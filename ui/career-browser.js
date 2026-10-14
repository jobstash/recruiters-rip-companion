'use strict';
(() => {
  const element = id => document.getElementById(id);
  const categories = {
    sources: { title: 'Sources', empty: 'No saved sources. Imported source documents will appear here.' },
    facts: { title: 'Facts', empty: 'No saved career facts.' },
    rankings: { title: 'Rankings', empty: 'No saved rankings. Saved role assessments and their reasons will appear here.' },
    applications: { title: 'Application drafts', empty: 'No saved application drafts. Saved CV and cover letter wording will appear here.' },
  };
  const categoryButtons = [...document.querySelectorAll('[data-career-kind]')];
  const records = element('career-records');
  const listStatus = element('career-list-status');
  const listRetry = element('career-list-retry');
  const pagination = element('career-pagination');
  const previous = element('career-previous');
  const next = element('career-next');
  const reader = element('career-reader');
  const readerTitle = element('career-reader-title');
  const readerStatus = element('career-reader-status');
  const readerRetry = element('career-reader-retry');
  const content = element('career-reader-content');
  let enabled = false;
  let kind = 'sources';
  let generation = 0;
  let readGeneration = 0;
  let offset = 0;
  let nextOffset = null;
  let priorOffsets = [];
  let loading = false;
  let selected = null;
  let selectedButton = null;

  async function request(operation, args) {
    const response = await window.companion.invoke(operation, args);
    if (!response?.ok) throw new Error(response?.error?.message || 'The saved data could not be read.');
    return response.result;
  }

  function closeReader(restoreFocus = false) {
    readGeneration += 1;
    const returnTo = selectedButton;
    selected = null;
    selectedButton = null;
    reader.hidden = true;
    readerTitle.textContent = '';
    readerStatus.textContent = '';
    content.replaceChildren();
    readerRetry.hidden = true;
    reader.removeAttribute('aria-busy');
    records.querySelectorAll('[aria-current]').forEach(button => button.removeAttribute('aria-current'));
    if (restoreFocus && returnTo?.isConnected) returnTo.focus();
  }

  function renderDetail(detail) {
    readerTitle.textContent = typeof detail?.title === 'string' ? detail.title : selected.title;
    const sections = Array.isArray(detail?.sections) ? detail.sections : [];
    content.replaceChildren();
    for (const section of sections) {
      if (typeof section?.text !== 'string') continue;
      const block = document.createElement('section');
      if (typeof section.heading === 'string' && section.heading) {
        const heading = document.createElement('h4');
        heading.textContent = section.heading;
        block.append(heading);
      }
      const text = document.createElement('p');
      text.textContent = section.text || 'No saved text in this section.';
      block.append(text);
      content.append(block);
    }
    readerStatus.textContent = content.childElementCount ? '' : 'No saved content is available for this record.';
  }

  async function openRecord(item, button, focus = true) {
    if (!enabled || loading) return;
    closeReader();
    selected = item;
    selectedButton = button;
    button.setAttribute('aria-current', 'true');
    reader.hidden = false;
    readerTitle.textContent = item.title;
    if (focus) readerTitle.focus();
    const currentGeneration = generation;
    const currentRead = ++readGeneration;
    const currentKind = kind;
    readerStatus.textContent = 'Loading saved content…';
    reader.setAttribute('aria-busy', 'true');
    try {
      const detail = Array.isArray(item.sections)
        ? item
        : await request('career-read', { kind: currentKind, id: item.id });
      if (!enabled || currentGeneration !== generation || currentRead !== readGeneration) return;
      renderDetail(detail);
    } catch (error) {
      if (!enabled || currentGeneration !== generation || currentRead !== readGeneration) return;
      readerStatus.textContent = `Could not open this record. ${error.message} Retry to load it again.`;
      readerRetry.hidden = false;
    } finally {
      if (currentGeneration === generation && currentRead === readGeneration) reader.removeAttribute('aria-busy');
    }
  }

  async function loadPage(focusList = false) {
    if (!enabled) return;
    const currentGeneration = ++generation;
    closeReader();
    loading = true;
    nextOffset = null;
    records.replaceChildren();
    records.hidden = true;
    records.setAttribute('aria-busy', 'true');
    listRetry.hidden = true;
    pagination.hidden = true;
    previous.disabled = true;
    next.disabled = true;
    const category = categories[kind];
    element('career-list-title').textContent = category.title;
    listStatus.textContent = `Loading ${category.title.toLowerCase()}…`;
    try {
      const result = await request('career-list', { kind, offset, limit: 25 });
      if (!enabled || currentGeneration !== generation) return;
      for (const item of result.items) {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'career-record';
        button.setAttribute('aria-controls', 'career-reader');
        const title = document.createElement('span');
        title.className = 'career-record-title';
        title.textContent = item.title;
        button.append(title);
        if (typeof item.summary === 'string' && item.summary) {
          const summary = document.createElement('span');
          summary.className = 'career-record-summary';
          summary.textContent = item.summary;
          button.append(summary);
        }
        button.addEventListener('click', () => { void openRecord(item, button); });
        row.append(button);
        records.append(row);
      }
      nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
      records.hidden = result.items.length === 0;
      listStatus.textContent = result.items.length
        ? `Showing ${offset + 1}–${offset + result.items.length} of ${result.total}. Select a record to read it.`
        : offset ? 'No records remain on this page. Return to the previous page.' : category.empty;
      previous.disabled = priorOffsets.length === 0;
      next.disabled = nextOffset === null;
      pagination.hidden = previous.disabled && next.disabled;
      if (focusList) {
        const target = records.querySelector('button') || element('career-list-title');
        target.setAttribute('tabindex', target.tagName === 'BUTTON' ? '0' : '-1');
        target.focus();
      }
    } catch (error) {
      if (!enabled || currentGeneration !== generation) return;
      records.replaceChildren();
      records.hidden = true;
      listStatus.textContent = `Could not load ${category.title.toLowerCase()}. ${error.message} Retry to load them again.`;
      listRetry.hidden = false;
      previous.disabled = priorOffsets.length === 0;
      pagination.hidden = previous.disabled;
    } finally {
      if (currentGeneration === generation) {
        loading = false;
        records.removeAttribute('aria-busy');
      }
    }
  }

  categoryButtons.forEach(button => button.addEventListener('click', () => {
    if (!enabled || button.dataset.careerKind === kind) return;
    kind = button.dataset.careerKind;
    categoryButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
    offset = 0;
    priorOffsets = [];
    void loadPage();
  }));
  previous.addEventListener('click', () => {
    if (!enabled || loading || !priorOffsets.length) return;
    offset = priorOffsets.pop();
    void loadPage(true);
  });
  next.addEventListener('click', () => {
    if (!enabled || loading || nextOffset === null) return;
    priorOffsets.push(offset);
    offset = nextOffset;
    void loadPage(true);
  });
  listRetry.addEventListener('click', () => { void loadPage(true); });
  readerRetry.addEventListener('click', () => {
    if (selected && selectedButton) void openRecord(selected, selectedButton);
  });
  element('career-close').addEventListener('click', () => closeReader(true));
  reader.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeReader(true); }
  });

  window.careerBrowser = {
    refresh() {
      enabled = true;
      categoryButtons.forEach(button => { button.disabled = false; });
      offset = 0;
      priorOffsets = [];
      return loadPage();
    },
    clear() {
      enabled = false;
      generation += 1;
      loading = false;
      closeReader();
      offset = 0;
      priorOffsets = [];
      nextOffset = null;
      categoryButtons.forEach(button => { button.disabled = true; });
      records.replaceChildren();
      records.hidden = true;
      records.removeAttribute('aria-busy');
      listStatus.textContent = 'Open local storage to read saved records.';
      listRetry.hidden = true;
      pagination.hidden = true;
      previous.disabled = true;
      next.disabled = true;
    },
  };
})();
