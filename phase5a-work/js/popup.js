// popup.js
//
// UI wiring for the extension toolbar popup ONLY. Every read or write
// of Deck/shortcut data goes through window.DeckStore - the same
// module app.js uses on the New Tab page. This file never talks to
// chrome.storage directly and never maintains its own copy of "which
// Deck is active"; it always asks DeckStore.

(function () {
  'use strict';

  const captureModesEl = document.getElementById('capture-modes');
  const curatedToolbarEl = document.getElementById('curated-toolbar');
  const tabListEl = document.getElementById('tab-list');
  const tabPreviewEl = document.getElementById('tab-preview');
  const windowSummaryEl = document.getElementById('window-summary');
  const selectAllBtn = document.getElementById('select-all-btn');
  const selectNoneBtn = document.getElementById('select-none-btn');
  const selectedCountEl = document.getElementById('selected-count');
  const addCountEl = document.getElementById('add-count');
  const deckSelect = document.getElementById('deck-select');
  const addBtn = document.getElementById('add-btn');
  const messageEl = document.getElementById('popup-message');
  const saveWindowBtn = document.getElementById('save-window-btn');

  const pasteTextarea = document.getElementById('paste-textarea');
  const pasteDeckSelect = document.getElementById('paste-deck-select');
  const pasteAddBtn = document.getElementById('paste-add-btn');

  const exportModesEl = document.getElementById('export-modes');
  const exportTabsBtn = document.getElementById('export-tabs-btn');

  // "Save Current Window as New Deck" naming prompt - a small local
  // modal shell, separate from the New Tab page's modal (different
  // document entirely), reusing the same .modal-overlay/.modal CSS.
  const modalOverlay = document.getElementById('popup-modal-overlay');
  const modalInput = document.getElementById('popup-modal-input');
  const modalError = document.getElementById('popup-modal-error');
  const modalCancel = document.getElementById('popup-modal-cancel');
  const modalConfirm = document.getElementById('popup-modal-confirm');

  const CAPTURE_MODES = ['tab', 'window', 'curated'];
  const DEFAULT_CAPTURE_MODE = 'tab';

  let tabs = [];               // TabCapture shape, current window only (WINDOW + CURATED)
  let activeTab = null;        // TabCapture shape, single active tab (TAB mode), or null
  let selectedIds = new Set(); // chrome tab ids currently checked (CURATED only)
  let mode = DEFAULT_CAPTURE_MODE;

  // -------------------------------------------------------------------
  // Message banner
  // -------------------------------------------------------------------

  function showMessage(text, isError) {
    messageEl.textContent = text;
    messageEl.hidden = false;
    messageEl.classList.toggle('popup__message--error', !!isError);
  }

  function clearMessage() {
    messageEl.hidden = true;
    messageEl.textContent = '';
    messageEl.classList.remove('popup__message--error');
  }

  // -------------------------------------------------------------------
  // Deck destination dropdowns
  //
  // Both selects are populated identically and default to
  // DeckStore.getActiveDeckId() - the popup never invents a separate
  // "last used in popup" Deck preference; DeckStore's activeDeckId
  // stays the single source of truth. Picking a different Deck here
  // only targets THIS add operation - it does not change the New Tab
  // page's active Deck (that would be surprising: the person opened
  // the popup to file tabs into some Deck, not to switch what they're
  // looking at on their New Tab page).
  // -------------------------------------------------------------------

  function populateDeckSelect(selectEl) {
    const decks = window.DeckStore.getDecks();
    const activeId = window.DeckStore.getActiveDeckId();
    const previousValue = selectEl.value;
    selectEl.innerHTML = '';
    for (const deck of decks) {
      const opt = document.createElement('option');
      opt.value = deck.id;
      opt.textContent = deck.name;
      selectEl.appendChild(opt);
    }
    // Keep whatever the user had picked if it still exists (e.g. after
    // a bulk add refreshes the list); otherwise fall back to the
    // active Deck, per the default rule above.
    const stillExists = decks.some((d) => d.id === previousValue);
    selectEl.value = stillExists ? previousValue : activeId;
  }

  function refreshDeckSelects() {
    populateDeckSelect(deckSelect);
    populateDeckSelect(pasteDeckSelect);
  }

  // -------------------------------------------------------------------
  // Capture modes (TAB / WINDOW / CURATED)
  //
  // All three modes share the same underlying data (`tabs` = current
  // window tabs, `activeTab` = the single active tab) and the same
  // destination Deck + Add button. They only differ in what subset of
  // tabs gets built into the DeckStore.addShortcuts() batch - see
  // currentModeItems(). lastCaptureMode is a separate, popup-only
  // preference (see storage.js) and is never confused with
  // DeckStore's activeDeckId.
  // -------------------------------------------------------------------

  function renderModeButtons() {
    for (const btn of captureModesEl.querySelectorAll('.popup__mode-btn')) {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    }
  }

  function setMode(newMode) {
    if (!CAPTURE_MODES.includes(newMode)) return;
    mode = newMode;
    if (mode === 'curated') {
      // Per spec: CURATED always starts as "everything except what I
      // remove" - reset to all-eligible-selected every time the user
      // switches into it, not just on the very first popup open.
      selectedIds = new Set(tabs.filter((t) => t.supported).map((t) => t.id));
    }
    renderModeButtons();
    renderForMode();
    window.DeckStorage.saveLastCaptureMode(mode).catch(() => {});
  }

  captureModesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup__mode-btn');
    if (!btn) return;
    clearMessage();
    setMode(btn.dataset.mode);
  });

  function renderForMode() {
    const isTab = mode === 'tab';
    const isWindow = mode === 'window';
    const isCurated = mode === 'curated';

    curatedToolbarEl.hidden = !isCurated;
    tabListEl.hidden = !isCurated;
    tabPreviewEl.hidden = !isTab;
    windowSummaryEl.hidden = !isWindow;

    if (isCurated) renderTabList();
    if (isTab) renderTabPreview();
    if (isWindow) renderWindowSummary();

    refreshAddButton();
  }

  /** Builds the exact items DeckStore.addShortcuts() will receive, for whichever mode is active. */
  function currentModeItems() {
    if (mode === 'tab') {
      if (activeTab && activeTab.supported) {
        return [{ name: activeTab.title, url: activeTab.url }];
      }
      return [];
    }
    if (mode === 'window') {
      return tabs.filter((t) => t.supported).map((t) => ({ name: t.title, url: t.url }));
    }
    // curated
    return tabs
      .filter((t) => t.supported && selectedIds.has(t.id))
      .map((t) => ({ name: t.title, url: t.url }));
  }

  /** Keeps "Add N to" / the Add button's enabled state in sync with the active mode. */
  function refreshAddButton() {
    let count;
    if (mode === 'tab') {
      count = activeTab && activeTab.supported ? 1 : 0;
    } else if (mode === 'window') {
      count = tabs.filter((t) => t.supported).length;
    } else {
      count = selectedIds.size;
      selectedCountEl.textContent = `${count} selected`;
    }
    addCountEl.textContent = String(count);
    addBtn.disabled = count === 0;
  }

  // -------------------------------------------------------------------
  // TAB mode - single active-tab preview (read-only, no checkbox)
  // -------------------------------------------------------------------

  function renderTabPreview() {
    tabPreviewEl.innerHTML = '';

    if (!activeTab) {
      const empty = document.createElement('div');
      empty.className = 'tab-list__empty';
      empty.textContent = 'No active tab found.';
      tabPreviewEl.appendChild(empty);
      return;
    }

    const row = document.createElement('div');
    row.className = 'tab-row tab-row--readonly' + (activeTab.supported ? '' : ' tab-row--unsupported');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tab-row__icon';
    if (activeTab.favIconUrl) {
      const img = document.createElement('img');
      img.src = activeTab.favIconUrl;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      iconWrap.appendChild(img);
    }

    const textWrap = document.createElement('span');
    textWrap.className = 'tab-row__text';

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-row__title';
    titleEl.textContent = activeTab.title;
    textWrap.appendChild(titleEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'tab-row__meta';
    metaEl.textContent = activeTab.supported
      ? activeTab.domain
      : 'This tab type can\u2019t be saved as a Deck shortcut.';
    textWrap.appendChild(metaEl);

    row.appendChild(iconWrap);
    row.appendChild(textWrap);
    tabPreviewEl.appendChild(row);
  }

  // -------------------------------------------------------------------
  // WINDOW mode - eligible-tab count only, no per-tab selection
  // -------------------------------------------------------------------

  function renderWindowSummary() {
    const eligible = tabs.filter((t) => t.supported).length;
    windowSummaryEl.textContent =
      eligible === 0
        ? 'No eligible tabs in this window.'
        : `${eligible} eligible tab${eligible === 1 ? '' : 's'}`;
  }

  // -------------------------------------------------------------------
  // CURATED mode - granular checkbox list (Phase 2's original selector)
  // -------------------------------------------------------------------

  function renderTabList() {
    tabListEl.innerHTML = '';

    if (tabs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tab-list__empty';
      empty.textContent = 'No tabs found in this window.';
      tabListEl.appendChild(empty);
      return;
    }

    for (const tab of tabs) {
      const row = document.createElement('label');
      row.className = 'tab-row' + (tab.supported ? '' : ' tab-row--unsupported');
      row.setAttribute('role', 'listitem');
      if (!tab.supported) {
        row.title = 'This tab type can\u2019t be saved as a Deck shortcut.';
      }

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tab-row__checkbox';
      checkbox.checked = selectedIds.has(tab.id);
      checkbox.disabled = !tab.supported;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(tab.id);
        else selectedIds.delete(tab.id);
        refreshAddButton();
      });

      const iconWrap = document.createElement('span');
      iconWrap.className = 'tab-row__icon';
      if (tab.favIconUrl) {
        const img = document.createElement('img');
        img.src = tab.favIconUrl;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        iconWrap.appendChild(img);
      }

      const textWrap = document.createElement('span');
      textWrap.className = 'tab-row__text';

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-row__title';
      titleEl.textContent = tab.title;
      textWrap.appendChild(titleEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'tab-row__meta';
      metaEl.textContent = tab.supported ? tab.domain : 'Unsupported tab';
      textWrap.appendChild(metaEl);

      row.appendChild(checkbox);
      row.appendChild(iconWrap);
      row.appendChild(textWrap);
      tabListEl.appendChild(row);
    }
  }

  async function loadTabs() {
    const [windowTabs, active] = await Promise.all([
      window.TabCapture.getCurrentWindowTabs(),
      window.TabCapture.getActiveTab(),
    ]);
    tabs = windowTabs;
    activeTab = active;
  }

  selectAllBtn.addEventListener('click', () => {
    selectedIds = new Set(tabs.filter((t) => t.supported).map((t) => t.id));
    renderTabList();
    refreshAddButton();
  });

  selectNoneBtn.addEventListener('click', () => {
    selectedIds = new Set();
    renderTabList();
    refreshAddButton();
  });

  // -------------------------------------------------------------------
  // Add selected tabs to a Deck - one bulk DeckStore call.
  // -------------------------------------------------------------------

  function describeBulkResult(result, deckName) {
    if (!result.ok) return result.error;
    const parts = [`${result.added} added`];
    if (result.duplicates) parts.push(`${result.duplicates} already in ${deckName}`);
    if (result.invalid) parts.push(`${result.invalid} skipped`);
    return parts.join(', ');
  }

  addBtn.addEventListener('click', async () => {
    clearMessage();
    const deckId = deckSelect.value;
    const deck = window.DeckStore.getDeckById(deckId);
    if (!deck) {
      showMessage('Pick a Deck to add to.', true);
      return;
    }

    const items = currentModeItems();

    if (items.length === 0) {
      showMessage(
        mode === 'tab' ? 'The active tab can\u2019t be captured.' : 'Select at least one tab.',
        true
      );
      return;
    }

    addBtn.disabled = true;
    const result = await window.DeckStore.addShortcuts(deckId, items);
    showMessage(describeBulkResult(result, deck.name), !result.ok);

    if (result.ok) {
      // Captured tabs stay open (this is capture, not tab removal).
      if (mode === 'curated') {
        // Clear the selection so a repeat click on "Add" can't
        // silently re-add the same tabs a second time. TAB/WINDOW
        // have nothing to "clear" - re-clicking Add just re-submits
        // the same tab(s), which addShortcuts reports as duplicates.
        selectedIds = new Set();
        renderTabList();
      }
      refreshDeckSelects();
    }
    refreshAddButton();
  });

  // -------------------------------------------------------------------
  // Save Current Window as New Deck
  // -------------------------------------------------------------------

  function openSaveWindowModal() {
    if (window.DeckStore.isAtDeckLimit()) {
      showMessage(`Maximum ${window.DeckStore.MAX_DECKS} Decks reached.`, true);
      return;
    }
    modalInput.value = '';
    modalError.textContent = '';
    modalOverlay.hidden = false;
    modalInput.focus();
  }

  function closePopupModal() {
    modalOverlay.hidden = true;
  }

  modalCancel.addEventListener('click', closePopupModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closePopupModal();
  });
  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalConfirm.click();
    if (e.key === 'Escape') closePopupModal();
  });

  modalConfirm.addEventListener('click', async () => {
    // createDeck() itself re-checks the 10-Deck limit atomically, so
    // this stays safe even if Decks changed since the button opened.
    const createResult = await window.DeckStore.createDeck(modalInput.value);
    if (!createResult.ok) {
      modalError.textContent = createResult.error;
      return;
    }

    const items = tabs
      .filter((t) => t.supported)
      .map((t) => ({ name: t.title, url: t.url }));

    let addResult = { ok: true, added: 0, duplicates: 0, invalid: 0 };
    if (items.length > 0) {
      addResult = await window.DeckStore.addShortcuts(createResult.deck.id, items);
    }

    closePopupModal();
    refreshDeckSelects();

    if (addResult.ok) {
      showMessage(
        `Created "${createResult.deck.name}" with ${addResult.added} shortcut${addResult.added === 1 ? '' : 's'}.`,
        false
      );
    } else {
      showMessage(`Created "${createResult.deck.name}", but couldn't add tabs: ${addResult.error}`, true);
    }
  });

  saveWindowBtn.addEventListener('click', openSaveWindowModal);

  // -------------------------------------------------------------------
  // Paste Links
  //
  // Plain textarea, no clipboard permission requested (see manifest
  // notes) - the user pastes manually. Same DeckStore bulk-add path
  // as tab capture; nothing here writes to storage directly.
  // -------------------------------------------------------------------

  function parsePastedLines(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  pasteAddBtn.addEventListener('click', async () => {
    clearMessage();
    const lines = parsePastedLines(pasteTextarea.value);
    const validUrls = lines.filter((line) => window.TabCapture.isSupportedTabUrl(line));

    if (validUrls.length === 0) {
      showMessage('No valid http(s) links found.', true);
      return;
    }

    const deckId = pasteDeckSelect.value;
    const deck = window.DeckStore.getDeckById(deckId);
    if (!deck) {
      showMessage('Pick a Deck to add to.', true);
      return;
    }

    const items = validUrls.map((url) => ({ name: url, url }));
    const result = await window.DeckStore.addShortcuts(deckId, items);

    const invalidLineCount = lines.length - validUrls.length;
    if (!result.ok) {
      showMessage(result.error, true);
      return;
    }

    const parts = [`${result.added} added`];
    if (result.duplicates) parts.push(`${result.duplicates} already in ${deck.name}`);
    if (invalidLineCount) {
      parts.push(`${invalidLineCount} invalid line${invalidLineCount === 1 ? '' : 's'} skipped`);
    }
    showMessage(parts.join(', '), false);
    pasteTextarea.value = '';
    refreshDeckSelects();
  });

  // -------------------------------------------------------------------
  // Phase 4: Export Tabs to .txt
  //
  // Read-only - never touches/closes a tab. Reuses the same
  // TabCapture module Phase 2 capture uses; the only new surface is
  // TabCapture.getExportUrls(scope). Downloaded via a plain Blob +
  // <a download> from this extension page - no "downloads" permission
  // needed (see manifest notes in the Phase 4 deliverable doc).
  // -------------------------------------------------------------------

  const EXPORT_SCOPES = ['tab', 'window', 'all'];
  let exportScope = 'window';

  function renderExportModeButtons() {
    for (const btn of exportModesEl.querySelectorAll('.popup__mode-btn')) {
      btn.classList.toggle('is-active', btn.dataset.scope === exportScope);
    }
  }

  exportModesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup__mode-btn');
    if (!btn || !EXPORT_SCOPES.includes(btn.dataset.scope)) return;
    exportScope = btn.dataset.scope;
    renderExportModeButtons();
  });

  renderExportModeButtons();

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function exportFilename() {
    const d = new Date();
    return `deck-tabs-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.txt`;
  }

  exportTabsBtn.addEventListener('click', async () => {
    clearMessage();
    exportTabsBtn.disabled = true;
    try {
      const urls = await window.TabCapture.getExportUrls(exportScope);
      if (urls.length === 0) {
        showMessage('No eligible tabs to export.', true);
        return;
      }

      // One URL per line, no JSON/metadata/tab or window IDs - directly
      // pasteable into Paste Links (see PART 3 - OUTPUT FORMAT).
      const text = urls.join('\n') + '\n';
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showMessage(`Exported ${urls.length} URL${urls.length === 1 ? '' : 's'}.`, false);
    } catch (err) {
      console.error('[popup] export failed', err);
      showMessage('Export failed.', true);
    } finally {
      exportTabsBtn.disabled = false;
    }
  });

  // -------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------

  window.DeckStore.init()
    .then(async () => {
      refreshDeckSelects();
      await loadTabs();
      const storedMode = await window.DeckStorage.loadLastCaptureMode();
      // setMode() both applies the restored (or default) mode and
      // renders it - this is also where CURATED's "all eligible
      // selected by default" gets applied on a fresh popup open.
      setMode(CAPTURE_MODES.includes(storedMode) ? storedMode : DEFAULT_CAPTURE_MODE);
    })
    .catch((err) => {
      console.error('[popup] failed to initialize', err);
      showMessage('Something went wrong loading your Decks.', true);
    });
})();
