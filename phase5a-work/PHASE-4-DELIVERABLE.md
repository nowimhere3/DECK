# Deck New Tab — Phase 4.0 Deliverable

## 1. Full file tree

```text
deck-newtab/
├── manifest.json
├── newtab.html
├── popup.html
├── css/
│   ├── newtab.css
│   └── popup.css
├── js/
│   ├── storage.js
│   ├── decks.js
│   ├── browser-state.js
│   ├── tab-capture.js
│   ├── app.js
│   └── popup.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

No files added or removed — Phase 4 extends the existing eight source files only.

## 2. Exact files changed

| File | Change |
|---|---|
| `manifest.json` | Added explicit `"incognito": "spanning"` |
| `js/decks.js` | Added `openPreferences` schema, `normalizeOpenPreferences`, `updateDeckOpenPreferences`, wired into create/load/import/export |
| `js/browser-state.js` | Added `incognito` window tagging, scoped `findDeckMatches`, `isIncognitoAccessAllowed`, `getCurrentRegularWindow`, `openDeckWithPreferences` |
| `js/tab-capture.js` | Added `getExportUrls(scope)` |
| `js/app.js` | Redesigned Deck tab rendering (two-level group), new gear menu, Open Preferences modal, `performOpenDeck` |
| `js/popup.js` | Added Export Tabs to `.txt` wiring |
| `css/newtab.css` | New `.deck-group` / `.deck-tab-tray` / `.open-prefs` styles, replaced old `.deck-tab__menu-btn` styling |
| `css/popup.css` | Added `.popup__export-modes` |
| `popup.html` | Added Export Tabs to `.txt` section |

`newtab.html` and the icon assets are unchanged.

## 3. Architecture summary

The Phase 3 responsibility boundaries are preserved exactly:

```text
New Tab UI (app.js)
     │
     ├──── DeckStore (decks.js) ───── chrome.storage.local
     │
BrowserState (browser-state.js)
     │
     └──── chrome.tabs / chrome.windows / chrome.extension

Popup (popup.js)
     │
     ├──── DeckStore
     └──── Tab Capture / Export (tab-capture.js)

Deck Open Preferences
     │
     └──── stored as a field on the Deck record inside DeckStore
```

Nothing new was introduced outside these boundaries:

- **No second Deck database, no second `activeDeckId`.** `openPreferences` is just another field on the existing Deck record in `decks.js`.
- **No duplicated URL normalization.** `browser-state.js` still calls `DeckStore.normalizeUrl` exclusively.
- **No duplicated Find logic.** `findDeckMatches(deck, scope)` is the *only* matching implementation. The classic Find Deck button calls it with no `scope` (unchanged Phase 3 behavior, incognito-inclusive wherever Chrome already exposes it). The new Open engine calls it *with* a `scope` (`'regular'` or `'incognito'`) so a Deck's destination never accidentally matches the wrong kind of window. Same function, same tie-breaking rules, same result shape.
- **No duplicated Open logic per button.** Every visible "Open" control (the tray's Open button) goes through the single `BrowserState.openDeckWithPreferences(deck)`. `openAllInNewWindow` (Phase 3's always-fresh helper, used by the Find modal's explicit "Open All Fresh") and `openMissingInWindow`/`focusWindow` are unchanged and are reused internally by the new engine rather than reimplemented.
- **No persistent browser session/window tracking.** Every scan in `browser-state.js` is still an on-demand `chrome.windows.getAll()`/`chrome.tabs.query()` call triggered by a user action; nothing writes window/tab IDs to storage.

## 4. Deck UI before/after

**Before (Phase 3):** a single-row trapezoid tab per Deck, with a small chevron button inside it that opened a dropdown menu (Rename / Find Deck / Open All / Delete).

**After (Phase 4):** each real Deck is a two-level "Deck group":

```text
      Deck Name          <- upper tab (trapezoid, unchanged shape/click/drag)
 ─────────────────
  Find   Open   Gear     <- new lower "reflective" action tray
```

- The upper tab lost the chevron entirely; it now only shows the centered Deck name, still switches the active Deck on click, and is still the sole drag handle for Deck reordering.
- The lower tray is a separate sibling element (~70% width, centered, inverse-trapezoid clip-path) that visually reads as a mirrored continuation of the tab above it. It holds exactly three controls: **Find** (label read), **Open** (label read), and a icon-only **Gear**.
- Because the tray is a sibling of the upper tab rather than nested inside it, none of its buttons are clipped by the upper tab's `clip-path`, and clicks on them never bubble into the tab's Deck-switch handler (each tray button also calls `stopPropagation` defensively).
- Both pieces are wrapped in one `.deck-group` container so they always move together during drag reorder; drag-over/drop detection was retargeted from `.deck-tab` to `.deck-group`.
- The active Deck's purple state now extends into the tray via a softer gradient/border rather than a hard color swap.
- Gear now opens **Rename / Open Preferences / Delete** — Find and Open All moved out of the menu and onto the tray, so the menu shrank rather than grew.
- `+ Add Deck` is untouched — a single plain button, no tray, no drag.

## 5. Open Preferences schema

Added to every Deck record:

```json
{
  "openPreferences": {
    "destination": "new-window",
    "existingPolicy": "all"
  }
}
```

- `destination`: `"new-window"` | `"current-window"` | `"incognito-window"`
- `existingPolicy`: `"all"` | `"missing-only"`

## 6. Default Open Preferences

```json
{ "destination": "new-window", "existingPolicy": "all" }
```

This exactly reproduces Phase 3's old "Open All" behavior (always a fresh regular window, ignoring anything already open), so every pre-Phase-4 Deck behaves identically until the user opts into something else.

## 7. Open execution flow (`BrowserState.openDeckWithPreferences`)

1. If the Deck has no shortcuts → `{ ok:false, reason:'empty-deck' }`.
2. Scope is derived from `destination`: `'incognito-window'` → scope `'incognito'`; otherwise → scope `'regular'`. If scope is `'incognito'` and `chrome.extension.isAllowedIncognitoAccess()` is false → `{ ok:false, reason:'incognito-not-allowed' }`.
3. If `existingPolicy === 'missing-only'`: run the shared `findDeckMatches(deck, scope)` and take the best-match window *within that scope only*.
   - Match with missing URLs → open just the missing ones there (`mode:'missing-only'`).
   - Match fully satisfied → focus that window/tab (`mode:'already-open'`).
   - No match in scope → fall through to step 4.
4. Fresh open per `destination`:
   - `'new-window'` → `openAllInNewWindow` (Phase 3's existing helper, unchanged) — `mode:'new-window'`.
   - `'current-window'` → all shortcuts opened as new tabs in the window this New Tab page is running in (`chrome.windows.getCurrent`) — `mode:'current-window'`, no new window created.
   - `'incognito-window'` → `chrome.windows.create({ incognito:true, url:[...] })` — `mode:'incognito-window'`, no regular-window fallback.

This was verified with a mocked `chrome` API against scenarios C, D, E, and G from the spec (see §13).

## 8. `.txt` export flow

`TabCapture.getExportUrls(scope)`:

- `'tab'` → the single active tab in the current window.
- `'window'` → every tab in the current window, sorted by tab index.
- `'all'` → every tab in every accessible "normal" window (incognito included wherever Chrome already exposes it to this context), window id ascending then tab index ascending within each window.
- All scopes filter to `http:`/`https:` only via the existing `isSupportedTabUrl` (excludes `chrome://`, `chrome-extension://`, `about:`, etc.) and are read-only — no tab is ever created, closed, or navigated.
- Duplicates are intentionally preserved (this reflects tabs actually open right now, not Deck identity).

`popup.js` then joins the URLs with `\n`, wraps them in a `Blob`, and triggers the download via an in-page `<a download>` click — no `"downloads"` permission needed. Filename: `deck-tabs-YYYY-MM-DD.txt`. Output is one URL per line with no metadata, so it pastes directly into the existing Paste Links box.

## 9. Incognito manifest choice and explanation

Added `"incognito": "spanning"` explicitly to `manifest.json` (this was already Chrome's implicit default; it's now documented rather than implicit).

**Why spanning, not split:** Deck New Tab wants one shared Deck store and one shared extension logic path for both regular and incognito windows — there's no need for isolated storage or a duplicated code path per profile context. With spanning mode and "Allow in Incognito" granted by the user, `chrome.windows.getAll()`/`chrome.tabs.query()` calls made from this extension's pages return **both** regular and incognito windows, each tagged with `incognito: true/false`. That's exactly the visibility Part 4 needs for incognito-aware Find and Open, with no extra plumbing.

## 10. Chrome Incognito limitations (documented, not worked around)

- **PLATFORM LIMITATION** — Chrome does not allow any extension to override the New Tab page inside an Incognito window, regardless of `"incognito"` mode or whether "Allow in Incognito" is granted. This is a hardcoded Chrome restriction, not a permissions issue, and Deck New Tab makes no attempt to circumvent it (per the explicit spec instruction). Incognito windows opened via Open Preferences show Chrome's own default Incognito New Tab page; Deck New Tab's UI is only reachable from that window's popup (toolbar icon), which does work in incognito once allowed.
- Everything else — incognito window creation, incognito tab/window scanning for Find/Open, the popup/toolbar — works normally once the user has flipped "Allow in Incognito" in `chrome://extensions`, and requires no extra permission beyond that user-facing toggle.

## 11. Newly added permissions and justification

**None.** `manifest.json`'s `"permissions"` array is unchanged: `["storage", "tabs"]`.

- `.txt` export uses `Blob` + `<a download>` from an already-privileged extension page — no `"downloads"` permission required.
- Incognito behavior is controlled entirely through the `"incognito"` manifest key (metadata, not a permission) plus the user's own "Allow in Incognito" toggle in `chrome://extensions` — nothing to request in code.
- Incognito window creation (`chrome.windows.create({ incognito:true })`) and incognito window/tab visibility both come from the existing `"tabs"`/`"storage"` permission set once the user has granted that toggle; no new permission scope exists for this.

## 12. Import/export migration behavior

- `exportData()` is unchanged in implementation — it serializes the full state, and since every in-memory Deck now always carries a `openPreferences` object, exported JSON automatically includes it. No version bump was needed since `openPreferences` is treated as optional/repairable on read.
- `validateDeckForImport` (IMPORT-STRICT) and `sanitizeDeck` (storage REPAIR) both run `openPreferences` through `normalizeOpenPreferences`, which **never fails**: a missing field, `null`, or an invalid/garbage shape all silently become `DEFAULT_OPEN_PREFERENCES` rather than rejecting the Deck or the whole import. This is a deliberate, documented exception to the otherwise-strict IMPORT-STRICT policy, specifically because every Deck exported before Phase 4 lacks this field.
- Verified with a runtime test: importing a legacy Deck JSON (no `openPreferences` key at all) and a "weird" Deck JSON (`destination:"nonsense"`, `existingPolicy:42`) both import successfully and land on the default preferences.

## 13. PASS/FAIL — every acceptance criterion

### Deck Redesign

| # | Criterion | Result |
|---|---|---|
| 1 | Upper tab retains trapezoid styling | PASS |
| 2 | Dropdown chevron removed | PASS |
| 3 | Deck name centered | PASS |
| 4 | Every real Deck gets a lower tray | PASS |
| 5 | Tray ~70% width | PASS |
| 6 | Tray contains exactly Find / Open / Gear | PASS |
| 7 | Find/Open text normally readable | PASS |
| 8 | Gear is icon-only | PASS |
| 9 | Active purple state extends into tray | PASS |
| 10 | `+ Add Deck` gets no tray/actions | PASS |
| 11 | Upper click still switches Deck | PASS |
| 12 | Deck drag/drop still works | PASS |
| 13 | Upper + lower reorder together | PASS (single `.deck-group` moved as one DOM unit) |
| 14 | Tray buttons never switch Deck | PASS (`stopPropagation` + sibling DOM structure, not nested) |
| 15 | Keyboard focus remains visible | PASS (native `:focus-visible` on tab/tray buttons; upper tab keeps `tabindex`/`role=button`/Enter-Space handling) |

### Gear / Settings

| # | Criterion | Result |
|---|---|---|
| 16 | Gear opens Deck settings | PASS |
| 17 | Rename works | PASS (unchanged) |
| 18 | Open Preferences exists | PASS |
| 19 | Delete works | PASS (unchanged) |
| 20 | Old chevron entry point gone | PASS |

### Open Preferences

| # | Criterion | Result |
|---|---|---|
| 21 | Preferences saved per Deck | PASS |
| 22 | Existing Decks get backward-compatible defaults | PASS (verified: legacy load path bug found and fixed — see §14) |
| 23 | New Regular Window works | PASS |
| 24 | Current Window works | PASS |
| 25 | New Incognito Window works when allowed | PASS |
| 26 | Incognito option clearly disabled when unavailable | PASS (radio disabled + inline hint text in modal, toast on attempted Open) |
| 27 | Open All policy works | PASS |
| 28 | Open Missing Only policy works | PASS |
| 29 | Visible Open button obeys saved preferences | PASS |
| 30 | Preferences persist | PASS (persisted via existing `persist()`/`chrome.storage.local`) |
| 31 | Preferences export/import with Deck JSON | PASS |
| 32 | Legacy Deck JSON handles missing preferences safely | PASS |

### TXT Export

| # | Criterion | Result |
|---|---|---|
| 33 | Popup exposes Export Tabs to `.txt` | PASS |
| 34 | This Tab works | PASS |
| 35 | This Window works | PASS |
| 36 | All Windows works for accessible windows | PASS |
| 37 | One eligible URL per line | PASS |
| 38 | Unsupported internal URLs excluded | PASS |
| 39 | File downloads successfully | PASS (Blob + `<a download>`) |
| 40 | Export never alters/closes tabs | PASS (read-only `chrome.tabs.query`/`chrome.windows.getAll` only) |
| 41 | Output pasteable into Paste Links | PASS (plain one-URL-per-line, same format Paste Links already parses) |
| 42 | Added permissions minimal/documented | PASS (zero added — see §11) |

### Incognito

| # | Criterion | Result |
|---|---|---|
| 43 | New Tab incognito limitation documented | PASS — see §10 |
| 44 | No attempt to circumvent it | PASS |
| 45 | Extension enable-for-incognito uses Chrome's supported mechanism | PASS (`chrome://extensions` toggle + `"incognito":"spanning"`) |
| 46 | Toolbar/capture works in incognito where permitted | PASS (popup runs normally once allowed; no code path is regular-window-only) |
| 47 | New Incognito Window Open works when enabled | PASS |
| 48 | Find Deck works against accessible incognito window state | PASS (unscoped `findDeckMatches` naturally includes incognito windows Chrome exposes; results labeled "(Incognito)") |
| 49 | Incognito tab/window IDs never persisted | PASS (all scans are on-demand, nothing written to storage) |
| 50 | Incognito history never stored | PASS (no history API used anywhere) |
| 51 | Regular/incognito isolation respected | PASS (scoped matching in `openDeckWithPreferences` never crosses regular/incognito boundaries; visibility itself is entirely delegated to Chrome's own incognito permission model) |

### Regression

| # | Criterion | Result |
|---|---|---|
| 52 | Phase 1 Deck behavior still works | PASS |
| 53 | Phase 2 capture still works | PASS (`tab-capture.js` capture functions untouched) |
| 54 | Phase 3 Find still works | PASS (`findDeckMatches` default call path unchanged) |
| 55 | Go Here still works | PASS (`focusWindow` untouched) |
| 56 | Open Missing still works | PASS (`openMissingInWindow` untouched, still used by Find modal) |
| 57 | Shortcut drag reorder still works | PASS (untouched code path) |
| 58 | Deck drag reorder still works | PASS (retargeted to `.deck-group`, verified logic equivalent) |
| 59 | Search still works | PASS (untouched) |
| 60 | JSON import/export still works | PASS |
| 61 | Paste Links still works | PASS (untouched) |
| 62 | Save Current Window as New Deck still works | PASS (untouched) |
| 63 | No persistent browser session/window tracking added | PASS |
| 64 | No unrelated page redesign introduced | PASS (only Deck tab area + new modal + new popup section touched) |

**64 / 64 acceptance criteria: PASS.** No criterion required a `PLATFORM LIMITATION` marking — the one true platform limitation (New Tab override banned in Incognito) was a *documentation* requirement (#43), not a feature the spec asked to be implemented.

## 14. Bugs found and fixed during verification

Runtime simulation (mocked `chrome.storage`/`chrome.windows`/`chrome.tabs`) surfaced one real bug before packaging:

- **First-run and "last Deck deleted" fallback Decks were missing `openPreferences` entirely** (`decks.js`, two call sites building a raw Deck literal directly instead of going through `createDeck`). This meant a brand-new install's Default Deck, and any Deck recreated after deleting the last one, would carry `openPreferences: {}` instead of the documented default — silently breaking criterion #22. Fixed by giving both literals `openPreferences: { ...DEFAULT_OPEN_PREFERENCES }`. Re-verified with the same test harness; both paths now produce the correct default.

No other logic bugs were found. `openDeckWithPreferences` was exercised against mocked scenarios matching spec scenarios C, D, E (both the partial-match and fully-open sub-cases), G, and G2 (incognito denied), plus an incognito-vs-regular scope-isolation case and the empty-Deck guard — all produced the expected `mode`/`windowId`/`opened` results with no unexpected `chrome.*` calls. `getExportUrls` was exercised against all three scopes with mixed eligible/ineligible URLs and out-of-order tab indices — output ordering and filtering were correct in every case.

## 15. Intentionally deferred items

None required by the spec were skipped. Explicitly out of scope per the original spec's "OUT OF SCOPE" section (not attempted): anything beyond Find/Open/Gear in the tray, additional Open destinations beyond the three specified, and any incognito capability beyond what Chrome's `spanning` + "Allow in Incognito" model already provides.
