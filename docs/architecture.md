# Architecture

## Overview

`checks-jenkins` is a Gerrit plugin that bridges Gerrit's [Checks API](https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html) to Jenkins CI. It surfaces Jenkins build statuses, logs, static-analysis warnings (warnings-ng), JUnit test results, and code-coverage metrics directly inside the Gerrit change screen.

The plugin splits into two halves wired together by Gerrit's plugin framework:

```
┌──────────────────────────────────────────────────────────┐
│                        Gerrit                            │
│                                                          │
│  ┌──────────────────┐       ┌─────────────────────────┐ │
│  │   Java Backend    │       │   TypeScript Frontend    │ │
│  │                   │       │                         │ │
│  │  ApiModule        │       │  plugin.ts              │ │
│  │  ├─ GetConfig     │◄──────┤  ChecksFetcher          │ │
│  │  └─ ProxyTrigger  │◄──────┤  CoverageClient         │ │
│  │       Action      │       │  CoverageViews (Lit)    │ │
│  │                   │       │                         │ │
│  │  HttpModule       │──┐    └─────────────────────────┘ │
│  │  → JavaScriptPlugin│  │                               │
│  └──────────────────┘  │    ┌─────────────┐              │
│                        └───►│ checks-jen- │              │
│                             │ kins.js     │              │
│                             └─────────────┘              │
└──────────────────────────────────────────────────────────┘
         │                                │
         │ Gerrit REST API                │ HTTP (via proxy)
         ▼                                ▼
┌──────────────────────────────────────────────────────────┐
│                      Jenkins                             │
│                                                          │
│  /gerrit-checks/runs          Checks API endpoint        │
│  /warnings-ng/api/json        Static analysis reports    │
│  /testReport/api/json         JUnit test results         │
│  /error-explanation/api/json  Build failure reasons      │
│  /coverage/api/json           Project coverage stats     │
│  /coverage/modified/api/json  Per-file modified lines    │
│  /coverage/files/api/json     Per-file absolute coverage │
└──────────────────────────────────────────────────────────┘
```

## Module graph

| Module | Role |
|---|---|
| `ApiModule` (`RestApiModule`) | Registers REST endpoints: `GET {project}/config`, `POST {project}/proxy-trigger` |
| `HttpModule` (`ServletModule`) | Registers the compiled TypeScript bundle (`checks-jenkins.js`) as a `JavaScriptPlugin` so Gerrit injects it into every page |
| `plugin.ts` | Entry point for the frontend. Installs checks provider, coverage provider, annotation provider, and dynamic custom components |
| `fetcher.ts` / `ChecksFetcher` | Polls Jenkins for check runs, caches raw payloads in IndexedDB (stale-while-revalidate), enriches results with warnings, test failures, and error explanations. Transforms check names with flattened-tree naming (depth-based numbering + 🌳/🍃 emojis, grouped by pipeline tree) for upstream/downstream pipeline visualization. |
| `coverage.ts` / `CoverageClient` | Fetches coverage data, provides line-level annotations in the diff view, per-file percentage columns, and low-coverage alerts |
| `coverage-percentage-views.ts` | Lit web components that render coverage percentage badges in file-list table columns |
| `request-cache-service.ts` | Two-tier cache (in-memory LRU + IndexedDB) for runs payloads, warnings/test enrichment results, and coverage payloads |
| `index-db.ts` | IndexedDB schema and key definitions |

## Build pipeline

1. **Bazel** compiles Java sources in `src/` into a Gerrit plugin JAR.
2. **Bazel** also compiles TypeScript in `web/` (using `ts_project` rule) and packages the output into a resource JAR via `resource_jars`.
3. At deploy time, Gerrit loads the JAR, reads `Gerrit-Module` / `Gerrit-HttpModule` from `MANIFEST.MF`, and bootstraps the plugin.

## Key design decisions

- **Proxy pattern for auth**: The TypeScript frontend never calls Jenkins directly when authentication is configured. Instead it POSTs to the `proxy-trigger` Gerrit endpoint, which forwards the request with Basic auth headers. This keeps Jenkins credentials server-side only.
- **Two-tier caching with stale-while-revalidate**: Check runs are cached in IndexedDB (2 min TTL) and served immediately while a background fetch refreshes the data. Coverage data is cached in memory (LRU, size 50) for fast same-page navigation and in IndexedDB for persistence across page reloads. Staleness is detected by comparing the Jenkins run's `statusLink` and `attempt` (coverage) or by structural comparison of `checkName`/`status`/`statusDescription` (runs).
- **Unavailable endpoint tracking**: When a Jenkins endpoint returns 403 or an error, it is marked as unavailable for the remainder of the session to avoid request storms.
- **Single checks provider**: Both Jenkins run data and coverage alerts are merged into a single Gerrit checks provider, giving users one unified CI status view.
- **Flattened-tree naming**: Upstream/downstream pipeline relationships (encoded in `externalId` by the Jenkins-side plugin) are parsed on the frontend and rendered as a flat list with depth-based numbering and tree/leaf emojis. Multiple independent trees are grouped by root so each pipeline's runs stay visually together. Independent runs without parent-child relationships keep their original names. See [Frontend](docs/frontend.md) for details.
