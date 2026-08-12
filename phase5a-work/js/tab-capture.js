// tab-capture.js
//
// Sole responsibility: talk to chrome.tabs and turn raw Chrome Tab
// objects into the small, UI-agnostic shape the popup needs. This
// module knows NOTHING about Decks, DeckStore, or the DOM - that
// split mirrors storage.js/decks.js from Phase 1. popup.js is the
// only thing that imports Deck concepts into the picture.

/**
 * The same "valid shortcut URL" rule DeckStore enforces (http/https
 * only). Duplicated here on purpose rather than imported, so this
 * file can classify tabs before anything ever reaches DeckStore -
 * DeckStore's own validateShortcutStrict remains the authoritative
 * check at the point shortcuts are actually persisted.
 */
function isSupportedTabUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function abbreviateDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Tabs from the CURRENT browser window only (Phase 2 scope - scanning
 * tabs across ALL windows is Phase 3's "Find Deck" territory and is
 * intentionally not done here).
 */
async function getCurrentWindowTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map((tab) => ({
    id: tab.id,
    title: (tab.title && tab.title.trim()) || tab.url || 'Untitled tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || null,
    domain: abbreviateDomain(tab.url || ''),
    supported: isSupportedTabUrl(tab.url),
  }));
}

/**
 * The single currently-active tab in the current browser window, in
 * the same shape as getCurrentWindowTabs() rows. Used by capture
 * mode TAB. Returns null if, for some reason, Chrome reports no
 * active tab (should not normally happen).
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return {
    id: tab.id,
    title: (tab.title && tab.title.trim()) || tab.url || 'Untitled tab',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || null,
    domain: abbreviateDomain(tab.url || ''),
    supported: isSupportedTabUrl(tab.url),
  };
}

/**
 * Part 3 - Export Tabs to .txt.
 *
 * Returns a flat array of eligible (http/https only) tab URLs for the
 * requested scope, in logical browser order (window id ascending, tab
 * index ascending within a window) - deliberately NOT deduplicated:
 * this represents the actual open tabs right now, not Deck identity,
 * so an intentional duplicate tab shows up as a duplicate line (see
 * PART 3 - EXPORT RULES in the Phase 4 spec).
 *
 * scope: 'tab' (the single active tab) | 'window' (current window) |
 * 'all' (every accessible normal window, incognito included wherever
 * Chrome exposes it to this context - same visibility rule as
 * BrowserState's Deck matching, no special-casing needed here).
 *
 * Never touches/closes any tab - this is a read-only export.
 */
async function getExportUrls(scope) {
  if (scope === 'tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && isSupportedTabUrl(tab.url) ? [tab.url] : [];
  }

  if (scope === 'window') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs
      .slice()
      .sort((a, b) => a.index - b.index)
      .filter((t) => isSupportedTabUrl(t.url))
      .map((t) => t.url);
  }

  // 'all' - every accessible normal-type window.
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const urls = [];
  for (const win of windows.slice().sort((a, b) => a.id - b.id)) {
    const tabs = (win.tabs || []).slice().sort((a, b) => a.index - b.index);
    for (const tab of tabs) {
      if (isSupportedTabUrl(tab.url)) urls.push(tab.url);
    }
  }
  return urls;
}

window.TabCapture = {
  getCurrentWindowTabs,
  getActiveTab,
  isSupportedTabUrl,
  getExportUrls,
};
