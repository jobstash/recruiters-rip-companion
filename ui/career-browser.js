'use strict';
(() => {
  const element = id => document.getElementById(id);
  const categories = {
    sources: { title: 'CVs', empty: 'No saved CVs or supporting documents. Use Import CV to add one.' },
    facts: { title: 'Facts', empty: 'No saved career facts.' },
    jobs: { title: 'Jobs', empty: 'No saved jobs. Start a pre-scan or copy the review prompt for your connected chat app.' },
    applications: { title: 'Job Applications', empty: 'No saved applications. Saved CV and cover letter wording will appear here.' },
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
  const root = element('career-browser');
  const deleteRankings = element('delete-rankings');
  // Wide windows show the list and reader side by side, so the first record opens automatically.
  const sideBySide = window.matchMedia('(min-width: 760px)');
  let enabled = false;
  let kind = 'jobs';
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
    root.classList.remove('is-reading');
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
      const hasFields = Array.isArray(section?.fields) && section.fields.length;
      if (!hasFields && typeof section?.text !== 'string') continue;
      const block = document.createElement('section');
      if (typeof section.heading === 'string' && section.heading) {
        const heading = document.createElement('h3');
        heading.textContent = section.heading;
        block.append(heading);
      }
      if (hasFields) {
        const list = document.createElement('dl');
        for (const field of section.fields) {
          if (typeof field?.label !== 'string' || typeof field?.value !== 'string') continue;
          const term = document.createElement('dt');
          term.textContent = field.label;
          const value = document.createElement('dd');
          value.textContent = field.value;
          if (field.numeric === true) value.className = 'numeric';
          list.append(term, value);
        }
        block.append(list);
      } else {
        const text = document.createElement('p');
        text.textContent = section.text || 'No saved text in this section.';
        block.append(text);
      }
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
    root.classList.add('is-reading');
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

  function showCategoryActions() {
    deleteRankings.hidden = !enabled || kind !== 'jobs';
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
    listStatus.textContent = `Loading ${category.title.toLowerCase()}…`;
    let firstRecord = null;
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
        firstRecord ??= { item, button };
        row.append(button);
        records.append(row);
      }
      nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
      records.hidden = result.items.length === 0;
      listStatus.textContent = result.items.length
        ? `${offset + 1}–${offset + result.items.length} of ${result.total}`
        : offset ? 'No records remain on this page. Return to the previous page.' : category.empty;
      previous.disabled = priorOffsets.length === 0;
      next.disabled = nextOffset === null;
      pagination.hidden = previous.disabled && next.disabled;
      if (focusList) {
        const target = records.querySelector('button') || listStatus;
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
    if (firstRecord && enabled && currentGeneration === generation && sideBySide.matches && !focusList) {
      void openRecord(firstRecord.item, firstRecord.button, false);
    }
  }

  categoryButtons.forEach(button => button.addEventListener('click', () => {
    if (!enabled || button.dataset.careerKind === kind) return;
    kind = button.dataset.careerKind;
    categoryButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
    offset = 0;
    priorOffsets = [];
    showCategoryActions();
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
      showCategoryActions();
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
      showCategoryActions();
    },
  };
})();
