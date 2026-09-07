# Caching

The plugin uses a two-tier caching strategy: in-memory LRU for same-page navigation speed and IndexedDB for persistence across page reloads.

## Cache domains

Three independent cache strategies serve different data:

| Cache | Store name | Capacity | Key type | Data |
|---|---|---|---|---|
| Runs cache | `request_store` | 100 (shared) | `RunsCacheKey` (3-element) | Raw `JenkinsCheckRun[]` payload, served stale-while-revalidate |
| Fetcher enrichment cache | `request_store` | 100 (shared) | `RequestKey` (4-element) | Enriched warnings + test results (`CheckRun[]`) |
| Coverage cache | `coverage_store` | 50 | `CoverageCacheKey` (4-element, includes attempt) | Coverage responses, parsed ranges, percentages |

All are backed by the same IndexedDB database (`GerritRequestDB`, version 3). The two fetcher cache types share the `request_store` object store; they are distinguished by key length (3 vs 4 elements). The `coverage_store` now also uses a 4-element key (per-attempt), so its pruning is scoped to `request_store` only.

## IndexedDB layer (`index-db.ts`)

### `RequestLRUCache<T>`

A generic LRU cache backed by IndexedDB. Created per store name:

```typescript
// Fetcher cache — capacity 100, shared by runs (3-element) and enrichment (4-element)
const fetcherCache = new RequestLRUCache<any>(100, "request_store");

// Coverage cache — capacity 50
const coverageCache = new RequestLRUCache<CoverageCacheEntry>(50, "coverage_store");
```

### Key types

```typescript
// 3-element key for raw runs payloads (stale-while-revalidate)
type RunsCacheKey = [name, changeNumber, patchsetNumber];

// 4-element key for fetcher enrichment data
type RequestKey = [name, changeNumber, patchsetNumber, numberOfRuns];

// 4-element key for coverage data (per attempt)
type CoverageCacheKey = [name, changeNumber, patchsetNumber, attempt];
```

### Entry structure

Each entry stores `{key, value, lastAccessed}` with a `lastAccessed` index for LRU eviction.

### Eviction strategy

On `put()`:
1. If `count >= capacity`, open cursor on the `lastAccessed` index (ascending) and delete the oldest entry.
2. Insert the new entry with `lastAccessed = Date.now()`.

### Staleness pruning (fetcher enrichment cache only)

For 4-element `RequestKey` entries, before inserting a new entry the cache scans for existing entries with the same `[name, changeNumber, patchsetNumber]` prefix:

```typescript
const range = IDBKeyRange.bound(
    [name, changeNumber, patchsetNumber, 0],
    [name, changeNumber, patchsetNumber, Infinity]
);
```

Any existing entry with a different `numberOfRuns` (4th element) is deleted — the run count changed, so the cached enrichment data is stale.

### `get()` touch

On read, the `lastAccessed` timestamp is updated to move the entry to the "recently used" end of the LRU order.

## Runs cache (stale-while-revalidate)

`ChecksFetcher.fetch()` caches the raw `JenkinsCheckRun[]` payload from the `/gerrit-checks/runs` endpoint using a 3-element `RunsCacheKey`. This is a **stale-while-revalidate** pattern: cached data is returned immediately, then refreshed in the background.

### Why cache raw runs?

`CheckRun` objects contain function closures in `actions[].callback` that cannot be serialized to IndexedDB. By caching the raw `JenkinsCheckRun[]` before `convert()`, each poll still runs the full enrichment pipeline (tree naming, error explanations, warnings, tests, conversion) — only the slowest network hop is skipped.

### Cache entry format

```typescript
interface CachedRuns {
  runs: JenkinsCheckRun[];  // raw runs, before computeTreeNames() mutation
  timestamp: number;         // Date.now() at write time
}
```

### Fetch flow

```
fetch(changeData)
  │
  ├─ Start network request (don't await)
  │
  ├─ Check cache: cacheService.get([name, changeNumber, patchsetNumber])
  │
  ├─ Cache HIT (entry exists AND age < TTL):
  │     • Use cached runs for this poll's response
  │     • Fire backgroundUpdateRuns(networkPromise, key, structuredClone(cachedRuns))
  │     • Proceed to enrichment + convert + return
  │
  └─ Cache MISS (no entry, expired, or empty):
        • Await network response
        • Auth checks (403/null → NOT_LOGGED_IN)
        • structuredClone(data.runs) and cache it
        • Proceed to enrichment + convert + return
```

### TTL

Cached runs expire after **2 minutes** (`RUNS_CACHE_TTL_MS`). When the TTL elapses, the next poll falls through to the network path, ensuring users never see indefinitely stale data after Jenkins becomes unreachable.

### Background update with change detection

`backgroundUpdateRuns()` runs asynchronously (not awaited). It:

1. Awaits the network response started by `fetch()`
2. Validates the response (rejects null, 403, `_jenkins_unavailable`, empty runs)
3. Compares fresh runs against the cached originals via `runsEqual()`
4. If **identical** → no-op (skips cache write and UI reload)
5. If **changed** → `structuredClone()`, write updated cache, call `onDataChanged`

`runsEqual()` performs a cheap structural comparison on fields the user sees:

```typescript
private runsEqual(a: JenkinsCheckRun[], b: JenkinsCheckRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].checkName !== b[i].checkName) return false;
    if (a[i].status !== b[i].status) return false;
    if (a[i].statusDescription !== b[i].statusDescription) return false;
  }
  return true;
}
```

This prevents spurious UI reloads when nothing actually changed (e.g., timestamps shifted but the visible data is identical).

### UI reload mechanism

When `backgroundUpdateRuns()` detects changed data, it invokes the `onDataChanged` callback. The plugin layer wires this to `plugin.checks().announceUpdate()`, which tells Gerrit to re-call `fetch()` on the next event loop tick — the fresh data is now in cache and gets served immediately.

### Mutation protection: `structuredClone()`

`computeTreeNames()` mutates runs **in-place** — rewriting `checkName` with depth/emoji prefixes and re-sorting the array. To prevent the cached reference from being corrupted:

- **Cache-miss path**: `structuredClone(data.runs)` before calling `cacheService.put()` — the clone is stored with original names intact.
- **Cache-hit path**: `structuredClone(cachedEntry.runs)` before passing to `backgroundUpdateRuns()` — the comparison uses original names from the clone, not the mutated array that `computeTreeNames()` will later modify.
- **Background update path**: `structuredClone(data.runs)` before caching fresh network data.

Without the clone, the next cache hit would see already-prefixed names (`"01 🌳 Build"`) and `computeTreeNames()` would prefix them again (`"01 🌳 01 🌳 Build"`).

## In-memory LRU (`coverage.ts`)

The `CoverageClient` maintains a second in-memory cache layer on top of IndexedDB:

```typescript
private cache: Map<string, CoverageCacheEntry> = new Map();
private static readonly MEMORY_CACHE_LIMIT = 50;
```

### Eviction

Delete-then-set to maintain MRU ordering:

```typescript
private setMemoryCache(key: string, entry: CoverageCacheEntry): void {
    this.cache.delete(key);       // remove old position
    this.cache.set(key, entry);   // insert at "most recently used" end
    if (this.cache.size > MEMORY_CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;  // Map iterates in insertion order
        if (oldest !== undefined) this.cache.delete(oldest);
    }
}
```

### Why two tiers?

- **Memory** (size 50): sub-millisecond lookup for files within the same change — the diff view asks `provideCoverageRanges()` per file, which would be too slow hitting IndexedDB every time.
- **IndexedDB** (size 50): survives page reloads. When a user navigates away and comes back, coverage data is available instantly without re-fetching from Jenkins.

## Coverage cache population flow

`CoverageClient.updateCache()` is the single entry point for populating the coverage cache. It runs per attempt, so each replayed build gets its own cached entry:

```
updateCache(jenkins, repo, changeNum, patchNum)
  │
  ├─ 1. Reuse runsCache (completed runs per patchset) → hit: return
  │
  ├─ 2. Check pendingFetches (dedup) → hit: await existing promise
  │
  ├─ 3. findCompletedRuns() → all COMPLETED runs, newest attempt first
  │
  └─ 4. For each run, fetched in parallel → ensureRunCached():
        ├─ in-memory hit → touch & return
        ├─ IndexedDB hit with matching (statusLink, attempt) → promote to memory
        └─ Fresh fetch: fetchAllCoverage() → parse → cache both tiers
```

### Staleness detection

Each attempt's entry is invalidated independently by its `(statusLink, attempt)` pair:

```typescript
if (dbEntry
    && dbEntry.statusLink === run.statusLink
    && dbEntry.attempt === run.attempt) {
    // Cache hit — promote to memory
    this.setMemoryCache(memKey, dbEntry);
    return;
}
```

When a new build completes for an attempt, the `statusLink` changes (different build number in the URL) or the `attempt` increments — that attempt's entry is invalidated and fresh data is fetched, while other attempts' entries remain valid.

## Concurrent request deduplication

A `pendingFetches` map prevents concurrent `updateCache()` calls for the same change+patchset from issuing duplicate HTTP requests, and `runsCache` reuses the already-resolved completed runs:

```typescript
private pendingFetches: Map<string, Promise<CoverageRun[] | null>> = new Map();

// In updateCache():
const patchsetKey = this.makePatchsetKey(jenkins.name, changeNum, patchNum);
const known = this.runsCache.get(patchsetKey);
if (known) return known;
const pending = this.pendingFetches.get(patchsetKey);
if (pending) return pending;  // await existing in-flight fetch

const promise = this.doUpdateCache(jenkins, repo, changeNum, patchNum);
this.pendingFetches.set(patchsetKey, promise);
try {
  const runs = await promise;
  if (runs) this.runsCache.set(patchsetKey, runs);
  return runs;
} finally {
  this.pendingFetches.delete(patchsetKey);
}
```

This is critical during `SHOW_CHANGE` where `prefetchCoverageRanges()` and `showPercentageColumns()` both call `ensureConfig()` + `updateCache()` concurrently.

## Fetcher enrichment cache

`ChecksFetcher` uses the IndexedDB cache for enriched warnings and test results:

```typescript
const cachedData: CheckRun[] = await cacheService.get(key);

if (cachedData === null || cachedData === undefined || cachedData.length == 0) {
    // Fetch warnings + tests in parallel, cache results
    const enrichmentPromises = completedRuns.flatMap(...);
    const results = await Promise.all(enrichmentPromises);
    const warningsData = results.flat().filter(Boolean);
    if (warningsData.length > 0) {
        await cacheService.put(key, warningsData.slice());
        checkRuns.push(...warningsData.slice());
    }
} else {
    checkRuns.push(...cachedData);  // cache hit — skip enrichment fetches
}
```

The cache key includes `numberOfRuns` — when the number of Jenkins runs changes, stale entries are pruned automatically by the IndexedDB layer.

## Cache capacity rationale

| Cache | Capacity | Rationale |
|---|---|---|
| Fetcher (IndexedDB) | 100 (shared) | Runs payloads (~3 KB each) and enrichment data (per-issue results) share the store. 100 entries covers several changes with multiple runs each. |
| Coverage (IndexedDB) | 50 | Coverage payloads are large (per-file blocks). 50 entries covers typical navigation patterns. |
| Coverage (memory) | 10 | A single diff view may query dozens of files. 10 change-level entries is sufficient for the current repo + a few recently viewed changes. |
