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
import "./test/test-setup";
import "./coverage-percentage-views";
import { assert, fixture, html } from "@open-wc/testing";
import {
  BaseComponent,
  AbsoluteHeaderView,
  IncrementalHeaderView,
  AbsoluteContentView,
  IncrementalContentView,
} from "./coverage-percentage-views";
import { query } from "./test/test-util";

suite("BaseComponent.instances tracking", () => {
  test("instances set is initially empty", () => {
    assert.equal(BaseComponent.instances.size, 0);
  });

  test("registers instance on connectedCallback", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view></absolute-header-view>`,
    );
    assert.isTrue(BaseComponent.instances.has(el));
    BaseComponent.instances.delete(el);
  });

  test("unregisters instance on disconnectedCallback", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view></absolute-header-view>`,
    );
    assert.isTrue(BaseComponent.instances.has(el));
    el.remove();
    assert.isFalse(BaseComponent.instances.has(el));
  });

  test("shown defaults to true", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view></absolute-header-view>`,
    );
    assert.isTrue(el.shown);
    BaseComponent.instances.delete(el);
  });
});

suite("AbsoluteHeaderView", () => {
  test("renders Cov(L) text", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view></absolute-header-view>`,
    );
    const div = query(el, ".coverage-percentage-column");
    assert.isDefined(div);
    assert.include(div!.textContent!, "Cov(L)");
    BaseComponent.instances.delete(el);
  });

  test("adds hidden class when shown is false", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view .shown=${false}></absolute-header-view>`,
    );
    const div = query(el, ".coverage-percentage-column.hidden");
    assert.isDefined(div);
    BaseComponent.instances.delete(el);
  });

  test("renders with correct title attribute", async () => {
    const el = await fixture<AbsoluteHeaderView>(
      html`<absolute-header-view></absolute-header-view>`,
    );
    const div = query(el, ".coverage-percentage-column");
    assert.equal(
      div!.getAttribute("title"),
      "Line coverage of the whole file",
    );
    BaseComponent.instances.delete(el);
  });
});

suite("IncrementalHeaderView", () => {
  test("renders ΔCov(L) text", async () => {
    const el = await fixture<IncrementalHeaderView>(
      html`<incremental-header-view></incremental-header-view>`,
    );
    const div = query(el, ".coverage-percentage-column");
    assert.isDefined(div);
    assert.include(div!.textContent!, "ΔCov(L)");
    BaseComponent.instances.delete(el);
  });

  test("renders with correct title attribute", async () => {
    const el = await fixture<IncrementalHeaderView>(
      html`<incremental-header-view></incremental-header-view>`,
    );
    const div = query(el, ".coverage-percentage-column");
    assert.equal(
      div!.getAttribute("title"),
      "Line coverage of new lines in the file",
    );
    BaseComponent.instances.delete(el);
  });
});

suite("AbsoluteContentView", () => {
  test("renders percentage text", async () => {
    const el = await fixture<AbsoluteContentView>(
      html`<absolute-content-view></absolute-content-view>`,
    );
    assert.equal(el.percentageText, "-");
    assert.equal(el.kind, "absolute");
    BaseComponent.instances.delete(el);
  });

  test("renders default dash when no percentage", async () => {
    const el = await fixture<AbsoluteContentView>(
      html`<absolute-content-view></absolute-content-view>`,
    );
    const div = query(el, ".coverage-percentage-column");
    assert.equal(div!.textContent, "-");
    BaseComponent.instances.delete(el);
  });

  test("extracts absolute value from PercentageData", () => {
    const el = new AbsoluteContentView();
    assert.equal(el.getPercentageFromData({ absolute: 85 }), 85);
  });
});

suite("IncrementalContentView", () => {
  test("renders default dash", async () => {
    const el = await fixture<IncrementalContentView>(
      html`<incremental-content-view></incremental-content-view>`,
    );
    assert.equal(el.kind, "incremental");
    BaseComponent.instances.delete(el);
  });

  test("extracts incremental value from PercentageData", () => {
    const el = new IncrementalContentView();
    assert.equal(el.getPercentageFromData({ incremental: 70 }), 70);
  });
});
