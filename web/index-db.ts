/**
 * @license
 * Copyright 2026 Amarula Solutions
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

/**
 * Composite Key: [name, changeNumber, patchsetNumber, numberOfRuns]
 */
export type RequestKey = [
  name: string,
  changeNumber: number,
  patchsetNumber: number,
  numberOfRuns: number,
];

/**
 * Coverage cache key: [jenkinsName, changeNumber, patchsetNumber, attempt]
 */
export type CoverageCacheKey = [
  name: string,
  changeNumber: number,
  patchsetNumber: number,
  attempt: number,
];

/**
 * Runs cache key: [jenkinsName, changeNumber, patchsetNumber]
 * Caches the raw JenkinsCheckRun[] payload for stale-while-revalidate.
 */
export type RunsCacheKey = [
  name: string,
  changeNumber: number,
  patchsetNumber: number,
];

type CacheKey = RequestKey | CoverageCacheKey | RunsCacheKey;

interface CacheEntry<T> {
  key: CacheKey;
  value: T;
  lastAccessed: number;
}

/** Current DB version — v3 invalidates coverage_store (entry shape and key changed). */
const DB_VERSION = 3;

/**
 * A persistent LRU cache for browser request data using IndexedDB.
 * Automatically evicts older entries when capacity is reached and
 * prunes stale run data when the number of runs for a specific change changes.
 *
 * Supports multiple object stores within a single database:
 *  - "request_store"  — fetcher check-run data (4-element RequestKey)
 *                       and raw runs payloads (3-element RunsCacheKey)
 *  - "coverage_store" — coverage report data (3-element CoverageCacheKey)
 */
export class RequestLRUCache<T> {
  private dbName: string = "GerritRequestDB";
  private db: IDBDatabase | null = null;

  constructor(
    private capacity: number,
    private storeName: string,
  ) {}

  /**
   * Initializes the database connection and object stores.
   */
  async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("request_store")) {
          const store = db.createObjectStore("request_store", {
            keyPath: "key",
          });
          store.createIndex("lastAccessed", "lastAccessed");
        }
        // The coverage cache entry's shape changed (percentages now carries
        // both `incremental` and `absolute`), so entries written by older
        // versions are dropped and rebuilt on the next fetch.
        if (event.oldVersion < 3 && db.objectStoreNames.contains("coverage_store")) {
          db.deleteObjectStore("coverage_store");
        }
        if (!db.objectStoreNames.contains("coverage_store")) {
          const store = db.createObjectStore("coverage_store", {
            keyPath: "key",
          });
          store.createIndex("lastAccessed", "lastAccessed");
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Retrieves data and updates its 'lastAccessed' timestamp.
   */
  async get(key: CacheKey): Promise<T | undefined> {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);

      const request = store.get(key as IDBValidKey);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry<T> | undefined;
        if (entry) {
          // Update timestamp to move this entry to the "Recently Used" end
          entry.lastAccessed = Date.now();
          store.put(entry);
          resolve(entry.value);
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Stores data in the cache.
   *
   * For 4-element fetcher keys: deletes stale entries for the same
   * [name, change, patch] with a different [runs] count before inserting.
   *
   * For coverage keys (≠ 4 elements): simple LRU eviction — overwrites
   * any existing entry with the same key, evicts oldest if over capacity.
   */
  async put(key: CacheKey, value: T): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);

      const doPut = () => {
        const countReq = store.count();
        countReq.onsuccess = () => {
          if (countReq.result >= this.capacity) {
            const index = store.index("lastAccessed");
            index.openCursor().onsuccess = (ev) => {
              const lruCursor = (ev.target as IDBRequest<IDBCursorWithValue>)
                .result;
              if (lruCursor) lruCursor.delete();
            };
          }
          const entry: CacheEntry<T> = { key, value, lastAccessed: Date.now() };
          store.put(entry);
        };
      };

      // Staleness pruning only applies to 4-element fetcher keys in request_store
      if (this.storeName === "request_store" && key.length >= 4) {
        const [name, changeNumber, patchsetNumber, runs] = key;
        const range = IDBKeyRange.bound(
          [name, changeNumber, patchsetNumber, 0] as IDBValidKey,
          [name, changeNumber, patchsetNumber, Infinity] as IDBValidKey,
        );
        const cursorRequest = store.openCursor(range);

        cursorRequest.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const existingKey = cursor.key as RequestKey;
            if (existingKey[3] !== runs) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            doPut();
          }
        };
      } else {
        doPut();
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Clears all cached requests.
   */
  async clear(): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.storeName, "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
