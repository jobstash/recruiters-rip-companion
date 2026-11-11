'use strict';

// Career gap detection on Me → CVs. Off unless the candidate ticks the checkbox;
// the years, minimum length and wording appear only while it is on.
(() => {
  const element = name => document.getElementById(`career-gap-${name}`);
  const root = document.getElementById('career-gap');
  const fields = ['from', 'to', 'months', 'mode', 'text'];
  const fixedWording = 'Career gap period - private reasons';
  // saved: the stored setting. dirty: the candidate changed a control that is not stored yet.
  let saved = null, pending = false, dirty = false, failure = '', generation = 0, onCvs = true;

  const draft = () => ({ enabled: element('enabled').checked, mode: element('mode').value, text: element('text').value.trim(),
    minMonths: Number(element('months').value), fromYear: Number(element('from').value), toYear: Number(element('to').value) });
  function problem(value) {
    const year = number => Number.isInteger(number) && number >= 1950 && number <= 2100;
    if (!year(value.fromYear) || !year(value.toYear)) return 'Enter the years to check, from 1950 to 2100.';
    if (value.fromYear > value.toYear) return 'The first year must not be after the last year.';
    if (!Number.isInteger(value.minMonths) || value.minMonths < 3 || value.minMonths > 120) return 'A career gap is at least 3 months. Enter 3 to 120.';
    if (value.mode === 'custom' && !value.text) return 'Write the wording to show for a career gap.';
    return '';
  }
  function fill(value) {
    element('enabled').checked = value.enabled;
    element('from').value = String(value.fromYear); element('to').value = String(value.toYear);
    element('months').value = String(value.minMonths); element('mode').value = value.mode; element('text').value = value.text;
  }
  function render() {
    root.hidden = !saved || !onCvs;
    element('enabled').disabled = !saved || pending;
    element('options').hidden = !element('enabled').checked;
    element('text-field').hidden = element('mode').value !== 'custom';
    for (const name of fields) element(name).disabled = !saved || pending;
    element('note').textContent = !saved ? '' : saved.enabled
      ? `On. A gap of ${saved.minMonths} months or more between jobs in ${saved.fromYear}–${saved.toYear} gets a “Career gap” entry in generated CVs: “${saved.mode === 'custom' ? saved.text : fixedWording}”. Earlier documents update the next time your AI prepares them.`
      : 'Off. Generated CVs do not mention gaps between jobs.';
    element('error').textContent = failure;
    element('error').hidden = !failure;
  }
  async function save() {
    if (!saved || pending) return;
    let next = draft();
    // Turning detection off never depends on the hidden options being valid.
    if (!next.enabled && problem(next)) next = { ...saved, enabled: false };
    failure = next.enabled ? problem(next) : '';
    if (failure || JSON.stringify(next) === JSON.stringify(saved)) { dirty = Boolean(failure); render(); return; }
    const token = ++generation;
    pending = true; render();
    try {
      const response = await window.companion.invoke('career-gap-set', next);
      if (token !== generation) return;
      if (!response.ok) throw new Error(response.error?.message || 'Try again.');
      saved = response.result; dirty = false; failure = '';
      fill(saved);
    } catch (error) {
      if (token !== generation) return;
      failure = `Could not save career gap detection. ${error.message}`;
      fill(saved); dirty = false;
    } finally {
      if (token === generation) { pending = false; render(); }
    }
  }
  for (const name of ['enabled', ...fields]) {
    element(name).addEventListener('input', () => { dirty = true; render(); });
    element(name).addEventListener('change', () => { void save(); });
  }
  for (const tab of document.querySelectorAll('#me-browser [data-career-kind]'))
    tab.addEventListener('click', () => { onCvs = tab.dataset.careerKind === 'sources'; render(); });
  window.careerGapUI = {
    // Polls must not overwrite what the candidate is typing or an outstanding save.
    refresh(value) {
      const changed = JSON.stringify(value) !== JSON.stringify(saved);
      saved = value;
      if (changed && !dirty && !pending) fill(saved);
      render();
    },
    clear() { generation++; saved = null; pending = false; dirty = false; failure = ''; render(); },
  };
  window.careerGapUI.clear();
})();
