# Deck New Tab — Phase 5 Addendum: Deck Shelf Density & Presentation

This extends the Phase 4 deliverable (`PHASE-4-DELIVERABLE.md`, unchanged and still accurate for everything it covers). Phase 5 touched **presentation only** — `decks.js` and `browser-state.js` are byte-for-byte the same Open Preferences engine from Phase 4; nothing about Find/Open/incognito/export logic changed.

## What changed

| File | Change |
|---|---|
| `css/newtab.css` | Widened `.page`/`.search`, corrected Deck tab geometry (wide top → narrow bottom, matching the reference), denser shelf spacing, `filter: drop-shadow` active glow, new collapsed-tab styles, shelf-controls styles |
| `js/app.js` | Split Deck rendering into `buildExpandedDeckTabs` / `buildCollapsedDeckTabs`, added `deckUnitsWrap()` wrap-detection, `renderDeckTabs()` mode dispatch, manual shelf-mode toggle wiring, generalized drag/drop to a shared `.deck-unit` concept, `toggleDeckMenu` now takes an `includeFindOpen` option |
| `js/storage.js` | Added `loadShelfMode`/`saveShelfMode` (separate preference key, not Deck data) |
| `newtab.html` | Added the `#shelf-mode-btn` control row beneath the Deck shelf |

## Deck shelf presentation model

- **`auto`** (default): render expanded first, measure whether the Deck row actually wrapped to a second line, and if so, re-render collapsed instead. Re-evaluated on window resize (debounced).
- **`expanded`**: always the two-level tab + reflective tray, even if that means wrapping to multiple rows. User's explicit choice is never silently overridden.
- **`collapsed`**: always the compact Phase-3-style tab + chevron dropdown.

The preference cycles via the **Deck Controls: Auto / Expanded / Collapsed** button beneath the shelf and persists across sessions (its own `chrome.storage.local` key, independent of Deck data — collapsing/expanding never touches or exports with Deck JSON).

Collapsed mode's chevron dropdown carries **Find, Open, Rename, Open Preferences, Delete** — every action available in expanded mode remains reachable; only the presentation changes.

## Visual corrections made against the target reference

1. **Geometry was inverted.** The Phase 4 tab clip-path tapered narrow-at-top/wide-at-bottom — backwards from the reference, which is wide-at-top and narrows toward the waterline. Corrected on `.deck-tab`.
2. **Shelf was too narrow to reach 6–8 Decks per row.** `.page` max-width went from 780px → 1360px (search bar widened to match, other narrower content untouched).
3. **Active-state glow used `box-shadow`,** which only follows an element's rectangular bounding box and produced a boxy halo around the clipped trapezoid instead of hugging its silhouette. Switched to `filter: drop-shadow(...)`, which respects the clip-path's actual alpha shape.
4. **Tray width bug (found via headless-render verification, not visible from CSS alone):** the reflective tray's `width: 72%` resolved too narrow for short Deck names (e.g. "Goon", "Default"), so the Find/Open/Gear buttons' combined content overflowed the tray's own box and got eaten by both `overflow: hidden` and the clip-path taper — visually clipping the leading "F" of "Find" and hiding the gear icon entirely. Fixed by giving both the expanded tab and tray generous, verified-sufficient `min-width` floors (150px / 144px) instead of relying on a percentage of an under-constrained flex parent.
5. **Second bug introduced while fixing #4:** the `width: 100%; min-width: 150px` added to `.deck-tab` for the expanded/tray fix also matched `.deck-tab--collapsed` (same base class), stretching every collapsed tab to the full shelf width and forcing one Deck per row — the opposite of collapsed mode's purpose. Fixed by scoping that rule to `.deck-group .deck-tab` only, leaving the standalone collapsed tab at its natural compact content width.

All of the above were caught and fixed using a real headless-Chromium render (Playwright) of the actual extension files against a mocked `chrome` API and several Deck-count/name-length scenarios — not by inspecting the CSS source alone. See verification results below.

## Verification performed

Rendered `newtab.html` in headless Chromium (1366×900 viewport, matching a typical Chromebook) with a mocked `chrome.storage`/`chrome.tabs`/`chrome.windows`/`chrome.extension`:

| Scenario | Result |
|---|---|
| 4 Decks (names matching the target reference) | One row, expanded, matches target proportions/geometry/glow |
| 8 Decks (mixed short/medium names) | All 8 fit on one row in `auto` mode, stayed expanded — meets the "6–8 across" density goal |
| 10 Decks incl. long names (would wrap if expanded) | `auto` mode correctly detected the wrap and rendered collapsed instead — single row, all 10 visible |
| Collapsed chevron dropdown | Confirmed contains exactly Find / Open / Rename / Open Preferences / Delete |
| Manual toggle: Auto → Expanded → Collapsed → Auto (10 Decks) | Expanded forced 2 rows (8 + 2) as expected since the user's explicit choice isn't auto-corrected; Collapsed forced 1 row; back to Auto re-detected collapse-needed correctly |
| Tray content fit (`getBoundingClientRect` on buttons vs. tray box) | Find/Open/Gear content (~123px) fits inside the tray's content box (144px min-width) with margin, confirmed numerically, not just visually |

No further visual bugs were found after the two fixes above. `decks.js`/`browser-state.js` were not re-tested in this pass since they were not touched — Phase 4's runtime verification (mocked-`chrome` scenario tests) still stands.

## Phase 5.1: Silhouette geometry correction

A follow-up reference comparison caught that the taper direction was still not matching the target closely enough. Corrected `.deck-tab` and `.deck-tab-tray` clip-paths only (CSS geometry, no width/density/behavior change):

- **Upper tab**: narrow at the top edge, progressively widening toward the mirror line (its bottom edge, where it meets the tray) - the mirror line is the widest point of the whole Deck control.
- **Lower tray**: not a mirrored widen-downward shape. It's a second, independent inward taper - starts slightly narrower than the tab's mirror-line width, then narrows further as it descends toward the bottom.

Re-verified via the same headless-render harness: tray content (Find/Open/Gear) still fits with margin inside the tray's box at the new clip-path values, and the 8-Deck single-row density result is unchanged (`allSameRow: true`, `Deck Controls: Auto` stayed expanded). No JS was touched for this correction.

## Phase 5.2: Mirror-line exact-width match + shortcut area regression

Two more corrections, both CSS-only - `js/` is byte-for-byte identical to the Phase 5.1 package (verified with `diff -rq`).

**1. Mirror-line width now matches exactly, not just "closely".** Previously the tab's bottom edge and the tray's top edge were computed from different box widths (tab: 100% of `.deck-group`; tray: 96%) with different inset percentages, so they were close but not pixel-identical, leaving a visible tiny step at the fold. Fixed by giving the tray the same `width: 100%` box as the tab and reusing the exact same `4%`/`96%` inset at the shared edge, so the two edges are now mathematically guaranteed to land at the same pixel width (verified: `tabBoxWidth === trayBoxWidth === 150`, `tabLeft === trayLeft` in a headless-render measurement). Only `width`/`clip-path` changed on `.deck-tab`/`.deck-tab-tray` - `.deck-tab-tray__btn` padding/gap/font-size and every other button rule are untouched, and the rendered button positions were confirmed pixel-identical before and after (`btnsLeft`/`btnsRight` unchanged).

**2. Shortcut grid no longer inherits the widened Deck-shelf container.** Widening `.page` to 1360px for shelf density had an unintended side effect: `main`/`#shortcuts-grid` also had `width: 100%`, so they silently stretched to fill the same 1360px container, moving the shortcut grid's effective width and (less obviously) its horizontal position relative to Phase 3.0/4.0. Fixed by giving `main` its own `max-width: 732px` - the exact content width the shortcut area had under the old 780px `.page` (780 − 2×24px padding). Because `.page` still centers its children, this constrained `<main>` lands back at the same on-screen horizontal position it always had (`left: 317px` at 1366px viewport - confirmed to match the old 780px-page math exactly: `(1366−780)/2 + 24 = 317`), independent of how wide the Deck shelf itself now is.
