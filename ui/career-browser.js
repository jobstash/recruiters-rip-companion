'use strict';
(() => {
  const categories = {
    sources: { title: 'CVs', empty: 'No CV added yet. Choose Import CV to add yours.', locked: 'Unlock to see your saved work.', select: 'Select a document' },
    facts: { title: 'Facts', empty: 'No details saved yet. Tell your AI app about your experience.', locked: 'Unlock to see your saved work.', select: 'Select an answer' },
    preferences: { title: 'Preferences', empty: 'No preferences saved. Tell your AI app what you want and what you want to avoid.', locked: 'Unlock to see your saved preferences.', select: 'Select a preference group' },
    career: { title: 'Career', empty: 'No work history saved yet. Ask your AI app to read your CV and add your previous jobs.', locked: 'Unlock to see your work history.', select: 'Select an employer' },
    jobs: { title: 'Jobs', empty: 'No jobs for these dates. Choose a longer date range or continue in Codex or Claude. To connect an AI app, open Settings → AI apps.', locked: 'Unlock to see your saved jobs.', select: 'Select a job' },
    applications: { title: 'Job Applications', empty: 'No saved applications.', locked: 'Unlock to see your saved applications.', select: 'Select an application' },
    blocks: { title: 'Blocked jobs', empty: 'Nothing blocked. Open a job to block it, its company or its category.', locked: 'Unlock to see your blocked jobs.', select: 'Select a block' },
  };
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
      : card.stage === 'ineligible' ? ['not eligible', card.label] : ['not reviewed yet'];
    return [card.title, card.company, ...stage, date ? `published ${date}` : 'publication date not stated'].filter(Boolean).join(', ');
  }
  /** Row anatomy, left to right: the record button with the company mark and three text lines, then the agent's fit or
   *  verdict when one exists. Open jobs carry nothing on the right: there is nothing to say yet. */
  function renderLogo(card) {
    const mark = node('span', 'career-card-mark');
    const initial = (card.company ?? '').trim().charAt(0).toUpperCase();
    mark.textContent = initial || '·';
    if (typeof card.logoUrl === 'string' && card.logoUrl.startsWith('https://')) {
      const image = document.createElement('img');
      image.className = 'career-card-logo';
      image.alt = '';
      image.decoding = 'async';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = card.logoUrl;
      mark.append(image);
    }
    return mark;
  }
  function renderCard(item, button, side) {
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
    button.append(renderLogo(card), body);
    button.setAttribute('aria-label', cardSpoken(card, date));

    if (card.stage === 'reviewed') {
      side.append(node('span', 'career-card-figure', card.score === null ? '—' : String(card.score)),
        node('span', 'career-card-caption', card.stale ? 'Fit · out of date' : 'Fit'));
      return;
    }
    // Ineligible: the saved verdict is the whole column; no number, no switch.
    if (card.stage === 'ineligible') {
      side.append(node('span', 'career-card-caption career-card-verdict', card.label));
      return;
    }
    // The pre-qualification is a word, never a number: the number only orders the queue.
  }
  function renderRow(item, button) {
    button.append(node('span', 'career-record-title', item.title));
    if (typeof item.summary === 'string' && item.summary) button.append(node('span', 'career-record-summary', item.summary));
  }

  /** One list + reader pair. `persistentReader` keeps the reader column rendered on wide screens.
   *  `stagePanels` show the active jobs view's controls; the pre-qualification switch and Clear reviews are disabled on other tabs. */
  function createBrowser({ root, prefix, kind: initialKind, persistentReader = false, deleteRankings = null, stagePanels = [], publication = null, reviewLaunch = null }) {
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
    const persistent = () => persistentReader && sideBySide.matches;
    let enabled = false;
    let kind = initialKind;
    let view = 'jobs';
    const viewEmpty = { jobs: categories.jobs.empty, reviewed: 'Nothing reviewed yet. Continue in Codex or Claude to review the jobs in this window.' };
    const stageCounts = [...root.querySelectorAll('[data-stage-count]')];
    let generation = 0;
    let readGeneration = 0;
    let offset = 0;
    let nextOffset = null;
    let priorOffsets = [];
    let loading = false;
    let selected = null;
    let selectedButton = null;
    // Set by a block edit; the refresh that follows keeps the page and the open record.
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
    function renderCvDeletion(detail, item) {
      if (kind !== 'sources' || !detail.deletion?.contentHash) return null;
      const section = node('div', 'actions');
      const button = blockButton('Delete CV', `Delete ${item.title}`, async () => {
        if (!enabled || button.disabled) return;
        button.disabled = true;
        const currentGeneration = generation;
        const currentRead = readGeneration;
        readerStatus.textContent = 'Deleting CV…';
        try {
          const result = await request('cv-delete', { sourceId: item.id, contentHash: detail.deletion.contentHash });
          if (!enabled || generation !== currentGeneration || readGeneration !== currentRead) return;
          if (result.cancelled) { readerStatus.textContent = ''; return; }
          if (result.deleted !== true) throw new Error('Companion did not confirm removal.');
          closeReader();
          await loadPage(true);
          listStatus.textContent = 'CV deleted.';
        } catch (error) {
          if (enabled && generation === currentGeneration && readGeneration === currentRead)
            readerStatus.textContent = `CV not deleted. ${error.message}`;
        } finally {
          button.disabled = false;
        }
      }, 'destructive');
      section.append(button);
      return section;
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
        section.append(blockButton('Unblock', `Unblock ${item.title}`, () => removeBlock(item)));
        return section;
      }
      if (kind !== 'jobs') return null;
      const title = item.card?.title ?? item.title;
      const actions = node('div', 'actions');
      actions.append(blockButton('Block job', `Block ${title}`,
        () => changeBlock('job-block', { id: item.id, kind: 'job' }, `Blocked ${title}`)));
      if (typeof block.company === 'string' && block.company) actions.append(blockButton(`Block ${block.company}`, `Block all ${block.company} jobs`,
        () => changeBlock('job-block', { id: item.id, kind: 'company' }, `Blocked ${block.company}`)));
      if (typeof block.category === 'string' && block.category) actions.append(blockButton(`Block ${block.category}`, `Block all ${block.category} jobs`,
        () => changeBlock('job-block', { id: item.id, kind: 'category' }, `Blocked ${block.category}`)));
      section.append(node('h3', '', 'Block from evaluation'), actions);
      return section;
    }
    // Each Career entry can open its employer's ecosystem.vision page; the reader offers it as a named action.
    function renderProfileAction(item, className = 'ghost') {
      if (item?.profileLink !== true) return null;
      const button = blockButton(`Go to ${item.title}'s profile`, null, async () => {
        if (!enabled) return;
        button.disabled = true;
        try { await request('career-open-profile', { id: item.id }); }
        catch (error) { listStatus.textContent = `Could not open ${item.title}'s profile. ${error.message}`; }
        finally { button.disabled = false; }
      }, className);
      return button;
    }

    function renderDocumentActions(detail, item) {
      const documents = Array.isArray(detail?.documents) ? detail.documents : [];
      const hasJobPage = detail?.jobPage === true || Boolean(detail?.header?.applyUrl);
      if (!hasJobPage && !documents.length && !detail?.documentNotice) return null;
      const section = node('section', 'career-files');
      section.append(node('h3', '', hasJobPage ? 'Job and documents' : 'Documents'));
      const group = node('div', 'career-document-actions');
      const recordKind = kind;
      function action(label, actionKind, operation, input, success) {
        const button = blockButton(label, `${label} for ${item.title}`, async () => {
          if (!enabled || button.disabled || !button.isConnected || kind !== recordKind || selected?.id !== item.id) return;
          button.disabled = true;
          const currentRead = readGeneration;
          try {
            await request(operation, { kind: recordKind, id: item.id, ...input });
            if (enabled && kind === recordKind && selected?.id === item.id && currentRead === readGeneration)
              window.showCompanionNotice(success, 'document-open');
          } catch (error) {
            if (enabled && kind === recordKind && selected?.id === item.id && currentRead === readGeneration)
              window.showCompanionNotice(error.message, 'error', true);
          } finally { button.disabled = false; }
        }, 'ghost');
        button.dataset.careerAction = actionKind;
        return button;
      }
      if (hasJobPage) {
        const column = node('div', 'career-document-action');
        column.append(action('Open job', 'job', 'career-open-job', {}, 'Job page opened.'));
        group.append(column);
      }
      for (const saved of documents) {
        const column = node('div', 'career-document-action');
        const date = displayDate(saved.createdAt);
        if (saved.status === 'saved') {
          const button = action(saved.kind === 'cv' ? 'Open CV' : 'Open letter', saved.kind, 'career-open-document',
            { document: saved.kind, token: saved.token }, `${saved.kind === 'cv' ? 'CV' : 'Letter'} opened.`);
          button.dataset.document = saved.kind;
          column.append(button, node('span', 'caption', date ? `Saved ${date}` : 'Saved PDF'));
        } else {
          column.append(node('span', '', saved.kind === 'cv' ? 'CV' : 'Cover letter'),
            node('span', 'caption', saved.status === 'missing' ? 'No saved PDF'
              : [date ? `Saved ${date}` : 'Saved PDF', 'Unavailable'].join(' · ')));
        }
        group.append(column);
      }
      section.append(group);
      if (detail.documentNotice) section.append(node('p', 'caption', detail.documentNotice));
      return section;
    }
    // The verdict block: the number that placed the job in the list, the rule it was measured against, the agent's reason,
    // and — for jobs the agent has not reviewed — the next-run control itself.
    function renderVerdict(detail, item) {
      const verdict = detail?.verdict, card = item?.card;
      if (!verdict || typeof verdict !== 'object') return null;
      const block = node('section', `career-verdict is-${verdict.kind}`);
      const row = node('div', 'career-verdict-row');
      if (Number.isInteger(verdict.number)) {
        const figure = node('div', 'career-verdict-figure');
        figure.append(node('span', 'career-verdict-number', String(verdict.number)), node('span', 'career-card-caption', verdict.numberLabel));
        row.append(figure);
      }
      const words = node('div', 'career-verdict-words');
      words.append(node('h3', 'career-verdict-headline', verdict.headline));
      if (typeof verdict.detail === 'string' && verdict.detail) words.append(node('p', 'career-verdict-detail', verdict.detail));
      row.append(words);
      block.append(row);
      if (typeof verdict.reason === 'string' && verdict.reason) block.append(node('p', 'career-verdict-reason', verdict.reason));
      return block;
    }
    // Keep company, publication and role facts together before the detail action group.
    function renderHeader(detail) {
      const header = detail?.header;
      if (!header || typeof header !== 'object') return null;
      const block = node('div', 'career-reader-meta');
      const top = node('div', 'career-reader-meta-top');
      const line = [header.company, header.published].filter(value => typeof value === 'string' && value).join(' · ');
      if (line) top.append(node('p', 'career-reader-line', line));
      if (top.childElementCount) block.append(top);
      if (Array.isArray(header.facts) && header.facts.length) block.append(node('p', 'career-reader-facts', header.facts.join(' · ')));
      return block.childElementCount ? block : null;
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
    function renderRequirements(requirements, item) {
      const list = node('div', 'career-requirements');
      for (const entry of requirements) {
        if (typeof entry?.requirement !== 'string' || !entry.requirement) continue;
        const row = node('div', 'career-requirement');
        const label = [entry.evidence, entry.importance].filter(value => typeof value === 'string' && value).join(' · ');
        const status = node('p', 'career-requirement-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const button = node('button', 'text', 'Add context');
        button.type = 'button';
        button.addEventListener('click', () => {
          if (!enabled) return;
          button.disabled = true;
          status.textContent = '';
          void request('copy-requirement-prompt', { id: item.id, requirement: entry.requirement })
            .then(() => { status.textContent = 'Prompt copied. Paste it into your connected agent.'; })
            .catch(error => { status.textContent = error.message; })
            .finally(() => { button.disabled = false; });
        });
        button.className = 'career-requirement-action text';
        row.append(node('p', 'career-requirement-label', label), node('p', 'career-requirement-body', entry.requirement), button, status);
        list.append(row);
      }
      return list;
    }
    function renderDetail(detail, item) {
      readerTitle.textContent = typeof detail?.heading === 'string' ? detail.heading : typeof detail?.title === 'string' ? detail.title : selected.title;
      const sections = Array.isArray(detail?.sections) ? detail.sections : [];
      content.replaceChildren();
      const cvDeletion = renderCvDeletion(detail, item);
      if (cvDeletion) content.append(cvDeletion);
      const header = renderHeader(detail);
      if (header) content.append(header);
      const documents = renderDocumentActions(detail, item);
      if (documents && kind !== 'applications') content.append(documents);
      const verdict = renderVerdict(detail, item);
      if (verdict) content.append(verdict);
      for (const section of sections) {
        const hasFields = Array.isArray(section?.fields) && section.fields.length;
        const hasChart = Array.isArray(section?.chart) && section.chart.length;
        const hasRequirements = Array.isArray(section?.requirements) && section.requirements.length;
        if (!hasFields && !hasChart && !hasRequirements && typeof section?.text !== 'string') continue;
        const block = document.createElement('section');
        if (typeof section.heading === 'string' && section.heading) {
          const heading = document.createElement('h3');
          heading.textContent = section.heading;
          block.append(heading);
        }
        if (hasChart) {
          block.append(renderChart(section.chart));
        } else if (hasRequirements) {
          block.append(renderRequirements(section.requirements, item));
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
        if (documents && kind === 'applications' && section === sections[0]) content.append(documents);
      }
      const removal = kind === 'blocks' ? renderBlockActions(item) : null;
      if (removal) content.append(removal);
      const blockActions = kind === 'jobs' ? renderBlockActions(item) : null;
      if (blockActions) content.append(blockActions);
      const profile = kind === 'career' ? renderProfileAction(item) : null;
      if (profile) { const section = node('section', 'career-block'); section.append(profile); content.append(section); }
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
      readerTitle.textContent = item.heading ?? item.title;
      if (focus) readerTitle.focus();
      const currentGeneration = generation;
      const currentRead = ++readGeneration;
      const currentKind = kind;
      readerStatus.textContent = 'Loading saved content…';
      reader.setAttribute('aria-busy', 'true');
      try {
        const detail = currentKind !== 'jobs' && Array.isArray(item.sections)
          ? item
          : await request('career-read', { kind: currentKind, id: item.id });
        if (!enabled || currentGeneration !== generation || currentRead !== readGeneration) return;
        detailSignature = JSON.stringify(detail);
        renderDetail(detail, item);
      } catch (error) {
        if (!enabled || currentGeneration !== generation || currentRead !== readGeneration) return;
        readerStatus.textContent = `Could not open this record. ${error.message} Retry to load it again.`;
        readerRetry.hidden = false;
      } finally {
        if (currentGeneration === generation && currentRead === readGeneration) reader.removeAttribute('aria-busy');
      }
    }

    // Each stage shows only its own controls above the list: the shortlist run, the review handoff, or nothing.
    function showJobActions() {
      const active = kind === 'jobs';
      for (const panel of stagePanels) panel.hidden = !(active && panel.dataset.stagePanel === view);
      if (reviewLaunch) reviewLaunch.hidden = !active;
      if (deleteRankings) { deleteRankings.hidden = !(active && view === 'reviewed'); deleteRankings.disabled = !enabled || !active; }
      if (publication) publication.input.disabled = !enabled || !active;
    }
    function renderCounts(counts) {
      for (const node of stageCounts) {
        const value = counts?.[node.dataset.stageCount];
        node.textContent = Number.isSafeInteger(value) ? ` ${value.toLocaleString('en-GB')}` : '';
      }
    }
    // Publication window: five positions, Today … Past 2 weeks; older saved presets fall back to the widest offered.
    const publicationRanges = [
      ['today', 'Today', 'today'], ['yesterday', 'Yesterday', 'since yesterday'], ['past_3_days', 'Past 3 days', 'in the past 3 days'],
      ['past_week', 'Past week', 'in the past week'], ['past_2_weeks', 'Past 2 weeks', 'in the past 2 weeks'],
    ];
    const rangeIndexFor = value => { const index = publicationRanges.findIndex(([name]) => name === value); return index >= 0 ? index : ['past_month', 'all'].includes(value) ? publicationRanges.length - 1 : 2; };
    let savedRange = null, rangeSaving = false;
    function renderPublication(range) {
      if (!publication || range === undefined) return;
      savedRange = range;
      if (document.activeElement === publication.input && rangeSaving) return;
      const index = rangeIndexFor(range);
      publication.input.value = String(index);
      publication.input.setAttribute('aria-valuetext', publicationRanges[index][1]);
      publication.label.textContent = publicationRanges[index][2];
    }
    // The handoff leads whenever the user's AI app is installed; Copy prompt is the fallback for any other host.
    let review = { hosts: { codex: false, claude: false }, preferredHost: 'codex' };
    function renderReviewLaunch() {
      if (!reviewLaunch) return;
      const installed = ['codex', 'claude'].filter(host => review.hosts?.[host] === true);
      const primaryHost = installed.includes(review.preferredHost) ? review.preferredHost : installed[0] ?? null;
      for (const host of ['codex', 'claude']) {
        const button = reviewLaunch.querySelector(`#review-${host}`);
        button.hidden = !installed.includes(host);
        button.classList.toggle('primary', host === primaryHost); button.classList.toggle('ghost', host !== primaryHost);
      }
      const copy = reviewLaunch.querySelector('#copy-review-prompt');
      copy.classList.toggle('primary', !primaryHost); copy.classList.toggle('text', Boolean(primaryHost)); copy.classList.toggle('ghost', false);
    }
    // Rows are keyed by record ID with a signature of what they render, so a background refresh touches only rows whose
    // content changed; unchanged rows (and their logos) stay in place and nothing blinks.
    const rowSignature = item => JSON.stringify([item.id, item.title, item.summary ?? null, item.card ?? null]);
    function buildRow(item) {
      const row = document.createElement('li');
      row.className = 'career-row';
      row.dataset.id = item.id;
      row.dataset.signature = rowSignature(item);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'career-record';
      button.setAttribute('aria-controls', `${prefix}-reader`);
      if (item.card && typeof item.card === 'object') {
        row.className = 'career-row career-card';
        const side = node('span', 'career-card-side');
        renderCard(item, button, side);
        row.append(button, side);
      } else {
        renderRow(item, button);
        row.append(button);
        if (kind === 'blocks') row.append(blockButton('Unblock', `Unblock ${item.title}`, () => removeBlock(item), 'text career-row-action'));
      }
      // A property, not a listener, so a reused row can be rebound to the item from the latest page without stacking handlers.
      button.onclick = () => { void openRecord(item, button); };
      return row;
    }
    async function loadPage(focusList = false, place = null) {
      if (!enabled) return;
      const currentGeneration = ++generation;
      // A background refresh (the record the user had open is remembered) swaps rows in place and keeps the reader; a
      // navigation clears the list, closes the reader and shows the loading state.
      const silent = Boolean(place?.selectedId !== undefined && place?.focusList !== true && place?.notice === undefined && records.childElementCount);
      if (!silent) {
        closeReader();
        records.replaceChildren();
        records.hidden = true;
        records.setAttribute('aria-busy', 'true');
        previous.disabled = true;
        next.disabled = true;
        listStatus.textContent = `Loading ${categories[kind].title.toLowerCase()}…`;
      }
      loading = true;
      nextOffset = null;
      listRetry.hidden = true;
      const category = categories[kind];
      let firstRecord = null;
      let reopen = null;
      try {
        const result = await request('career-list', { kind, offset, limit: 25, ...(kind === 'jobs' ? { view } : {}) });
        if (!enabled || currentGeneration !== generation) return;
        if (kind === 'jobs') renderCounts(result.counts);
        const existing = new Map([...records.children].map(row => [row.dataset.id, row]));
        const rows = result.items.map(item => {
          const previousRow = existing.get(item.id);
          const row = previousRow && previousRow.dataset.signature === rowSignature(item) ? previousRow : buildRow(item);
          const button = row.querySelector('.career-record');
          if (row === previousRow) button.onclick = () => { void openRecord(item, button); };
          firstRecord ??= { item, button };
          if (place?.selectedId === item.id) reopen = { item, button };
          return row;
        });
        // One DOM write for the page, and only when something actually differs.
        const same = rows.length === records.childElementCount && rows.every((row, index) => row === records.children[index]);
        if (!same) {
          const focused = document.activeElement;
          const focusedRow = [...records.children].find(row => [...row.querySelectorAll('button')].includes(focused));
          const scrollTop = records.scrollTop;
          records.replaceChildren(...rows);
          if (silent && focusedRow) {
            const replacement = rows.find(row => row.dataset.id === focusedRow.dataset.id);
            replacement?.querySelector('.career-record')?.focus({ preventScroll: true });
          }
          if (silent) records.scrollTop = scrollTop;
        }
        nextOffset = Number.isInteger(result.nextOffset) && result.nextOffset > offset ? result.nextOffset : null;
        records.hidden = result.items.length === 0;
        const range = `${integer(offset + 1)}–${integer(offset + result.items.length)} of ${integer(result.total)}`;
        listStatus.textContent = result.items.length
          ? range
          : offset ? 'No records on this page. Choose Previous.' : kind === 'jobs' ? viewEmpty[view] : category.empty;
        if (typeof place?.notice === 'string' && place.notice) listStatus.textContent = `${place.notice} · ${listStatus.textContent}`;
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
      // A refresh keeps the record the user had open, re-reading it quietly; a navigation opens the first record on wide
      // layouts. A record that left this page keeps its reader as it was rather than replacing what the user was reading.
      if (reopen) void (silent && selected?.id === reopen.item.id ? refreshRecord(reopen.item, reopen.button) : openRecord(reopen.item, reopen.button, false));
      else if (!place?.selectedId && sideBySide.matches && firstRecord) void openRecord(firstRecord.item, firstRecord.button, false);
    }
    // Re-read the open record without the loading state; the reader is rewritten only when its content changed.
    let detailSignature = '';
    async function refreshRecord(item, button) {
      if (!enabled) return;
      selected = item;
      selectedButton = button;
      records.querySelectorAll('[aria-current]').forEach(current => { if (current !== button) current.removeAttribute('aria-current'); });
      button.setAttribute('aria-current', 'true');
      const currentGeneration = generation;
      const currentRead = ++readGeneration;
      try {
        const detail = kind !== 'jobs' && Array.isArray(item.sections) ? item : await request('career-read', { kind, id: item.id });
        if (!enabled || currentGeneration !== generation || currentRead !== readGeneration) return;
        const signature = JSON.stringify(detail);
        if (signature === detailSignature) return;
        detailSignature = signature;
        const focusedAction = [...content.querySelectorAll('button')].includes(document.activeElement)
          ? document.activeElement.dataset.careerAction : null;
        const scrollTop = reader.scrollTop;
        renderDetail(detail, item);
        if (focusedAction) {
          const target = [...content.querySelectorAll('button')].find(button => button.dataset.careerAction === focusedAction);
          (target ?? readerTitle).focus({ preventScroll: true });
        }
        reader.scrollTop = scrollTop;
      } catch { /* The reader keeps what it showed; the next navigation reports errors. */ }
    }

    function resetPlace() {
      offset = 0;
      priorOffsets = [];
      keepPlace = null;
    }
    categoryButtons.forEach(button => button.addEventListener('click', () => {
      const nextView = button.dataset.careerView ?? 'jobs';
      if (!enabled || (button.dataset.careerKind === kind && (kind !== 'jobs' || nextView === view))) return;
      kind = button.dataset.careerKind; view = nextView;
      categoryButtons.forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === button)));
      resetPlace();
      showJobActions();
      void loadPage();
    }));
    // Dragging only moves the label; the range is saved once on change, then the agent's next review uses it.
    publication?.input.addEventListener('input', () => {
      const index = Number.parseInt(publication.input.value, 10);
      publication.label.textContent = publicationRanges[index]?.[2] ?? '';
      publication.input.setAttribute('aria-valuetext', publicationRanges[index]?.[1] ?? '');
    });
    publication?.input.addEventListener('change', () => {
      if (!enabled || kind !== 'jobs') return;
      const range = publicationRanges[Number.parseInt(publication.input.value, 10)]?.[0];
      if (!range || range === savedRange) return;
      rangeSaving = true;
      request('publication-range-set', { publicationRange: range }).catch(error => {
        listStatus.textContent = `Could not change the publication window. ${error.message}`;
        renderPublication(savedRange);
      }).finally(() => { rangeSaving = false; });
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
      setContext({ review: nextReview, publicationRange } = {}) {
        if (nextReview?.hosts) review = nextReview;
        renderReviewLaunch();
        renderPublication(publicationRange);
      },
      refresh() {
        // A state broadcast while the list is already showing keeps the page and the open record; only the first load starts at the top.
        const place = keepPlace ?? (enabled ? { offset, priorOffsets: [...priorOffsets], selectedId: selected?.id ?? null, focusId: null } : null);
        enabled = true;
        categoryButtons.forEach(button => { button.disabled = false; });
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
    deleteRankings: document.getElementById('delete-rankings'),
    stagePanels: [...document.querySelectorAll('#stage-panels [data-stage-panel]')],
    publication: { input: document.getElementById('publication-range'), label: document.getElementById('publication-range-label') },
    reviewLaunch: document.getElementById('review-launch'),
  });
  window.careerBrowser = {
    refresh() { return Promise.all([me.refresh(), jobs.refresh()]); },
    clear() { me.clear(); jobs.clear(); },
    setContext(context) { jobs.setContext(context); },
  };
})();
