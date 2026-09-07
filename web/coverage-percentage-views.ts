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

import {css, html, LitElement, PropertyValues} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {PercentageData, coverageEmoji} from './coverage';

const COMMON_CSS = css`
  :host {
    display: inline-block;
    min-width: 3.5em;
    box-sizing: border-box;
  }
  .coverage-percentage-column {
    display: inline-block;
    min-width: 3.5em;
    text-align: center;
    width: 100%;
  }
  .coverage-percentage-column.hidden {
    display: none;
  }
`;

/** Base class for all components */
export class BaseComponent extends LitElement {
  /** Set of live instances so plugin.ts can broadcast visibility changes. */
  static instances = new Set<BaseComponent>();

  /** Default visible – columns occupy layout space from first paint.
   *  Only hidden when config confirms coverage is disabled. */
  @property() shown = true;

  override connectedCallback() {
    super.connectedCallback();
    BaseComponent.instances.add(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    BaseComponent.instances.delete(this);
  }

  override render() {
    return html`<div class="${this.computeCoverageClass()}"><slot></slot></div>`;
  }

  protected computeCoverageClass(): string {
    return this.shown ? 'coverage-percentage-column' : 'coverage-percentage-column hidden';
  }
}

declare interface PatchRange {
  patchNum: string;
}

declare interface CoverageProvider {
  (
    changeNum: string,
    path: string,
    patchNum: string
  ): Promise<PercentageData | null>;
}

/**
 * Base Coverage Class used for all elements that have data values.
 */
export class BaseCoverageComponent extends BaseComponent {
  @property() changeNum = '';

  @property() patchRange: PatchRange | null = null;

  @property() path = '';

  @property() provider: CoverageProvider = async (
    _changeNum: string,
    _path: string,
    _patchNum: string
  ) => null;

  @property() percentageText = '-';

  @property() percentageValue: number | undefined = undefined;

  @property() kind = '';

  override update(changedProperties: PropertyValues) {
    if (
      changedProperties.has('changeNum') ||
      changedProperties.has('patchRange') ||
      changedProperties.has('path') ||
      changedProperties.has('provider')
    ) {
      this.computePercentage(
        this.changeNum,
        this.patchRange,
        this.path,
        this.provider
      );
    }
    super.update(changedProperties);
  }

  protected getPercentageFromData(_pd: PercentageData): number | undefined {
    return undefined;
  }

  protected async computePercentage(
    changeNum: string,
    patchRange: PatchRange | null,
    path: string,
    provider: CoverageProvider
  ) {
    if (!changeNum || !patchRange || !path) {
      this.percentageText = '-';
      this.percentageValue = undefined;
      return;
    }

    if (provider) {
      const p = await provider(changeNum, path, patchRange.patchNum);
      if (p && Number.isFinite(this.getPercentageFromData(p))) {
        const raw = this.getPercentageFromData(p)!;
        this.percentageValue = raw;
        this.percentageText = raw.toString() + '%';
      } else {
        this.percentageText = '-';
        this.percentageValue = undefined;
      }
    }
  }
}

/**
 * Component for absolute coverage header.
 */
@customElement('absolute-header-view')
export class AbsoluteHeaderView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`
      <div
        class="${this.computeCoverageClass()}"
        title="Line coverage of the whole file"
      >
        Cov(L)
      </div>
    `;
  }
}

/**
 * Component for incremental coverage header.
 */
@customElement('incremental-header-view')
export class IncrementalHeaderView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`
      <div
        class="${this.computeCoverageClass()}"
        title="Line coverage of new lines in the file"
      >
        ΔCov(L)
      </div>
    `;
  }
}

/**
 * Component for absolute coverage data.
 */
@customElement('absolute-content-view')
export class AbsoluteContentView extends BaseCoverageComponent {
  static override styles = COMMON_CSS;

  constructor() {
    super();
    this.kind = 'absolute';
  }

  override getPercentageFromData(pd: PercentageData): number | undefined {
    return pd.absolute;
  }

  override render() {
    return html`
      <div class="${this.computeCoverageClass()}">${coverageEmoji(this.percentageValue)}${this.percentageValue !== undefined ? ' ' : ''}${this.percentageText}</div>
    `;
  }
}

/**
 * Component for incremental coverage data.
 */
@customElement('incremental-content-view')
export class IncrementalContentView extends BaseCoverageComponent {
  static override styles = COMMON_CSS;

  constructor() {
    super();
    this.kind = 'incremental';
  }

  override getPercentageFromData(pd: PercentageData): number | undefined {
    return pd.incremental;
  }

  override render() {
    return html`
      <div class="${this.computeCoverageClass()}">${coverageEmoji(this.percentageValue)}${this.percentageValue !== undefined ? ' ' : ''}${this.percentageText}</div>
    `;
  }
}

/**
 * Component for absolute summary.
 */
@customElement('absolute-summary-view')
export class AbsoluteSummaryView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`<div class="${this.computeCoverageClass()}"></div> `;
  }
}

/**
 * Component for incremental summary.
 */
@customElement('incremental-summary-view')
export class IncrementalSummaryView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`<div class="${this.computeCoverageClass()}"></div> `;
  }
}

/**
 * Component for branch coverage header.
 */
@customElement('branch-header-view')
export class BranchHeaderView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`
      <div
        class="${this.computeCoverageClass()}"
        title="Branch coverage of the whole file"
      >
        Cov(B)
      </div>
    `;
  }
}

/**
 * Component for instruction coverage header.
 */
@customElement('instruction-header-view')
export class InstructionHeaderView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html`
      <div
        class="${this.computeCoverageClass()}"
        title="Instruction coverage of the whole file"
      >
        Cov(I)
      </div>
    `;
  }
}

/**
 * Component for branch coverage data.
 */
@customElement('branch-content-view')
export class BranchContentView extends BaseCoverageComponent {
  static override styles = COMMON_CSS;

  constructor() {
    super();
    this.kind = 'absolute_branch';
  }

  override getPercentageFromData(pd: PercentageData) {
    return pd.absolute_branch;
  }

  override render() {
    return html`
      <div class="${this.computeCoverageClass()}">${coverageEmoji(this.percentageValue)}${this.percentageValue !== undefined ? ' ' : ''}${this.percentageText}</div>
    `;
  }
}

/**
 * Component for instruction coverage data.
 */
@customElement('instruction-content-view')
export class InstructionContentView extends BaseCoverageComponent {
  static override styles = COMMON_CSS;

  constructor() {
    super();
    this.kind = 'absolute_instruction';
  }

  override getPercentageFromData(pd: PercentageData) {
    return pd.absolute_instruction;
  }

  override render() {
    return html`
      <div class="${this.computeCoverageClass()}">${coverageEmoji(this.percentageValue)}${this.percentageValue !== undefined ? ' ' : ''}${this.percentageText}</div>
    `;
  }
}

/**
 * Component for branch coverage summary.
 */
@customElement('branch-summary-view')
export class BranchSummaryView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html` <div class="${this.computeCoverageClass()}"></div> `;
  }
}

/**
 * Component for instruction coverage summary.
 */
@customElement('instruction-summary-view')
export class InstructionSummaryView extends BaseComponent {
  static override styles = COMMON_CSS;

  override render() {
    return html` <div class="${this.computeCoverageClass()}"></div> `;
  }
}
