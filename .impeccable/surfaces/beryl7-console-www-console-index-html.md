---
version: 1
slug: "beryl7-console-www-console-index-html"
primary_target: "beryl7-console/www/console/index.html"
related_targets: []
---

# Surface: /console/ — the Beryl 7 control grid

Scope: one page, Operate mode. The whole console as a grid of glass instrument tiles; every tile is a live reading and the entry to its sheet. Phone first (iPhone), iPad, desktop; light and dark. Replaces the five-page console visually and structurally; the old pages stay in place as the off-ramp until the owner deletes them.

## Direction contract

THESIS: The router is a panel of instruments you operate with a thumb — iOS Control Center, not an admin dashboard. It refuses the category arrangement it replaces: sidebar + page title + stacked cards with section headings + bottom tabs. There are no pages. There is one grid and a sheet.

OWN-WORLD: Liquid glass as the only material — translucent panes (never opaque), backdrop blur, a 1px specular inset edge, depth by stacking two glass layers, no drop shadows anywhere. A calm two-tone ground (maroon warmth at the top fading to a cool neutral) that stays visible through every pane and between tiles. One accent, maroon; a tile's on-state is a maroon-tinted face. System font stack; 12px labels, 17–20px semibold tabular values; a tile reads as an instrument, not a paragraph. Icons are a new 1.75px round-stroke family drawn for this build.

STORY: Open it and the first glance answers "is everything OK" — the Path row (Internet · Uplink · VPN) and a dozen live tiles. Tap a tile to go one level down into its sheet, do the thing, swipe or Escape back to the grid. Toggle tiles (VPN routing, Guest, IoT, Travel, iPerf) switch on the face itself.

FIRST VIEWPORT (390px phone): a centered floating glass capsule — mark, "Beryl 7", live dot. Below, full-width dashed Path frame with three compact nodes and stubs. Then the grid, two square tiles per row: Devices (count + newest names) beside Internet (ping + loss sparkline); Uplink beside VPN (toggle); Throughput spanning two; Radios, Guest (toggle), IoT (toggle), System (three arcs), Activity (last three events), Travel (switch), Speed test. Desktop 1400: same grid at six columns, Path spanning three; the sheet becomes a right-hand pane.

FORM: Control Center grid + sheets — user-pinned direction (2026-09-15, "A"), position 1 of 4 considered (B cockpit strip competitive, C map-first and D feed declined). No concept-seed roll: a user-pinned direction beats the roll. Signature interaction: the sheet rising as the grid recedes and dims — the only authored motion in the build.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Acceptance criteria (owner's, verbatim in spirit)
- tiles small enough that the bands/ground move under them as you scroll
- the sheet is a genuinely heavier second glass layer over a dimmed grid; depth by stacking, not by shadow
- maroon the only accent; a tile's on-state is a maroon-tinted face, never a coloured dot
- system stack, no webfont
- tile labels 12px, values 17–20px semibold
- exactly one authored motion moment: the sheet rising with the grid receding; nothing else moves
- self-checks: stranger test; strip-backdrop-filter test; no box-shadow depth; ground visible through every pane; no element in the old console's position/shape/grouping

## Held back by the owner
Phase 4 deletions (legacy/, theme.css, the five old pages). No SSH/dropbear/firewall/WireGuard-config changes.
