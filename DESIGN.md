# Design system — Beryl 7 control grid

Recorded 2026-09-15 from the shipped build: `www/console/console.css`, `www/console/index.html`, `www/console/core.js`, `www/console/tiles.js`. Every token and class named here exists in those files; where the direction contract (`.impeccable/surfaces/beryl7-console-www-console-index-html.md`) and the build differ, the build is what is recorded and the divergence is noted. Scope is `/console/` only; the previous console (`app.css`, `theme.css`, the five pages, `legacy/`) is a separate, superseded system and is not described here.

## 1. Thesis

The router is a panel of glass instruments operated with a thumb. There is one grid and one sheet; there are no pages, no sidebar, no section headings, no tabs. Every tile is a live reading and the way into its depth. A tile reads as an instrument, not a paragraph.

## 2. Material: liquid glass, the only material

One recipe, written once as `.glass` and repeated verbatim on `.tile`, `.sheet`, `.pop`, `.stale`, `.ask`:

| part | token | light | dark |
|---|---|---|---|
| fill (tile grade) | `--pane` | `rgba(255,255,255,.28)` | `rgba(255,255,255,.07)` |
| fill (sheet grade) | `--pane-2` | `rgba(255,255,255,.66)` | `rgba(24,20,28,.78)` |
| boundary | `--edge` | `rgba(23,22,28,.12)` | `rgba(255,255,255,.13)` |
| specular | `--spec` | `rgba(255,255,255,.92)` | `rgba(255,255,255,.22)` |
| blur (tile grade) | `--glass` | `blur(18px) saturate(160%)` | same |
| blur (sheet grade) | `--glass-2` | `blur(36px) saturate(170%)` | same |

Rules the build keeps:

- A pane is translucent or it is not a pane. Fills sit between .07 and .30 alpha at tile grade; the sheet is heavier (.66 / .78) because it is the layer on top.
- The boundary of every pane is `1px solid var(--edge)` plus `box-shadow: inset 0 1px 0 var(--spec)` — the specular inset edge. That is the whole boundary.
- **No drop shadow.** The only non-inset `box-shadow` in the file is the 3px focus ring on `.in/.sel/.ta:focus` (`color-mix(var(--accent) 22%)`), which is a ring, not depth.
- **Depth is stacking.** Two glass layers: the sheet (`--pane-2`, `--glass-2`) over the receded grid (`.stage.is-back`: `scale(.965)`, `opacity .78`) under a veil (`--dim`).
- Recessed surfaces inside glass (switch track, inputs, pick rail, bar track, wait bones) use `--well` (`rgba(23,22,28,.06)` / `rgba(0,0,0,.28)`), never a second opaque colour.
- Hairlines inside a pane use `--line` (`rgba(23,22,28,.10)` / `rgba(255,255,255,.10)`).
- The one opaque surface is `.qr` (`#fff`), because a QR must be scannable.

### The ground

`body` is `--ground` (`#e6e8ed` light, `#100f14` dark). `body::before` is a fixed, static field of three gradients that the grid scrolls over, so any tile shows a different colour through it at different scroll positions:

```
radial-gradient(70% 45% at 82% -6%, var(--g-glow), transparent 70%),
linear-gradient(180deg, var(--g-warm) 0%, transparent 46%),
linear-gradient(206deg, transparent 40%, var(--g-cool) 100%)
```

Light: `--g-warm rgba(139,38,53,.20)`, `--g-glow rgba(255,255,255,.55)`, `--g-cool rgba(72,86,124,.18)`. Dark: `--g-warm rgba(217,115,126,.22)`, `--g-glow rgba(139,38,53,.38)`, `--g-cool rgba(70,80,124,.26)`. Warm at the top, cool at the foot. Static.

`theme-color` in `index.html` mirrors `--ground` per scheme.

## 3. Colour

### Accent: maroon, alone

| token | light | dark |
|---|---|---|
| `--accent` | `#8b2635` | `#d9737e` |
| `--accent-ink` | `#ffffff` | `#1a0b0f` |
| `--pane-on` | `color-mix(in srgb, var(--accent) 30%, rgba(255,255,255,.22))` | `color-mix(in srgb, var(--accent) 34%, rgba(255,255,255,.05))` |
| `--edge-on` | `color-mix(in srgb, var(--accent) 55%, transparent)` | `color-mix(in srgb, var(--accent) 60%, transparent)` |

Where the accent appears: `.tile.is-on` / `.cell.is-on` face (`--pane-on`, `--edge-on`); `.switch[aria-checked=true]` track; `.act--primary` fill; `.mark--solid` fill; `.mark[data-tone=accent]` word and edge; the sheet header icon (`.sheet__hd svg.ico`); `.cap__mark`; `.spark .l2/.a2/.e` (second series and end dot); `caret-color`, `::selection`, `:focus-visible` outline, `accent-color` on checkboxes.

**The on-state is the face.** `renderTile` toggles `is-on` on the whole `.tile` from the tile's returned `state.on`; `is-off` dims value and sub to `--ink-3`. There is no dot, badge or indicator for "on". (The `.cap__dot` in the capsule is a link-health dot — `--ok`, `--warn` when `data-link="stale"|"down"` — not an on-state.)

### Semantic: status, not accent

| token | light | dark | meaning in copy |
|---|---|---|---|
| `--ok` | `#1b6a44` | `#6fd39b` | Up, Carrying, Connected |
| `--warn` | `#855609` | `#eabb5f` | Standby, stale, no reply |
| `--bad` | `#ad2330` | `#f28b8b` | Down, None, Blocked |

Semantic colour is applied only through `data-tone="ok|warn|bad"` and always lands on a word, an edge or a stroke — `.tile__value`, `.tile__sub`, `.readout__v`, `.line__e`, `.mark` (word + edge), `.say` (edge + icon), `.node__ico` (icon + edge), `.arc .f`, `.bar i`, `.fan`, `.pop svg`. Never a filled surface. `.act--danger` is the one red control: red word and edge on a clear fill.

### Ink

| token | light | dark |
|---|---|---|
| `--ink` | `#17161c` | `#f3f0f2` |
| `--ink-2` | `rgba(23,22,28,.74)` | `rgba(243,240,242,.76)` |
| `--ink-3` | `rgba(23,22,28,.62)` | `rgba(243,240,242,.62)` |

`--ink` for values and titles, `--ink-2` for labels and supporting text, `--ink-3` for hints, timestamps and the off state.

### Theming

Three blocks author the same dark palette: `:root[data-theme="dark"]`, `@media (prefers-color-scheme:dark) :root:not([data-theme="light"])`, and `:root[data-theme="light"]` sets `color-scheme:light`. The inline script in `index.html` resolves `localStorage b7.theme` → `?theme=` → `prefers-color-scheme` and sets `data-theme` before the stylesheet loads. Any new token must be added to all three blocks.

## 4. Type

```
--font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif
--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace
```

No webfont. The ramp is seven sizes, all tokens:

| token | px | weight | used by |
|---|---|---|---|
| `--fs-label` | 12 | 500 | `.tile__hd`, `.readout__k`, `.cell__k`, `.node__k`, `.field__l`, `.field__h`, `.cap__state`, `.sheet__m`, `.act--sm` |
| `--fs-sub` | 12.5 | 400/600 | `.tile__sub`, `.line`, `.kv`, `.say`, `.act`, `.pick>button`, `.pop`, units inside values |
| `--fs-node` | 13 | 600 | `.node__v` |
| `--fs-body` | 15 | 400/600 | `body`, `.cell__t`, inputs, `.empty b` |
| `--fs-value` | 17 | 600 | `.tile__value` |
| `--fs-readout` | 20 | 600 | `.readout__v` |
| `--fs-title` | 20 | 600 | `.sheet__t`, `.ask__t` |
| `--fs-value-lg` | 20 | 600 | `.tile__value--lg` |

Off-token sizes that exist in the build: `.mark` 11.5px, `.arc__k` 11px, `.cap` 13px, `.ta` 13px mono, `.wait` bones. Inputs jump to 16px under `@supports (-webkit-touch-callout:none)` so iOS never zooms.

Values are `font-variant-numeric: tabular-nums`, `letter-spacing: -.02em`, `line-height 1.15`. Labels keep `letter-spacing: 0`. Body is `-.005em`, `line-height 1.45`. The `.num` utility applies tabular figures anywhere else.

Tile values sit inside the contract's 17–20px range: 17px for word values (`Ethernet`, `Direct`, `2 of 2`), 20px for the numeric hero values (`G.face.value(..., lg)`: device count, ping, throughput, speed). Sheet readouts use their own 20px token. Path nodes are 13px.

## 5. Shape and rhythm

| token | value | used by |
|---|---|---|
| `--r-tile` | 22px | `.tile` |
| `--r-sheet` | 28px | `.sheet` (top corners; all four on desktop), `.ask` |
| `--r-cell` | 16px | `.readout`, `.cell`, `.say`, `.node`, `.pop`, `.qr` |
| `--r-ctl` | 14px | `.in`, `.sel`, `.ta` |
| `--r-pill` | 999px | `.cap`, `.switch`, `.pick`, `.mark`, `.act`, `.stale`, inline inputs |
| `--gap` | 12px | grid gap on phone (14 at ≥700, 16 at ≥1100) |
| `--pad` | 16px | grid side padding on phone (24 at ≥1100) |

Tiles are square (`aspect-ratio 1/1`, `max-height 200px`, padding `14px 14px 13px`). `.tile--wide` spans 2 columns at `2/1`. `.tile--path` spans the full row on phone (`1 / -1`), 4 of 4 at ≥700, 3 of 6 at ≥1100, with `border-style: dashed`.

Grid: `repeat(2, minmax(0,1fr))` → 4 columns at 700px → 6 at 1100px; `max-width 1180px`, centred. Inside a sheet, blocks separate by 14px bottom margin (`.readouts`, `.cells`, `.lines`, `.kv`, `.say`, `.field`, `.pick`).

Hit areas: 44px on the 30px `.switch` via `::before{inset:-7px}`; `.act::before{inset:-4px 0}`; `.pick>button::before{inset:-6px 0}`; `.sheet__x::before{inset:-5px}`.

## 6. Motion: exactly one

The sheet rises while the grid recedes. Tokens `--dur: 420ms`, `--ease: cubic-bezier(.2,.8,.2,1)`. Only these elements carry a `transition`, and only inside `@media (prefers-reduced-motion: no-preference)`:

- `.stage` — `transform`, `opacity` (`.is-back` = `scale(.965)` + `opacity .78`; at ≥1100 `translateX(-1.5%) scale(.985)`)
- `.sheet` — `transform` from `translateY(102%)` (phone) or `translateX(104%)` (≥1100, right-hand pane), plus a `visibility` hand-off
- `.veil` — `opacity` to `--dim` (`rgba(20,16,24,.30)` / `rgba(0,0,0,.44)`)

`core.js` adds `is-open` to `#sheet` and `#veil` and `is-back` to `#stage` two frames after unhiding, so the transform runs from its hidden position. Closing reverses; `Escape`, the close button, and the history entry the sheet pushed all route to `sheet.close`.

There are zero `@keyframes` and zero `animation` declarations. Switches jump (`.switch::after` moves `left:2px` → `right:2px` with no transition). Toasts (`.pop`) appear in place. The busy spinner (`.act.is-busy::after`) is a static ring. Sparklines redraw; bars set `scaleX` with no transition. Adding a transition anywhere else breaks the rule.

## 7. Components

Every component is a constructor on `G.ui` in `core.js` and a class family in `console.css`; tiles compose them and never write HTML from payload strings (`textContent` only).

**Frame**
- `.stage` — capsule + grid; the thing that recedes. `aria-hidden` while a sheet is open.
- `.cap` (`.glass`) — the only fixed chrome: sticky pill, mark (`--accent`) · "Beryl 7" · `.cap__dot` · `.cap__state` word. `data-link="live|stale|down"`.
- `.grid` — `<main aria-label="Router controls">`, built by `buildGrid()` from the `G.tile` registry sorted by `order`.

**Tile** (`.tile`, `data-tile=id`, `role=button` when it has a sheet; Enter/Space open it)
- `G.face.hd(frag, icon, label, right)` → `.tile__hd` 12px/500 `--ink-2`, 16px icon, optional `.push` on the right.
- `G.face.value(frag, v, unit, tone, lg)` → `.tile__value.num` (+`--lg`), unit in `<small>` at `--fs-sub`.
- `G.face.sub(frag, s, tone)` → `.tile__sub`, two-line clamp.
- `G.face.foot(frag, left, right)` → `.tile__foot`, one-line clamp on the left.
- Modifiers: `.tile--wide`, `.tile--path`, `.tile--ctl` (adds `.tile__ctl` holding a `.switch` top-right; header padded 60px). States: `.is-on`, `.is-off`, `data-tone`. Placeholder value while data is absent is `—`.
- A tile's render returns `{ on, tone }`; `renderTile` applies them. A toggle tile holds its old switch state, disabled, until the router answers.

**Path** (`.tile--path` → `.nodes` → three `.node`s)
- `.node__ico` 34px glass disc, `.node__k` label, `.node__v` 13px/600 value. `data-tone="ok|bad|off"`; `off` = dashed disc, hairline connector becomes dashed (`repeating-linear-gradient`).

**Sheet** (`#sheet`, `role=dialog`, `aria-modal`)
- `.sheet__grab` (phone only) · `.sheet__hd` [`svg.ico` 22px in `--accent`, `.sheet__t`, `.sheet__m`, `.sheet__x`] · `.sheet__bd` (scrolls, `overscroll-behavior: contain`) · `.sheet__ft` (`border-top: --line`, actions right, `.push` left).
- Opened via `G.sheet.open(id)`; a tile's `def.sheet(body, api)` fills it. `api.meta`, `api.foot`, `api.on(src, fn)`, `api.refresh`, `api.close`.
- ≥1100px: right-hand pane, `width min(540px, 100% - 36px)`, inset 18px, all corners `--r-sheet`.

**Inside a sheet**
- `ui.pick(options, value, onChange, fill)` → `.pick` rail in `--well`; pressed segment is `--pane-2` + specular.
- `ui.readout(k, v, s, tone, unit)` / `ui.readouts` → `.readout` label-over-number, tile-grade glass, `auto-fit minmax(120px,1fr)`.
- `ui.cell({k, t, s, right, on, dim, onClick})` / `ui.cells` → `.cell` compact card, `auto-fill minmax(156px,1fr)`, `min-height 96px`; `.is-on` takes the maroon face, `.is-dim` = `opacity .62`.
- `ui.line(t, body, e, tone)` / `ui.lines` → `.line` time · body · end, hairline-separated. `ui.kv(pairs)` → `.kv` definition grid, values right-aligned tabular.
- `ui.mark(text, tone, solid)` → `.mark` 11.5px glass pill; colour on word and edge; `--solid` is maroon.
- `ui.say(text, tone, icon)` → `.say` callout; colour on edge and icon, never fill.
- Forms: `ui.field(label, ctl, hint)` → `.field` / `.field__l` / `.field__h`; `ui.input` `.in`, `ui.select` `.sel` (custom chevron `--chev`), `ui.textarea` `.ta` (mono, 120px), `ui.check` `.check`; `.row2`, `.inline`; `--inline` variants are pills.
- `ui.act(label, kind, onClick, icon)` → `.act` glass pill, 36px; kinds `primary` (maroon fill), `quiet` (no chrome), `danger` (red word + edge), `sm` (30px). `.is-busy` hides the label under a static ring.
- `ui.switchEl(checked, onChange, label)` → `.switch` 50×30, `role=switch`, `aria-checked`.
- `ui.confirm({...})` → `.ask` sheet-grade glass, centred, no motion, over its own `.veil`.
- `G.pop(text, tone, ms)` → `.pop` in `#pops`, sheet-grade glass, bottom centre, `role=status`.
- `ui.empty(icon, title, text)`, `ui.wait(n)` (bones in `--well`), `ui.qr(text)`, `.stale` (sheet-grade pill with a `--warn` edge, under the capsule).

**Instruments**
- `ui.spark(values, o)` → `.spark`; `.l` ink line, `.l2` accent line, `.a/.a2` fills at .06/.14, `.z` zero line, `.e` accent end dot. 1.5px, `vector-effect: non-scaling-stroke`. Inside a tile it takes the remaining height (`min-height 36px`).
- `ui.arc(frac, label, value, tone)` → `.arc` 240° ring, 5px stroke, track `--well`, fill `--ink` (or `--warn/--bad`). Three in `.arcs`.
- `ui.fan(dbm)` / `ui.fanSet` → `.fan` Wi-Fi mark lit from the dot outward, `data-tone` from `quality(dbm)`.
- `ui.bar(frac, tone)` → `.bar` 5px track; the fill is `transform: scaleX`, never re-laid.

**Icons** — one family in `ICONS` (`core.js`): 24-unit grid, `stroke-width 1.75`, round caps and joins, `fill: none`, `currentColor`. Names as shipped: globe link shield devices wifi pulse gauge clock plane speed users plug router key lock x check alert info refresh chevron plus trash qr bolt sun moon search eye copy usb ethernet log download power home layers. Action buttons and pops render icons at 1.9; the close glyph at 2. No glyph fonts, no emoji, no raster icons.

## 8. Voice

- Labels are nouns in Sentence case and fixed by PRODUCT.md: Path · Devices · Internet · Uplink · VPN · Radios · Guest Wi-Fi · IoT · Throughput · System · Activity · Travel · Speed test.
- State words are live readings, one word where possible, Sentence case, and always carry their `data-tone`: Up / Down / Standby / Carrying / Off / On / None / Blocked / Wired / Direct / Quiet / Home / Away / No route / No data. The placeholder before first data is `—`.
- A control names its action: Turn on, Turn off, Connect, Disconnect, Forget, Join, Rename, Remove, Apply, Save, Run, Scan USB.
- A pop names the result or the problem and the recovery, ending in a full stop: "Saved.", "Forgotten.", "Added — press Connect on it.", "Scan failed: the radio was busy — try again.", "This network needs a password."
- Confirmations (`.ask`) are questions or imperatives with the object named: "Forget the password for …", "Delete the modem profile?".
- No marketing register, no exclamation marks, no descriptive prose standing in for a measurement.

## 9. Accessibility floors the build meets

`:focus-visible` 2px `--accent` outline at 2px offset on everything; `touch-action: manipulation` on all controls; `.vh` for visually-hidden labels; `aria-live="polite"` on the capsule and pops; the sheet is `role=dialog aria-modal` and focuses its close button on open, restoring focus to the opener on close; `[hidden]` is `display:none !important`; safe-area insets on the capsule, stage foot, sheet body/footer and pops; `min-height: 100svh`.

## 10. Divergences from the direction contract (build wins)

- Contract lists VPN and iPerf as toggle tiles; the build ships toggles on Guest, IoT (`tiles.js:789`, per-network loop) and Travel (`:1095`) only. VPN is a reading tile whose sheet holds the routing controls; iPerf lives in a sheet.

## Not canonized

Inline `style.cssText` in `tiles.js` (lines 138, 216, 435, 522: margins, flex alignment, a mono log block) and the off-token sizes in §4 (11px, 11.5px, 13px) are carried as build details, not as system rules; a future surface should reach for a class or a token instead. The `Speed` label is recorded as shipped; PRODUCT.md's terminology list does not yet include it.
