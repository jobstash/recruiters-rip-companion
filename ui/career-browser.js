'use strict';
(() => {
  const categories = {
    sources: { title: 'CVs', empty: 'No saved CVs or supporting documents. Use Import CV to add one.', locked: 'Open local storage to read saved records.', select: 'Select a record' },
    facts: { title: 'Facts', empty: 'No saved career facts.', locked: 'Open local storage to read saved records.', select: 'Select a record' },
    jobs: { title: 'Jobs', empty: 'No saved jobs. Copy the review prompt into your connected agent to start matching.', locked: 'Open local storage to read saved jobs.', select: 'Select a job' },
    applications: { title: 'Job Applications', empty: 'No saved applications.', locked: 'Open local storage to read saved applications.', select: 'Select an application' },
  };
  // Operational words for unscored cards; a scored card shows one number captioned by its source.
  const scoreCaptions = { unscored: 'Not scored', unavailable: 'Advert unavailable', refused: 'Declined', oversize: 'Too large' };
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
  const displayDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : null;
  // Wide windows show the list and reader side by side, so the first record opens automatically.
  const sideBySide = window.matchMedia('(min-width: 760px)');
  const node = (tag, className, text) => {
    const created = document.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  function scoreCaption(score) {
    if (score.value === null) return scoreCaptions[score.status] ?? 'Not scored';
    const source = score.source === 'reviewed' ? ['Reviewed', score.decision].filter(Boolean).join(' · ') : 'Pre-filter';
    return score.stale ? `${source} · out of date` : source;
  }
  function scoreSpoken(score) {
    if (score.value === null) return scoreCaption(score).toLowerCase();
    const source = score.source === 'reviewed' ? 'reviewed' : 'pre-filter';
    return [`${source} score ${score.value} of 100`, score.decision, score.stale ? 'out of date' : null].filter(Boolean).join(', ');
  }
  function renderCard(card, button) {
    const date = displayDate(card.publishedAt);
    const body = node('span', 'career-card-body');
    body.append(node('span', 'career-record-title', card.title));
    const meta = node('span', 'career-card-meta');
    if (card.company) meta.append(node('span', 'career-card-company', card.company));
    meta.append(node('span', 'career-card-date', date ? `Published ${date}` : 'Publication date not stated'));
    body.append(meta);
    const chips = Array.isArray(card.chips) ? card.chips.filter(chip => typeof chip?.text === 'string' && chip.text) : [];
    if (chips.length) {
      const list = node('ul', 'career-card-chips');
      for (const chip of chips) {
        const item = node('li', 'career-chip', chip.text);
        item.dataset.kind = chip.kind;
        list.append(item);
      }
      body.append(list);
    }
    const score = node('span', 'career-card-score');
    score.append(node('span', 'career-card-score-value', card.score.value === null ? '—' : String(card.score.value)),
      node('span', 'career-card-score-caption', scoreCaption(card.score)));
    button.append(body, score);
    button.setAttribute('aria-label', [card.title, card.company, scoreSpoken(card.score),
      date ? `published ${date}` : 'publication date not stated'].filter(Boolean).join(', '));
  }
  function renderRow(item, button) {
    if (item.card && typeof item.card === 'object') { renderCard(item.card, button); return; }
    button.append(node('span', 'career-record-title', item.title));
    if (typeof item.summary === 'string' && item.summary) button.append(node('span', 'career-record-summary', item.summary));
  }

  /** One list + reader pair. `persistentReader` keeps the reader column rendered on wide screens.
   *  `jobControls` are shown only while the jobs kind is active; sort and Clear are also disabled otherwise. */
  function createBrowser({ root, prefix, kind: initialKind, persistentReader = false, sortControl = null, deleteRankings = null, jobControls = [] }) {
    const element = name => document.getElementById(`${prefix}-${name}`);
    const categoryButtons = [...root.querySelectorAll('[data-career-kind]')];
    const records = element('records');
    const listStatus = element('list-status');
    const listRetry = element('list-retry');
    const pagination = element('pagination');
    const previous = element('previous');
    const next = element('next');
    const reader = element('reader');
    const readerTitle = element('reader-title');
    const readerStatus = element('reader-status');
    const readerRetry = element('reader-retry');
    const content = element('reader-content');
    const sortSelect = sortControl ? element('sort') : null;
    const persistent = () => persistentReader && sideBySide.matches;
    let enabled = false;
    let kind = initialKind;
    let sort = 'score';
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
      reader.hidden = !persistent();
      readerTitle.textContent = '';
      root.classList.remove('is-reading');
      readerStatus.textContent = persistent() ? categories[kind].select : '';
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

    function showJobActions() {
      const active = kind === 'jobs';
      for (const control of jobControls) control.hidden = !active;
      if (deleteRankings) deleteRankings.disabled = !enabled || !active;
      if (sortSelect) sortSelect.disabled = !enabled || !active;
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
      // The pagination bar keeps its place while a page loads; only its buttons change state.
      previous.disabled = true;
      next.disabled = true;
      const category = categories[kind];
      listStatus.textContent = `Loading ${category.title.toLowerCase()}…`;
      let firstRecord = null;
      try {
        const result = await request('career-list', { kind, offset, limit: 25, ...(kind === 'jobs' ? { sort } : {}) });
        if (!enabled || currentGeneration !== generation) return;
        for (const item of result.items) {
          const row = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'career-record';
          button.setAttribute('aria-controls', `${prefix}-reader`);
          renderRow(item, button);
          button.addEventListener('click', () => { void openRecord(item, button); });
          firstRecord ??= { item, button };
          row.append(button);
          records.append(row);
        }
        nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
        records.hidden = result.items.length === 0;
        listStatus.textContent = result.items.length
          ? `${(offset + 1).toLocaleString('en-GB')}–${(offset + result.items.length).toLocaleString('en-GB')} of ${result.total.toLocaleString('en-GB')}`
          : offset ? 'No records on this page. Choose Previous.' : category.empty;
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
      // Side-by-side layouts always show a record, including after Next/Previous; focus stays where the user put it.
      if (firstRecord && enabled && currentGeneration === generation && sideBySide.matches) {
        void openRecord(firstRecord.item, firstRecord.button, false);
      }
    }

    categoryButtons.forEach(button => button.addEventListener('click', () => {
      if (!enabled || button.dataset.careerKind === kind) return;
      kind = button.dataset.careerKind;
      categoryButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      offset = 0;
      priorOffsets = [];
      showJobActions();
      void loadPage();
    }));
    sortSelect?.addEventListener('change', () => {
      if (!enabled || kind !== 'jobs' || !['score', 'recent'].includes(sortSelect.value) || sortSelect.value === sort) return;
      sort = sortSelect.value;
      offset = 0;
      priorOffsets = [];
      void loadPage();
    });
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
    element('close').addEventListener('click', () => closeReader(true));
    reader.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeReader(true); }
    });
    if (persistentReader) sideBySide.addEventListener?.('change', () => { if (!selected) closeReader(); });

    return {
      refresh() {
        enabled = true;
        categoryButtons.forEach(button => { button.disabled = false; });
        offset = 0;
        priorOffsets = [];
        showJobActions();
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
        listStatus.textContent = categories[kind].locked;
        listRetry.hidden = true;
        pagination.hidden = true;
        previous.disabled = true;
        next.disabled = true;
        showJobActions();
      },
    };
  }

  // Me browses CVs and facts; the Jobs tab switches one list + reader between ranked jobs and applications.
  const me = createBrowser({ root: document.getElementById('me-browser'), prefix: 'me', kind: 'sources' });
  const jobs = createBrowser({
    root: document.getElementById('career-browser'), prefix: 'career', kind: 'jobs', persistentReader: true,
    sortControl: document.getElementById('career-sort-control'), deleteRankings: document.getElementById('delete-rankings'),
    jobControls: [document.getElementById('prefilter-controls'), document.getElementById('career-sort-control'), document.getElementById('delete-rankings')],
  });
  window.careerBrowser = {
    refresh() { return Promise.all([me.refresh(), jobs.refresh()]); },
    clear() { me.clear(); jobs.clear(); },
  };
})();
