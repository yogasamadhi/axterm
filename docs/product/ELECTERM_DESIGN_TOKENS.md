# Electerm 5.5.0 design-token map

Updated: 2026-09-12  
Baseline: `vendor/electerm@799bedef98c1deae676ae03041719de98d3b57f1`  
Machine-readable destination:
`apps/desktop/src/renderer/src/styles/electerm-parity.tokens.css`

This map records the stable visual primitives observed in the pinned reference.
It does not copy Electerm's component architecture. Axterm components use
semantic `--ax-*` names so themes can change values without changing layout or
state behavior.

## Color roles

| Electerm source token | Reference value | Axterm token                | Meaning                              |
| --------------------- | --------------- | --------------------------- | ------------------------------------ |
| `--main`              | `#141314`       | `--ax-color-canvas`         | Main terminal and panel canvas       |
| `--main-dark`         | `#000000`       | `--ax-color-canvas-deep`    | Activity rail and inactive tab strip |
| `--main-light`        | `#2e3338`       | `--ax-color-surface-raised` | Elevated/control surface             |
| `--main-darker`       | `#0e0d0e`       | `--ax-color-surface-sunken` | Recessed surface                     |
| `--main-lighter`      | `#5b5a5b`       | `--ax-color-surface-muted`  | Muted/divider-adjacent surface       |
| `--text`              | `#dddddd`       | `--ax-color-text`           | Normal foreground                    |
| `--text-light`        | `#ffffff`       | `--ax-color-text-strong`    | Active/hover foreground              |
| `--text-dark`         | `#888888`       | `--ax-color-text-muted`     | Inactive foreground                  |
| `--text-disabled`     | `#777777`       | `--ax-color-text-disabled`  | Disabled foreground                  |
| `--primary`           | `#0088cc`       | `--ax-color-primary`        | Selection and primary action         |
| `--info`              | `#ffd166`       | `--ax-color-info`           | Informational state                  |
| `--success`           | `#06d6a0`       | `--ax-color-success`        | Connected/success state              |
| `--error`             | `#ef476f`       | `--ax-color-danger`         | Error/destructive state              |
| `--warn`              | `#e55934`       | `--ax-color-warning`        | Warning/interactive prompt state     |
| `--primary-contrast`  | `#ffffff`       | `--ax-color-on-primary`     | Foreground on primary                |

Source: `src/client/css/includes/theme.styl`.

## Geometry and density

| Electerm primitive    | Reference value              | Axterm token              | Source                                      |
| --------------------- | ---------------------------- | ------------------------- | ------------------------------------------- |
| Activity layout track | `43px`                       | `--ax-size-activity-rail` | `common/constants.js`                       |
| Activity icon bar     | `36px`                       | component geometry        | `sidebar/sidebar.styl`                      |
| Tab strip height      | `36px`                       | `--ax-size-tab-height`    | `tabs/tabs.styl`                            |
| Footer height         | `36px`                       | `--ax-size-footer-height` | `common/constants.js`, `footer/footer.styl` |
| Tab minimum width     | `100px`                      | `--ax-size-tab-min`       | `tabs/tabs.styl`                            |
| Tab maximum width     | `200px`                      | `--ax-size-tab-max`       | `tabs/tabs.styl`                            |
| Tab close target      | `16px`                       | `--ax-size-tab-close`     | `tabs/tabs.styl`                            |
| Connection/status dot | `5px`                        | `--ax-size-status-dot`    | `tabs/tabs.styl`                            |
| Shortcut bar height   | `44px`                       | `--ax-size-shortcut-bar`  | `terminal/shortcut-bar.styl`                |
| Fast animation        | `200ms`                      | `--ax-motion-fast`        | `theme.styl`                                |
| Dropdown shadow       | `0 2px 8px rgb(0 0 0 / 15%)` | `--ax-shadow-menu`        | `tabs/tabs.styl`                            |

Axterm normalizes recurring Electerm padding and radius values into
`--ax-space-1` (`4px`), `--ax-space-2` (`8px`), `--ax-space-3` (`12px`) and
`--ax-space-4` (`16px`). Compact controls use `--ax-radius-control` (`3px`),
while panels and menus use `--ax-radius-panel` (`4px`). These normalized names
must still be checked against the component-level screenshot before migration.

## Interaction states

The token is only half of the contract. Phase 12 components must preserve these
reference state rules:

- inactive tabs use deep canvas and muted text;
- active tabs use main canvas and normal text;
- tab close controls appear on hover and stay visible on touch devices;
- active rail controls use strong text, while hover promotes muted text;
- connected, failed and connecting indicators use success, danger and primary;
- window close hover uses the danger surface;
- drag targets use a dashed primary/muted insertion marker;
- menus use the main canvas, four-pixel radius and the mapped dropdown shadow.

## Migration rule

Phase 11 only establishes the token source and audit. Each Phase 12–20 UI slice
must replace its relevant hard-coded layout/color values with semantic tokens,
then attach a reference/Axterm screenshot comparison. A token may be adjusted
only with a reviewed golden-image update; component-local overrides must explain
the reference state they implement.
