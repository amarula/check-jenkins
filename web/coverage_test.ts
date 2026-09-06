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
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./test/test-setup";
import { assert } from "@open-wc/testing";
import {
  CoverageClient,
  coverageUrlId,
  parsePct,
  parseProject,
  getLowCoverageReason,
  formatReferenceBuild,
  javaStringHashCode,
} from "./coverage";
import { CoverageType, Side } from "@gerritcodereview/typescript-api/diff";
import { PluginApi } from "@gerritcodereview/typescript-api/plugin";

suite("parseProject", () => {
  test("parses simple repo from gerrit URL path", () => {
    assert.equal(parseProject("/c/repo-name/+/123"), "repo-name");
  });

  test("parses repo with slashes", () => {
    assert.equal(parseProject("/c/org/repo/+/456"), "org/repo");
  });

  test("parses repo with numeric change number", () => {
    assert.equal(parseProject("/c/myproject/+/789/5"), "myproject");
  });

  test("throws on non-gerrit path", () => {
    assert.throws(() => parseProject("/some/other/path"));
  });

  test("throws on path without + separator", () => {
    assert.throws(() => parseProject("/c/repo-no-plus/123"));
  });

  test("throws on empty path", () => {
    assert.throws(() => parseProject(""));
  });
});

suite("javaStringHashCode", () => {
  test("matches Java String.hashCode for known values", () => {
    assert.equal(javaStringHashCode(""), 0);
    assert.equal(javaStringHashCode("abc"), 96354);
  });

  test("returns a signed 32-bit integer", () => {
    const hash = javaStringHashCode("common/src/commonMain/kotlin/Foo.kt");
    assert.isTrue(Number.isInteger(hash));
    assert.isTrue(hash >= -2147483648 && hash <= 2147483647);
  });
});

suite("parsePct", () => {
  test("parses integer percentage", () => {
    assert.equal(parsePct("88%"), 88);
  });

  test("parses decimal percentage", () => {
    assert.equal(parsePct("88.44%"), 88.44);
  });

  test("parses percentage with plus sign", () => {
    assert.equal(parsePct("+5.0%"), 5.0);
  });

  test("returns undefined for empty string", () => {
    assert.isUndefined(parsePct(""));
  });

  test("returns undefined for undefined input", () => {
    assert.isUndefined(parsePct(undefined));
  });

  test("returns undefined for non-numeric", () => {
    assert.isUndefined(parsePct("abc"));
  });

  test("returns undefined for whitespace only", () => {
    assert.isUndefined(parsePct("  "));
  });
});

suite("getLowCoverageReason", () => {
  test("extracts reason from commit message", () => {
    assert.equal(
      getLowCoverageReason("Low-Coverage-Reason: TRIVIAL_CHANGE"),
      "TRIVIAL_CHANGE",
    );
  });

  test("returns undefined when no reason present", () => {
    assert.isUndefined(getLowCoverageReason("Some commit message"));
  });

  test("returns undefined for undefined input", () => {
    assert.isUndefined(getLowCoverageReason(undefined));
  });

  test("returns undefined for empty string", () => {
    assert.isUndefined(getLowCoverageReason(""));
  });

  test("extracts reason from multiline message", () => {
    assert.equal(
      getLowCoverageReason(
        "Fix bug in coverage\n\nLow-Coverage-Reason: HARD_TO_TEST\n\nMore context",
      ),
      "HARD_TO_TEST",
    );
  });
});

suite("formatReferenceBuild", () => {
  test("converts an HTML anchor into a markdown link", () => {
    assert.equal(
      formatReferenceBuild(
        '<a href="https://jenkins.example.com/job/foo/167/" class="model-link inside">foo » bar #167</a>',
      ),
      "[foo » bar #167](https://jenkins.example.com/job/foo/167/)",
    );
  });

  test("decodes HTML entities in the link text", () => {
    assert.equal(
      formatReferenceBuild(
        '<a href="https://jenkins.example.com/job/foo/167/">foo &amp; bar #167</a>',
      ),
      "[foo & bar #167](https://jenkins.example.com/job/foo/167/)",
    );
  });

  test("strips tags when no anchor is present", () => {
    assert.equal(
      formatReferenceBuild('<span class="foo">bar #167</span>'),
      "bar #167",
    );
  });

  test("returns plain text unchanged for non-HTML input", () => {
    assert.equal(formatReferenceBuild("bar #167"), "bar #167");
  });

  test("returns the URL when the anchor has no link text", () => {
    assert.equal(
      formatReferenceBuild('<a href="https://jenkins.example.com/job/foo/167/"></a>'),
      "https://jenkins.example.com/job/foo/167/",
    );
  });
});

suite("coverageUrlId", () => {
  test("defaults to coverage when coverage_id is unset", () => {
    assert.equal(
      coverageUrlId({ name: "jenkins", url: "http://jenkins", user: "" }),
      "coverage",
    );
  });

  test("returns the configured coverage_id", () => {
    assert.equal(
      coverageUrlId({
        name: "jenkins",
        url: "http://jenkins",
        user: "",
        coverage_id: "jacoco",
      }),
      "jacoco",
    );
  });
});

suite("CoverageClient.computePercentages", () => {
  let client: CoverageClient;

  setup(() => {
    client = new CoverageClient({} as unknown as PluginApi);
  });

  test("returns empty object for null response", () => {
    const result = (client as any).computePercentages(null);
    assert.deepEqual(result, {});
  });

  test("returns empty object for response without files", () => {
    const result = (client as any).computePercentages({});
    assert.deepEqual(result, {});
  });

  test("computes coverage percentage from covered and missed blocks", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          modifiedLinesBlocks: [
            { startLine: 1, endLine: 5, type: "COVERED" },
            { startLine: 6, endLine: 10, type: "MISSED" },
          ],
        },
      ],
    };
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {
      "src/foo.ts": { incremental: 50 },
    });
  });

  test("returns 100% for fully covered file", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/bar.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 10, type: "COVERED" }],
        },
      ],
    };
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {
      "src/bar.ts": { incremental: 100 },
    });
  });

  test("returns 0% for fully missed file", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/baz.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 10, type: "MISSED" }],
        },
      ],
    };
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {
      "src/baz.ts": { incremental: 0 },
    });
  });

  test("skips file with no modifiedLinesBlocks", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/empty.ts",
        },
      ],
    } as any;
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {});
  });

  test("skips file with no fullyQualifiedFileName", () => {
    const resp = {
      files: [
        {
          modifiedLinesBlocks: [{ startLine: 1, endLine: 5, type: "COVERED" }],
        },
      ],
    } as any;
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {});
  });

  test("handles multiple files", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/covered.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 10, type: "COVERED" }],
        },
        {
          fullyQualifiedFileName: "src/missed.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 5, type: "MISSED" }],
        },
      ],
    };
    const result = (client as any).computePercentages(resp);
    assert.deepEqual(result, {
      "src/covered.ts": { incremental: 100 },
      "src/missed.ts": { incremental: 0 },
    });
  });
});

suite("CoverageClient.computeAbsolutePercentages", () => {
  let client: CoverageClient;

  setup(() => {
    client = new CoverageClient({} as unknown as PluginApi);
  });

  test("returns empty object for null response", () => {
    const result = (client as any).computeAbsolutePercentages(null);
    assert.deepEqual(result, {});
  });

  test("returns empty object for response without files", () => {
    const result = (client as any).computeAbsolutePercentages({});
    assert.deepEqual(result, {});
  });

  test("parses line coverage from the metrics map", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          metrics: { line: "88.44%" },
        },
      ],
    };
    const result = (client as any).computeAbsolutePercentages(resp);
    assert.deepEqual(result, {
      "src/foo.ts": { absolute: 88.44 },
    });
  });

  test("skips file without a parseable line metric", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          metrics: { branch: "50%" },
        },
      ],
    };
    const result = (client as any).computeAbsolutePercentages(resp);
    assert.deepEqual(result, {});
  });

  test("skips file with no fullyQualifiedFileName", () => {
    const resp = {
      files: [
        {
          metrics: { line: "90%" },
        },
      ],
    } as any;
    const result = (client as any).computeAbsolutePercentages(resp);
    assert.deepEqual(result, {});
  });

  test("handles multiple files", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/covered.ts",
          metrics: { line: "100.00%" },
        },
        {
          fullyQualifiedFileName: "src/missed.ts",
          metrics: { line: "0.00%" },
        },
      ],
    };
    const result = (client as any).computeAbsolutePercentages(resp);
    assert.deepEqual(result, {
      "src/covered.ts": { absolute: 100 },
      "src/missed.ts": { absolute: 0 },
    });
  });
});

suite("CoverageClient.parseRanges", () => {
  let client: CoverageClient;

  setup(() => {
    client = new CoverageClient({} as unknown as PluginApi);
  });

  test("returns empty object for null response", () => {
    const result = (client as any).parseRanges(null);
    assert.deepEqual(result, {});
  });

  test("returns empty object for response without files", () => {
    const result = (client as any).parseRanges({});
    assert.deepEqual(result, {});
  });

  test("parses COVERED block to CoverageType.COVERED", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 5, type: "COVERED" }],
        },
      ],
    };
    const result = (client as any).parseRanges(resp);
    assert.equal(result["src/foo.ts"].length, 1);
    assert.equal(result["src/foo.ts"][0].type, CoverageType.COVERED);
    assert.equal(result["src/foo.ts"][0].side, Side.RIGHT);
    assert.equal(result["src/foo.ts"][0].code_range.start_line, 1);
    assert.equal(result["src/foo.ts"][0].code_range.end_line, 5);
  });

  test("parses MISSED block to CoverageType.NOT_COVERED", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/bar.ts",
          modifiedLinesBlocks: [{ startLine: 10, endLine: 20, type: "MISSED" }],
        },
      ],
    };
    const result = (client as any).parseRanges(resp);
    assert.equal(result["src/bar.ts"][0].type, CoverageType.NOT_COVERED);
  });

  test("skips block with missing startLine", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          modifiedLinesBlocks: [
            { startLine: null as any, endLine: 5, type: "COVERED" },
          ],
        },
      ],
    };
    const result = (client as any).parseRanges(resp);
    assert.deepEqual(result, {});
  });

  test("skips block with missing type", () => {
    const resp = {
      files: [
        {
          fullyQualifiedFileName: "src/foo.ts",
          modifiedLinesBlocks: [{ startLine: 1, endLine: 5, type: "" }],
        },
      ],
    };
    const result = (client as any).parseRanges(resp);
    assert.deepEqual(result, {});
  });
});
