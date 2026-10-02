/* Shared presentation helpers. EPUB rendering and API persistence stay in app.js. */
let desktopPage = 'home';
let desktopSeries = null;
window.resetDesktopState = () => {
  desktopPage = 'home'; desktopSeries = null;
  document.getElementById('desktop-content').replaceChildren();
  document.querySelectorAll('.form-editor[open]').forEach(dialog => dialog.close());
};

function readingStatus(entry) {
  return entry.status || (entry.progress >= 98 ? 'finished' : entry.progress > 0 ? 'reading' : 'unread');
}

function navigateDesktop(page, value = null) {
  if (page === 'book') { openBookDetails(value).catch(error => showToast(error.message || 'Could not open book details.')); return; }
  desktopPage = page === 'search' ? 'library' : page;
  desktopSeries = page === 'series' ? value : null;
  if (desktopSeries) { document.getElementById('shelf-search').value = ''; document.getElementById('shelf-filter').value = 'all'; }
  if (!isMobileShell()) history.pushState({ endpaperDesktop: { page: desktopPage, value } }, '', `#/${page}${value ? `/${encodeURIComponent(value)}` : ''}`);
  renderShelf();
  document.getElementById('shelf-view').scrollTo(0, 0);
  if (page === 'search') document.getElementById('shelf-search').focus();
}

function renderDesktopShell() {
  if (isMobileShell() || !currentUser) return;
  const root = document.getElementById('shelf-view');
  root.dataset.desktopPage = desktopPage;
  const catalogue = ['library', 'series'].includes(desktopPage);
  const heading = document.getElementById('desktop-heading');
  const titles = { home: 'Your reading', library: 'Library', series: desktopSeries, more: 'More', offline: 'Downloads', notebook: 'Notebook', stats: 'Reading stats', preferences: 'Appearance & reader defaults', goals: 'Reading goals' };
  heading.textContent = titles[desktopPage] || 'Your reading';
  document.getElementById('desktop-topbar-title').textContent = desktopPage === 'home' ? 'Your library' : heading.textContent;
  document.getElementById('desktop-browse-library').hidden = desktopPage !== 'home';
  document.getElementById('desktop-description').textContent = desktopPage === 'home' ? 'Pick up where you left off, or find your next book.' : catalogue ? `${library.length} book${library.length === 1 ? '' : 's'} in your shared library` : '';
  document.querySelectorAll('[data-desktop-page]').forEach(button => {
    const active = button.dataset.desktopPage === desktopPage || desktopPage === 'series' && button.dataset.desktopPage === 'library';
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  const content = document.getElementById('desktop-content');
  content.replaceChildren();
  // Reuse the same destinations and persistence on both shells.
  if (!['home', 'library', 'series'].includes(desktopPage)) {
    const renderers = { more: mobileMore, offline: mobileOffline, notebook: mobileNotebook, stats: mobileStats, preferences: mobilePreferences, goals: mobileGoals };
    mobileRoute = { page: desktopPage };
    const render = renderers[desktopPage];
    if (render) { mobileRenderVersion++; render(content, mobileRenderVersion); }
  }
  if (catalogue && desktopSeries) {
    for (const card of document.querySelectorAll('#shelf .book-card')) {
      const entry = library.find(item => item.id === card.dataset.bookId);
      card.hidden = entry?.series !== desktopSeries;
    }
    const count = document.querySelectorAll('#shelf .book-card:not([hidden])').length;
    document.getElementById('shelf-count').textContent = `${count} book${count === 1 ? '' : 's'}`;
  }
  document.getElementById('desktop-account-name').textContent = currentUser.username || 'Account';
  window.animateShellDestination?.('desktop', `${desktopPage}:${desktopSeries || ''}`);
}
window.renderDesktopShell = renderDesktopShell;

document.querySelectorAll('[data-desktop-page]').forEach(button => button.addEventListener('click', () => navigateDesktop(button.dataset.desktopPage)));
window.addEventListener('popstate', event => {
  if (isMobileShell()) return;
  if (document.body.classList.contains('reader-active')) showShelf();
  desktopPage = event.state?.endpaperDesktop?.page || 'home';
  desktopSeries = event.state?.endpaperDesktop?.value || null;
  renderShelf();
});
window.matchMedia('(max-width:700px), (max-width:900px) and (pointer:coarse)').addEventListener('change', () => { renderShelf(); updateDrawerBackdrop(); });

// Native dialog supplies protected focus, Escape and focus restoration.
function openFormEditor({ title, fields, onSave, submitLabel = 'Save' }) {
  const dialog = mobileElement('dialog', 'form-editor');
  dialog.setAttribute('aria-label', title);
  const form = mobileElement('form');
  form.appendChild(mobileElement('h2', '', title));
  const inputs = new Map();
  for (const field of fields) {
    const label = mobileElement('label', 'editor-field', field.label);
    const input = mobileElement(field.multiline ? 'textarea' : 'input');
    input.name = field.name; input.value = field.value || '';
    if (!field.multiline) input.type = field.type || 'text';
    if (field.required) input.required = true;
    if (field.type === 'number') input.step = 'any';
    if (field.multiline) input.rows = 4;
    label.appendChild(input); form.appendChild(label); inputs.set(field.name, input);
  }
  const error = mobileElement('p', 'editor-error'); error.setAttribute('role', 'alert');
  const actions = mobileElement('div', 'editor-actions');
  const cancel = mobileButton('Cancel', () => dialog.close());
  const save = mobileElement('button', 'primary-action', submitLabel); save.type = 'submit';
  actions.append(cancel, save); form.append(error, actions); dialog.appendChild(form);
  document.body.appendChild(dialog);
  return new Promise(resolve => {
    let saved = false;
    dialog.addEventListener('close', () => { dialog.remove(); resolve(saved); }, { once: true });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    form.addEventListener('submit', async event => {
      event.preventDefault(); error.textContent = ''; save.disabled = true; cancel.disabled = true;
      try {
        await onSave(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])));
        saved = true; dialog.close();
      } catch (failure) { error.textContent = failure.message || 'Could not save. Please try again.'; }
      finally { save.disabled = false; cancel.disabled = false; }
    });
    dialog.showModal();
  });
}

async function openAnnotation(item) {
  const targetBook = item.book_id || currentBookId;
  if (!targetBook) return;
  const expectedAccountVersion = accountVersion;
  if (targetBook !== currentBookId || !rendition) await openBook(targetBook);
  if (accountVersion !== expectedAccountVersion || currentBookId !== targetBook || !rendition) return;
  closeNotebookModal(); closeDrawers({ returnFocus: false });
  const cfi = item.cfi || item.cfi_range;
  if (cfi) await navigateReader(cfi);
}

async function editAnnotation(item, refresh) {
  if (!item.id) { showToast('This highlight is still syncing. Try again shortly.'); return; }
  const context = currentBookId === item.book_id || !item.book_id ? createReaderMutationContext(getCurrentEntry()) : null;
  const expectedAccountVersion = accountVersion;
  await openFormEditor({ title: 'Edit highlight & note', fields: [
    { name: 'note', label: 'Note', value: item.note || '', multiline: true },
    { name: 'tags', label: 'Tags (comma-separated)', value: (item.tags || []).join(', ') },
  ], onSave: async values => {
    if (accountVersion !== expectedAccountVersion) throw new Error('Your account changed. Reopen this highlight.');
    const updated = await api.updateHighlight(item.id, { note: values.note, tags: values.tags.split(',').map(tag => tag.trim()).filter(Boolean) }, context?.requestOptions || { expectedAccountVersion });
    if (accountVersion !== expectedAccountVersion) return;
    Object.assign(item, { note: updated.note || '', tags: updated.tags || [] });
    const local = getCurrentEntry()?.highlights?.find(highlight => highlight.id === item.id);
    if (local) Object.assign(local, { note: item.note, tags: item.tags });
    refresh();
  }});
}

function annotationRow(item, refresh) {
  const row = mobileElement('article', 'annotation-row');
  const destination = mobileButton('', () => openAnnotation(item).catch(error => showToast(error.message || 'Could not open highlight.')), 'annotation-destination');
  destination.setAttribute('aria-label', `Open highlight in ${item.book_title || item.chapter || 'this book'}`);
  const swatch = mobileElement('span', 'annotation-swatch');
  swatch.style.backgroundColor = /^#[0-9a-f]{3,8}$/i.test(item.color || '') ? item.color : '#F2D94E';
  swatch.setAttribute('aria-hidden', 'true');
  const location = mobileElement('small', 'annotation-location', [item.book_title, item.chapter].filter(Boolean).join(' · ') || 'Saved passage');
  const quote = mobileElement('blockquote', 'highlight-excerpt', item.excerpt || 'Highlighted passage');
  destination.append(swatch, location, quote);
  if (item.note) destination.appendChild(mobileElement('p', 'annotation-note', item.note));
  row.appendChild(destination);
  const footer = mobileElement('div', 'annotation-footer');
  const tags = mobileElement('span', 'annotation-tags', (item.tags || []).map(tag => `#${tag}`).join(' '));
  footer.append(tags, mobileButton('Edit note & tags', () => editAnnotation(item, refresh), 'file-link-btn'));
  row.appendChild(footer);
  return row;
}

function openAudioOptions() {
  const panel = document.getElementById('audio-options');
  panel.showModal();
  populateTtsVoices();
}
document.getElementById('audio-options').addEventListener('keydown', event => event.stopPropagation());
document.getElementById('audio-options-close').addEventListener('click', () => document.getElementById('audio-options').close());

const desktopAccountMenu = mobileElement('details'); desktopAccountMenu.id = 'desktop-account-menu';
const accountSummary = mobileElement('summary', '', 'Account');
accountSummary.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>');
const accountActions = mobileElement('div', 'desktop-account-actions');
desktopAccountMenu.append(accountSummary, accountActions);
preserveActionMenuFocus(accountActions, accountSummary);
for (const [id, label] of [['shell-theme-toggle', 'App appearance'], ['help-toggle', 'Keyboard shortcuts'], ['admin-toggle', 'People & permissions'], ['logout-btn', 'Log out']]) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.appendChild(mobileElement('span', '', label));
  button.addEventListener('click', () => { desktopAccountMenu.open = false; });
  accountActions.appendChild(button);
}
document.getElementById('topbar-actions').insertBefore(desktopAccountMenu, document.getElementById('upload-btn'));
desktopAccountMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); desktopAccountMenu.open = false; accountSummary.focus(); }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation(); desktopAccountMenu.open = true;
    const buttons = [...accountActions.querySelectorAll('button')].filter(button => !button.disabled && button.getClientRects().length);
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
});
// A pointer press can blur summary to body before its button receives the click.
// Dismiss on a real outside focus destination, not that intermediate blur.
document.addEventListener('focusin', event => { if (!desktopAccountMenu.contains(event.target)) desktopAccountMenu.open = false; });
document.addEventListener('click', event => { if (!desktopAccountMenu.contains(event.target)) desktopAccountMenu.open = false; });

renderDesktopShell();

/* Progressive select enhancement. Native controls remain the source of values,
   form submission and change events, and remain usable if this script fails. */
(() => {
  const controls = new Map();
  let sequence = 0, opened = null;
  const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>';
  const nameOf = select => {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    if (select.getAttribute('aria-labelledby')) return select.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    return [...select.labels || []].map(label => {
      const copy = label.cloneNode(true); copy.querySelectorAll('select,.polished-select').forEach(element => element.remove());
      return copy.textContent.trim();
    }).join(' ') || select.name || 'Choose an option';
  };
  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const wrapper = document.createElement('span'); wrapper.className = 'polished-select';
    const trigger = document.createElement('button'); trigger.type = 'button';
    trigger.className = 'select-trigger'; trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span'); text.className = 'select-value';
    trigger.append(text); trigger.insertAdjacentHTML('beforeend', chevron);
    const menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = `select-menu-${++sequence}`;
    menu.setAttribute('role', 'listbox'); trigger.setAttribute('aria-controls', menu.id);
    const nativePopover = typeof menu.showPopover === 'function';
    if (nativePopover) menu.setAttribute('popover', 'manual'); else menu.hidden = true;
    select.before(wrapper); wrapper.append(select, trigger, menu);
    select.classList.add('select-source');
    let active = -1, prefix = '', lastTyped = 0;
    const enabled = () => [...select.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled && !option.parentElement.disabled && !option.hidden);
    const close = () => {
      if (nativePopover && menu.matches(':popover-open')) menu.hidePopover();
      if (!nativePopover) menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
      if (opened === control) opened = null;
    };
    const position = () => {
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8, topEdge = (viewport?.offsetTop || 0) + 8;
      const rightEdge = leftEdge + (viewport?.width || innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height || innerHeight) - 16;
      const rect = trigger.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(rect.width, 220), rightEdge - leftEdge)}px`;
      const below = bottomEdge - rect.bottom - 6, above = rect.top - topEdge - 6;
      const up = below < Math.min(menu.scrollHeight, 280) && above > below;
      menu.style.maxHeight = `${Math.max(44, Math.min(320, up ? above : below))}px`;
      menu.style.left = `${Math.max(leftEdge, Math.min(rect.left, rightEdge - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(topEdge, up ? rect.top - menu.offsetHeight - 6 : Math.min(rect.bottom + 6, bottomEdge - menu.offsetHeight))}px`;
      menu.dataset.direction = up ? 'up' : 'down';
    };
    const activate = index => {
      active = index;
      menu.querySelectorAll('[role=option]').forEach(row => row.classList.toggle('is-active', Number(row.dataset.index) === index));
      const row = menu.querySelector(`[data-index="${index}"]`);
      if (row) { trigger.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    };
    const sync = () => {
      const name = nameOf(select); trigger.setAttribute('aria-label', name); menu.setAttribute('aria-label', name);
      text.textContent = select.selectedOptions[0]?.label || 'No options available';
      trigger.disabled = select.disabled || !enabled().length; wrapper.hidden = select.hidden;
      if (trigger.disabled) close();
      if (opened === control) { build(); position(); activate(active); }
    };
    const build = () => {
      menu.replaceChildren();
      let previousGroup = null;
      [...select.options].forEach((option, index) => {
        if (option.hidden) return;
        const group = option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null;
        if (group && group !== previousGroup) {
          const heading = document.createElement('div'); heading.className = 'select-group'; heading.textContent = group.label; menu.append(heading);
        }
        previousGroup = group;
        const row = document.createElement('div'); row.id = `${menu.id}-option-${index}`; row.dataset.index = index;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected));
        row.setAttribute('aria-disabled', String(option.disabled || !!group?.disabled));
        const label = document.createElement('span'); label.textContent = option.label;
        row.append(label); row.insertAdjacentHTML('beforeend', check); menu.append(row);
      });
    };
    const open = () => {
      sync(); if (trigger.disabled) return;
      opened?.close(); build();
      if (nativePopover) menu.showPopover(); else menu.hidden = false;
      opened = control; trigger.setAttribute('aria-expanded', 'true'); position();
      activate(enabled().some(item => item.index === select.selectedIndex) ? select.selectedIndex : enabled()[0].index);
    };
    const choose = index => {
      if (!enabled().some(item => item.index === index)) return;
      const changed = select.selectedIndex !== index;
      close(); select.selectedIndex = index; sync(); trigger.focus({ preventScroll: true });
      if (changed) { select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    const control = { wrapper, trigger, menu, close, sync };
    controls.set(select, control);
    trigger.addEventListener('click', () => opened === control ? close() : open());
    trigger.addEventListener('keydown', event => {
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'];
      if (event.key === 'Tab') { close(); return; }
      // A second Escape belongs to the containing sheet or dialog.
      if (event.key === 'Escape' && opened !== control) return;
      if (keys.includes(event.key) || event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { close(); return; }
        if (event.key === 'Enter' || event.key === ' ') { if (opened === control) choose(active); else open(); return; }
        const wasOpen = opened === control;
        if (!wasOpen) open();
        const choices = enabled(), cursor = choices.findIndex(item => item.index === active);
        if (event.key === 'Home') activate(choices[0].index);
        else if (event.key === 'End') activate(choices.at(-1).index);
        else if (event.key === 'ArrowDown' && wasOpen) activate(choices[(cursor + 1) % choices.length].index);
        else if (event.key === 'ArrowUp') activate(choices[(cursor - 1 + choices.length) % choices.length].index);
        else if (event.key.length === 1) {
          const now = Date.now(); prefix = now - lastTyped > 700 ? event.key : prefix + event.key; lastTyped = now;
          const match = choices.find(item => item.option.label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()));
          if (match) activate(match.index);
        }
      }
    });
    // Keep mouse focus on the combobox without suppressing WebKit touch clicks.
    menu.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
    menu.addEventListener('click', event => { const row = event.target.closest('[role=option]'); if (row) choose(Number(row.dataset.index)); });
    select.addEventListener('change', sync);
    // Existing renderers set these properties directly (including async rollback).
    for (const property of ['value', 'selectedIndex', 'disabled']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
      if (descriptor?.get && descriptor?.set) Object.defineProperty(select, property, {
        configurable: true, get() { return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, value); sync(); }
      });
    }
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'value', 'label', 'aria-label', 'aria-labelledby'] });
    control.dispose = () => { close(); observer.disconnect(); controls.delete(select); };
    sync();
  }
  function enhanceAll(root = document) {
    if (root.matches?.('select')) enhance(root);
    root.querySelectorAll?.('select').forEach(enhance);
  }
  window.enhanceSelectControls = enhanceAll;
  enhanceAll();
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => { if (node.nodeType === 1) enhanceAll(node); }));
    controls.forEach((control, select) => { if (!select.isConnected) control.dispose(); });
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', event => { if (opened && !opened.wrapper.contains(event.target)) opened.close(); }, true);
  document.addEventListener('focusin', event => { if (opened && !opened.wrapper.contains(event.target)) opened.close(); });
  document.addEventListener('scroll', event => { if (opened && !opened.menu.contains(event.target)) opened.close(); }, true);
  window.addEventListener('resize', () => opened?.close());
  window.visualViewport?.addEventListener('resize', () => opened?.close());
  document.addEventListener('reset', () => queueMicrotask(() => controls.forEach(control => control.sync())));
})();

/* Common keyboard behavior for action menus; existing actions keep their handlers. */
function preserveActionMenuFocus(menu, trigger) {
  // Dialogs and drawers must return focus to the visible trigger, rather than
  // the menu item that disappears after activation. Run before action handlers.
  menu.addEventListener('click', event => {
    const item = event.target.closest('button');
    if (item && menu.contains(item) && !item.disabled) trigger.focus({ preventScroll: true });
  }, true);
}

function positionActionMenu(menu, button) {
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
  const right = left + (viewport?.width || innerWidth) - 16, bottom = top + (viewport?.height || innerHeight) - 16;
  const rect = button.getBoundingClientRect();
  menu.style.position = 'fixed'; menu.style.right = 'auto';
  const below = bottom - rect.bottom - 6, above = rect.top - top - 6;
  const up = below < Math.min(menu.scrollHeight, 280) && above > below;
  menu.style.maxHeight = `${Math.max(44, Math.min(400, up ? above : below))}px`;
  menu.style.left = `${Math.max(left, Math.min(rect.right - menu.offsetWidth, right - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(top, up ? rect.top - menu.offsetHeight - 6 : Math.min(rect.bottom + 6, bottom - menu.offsetHeight))}px`;
  menu.style.transformOrigin = up ? 'bottom right' : 'top right';
}
desktopAccountMenu.addEventListener('toggle', () => { if (desktopAccountMenu.open) positionActionMenu(accountActions, accountSummary); });
window.addEventListener('resize', () => { desktopAccountMenu.open = false; });
document.addEventListener('scroll', event => { if (!accountActions.contains(event.target)) desktopAccountMenu.open = false; }, true);
for (const [buttonId, menuId, close] of [
  ['library-tools-btn', 'library-tools-menu', closeLibraryToolsMenu],
  ['reader-more-btn', 'reader-more-menu', closeReaderMoreMenu],
  ['mobile-reader-tools-button', 'mobile-reader-tools-menu', closeMobileReaderTools],
]) {
  const button = document.getElementById(buttonId), menu = document.getElementById(menuId);
  preserveActionMenuFocus(menu, button);
  const items = () => [...menu.querySelectorAll('button:not(:disabled)')].filter(item => item.getClientRects().length);
  if (menuId !== 'mobile-reader-tools-menu') new MutationObserver(() => {
    if (button.getAttribute('aria-expanded') === 'true') positionActionMenu(menu, button);
  }).observe(button, { attributes: true, attributeFilter: ['aria-expanded'] });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !button.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', event => { if (!menu.contains(event.target) && !button.contains(event.target)) close(); });
  window.addEventListener('resize', close);
  document.addEventListener('scroll', event => { if (!menu.contains(event.target)) close(); }, true);
  button.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { close(); return; }
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    (event.key === 'ArrowUp' ? items().at(-1) : items()[0])?.focus();
  });
  menu.addEventListener('keydown', event => {
    const choices = items(), index = choices.indexOf(document.activeElement);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab'].includes(event.key)) return;
    event.stopPropagation();
    if (event.key === 'Tab') { close(); return; }
    event.preventDefault();
    if (event.key === 'Escape') { close(); button.focus({ preventScroll: true }); return; }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.focus();
  });
}

/* A moving paper bookmark links destinations; content stays immediately usable. */
(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const easing = 'cubic-bezier(.16,1,.3,1)';
  const viewKeys = new Map(), viewAnimations = new Map();
  const indicators = [];
  for (const id of ['desktop-nav', 'mobile-tabbar']) {
    const nav = document.getElementById(id);
    const marker = document.createElement('span'); marker.className = 'navigation-highlight';
    marker.setAttribute('aria-hidden', 'true'); marker.hidden = true;
    nav.append(marker); nav.classList.add('has-motion-indicator');
    let animation = null, previous = null, frame = 0;
    const update = () => {
      frame = 0;
      const active = nav.querySelector('button[aria-current="page"]');
      if (document.body.classList.contains('reader-active') || !active?.getClientRects().length || !nav.getClientRects().length) {
        animation?.cancel(); animation = null; marker.hidden = true; previous = null; return;
      }
      const bounds = nav.getBoundingClientRect(), rect = active.getBoundingClientRect();
      const next = { x: rect.left - bounds.left + nav.scrollLeft - nav.clientLeft, y: rect.top - bounds.top + nav.scrollTop - nav.clientTop, width: rect.width, height: rect.height };
      const moved = previous && Object.keys(next).some(key => Math.abs(next[key] - previous[key]) > .5);
      if (previous && !moved && !marker.hidden && !preference.matches) return;
      const current = moved && !marker.hidden ? marker.getBoundingClientRect() : null;
      animation?.cancel(); animation = null;
      marker.hidden = false;
      marker.style.width = `${next.width}px`; marker.style.height = `${next.height}px`;
      const finalTransform = `translate(${next.x}px,${next.y}px)`;
      marker.style.transform = finalTransform;
      if (current && !preference.matches && typeof marker.animate === 'function') {
        animation = marker.animate([
          { transform: `translate(${current.left - bounds.left + nav.scrollLeft - nav.clientLeft}px,${current.top - bounds.top + nav.scrollTop - nav.clientTop}px) scale(${current.width / next.width},${current.height / next.height})` },
          { transform: finalTransform }
        ], { duration: 230, easing });
      }
      previous = next;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    new MutationObserver(schedule).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
    new ResizeObserver(schedule).observe(nav);
    indicators.push({ update, schedule }); update();
  }
  window.animateShellDestination = (shell, key) => {
    const changed = viewKeys.has(shell) && viewKeys.get(shell) !== key;
    viewKeys.set(shell, key);
    indicators.forEach(indicator => indicator.schedule());
    if (!changed || preference.matches || document.body.classList.contains('reader-active')) return;
    const roots = shell === 'mobile' ? [document.getElementById('mobile-content')] : [...document.querySelectorAll('#desktop-page-header,#desktop-content,#continue-card,#smart-sections,#shelf')];
    for (const root of roots) {
      viewAnimations.get(root)?.cancel();
      if (!root?.getClientRects().length || typeof root.animate !== 'function') continue;
      const animation = root.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 170, easing });
      viewAnimations.set(root, animation);
      animation.finished.then(() => { if (viewAnimations.get(root) === animation) viewAnimations.delete(root); }).catch(() => {});
    }
  };
  preference.addEventListener('change', () => {
    viewAnimations.forEach(animation => animation.cancel()); viewAnimations.clear();
    indicators.forEach(indicator => indicator.update());
  });
  new MutationObserver(() => {
    if (document.body.classList.contains('reader-active')) { viewAnimations.forEach(animation => animation.cancel()); viewAnimations.clear(); }
    indicators.forEach(indicator => indicator.schedule());
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.fonts.ready.then(() => indicators.forEach(indicator => indicator.schedule()));
  window.animateShellDestination('desktop', `${desktopPage}:${desktopSeries || ''}`);
  window.animateShellDestination('mobile', `${mobileRoute.page}:${mobileRoute.value || ''}`);
})();
