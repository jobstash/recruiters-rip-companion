'use strict';
(() => {
  const categories = {
    sources: { title: 'CVs', empty: 'No saved CVs or supporting documents. Use Import CV to add one.', locked: 'Open local storage to read saved records.', select: 'Select a record' },
    facts: { title: 'Facts', empty: 'No saved career facts.', locked: 'Open local storage to read saved records.', select: 'Select a record' },
    jobs: { title: 'Jobs', empty: 'No saved jobs. Copy the review prompt into your connected agent to start matching.', locked: 'Open local storage to read saved jobs.', select: 'Select a job' },
    applications: { title: 'Job Applications', empty: 'No saved applications.', locked: 'Open local storage to read saved applications.', select: 'Select an application' },
    blocks: { title: 'Blocked jobs', empty: 'Nothing blocked. Open a job to block it, its company or its category.', locked: 'Open local storage to read blocked jobs.', select: 'Select a block' },
  };
  // Why an unscored job has no rank; the pre-filter never shows a number, only whether the job is in the next run.
  const statusWords = { unavailable: 'Advert unavailable', refused: 'Declined', oversize: 'Too large' };
  const statusWord = card => statusWords[card.status] ?? 'Not pre-filtered';
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
  const displayDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : null;
  const integer = value => value.toLocaleString('en-GB');
  // Wide windows show the list and reader side by side, so the first record opens automatically.
  const sideBySide = window.matchMedia('(min-width: 760px)');
  const node = (tag, className, text) => {
    const created = document.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  function cardSpoken(card, date) {
    const stage = card.stage === 'reviewed'
      ? [`fit ${card.score === null ? 'not saved' : `${card.score} of 100`}`, card.stale ? 'out of date' : null]
      : card.stage === 'prefilter'
        ? [card.rank === null ? null : `rank ${card.rank}`, card.included ? 'in next run' : 'not in next run', card.overridden ? 'manual' : null]
        : [statusWord(card).toLowerCase(), card.included ? 'in next run' : 'not in next run'];
    return [card.title, card.company, ...stage, date ? `published ${date}` : 'publication date not stated'].filter(Boolean).join(', ');
  }
  /** Body goes inside the record button; the right column (fit number or the next-run switch) is a sibling so the
   *  checkbox is never nested inside the button. */
  function renderCard(item, button, side, onInclude) {
    const card = item.card;
    const date = displayDate(card.publishedAt);
    const body = node('span', 'career-card-body');
    body.append(node('span', 'career-record-title', card.title));
    const meta = node('span', 'career-card-meta');
    if (card.company) meta.append(node('span', 'career-card-company', card.company));
    meta.append(node('span', 'career-card-date', date ? `Published ${date}` : 'Publication date not stated'));
    body.append(meta);
    const facts = Array.isArray(card.facts) ? card.facts.filter(fact => typeof fact === 'string' && fact) : [];
    if (facts.length) body.append(node('span', 'career-card-facts', facts.join(' · ')));
    button.append(body);
    button.setAttribute('aria-label', cardSpoken(card, date));

    if (card.stage === 'reviewed') {
      side.append(node('span', 'career-card-fit', card.score === null ? '—' : String(card.score)),
        node('span', 'career-card-caption', card.stale ? 'Fit · out of date' : 'Fit'));
      return;
    }
    const label = node('label', 'career-card-include');
    const checkbox = node('input', 'career-include');
    checkbox.type = 'checkbox';
    checkbox.checked = card.included === true;
    checkbox.setAttribute('aria-label', `Include ${card.title} in the next agent run`);
    checkbox.dataset.id = item.id;
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', event => { void onInclude(item, event.target.checked, event.target); });
    label.addEventListener('click', event => event.stopPropagation());
    label.append(checkbox, node('span', 'career-card-caption', 'In next run'));
    side.append(label);
    if (card.stage === 'unscored') side.append(node('span', 'career-card-caption', statusWord(card)));
    if (card.overridden) side.append(node('span', 'career-card-caption', 'manual'));
  }
  function renderRow(item, button) {
    button.append(node('span', 'career-record-title', item.title));
    if (typeof item.summary === 'string' && item.summary) button.append(node('span', 'career-record-summary', item.summary));
  }

  /** One list + reader pair. `persistentReader` keeps the reader column rendered on wide screens.
   *  `jobControls` are shown only while the jobs kind is active; sort, the minimum-score slider and Clear are also disabled otherwise. */
  function createBrowser({ root, prefix, kind: initialKind, persistentReader = false, sortControl = null, surfaceControl = null, deleteRankings = null, jobControls = [] }) {
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
    const slider = surfaceControl ? element('minimum-score') : null;
    const sliderValue = surfaceControl ? element('minimum-score-value') : null;
    const surfaceSentence = surfaceControl ? element('surface-sentence') : null;
    const persistent = () => persistentReader && sideBySide.matches;
    let enabled = false;
    let kind = initialKind;
    let sort = 'rank';
    let generation = 0;
    let readGeneration = 0;
    let offset = 0;
    let nextOffset = null;
    let priorOffsets = [];
    let loading = false;
    let selected = null;
    let selectedButton = null;
    let minimumScore = null;
    // Set by an inclusion edit; the refresh that follows keeps the page, the open record and the toggled control.
    let keepPlace = null;

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

    // Inclusion is user-owned: the companion records the choice, then the state broadcast reloads this list in place.
    async function setInclusion(item, included, control = null) {
      if (!enabled) return;
      keepPlace = { offset, priorOffsets: [...priorOffsets], selectedId: selected?.id ?? item.id, focusId: control ? item.id : null };
      try {
        await request('prescan-include', { id: item.id, included });
      } catch (error) {
        keepPlace = null;
        if (control) control.checked = item.card.included === true;
        listStatus.textContent = `Could not change the next run. ${error.message}`;
      }
    }

    // Blocking hides matching jobs from the list, so the refresh that follows keeps the page and focuses the list.
    async function changeBlock(operation, args, notice) {
      if (!enabled) return;
      keepPlace = { offset, priorOffsets: [...priorOffsets], selectedId: null, focusId: null, focusList: true, notice };
      try {
        await request(operation, args);
      } catch (error) {
        keepPlace = null;
        listStatus.textContent = `Could not change blocked jobs. ${error.message}`;
      }
    }
    function blockButton(text, label, onClick, className = 'ghost') {
      const button = node('button', className, text);
      button.type = 'button';
      if (label) button.setAttribute('aria-label', label);
      button.addEventListener('click', event => { event.stopPropagation(); void onClick(); });
      return button;
    }
    function removeBlock(item) {
      return changeBlock('job-unblock', { id: item.id }, `Unblocked ${item.title}`);
    }
    // Jobs offer to block the job, its company or its category; a block's reader offers to remove it.
    function renderBlockActions(item) {
      const block = item?.block;
      if (!block || typeof block !== 'object') return null;
      const section = node('section', 'career-block');
      if (kind === 'blocks') {
        section.append(blockButton('Remove block', `Remove block ${item.title}`, () => removeBlock(item)));
        return section;
      }
      if (kind !== 'jobs') return null;
      const title = item.card?.title ?? item.title;
      const actions = node('div', 'actions');
      actions.append(blockButton('Block this job', `Block ${title}`,
        () => changeBlock('job-block', { id: item.id, kind: 'job' }, `Blocked ${title}`)));
      if (typeof block.company === 'string' && block.company) actions.append(blockButton(`Block all ${block.company} jobs`, null,
        () => changeBlock('job-block', { id: item.id, kind: 'company' }, `Blocked ${block.company}`)));
      if (typeof block.category === 'string' && block.category) actions.append(blockButton(`Block all ${block.category} jobs`, null,
        () => changeBlock('job-block', { id: item.id, kind: 'category' }, `Blocked ${block.category}`)));
      section.append(node('h3', '', 'Block from evaluation'), actions);
      return section;
    }

    function renderInclusion(item) {
      const card = item?.card;
      if (!card || card.stage === 'reviewed') return null;
      const block = document.createElement('section');
      block.className = 'career-next-run';
      const heading = document.createElement('h3');
      heading.textContent = 'Next run';
      const list = document.createElement('dl');
      const term = document.createElement('dt');
      term.textContent = 'Agent evaluation';
      const value = document.createElement('dd');
      value.textContent = `${card.included ? 'Included' : 'Excluded'}${card.overridden ? ' (manual)' : ''}`;
      list.append(term, value);
      block.append(heading, list);
      if (card.overridden) {
        const reset = node('button', 'text', 'Reset to minimum score');
        reset.type = 'button';
        reset.id = `${prefix}-inclusion-reset`;
        reset.addEventListener('click', () => { void setInclusion(item, null); });
        block.append(reset);
      }
      return block;
    }

    // Fit chart: one filled bar per dimension on a muted track; Overall first and heavier. Values are whole 0–100 scores.
    function renderChart(rows) {
      const chart = node('div', 'career-chart');
      rows.forEach((entry, index) => {
        if (typeof entry?.label !== 'string' || !Number.isInteger(entry?.value)) return;
        const value = Math.min(100, Math.max(0, entry.value));
        const row = node('div', index === 0 ? 'career-chart-row is-overall' : 'career-chart-row');
        const track = node('span', 'career-chart-track');
        track.setAttribute('aria-hidden', 'true');
        const fill = node('span', 'career-chart-fill');
        fill.style.width = `${value}%`;
        track.append(fill);
        row.append(node('span', 'career-chart-label', entry.label), track, node('span', 'career-chart-value', String(value)));
        chart.append(row);
      });
      return chart;
    }
    function renderDetail(detail, item) {
      readerTitle.textContent = typeof detail?.title === 'string' ? detail.title : selected.title;
      const sections = Array.isArray(detail?.sections) ? detail.sections : [];
      content.replaceChildren();
      const inclusion = renderInclusion(item);
      if (inclusion) content.append(inclusion);
      const blockActions = kind === 'jobs' ? renderBlockActions(item) : null;
      if (blockActions) content.append(blockActions);
      for (const section of sections) {
        const hasFields = Array.isArray(section?.fields) && section.fields.length;
        const hasChart = Array.isArray(section?.chart) && section.chart.length;
        if (!hasFields && !hasChart && typeof section?.text !== 'string') continue;
        const block = document.createElement('section');
        if (typeof section.heading === 'string' && section.heading) {
          const heading = document.createElement('h3');
          heading.textContent = section.heading;
          block.append(heading);
        }
        if (hasChart) {
          block.append(renderChart(section.chart));
        } else if (hasFields) {
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
      const removal = kind === 'blocks' ? renderBlockActions(item) : null;
      if (removal) content.append(removal);
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
        renderDetail(detail, item);
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
      if (slider) slider.disabled = !enabled || !active;
    }
    function showSliderValue(value) {
      slider.value = String(value);
      slider.setAttribute('aria-valuetext', `Minimum score ${value}`);
      sliderValue.textContent = String(value);
    }
    // The surface block states what the slider decides: how many of the unreviewed jobs the agent will receive.
    function renderSurface(inclusion) {
      minimumScore = inclusion.minimumScore;
      if (document.activeElement !== slider) showSliderValue(inclusion.minimumScore);
      const jobs = `${integer(inclusion.candidates)} ${inclusion.candidates === 1 ? 'job' : 'jobs'}`;
      surfaceSentence.textContent = inclusion.scored === null
        ? `All ${jobs} will be sent`
        : `${integer(inclusion.included)} of ${jobs} will be sent to the agent${inclusion.stale ? ' · ranked before your profile changed; pre-filter again to update' : ''}`;
    }
    function renderCutoff(inclusion, index) {
      const divider = document.createElement('li');
      divider.className = 'career-cutoff';
      divider.append(node('span', 'career-cutoff-text', `Below minimum score ${inclusion.minimumScore} · not sent to the agent`));
      if (slider) {
        const change = node('button', 'text', 'Change');
        change.type = 'button';
        change.addEventListener('click', () => slider.focus());
        divider.append(change);
      }
      divider.dataset.index = String(index);
      return divider;
    }
    async function loadPage(focusList = false, place = null) {
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
      let reopen = null;
      let refocus = null;
      try {
        const result = await request('career-list', { kind, offset, limit: 25, ...(kind === 'jobs' ? { sort } : {}) });
        if (!enabled || currentGeneration !== generation) return;
        const inclusion = kind === 'jobs' && result.inclusion && typeof result.inclusion === 'object' ? result.inclusion : null;
        const cutoffIndex = inclusion && sort === 'rank' && Number.isInteger(result.cutoffIndex) ? result.cutoffIndex : null;
        result.items.forEach((item, index) => {
          if (cutoffIndex === index) records.append(renderCutoff(inclusion, index));
          const row = document.createElement('li');
          row.className = 'career-row';
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'career-record';
          button.setAttribute('aria-controls', `${prefix}-reader`);
          if (item.card && typeof item.card === 'object') {
            row.className = 'career-row career-card';
            const side = node('span', 'career-card-side');
            renderCard(item, button, side, setInclusion);
            row.append(button, side);
            if (place?.focusId === item.id) refocus = side.querySelector('input');
          } else {
            renderRow(item, button);
            row.append(button);
            if (kind === 'blocks') row.append(blockButton('Remove', `Remove block ${item.title}`, () => removeBlock(item), 'text career-row-action'));
          }
          button.addEventListener('click', () => { void openRecord(item, button); });
          firstRecord ??= { item, button };
          if (place?.selectedId === item.id) reopen = { item, button };
          records.append(row);
        });
        if (cutoffIndex === result.items.length) records.append(renderCutoff(inclusion, cutoffIndex));
        nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
        records.hidden = result.items.length === 0;
        const range = `${integer(offset + 1)}–${integer(offset + result.items.length)} of ${integer(result.total)}`;
        listStatus.textContent = result.items.length
          ? inclusion ? `${range} · ${integer(inclusion.included)} sent to the agent` : range
          : offset ? 'No records on this page. Choose Previous.' : category.empty;
        if (typeof place?.notice === 'string' && place.notice) listStatus.textContent = `${place.notice} · ${listStatus.textContent}`;
        if (slider && inclusion) renderSurface(inclusion);
        previous.disabled = priorOffsets.length === 0;
        next.disabled = nextOffset === null;
        pagination.hidden = previous.disabled && next.disabled;
        if (focusList || place?.focusList) {
          const target = records.querySelector('.career-record') || listStatus;
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
      if (!enabled || currentGeneration !== generation) return;
      // An inclusion edit reopens the record the user had open; otherwise side-by-side layouts show the first record.
      const open = reopen ?? (sideBySide.matches ? firstRecord : null);
      if (open) void openRecord(open.item, open.button, false);
      if (refocus) refocus.focus();
    }

    function resetPlace() {
      offset = 0;
      priorOffsets = [];
      keepPlace = null;
    }
    categoryButtons.forEach(button => button.addEventListener('click', () => {
      if (!enabled || button.dataset.careerKind === kind) return;
      kind = button.dataset.careerKind;
      categoryButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      resetPlace();
      showJobActions();
      void loadPage();
    }));
    sortSelect?.addEventListener('change', () => {
      if (!enabled || kind !== 'jobs' || !['rank', 'recent'].includes(sortSelect.value) || sortSelect.value === sort) return;
      sort = sortSelect.value;
      resetPlace();
      void loadPage();
    });
    // Dragging only moves the number; the threshold is saved once on change so the list does not reload mid-drag.
    slider?.addEventListener('input', () => { showSliderValue(Number.parseInt(slider.value, 10)); });
    slider?.addEventListener('change', () => {
      if (!enabled || kind !== 'jobs') return;
      const value = Number.parseInt(slider.value, 10);
      if (!Number.isInteger(value) || value < 0 || value > 100) { if (minimumScore !== null) showSliderValue(minimumScore); return; }
      if (value === minimumScore) return;
      keepPlace = { offset, priorOffsets: [...priorOffsets], selectedId: selected?.id ?? null, focusId: null };
      request('prescan-threshold', { minimumScore: value }).catch(error => {
        keepPlace = null;
        if (minimumScore !== null) showSliderValue(minimumScore);
        listStatus.textContent = `Could not change the minimum score. ${error.message}`;
      });
    });
    previous.addEventListener('click', () => {
      if (!enabled || loading || !priorOffsets.length) return;
      offset = priorOffsets.pop();
      keepPlace = null;
      void loadPage(true);
    });
    next.addEventListener('click', () => {
      if (!enabled || loading || nextOffset === null) return;
      priorOffsets.push(offset);
      offset = nextOffset;
      keepPlace = null;
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
        const place = keepPlace;
        keepPlace = null;
        if (place) { offset = place.offset; priorOffsets = place.priorOffsets; }
        else { offset = 0; priorOffsets = []; }
        showJobActions();
        return loadPage(false, place);
      },
      clear() {
        enabled = false;
        generation += 1;
        loading = false;
        closeReader();
        resetPlace();
        nextOffset = null;
        minimumScore = null;
        if (surfaceSentence) surfaceSentence.textContent = '';
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
    sortControl: document.getElementById('career-sort-control'), surfaceControl: document.getElementById('career-surface'),
    deleteRankings: document.getElementById('delete-rankings'),
    jobControls: [document.getElementById('prefilter-controls'), document.getElementById('career-surface'),
      document.getElementById('career-sort-control'), document.getElementById('delete-rankings')],
  });
  window.careerBrowser = {
    refresh() { return Promise.all([me.refresh(), jobs.refresh()]); },
    clear() { me.clear(); jobs.clear(); },
  };
})();
