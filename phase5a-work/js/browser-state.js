// browser-state.js
//
// Sole responsibility: talk to chrome.windows / chrome.tabs and answer
// "where (if anywhere) is this Deck already open?" plus the launch
// actions that follow from that answer. This module knows NOTHING
// about how Decks are stored - it only ever receives an already-loaded
// Deck object (from DeckStore) and normalizes/compares URLs using
// window.DeckStore.normalizeUrl, the same rule DeckStore itself uses
// for duplicate checking. That keeps "same URL" meaning one thing
// everywhere in the app (see decks.js's normalizeUrl export).
//
// Everything here is an ON-DEMAND scan triggered by a user action
// (Find Deck / Open All / Open Missing). Nothing in this file writes
// to chrome.storage.local, keeps a running list of tab/window IDs, or
// polls in the background - window and tab IDs are treated as pure
// runtime state that is read fresh every time and never persisted.
//
// Scope: only "normal" browser windows are scanned (chrome.windows'
// own popup/panel/devtools/app window types are excluded), matching
// the product idea of "which of my normal browser windows already has
// this working context open."

/**
 * Dedupe a Deck's shortcut URLs down to the set of unique normalized
 * URLs, preserving Deck (first-occurrence) order. Phase 3 policy: a
 * legacy/imported Deck with duplicate shortcut URLs should not let one
 * open tab "count twice" - see URL MATCHING POLICY / DUPLICATE DECK
 * URL CONSIDERATION in the Phase 3 spec.
 */
function uniqueDeckUrls(deck) {
  const seen = new Set();
  const ordered = [];
  for (const shortcut of deck.shortcuts) {
    const normalized = window.DeckStore.normalizeUrl(shortcut.url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Read every currently open "normal" Chrome window and its tabs.
 * Returns [{ id, focused, tabs: [{ id, url, normalizedUrl }] }], sorted
 * ascending by window id so downstream tie-breaking is deterministic
 * regardless of what order the browser happens to report windows in.
 */
async function getScannableWindows() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return windows
    .map((win) => ({
      id: win.id,
      focused: !!win.focused,
      // Phase 4: surfaced so callers can scope matching to regular-only
      // or incognito-only windows (see findDeckMatches' `scope` option
      // below). Chrome only includes incognito windows here at all when
      // the user has granted "Allow in Incognito" for this extension -
      // no special-case code is needed to respect that boundary, it
      // simply falls out of what chrome.windows.getAll() returns.
      incognito: !!win.incognito,
      tabs: (win.tabs || []).map((tab) => ({
        id: tab.id,
        url: tab.url || '',
        normalizedUrl: window.DeckStore.normalizeUrl(tab.url || ''),
      })),
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Core Find Deck comparison.
 *
 * Scoring: for each scanned window, match count = number of the
 * Deck's UNIQUE normalized shortcut URLs found among that window's
 * open tabs (exact normalized-URL equality only - no fuzzy/hostname
 * matching, per the Phase 3 URL MATCHING POLICY).
 *
 * Best-match tie-breaker (documented per spec): highest match count
 * wins; ties are broken by (1) the currently focused window, then
 * (2) lowest window id (windows are pre-sorted ascending by id, so
 * this falls out of a stable sort on match count).
 *
 * Returns { totalUnique, windows: [...], bestWindowId } where each
 * window entry is:
 *   { windowId, focused, incognito, matchedCount, missingUrls, matchedTabId }
 * matchedTabId is the id of the tab holding the FIRST Deck URL (in
 * Deck order) found in that window - the deterministic tab to
 * activate if the user asks to go there (see focusWindow below).
 * Windows with zero matches are omitted from the result list.
 *
 * `scope` (Phase 4, optional): 'regular' | 'incognito' | undefined.
 * The classic Find Deck button/modal calls this with no scope, exactly
 * as Phase 3 did - it sees every window Chrome exposes to this
 * extension context, incognito windows included where "Allow in
 * Incognito" has been granted (see getScannableWindows above). The
 * Phase 4 Open engine (openDeckWithPreferences) calls this WITH a
 * scope so a Deck's "Current Window"/"New Regular Window" destination
 * never matches against an incognito window and vice versa - this is
 * the one and only matching implementation either path uses.
 */
async function findDeckMatches(deck, scope) {
  const deckUrls = uniqueDeckUrls(deck);
  let windows = await getScannableWindows();
  if (scope === 'regular') windows = windows.filter((w) => !w.incognito);
  else if (scope === 'incognito') windows = windows.filter((w) => w.incognito);

  const results = [];
  for (const win of windows) {
    const openUrls = new Set(win.tabs.map((t) => t.normalizedUrl).filter(Boolean));
    const missingUrls = [];
    let matchedCount = 0;
    let matchedTabId = null;

    for (const url of deckUrls) {
      if (openUrls.has(url)) {
        matchedCount++;
        if (matchedTabId === null) {
          // First Deck-order URL found in this window - deterministic
          // "which tab to activate" choice (see PART 2 - GO TO / FOCUS).
          const tab = win.tabs.find((t) => t.normalizedUrl === url);
          matchedTabId = tab ? tab.id : null;
        }
      } else {
        missingUrls.push(url);
      }
    }

    if (matchedCount > 0) {
      results.push({
        windowId: win.id,
        focused: win.focused,
        incognito: win.incognito,
        matchedCount,
        missingUrls,
        matchedTabId,
      });
    }
  }

  // Deterministic best-match sort: highest count first; tie -> focused
  // window first; tie -> lowest window id (already ascending from
  // getScannableWindows, and Array.prototype.sort is stable).
  results.sort((a, b) => {
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return 0; // stable sort preserves ascending window-id order from input
  });

  return {
    totalUnique: deckUrls.length,
    windows: results,
    bestWindowId: results.length > 0 ? results[0].windowId : null,
  };
}

/**
 * PART 2 - focus a window and, if a deterministic matched tab is
 * known, activate it too. Never touches any other tab or window.
 */
async function focusWindow(windowId, tabId) {
  await chrome.windows.update(windowId, { focused: true });
  if (tabId !== null && tabId !== undefined) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (err) {
      // Tab may have closed between the scan and the click; focusing
      // the window itself already succeeded, so this is non-fatal.
      console.warn('[browser-state] could not activate matched tab', err);
    }
  }
}

/**
 * PART 4 - Open Missing. Opens exactly `missingUrls`, in the order
 * given (Deck order), as new background tabs in `windowId`. Never
 * touches existing tabs. Returns the number of tabs successfully
 * created.
 */
async function openMissingInWindow(windowId, missingUrls) {
  let opened = 0;
  for (const url of missingUrls) {
    try {
      await chrome.tabs.create({ windowId, url, active: false });
      opened++;
    } catch (err) {
      console.error('[browser-state] failed to open missing URL', url, err);
    }
  }
  return opened;
}

/**
 * PART 3 - Open All. Opens every eligible (unique, normalized) Deck
 * shortcut URL, in Deck order, as a brand-new Chrome window. Chrome's
 * windows.create accepts an array of URLs and opens them as that
 * window's initial tabs in the given order, so Deck order is
 * preserved without any extra bookkeeping. No-ops (returns null)
 * for an empty Deck rather than creating an empty/blank window.
 */
async function openAllInNewWindow(deck) {
  const urls = uniqueDeckUrls(deck);
  if (urls.length === 0) return null;
  const win = await chrome.windows.create({ url: urls });
  return win ? win.id : null;
}

/**
 * PART 4 - whether THIS extension context is currently allowed to see/
 * act on incognito windows at all. Backed by Chrome's own supported
 * check (chrome.extension.isAllowedIncognitoAccess), not a guess - true
 * only once the user has flipped "Allow in Incognito" for Deck New Tab
 * in chrome://extensions. Never persisted; re-checked on demand.
 */
async function isIncognitoAccessAllowed() {
  try {
    return await chrome.extension.isAllowedIncognitoAccess();
  } catch (err) {
    console.warn('[browser-state] could not check incognito access', err);
    return false;
  }
}

/**
 * PART 2 (Current Window destination) - "the currently relevant regular
 * Chrome window" is defined as the (non-incognito) window this very
 * script is running in - i.e. the window the person is looking at the
 * New Tab page in right now when they click Open. Falls back to any
 * other open regular window only if that somehow isn't available.
 */
async function getCurrentRegularWindow() {
  try {
    const win = await chrome.windows.getCurrent({ windowTypes: ['normal'] });
    if (win && !win.incognito) return win;
  } catch (err) {
    // fall through to the broader lookup below
  }
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all.find((w) => !w.incognito) || null;
}

/**
 * PART 2 - the single Open implementation every visible "Open" control
 * (the Deck tab tray's Open button) goes through, driven entirely by
 * the Deck's saved Open Preferences. Not used by "Open All Fresh" in
 * the Find Deck modal, or by the old always-fresh openAllInNewWindow -
 * those remain intentionally simple/explicit ("start over, ignore
 * anything already open") and are unaffected by this function.
 *
 * Algorithm:
 *   1. Scope matching to regular windows (new-window/current-window
 *      destinations) or incognito windows (incognito-window
 *      destination) - the same matching core as Find Deck (see
 *      findDeckMatches' `scope` option), so "same URL"/"best match"
 *      can never disagree between Find and Open.
 *   2. existingPolicy 'missing-only': if a best-match window exists in
 *      that scope, reuse it - fill in only the missing shortcuts (or
 *      just focus it if the Deck is already fully open there). This
 *      intentionally takes priority over `destination`: the whole
 *      point of "missing only" is "don't open a duplicate window/tabs
 *      for what's already open", regardless of which destination is
 *      configured.
 *   3. Otherwise (existingPolicy 'all', or no match found): open fresh
 *      according to `destination` - a new regular window, new tabs in
 *      the current regular window, or a new incognito window.
 *
 * Returns { ok, mode, windowId?, opened? } on success, or
 * { ok:false, reason } - reason is one of 'empty-deck' or
 * 'incognito-not-allowed' - so the caller (app.js) can show an
 * appropriate message without this module knowing about the DOM.
 */
async function openDeckWithPreferences(deck) {
  const prefs = deck.openPreferences || { destination: 'new-window', existingPolicy: 'all' };

  if (!deck.shortcuts || deck.shortcuts.length === 0) {
    return { ok: false, reason: 'empty-deck' };
  }

  const scope = prefs.destination === 'incognito-window' ? 'incognito' : 'regular';

  if (scope === 'incognito') {
    const allowed = await isIncognitoAccessAllowed();
    if (!allowed) return { ok: false, reason: 'incognito-not-allowed' };
  }

  if (prefs.existingPolicy === 'missing-only') {
    const matchResult = await findDeckMatches(deck, scope);
    const bestMatch = matchResult.windows[0] || null;
    if (bestMatch && bestMatch.missingUrls.length > 0) {
      const opened = await openMissingInWindow(bestMatch.windowId, bestMatch.missingUrls);
      return { ok: true, mode: 'missing-only', windowId: bestMatch.windowId, opened };
    }
    if (bestMatch && bestMatch.missingUrls.length === 0) {
      await focusWindow(bestMatch.windowId, bestMatch.matchedTabId);
      return { ok: true, mode: 'already-open', windowId: bestMatch.windowId };
    }
    // No existing match in scope - nothing to treat as "missing
    // from", so fall through to a fresh open per `destination` below.
  }

  const urls = uniqueDeckUrls(deck);

  if (prefs.destination === 'current-window') {
    const win = await getCurrentRegularWindow();
    if (!win) {
      const windowId = await openAllInNewWindow(deck);
      return { ok: true, mode: 'new-window-fallback', windowId };
    }
    let opened = 0;
    for (const url of urls) {
      try {
        await chrome.tabs.create({ windowId: win.id, url, active: false });
        opened++;
      } catch (err) {
        console.error('[browser-state] failed to open URL in current window', url, err);
      }
    }
    return { ok: true, mode: 'current-window', windowId: win.id, opened };
  }

  if (prefs.destination === 'incognito-window') {
    const win = await chrome.windows.create({ incognito: true, url: urls });
    return { ok: true, mode: 'incognito-window', windowId: win ? win.id : null };
  }

  // Default: 'new-window' - identical to Phase 3's Open All.
  const windowId = await openAllInNewWindow(deck);
  return { ok: true, mode: 'new-window', windowId };
}

window.BrowserState = {
  findDeckMatches,
  focusWindow,
  openMissingInWindow,
  openAllInNewWindow,
  isIncognitoAccessAllowed,
  getCurrentRegularWindow,
  openDeckWithPreferences,
};
