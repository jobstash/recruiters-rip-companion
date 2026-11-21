'use strict';
// Pipeline board: a column per stage and a card per application. A card moves by dragging it to another column, with its
// Set status… menu, or with Left/Right arrows while it has focus; Closed asks Rejected or Withdrew on the card itself. Saving,
// announcing and redrawing belong to the handlers (ui/career-browser.js).
(() => {
  const columns = [['prepared', 'Prepared'], ['applied', 'Applied'], ['interviewing', 'Interviewing'], ['offer', 'Offer'], ['hired', 'Hired'], ['closed', 'Closed']];
  const order = columns.map(([id]) => id);
  const labels = Object.fromEntries(columns);
  const milestones = { interviewing: 'interview', offer: 'offer', hired: 'new job' };
  const node = (tag, className, text) => {
    const created = document.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  // A pointer must travel this far before a press becomes a drag; a shorter press is a click that opens the card.
  const DRAG_DISTANCE = 6;
  const interviewDate = value => {
    const date = new Date(`${value}T12:00:00`);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short',
      ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  };

  function create(container, handlers) {
    let data = null, selectedId = null, choice = null, drag = null, suppressClick = false;
    // Where focus belongs after the next redraw: the control that acted, even if disabling it while saving dropped focus.
    let focusAfter = null;
    const controls = new Map(), lanes = new Map(), cards = new Map();

    function request(card, column, sent, focusKey = `${card.id}:open`) {
      focusAfter = focusKey;
      if (column === 'closed') { choice = card.id; draw(`${card.id}:choice-rejected`); focusAfter = null; return; }
      choice = null;
      void handlers.move(card, column, sent);
    }
    function control(element, key) {
      element.dataset.focusKey = key;
      controls.set(key, element);
      return element;
    }
    function button(text, className, key, onClick) {
      const created = control(node('button', className, text), key);
      created.type = 'button';
      created.addEventListener('click', event => { if (event.detail > 1) return; onClick(); });
      return created;
    }
    function closeChoice(card) {
      const group = node('div', 'pipeline-choice');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', `Close ${card.title} as`);
      const cancel = () => { choice = null; draw(`${card.id}:open`); };
      group.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } });
      const rejected = button('Rejected', 'ghost', `${card.id}:choice-rejected`, () => handlers.move(card, 'rejected', [rejected, withdrew]));
      const withdrew = button('Withdrew', 'ghost', `${card.id}:choice-withdrawn`, () => handlers.move(card, 'withdrawn', [rejected, withdrew]));
      group.append(node('span', 'pipeline-choice-label', 'Close as'), rejected, withdrew, button('Cancel', 'text', `${card.id}:choice-cancel`, cancel));
      return group;
    }
    function renderCard(card, column) {
      const item = node('li', 'pipeline-card');
      item.dataset.id = card.id;
      const open = control(node('button', 'pipeline-card-open'), `${card.id}:open`);
      open.type = 'button';
      open.append(node('span', 'pipeline-card-role', card.title));
      if (card.company) open.append(node('span', 'pipeline-card-company', card.company));
      open.append(node('span', 'pipeline-card-detail', card.detail));
      const nextInterview = card.stage === 'interviewing' && card.nextInterviewAt
        ? `Next interview · ${interviewDate(card.nextInterviewAt)}` : null;
      if (nextInterview) open.append(node('span', 'pipeline-card-interview', nextInterview));
      open.setAttribute('aria-label', [card.title, card.company, card.detail, nextInterview].filter(Boolean).join(', '));
      open.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
      if (card.id === selectedId) open.setAttribute('aria-current', 'true');
      open.addEventListener('click', () => {
        if (suppressClick) { suppressClick = false; return; }
        handlers.open(card, open);
      });
      open.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const target = order[order.indexOf(column) + (event.key === 'ArrowRight' ? 1 : -1)];
        if (!target) return;
        event.preventDefault();
        request(card, target, [open]);
      });
      // Pointer drag: the press starts on the card itself, never on its controls.
      item.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest?.('select, .pipeline-card-actions, .pipeline-choice')) return;
        drag = { card, column, item, x: event.clientX, y: event.clientY, ghost: null, target: null };
      });
      const move = control(node('select', 'pipeline-move'), `${card.id}:move`);
      move.setAttribute('aria-label', `Set status for ${card.title}`);
      const placeholder = node('option', '', 'Set status…');
      placeholder.value = '';
      move.append(placeholder, ...order.filter(id => id !== column).map(id => { const option = node('option', '', labels[id]); option.value = id; return option; }));
      move.value = '';
      move.addEventListener('change', () => { const target = move.value; move.value = ''; if (target) request(card, target, [move], `${card.id}:move`); });
      const actions = node('div', 'pipeline-card-actions');
      actions.append(move);
      if (card.stage === 'interviewing') {
        const next = button('Next round', 'text', `${card.id}:round`, () => handlers.nextRound(card, [next]));
        actions.append(next);
      }
      // Render from the saved stage only. A move never copies a link or opens X.
      if (Object.hasOwn(milestones, card.stage)) {
        const share = node('div', 'pipeline-card-share');
        share.append(button('Give a friend a free month', 'text', `${card.id}:invite`, () => window.referralsUI.invite()),
          button(`Share my ${milestones[card.stage]} on X`, 'text', `${card.id}:share`, () => window.referralsUI.share(card.stage)));
        actions.append(share);
      }
      item.append(open, actions);
      if (choice === card.id) item.append(closeChoice(card));
      return item;
    }
    function forgetCard(id) {
      for (const suffix of ['open', 'move', 'round', 'invite', 'share', 'choice-rejected', 'choice-withdrawn', 'choice-cancel']) controls.delete(`${id}:${suffix}`);
    }
    function draw(focusKey) {
      const active = focusKey && controls.get(focusKey);
      const oldLane = active?.closest?.('[data-column]')?.dataset.column;
      const seen = new Set();
      const scrollPositions = [...lanes.values()].map(lane => [lane.body, lane.body.scrollTop]);
      for (const entry of data.columns) {
        if (!order.includes(entry.id)) continue;
        let lane = lanes.get(entry.id);
        if (!lane) {
          const section = node('section', 'pipeline-column');
          section.dataset.column = entry.id;
          const heading = node('h3', 'pipeline-column-head');
          heading.id = `pipeline-column-${entry.id}`;
          const count = node('span', 'pipeline-count');
          heading.append(node('span', 'pipeline-column-name', labels[entry.id]), count);
          section.setAttribute('aria-labelledby', heading.id);
          const body = node('div', 'pipeline-lane-body');
          const list = node('ol', 'pipeline-cards');
          list.setAttribute('aria-labelledby', heading.id);
          section.append(heading, body);
          lane = { section, count, body, list, empty: node('p', 'pipeline-empty', 'No applications') };
          lanes.set(entry.id, lane);
        }
        if (lane.section.parentNode !== container) container.append(lane.section);
        const count = String(entry.cards.length);
        if (lane.count.textContent !== count) lane.count.textContent = count;
        if (entry.cards.length) {
          lane.empty.remove();
          if (lane.list.parentNode !== lane.body) lane.body.append(lane.list);
        } else {
          lane.list.remove();
          if (lane.empty.parentNode !== lane.body) lane.body.append(lane.empty);
        }
        for (let index = 0; index < entry.cards.length; index += 1) {
          const card = entry.cards[index];
          seen.add(card.id);
          // Include the progress snapshot: controls must never keep a stale concurrency token.
          const signature = JSON.stringify([card, entry.id, choice === card.id]);
          let saved = cards.get(card.id);
          if (!saved || saved.signature !== signature) {
            forgetCard(card.id);
            const item = renderCard(card, entry.id);
            if (saved) saved.item.replaceWith(item);
            saved = { item, signature };
            cards.set(card.id, saved);
          }
          const open = controls.get(`${card.id}:open`);
          if (card.id === selectedId) open.setAttribute('aria-current', 'true');
          else open.removeAttribute('aria-current');
          // Do not detach unchanged nodes: their focus, native controls and lane scroll survive refreshes.
          if (lane.list.children[index] !== saved.item) lane.list.insertBefore(saved.item, lane.list.children[index] ?? null);
        }
      }
      for (const [id, saved] of cards) {
        if (seen.has(id)) continue;
        saved.item.remove();
        cards.delete(id);
        forgetCard(id);
      }
      for (const [body, scrollTop] of scrollPositions) if (body.scrollTop !== scrollTop) body.scrollTop = scrollTop;
      const target = focusKey && (controls.get(focusKey) ?? controls.get(`${focusKey.split(':')[0]}:open`));
      if (target && target !== document.activeElement) {
        const sameLane = oldLane === target.closest?.('[data-column]')?.dataset.column;
        target.focus({ preventScroll: sameLane });
      }
    }

    // Drag: a lifted copy follows the pointer; the lane under it is lit and an empty slot shows where the card will land
    // (the top: a moved card has the latest step).
    function columnAt(x, y) { return document.elementFromPoint(x, y)?.closest?.('[data-column]') ?? null; }
    function markTarget(target) {
      drag.target?.classList.remove('is-drop-target');
      drag.slot?.remove();
      drag.target = target; drag.slot = null;
      if (!target || target.dataset.column === drag.column) return;
      target.classList.add('is-drop-target');
      drag.slot = node('div', 'pipeline-drop-slot');
      drag.slot.setAttribute('aria-hidden', 'true');
      drag.slot.style.height = `${drag.height}px`;
      target.querySelector('.pipeline-lane-body')?.prepend(drag.slot);
    }
    function endDrag() {
      if (!drag) return;
      drag.ghost?.remove();
      drag.item.classList.remove('is-dragging');
      markTarget(null);
      drag = null;
    }
    window.addEventListener('pointermove', event => {
      if (!drag) return;
      if (!drag.ghost) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_DISTANCE) return;
        const box = drag.item.getBoundingClientRect();
        drag.offsetX = drag.x - box.left; drag.offsetY = drag.y - box.top;
        drag.ghost = drag.item.cloneNode(true);
        drag.ghost.classList.add('pipeline-ghost');
        drag.ghost.setAttribute('aria-hidden', 'true');
        drag.ghost.style.width = `${box.width}px`;
        drag.height = box.height;
        document.body.append(drag.ghost);
        drag.item.classList.add('is-dragging');
      }
      drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
      drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
      const target = columnAt(event.clientX, event.clientY);
      if (target !== drag.target) markTarget(target);
    });
    window.addEventListener('pointerup', event => {
      if (!drag) return;
      const { card, column, ghost } = drag, target = ghost ? columnAt(event.clientX, event.clientY)?.dataset.column : null;
      endDrag();
      if (!ghost) return;
      // The click that follows a drag is part of the drag.
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (target && target !== column) request(card, target, []);
    });
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('keydown', event => { if (drag && event.key === 'Escape') endDrag(); });

    return {
      /** Reconciles keyed cards without replacing lanes or unrelated controls. */
      render(next, options = {}) {
        data = next; selectedId = options.selectedId ?? null;
        if (choice && !next.columns.some(entry => entry.cards.some(card => card.id === choice && entry.id !== 'closed'))) choice = null;
        const active = document.activeElement?.dataset?.focusKey;
        draw(focusAfter ?? active);
        focusAfter = null;
      },
      button: id => controls.get(`${id}:open`) ?? null,
      select(id) {
        controls.get(`${selectedId}:open`)?.removeAttribute('aria-current');
        selectedId = id;
        controls.get(`${selectedId}:open`)?.setAttribute('aria-current', 'true');
      },
      clear() {
        endDrag();
        data = null; selectedId = null; choice = null; focusAfter = null;
        controls.clear(); cards.clear(); lanes.clear();
        container.replaceChildren();
      },
    };
  }
  window.pipelineBoard = { create };
})();
