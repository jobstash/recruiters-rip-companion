import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { preferenceItems } from '../src/preferences-browser.mjs';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { candidateContext } from '../src/mcp/matching-tools.mjs';
import { createCareerState } from '../src/mcp/state.mjs';

const populated = () => ({ profile: { preferences: {
  roles: ['platform_engineer'], acceptedAlternatives: ['Engineering manager'], excludedRoles: ['Sales_engineer'], notes: 'Prefer product ownership.',
  locations: ['London'], workModes: ['remote', 'hybrid'], willingToRelocate: false, travel: 'occasional', availability: 'immediate',
  employmentTypes: ['permanent', 'part_time'], salaryMinimum: 120000, salaryCurrency: 'GBP', salaryPeriod: 'year', requiresSponsorship: true,
  responsibilityModes: ['hands_on', 'managerial'], directReports: 'not_preferred', emphasis: 'vacancy_specific',
  technologies: ['Node.js', 'PostgreSQL'], domains: ['Fintech'], companySizes: ['51_200'], companyStages: ['series_b'],
} } });

test('preferenceItems returns the exact four-record projection', () => {
  assert.deepEqual(preferenceItems(populated()), [
    { id: 'direction', title: 'Direction', summary: 'Platform engineer · Engineering manager · Sales engineer', sections: [
      { heading: 'Direction', fields: [
        { label: 'Target roles', value: 'Platform engineer' },
        { label: 'Accepted alternatives', value: 'Engineering manager' },
        { label: 'Avoid', value: 'Sales engineer' },
      ] },
      { heading: 'Direction notes', text: 'Prefer product ownership.' },
    ] },
    { id: 'location', title: 'Location', summary: 'London · Remote · Hybrid', sections: [
      { heading: 'Location', fields: [
        { label: 'Locations', value: 'London' },
        { label: 'Work modes', value: 'Remote · Hybrid' },
        { label: 'Willing to relocate', value: 'No' },
        { label: 'Travel', value: 'Occasional' },
        { label: 'Availability', value: 'Immediate' },
      ] },
    ] },
    { id: 'employment', title: 'Employment', summary: 'Permanent · Part time', sections: [
      { heading: 'Employment', fields: [
        { label: 'Employment types', value: 'Permanent · Part time' },
        { label: 'Minimum salary', value: '£120,000 / year' },
        { label: 'Requires sponsorship', value: 'Yes' },
      ] },
    ] },
    { id: 'work', title: 'Work', summary: 'Hands on · Managerial · Node.js · PostgreSQL · Fintech', sections: [
      { heading: 'Responsibilities', fields: [
        { label: 'Responsibility modes', value: 'Hands on · Managerial' },
        { label: 'Direct reports', value: 'Not preferred' },
        { label: 'Review emphasis', value: 'Vacancy specific' },
      ] },
      { heading: 'Environment', fields: [
        { label: 'Technologies', value: 'Node.js · PostgreSQL' },
        { label: 'Domains', value: 'Fintech' },
        { label: 'Company sizes', value: '51 200' },
        { label: 'Company stages', value: 'Series b' },
      ] },
    ] },
  ]);
});

test('preferenceItems represents every empty or unknown value without inference', () => {
  const items = preferenceItems(createCareerState());
  assert.deepEqual(items.map(({ id, summary }) => ({ id, summary })), [
    { id: 'direction', summary: 'Not saved' }, { id: 'location', summary: 'Not saved' },
    { id: 'employment', summary: 'Not saved' }, { id: 'work', summary: 'Not saved' },
  ]);
  assert.equal(items[0].sections[1].text, 'No direction notes saved.');
  assert.ok(items.flatMap(item => item.sections).filter(section => section.fields)
    .flatMap(section => section.fields).every(field => field.value === 'Not saved'));
});

test('preferenceItems formats partial salary data truthfully', () => {
  const salary = preferences => preferenceItems({ profile: { preferences } })[2].sections[0].fields[1].value;
  assert.equal(salary({ salaryMinimum: 95000, salaryCurrency: 'USD', salaryPeriod: 'month' }), 'US$95,000 / month');
  assert.equal(salary({ salaryMinimum: 500 }), '500 (currency not saved) / period not saved');
  assert.equal(salary({ salaryCurrency: 'EUR', salaryPeriod: 'year' }), 'Not saved');
});

test('new direction fields are accepted by the update schema and projected into matching context', () => {
  const store = { get: () => ({ career: createCareerState() }), update: () => assert.fail('schema test is read only') };
  const tool = createProfileTools({ store }).find(item => item.name === 'career_preferences_update');
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(tool.inputSchema);
  assert.equal(validate({ requestId: 'ecad2f7e-6880-4b47-b473-f991912b6069', revision: 0,
    patch: { acceptedAlternatives: ['Technical lead'], excludedRoles: ['Sales engineer'] } }), true, JSON.stringify(validate.errors));

  const career = createCareerState();
  career.profile = { headline: 'Platform engineer', roleCapabilities: ['Backend systems'], preferences: {
    roles: ['Platform engineer'], acceptedAlternatives: ['Technical lead'], excludedRoles: ['Sales engineer'],
    locations: ['London'], workModes: ['remote'], willingToRelocate: false, travel: 'none',
  } };
  career.facts.fact = { id: 'fact', kind: 'capability', subject: 'Node.js', answer: 'Hands-on', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(candidateContext(career).preferences.acceptedAlternatives, ['Technical lead']);
  assert.deepEqual(candidateContext(career).preferences.excludedRoles, ['Sales engineer']);
});
