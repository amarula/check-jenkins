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
import "@gerritcodereview/typescript-api/gerrit";
import { ChecksFetcher } from "./fetcher";
import { CoverageClient } from "./coverage";
import {
  BaseComponent,
  BaseCoverageComponent,
} from "./coverage-percentage-views";
import "./coverage-percentage-views";
import {
  ChangeData,
  ResponseCode,
} from "@gerritcodereview/typescript-api/checks";
import { EventType, PluginApi } from "@gerritcodereview/typescript-api/plugin";
import {
  ChangeInfo,
  RevisionInfo,
} from "@gerritcodereview/typescript-api/rest-api";

window.Gerrit?.install(async (plugin: PluginApi): Promise<void> => {
  const fetcher = new ChecksFetcher(plugin, () => {
    // Background update detected new data — force Gerrit to re-fetch
    // checks so the UI picks up the fresh data immediately.
    plugin.checks().announceUpdate();
  });
  const coverageClient = new CoverageClient(plugin);

  // ---- Single checks provider: merge Jenkins runs + coverage ----
  plugin.checks().register(
    {
      fetch: async (changeData: ChangeData) => {
        // Fire both in parallel, but don't block the login prompt on coverage.
        // When Jenkins is unavailable the fetcher returns NOT_LOGGED_IN immediately;
        // coverage may still be resolving stale cached data — skip merging its runs.
        const [jenkinsResult, coverageResult] = await Promise.all([
          fetcher.fetch(changeData),
          coverageClient.mayBeShowLowCoverageAlert(
            changeData.changeNumber,
            changeData.patchsetNumber,
            changeData.commitMessage,
            changeData.repo,
          ),
        ]);
        if (jenkinsResult.responseCode !== ResponseCode.OK) {
          return jenkinsResult;
        }
        return {
          responseCode: ResponseCode.OK,
          runs: [...(jenkinsResult.runs || []), ...(coverageResult.runs || [])],
        };
      },
    },
    { fetchPollingIntervalSeconds: 60 },
  );

  // ---- Coverage annotations / columns / prefetch ----

  // 1. Line-level coverage annotations in the diff view
  try {
    const annotationApi = plugin.annotationApi();
    if (annotationApi) {
      annotationApi.setCoverageProvider(coverageClient.provideCoverageRanges);
    }
  } catch (e) {
    console.warn("checks-jenkins: annotationApi not available", e);
  }

  // 2. Prefetch coverage data when a change is shown,
  //    and re-evaluate column visibility for the new project.
  //    Run both in parallel — they share ensureConfig dedup so the
  //    second call hits the in-flight promise and resolves immediately.
  plugin.on(
    EventType.SHOW_CHANGE,
    async (change: ChangeInfo, revision: RevisionInfo) => {
      const [show] = await Promise.all([
        coverageClient.showPercentageColumns(),
        coverageClient.prefetchCoverageRanges(change, revision),
      ]);
      for (const instance of BaseComponent.instances) {
        instance.shown = show;
      }
    },
  );

  // 3. Dynamic custom components for coverage percentage columns
  function onAttached(needsProvider = false) {
    return (v: HTMLElement) => {
      void coverageClient.showPercentageColumns().then((show: boolean) => {
        const view = v as BaseComponent;
        view.shown = show;
        if (needsProvider) {
          (v as BaseCoverageComponent).provider =
            coverageClient.provideCoveragePercentages;
        }
      });
    };
  }

  // File list header columns
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-header",
      "absolute-header-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-header",
      "branch-header-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-header",
      "instruction-header-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-header",
      "incremental-header-view",
    )
    .onAttached(onAttached());

  // File list content columns (with percentage provider)
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-content",
      "absolute-content-view",
    )
    .onAttached(onAttached(true));
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-content",
      "branch-content-view",
    )
    .onAttached(onAttached(true));
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-content",
      "instruction-content-view",
    )
    .onAttached(onAttached(true));
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-content",
      "incremental-content-view",
    )
    .onAttached(onAttached(true));

  // File list summary columns
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-summary",
      "absolute-summary-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-summary",
      "branch-summary-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-summary",
      "instruction-summary-view",
    )
    .onAttached(onAttached());
  plugin
    .registerDynamicCustomComponent(
      "change-view-file-list-summary",
      "incremental-summary-view",
    )
    .onAttached(onAttached());
});
