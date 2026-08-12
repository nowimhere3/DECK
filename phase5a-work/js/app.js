// app.js
//
// UI rendering + event wiring ONLY. Every read or write of Deck /
// shortcut data goes through window.DeckStore. This file never
// touches chrome.storage directly and never reaches into a Deck
// object it didn't get back from DeckStore.

(function () {
  'use strict';

  const deckTabsEl = document.getElementById('deck-tabs');
  const deckLimitNoteEl = document.getElementById('deck-limit-note');
  const shortcutsGridEl = document.getElementById('shortcuts-grid');
  const addShortcutBtn = document.getElementById('add-shortcut-btn');
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const importFileInput = document.getElementById('import-file-input');
  const toastEl = document.getElementById('toast');

  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalCancel = document.getElementById('modal-cancel');
  const modalConfirm = document.getElementById('modal-confirm');
  const modalDanger = document.getElementById('modal-danger');

  let openDeckMenuId = null; // which Deck's management popover is open, if any
  let repositionDeckMenu = null; // reposition fn for the open menu, or null
  let toastTimer = null;

  // -------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
  }

  // -------------------------------------------------------------------
  // Generic modal
  //
  // A single reusable dialog shell drives: Add Deck, Rename Deck,
  // Delete Deck confirm, Add Shortcut, Edit Shortcut. `body` is a DOM
  // node built by the caller; `onConfirm` runs when the confirm
  // button is pressed and may return an error string to keep the
  // modal open with a message, or nothing/null to close it.
  // -------------------------------------------------------------------

  let activeModal = null;

  function closeModal() {
    modalOverlay.hidden = true;
    modalBody.innerHTML = '';
    activeModal = null;
  }

  function openModal({ title, bodyNode, confirmLabel, onConfirm, dangerLabel, onDanger, focusEl, cancelLabel }) {
    modalTitle.textContent = title;
    modalBody.innerHTML = '';
    modalBody.appendChild(bodyNode);

    modalCancel.textContent = cancelLabel || 'Cancel';

    if (confirmLabel) {
      modalConfirm.hidden = false;
      modalConfirm.textContent = confirmLabel;
    } else {
      modalConfirm.hidden = true;
    }

    if (dangerLabel) {
      modalDanger.hidden = false;
      modalDanger.textContent = dangerLabel;
    } else {
      modalDanger.hidden = true;
    }

    activeModal = { onConfirm, onDanger };
    modalOverlay.hidden = false;
    (focusEl || (confirmLabel ? modalConfirm : modalCancel)).focus();
  }

  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modalOverlay.hidden) closeModal();
      closeDeckMenu();
    }
  });

  modalConfirm.addEventListener('click', async () => {
    if (!activeModal || !activeModal.onConfirm) return;
    const result = await activeModal.onConfirm();
    if (!result) closeModal();
  });

  modalDanger.addEventListener('click', async () => {
    if (!activeModal || !activeModal.onDanger) return;
    const result = await activeModal.onDanger();
    if (!result) closeModal();
  });

  function fieldRow(labelText, inputEl, errorId) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(inputEl);
    if (errorId) {
      const err = document.createElement('div');
      err.className = 'modal__error';
      err.id = errorId;
      label.appendChild(err);
    }
    return label;
  }

  function setError(id, message) {
    const el = document.getElementById(id);
    if (el) el.textContent = message || '';
  }

  // -------------------------------------------------------------------
  // Deck tabs
  // -------------------------------------------------------------------

  function closeDeckMenu() {
    openDeckMenuId = null;
    const existing = document.querySelector('.deck-menu');
    if (existing) existing.remove();
    if (repositionDeckMenu) {
      window.removeEventListener('resize', repositionDeckMenu);
      window.removeEventListener('scroll', repositionDeckMenu, true);
      repositionDeckMenu = null;
    }
  }

  // Deck drag-and-drop reordering. Both presentations (expanded
  // .deck-group, collapsed .deck-tab--collapsed) mark their top-level
  // reorderable element with the shared .deck-unit class + a
  // data-deck-id, so this one set of handlers drives reordering
  // regardless of which presentation is currently rendered.
  let draggedDeckId = null;

  function clearDeckDragOverMarkers() {
    deckTabsEl
      .querySelectorAll('.deck-unit--drag-before, .deck-unit--drag-after')
      .forEach((el) => el.classList.remove('deck-unit--drag-before', 'deck-unit--drag-after'));
  }

  deckTabsEl.addEventListener('dragover', (e) => {
    if (!draggedDeckId) return;
    const target = e.target.closest('.deck-unit');
    if (!target || target.dataset.deckId === draggedDeckId) {
      clearDeckDragOverMarkers();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = target.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    clearDeckDragOverMarkers();
    target.classList.add(before ? 'deck-unit--drag-before' : 'deck-unit--drag-after');
  });

  deckTabsEl.addEventListener('drop', async (e) => {
    if (!draggedDeckId) return;
    const target = e.target.closest('.deck-unit');
    clearDeckDragOverMarkers();
    if (!target || target.dataset.deckId === draggedDeckId) return;
    e.preventDefault();

    const ids = window.DeckStore.getDecks().map((d) => d.id);
    const fromIdx = ids.indexOf(draggedDeckId);
    const targetId = target.dataset.deckId;
    if (fromIdx === -1) return;
    ids.splice(fromIdx, 1);

    const rect = target.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    let toIdx = ids.indexOf(targetId);
    if (toIdx === -1) return;
    if (!before) toIdx += 1;
    ids.splice(toIdx, 0, draggedDeckId);

    await window.DeckStore.reorderDecks(ids);
  });

  deckTabsEl.addEventListener('dragend', () => {
    draggedDeckId = null;
    clearDeckDragOverMarkers();
    const dragging = deckTabsEl.querySelector('.deck-unit.is-dragging');
    if (dragging) dragging.classList.remove('is-dragging');
  });

  // -------------------------------------------------------------------
  // Phase 5: Deck shelf presentation (expanded / collapsed / auto)
  //
  // `shelfModePref` is the user's saved choice - 'auto' | 'expanded' |
  // 'collapsed' - loaded once at startup (see the bootstrap IIFE near
  // the bottom of this file) and persisted via DeckStorage whenever
  // the user changes it. It is UI presentation state, not Deck data,
  // so it never touches DeckStore.
  //
  // 'auto': render EXPANDED (the two-level tab + reflective tray from
  // Phase 4) first, measure whether the Deck row actually wrapped onto
  // more than one line, and if it did, re-render COLLAPSED instead
  // (Phase 3-style single tab + chevron dropdown). One clean expanded
  // row is the ideal state; two rows of expanded trays is the thing
  // being avoided.
  // -------------------------------------------------------------------

  let shelfModePref = 'auto';
  let lastRenderedState = null;
  const shelfModeBtn = document.getElementById('shelf-mode-btn');

  function shelfModeLabel() {
    if (shelfModePref === 'expanded') return 'Deck Controls: Expanded';
    if (shelfModePref === 'collapsed') return 'Deck Controls: Collapsed';
    return 'Deck Controls: Auto';
  }

  function updateShelfModeButton() {
    if (shelfModeBtn) shelfModeBtn.textContent = shelfModeLabel();
  }

  if (shelfModeBtn) {
    shelfModeBtn.addEventListener('click', async () => {
      const order = ['auto', 'expanded', 'collapsed'];
      shelfModePref = order[(order.indexOf(shelfModePref) + 1) % order.length];
      updateShelfModeButton();
      await window.DeckStorage.saveShelfMode(shelfModePref);
      if (lastRenderedState) renderDeckTabs(lastRenderedState);
    });
  }

  /**
   * True if the current contents of deckTabsEl (deck units only - the
   * `+ Add Deck` button is appended separately, after this check, and
   * deliberately doesn't count: a lone Add Deck button wrapping alone
   * isn't "two rows of Decks") span more than one visual row.
   */
  function deckUnitsWrap() {
    const units = deckTabsEl.querySelectorAll('.deck-unit');
    if (units.length === 0) return false;
    const firstTop = units[0].getBoundingClientRect().top;
    for (const el of units) {
      if (Math.abs(el.getBoundingClientRect().top - firstTop) > 2) return true;
    }
    return false;
  }

  function appendAddDeckButton() {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'deck-tab-add';
    const atLimit = window.DeckStore.isAtDeckLimit();
    addBtn.disabled = atLimit;
    addBtn.title = atLimit ? `Maximum ${window.DeckStore.MAX_DECKS} Decks` : 'Add Deck';
    addBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg> Add Deck';
    addBtn.addEventListener('click', openAddDeckModal);
    deckTabsEl.appendChild(addBtn);

    deckLimitNoteEl.hidden = !atLimit;
  }

  /**
   * Phase 4/5: each real Deck renders as ONE "two-level Deck control"
   * (see PART 1 of the Phase 4 spec) - an upper trapezoid label plus a
   * smaller "reflection below the waterline" action tray directly
   * beneath it, wrapped together in a single .deck-group (also tagged
   * .deck-unit for shared drag/drop - see above) so they always move
   * together on reorder and both share one deckId hit target. Only the
   * upper label switches/drags the Deck; the tray's Find/Open/Gear
   * buttons stopPropagation so they can never bubble up into the
   * label's click/drag handling.
   */
  function buildExpandedDeckTabs(state) {
    deckTabsEl.innerHTML = '';
    deckTabsEl.classList.add('deck-tabs--expanded');
    deckTabsEl.classList.remove('deck-tabs--collapsed');

    for (const deck of state.decks) {
      const isActive = deck.id === state.activeDeckId;

      const group = document.createElement('div');
      group.className = 'deck-group deck-unit' + (isActive ? ' is-active' : '');
      group.dataset.deckId = deck.id;

      // ---- Upper Deck tab: identity + activate + drag reorder ----
      const tab = document.createElement('div');
      tab.className = 'deck-tab' + (isActive ? ' is-active' : '');
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.title = deck.name;
      tab.draggable = true;

      const label = document.createElement('span');
      label.className = 'deck-tab__label';
      label.textContent = deck.name;
      tab.appendChild(label);

      // WHAT: expanded Decks expose a tab-style close shortcut on the
      // upper surface. WHY: deletion is quicker without hiding the common
      // action in Gear. FUTURE / DO-NOT-BREAK: this must keep calling the
      // shared confirmation flow, and pointer/key events must never bubble
      // into Deck activation or drag handling. Collapsed mode intentionally
      // has no close button; Delete remains in its dropdown.
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'deck-tab__close-btn';
      closeBtn.setAttribute('aria-label', `Delete ${deck.name}`);
      closeBtn.textContent = '\u00d7';
      closeBtn.draggable = false;
      closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      closeBtn.addEventListener('dragstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      closeBtn.addEventListener('keydown', (e) => e.stopPropagation());
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDeleteDeckModal(deck);
      });
      tab.appendChild(closeBtn);

      tab.addEventListener('dragstart', (e) => {
        draggedDeckId = deck.id;
        group.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', deck.id);
      });

      tab.addEventListener('click', async () => {
        closeDeckMenu();
        if (deck.id !== state.activeDeckId) {
          await window.DeckStore.setActiveDeck(deck.id);
        }
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          tab.click();
        }
      });

      group.appendChild(tab);

      // ---- Lower reflective action tray: Find / Open / Gear ----
      const tray = document.createElement('div');
      tray.className = 'deck-tab-tray' + (isActive ? ' is-active' : '');
      tray.setAttribute('role', 'group');
      tray.setAttribute('aria-label', `${deck.name} actions`);

      const findBtn = document.createElement('button');
      findBtn.type = 'button';
      findBtn.className = 'deck-tab-tray__btn';
      findBtn.setAttribute('aria-label', `Find ${deck.name}`);
      findBtn.innerHTML =
        '<span class="deck-tab-tray__icon" aria-hidden="true">\uD83D\uDD0D</span><span>Find</span>';
      findBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFindDeckModal(deck);
      });

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'deck-tab-tray__btn';
      openBtn.setAttribute('aria-label', `Open ${deck.name}`);
      openBtn.innerHTML =
        '<span class="deck-tab-tray__icon" aria-hidden="true">\uD83D\uDCC1</span><span>Open</span>';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        performOpenDeck(deck);
      });

      const gearBtn = document.createElement('button');
      gearBtn.type = 'button';
      gearBtn.className = 'deck-tab-tray__btn deck-tab-tray__btn--icon-only';
      gearBtn.setAttribute('aria-label', `Deck settings for ${deck.name}`);
      gearBtn.innerHTML = '<span class="deck-tab-tray__icon" aria-hidden="true">\u2699</span>';
      gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Find/Open already have dedicated tray buttons in expanded
        // presentation, so the gear menu only needs the rest.
        toggleDeckMenu(deck, gearBtn, { includeFindOpen: false });
      });

      tray.appendChild(findBtn);
      tray.appendChild(openBtn);
      tray.appendChild(gearBtn);
      group.appendChild(tray);

      deckTabsEl.appendChild(group);
    }
  }

  /**
   * Phase 5 - collapsed presentation: back to a Phase-3-style single
   * tab (Deck name + dropdown chevron), used automatically once the
   * expanded presentation would wrap to a second row, or whenever the
   * user explicitly picks "Collapsed". No Deck action becomes
   * unreachable: the chevron's dropdown carries Find/Open in addition
   * to the Rename/Open Preferences/Delete it always had.
   */
  function buildCollapsedDeckTabs(state) {
    deckTabsEl.innerHTML = '';
    deckTabsEl.classList.add('deck-tabs--collapsed');
    deckTabsEl.classList.remove('deck-tabs--expanded');

    for (const deck of state.decks) {
      const isActive = deck.id === state.activeDeckId;

      const tab = document.createElement('div');
      tab.className = 'deck-tab deck-tab--collapsed deck-unit' + (isActive ? ' is-active' : '');
      tab.dataset.deckId = deck.id;
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.title = deck.name;
      tab.draggable = true;

      const label = document.createElement('span');
      label.className = 'deck-tab__label';
      label.textContent = deck.name;
      tab.appendChild(label);

      const chevronBtn = document.createElement('button');
      chevronBtn.type = 'button';
      chevronBtn.className = 'deck-tab__chevron-btn';
      chevronBtn.setAttribute('aria-label', `Deck actions for ${deck.name}`);
      chevronBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      chevronBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDeckMenu(deck, chevronBtn, { includeFindOpen: true });
      });
      tab.appendChild(chevronBtn);

      tab.addEventListener('dragstart', (e) => {
        draggedDeckId = deck.id;
        tab.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', deck.id);
      });

      tab.addEventListener('click', async () => {
        closeDeckMenu();
        if (deck.id !== state.activeDeckId) {
          await window.DeckStore.setActiveDeck(deck.id);
        }
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          tab.click();
        }
      });

      deckTabsEl.appendChild(tab);
    }
  }

  function renderDeckTabs(state) {
    if (shelfModePref === 'expanded') {
      buildExpandedDeckTabs(state);
    } else if (shelfModePref === 'collapsed') {
      buildCollapsedDeckTabs(state);
    } else {
      buildExpandedDeckTabs(state);
      if (deckUnitsWrap()) {
        buildCollapsedDeckTabs(state);
      }
    }
    appendAddDeckButton();
  }

  function toggleDeckMenu(deck, anchorEl, opts) {
    const includeFindOpen = !!(opts && opts.includeFindOpen);

    if (openDeckMenuId === deck.id) {
      closeDeckMenu();
      return;
    }
    closeDeckMenu();
    openDeckMenuId = deck.id;

    const menu = document.createElement('div');
    menu.className = 'deck-menu';

    if (includeFindOpen) {
      const findBtn = document.createElement('button');
      findBtn.textContent = 'Find';
      findBtn.addEventListener('click', () => {
        closeDeckMenu();
        openFindDeckModal(deck);
      });

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => {
        closeDeckMenu();
        performOpenDeck(deck);
      });

      menu.appendChild(findBtn);
      menu.appendChild(openBtn);
    }

    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => {
      closeDeckMenu();
      openRenameDeckModal(deck);
    });

    const openPrefsBtn = document.createElement('button');
    openPrefsBtn.textContent = 'Open Preferences';
    openPrefsBtn.addEventListener('click', () => {
      closeDeckMenu();
      openOpenPreferencesModal(deck);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      closeDeckMenu();
      openDeleteDeckModal(deck);
    });

    menu.appendChild(renameBtn);
    menu.appendChild(openPrefsBtn);
    menu.appendChild(deleteBtn);

    // Deck tabs are clipped to a trapezoid shape via clip-path (see
    // .deck-tab in newtab.css) so the browser can paint their angled
    // edges. clip-path clips a box's ENTIRE painted output, including
    // descendants - so a menu appended inside a .deck-tab (as this
    // used to do) was added to the DOM correctly but rendered
    // invisible, clipped away by its own anchor. That's the reported
    // "the arrow does nothing" bug: nothing visibly happened, even
    // though the click handler ran.
    //
    // Fix: append the menu to <body>, outside any clipped ancestor,
    // and position it with fixed coordinates computed from the
    // anchor's on-screen position instead of relying on CSS
    // position:absolute inside the (clipped) Deck tab.
    document.body.appendChild(menu);

    function positionMenu() {
      const rect = anchorEl.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.left = `${rect.left + rect.width / 2}px`;
    }
    positionMenu();
    repositionDeckMenu = positionMenu;
    window.addEventListener('resize', repositionDeckMenu);
    window.addEventListener('scroll', repositionDeckMenu, true);

    setTimeout(() => {
      document.addEventListener('click', closeDeckMenu, { once: true });
    }, 0);
  }

  function openAddDeckModal() {
    if (window.DeckStore.isAtDeckLimit()) {
      showToast(`Maximum ${window.DeckStore.MAX_DECKS} Decks reached.`);
      return;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = 'e.g. Work';

    const body = fieldRow('Deck name', input, 'add-deck-error');
    openModal({
      title: 'Create Deck',
      bodyNode: body,
      confirmLabel: 'Create',
      focusEl: input,
      onConfirm: async () => {
        const result = await window.DeckStore.createDeck(input.value);
        if (!result.ok) {
          setError('add-deck-error', result.error);
          return true; // keep modal open
        }
        showToast(`Created "${result.deck.name}"`);
        return false;
      },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') modalConfirm.click();
    });
  }

  function openRenameDeckModal(deck) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.value = deck.name;

    const body = fieldRow('Deck name', input, 'rename-deck-error');
    openModal({
      title: 'Rename Deck',
      bodyNode: body,
      confirmLabel: 'Save',
      focusEl: input,
      onConfirm: async () => {
        const result = await window.DeckStore.renameDeck(deck.id, input.value);
        if (!result.ok) {
          setError('rename-deck-error', result.error);
          return true;
        }
        showToast('Deck renamed');
        return false;
      },
    });
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') modalConfirm.click();
    });
  }

  function openDeleteDeckModal(deck) {
    const body = document.createElement('div');
    const p = document.createElement('p');
    p.style.margin = '0';
    p.style.fontSize = '13.5px';
    p.style.color = 'var(--text-muted)';
    p.textContent = `Delete "${deck.name}" and all ${deck.shortcuts.length} of its shortcuts? This cannot be undone.`;
    body.appendChild(p);

    openModal({
      title: 'Delete Deck',
      bodyNode: body,
      confirmLabel: null,
      dangerLabel: 'Delete Deck',
      onDanger: async () => {
        await window.DeckStore.deleteDeck(deck.id);
        showToast(`Deleted "${deck.name}"`);
        return false;
      },
    });
  }

  // -------------------------------------------------------------------
  // Phase 4: Per-Deck Open Preferences (Deck Gear -> Open Preferences)
  // -------------------------------------------------------------------

  /**
   * Small radio-group builder shared by the two Open Preferences
   * fieldsets. Returns { fieldset, getValue() } so the caller doesn't
   * need to know the DOM shape or input `name` used internally.
   */
  function buildRadioGroup(legendText, groupName, options, selectedValue) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = legendText;
    fieldset.appendChild(legend);

    for (const opt of options) {
      const row = document.createElement('label');
      row.className = 'open-prefs__option' + (opt.disabled ? ' is-disabled' : '');

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = opt.value;
      input.checked = opt.value === selectedValue && !opt.disabled;
      input.disabled = !!opt.disabled;

      const textWrap = document.createElement('span');
      const labelText = document.createElement('span');
      labelText.textContent = opt.label;
      textWrap.appendChild(labelText);
      if (opt.hint) {
        const hint = document.createElement('span');
        hint.className = 'open-prefs__hint';
        hint.textContent = opt.hint;
        textWrap.appendChild(hint);
      }

      row.appendChild(input);
      row.appendChild(textWrap);
      fieldset.appendChild(row);
    }

    // If the previously-selected value is disabled (e.g. Incognito was
    // revoked since this Deck was configured), fall back to the first
    // enabled option so the form never submits a disabled/invalid value.
    if (!fieldset.querySelector('input:checked')) {
      const firstEnabled = fieldset.querySelector('input:not(:disabled)');
      if (firstEnabled) firstEnabled.checked = true;
    }

    return {
      fieldset,
      getValue: () => {
        const checked = fieldset.querySelector('input:checked');
        return checked ? checked.value : selectedValue;
      },
    };
  }

  async function openOpenPreferencesModal(deck) {
    const incognitoAllowed = await window.BrowserState.isIncognitoAccessAllowed();
    const prefs = deck.openPreferences || window.DeckStore.DEFAULT_OPEN_PREFERENCES;

    const wrap = document.createElement('div');
    wrap.className = 'open-prefs';

    const destGroup = buildRadioGroup('Destination', 'open-pref-destination', [
      { value: 'new-window', label: 'New Regular Window' },
      { value: 'current-window', label: 'Current Window' },
      {
        value: 'incognito-window',
        label: 'New Incognito Window',
        disabled: !incognitoAllowed,
        hint: incognitoAllowed
          ? null
          : 'Enable "Allow in Incognito" for Deck New Tab in chrome://extensions to use this.',
      },
    ], prefs.destination);

    const policyGroup = buildRadioGroup('When some URLs are already open', 'open-pref-policy', [
      { value: 'all', label: 'Open All' },
      { value: 'missing-only', label: 'Open Missing Only' },
    ], prefs.existingPolicy);

    wrap.appendChild(destGroup.fieldset);
    wrap.appendChild(policyGroup.fieldset);

    openModal({
      title: `Open Preferences \u2014 ${deck.name}`,
      bodyNode: wrap,
      confirmLabel: 'Save',
      onConfirm: async () => {
        const result = await window.DeckStore.updateDeckOpenPreferences(deck.id, {
          destination: destGroup.getValue(),
          existingPolicy: policyGroup.getValue(),
        });
        if (!result.ok) {
          showToast(result.error);
          return true;
        }
        showToast('Open Preferences saved');
        return false;
      },
    });
  }

  // -------------------------------------------------------------------
  // Phase 3: Find Deck / Open All / Open Missing
  //
  // This section is the only part of app.js that calls into
  // window.BrowserState. It never touches chrome.windows/chrome.tabs
  // itself and never mutates Deck data - Find Deck is read-only
  // discovery, and the launch actions (Go Here / Open Missing / Open
  // All) only ever create new tabs/windows or focus an existing one.
  // -------------------------------------------------------------------

  async function openAllDeck(deck) {
    if (deck.shortcuts.length === 0) {
      showToast('This Deck has no shortcuts to open.');
      return;
    }
    const windowId = await window.BrowserState.openAllInNewWindow(deck);
    if (windowId === null) {
      showToast('This Deck has no shortcuts to open.');
      return;
    }
    showToast(`Opened "${deck.name}" in a new window`);
  }

  // -------------------------------------------------------------------
  // Phase 4: the visible tray "Open" button - the ONE place that reads
  // and acts on a Deck's saved Open Preferences. Everything else (the
  // actual window/tab decisions) lives in BrowserState.openDeckWithPreferences.
  // -------------------------------------------------------------------

  function describeOpenResult(deck, result) {
    switch (result.mode) {
      case 'new-window':
      case 'new-window-fallback':
        return `Opened "${deck.name}" in a new window`;
      case 'current-window':
        return `Opened ${result.opened} shortcut${result.opened === 1 ? '' : 's'} in this window`;
      case 'incognito-window':
        return `Opened "${deck.name}" in a new Incognito window`;
      case 'missing-only':
        return `Opened ${result.opened} missing shortcut${result.opened === 1 ? '' : 's'}`;
      case 'already-open':
        return `"${deck.name}" is already open here`;
      default:
        return `Opened "${deck.name}"`;
    }
  }

  async function performOpenDeck(deck) {
    if (deck.shortcuts.length === 0) {
      showToast('This Deck has no shortcuts to open.');
      return;
    }
    const result = await window.BrowserState.openDeckWithPreferences(deck);
    if (!result.ok) {
      if (result.reason === 'incognito-not-allowed') {
        showToast(
          'Incognito access isn\u2019t enabled for Deck New Tab. Enable "Allow in Incognito" in chrome://extensions, then try again.'
        );
      } else {
        showToast('This Deck has no shortcuts to open.');
      }
      return;
    }
    showToast(describeOpenResult(deck, result));
  }

  function findDeckWindowRow(deck, match, isBest) {
    const row = document.createElement('div');
    row.className = 'find-deck-row' + (isBest ? ' find-deck-row--best' : '');

    const goHere = async () => {
      await window.BrowserState.focusWindow(match.windowId, match.matchedTabId);
      closeModal();
    };

    // WHAT: the recommended result card itself is a Go Here target.
    // WHY: purple consistently signals the recommended next action.
    // FUTURE / DO-NOT-BREAK: only BEST MATCH gets card activation, and
    // every nested explicit action must stop propagation so one click can
    // never launch both Open Missing and Go Here.
    if (isBest) {
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', `Go to best match, Window ${match.windowId}`);
      row.addEventListener('click', goHere);
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goHere();
        }
      });
    }

    const info = document.createElement('div');
    info.className = 'find-deck-row__info';

    const title = document.createElement('div');
    title.className = 'find-deck-row__title';
    title.textContent = match.incognito ? `Window ${match.windowId} (Incognito)` : `Window ${match.windowId}`;
    if (isBest) {
      const badge = document.createElement('span');
      badge.className = 'find-deck-row__badge';
      badge.textContent = 'BEST MATCH';
      title.appendChild(badge);
    }

    const count = document.createElement('div');
    count.className = 'find-deck-row__count';
    count.textContent =
      match.missingUrls.length === 0
        ? `${match.matchedCount} / ${match.matchedCount + match.missingUrls.length} matched — Deck fully open here`
        : `${match.matchedCount} / ${match.matchedCount + match.missingUrls.length} matched`;

    info.appendChild(title);
    info.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'find-deck-row__actions';

    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'btn btn--primary';
    goBtn.textContent = 'Go Here';
    goBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      goHere();
    });
    actions.appendChild(goBtn);

    if (match.missingUrls.length > 0) {
      const missingBtn = document.createElement('button');
      missingBtn.type = 'button';
      missingBtn.className = 'btn btn--ghost';
      missingBtn.textContent = `Open Missing ${match.missingUrls.length}`;
      missingBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        missingBtn.disabled = true;
        const opened = await window.BrowserState.openMissingInWindow(match.windowId, match.missingUrls);
        showToast(`Opened ${opened} missing shortcut${opened === 1 ? '' : 's'}`);
        closeModal();
      });
      actions.appendChild(missingBtn);
    }

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  async function openFindDeckModal(deck) {
    if (deck.shortcuts.length === 0) {
      const body = document.createElement('div');
      const p = document.createElement('p');
      p.style.margin = '0';
      p.style.fontSize = '13.5px';
      p.style.color = 'var(--text-muted)';
      p.textContent = 'This Deck has no shortcuts to find.';
      body.appendChild(p);
      openModal({ title: `Find ${deck.name}`, bodyNode: body, cancelLabel: 'Close' });
      return;
    }

    const result = await window.BrowserState.findDeckMatches(deck);

    const body = document.createElement('div');
    body.className = 'find-deck-body';

    const summary = document.createElement('p');
    summary.className = 'find-deck-summary';
    summary.textContent = `${result.totalUnique} shortcut${result.totalUnique === 1 ? '' : 's'} in Deck`;
    body.appendChild(summary);

    if (result.windows.length === 0) {
      const none = document.createElement('p');
      none.className = 'find-deck-summary';
      none.textContent = 'No open tabs match this Deck.';
      body.appendChild(none);
    } else {
      for (const match of result.windows) {
        body.appendChild(findDeckWindowRow(deck, match, match.windowId === result.bestWindowId));
      }
    }

    const openAllRow = document.createElement('div');
    openAllRow.className = 'find-deck-open-all-row';
    const openAllBtn = document.createElement('button');
    openAllBtn.type = 'button';
    openAllBtn.className = 'btn btn--ghost';
    openAllBtn.textContent = result.windows.length === 0 ? 'Open All' : 'Open All Fresh';
    openAllBtn.addEventListener('click', async () => {
      await openAllDeck(deck);
      closeModal();
    });
    openAllRow.appendChild(openAllBtn);
    body.appendChild(openAllRow);

    openModal({ title: `Find ${deck.name}`, bodyNode: body, cancelLabel: 'Close' });
  }

  // -------------------------------------------------------------------
  // Shortcuts grid
  // -------------------------------------------------------------------

  function faviconUrlFor(url) {
    try {
      const u = new URL(url);
      // chrome-extension pages can use the privileged favicon API when
      // the "favicon" permission-less endpoint is available; fall back
      // to Google's public favicon service otherwise.
      return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
    } catch {
      return null;
    }
  }

  function renderShortcuts(deck) {
    shortcutsGridEl.innerHTML = '';

    if (!deck || deck.shortcuts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'shortcuts-grid__empty';
      empty.textContent = 'No shortcuts yet. Add one below.';
      shortcutsGridEl.appendChild(empty);
      return;
    }

    for (const shortcut of deck.shortcuts) {
      shortcutsGridEl.appendChild(buildShortcutTile(deck, shortcut));
    }
  }

  // -------------------------------------------------------------------
  // Shortcut drag-and-drop reordering
  //
  // DeckStore owns the persisted order (reorderShortcuts). This layer
  // only tracks the drag gesture in the DOM and, on drop, computes
  // the resulting shortcut-id order and hands it to DeckStore - it
  // never reorders anything itself outside of what DeckStore's
  // onChange -> render() produces afterward.
  // -------------------------------------------------------------------

  let draggedShortcutId = null;

  function clearDragOverMarkers() {
    shortcutsGridEl
      .querySelectorAll('.shortcut-tile--drag-before, .shortcut-tile--drag-after')
      .forEach((el) => el.classList.remove('shortcut-tile--drag-before', 'shortcut-tile--drag-after'));
  }

  shortcutsGridEl.addEventListener('dragover', (e) => {
    if (!draggedShortcutId) return;
    const target = e.target.closest('.shortcut-tile');
    if (!target || target.dataset.shortcutId === draggedShortcutId) {
      clearDragOverMarkers();
      return;
    }
    e.preventDefault(); // required to allow a drop here
    e.dataTransfer.dropEffect = 'move';

    const rect = target.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    clearDragOverMarkers();
    target.classList.add(before ? 'shortcut-tile--drag-before' : 'shortcut-tile--drag-after');
  });

  shortcutsGridEl.addEventListener('drop', async (e) => {
    if (!draggedShortcutId) return;
    const target = e.target.closest('.shortcut-tile');
    clearDragOverMarkers();
    if (!target || target.dataset.shortcutId === draggedShortcutId) return;
    e.preventDefault();

    const activeDeck = window.DeckStore.getActiveDeck();
    if (!activeDeck) return;

    const ids = activeDeck.shortcuts.map((s) => s.id);
    const fromIdx = ids.indexOf(draggedShortcutId);
    const targetId = target.dataset.shortcutId;
    if (fromIdx === -1) return;
    ids.splice(fromIdx, 1);

    const rect = target.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    let toIdx = ids.indexOf(targetId);
    if (toIdx === -1) return;
    if (!before) toIdx += 1;
    ids.splice(toIdx, 0, draggedShortcutId);

    await window.DeckStore.reorderShortcuts(activeDeck.id, ids);
  });

  shortcutsGridEl.addEventListener('dragend', () => {
    draggedShortcutId = null;
    clearDragOverMarkers();
    const dragging = shortcutsGridEl.querySelector('.shortcut-tile.is-dragging');
    if (dragging) dragging.classList.remove('is-dragging');
  });

  function buildShortcutTile(deck, shortcut) {
    const tile = document.createElement('a');
    tile.className = 'shortcut-tile';
    tile.href = shortcut.url;
    tile.setAttribute('role', 'listitem');

    // Drag-and-drop reordering. The tile itself is the drag source;
    // the grid-level dragover/drop handlers below own the actual
    // reordering logic and the DeckStore.reorderShortcuts() call.
    tile.draggable = true;
    tile.dataset.shortcutId = shortcut.id;
    tile.addEventListener('dragstart', (e) => {
      draggedShortcutId = shortcut.id;
      tile.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Needed for Chrome to treat this as a valid drag operation;
      // the payload itself isn't read back out, ordering is derived
      // from draggedShortcutId + the current deck's shortcut list.
      e.dataTransfer.setData('text/plain', shortcut.id);
    });

    const iconWrap = document.createElement('div');
    iconWrap.className = 'shortcut-tile__icon-wrap';

    const fallback = document.createElement('div');
    fallback.className = 'shortcut-tile__fallback';
    fallback.textContent = (shortcut.name || '?').trim().charAt(0).toUpperCase() || '?';

    const favicon = faviconUrlFor(shortcut.url);
    if (favicon) {
      const img = document.createElement('img');
      img.src = favicon;
      img.alt = '';
      img.width = 24;
      img.height = 24;
      img.addEventListener('error', () => {
        img.remove();
        iconWrap.appendChild(fallback);
      });
      iconWrap.appendChild(img);
    } else {
      iconWrap.appendChild(fallback);
    }

    const label = document.createElement('div');
    label.className = 'shortcut-tile__label';
    label.textContent = shortcut.name;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'shortcut-tile__edit-btn';
    editBtn.setAttribute('aria-label', `Edit ${shortcut.name}`);
    editBtn.textContent = '\u22ef';
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditShortcutModal(deck, shortcut);
    });

    tile.appendChild(editBtn);
    tile.appendChild(iconWrap);
    tile.appendChild(label);

    return tile;
  }

  function shortcutFormBody(existing) {
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 100;
    nameInput.placeholder = 'GitHub';
    nameInput.value = existing ? existing.name : '';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://github.com';
    urlInput.value = existing ? existing.url : '';

    const wrap = document.createElement('div');
    wrap.appendChild(fieldRow('Name', nameInput));
    wrap.appendChild(fieldRow('URL', urlInput, 'shortcut-error'));

    return { wrap, nameInput, urlInput };
  }

  function normalizeUrlForSave(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
    // No protocol given - treat it as https if it looks domain-like.
    if (/^[^\s]+\.[^\s]+$/.test(trimmed)) return `https://${trimmed}`;
    return trimmed; // not protocol-prefixed or domain-like; DeckStore will reject it if it isn't a valid http(s) URL
  }

  function openAddShortcutModal() {
    const activeDeck = window.DeckStore.getActiveDeck();
    if (!activeDeck) return;
    const { wrap, nameInput, urlInput } = shortcutFormBody(null);

    openModal({
      title: 'Add Shortcut',
      bodyNode: wrap,
      confirmLabel: 'Add',
      focusEl: nameInput,
      onConfirm: async () => {
        const url = normalizeUrlForSave(urlInput.value);
        if (!url) {
          setError('shortcut-error', 'A URL is required.');
          return true;
        }
        const result = await window.DeckStore.addShortcut(activeDeck.id, {
          name: nameInput.value,
          url,
        });
        if (!result.ok) {
          setError('shortcut-error', result.error);
          return true;
        }
        showToast('Shortcut added');
        return false;
      },
    });
  }

  function openEditShortcutModal(deck, shortcut) {
    const { wrap, nameInput, urlInput } = shortcutFormBody(shortcut);

    openModal({
      title: 'Edit Shortcut',
      bodyNode: wrap,
      confirmLabel: 'Save',
      dangerLabel: 'Delete',
      focusEl: nameInput,
      onConfirm: async () => {
        const url = normalizeUrlForSave(urlInput.value);
        if (!url) {
          setError('shortcut-error', 'A URL is required.');
          return true;
        }
        const result = await window.DeckStore.updateShortcut(deck.id, shortcut.id, {
          name: nameInput.value,
          url,
        });
        if (!result.ok) {
          setError('shortcut-error', result.error);
          return true;
        }
        showToast('Shortcut updated');
        return false;
      },
      onDanger: async () => {
        await window.DeckStore.deleteShortcut(deck.id, shortcut.id);
        showToast('Shortcut deleted');
        return false;
      },
    });
  }

  addShortcutBtn.addEventListener('click', openAddShortcutModal);

  // -------------------------------------------------------------------
  // Search bar
  // -------------------------------------------------------------------

  function looksLikeUrl(input) {
    const trimmed = input.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return true; // has a protocol
    if (/\s/.test(trimmed)) return false; // spaces => treat as a search
    // domain.tld or domain.tld/path, optionally with a port
    return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/.test(trimmed);
  }

  function resolveSearchTarget(rawInput) {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    if (looksLikeUrl(trimmed)) {
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = resolveSearchTarget(searchInput.value);
    if (target) window.location.href = target;
  });

  // -------------------------------------------------------------------
  // Export / import
  // -------------------------------------------------------------------

  exportBtn.addEventListener('click', () => {
    const json = window.DeckStore.exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `decks-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Decks exported');
  });

  importBtn.addEventListener('click', () => importFileInput.click());

  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files && importFileInput.files[0];
    importFileInput.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const result = await window.DeckStore.importData(text);
      if (!result.ok) {
        showToast(`Import failed: ${result.error}`);
        return;
      }
      showToast(`Imported ${result.deckCount} Deck${result.deckCount === 1 ? '' : 's'}`);
    } catch (err) {
      console.error('[app] import failed', err);
      showToast('Import failed: could not read that file.');
    }
  });

  // -------------------------------------------------------------------
  // Render loop - re-render whenever DeckStore state changes.
  // -------------------------------------------------------------------

  function render(state) {
    lastRenderedState = state;
    closeDeckMenu();
    renderDeckTabs(state);
    const activeDeck = state.decks.find((d) => d.id === state.activeDeckId) || null;
    renderShortcuts(activeDeck);
  }

  window.DeckStore.onChange(render);

  // Re-evaluate wrap detection on resize, but only in 'auto' mode -
  // an explicit user choice of Expanded/Collapsed is never overridden
  // by window size.
  let shelfResizeTimer = null;
  window.addEventListener('resize', () => {
    if (shelfModePref !== 'auto' || !lastRenderedState) return;
    clearTimeout(shelfResizeTimer);
    shelfResizeTimer = setTimeout(() => {
      renderDeckTabs(lastRenderedState);
    }, 150);
  });

  (async () => {
    shelfModePref = (await window.DeckStorage.loadShelfMode()) || 'auto';
    updateShelfModeButton();
    try {
      const state = await window.DeckStore.init();
      render(state);
      searchInput.focus();
    } catch (err) {
      // init() itself is defensive and shouldn't throw, but guard the
      // UI anyway so a startup failure never leaves a blank page.
      console.error('[app] failed to initialize DeckStore', err);
      showToast('Something went wrong loading your Decks.');
    }
  })();
})();
