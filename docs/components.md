# Web Components

The coverage percentage columns in Gerrit's file list are implemented as [Lit](https://lit.dev/) web components. They are registered as dynamic custom components via Gerrit's plugin API.

## Class hierarchy

```
LitElement
  └── BaseComponent                    (shown, instances)
        ├── BaseCoverageComponent      (changeNum, patchRange, path, provider, percentageText, kind)
        │     ├── AbsoluteContentView        (line coverage)
        │     ├── IncrementalContentView     (line coverage, new lines)
        │     ├── BranchContentView          (branch coverage)
        │     └── InstructionContentView     (instruction coverage)
        │
        ├── AbsoluteHeaderView          ("Cov(L)" header)
        ├── BranchHeaderView            ("Cov(B)" header)
        ├── InstructionHeaderView       ("Cov(I)" header)
        ├── IncrementalHeaderView       ("ΔCov(L)" header)
        ├── AbsoluteSummaryView         (empty summary cell)
        ├── BranchSummaryView           (empty summary cell)
        ├── InstructionSummaryView      (empty summary cell)
        └── IncrementalSummaryView      (empty summary cell)
```

## BaseComponent

`web/coverage-percentage-views.ts:40`

The root class for all 12 components. Provides:

```typescript
export class BaseComponent extends LitElement {
    static instances = new Set<BaseComponent>();  // live-instance registry
    @property() shown = true;                      // column visibility

    connectedCallback()    → instances.add(this)
    disconnectedCallback() → instances.delete(this)
    render()               → <div class="{shown ? 'coverage-percentage-column' : 'coverage-percentage-column hidden'}"><slot></slot></div>
}
```

### Visibility broadcasting

`plugin.ts` uses the static `instances` set to broadcast column visibility changes:

```typescript
plugin.on(EventType.SHOW_CHANGE, async (change, revision) => {
    const [show] = await Promise.all([
        coverageClient.showPercentageColumns(),
        coverageClient.prefetchCoverageRanges(change, revision),
    ]);
    for (const instance of BaseComponent.instances) {
        instance.shown = show;
    }
});
```

When `show` is `false`, the CSS class `hidden` (display: none) is applied.

## BaseCoverageComponent

`web/coverage-percentage-views.ts:82`

Extends `BaseComponent` with data-binding logic:

```typescript
export class BaseCoverageComponent extends BaseComponent {
    @property() changeNum = '';
    @property() patchRange: PatchRange | null = null;
    @property() path = '';
    @property() provider: CoverageProvider = async () => null;
    @property() percentageText = '-';
    @property() kind = '';
}
```

### Reactive update

`update()` triggers `computePercentage()` whenever `changeNum`, `patchRange`, `path`, or `provider` changes:

```typescript
override update(changedProperties: PropertyValues) {
    if (changedProperties.has('changeNum') || changedProperties.has('patchRange')
        || changedProperties.has('path') || changedProperties.has('provider')) {
        this.computePercentage(this.changeNum, this.patchRange, this.path, this.provider);
    }
    super.update(changedProperties);
}
```

### Data resolution

`computePercentage()` calls the `provider` callback and delegates to the subclass's `getPercentageFromData()`:

```typescript
const p = await provider(changeNum, path, patchRange.patchNum);
if (p && Number.isFinite(this.getPercentageFromData(p))) {
    this.percentageText = this.getPercentageFromData(p)!.toString() + '%';
} else {
    this.percentageText = '-';
}
```

Each subclass overrides `getPercentageFromData()` to extract its metric:

| Component | `kind` | Extracts |
|---|---|---|
| `AbsoluteContentView` | `absolute` | `pd.absolute` (line) |
| `IncrementalContentView` | `incremental` | `pd.incremental` (line, new lines) |
| `BranchContentView` | `absolute_branch` | `pd.absolute_branch` |
| `InstructionContentView` | `absolute_instruction` | `pd.absolute_instruction` |

## Registration in plugin.ts

Components are registered into three file-list table slots:

Columns appear in the order `Cov(L) | Cov(B) | Cov(I) | ΔCov(L)`.

| Slot | Registration ID | Components |
|---|---|---|
| `change-view-file-list-header` | Column headers | `absolute-header-view`, `branch-header-view`, `instruction-header-view`, `incremental-header-view` |
| `change-view-file-list-content` | Per-file data cells | `absolute-content-view`, `branch-content-view`, `instruction-content-view`, `incremental-content-view` |
| `change-view-file-list-summary` | Summary row | `absolute-summary-view`, `branch-summary-view`, `instruction-summary-view`, `incremental-summary-view` |

### Content vs header registration

Content components receive a `provider` callback; header and summary components do not:

```typescript
// Header — no provider
plugin.registerDynamicCustomComponent('change-view-file-list-header', 'absolute-header-view')
    .onAttached(onAttached());  // needsProvider defaults to false

// Content — with provider
plugin.registerDynamicCustomComponent('change-view-file-list-content', 'absolute-content-view')
    .onAttached(onAttached(true));  // needsProvider = true → sets provider
```

### Provider binding

The `provider` is `CoverageClient.provideCoveragePercentages`, which queries the coverage cache and returns `PercentageData | null`. If null or the requested metric is not a finite number, the component renders `-`.

## CSS

All components share common styles:

```css
:host {
    display: inline-block;
    width: 4.5em;
    box-sizing: border-box;
}
.coverage-percentage-column {
    text-align: center;
    width: 100%;
}
.coverage-percentage-column.hidden {
    display: none;
}
```

The fixed `width` (rather than a `min-width`) keeps the header and data cells
the same width so the file list stays aligned, and `text-align: center` centers
the label / circle + percentage within the column.

## Custom element names

Defined via `@customElement()` decorator:

| Decorator | HTML tag |
|---|---|
| `@customElement('absolute-header-view')` | `<absolute-header-view>` |
| `@customElement('branch-header-view')` | `<branch-header-view>` |
| `@customElement('instruction-header-view')` | `<instruction-header-view>` |
| `@customElement('incremental-header-view')` | `<incremental-header-view>` |
| `@customElement('absolute-content-view')` | `<absolute-content-view>` |
| `@customElement('branch-content-view')` | `<branch-content-view>` |
| `@customElement('instruction-content-view')` | `<instruction-content-view>` |
| `@customElement('incremental-content-view')` | `<incremental-content-view>` |
| `@customElement('absolute-summary-view')` | `<absolute-summary-view>` |
| `@customElement('branch-summary-view')` | `<branch-summary-view>` |
| `@customElement('instruction-summary-view')` | `<instruction-summary-view>` |
| `@customElement('incremental-summary-view')` | `<incremental-summary-view>` |
