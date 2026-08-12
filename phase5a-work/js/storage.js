// storage.js
//
// Sole responsibility: read/write the raw persisted blob to
// chrome.storage.local. This module knows NOTHING about what a
// "Deck" or "Shortcut" is - it only moves a plain JS object in and
// out of storage. All Deck/shortcut logic lives in decks.js.

const STORAGE_KEY = 'deckNewTabState';

// Separate key on purpose: this is a popup UI preference (which
// capture mode was last used), not part of the Deck/shortcut state
// schema that decks.js owns, validates, and imports/exports. Keeping
// it out of STORAGE_KEY means it can never interact with
// normalizeState(), the Deck-limit check, or import/export.
const CAPTURE_MODE_KEY = 'deckNewTabLastCaptureMode';

// Also separate on purpose, same reasoning as CAPTURE_MODE_KEY: this is
// a New Tab UI presentation preference (auto/expanded/collapsed Deck
// shelf), not Deck/shortcut data, so it stays out of normalizeState(),
// the Deck-limit check, and import/export entirely.
const SHELF_MODE_KEY = 'deckNewTabShelfMode';

/**
 * Load the raw state object from chrome.storage.local.
 * Returns null if nothing has been stored yet, or if the storage
 * API itself fails (e.g. quota / runtime errors) so callers can
 * fall back to a fresh state instead of throwing.
 */
async function loadRawState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const value = result ? result[STORAGE_KEY] : undefined;
    return value === undefined ? null : value;
  } catch (err) {
    console.error('[storage] Failed to load state, returning null.', err);
    return null;
  }
}

/**
 * Persist the raw state object to chrome.storage.local.
 * Returns true on success, false on failure. Callers should treat a
 * false result as "state changed in memory but was not saved" and
 * may choose to surface a warning, but the app must not crash.
 */
async function saveRawState(state) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return true;
  } catch (err) {
    console.error('[storage] Failed to save state.', err);
    return false;
  }
}

/**
 * Load the last-used popup capture mode ('tab' | 'window' | 'curated').
 * Returns null if nothing has been stored yet or the read fails, so
 * the popup can fall back to a sensible default.
 */
async function loadLastCaptureMode() {
  try {
    const result = await chrome.storage.local.get(CAPTURE_MODE_KEY);
    const value = result ? result[CAPTURE_MODE_KEY] : undefined;
    return typeof value === 'string' ? value : null;
  } catch (err) {
    console.error('[storage] Failed to load last capture mode.', err);
    return null;
  }
}

/** Persist the last-used popup capture mode. Best-effort, like saveRawState. */
async function saveLastCaptureMode(mode) {
  try {
    await chrome.storage.local.set({ [CAPTURE_MODE_KEY]: mode });
    return true;
  } catch (err) {
    console.error('[storage] Failed to save last capture mode.', err);
    return false;
  }
}

/**
 * Load the user's Deck shelf presentation preference
 * ('auto' | 'expanded' | 'collapsed'). Returns null if nothing has
 * been stored yet or the read fails, so the New Tab page can fall
 * back to 'auto'.
 */
async function loadShelfMode() {
  try {
    const result = await chrome.storage.local.get(SHELF_MODE_KEY);
    const value = result ? result[SHELF_MODE_KEY] : undefined;
    return typeof value === 'string' ? value : null;
  } catch (err) {
    console.error('[storage] Failed to load shelf mode.', err);
    return null;
  }
}

/** Persist the Deck shelf presentation preference. Best-effort. */
async function saveShelfMode(mode) {
  try {
    await chrome.storage.local.set({ [SHELF_MODE_KEY]: mode });
    return true;
  } catch (err) {
    console.error('[storage] Failed to save shelf mode.', err);
    return false;
  }
}

// Exposed as a small namespace on window so app.js/decks.js can use
// it without a build step (Phase 1 is plain scripts, no bundler).
window.DeckStorage = {
  loadRawState,
  saveRawState,
  loadLastCaptureMode,
  saveLastCaptureMode,
  loadShelfMode,
  saveShelfMode,
};
