# Configuration

The plugin reads configuration from two Gerrit config files, resolved in priority order.

## Resolution priority

1. **Per-project config** — `project.config` in `refs/meta/config` of the target repository. Supports `[jenkins "..."]` subsections for multi-instance setups.
2. **Global fallback** — `gerrit.config` under `[plugin "checks-jenkins"]`. Used only when the per-project config contains zero Jenkins instances.

The config is served by the `GetConfig` REST endpoint (`GET /projects/{project}/checks-jenkins~config`) and consumed by the frontend as `Config[]`. The frontend uses only the first entry (`configs[0]`).

## Global configuration (`gerrit.config`)

```ini
[plugin "checks-jenkins"]
    url = https://jenkins.example.com/
    user = gerrit-ci-user
    token = my-api-token
    coverage = true
```

| Key | Required | Description |
|---|---|---|
| `url` | **Yes** | Base URL of the Jenkins instance |
| `user` | **Yes** (for Basic auth) | Jenkins username. When omitted, the frontend uses cookie-based SSO (`credentials: 'include'`) |
| `token` | No | API token or password for Basic auth. Combined with `user` as `user:token`, Base64-encoded |
| `coverage` | No | Set to `true` to enable coverage features (requires Jenkins [Code Coverage API](https://plugins.jenkins.io/code-coverage-api/) plugin) |
| `coverage_id` | No | Jenkins Coverage plugin report `id` (the URL segment under the build). Defaults to `coverage` |

## Per-project configuration (`project.config`)

Stored in the repository's `refs/meta/config` branch. Uses `[jenkins "..."]` subsections to support multiple Jenkins instances per project:

```ini
[jenkins "prod-ci"]
    url = https://jenkins.prod.example.com/
    user = gerrit-bot
    token = prod-api-token
    coverage = true
    coverage_id = coverage

[jenkins "staging-ci"]
    url = https://jenkins.staging.example.com/
    user = gerrit-bot
```

### Multi-instance semantics

- Each subsection key (`prod-ci`, `staging-ci`) becomes the `name` field in the returned config object.
- The name is used by the frontend to construct cache keys and to route `proxy-trigger` requests.
- When multiple instances are configured, the frontend currently only uses `configs[0]`. The interface supports multi-instance in the future.
- Missing `url` + `user` in any instance silently excludes it from results.

### Global fallback

When `project.config` has zero `[jenkins "..."]` subsections, `GetConfig` falls back to the global `gerrit.config`:

```java
if (result.isEmpty() && globalConfig != null) {
    // build a JenkinsChecksConfig from the global plugin section
    jenkinsCfg.name = "globalConfig";
    result.add(jenkinsCfg);
}
```

The fallback only happens when the per-project config is **empty** — not when it has instances but the requested instance is missing.

## Authentication modes

### Basic auth (proxy mode)

When `user` is configured:

1. Frontend POSTs to Gerrit's `proxy-trigger` endpoint.
2. `ProxyTriggerAction` reads `user` + `token` from config.
3. Base64-encodes `user:token` and sets `Authorization: Basic {encoded}` header.
4. Forwards the request to Jenkins.

Credentials never reach the browser.

### Cookie-based SSO (direct mode)

When `user` is **not** configured:

```typescript
if (!jenkins.user) {
    const options: RequestInit = { credentials: 'include' };
    return fetch(url, options);
}
```

The browser calls Jenkins directly with `credentials: 'include'`, relying on existing SSO cookies.

## Coverage toggle

Coverage features are gated behind the `coverage` key:

```ini
[jenkins "my-jenkins"]
    coverage = true
```

When `coverage_enabled` is `true`:

- The coverage annotation provider registers with Gerrit's diff API.
- Coverage percentage columns appear in the file list.
- The low-coverage alert check runs on every poll.
- Coverage data is pre-fetched on `SHOW_CHANGE`.

When `false` or absent, the entire coverage subsystem is dormant — no coverage-related HTTP requests are made.

## Coverage report id

By default the plugin reads the coverage report published under the Coverage plugin's built-in id `coverage` (i.e. `{build}/coverage/`). If the pipeline publishes the report under a custom id — e.g. `recordCoverage(id: 'my-report', ...)` — set the same id in the config:

```ini
[jenkins "my-jenkins"]
    coverage = true
    coverage_id = my-report
```

The id must match the Jenkins Coverage plugin's pattern `\p{Alnum}[\p{Alnum}-_]*` and be unique within the job. When `coverage_id` is omitted, the plugin falls back to `coverage`.

## Config caching in the frontend

Both `ChecksFetcher` and `CoverageClient` cache config independently:

| Component | Cache | Invalidation |
|---|---|---|
| `ChecksFetcher` | `this.configs: Config[] \| null` | Refetched on every `fetch()` call |
| `CoverageClient` | `this.configs: Config[] \| null` + `this.configsRepo` | Refetched when repo changes; deduplicated via `configsPromise` |

`CoverageClient.ensureConfig()` is designed to be called concurrently (e.g., from `prefetchCoverageRanges` and `showPercentageColumns` during the same `SHOW_CHANGE` event). The `configsPromise` field deduplicates concurrent calls so only one HTTP request is made.
