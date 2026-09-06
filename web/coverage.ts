/**
 * @license
 * Copyright (C) 2024 The Android Open Source Project
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
import { PluginApi } from "@gerritcodereview/typescript-api/plugin";
import {
  CoverageRange,
  CoverageType,
  Side,
} from "@gerritcodereview/typescript-api/diff";
import {
  Category,
  CheckResult,
  CheckRun,
  FetchResponse,
  ResponseCode,
  RunStatus,
} from "@gerritcodereview/typescript-api/checks";
import {
  ChangeInfo,
  RevisionInfo,
} from "@gerritcodereview/typescript-api/rest-api";
import { Config } from "./fetcher";
import { CoverageCacheKey } from "./index-db";
import { coverageCacheService } from "./request-cache-service";

export declare interface PercentageData {
  absolute?: number;
  incremental?: number;
  absolute_unit_tests?: number;
  incremental_unit_tests?: number;
}

declare interface CoverageChangeInfo {
  changeNum: number;
  patchNum: number | undefined;
  jenkinsUrl: string;
}

declare interface JenkinsRunEntry {
  status: string;
  statusLink: string;
  attempt: number;
}

/** A completed Jenkins run that has coverage data. */
declare interface CoverageRun {
  statusLink: string;
  attempt: number;
}

/**
 * Aggregate coverage statistics (all flat key → percentage string).
 * e.g. {"line": "88.44%", "branch": "82.19%", "class": "96.88%", ...}
 */
declare interface CoverageStats {
  [metric: string]: string | undefined;
}

/**
 * Quality gate result item.
 */
declare interface QualityGateItem {
  qualityGate: string;
  result: string;
  threshold: number;
  value: string;
}

/**
 * Response from /coverage/api/json
 * _class: io.jenkins.plugins.coverage.metrics.restapi.CoverageApi
 */
declare interface ProjectCoverageResponse {
  _class?: string;
  projectStatistics?: CoverageStats;
  projectDelta?: CoverageStats;
  modifiedFilesStatistics?: CoverageStats;
  modifiedFilesDelta?: CoverageStats;
  modifiedLinesStatistics?: CoverageStats;
  modifiedLinesDelta?: CoverageStats;
  qualityGates?: {
    overallResult: string;
    resultItems?: QualityGateItem[];
  };
  referenceBuild?: string;
}

/**
 * A block of modified lines from /coverage/modified/api/json.
 */
declare interface ModifiedLinesBlock {
  startLine: number;
  endLine: number;
  type: string; // "COVERED", "MISSED", etc.
}

/**
 * Per-file modified lines entry from /coverage/modified/api/json.
 */
declare interface ModifiedLinesFile {
  fullyQualifiedFileName: string;
  modifiedLinesBlocks: ModifiedLinesBlock[];
}

/**
 * Response from /coverage/modified/api/json
 * _class: io.jenkins.plugins.coverage.metrics.restapi.ModifiedLinesCoverageApi
 */
declare interface ModifiedLinesResponse {
  _class?: string;
  files: ModifiedLinesFile[];
}

/**
 * Per-file whole-file (absolute) coverage entry from /coverage/files/api/json.
 */
declare interface FileCoverageFile {
  fullyQualifiedFileName: string;
  /** Metric name → formatted percentage, e.g. {"line": "88.44%", "branch": "82.19%"}. */
  metrics?: CoverageStats;
}

/**
 * Response from /coverage/files/api/json
 * _class: io.jenkins.plugins.coverage.metrics.restapi.FileCoverageApi
 */
declare interface FileCoverageResponse {
  _class?: string;
  files: FileCoverageFile[];
}

const OVERALL_LOW_COVERAGE_WARNING_BAR = 70;

const LOW_COVERAGE_REASON_PREFIXES = [
  "TRIVIAL_CHANGE",
  "TESTS_ARE_DISABLED",
  "TESTS_IN_SEPARATE_CL",
  "HARD_TO_TEST",
  "COVERAGE_UNDERREPORTED",
  "LARGE_SCALE_REFACTOR",
  "EXPERIMENTAL_CODE",
  "OTHER",
];

// Coverage-tier emoji matching the Jenkins Coverage plugin weather-icon
// conventions: >= 80% sunny, 60-79% partly cloudy, 40-59% cloudy, < 40% stormy.
const COVERAGE_GOOD = "\u{1F7E2}"; // 🟢 green circle
const COVERAGE_MODERATE = "\u{1F7E1}"; // 🟡 yellow circle
const COVERAGE_POOR = "\u{1F7E0}"; // 🟠 orange circle
const COVERAGE_CRITICAL = "\u{1F534}"; // 🔴 red circle
const COVERAGE_CHART = "\u{1F4CA}"; // 📊 bar chart

/**
 * Returns a coverage-tier emoji matching the Jenkins Coverage plugin's
 * weather-icon conventions:
 *   >= 80% → 🟢 (good / sunny)
 *   60-79% → 🟡 (moderate / partly cloudy)
 *   40-59% → 🟠 (poor / cloudy)
 *   < 40%  → 🔴 (critical / stormy)
 */
export function coverageEmoji(pct: number | undefined): string {
  if (pct === undefined) return "";
  if (pct >= 80) return COVERAGE_GOOD;
  if (pct >= 60) return COVERAGE_MODERATE;
  if (pct >= 40) return COVERAGE_POOR;
  return COVERAGE_CRITICAL;
}

/**
 * Returns the Jenkins Coverage plugin report URL id for a config.  Defaults to
 * the plugin's built-in id ("coverage") when the config does not override it
 * via `coverage_id`.
 */
export function coverageUrlId(jenkins: Config): string {
  return jenkins.coverage_id ?? "coverage";
}

export function parsePct(pct?: string): number | undefined {
  if (!pct) return undefined;
  const n = parseFloat(pct.replace("%", "").replace("+", ""));
  return isNaN(n) ? undefined : n;
}

export function parseProject(pathName: string): string {
  if (!pathName.startsWith("/c/")) throw new Error(`Invalid path: ${pathName}`);
  const idx = pathName.indexOf("/+");
  if (idx === -1) throw new Error(`Invalid path: ${pathName}`);
  return pathName.substring(3, idx);
}

/**
 * Decodes the HTML entities commonly emitted by Jenkins so they render as
 * literal characters instead of raw markup.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Converts the Jenkins Coverage plugin's `referenceBuild` value into clean
 * text. The API returns an HTML anchor (e.g.
 * `<a href="https://…/167/" class="model-link inside">… #167</a>`), which would
 * otherwise leak raw tags into the check result message. When the value carries
 * a URL this returns a markdown link so it stays clickable; otherwise it falls
 * back to the plain text (or the input unchanged when nothing is extractable).
 */
export function formatReferenceBuild(referenceBuild: string): string {
  const anchor = referenceBuild.match(
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  );
  if (anchor) {
    const text = decodeHtmlEntities(anchor[2].replace(/<[^>]*>/g, "")).trim();
    return text ? `[${text}](${anchor[1]})` : anchor[1];
  }
  const text = decodeHtmlEntities(referenceBuild.replace(/<[^>]*>/g, "")).trim();
  return text || referenceBuild.trim();
}

export function getLowCoverageReason(
  commitMessage?: string,
): string | undefined {
  if (!commitMessage) return undefined;
  const re = /Low-Coverage-Reason:(.*)/g;
  const matches = [...commitMessage.matchAll(re)];
  if (matches.length === 0 || matches[0].length === 0) return undefined;
  return matches[0][matches[0].length - 1].toString().trim() || undefined;
}

interface CoverageCacheEntry {
  changeInfo: CoverageChangeInfo;
  /** Current statusLink from the completed run.  null when no run found. */
  statusLink: string | null;
  /** Attempt number of the completed run. */
  attempt: number | null;
  /** Raw project-level response (for checks). */
  projectResponse: ProjectCoverageResponse | null;
  /** Parsed per-file ranges (for diff annotations). */
  ranges: { [path: string]: CoverageRange[] } | null;
  /** Parsed per-file percentages (for file list columns). */
  percentages: { [path: string]: PercentageData } | null;
}

export class CoverageClient {
  private static readonly MEMORY_CACHE_LIMIT = 10;

  private plugin: PluginApi;

  /** Cached Jenkins configs, keyed by repo. */
  private configs: Config[] | null = null;
  private configsRepo: string | null = null;
  /** In-flight config fetch to dedupe concurrent calls. */
  private configsPromise: Promise<Config[]> | null = null;

  /** True when the coverage endpoints returned 403 — skip future fetches. */
  private coverageUnavailable: boolean = false;

  /**
   * In-memory LRU cache for coverage entries, keyed per attempt.
   * Key: JSON.stringify([jenkinsName, changeNum, patchNum, attempt])
   */
  private cache: Map<string, CoverageCacheEntry> = new Map();

  /** Completed runs per change+patchset, so repeated calls skip the runs fetch. */
  private runsCache: Map<string, CoverageRun[]> = new Map();

  /**
   * In-flight fetch promises, keyed by change+patchset.
   * Deduplicates concurrent calls for the same change+patchset.
   */
  private pendingFetches: Map<string, Promise<CoverageRun[] | null>> =
    new Map();

  constructor(plugin: PluginApi) {
    this.provideCoverageRanges = this.provideCoverageRanges.bind(this);
    this.prefetchCoverageRanges = this.prefetchCoverageRanges.bind(this);
    this.provideCoveragePercentages =
      this.provideCoveragePercentages.bind(this);
    this.plugin = plugin;
  }

  // ---- Config fetching ----

  private async fetchConfig(repo: string): Promise<Config[]> {
    const pluginName = encodeURIComponent(this.plugin.getPluginName());
    return this.plugin
      .restApi()
      .get<Config[]>(
        `/projects/${encodeURIComponent(repo)}/${pluginName}~config`,
      );
  }

  private async ensureConfig(repo: string): Promise<Config | null> {
    if (this.configs && repo === this.configsRepo && !this.configsPromise)
      return this.configs?.[0] ?? null;
    // Dedupe concurrent calls
    if (!this.configsPromise || repo !== this.configsRepo) {
      this.configsPromise = this.fetchConfig(repo);
      this.configsRepo = repo;
    }
    this.configs = await this.configsPromise;
    return this.configs?.[0] ?? null;
  }

  private isEnabled(): boolean {
    return this.configs?.[0]?.coverage_enabled === true;
  }

  // ---- JSON / HTTP helpers ----

  private async toJson(response: Response) {
    try {
      return response.status != null
        ? await response.json()
        : JSON.parse(response.toString());
    } catch {
      return null;
    }
  }

  private async fetchFromJenkins(
    jenkins: Config,
    repo: string,
    url: string,
  ): Promise<Response> {
    if (!jenkins.user) return fetch(url, { credentials: "include" });
    const dst = new URL(url);
    const extractPath = `${dst.pathname.substring(1)}${dst.search}`;
    const pluginName = encodeURIComponent(this.plugin.getPluginName());
    return this.plugin
      .restApi()
      .post(
        `/projects/${encodeURIComponent(repo)}/${pluginName}~proxy-trigger`,
        {
          jenkinsname: jenkins.name,
          urlpath: encodeURI(extractPath),
          method: "GET",
        },
      );
  }

  // ---- Data fetching ----

  /**
   * Fetches the completed Jenkins runs for the given change and patchset,
   * sorted newest-attempt first.  Each run carries its own statusLink, from
   * which that attempt's coverage report is fetched.
   */
  private async findCompletedRuns(
    jenkins: Config,
    repo: string,
    changeNum: number,
    patchNum: number,
  ): Promise<CoverageRun[] | null> {
    const runsUrl = `${jenkins.url}/gerrit-checks/runs?change=${changeNum}&patchset=${patchNum}`;
    const response = await (async () => {
      try {
        return await this.fetchFromJenkins(jenkins, repo, runsUrl);
      } catch {
        return null;
      }
    })();
    if (
      response == null ||
      (response.status != null && response.status === 403)
    )
      return null;

    const data = await this.toJson(response);
    // When Jenkins returns 5xx, the proxy sends _jenkins_unavailable rather
    // than an error status.  Treat it the same as a 403 / null response.
    if (data != null && data._jenkins_unavailable) {
      return null;
    }
    if (!data?.runs || !Array.isArray(data.runs) || data.runs.length === 0)
      return [];

    return (data.runs as JenkinsRunEntry[])
      .filter((r) => r.status === "COMPLETED" && r.statusLink)
      .map((r) => ({ statusLink: r.statusLink, attempt: r.attempt }))
      .sort((a, b) => b.attempt - a.attempt);
  }

  /**
   * Fetches and merges the coverage endpoints:
   *  1. /{coverage_id}/api/json          — project stats
   *  2. /{coverage_id}/modified/api/json — per-file modified-line blocks
   *  3. /{coverage_id}/files/api/json    — per-file whole-file coverage
   */
  private async fetchAllCoverage(
    jenkins: Config,
    repo: string,
    statusLink: string,
  ): Promise<{
    projectResponse: ProjectCoverageResponse | null;
    modifiedLines: ModifiedLinesResponse | null;
    fileCoverage: FileCoverageResponse | null;
  }> {
    if (this.coverageUnavailable) {
      return { projectResponse: null, modifiedLines: null, fileCoverage: null };
    }

    const coverageId = coverageUrlId(jenkins);
    const fetchOne = async (path: string) => {
      try {
        return await this.fetchFromJenkins(
          jenkins,
          repo,
          `${statusLink}${path}`,
        );
      } catch {
        return null;
      }
    };

    // Fetch the endpoints in parallel — they are independent.
    const [projResp, modResp, fileResp] = await Promise.all([
      fetchOne(`${coverageId}/api/json`),
      fetchOne(`${coverageId}/modified/api/json`),
      fetchOne(`${coverageId}/files/api/json`),
    ]);

    // If both core endpoints returned 403, the coverage plugin is not
    // installed — remember it to avoid re-fetching on future polls.
    const projDenied = !!(
      projResp &&
      projResp.status != null &&
      projResp.status === 403
    );
    const modDenied = !!(
      modResp &&
      modResp.status != null &&
      modResp.status === 403
    );
    if (projDenied && modDenied) {
      this.coverageUnavailable = true;
      return { projectResponse: null, modifiedLines: null, fileCoverage: null };
    }

    let projectResponse: ProjectCoverageResponse | null = null;
    if (projResp && !projDenied) {
      projectResponse = await this.toJson(projResp);
    }

    let modifiedLines: ModifiedLinesResponse | null = null;
    if (modResp && !modDenied) {
      modifiedLines = await this.toJson(modResp);
    }

    // The files endpoint is newer than the other two and 404s on older plugin
    // versions. Parse it defensively: a missing/unparseable response simply
    // leaves absolute coverage empty (the parser skips responses without files).
    let fileCoverage: FileCoverageResponse | null = null;
    if (fileResp && !(fileResp.status != null && fileResp.status === 403)) {
      fileCoverage = await this.toJson(fileResp);
    }

    return { projectResponse, modifiedLines, fileCoverage };
  }

  // ---- Parsing ----

  /**
   * Computes per-file incremental coverage percentages from modified line
   * blocks.  The modified-lines endpoint only reports lines changed by this
   * CL, so the result is the coverage of new/changed lines, not the whole
   * file.  Percentage = covered lines / total modified lines * 100.
   */
  private computePercentages(resp: ModifiedLinesResponse | null): {
    [path: string]: PercentageData;
  } {
    const pcts: { [path: string]: PercentageData } = {};
    if (!resp?.files) return pcts;

    for (const file of resp.files) {
      if (!file.fullyQualifiedFileName || !file.modifiedLinesBlocks) continue;

      let covered = 0;
      let missed = 0;
      for (const block of file.modifiedLinesBlocks) {
        const lineCount = block.endLine - block.startLine + 1;
        if (block.type === "COVERED") {
          covered += lineCount;
        } else {
          missed += lineCount;
        }
      }

      const total = covered + missed;
      if (total > 0) {
        pcts[file.fullyQualifiedFileName] = {
          incremental: Math.round((covered / total) * 100),
        };
      }
    }
    return pcts;
  }

  /**
   * Computes per-file absolute (whole-file) coverage percentages from the
   * /coverage/files/api/json response.  Uses the line-coverage metric.
   */
  private computeAbsolutePercentages(resp: FileCoverageResponse | null): {
    [path: string]: PercentageData;
  } {
    const pcts: { [path: string]: PercentageData } = {};
    if (!resp?.files) return pcts;

    for (const file of resp.files) {
      if (!file.fullyQualifiedFileName) continue;
      const line = parsePct(file.metrics?.line);
      if (line !== undefined) {
        pcts[file.fullyQualifiedFileName] = { absolute: line };
      }
    }
    return pcts;
  }

  /**
   * Parses per-file line-level coverage ranges from the modified lines response.
   * Each block has {startLine, endLine, type: "COVERED"|"MISSED"|...}.
   */
  private parseRanges(resp: ModifiedLinesResponse | null): {
    [path: string]: CoverageRange[];
  } {
    const ranges: { [path: string]: CoverageRange[] } = {};
    if (!resp?.files) return ranges;

    for (const file of resp.files) {
      if (!file.fullyQualifiedFileName || !file.modifiedLinesBlocks) continue;

      const fileRanges: CoverageRange[] = [];
      for (const block of file.modifiedLinesBlocks) {
        if (block.startLine == null || block.endLine == null || !block.type)
          continue;
        fileRanges.push({
          side: Side.RIGHT,
          type:
            block.type === "COVERED"
              ? CoverageType.COVERED
              : CoverageType.NOT_COVERED,
          code_range: {
            start_line: block.startLine,
            end_line: block.endLine,
          },
        });
      }

      if (fileRanges.length > 0) {
        ranges[file.fullyQualifiedFileName] = fileRanges;
      }
    }
    return ranges;
  }

  // ---- Cache helpers ----

  private makeMemoryKey(
    jenkinsName: string,
    changeNum: number,
    patchNum: number,
    attempt: number,
  ): string {
    return JSON.stringify([jenkinsName, changeNum, patchNum, attempt]);
  }

  private makePatchsetKey(
    jenkinsName: string,
    changeNum: number,
    patchNum: number,
  ): string {
    return JSON.stringify([jenkinsName, changeNum, patchNum]);
  }

  /**
   * Insert / touch `entry` in the in-memory LRU map, evicting the oldest
   * entry when the map exceeds MEMORY_CACHE_LIMIT.
   */
  private setMemoryCache(key: string, entry: CoverageCacheEntry): void {
    // Delete-then-set to move the key to the "most recently used" end
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CoverageClient.MEMORY_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  // ---- Cache management ----

  /**
   * Populates the coverage cache for every completed attempt of the given
   * change+patchset and returns the completed runs (newest attempt first).
   *
   * Lookup order per attempt:
   *  1. In-memory Map (fast, survives same-page navigation)
   *  2. IndexedDB         (persistent, survives page reloads)
   *
   * On an IndexedDB hit the cached statusLink is compared against the run's
   * current statusLink; only when they differ do we re-fetch the heavy
   * coverage payloads.
   */
  private async updateCache(
    jenkins: Config,
    repo: string,
    changeNum: number,
    patchNum: number,
  ): Promise<CoverageRun[] | null> {
    if (isNaN(changeNum) || isNaN(patchNum) || changeNum <= 0 || patchNum <= 0)
      return null;

    const patchsetKey = this.makePatchsetKey(jenkins.name, changeNum, patchNum);

    // Reuse already-known completed runs for this patchset.
    const known = this.runsCache.get(patchsetKey);
    if (known) return known;

    // Dedupe concurrent calls for the same change+patchset.
    const pending = this.pendingFetches.get(patchsetKey);
    if (pending) return pending;

    const promise = this.doUpdateCache(jenkins, repo, changeNum, patchNum);
    this.pendingFetches.set(patchsetKey, promise);
    try {
      const runs = await promise;
      if (runs) this.runsCache.set(patchsetKey, runs);
      return runs;
    } finally {
      this.pendingFetches.delete(patchsetKey);
    }
  }

  private async doUpdateCache(
    jenkins: Config,
    repo: string,
    changeNum: number,
    patchNum: number,
  ): Promise<CoverageRun[] | null> {
    const runs = await this.findCompletedRuns(jenkins, repo, changeNum, patchNum).catch(
      () => null,
    );
    if (runs === null) return null;

    for (const run of runs) {
      await this.ensureRunCached(jenkins, repo, changeNum, patchNum, run);
    }
    return runs;
  }

  private async ensureRunCached(
    jenkins: Config,
    repo: string,
    changeNum: number,
    patchNum: number,
    run: CoverageRun,
  ): Promise<void> {
    const memKey = this.makeMemoryKey(
      jenkins.name,
      changeNum,
      patchNum,
      run.attempt,
    );

    // In-memory hit — touch and return.
    const existing = this.cache.get(memKey);
    if (existing) {
      this.setMemoryCache(memKey, existing);
      return;
    }

    const cacheKey: CoverageCacheKey = [
      jenkins.name,
      changeNum,
      patchNum,
      run.attempt,
    ];
    const dbEntry = await coverageCacheService.get(cacheKey).catch(
      () => undefined,
    );

    // IndexedDB hit with matching statusLink and attempt — promote to memory.
    if (
      dbEntry &&
      dbEntry.statusLink === run.statusLink &&
      dbEntry.attempt === run.attempt
    ) {
      this.setMemoryCache(memKey, dbEntry);
      return;
    }

    const changeInfo: CoverageChangeInfo = {
      changeNum,
      patchNum,
      jenkinsUrl: jenkins.url,
    };

    // Fetch fresh coverage data for this attempt.
    const { projectResponse, modifiedLines, fileCoverage } =
      await this.fetchAllCoverage(jenkins, repo, run.statusLink).catch((e) => {
        console.warn("checks-jenkins: coverage fetch failed", e);
        return {
          projectResponse: null,
          modifiedLines: null,
          fileCoverage: null,
        };
      });

    // Merge incremental (modified lines) and absolute (whole file) coverage
    // into a single per-file map.
    const percentages = this.computePercentages(modifiedLines);
    for (const [path, absolute] of Object.entries(
      this.computeAbsolutePercentages(fileCoverage),
    )) {
      percentages[path] = { ...percentages[path], ...absolute };
    }

    const entry: CoverageCacheEntry = {
      changeInfo,
      statusLink: run.statusLink,
      attempt: run.attempt,
      projectResponse,
      ranges: this.parseRanges(modifiedLines),
      percentages,
    };

    this.setMemoryCache(memKey, entry);
    await coverageCacheService.put(cacheKey, entry);
  }

  // ---- Public API ----

  async provideCoverageRanges(
    changeNum: number,
    path: string,
    _basePatchNum: number | undefined,
    patchNum: number | undefined,
  ): Promise<CoverageRange[] | undefined> {
    if (patchNum === undefined) return undefined;
    try {
      const repo = parseProject(window.location.pathname);
      const jenkins = await this.ensureConfig(repo);
      if (!jenkins || !this.isEnabled()) return undefined;
      const runs = await this.updateCache(jenkins, repo, changeNum, patchNum);
      if (!runs || runs.length === 0) return undefined;
      const entry = this.cache.get(
        this.makeMemoryKey(jenkins.name, changeNum, patchNum, runs[0].attempt),
      );
      return entry?.ranges?.[path] || [];
    } catch {
      return undefined;
    }
  }

  async prefetchCoverageRanges(
    change: ChangeInfo,
    revision: RevisionInfo,
  ): Promise<void> {
    let patchNum = NaN;
    if (typeof revision._number === "number") patchNum = revision._number;
    try {
      const jenkins = await this.ensureConfig(change.project);
      if (!jenkins || !this.isEnabled()) return;
      await this.updateCache(jenkins, change.project, change._number, patchNum);
    } catch (e) {
      console.info("checks-jenkins: prefetch error", e);
    }
  }

  async provideCoveragePercentages(
    changeNum: string,
    path: string,
    patchNum: string,
  ): Promise<PercentageData | null> {
    try {
      const repo = parseProject(window.location.pathname);
      const jenkins = await this.ensureConfig(repo);
      if (!jenkins || !this.isEnabled()) return null;
      const runs = await this.updateCache(
        jenkins,
        repo,
        Number(changeNum),
        Number(patchNum),
      );
      if (!runs || runs.length === 0) return null;
      const entry = this.cache.get(
        this.makeMemoryKey(
          jenkins.name,
          Number(changeNum),
          Number(patchNum),
          runs[0].attempt,
        ),
      );
      return entry?.percentages?.[path] || null;
    } catch {
      return null;
    }
  }

  // ---- Checks provider ----

  async mayBeShowLowCoverageAlert(
    changeNum: number,
    patchNum: number,
    commitMessage?: string,
    repo?: string,
  ): Promise<FetchResponse> {
    try {
      const project = repo || parseProject(window.location.pathname);
      const jenkins = await this.ensureConfig(project);
      if (!jenkins || !this.isEnabled())
        return { responseCode: ResponseCode.OK, runs: [] };

      const coverageId = coverageUrlId(jenkins);
      const reason = getLowCoverageReason(commitMessage);
      const responseRuns: CheckRun[] = [];

      // One Code Coverage run per completed attempt, each bound to its own
      // statusLink so switching attempts shows that attempt's coverage.
      const runs = await this.updateCache(jenkins, project, changeNum, patchNum);
      if (runs) {
        for (const run of runs) {
          const entry = this.cache.get(
            this.makeMemoryKey(jenkins.name, changeNum, patchNum, run.attempt),
          );
          const coverageResults = this.buildCoverageResults(entry, reason);
          if (coverageResults.length > 0) {
            responseRuns.push({
              checkName: "Code Coverage",
              status: RunStatus.COMPLETED,
              attempt: run.attempt,
              results: coverageResults,
              statusLink: entry?.statusLink
                ? `${entry.statusLink}${coverageId}`
                : undefined,
            });
          }
        }
      }

      if (
        reason &&
        !LOW_COVERAGE_REASON_PREFIXES.some((v) => reason.startsWith(v))
      ) {
        responseRuns.push({
          checkName: "Low-Coverage-Reason Format Check",
          status: RunStatus.COMPLETED,
          results: [
            {
              category: Category.WARNING,
              summary: "Low-Coverage-Reason footer is not properly formatted",
              message:
                `Reason "${reason}" must start with one of: ` +
                LOW_COVERAGE_REASON_PREFIXES.join(", ") +
                ".",
            },
          ],
        });
      }

      return { responseCode: ResponseCode.OK, runs: responseRuns };
    } catch (e) {
      console.info("checks-jenkins: mayBeShowLowCoverageAlert error", e);
      return { responseCode: ResponseCode.OK, runs: [] };
    }
  }

  /**
   * Builds the coverage check results for a single attempt's cached entry:
   * per-file low-coverage alerts, falling back to project-level stats.
   */
  private buildCoverageResults(
    entry: CoverageCacheEntry | undefined,
    reason: string | undefined,
  ): CheckResult[] {
    const projectResp = entry?.projectResponse;
    const percentages = entry?.percentages || {};
    const coverageResults: CheckResult[] = [];

    // Per-file low-coverage alerts
    for (const file of Object.keys(percentages)) {
      const inc = percentages[file].incremental;
      if (inc !== undefined && inc < OVERALL_LOW_COVERAGE_WARNING_BAR) {
        coverageResults.push({
          category: reason ? Category.INFO : Category.WARNING,
          summary: `${COVERAGE_CRITICAL} ${file}: incremental ${inc}% < ${OVERALL_LOW_COVERAGE_WARNING_BAR}%`,
          message: reason
            ? "Low-Coverage-Reason provided — CL will not be blocked."
            : "Please add tests for uncovered lines or add Low-Coverage-Reason in commit message.",
        });
      }
    }

    // Fallback: show project-level stats
    if (coverageResults.length === 0 && projectResp?.projectStatistics) {
      const s = projectResp.projectStatistics;
      const parts: string[] = [];
      if (s.line)
        parts.push(`Line: ${coverageEmoji(parsePct(s.line))} ${s.line}`);
      if (s.branch)
        parts.push(
          `Branch: ${coverageEmoji(parsePct(s.branch))} ${s.branch}`,
        );
      if (s.file)
        parts.push(`File: ${coverageEmoji(parsePct(s.file))} ${s.file}`);
      if (s.class)
        parts.push(`Class: ${coverageEmoji(parsePct(s.class))} ${s.class}`);
      if (parts.length > 0) {
        const linePct = parsePct(s.line);
        coverageResults.push({
          category:
            linePct !== undefined &&
            linePct < OVERALL_LOW_COVERAGE_WARNING_BAR
              ? Category.WARNING
              : Category.INFO,
          summary: `${COVERAGE_CHART} Project coverage: ${parts.join(", ")}`,
          message:
            `Coverage metrics for this build. Loc: ${s.loc || "N/A"}.` +
            (projectResp.referenceBuild && projectResp.referenceBuild !== "-"
              ? ` Reference build: ${formatReferenceBuild(projectResp.referenceBuild)}.`
              : ""),
        });
      }
    }

    return coverageResults;
  }

  async showPercentageColumns(): Promise<boolean> {
    try {
      const repo = parseProject(window.location.pathname);
      const jenkins = await this.ensureConfig(repo);
      return jenkins?.coverage_enabled === true;
    } catch {
      return false;
    }
  }
}
