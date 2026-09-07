
# checks-jenkins

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Gerrit Plugin](https://img.shields.io/badge/Gerrit-Plugin-blue.svg)](https://www.gerritcodereview.com/)

`checks-jenkins` is a Gerrit plugin that implements the [Gerrit Checks API](https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html) specifically for **Jenkins CI**.
It surfaces Jenkins build statuses, logs, test results, and code coverage metrics directly within the Gerrit change screen, providing a seamless CI/CD feedback loop for developers.

![Checks UI screenshot showing Jenkins build runs in the Gerrit Checks tab](docs/images/checks-ui.png)

## 🚀 Features

- **Real-time Status**: Monitor Jenkins build progress (Pending, Running, Success, Failure) within the Gerrit UI.
- **Detailed Feedback**: Provides links to build artifacts, warnings-ng reports, JUnit test failures, and build-failure explanations. When a build fails, the plugin queries the Jenkins [Error Explanation](https://plugins.jenkins.io/error-explanation/) plugin to surface human-readable failure reasons directly in the check result.

  ![Error explanation from Jenkins surfaced in a Gerrit check result](docs/images/explain-error-checks-ui.png)

- **Code Coverage**: Per-file coverage annotations on diffs, file-list columns, and a low-coverage alert check (requires Jenkins [Code Coverage](https://plugins.jenkins.io/coverage/) plugin).
- **Warning NG**: Per visualize the warning raised by the pipeline that are including in you recording steps.
- **Pipeline Visualization**: Upstream/downstream job relationships are displayed as a flattened tree. Parent jobs get a `🌳` prefix, leaf jobs get `🍃`, and every job at the same depth shares the same zero-padded number — making pipeline structure scannable at a glance without leaving the flat Gerrit Checks table. Requires the latest [Gerrit Checks API Plugin](https://plugins.jenkins.io/gerrit-checks-api/) on Jenkins.

  ![Flattened-tree pipeline visualization showing upstream/downstream dependencies in the Checks tab](docs/images/checks-dependency.png)

- **Rerun Triggers**: Directly trigger a Jenkins job rerun from the Gerrit interface. Rerun buttons are automatically disabled while any pipeline job is running — preventing accidental double-triggers.
- **Streamlined Workflow**: Reduces the need to leave Gerrit to check CI status on the Jenkins dashboard.

## 🛠 Prerequisites

- **Gerrit**: 3.x or higher.
- **Jenkins**: A running instance with:
  - [Gerrit Checks API Plugin](https://plugins.jenkins.io/gerrit-checks-api/)
  - [Code Coverage Plugin](https://plugins.jenkins.io/coverage/) *(optional — for coverage features)*
  - [Warning-ng Plugin](https://plugins.jenkins.io/warnings-ng/) *(optional — for warning features)*
- **Core Checks Plugin**: This plugin requires the standard Gerrit `checks` plugin to be installed.

## 📦 Installation

1. **Build the plugin**:
    Using Bazel (standard Gerrit plugin build system):
    ```bash
    bazel build plugins/checks-jenkins:checks-jenkins
    ```
2. **Deploy to Gerrit**:
    Copy the .jar file to your Gerrit installation's plugin directory:
    ```bash
    cp bazel-bin/checks-jenkins.jar /path/to/gerrit/plugins/
    ```
3. **Reload the plugin**:
   Waiting automatic reload or:
   ```bash
   ssh -p 29418 user@gerrit-host gerrit plugin reload checks-jenkins
   ```

## ⚙️ Configuration

The plugin uses Gerrit's project-level or global configuration under the `jenkins` section.

### Basic Jenkins connection

**`gerrit.config`** (global) or **`project.config`** (per-project, in `refs/meta/config`):

```ini
[plugin "checks-jenkins"]
    url = https://jenkins.example.com/
    user = gerrit-ci-user
    token = my-api-token
```

The `user` and `token` fields are combined as `user:token` and Base64-encoded into an `Authorization: Basic` header for all proxied requests to Jenkins. Credentials never reach the browser.

If the Gerrit user is already authenticated with Jenkins (e.g., via SSO), omit `user` and `token` and the plugin uses cookie-based `credentials: 'include'`.

#### Generating a Jenkins API token

The `token` field expects a Jenkins API token, not the user's login password. To generate one:

1. Log in to Jenkins.
2. Click your username in the top-right corner, then **Configure** (or navigate to `https://<jenkins>/user/<username>/configure`).
3. Under **API Token**, click **Add new Token**.
4. Give it a name (e.g. `gerrit-checks`), then click **Generate**.
5. Copy the generated token immediately — it will not be shown again.

Paste the copied token into your config:

```ini
[plugin "checks-jenkins"]
    token = 11aabb22cc33dd44ee55ff66aa77bb88cc
```

> ℹ️ The API token belongs to the Jenkins user specified in the `user` field. Make sure the user has sufficient permissions to read job statuses, access the Coverage API (if `coverage = true`), and trigger builds (for rerun functionality).

### Multi-instance (per-project)

```ini
[jenkins "my-jenkins"]
    url = https://jenkins.example.com/
    user = gerrit-ci-user
    token = my-api-token
```

The `name` field is the subsection key (`my-jenkins`). Multiple Jenkins instances can be configured per project.

### 📊 Code Coverage

Enable coverage reporting by adding the `coverage` key:

```ini
[plugin "checks-jenkins"]
    url = https://jenkins.example.com/
    user = gerrit-ci-user
    coverage = true
```

Or per-instance:

```ini
[jenkins "my-jenkins"]
    url = https://jenkins.example.com/
    user = gerrit-ci-user
    coverage = true
```

When enabled, the plugin queries the Jenkins [Code Coverage API](https://plugins.jenkins.io/code-coverage-api/) endpoints for the most recent completed build and surfaces:

| Feature | Location | Description |
|---|---|---|
| **Line coverage** | Diff view | Covered / missed annotations on modified lines (`COVERED` / `NOT_COVERED` ranges) |
| **File percentages** | File list columns | `Cov(L)` line, `Cov(B)` branch and `Cov(I)` instruction coverage of the whole file, plus `ΔCov(L)` line coverage of new lines, per file |
| **Low-coverage alert** | Checks tab | `Code Coverage` check run warns when a file's incremental coverage drops below 70% |
| **Project stats** | Checks tab | Project coverage summary shown first, followed by per-file alerts for files below 70% |

#### Coverage display

File-list columns and project stats use emoji indicators matching the Jenkins Coverage plugin weather-icon tiers:

| Emoji | Range | Meaning |
|---|---|---|
| 🟢 | ≥ 80% | Good |
| 🟡 | 60–79% | Moderate |
| 🟠 | 40–59% | Poor |
| 🔴 | < 40% | Critical |

Example check result:

```
📊 Project coverage: Line: 🔴 26.35%, Branch: 🔴 16.69%, File: 🟠 52.57%, Class: 🟠 53.75%
Coverage metrics for this build. Loc: 14036.
```

### 🔰 Low-Coverage-Reason footer

To suppress low-coverage warnings on a change (demoting them from `WARNING` to `INFO`), add a footer to the commit message:

```
Low-Coverage-Reason: HARD_TO_TEST
```

Valid reasons:

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

A malformed reason (not starting with one of the prefixes above) triggers a separate `Low-Coverage-Reason Format Check` warning.

> 📖 See [Configuration](docs/configuration.md) for the full config reference, [Coverage System](docs/coverage-system.md) for coverage internals, and [Caching](docs/caching.md) for the cache strategy.

## 📖 Documentation

Detailed technical documentation is available in the [`docs/`](docs/) directory:

| Document | Description |
|---|---|
| [Architecture](docs/architecture.md) | High-level plugin architecture, module graph, build pipeline, and key design decisions |
| [Backend](docs/backend.md) | Java backend classes — REST endpoints, config resolution, and auth proxy |
| [Frontend](docs/frontend.md) | TypeScript frontend — checks provider, enrichment pipeline, coverage client |
| [Data Flow](docs/data-flow.md) | Sequence diagrams for config, checks polling, coverage, and rerun flows |
| [Configuration](docs/configuration.md) | Full config reference — global, per-project, multi-instance, auth modes |
| [Coverage System](docs/coverage-system.md) | Coverage endpoints, line annotations, low-coverage alert, `Low-Coverage-Reason` footer |
| [Caching](docs/caching.md) | Two-tier cache strategy — in-memory LRU, IndexedDB, staleness detection |
| [Components](docs/components.md) | Lit web component hierarchy — headers, content cells, summary rows |
| [Contributing](docs/contributing.md) | Development setup, build commands, testing, linting, and deployment |

## 🤝 Contributing

Contributions are welcome! This project is maintained by Amarula Solutions.

- Clone from gerrithub.io and take the clone instructions from: https://gerrithub.io/admin/repos/amarula/checks-jenkins,general
- Create your changeset to be included
- Push them using: git push origin HEAD:refs/for/master

> 📖 See [Contributing](docs/contributing.md) for development setup, build commands, and testing.

## 📄 License

This project is licensed under the Apache License, Version 2.0. See the LICENSE file for more information.
