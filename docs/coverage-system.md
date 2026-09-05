# Coverage System

The coverage subsystem fetches code-coverage metrics from Jenkins' [Code Coverage API](https://plugins.jenkins.io/code-coverage-api/) plugin and surfaces them at three levels in the Gerrit UI:

1. **Line-level annotations** — green (COVERED) / red (NOT_COVERED) highlights in the diff view.
2. **File-list columns** — per-file absolute and incremental coverage percentages.
3. **Checks tab alert** — a `Code Coverage` check run warning on low-coverage files.

## Endpoints

Two Jenkins REST endpoints are queried in parallel:

| Endpoint | Response class | Purpose |
|---|---|---|
| `{statusLink}{coverage_id}/api/json` | `io.jenkins.plugins.coverage.metrics.restapi.CoverageApi` | Project-level stats, per-file delta percentages |
| `{statusLink}{coverage_id}/modified/api/json` | `io.jenkins.plugins.coverage.metrics.restapi.ModifiedLinesCoverageApi` | Per-file modified line blocks with coverage types |

`{coverage_id}` is the Jenkins Coverage plugin report id (default `coverage`), configurable per Jenkins instance via the `coverage_id` config key.

Both are fetched for the **most recent completed run** on the change's patchset.

## Finding the completed run

Before fetching coverage data, `CoverageClient.findCompletedRun()` queries:

```
GET {jenkins}/gerrit-checks/runs?change={changeNum}&patchset={patchNum}
```

It scans the returned runs for the first one with `status === "COMPLETED"` and extracts its `statusLink` and `attempt` number. These serve as the staleness key for cache invalidation (see [caching.md](caching.md)).

## Data parsing

### `parseRanges()` — line-level annotation data

Input: `ModifiedLinesResponse` with `files[].modifiedLinesBlocks[]`.

Each block has:

```typescript
interface ModifiedLinesBlock {
    startLine: number;
    endLine: number;
    type: string;   // "COVERED", "MISSED", etc.
}
```

Blocks are mapped to Gerrit's `CoverageRange`:

```typescript
{
    side: Side.RIGHT,                               // always RIGHT (the new patchset)
    type: block.type === 'COVERED'
        ? CoverageType.COVERED
        : CoverageType.NOT_COVERED,
    code_range: {
        start_line: block.startLine,
        end_line: block.endLine,
    },
}
```

Result is keyed by `fullyQualifiedFileName` — the absolute path within the repository.

### `computePercentages()` — per-file percentage data

Input: same `ModifiedLinesResponse`.

The modified-lines endpoint only reports lines changed by this CL, so the
computed value is the **incremental** coverage of new/changed lines, not the
whole-file absolute coverage.

For each file, counts covered vs missed lines across all blocks:

```
covered = Σ (block.endLine - block.startLine + 1)  for blocks where type === 'COVERED'
missed  = Σ (block.endLine - block.startLine + 1)  for all other blocks
total   = covered + missed

if total > 0:
    incremental = Math.round((covered / total) * 100)
```

Returns `{ [path]: { incremental: number } }`.

## Low-coverage alert

`mayBeShowLowCoverageAlert()` runs as part of the unified checks provider. It evaluates per-file coverage against a threshold:

```typescript
const OVERALL_LOW_COVERAGE_WARNING_BAR = 70;
```

### Per-file check

For every file with coverage data, if `incremental < 70`:

- **Without `Low-Coverage-Reason`**: emits a `WARNING` result with message *"Please add tests for uncovered lines or add Low-Coverage-Reason in commit message."*
- **With `Low-Coverage-Reason`**: demotes to `INFO` with message *"Low-Coverage-Reason provided — CL will not be blocked."*

### Project-level fallback

When no individual file is below threshold, the system falls back to project-level stats from `projectStatistics`:

```
"Project coverage: Line: 88.44%, Branch: 82.19%, File: 94.12%, Class: 96.88%"
```

If `Line` coverage is below 70%, this is `WARNING`; otherwise `INFO`.

### Quality gates

The `qualityGates` field (with `overallResult` and per-gate `resultItems`) from the coverage API response is available but not currently surfaced in the UI.

## `Low-Coverage-Reason` footer

Commit messages can include a footer to suppress low-coverage warnings:

```
Low-Coverage-Reason: HARD_TO_TEST
```

### Parsing

```typescript
const re = /Low-Coverage-Reason:(.*)/g;
const matches = [...commitMessage.matchAll(re)];
```

Takes the first match (global, multi-line) and trims the value.

### Valid prefixes

| Prefix | Meaning |
|---|---|
| `TRIVIAL_CHANGE` | Minimal logic change, not worth testing |
| `TESTS_ARE_DISABLED` | Tests exist but are temporarily disabled |
| `TESTS_IN_SEPARATE_CL` | Tests will be added in a follow-up change |
| `HARD_TO_TEST` | The change is inherently difficult to test |
| `COVERAGE_UNDERREPORTED` | Coverage tool misses lines that are actually exercised |
| `LARGE_SCALE_REFACTOR` | Behavior-preserving restructuring |
| `EXPERIMENTAL_CODE` | Prototype or experimental change |
| `OTHER` | None of the above (provide details after prefix) |

### Format check

If a `Low-Coverage-Reason` footer exists but does **not** start with one of the valid prefixes, a separate `Low-Coverage-Reason Format Check` warning run is emitted. This doesn't block the change but alerts the author.

## Column visibility gating

`showPercentageColumns()` returns `true` only when:

1. The project can be parsed from `window.location.pathname`.
2. A config exists for that project.
3. `coverage_enabled === true` in that config.

When `false`, all 12 dynamic custom components set `shown = false`, hiding them from the file list via CSS class `hidden`.

## Unavailable endpoint tracking

If **both** `coverage/api/json` and `coverage/modified/api/json` return 403, the `coverageUnavailable` flag is set to `true`. From that point, all coverage fetches for the session are skipped — no more HTTP requests are made to the coverage endpoints. This prevents request storms when the Code Coverage API plugin is not installed on Jenkins.
