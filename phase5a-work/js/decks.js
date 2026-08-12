// decks.js
//
// The DeckStore: the single source of truth for Deck + shortcut data.
//
// Responsibility split (see project README):
//   storage.js -> persistence only (raw blob in / out of chrome.storage.local)
//   decks.js   -> Deck CRUD, active Deck identity, shortcut CRUD,
//                 data normalization, Deck limit enforcement
//   app.js     -> UI rendering + DOM/event wiring only
//
// app.js (and, later, Phase 2's popup) should only ever talk to the
// DeckStore API below. Nothing outside this file should read or
// write chrome.storage.local directly, and nothing outside this file
// should reach into a Deck object and mutate it by hand.

const SCHEMA_VERSION = 1;
const MAX_DECKS = 10;
const DEFAULT_DECK_NAME = 'Default';

// ---------------------------------------------------------------------------
// Phase 4: Per-Deck Open Preferences
//
// { destination: 'new-window' | 'current-window' | 'incognito-window',
//   existingPolicy: 'all' | 'missing-only' }
//
// DEFAULT_OPEN_PREFERENCES intentionally reproduces the exact pre-Phase-4
// "Open All" behavior (always a fresh regular window, ignoring anything
// already open) so every Deck created before Phase 4 keeps behaving
// exactly as it did in Phase 3 unless the user opts into something else.
// ---------------------------------------------------------------------------

const OPEN_DESTINATIONS = ['new-window', 'current-window', 'incognito-window'];
const OPEN_EXISTING_POLICIES = ['all', 'missing-only'];
const DEFAULT_OPEN_PREFERENCES = Object.freeze({ destination: 'new-window', existingPolicy: 'all' });

/** In-memory state. Always kept normalized/valid after init(). */
let state = {
  schemaVersion: SCHEMA_VERSION,
  activeDeckId: null,
  decks: [],
};

/** Subscribers notified after every committed change. */
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(getState());
    } catch (err) {
      console.error('[decks] listener threw', err);
    }
  }
}

function makeId(prefix) {
  const rand =
    (crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${rand}`;
}

// ---------------------------------------------------------------------------
// Validation policy
//
// Two distinct paths touch untrusted data, and they use different
// policies on purpose:
//
//   REPAIR (used only for data loaded from chrome.storage.local, i.e.
//   normalizeState()/sanitizeDeck()/sanitizeShortcut()): best-effort
//   recovery. Storage can be corrupted by things outside the user's
//   control (a bad write, a future schema, manual edits, a bug in an
//   older version), so unrecoverable records are dropped silently
//   and the app keeps working rather than becoming unusable.
//
//   STRICT (used for the DeckStore API boundary - addShortcut,
//   addShortcuts, updateShortcut): the input is something a user is
//   actively supplying right now, so invalid records are rejected
//   with a clear error and nothing bad is persisted. IDs are
//   auto-generated here since the UI never supplies one for a new
//   Deck/shortcut.
//
//   IMPORT-STRICT (validateDeckForImport/validateShortcutForImport,
//   used only by importData()): the strictest policy. A user-supplied
//   JSON file must already carry valid, non-empty Deck/Shortcut IDs
//   and a valid activeDeckId that matches one of the imported Decks -
//   none of these are silently generated or defaulted. The first
//   invalid Deck/shortcut record aborts the WHOLE import with a
//   specific error, so an import never partially "eats" part of a
//   file without the user knowing.
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Repair-style normalization for a Deck's openPreferences. Used on the
 * REPAIR path (loading from storage) AND at the STRICT/IMPORT-STRICT API
 * boundaries for this one field specifically - unlike the rest of the
 * Deck record, openPreferences must never cause a Deck (or a whole
 * import) to be rejected, because every pre-Phase-4 Deck lacks this
 * field entirely and Phase 4 must not break them (Acceptance #22, #32).
 * An absent or malformed value silently becomes DEFAULT_OPEN_PREFERENCES.
 */
function normalizeOpenPreferences(raw) {
  const destination = OPEN_DESTINATIONS.includes(raw && raw.destination)
    ? raw.destination
    : DEFAULT_OPEN_PREFERENCES.destination;
  const existingPolicy = OPEN_EXISTING_POLICIES.includes(raw && raw.existingPolicy)
    ? raw.existingPolicy
    : DEFAULT_OPEN_PREFERENCES.existingPolicy;
  return { destination, existingPolicy };
}

/**
 * The only definition of "a valid shortcut URL" in the app: an
 * absolute http:// or https:// URL. Returns the normalized href, or
 * null if `raw` isn't one. Deliberately does NOT guess/add a missing
 * scheme - that convenience belongs to the UI layer (see app.js
 * normalizeUrlForSave), not the data layer.
 */
function parseHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

/** STRICT: validate a single shortcut record. Never repairs the URL. */
function validateShortcutStrict(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Shortcut must be an object.' };
  }
  const url = parseHttpUrl(raw.url);
  if (!url) {
    return { ok: false, error: 'Shortcut URL must be a valid http:// or https:// URL.' };
  }
  return {
    ok: true,
    shortcut: {
      id: isNonEmptyString(raw.id) ? raw.id : makeId('sc'),
      name: isNonEmptyString(raw.name) ? raw.name.trim().slice(0, 100) : url,
      url,
    },
  };
}

/** STRICT: validate a single Deck record, including all its shortcuts. */
function validateDeckStrict(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Deck must be an object.' };
  }
  if (!isNonEmptyString(raw.name)) {
    return { ok: false, error: 'Deck name is missing or empty.' };
  }
  if (raw.shortcuts !== undefined && !Array.isArray(raw.shortcuts)) {
    return { ok: false, error: `Deck "${raw.name}" has an invalid "shortcuts" field (expected an array).` };
  }

  const shortcutsRaw = Array.isArray(raw.shortcuts) ? raw.shortcuts : [];
  const shortcuts = [];
  for (let i = 0; i < shortcutsRaw.length; i++) {
    const result = validateShortcutStrict(shortcutsRaw[i]);
    if (!result.ok) {
      return { ok: false, error: `Deck "${raw.name}", shortcut ${i + 1}: ${result.error}` };
    }
    shortcuts.push(result.shortcut);
  }

  return {
    ok: true,
    deck: {
      id: isNonEmptyString(raw.id) ? raw.id : makeId('deck'),
      name: raw.name.trim().slice(0, 60),
      shortcuts,
      openPreferences: normalizeOpenPreferences(raw.openPreferences),
    },
  };
}

/**
 * IMPORT-STRICT: same URL rule as validateShortcutStrict, but a
 * non-empty "id" is mandatory. User-imported JSON must carry its own
 * Shortcut IDs - they are never silently generated during import.
 */
function validateShortcutForImport(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Shortcut must be an object.' };
  }
  if (!isNonEmptyString(raw.id)) {
    return { ok: false, error: 'Shortcut is missing a valid non-empty "id".' };
  }
  const url = parseHttpUrl(raw.url);
  if (!url) {
    return { ok: false, error: 'Shortcut URL must be a valid http:// or https:// URL.' };
  }
  return {
    ok: true,
    shortcut: {
      id: raw.id.trim(),
      name: isNonEmptyString(raw.name) ? raw.name.trim().slice(0, 100) : url,
      url,
    },
  };
}

/**
 * IMPORT-STRICT: same shape rules as validateDeckStrict, but a
 * non-empty "id" is mandatory and every shortcut is checked with
 * validateShortcutForImport (so Shortcut IDs are required too).
 */
function validateDeckForImport(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Deck must be an object.' };
  }
  if (!isNonEmptyString(raw.id)) {
    return { ok: false, error: 'Deck is missing a valid non-empty "id".' };
  }
  if (!isNonEmptyString(raw.name)) {
    return { ok: false, error: `Deck "${raw.id}" is missing a valid non-empty name.` };
  }
  if (raw.shortcuts !== undefined && !Array.isArray(raw.shortcuts)) {
    return { ok: false, error: `Deck "${raw.name}" has an invalid "shortcuts" field (expected an array).` };
  }

  const shortcutsRaw = Array.isArray(raw.shortcuts) ? raw.shortcuts : [];
  const shortcuts = [];
  for (let i = 0; i < shortcutsRaw.length; i++) {
    const result = validateShortcutForImport(shortcutsRaw[i]);
    if (!result.ok) {
      return { ok: false, error: `Deck "${raw.name}", shortcut ${i + 1}: ${result.error}` };
    }
    shortcuts.push(result.shortcut);
  }

  return {
    ok: true,
    deck: {
      id: raw.id.trim(),
      name: raw.name.trim().slice(0, 60),
      shortcuts,
      // Legacy exported/imported Deck JSON has no openPreferences field
      // at all - normalizeOpenPreferences() defaults it safely rather
      // than failing the import (Acceptance #32).
      openPreferences: normalizeOpenPreferences(raw.openPreferences),
    },
  };
}

/**
 * REPAIR: recover a shortcut loaded from chrome.storage.local. Unlike
 * the strict validator, this will try prefixing a missing scheme
 * (e.g. an old/hand-edited record with url: "github.com") before
 * giving up. Returns null - and the record is dropped - only if it
 * still can't be made into a valid http/https URL.
 */
function sanitizeShortcut(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.url !== 'string') return null;

  const trimmed = raw.url.trim();
  if (!trimmed) return null;

  let url = parseHttpUrl(trimmed);
  if (!url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    url = parseHttpUrl(`https://${trimmed}`);
  }
  if (!url) return null;

  return {
    id: isNonEmptyString(raw.id) ? raw.id : makeId('sc'),
    name: isNonEmptyString(raw.name) ? raw.name.trim().slice(0, 100) : url,
    url,
  };
}

/** REPAIR: recover a Deck loaded from chrome.storage.local. */
function sanitizeDeck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNonEmptyString(raw.name)) return null;

  const shortcuts = Array.isArray(raw.shortcuts)
    ? raw.shortcuts.map(sanitizeShortcut).filter(Boolean)
    : [];

  return {
    id: isNonEmptyString(raw.id) ? raw.id : makeId('deck'),
    name: raw.name.trim().slice(0, 60),
    shortcuts,
    openPreferences: normalizeOpenPreferences(raw.openPreferences),
  };
}

/**
 * Turn whatever was loaded from storage (possibly null, possibly
 * corrupted, possibly from an older schema) into a guaranteed-valid
 * state object. Never throws.
 */
function normalizeState(rawState) {
  let decksInput =
    rawState && Array.isArray(rawState.decks) ? rawState.decks : [];

  let decks = decksInput.map(sanitizeDeck).filter(Boolean);

  // De-duplicate any accidental duplicate ids from a bad import.
  const seenIds = new Set();
  decks = decks.filter((d) => {
    if (seenIds.has(d.id)) return false;
    seenIds.add(d.id);
    return true;
  });

  // Enforce the Deck limit even on load, in case storage was hand-edited.
  if (decks.length > MAX_DECKS) {
    decks = decks.slice(0, MAX_DECKS);
  }

  // First run / totally empty storage -> create exactly one Default Deck.
  if (decks.length === 0) {
    decks = [
      {
        id: makeId('deck'),
        name: DEFAULT_DECK_NAME,
        shortcuts: [],
        openPreferences: { ...DEFAULT_OPEN_PREFERENCES },
      },
    ];
  }

  let activeDeckId =
    rawState && isNonEmptyString(rawState.activeDeckId)
      ? rawState.activeDeckId
      : null;

  const activeExists = decks.some((d) => d.id === activeDeckId);
  if (!activeExists) {
    // Deleted/missing/invalid active Deck -> fall back to the first
    // available Deck so the app is never left without an active Deck.
    activeDeckId = decks[0].id;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    activeDeckId,
    decks,
  };
}

// ---------------------------------------------------------------------------
// Persistence glue
// ---------------------------------------------------------------------------

async function persist() {
  const ok = await window.DeckStorage.saveRawState(state);
  if (!ok) {
    console.warn('[decks] state change could not be saved to storage.');
  }
  notify();
  return ok;
}

/** Load + normalize once at startup. Must be called before any other API. */
async function init() {
  const raw = await window.DeckStorage.loadRawState();
  state = normalizeState(raw);
  // If normalization changed anything relative to what was stored
  // (first run, repaired corruption, dropped over-limit decks, etc.)
  // write the clean version back so storage stays consistent.
  await window.DeckStorage.saveRawState(state);
  notify();
  return getState();
}

function getState() {
  // Shallow-ish clone so callers can't mutate internal state directly.
  return {
    schemaVersion: state.schemaVersion,
    activeDeckId: state.activeDeckId,
    decks: state.decks.map((d) => ({
      id: d.id,
      name: d.name,
      shortcuts: d.shortcuts.map((s) => ({ ...s })),
      openPreferences: { ...d.openPreferences },
    })),
  };
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Deck queries
// ---------------------------------------------------------------------------

function getDecks() {
  return getState().decks;
}

function getDeckById(deckId) {
  const deck = state.decks.find((d) => d.id === deckId);
  return deck
    ? {
        id: deck.id,
        name: deck.name,
        shortcuts: deck.shortcuts.map((s) => ({ ...s })),
        openPreferences: { ...deck.openPreferences },
      }
    : null;
}

function getActiveDeckId() {
  return state.activeDeckId;
}

function getActiveDeck() {
  return getDeckById(state.activeDeckId);
}

function isAtDeckLimit() {
  return state.decks.length >= MAX_DECKS;
}

// ---------------------------------------------------------------------------
// Deck mutations
// ---------------------------------------------------------------------------

async function setActiveDeck(deckId) {
  const exists = state.decks.some((d) => d.id === deckId);
  if (!exists) {
    return { ok: false, error: 'Deck does not exist.' };
  }
  state.activeDeckId = deckId;
  await persist();
  return { ok: true };
}

async function createDeck(name) {
  if (!isNonEmptyString(name)) {
    return { ok: false, error: 'Deck name is required.' };
  }
  if (isAtDeckLimit()) {
    return { ok: false, error: `Maximum ${MAX_DECKS} Decks reached.` };
  }
  const deck = {
    id: makeId('deck'),
    name: name.trim().slice(0, 60),
    shortcuts: [],
    openPreferences: { ...DEFAULT_OPEN_PREFERENCES },
  };
  state.decks.push(deck);
  state.activeDeckId = deck.id;
  await persist();
  return { ok: true, deck: { ...deck, shortcuts: [], openPreferences: { ...deck.openPreferences } } };
}

async function renameDeck(deckId, name) {
  if (!isNonEmptyString(name)) {
    return { ok: false, error: 'Deck name is required.' };
  }
  const deck = state.decks.find((d) => d.id === deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  deck.name = name.trim().slice(0, 60);
  await persist();
  return { ok: true };
}

/**
 * STRICT: the user is actively changing this Deck's Open Preferences
 * right now, so (unlike normalizeOpenPreferences' REPAIR/backward-compat
 * leniency) an invalid destination/existingPolicy is rejected with a
 * clear error rather than silently defaulted.
 */
async function updateDeckOpenPreferences(deckId, prefs) {
  const deck = state.decks.find((d) => d.id === deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  if (!prefs || typeof prefs !== 'object') {
    return { ok: false, error: 'Open Preferences must be an object.' };
  }
  if (!OPEN_DESTINATIONS.includes(prefs.destination)) {
    return { ok: false, error: `destination must be one of: ${OPEN_DESTINATIONS.join(', ')}` };
  }
  if (!OPEN_EXISTING_POLICIES.includes(prefs.existingPolicy)) {
    return { ok: false, error: `existingPolicy must be one of: ${OPEN_EXISTING_POLICIES.join(', ')}` };
  }
  deck.openPreferences = { destination: prefs.destination, existingPolicy: prefs.existingPolicy };
  await persist();
  return { ok: true, openPreferences: { ...deck.openPreferences } };
}

async function deleteDeck(deckId) {
  const idx = state.decks.findIndex((d) => d.id === deckId);
  if (idx === -1) return { ok: false, error: 'Deck does not exist.' };

  state.decks.splice(idx, 1);

  if (state.decks.length === 0) {
    // Never allow zero Decks to exist.
    state.decks.push({
      id: makeId('deck'),
      name: DEFAULT_DECK_NAME,
      shortcuts: [],
      openPreferences: { ...DEFAULT_OPEN_PREFERENCES },
    });
  }

  if (state.activeDeckId === deckId || !state.decks.some((d) => d.id === state.activeDeckId)) {
    state.activeDeckId = state.decks[0].id;
  }

  await persist();
  return { ok: true, newActiveDeckId: state.activeDeckId };
}

// ---------------------------------------------------------------------------
// Shortcut mutations
// ---------------------------------------------------------------------------

function findDeckOrThrowSafe(deckId) {
  return state.decks.find((d) => d.id === deckId) || null;
}

async function addShortcut(deckId, shortcut) {
  const deck = findDeckOrThrowSafe(deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  const result = validateShortcutStrict(shortcut);
  if (!result.ok) return { ok: false, error: result.error };
  deck.shortcuts.push(result.shortcut);
  await persist();
  return { ok: true, shortcut: { ...result.shortcut } };
}

/**
 * Bulk-insert shortcuts into a Deck in one persisted operation. Used
 * by Phase 2 tab capture (popup) and Paste Links; the New Tab page's
 * single "Add Shortcut" modal still goes through addShortcut above
 * and is unaffected by any of this.
 *
 * Each item is validated strictly (valid http/https URL required).
 * Invalid items are excluded from the batch rather than failing the
 * whole call, since a bulk tab-capture add is expected to sometimes
 * include a handful of non-http tabs (e.g. chrome:// pages) alongside
 * many good ones.
 *
 * Duplicate policy (Phase 2): an item whose URL exactly matches a
 * shortcut already in the TARGET Deck is skipped rather than
 * inserted again - accidental exact-URL duplicates within one Deck
 * are avoided by default. This check is scoped to a single Deck on
 * purpose: the same URL may legitimately exist in other Decks, and
 * this function never looks at other Decks. Duplicates *within* the
 * submitted batch itself (e.g. two selected tabs pointing at the
 * same URL) are likewise collapsed to one insert.
 *
 * Returns counts rather than throwing/failing on partial issues, so
 * a caller (e.g. the popup) can report "N added, M already in Deck,
 * K skipped" - it only returns ok:false when nothing in the batch
 * was even a valid shortcut to begin with.
 */
async function addShortcuts(deckId, shortcuts) {
  const deck = findDeckOrThrowSafe(deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  if (!Array.isArray(shortcuts)) return { ok: false, error: 'shortcuts must be an array.' };

  const validated = shortcuts.map(validateShortcutStrict);
  const validCount = validated.reduce((n, r) => (r.ok ? n + 1 : n), 0);

  if (validCount === 0) {
    return { ok: false, error: 'No valid shortcuts to add.' };
  }

  const existingUrls = new Set(deck.shortcuts.map((s) => s.url));
  const toAdd = [];
  let duplicates = 0;

  for (const result of validated) {
    if (!result.ok) continue;
    if (existingUrls.has(result.shortcut.url)) {
      duplicates++;
      continue;
    }
    existingUrls.add(result.shortcut.url);
    toAdd.push(result.shortcut);
  }

  if (toAdd.length > 0) {
    deck.shortcuts.push(...toAdd);
    await persist();
  }

  return {
    ok: true,
    added: toAdd.length,
    duplicates,
    invalid: shortcuts.length - validCount,
  };
}

async function updateShortcut(deckId, shortcutId, changes) {
  const deck = findDeckOrThrowSafe(deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  const shortcut = deck.shortcuts.find((s) => s.id === shortcutId);
  if (!shortcut) return { ok: false, error: 'Shortcut does not exist.' };

  const merged = { ...shortcut, ...changes, id: shortcut.id };
  const result = validateShortcutStrict(merged);
  if (!result.ok) return { ok: false, error: result.error };

  Object.assign(shortcut, result.shortcut);
  await persist();
  return { ok: true, shortcut: { ...shortcut } };
}

async function deleteShortcut(deckId, shortcutId) {
  const deck = findDeckOrThrowSafe(deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  const idx = deck.shortcuts.findIndex((s) => s.id === shortcutId);
  if (idx === -1) return { ok: false, error: 'Shortcut does not exist.' };
  deck.shortcuts.splice(idx, 1);
  await persist();
  return { ok: true };
}

async function reorderShortcuts(deckId, orderedShortcutIds) {
  const deck = findDeckOrThrowSafe(deckId);
  if (!deck) return { ok: false, error: 'Deck does not exist.' };
  if (!Array.isArray(orderedShortcutIds)) return { ok: false, error: 'Invalid order.' };

  const byId = new Map(deck.shortcuts.map((s) => [s.id, s]));
  const reordered = orderedShortcutIds.map((id) => byId.get(id)).filter(Boolean);

  // Safety: if the id list doesn't cleanly match current shortcuts
  // (stale ids, missing ids), refuse rather than silently dropping data.
  if (reordered.length !== deck.shortcuts.length) {
    return { ok: false, error: 'Order does not match current shortcuts.' };
  }

  deck.shortcuts = reordered;
  await persist();
  return { ok: true };
}

/**
 * Phase 3: reorder the Decks themselves (the Deck tab bar). Mirrors
 * reorderShortcuts above - array order in state.decks[] IS the
 * persisted Deck order, there is no separate displayOrder field.
 * Deck IDs, and therefore activeDeckId, are never touched here, so
 * reordering can never change which Deck is active.
 */
async function reorderDecks(orderedDeckIds) {
  if (!Array.isArray(orderedDeckIds)) return { ok: false, error: 'Invalid order.' };

  const byId = new Map(state.decks.map((d) => [d.id, d]));
  const reordered = orderedDeckIds.map((id) => byId.get(id)).filter(Boolean);

  // Safety: if the id list doesn't cleanly match current Decks
  // (stale ids, missing ids), refuse rather than silently dropping data.
  if (reordered.length !== state.decks.length) {
    return { ok: false, error: 'Order does not match current Decks.' };
  }

  state.decks = reordered;
  await persist();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

function exportData() {
  return JSON.stringify(getState(), null, 2);
}

/**
 * Validate + import a Deck JSON blob (as produced by exportData()).
 *
 * IMPORT-STRICT policy: every Deck and every shortcut must already
 * have a valid non-empty "id" (never auto-generated here), and
 * "activeDeckId" must be present and match one of the imported Decks.
 * The first invalid record, or an invalid/missing activeDeckId,
 * aborts the whole import with a specific error - nothing is
 * partially imported, and current state is left completely untouched
 * on any failure.
 */
async function importData(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Import file must contain a JSON object.' };
  }
  if (!Array.isArray(parsed.decks)) {
    return { ok: false, error: 'Import file is missing a "decks" array.' };
  }
  if (parsed.decks.length === 0) {
    return { ok: false, error: 'Import file contains no Decks.' };
  }
  if (parsed.decks.length > MAX_DECKS) {
    return {
      ok: false,
      error: `Import contains ${parsed.decks.length} Decks, which exceeds the maximum of ${MAX_DECKS}.`,
    };
  }
  if (!isNonEmptyString(parsed.activeDeckId)) {
    return { ok: false, error: 'Import file is missing a valid non-empty "activeDeckId".' };
  }

  const decks = [];
  const ids = new Set();
  for (let i = 0; i < parsed.decks.length; i++) {
    const result = validateDeckForImport(parsed.decks[i]);
    if (!result.ok) {
      return { ok: false, error: `Deck at position ${i + 1}: ${result.error}` };
    }
    if (ids.has(result.deck.id)) {
      return { ok: false, error: `Import file contains duplicate Deck ID "${result.deck.id}".` };
    }
    ids.add(result.deck.id);
    decks.push(result.deck);
  }

  const activeDeckId = parsed.activeDeckId.trim();
  if (!ids.has(activeDeckId)) {
    return {
      ok: false,
      error: `Import file's "activeDeckId" ("${activeDeckId}") does not match any imported Deck.`,
    };
  }

  state = {
    schemaVersion: SCHEMA_VERSION,
    activeDeckId,
    decks,
  };

  await persist();
  return { ok: true, deckCount: decks.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

window.DeckStore = {
  MAX_DECKS,
  init,
  onChange,
  getState,
  getDecks,
  getDeckById,
  getActiveDeckId,
  getActiveDeck,
  isAtDeckLimit,
  setActiveDeck,
  createDeck,
  renameDeck,
  deleteDeck,
  reorderDecks,
  updateDeckOpenPreferences,
  OPEN_DESTINATIONS,
  OPEN_EXISTING_POLICIES,
  DEFAULT_OPEN_PREFERENCES,
  addShortcut,
  addShortcuts,
  updateShortcut,
  deleteShortcut,
  reorderShortcuts,
  exportData,
  importData,
  // Phase 3: the single normalization rule for "same URL", shared with
  // Find Deck / Open Missing (js/browser-state.js) so they can never
  // disagree with DeckStore's own duplicate-checking about what counts
  // as the same URL. Returns the normalized href, or null if `raw`
  // isn't an absolute http(s) URL - same contract as internal use.
  normalizeUrl: parseHttpUrl,
};
