/**
 * @license
 * Copyright (C) 2022 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  Action,
  ActionResult,
  ChangeData,
  CheckResult,
  CheckRun,
  ChecksProvider,
  ResponseCode,
  RunStatus,
  Category,
  LinkIcon,
  TagColor,
} from "@gerritcodereview/typescript-api/checks";
import { PluginApi } from "@gerritcodereview/typescript-api/plugin";
import { cacheService } from "./request-cache-service";
import { RequestKey, RunsCacheKey } from "./index-db";

export declare interface Config {
  name: string;
  url: string;
  user: string;
  coverage_enabled?: boolean;
  coverage_id?: string;
}

export interface ProxyInput {
  jenkinsname: string;
  urlpath: string;
  method: string;
}

export declare interface JenkinsCheckRun {
  actions: JenkinsAction[];
  attempt: number;
  change: number;
  checkDescription: string;
  checkLink: string;
  checkName: string;
  externalId: string;
  finishedTimestamp: string;
  labelName: string;
  patchset: number;
  results: CheckResult[];
  scheduledTimestamp: string;
  startedTimestamp: string;
  status: RunStatus;
  statusDescription: string;
  statusLink: string;
}

export declare interface JenkinsAction {
  data: string;
  disabled: boolean;
  method: string;
  name: string;
  primary: boolean;
  summary: boolean;
  tooltip: string;
  url: string;
}

interface AnalysisTool {
  id: string;
  name: string;
  size: number;
  latestUrl: string;
  errorSize: number;
  highSize: number;
  lowSize: number;
  normalSize: number;
}

interface AnalysisResponse {
  _class: string;
  tools: AnalysisTool[];
}

interface AnalysisIssue {
  fileName: string;
  message: string;
  severity: string;
  toString: string;
  lineStart: number;
  columnStart: number;
  columnEnd: number;
  lineEnd: number;
}

interface AnalysisReport {
  _class: string;
  issues: AnalysisIssue[];
}

interface ErrorResponse {
  _class: string;
  explanation?: string;
}

interface CachedRuns {
  runs: JenkinsCheckRun[];
  timestamp: number;
}

export class ChecksFetcher implements ChecksProvider {
  private plugin: PluginApi;

  configs: Config[] | null;

  /** Endpoints that returned 403/error — skipped after {@link UNAVAILABLE_RETRY_BUDGET}
   *  consecutive failures within {@link UNAVAILABLE_TTL_MS}.  The counter
   *  resets on the first successful request or when the TTL expires. */
  private unavailableEndpoints: Map<
    string,
    { failures: number; lastFailure: number }
  > = new Map();

  /** RunKeys that the user has clicked rerun on, or that are currently RUNNING/RUNNABLE.
   *  Maps key to the timestamp (Date.now()) when it was added. While non-empty,
   *  all rerun actions are disabled to prevent double-triggering. */
  private triggeredReruns: Map<string, number> = new Map();

  /** Maximum time (ms) a recently-clicked rerun remains disabled while waiting
   *  for Jenkins to update its status to RUNNING. */
  private static readonly RERUN_DISABLE_TTL_MS = 60_000;

  /** Number of consecutive failures before an enrichment endpoint is
   *  considered unavailable and skipped on future polls. */
  private static readonly UNAVAILABLE_RETRY_BUDGET = 2;

  /** Maximum time (ms) an endpoint stays marked unavailable before the
   *  failure counter is cleared and the endpoint is retried. */
  private static readonly UNAVAILABLE_TTL_MS = 2 * 60 * 1000; // 2 min

  /** Maximum age (ms) for cached runs before forcing a network refresh. */
  private static readonly RUNS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 min

  /** Callback invoked when a background update detects changed data.
   *  Set by the plugin layer to trigger a UI re-fetch. */
  private onDataChanged: (() => void) | null = null;

  private static readonly TREE_EMOJI = "\u{1F333}"; // 🌳 — has downstream children
  private static readonly LEAF_EMOJI = "\u{1F343}"; // 🍃 — terminal job

  constructor(pluginApi: PluginApi, reloadCb?: () => void) {
    this.plugin = pluginApi;
    this.configs = null;
    if (reloadCb) this.onDataChanged = reloadCb;
  }

  /** Register a callback to be invoked when a background update detects new data. */
  setOnDataChanged(callback: () => void): void {
    this.onDataChanged = callback;
  }

  private isUnavailable(jenkinsName: string, endpoint: string): boolean {
    const key = `${jenkinsName}:${endpoint}`;
    const entry = this.unavailableEndpoints.get(key);
    if (!entry) return false;
    if (Date.now() - entry.lastFailure > ChecksFetcher.UNAVAILABLE_TTL_MS) {
      this.unavailableEndpoints.delete(key);
      return false;
    }
    return entry.failures >= ChecksFetcher.UNAVAILABLE_RETRY_BUDGET;
  }

  private markUnavailable(jenkinsName: string, endpoint: string): void {
    const key = `${jenkinsName}:${endpoint}`;
    const entry = this.unavailableEndpoints.get(key);
    this.unavailableEndpoints.set(key, {
      failures: (entry?.failures ?? 0) + 1,
      lastFailure: Date.now(),
    });
  }

  /** Reset the failure counter when an endpoint responds successfully. */
  private markAvailable(jenkinsName: string, endpoint: string): void {
    this.unavailableEndpoints.delete(`${jenkinsName}:${endpoint}`);
  }

  private async toJson(response: Response) {
    try {
      if (response.status !== undefined) {
        return await response.json();
      } else {
        const val: string = response.toString();
        return JSON.parse(val);
      }
    } catch {
      // JSON parse failure — return null.
      return null;
    }
  }

  /**
   * Fast structural comparison of two JenkinsCheckRun arrays.
   * Returns true when both arrays have the same length and each run has the
   * same checkName, status, and statusDescription at the same index.
   */
  private runsEqual(a: JenkinsCheckRun[], b: JenkinsCheckRun[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].checkName !== b[i].checkName) return false;
      if (a[i].status !== b[i].status) return false;
      if (a[i].statusDescription !== b[i].statusDescription) return false;
    }
    return true;
  }

  /**
   * Background cache refresh: awaits the in-flight network response, compares
   * the fresh data against what we already showed the user, and — only when
   * something actually changed — writes the new runs to IndexedDB and signals
   * the plugin layer to trigger a UI reload.
   */
  private async backgroundUpdateRuns(
    networkPromise: Promise<Response | null>,
    runsKey: RunsCacheKey,
    currentRuns: JenkinsCheckRun[],
  ): Promise<void> {
    try {
      const response = await networkPromise;
      if (
        response === null ||
        (response.status !== undefined && response.status === 403)
      )
        return;

      const data = await this.toJson(response);
      if (data === null || data._jenkins_unavailable) return;
      if (!data?.runs || !Array.isArray(data.runs) || data.runs.length === 0)
        return;

      // Nothing new — skip the cache write and UI reload
      if (this.runsEqual(currentRuns, data.runs)) return;

      // Deep-clone before caching: computeTreeNames mutates runs in-place and
      // we must not corrupt the cached copy that will be reused on future polls.
      const cloned: JenkinsCheckRun[] = structuredClone(data.runs);
      await cacheService.put(runsKey, { runs: cloned, timestamp: Date.now() });

      this.onDataChanged?.();
    } catch {
      // Network flakiness in the background must not surface to the user.
    }
  }

  async fetch(changeData: ChangeData) {
    await this.fetchConfig(changeData)
      .then((result) => {
        this.configs = result;
      })
      .catch((reason) => {
        throw reason;
      });

    if (this.configs === null || this.configs.length === 0) {
      return {
        responseCode: ResponseCode.OK,
        runs: [],
      };
    }
    const checkRuns: CheckRun[] = [];
    for (const jenkins of this.configs) {
      const checks_url = `${jenkins.url}/gerrit-checks/runs?change=${changeData.changeNumber}&patchset=${changeData.patchsetNumber}`;

      // Start the network request eagerly but don't await it yet —
      // we check the cache first so we can return stale data immediately.
      const networkPromise = (async () => {
        try {
          return await this.fetchFromJenkins(
            jenkins,
            changeData.repo,
            checks_url,
            "GET",
          );
        } catch (_e) {
          return null;
        }
      })();

      const runsKey: RunsCacheKey = [
        jenkins.name,
        changeData.changeNumber,
        changeData.patchsetNumber,
      ];
      const cachedEntry: CachedRuns | undefined =
        await cacheService.get(runsKey);
      const now = Date.now();
      const cacheHit =
        cachedEntry &&
        cachedEntry.runs &&
        Array.isArray(cachedEntry.runs) &&
        cachedEntry.runs.length > 0 &&
        now - cachedEntry.timestamp < ChecksFetcher.RUNS_CACHE_TTL_MS;

      let data: any; // the { runs: JenkinsCheckRun[] } payload we'll process
      let totalRuns: number;

      if (cacheHit) {
        // Serve cached runs immediately; refresh in background.
        data = { runs: cachedEntry!.runs };
        totalRuns = cachedEntry!.runs.length;
        // Clone before computeTreeNames mutates checkName in-place —
        // backgroundUpdateRuns needs the originals for comparison.
        this.backgroundUpdateRuns(
          networkPromise,
          runsKey,
          structuredClone(cachedEntry!.runs),
        );
      } else {
        // No usable cache — must await the network.
        const response = await networkPromise;
        if (
          response === null ||
          (response.status !== undefined && response.status === 403)
        ) {
          // Give the user a LOGIN button that will open a new tab where they can log into Jenkins
          return {
            responseCode: ResponseCode.NOT_LOGGED_IN,
            loginCallback: () => window.open(jenkins.url),
          };
        }
        data = await this.toJson(response);
        if (data !== null && data !== undefined && data._jenkins_unavailable) {
          return {
            responseCode: ResponseCode.NOT_LOGGED_IN,
            loginCallback: () => window.open(jenkins.url),
          };
        }
        if (data === null) {
          continue;
        }
        if (!data?.runs || !Array.isArray(data.runs)) {
          continue;
        }
        totalRuns = data.runs.length;
        if (totalRuns === 0) {
          continue;
        }

        // Cache the raw runs for next time (deep-clone before
        // computeTreeNames mutates them in-place).
        const cloned: JenkinsCheckRun[] = structuredClone(data.runs);
        await cacheService.put(runsKey, { runs: cloned, timestamp: now });
      }

      // Apply flattened-tree naming before enrichment so checkName
      // carries the depth and emoji prefix for all downstream consumers.
      this.computeTreeNames(data.runs);

      const key: RequestKey = [
        jenkins.name,
        changeData.changeNumber,
        changeData.patchsetNumber,
        totalRuns,
      ];

      // Phase A: Enrich error results with explanations (parallel across runs).
      // Skip entirely if the endpoint was already marked unavailable on a prior poll.
      const completedRuns = data.runs.filter(
        (run: JenkinsCheckRun) => run.status === RunStatus.COMPLETED,
      );
      if (!this.isUnavailable(jenkins.name, "error-explanation")) {
        await Promise.all(
          completedRuns.map(async (run: JenkinsCheckRun) => {
            if (!run.results) run.results = [];
            const errorResult = run.results.find(
              (result: CheckResult) => result.category === Category.ERROR,
            );
            if (!errorResult) return;
            const errorMessage = await this.explainBuildFailure(
              jenkins,
              changeData,
              run.statusLink,
            );
            if (errorMessage) {
              const lines = errorMessage.split("\n");
              const parsedSummary = lines[0].trim();
              const detailedMessage = lines.slice(1).join("\n").trim();
              const markdownMessage = detailedMessage
                ? `\`\`\`text\n${detailedMessage}\n\`\`\``
                : "No additional details provided.";
              errorResult.summary = parsedSummary;
              errorResult.message = markdownMessage;
              run.statusDescription = parsedSummary;
            }
          }),
        );
      }

      // Phase B: Fetch warnings + test results (parallel across runs and both types).
      // Skip endpoints that were already marked unavailable on a prior poll.
      const cachedData: CheckRun[] = await cacheService.get(key);
      if (
        cachedData === null ||
        cachedData === undefined ||
        cachedData.length === 0
      ) {
        const enrichmentPromises = completedRuns.flatMap(
          (run: JenkinsCheckRun) => {
            const promises: Promise<CheckRun[] | null>[] = [];
            if (!this.isUnavailable(jenkins.name, "warnings")) {
              promises.push(
                this.buildWarnings(
                  jenkins,
                  changeData,
                  run.statusLink,
                  run.attempt,
                ),
              );
            }
            if (!this.isUnavailable(jenkins.name, "tests")) {
              promises.push(
                this.buildTestResults(
                  jenkins,
                  changeData,
                  run.statusLink,
                  run.attempt,
                ),
              );
            }
            return promises;
          },
        );
        const results = await Promise.all(enrichmentPromises);
        const warningsData = results.flat().filter(Boolean);
        if (warningsData.length > 0) {
          await cacheService.put(key, warningsData.slice());
          checkRuns.push(...warningsData.slice());
        }
      } else {
        checkRuns.push(...cachedData);
      }

      // Sync triggeredReruns from current run statuses:
      //  - RUNNING/RUNNABLE runs add/refresh their keys with a fresh timestamp.
      //  - Keys added by user clicks survive the shouldReload re-fetch gap
      //    (Jenkins may not have queued the job yet) via a TTL.
      //  - Keys whose TTL has expired with no active run are removed.
      for (const run of data.runs) {
        if (
          run.status === RunStatus.RUNNING ||
          run.status === RunStatus.RUNNABLE
        ) {
          const { runKey } = this.parseExternalId(run.externalId);
          if (runKey) this.triggeredReruns.set(runKey, now);
        }
      }
      for (const [k, ts] of this.triggeredReruns) {
        if (now - ts > ChecksFetcher.RERUN_DISABLE_TTL_MS) {
          this.triggeredReruns.delete(k);
        }
      }

      for (const run of data.runs) {
        checkRuns.push(this.convert(jenkins, changeData.repo, run));
      }
    }

    return {
      responseCode: ResponseCode.OK,
      runs: checkRuns,
    };
  }

  private warningNgGetCategory(tool: AnalysisTool): Category {
    if (tool.errorSize && tool.size >= tool.errorSize) {
      return Category.ERROR;
    } else if (tool.highSize && tool.size >= tool.highSize) {
      return Category.WARNING;
    } else if (tool.normalSize && tool.size >= tool.normalSize) {
      return Category.INFO;
    } else if (tool.lowSize && tool.size >= tool.lowSize) {
      return Category.INFO;
    }
    return Category.SUCCESS;
  }

  private warningNgGetTagColor(issue: AnalysisIssue): TagColor {
    switch (issue.severity) {
      case "TOTAL_ERROR":
      case "NEW_ERROR":
      case "DELTA_ERROR":
      case "ERROR":
        return TagColor.PURPLE;
      case "TOTAL_HIGH":
      case "NEW_HIGH":
      case "DELTA_HIGH":
      case "HIGH":
        return TagColor.BROWN;
      case "TOTAL_NORMAL":
      case "NEW_NORMAL":
      case "DELTA_NORMAL":
      case "NORMAL":
        return TagColor.YELLOW;
      case "TOTAL_LOW":
      case "NEW_LOW":
      case "DELTA_LOW":
      case "LOW":
        return TagColor.PINK;
    }
    return TagColor.GRAY;
  }

  async buildWarnings(
    jenkins: Config,
    changeData: ChangeData,
    statusLink: string,
    attempt: number,
  ) {
    if (this.isUnavailable(jenkins.name, "warnings")) return null;

    const toolsResult = await (async () => {
      try {
        return await this.fetchFromJenkins(
          jenkins,
          changeData.repo,
          `${statusLink}warnings-ng/api/json`,
          "GET",
        );
      } catch (e) {
        return null;
      }
    })();

    if (
      toolsResult === null ||
      (toolsResult.ok !== undefined && !toolsResult.ok)
    ) {
      this.markUnavailable(jenkins.name, "warnings");
      return null;
    }

    const toolsInfo: AnalysisResponse = await this.toJson(toolsResult);
    if (toolsInfo === null) {
      return [];
    }
    this.markAvailable(jenkins.name, "warnings");
    // Fetch all tool issues in parallel — each tool's endpoint is independent.
    const toolResults = await Promise.allSettled(
      toolsInfo.tools.map(async (tool): Promise<CheckRun | null> => {
        const toolResp = await (async () => {
          try {
            return await this.fetchFromJenkins(
              jenkins,
              changeData.repo,
              `${statusLink}${tool.id}/all/api/json?tree=issues[severity,message,toString,fileName,lineStart,columnStart,lineEnd,columnEnd]`,
              "GET",
            );
          } catch (e) {
            return null;
          }
        })();

        if (toolResp === null || (toolResp.ok !== undefined && !toolResp.ok)) {
          return null;
        }

        const warnings: AnalysisReport = await this.toJson(toolResp);
        if (warnings === null) {
          return null;
        }

        return {
          change: changeData.changeNumber,
          patchset: changeData.patchsetNumber,
          checkName: `${tool.name}`,
          status: RunStatus.COMPLETED,
          statusLink: `${tool.latestUrl}`,
          attempt: attempt,
          actions: [],
          results: warnings.issues.map((issue) => ({
            show_on_unchanged_lines: false,
            category: this.warningNgGetCategory(tool),
            summary: issue.message,
            message: issue.toString,
            tags: [
              {
                name: `${tool.name}`,
                color: this.warningNgGetTagColor(issue),
                tooltip: issue.message,
              },
            ],
            links: [
              {
                url: `${tool.latestUrl}`,
                icon: LinkIcon.EXTERNAL,
                primary: true,
              },
            ],
            codePointers: [
              {
                path: issue.fileName,
                range: {
                  start_line: issue.lineStart,
                  start_character: issue.columnStart - 1,
                  end_line: issue.lineEnd,
                  end_character: issue.columnEnd,
                },
              },
            ],
          })),
        };
      }),
    );

    return toolResults
      .filter(
        (r): r is PromiseFulfilledResult<CheckRun> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value);
  }

  async buildTestResults(
    jenkins: Config,
    changeData: ChangeData,
    statusLink: string,
    attempt: number,
  ) {
    if (this.isUnavailable(jenkins.name, "tests")) return null;

    interface TestCase {
      className: string;
      errorDetails: string | null;
      name: string;
      status: "PASSED" | "FAILED" | "SKIPPED";
    }

    interface TestSuite {
      cases: TestCase[];
    }

    interface JunitResult {
      _class: string;
      suites: TestSuite[];
    }

    const testResult = await (async () => {
      try {
        return await this.fetchFromJenkins(
          jenkins,
          changeData.repo,
          `${statusLink}testReport/api/json?tree=suites[cases[className,name,status,errorDetails]]`,
          "GET",
        );
      } catch (e) {
        return null;
      }
    })();

    if (testResult === null || (testResult.ok !== undefined && !testResult.ok)) {
      this.markUnavailable(jenkins.name, "tests");
      return null;
    }

    const testReport: JunitResult = await this.toJson(testResult);
    if (testReport === null) {
      return [];
    }
    this.markAvailable(jenkins.name, "tests");
    const results: CheckResult[] = [];

    const failedTests: CheckResult[] = testReport.suites.flatMap((suite) =>
      suite.cases
        .filter((test) => test.status === "FAILED")
        .map((test) => ({
          show_on_unchanged_lines: false,
          category: Category.ERROR,
          message: test.errorDetails ?? undefined,
          summary: `${test.className}.${test.name}`,
        })),
    );

    if (!failedTests.length) {
      return [];
    }

    results.push(...failedTests);
    const checkRuns: CheckRun[] = [];
    checkRuns.push({
      change: changeData.changeNumber,
      patchset: changeData.patchsetNumber,
      checkName: "JUnit",
      status: RunStatus.COMPLETED,
      statusLink: `${statusLink}testReport`,
      attempt: attempt,
      actions: [],
      results: results,
    });

    return checkRuns;
  }

  async explainBuildFailure(
    jenkins: Config,
    changeData: ChangeData,
    statusLink: string,
  ) {
    if (this.isUnavailable(jenkins.name, "error-explanation")) return null;

    const errorResult = await (async () => {
      try {
        return await this.fetchFromJenkins(
          jenkins,
          changeData.repo,
          `${statusLink}error-explanation/api/json`,
          "GET",
        );
      } catch (e) {
        return null;
      }
    })();

    if (
      errorResult === null ||
      (errorResult.ok !== undefined && !errorResult.ok)
    ) {
      this.markUnavailable(jenkins.name, "error-explanation");
      return null;
    }

    const errorInfo: ErrorResponse = await this.toJson(errorResult);
    if (errorInfo === null) {
      return null;
    }
    this.markAvailable(jenkins.name, "error-explanation");
    return errorInfo.explanation;
  }

  fetchConfig(changeData: ChangeData): Promise<Config[]> {
    const pluginName = encodeURIComponent(this.plugin.getPluginName());
    return this.plugin
      .restApi()
      .get<Config[]>(
        `/projects/${encodeURIComponent(changeData.repo)}/${pluginName}~config`,
      );
  }

  convert(jenkins: Config, repo: string, run: JenkinsCheckRun): CheckRun {
    const convertedRun: CheckRun = {
      attempt: run.attempt,
      change: run.change,
      checkDescription: run.checkDescription,
      checkLink: run.checkLink,
      checkName: run.checkName,
      externalId: run.externalId,
      finishedTimestamp: new Date(run.finishedTimestamp),
      labelName: run.labelName,
      patchset: run.patchset,
      results: run.results,
      scheduledTimestamp: new Date(run.scheduledTimestamp),
      startedTimestamp: new Date(run.startedTimestamp),
      status: run.status,
      statusDescription: run.statusDescription,
      statusLink: run.statusLink,
    };
    const actions: Action[] = [];
    const { runKey } = this.parseExternalId(run.externalId);
    const rerunDisabled = runKey
      ? this.triggeredReruns.has(runKey) || this.triggeredReruns.size > 0
      : this.triggeredReruns.size > 0;
    const rerunTooltip =
      runKey && this.triggeredReruns.has(runKey)
        ? "Run already triggered"
        : this.triggeredReruns.size > 0
          ? "A pipeline job is currently running"
          : undefined;
    for (const action of run.actions) {
      actions.push({
        name: action.name,
        tooltip: rerunTooltip ?? action.tooltip,
        primary: action.primary,
        summary: action.summary,
        disabled: action.disabled || rerunDisabled,
        callback: () =>
          this.rerun(jenkins, repo, action.url + "/index", runKey),
      });
    }
    convertedRun.actions = actions;
    return convertedRun;
  }

  /**
   * Parses a Jenkins externalId into its {runKey, parentKey} components.
   *
   * Downstream runs carry a JSON object: {"parent":"upstreamJob#N","run":"thisJob#M"}.
   * Direct runs are plain strings: "jobFullName#buildNumber".
   */
  private parseExternalId(externalId: string | undefined): {
    runKey: string;
    parentKey: string | null;
  } {
    if (!externalId) return { runKey: "", parentKey: null };
    try {
      const parsed = JSON.parse(externalId);
      if (parsed.parent && parsed.run) {
        return {
          runKey: parsed.run as string,
          parentKey: parsed.parent as string,
        };
      }
    } catch {}
    return { runKey: externalId, parentKey: null };
  }

  /**
   * Rewrites checkName on every run in-place to a flattened-tree label:
   *
   *   {depth+1 padded} {🌳|🍃} {originalName}
   *
   * Depth is the number of parent links traversed to reach a root (direct run).
   * 🌳 is used when another run references this run's key as its parent,
   * 🍃 otherwise.
   *
   * When there are no parent-child relationships (single run or all independent),
   * all names are left unchanged — numbering and emojis add no value.
   *
   * When multiple independent trees exist in the same batch, runs are grouped
   * by tree first, then sorted by depth within each tree.  This keeps each
   * pipeline's upstream/downstream chain visually together in the flat list.
   */
  private computeTreeNames(runs: JenkinsCheckRun[]): void {
    if (!runs || runs.length === 0) return;

    // 1. Parse every externalId
    const parsed = runs.map((r) => this.parseExternalId(r.externalId));

    // 2. Build lookup structures
    const parentMap = new Map<string, string | null>(); // runKey → parentKey
    const allKeys = new Set<string>();
    for (const p of parsed) {
      if (p.runKey) {
        parentMap.set(p.runKey, p.parentKey);
        allKeys.add(p.runKey);
      }
    }

    // 3. Determine which runKeys have children
    const hasChildren = new Set<string>();
    for (const p of parsed) {
      if (p.parentKey && allKeys.has(p.parentKey)) {
        hasChildren.add(p.parentKey);
      }
    }

    // 4. Compute the set of runKeys that participate in the dependency graph.
    //    A run is "in the graph" if it either has children or has a parent that
    //    exists in this batch.  Runs with no relationships at all keep their
    //    original names — they don't need numbering or emojis.
    const inGraph = new Set<string>(hasChildren);
    for (const p of parsed) {
      if (p.parentKey && allKeys.has(p.parentKey)) {
        inGraph.add(p.runKey);
      }
    }

    // If no run participates in any parent→child relationship, skip naming entirely.
    if (inGraph.size === 0) return;

    // 5. Find the root for each run by walking the parent chain.
    //    A root is a run whose parent is absent from this batch.
    const rootCache = new Map<string, string>();
    const findRoot = (runKey: string): string => {
      if (rootCache.has(runKey)) return rootCache.get(runKey)!;
      const parent = parentMap.get(runKey);
      if (parent === null || parent === undefined || !allKeys.has(parent)) {
        rootCache.set(runKey, runKey);
        return runKey;
      }
      const root = findRoot(parent);
      rootCache.set(runKey, root);
      return root;
    };

    // 6. Assign a tree index to each unique root in order of first
    //    appearance in the run list.
    const treeIndex = new Map<string, number>();
    for (const p of parsed) {
      if (!p.runKey || !inGraph.has(p.runKey)) continue;
      const root = findRoot(p.runKey);
      if (!treeIndex.has(root)) {
        treeIndex.set(root, treeIndex.size);
      }
    }

    // 7. Compute depth by walking the parent chain.
    const depthCache = new Map<string, number>();
    const computeDepth = (runKey: string): number => {
      if (depthCache.has(runKey)) return depthCache.get(runKey)!;
      const parent = parentMap.get(runKey);
      if (parent === null || parent === undefined || !allKeys.has(parent)) {
        depthCache.set(runKey, 0);
        return 0;
      }
      const d = computeDepth(parent) + 1;
      depthCache.set(runKey, d);
      return d;
    };

    // 8. Apply the new checkName only to runs that are part of the tree.
    //    Runs without a valid externalId or outside the graph keep their
    //    original name.
    interface RunMeta {
      depth: number;
      treeIndex: number;
    }
    const runMeta = new Map<JenkinsCheckRun, RunMeta>();
    for (let i = 0; i < runs.length; i++) {
      const { runKey } = parsed[i];
      if (!runKey || !inGraph.has(runKey)) continue;
      const meta: RunMeta = {
        depth: computeDepth(runKey),
        treeIndex: treeIndex.get(findRoot(runKey))!,
      };
      runMeta.set(runs[i], meta);
      const level = String(meta.depth + 1).padStart(2, "0");
      const emoji = hasChildren.has(runKey)
        ? ChecksFetcher.TREE_EMOJI
        : ChecksFetcher.LEAF_EMOJI;
      runs[i].checkName = `${level} ${emoji} ${runs[i].checkName}`;
    }

    // 9. Stable-sort: in-graph runs first, grouped by tree, then by depth
    //    within each tree.  Non-graph runs stay at the end.
    runs.sort((a, b) => {
      const ma = runMeta.get(a);
      const mb = runMeta.get(b);
      if (!ma && !mb) return 0;
      if (!ma) return 1;
      if (!mb) return -1;
      if (ma.treeIndex !== mb.treeIndex) return ma.treeIndex - mb.treeIndex;
      return ma.depth - mb.depth;
    });
  }

  private fetchFromJenkins(
    jenkins: Config,
    repo: string,
    url: string,
    method: string,
  ): Promise<Response> {
    if (!jenkins.user) {
      const options: RequestInit = { credentials: "include" };
      return fetch(url, options);
    }

    const dst = new URL(url);
    const extractPath = `${dst.pathname.substring(1)}${dst.search}`;
    const pluginName = encodeURIComponent(this.plugin.getPluginName());
    const payload: ProxyInput = {
      jenkinsname: jenkins.name,
      urlpath: encodeURI(extractPath),
      method: method,
    };
    return this.plugin
      .restApi()
      .post(
        `/projects/${encodeURIComponent(repo)}/${pluginName}~proxy-trigger`,
        payload,
      );
  }

  private rerun(
    jenkins: Config,
    repo: string,
    url: string,
    runKey: string,
  ): Promise<ActionResult> {
    if (runKey) this.triggeredReruns.set(runKey, Date.now());
    return this.fetchFromJenkins(jenkins, repo, url, "POST")
      .then((_) => {
        return {
          message: "Run triggered.",
          shouldReload: true,
        };
      })
      .catch((e) => {
        const msg: string = e.message;
        /* Redirect that is not to be considered as error */
        if (msg.includes("302")) {
          return {
            message: "Run triggered.",
            shouldReload: true,
          };
        }
        return { message: `Triggering the run failed: ${e.message}` };
      });
  }
}
