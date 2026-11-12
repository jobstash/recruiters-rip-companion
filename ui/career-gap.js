'use strict';

// Career gap detection on Me → CVs. Off unless the candidate ticks the checkbox. While it is on, the form shows what
// counts as a gap (years, minimum length) and the parts of the entry each gap gets among the jobs in a generated CV:
// activity, place and description in the candidate's words. Its time range comes from the CV, so it is not typed.
(() => {
  const element = name => document.getElementById(`career-gap-${name}`);
  const root = document.getElementById('career-gap');
  const fields = ['from', 'to', 'months', 'activity', 'place', 'description'];
  // saved: the stored setting. dirty: the candidate changed a control that is not stored yet.
  let saved = null, pending = false, dirty = false, failure = '', generation = 0, onCvs = true;

  // Same key order as the stored setting, so an unchanged form compares equal to it.
  const draft = () => ({ enabled: element('enabled').checked, activity: element('activity').value.trim(), place: element('place').value.trim(),
    description: element('description').value.trim(),
    minMonths: Number(element('months').value), fromYear: Number(element('from').value), toYear: Number(element('to').value) });
  function problem(value) {
    const year = number => Number.isInteger(number) && number >= 1950 && number <= 2100;
    if (!year(value.fromYear) || !year(value.toYear)) return 'Enter the years to check, from 1950 to 2100.';
    if (value.fromYear > value.toYear) return 'The first year must not be after the last year.';
    if (!Number.isInteger(value.minMonths) || value.minMonths < 3 || value.minMonths > 120) return 'A career gap is at least 3 months. Enter 3 to 120.';
    if (!value.activity) return 'Write the activity to show for a career gap, such as Career break.';
    return '';
  }
  function fill(value) {
    element('enabled').checked = value.enabled;
    element('from').value = String(value.fromYear); element('to').value = String(value.toYear);
    element('months').value = String(value.minMonths);
    element('activity').value = value.activity; element('place').value = value.place; element('description').value = value.description;
  }
  function render() {
    root.hidden = !saved || !onCvs;
    element('enabled').disabled = !saved || pending;
    element('options').hidden = !element('enabled').checked;
    for (const name of fields) element(name).disabled = !saved || pending;
    // The saved entry, part by part, in the order a job shows them.
    const entry = saved ? [`“${saved.activity}”`, ...(saved.place ? [`“${saved.place}”`] : []), 'its dates from your CV', ...(saved.description ? [`“${saved.description}”`] : [])].join(' · ') : '';
    element('note').textContent = !saved ? '' : saved.enabled
      ? `On. A gap of ${saved.minMonths} months or more between jobs in ${saved.fromYear}–${saved.toYear} is listed in Experience among your jobs in generated CVs: ${entry}. Earlier documents update the next time your AI prepares them.`
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
