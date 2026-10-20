const UNKNOWN = 'Not saved';

const preferences = career => {
  const value = career?.profile?.preferences;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};

const humanize = value => typeof value === 'string' && value.trim()
  ? value.trim().replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase())
  : null;

const display = value => {
  if (Array.isArray(value)) {
    const items = value.map(humanize).filter(Boolean);
    return items.length ? items.join(' · ') : UNKNOWN;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return humanize(value) ?? UNKNOWN;
};

const fields = (heading, rows) => ({
  heading,
  fields: rows.map(([label, value]) => ({ label, value })),
});

const salary = ({ salaryMinimum, salaryCurrency, salaryPeriod }) => {
  if (!Number.isFinite(salaryMinimum)) return UNKNOWN;
  const currency = typeof salaryCurrency === 'string' && /^[A-Z]{3}$/.test(salaryCurrency) ? salaryCurrency : null;
  const period = humanize(salaryPeriod);
  let amount = salaryMinimum.toLocaleString('en-GB');
  if (currency) {
    try {
      amount = new Intl.NumberFormat('en-GB', {
        style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
      }).format(salaryMinimum);
    } catch {
      amount = `${currency} ${amount}`;
    }
  } else {
    amount = `${amount} (currency not saved)`;
  }
  return `${amount}${period ? ` / ${period.toLowerCase()}` : ' / period not saved'}`;
};

const summary = values => {
  const known = values.map(display).filter(value => value !== UNKNOWN);
  return known.length ? known.join(' · ') : UNKNOWN;
};

/** Projects explicit candidate preferences into the generic career browser's read-only records. */
export function preferenceItems(career) {
  const value = preferences(career);
  return [
    {
      id: 'direction', title: 'Direction', summary: summary([value.roles, value.acceptedAlternatives, value.excludedRoles]),
      sections: [
        fields('Direction', [
          ['Target roles', display(value.roles)],
          ['Accepted alternatives', display(value.acceptedAlternatives)],
          ['Avoid', display(value.excludedRoles)],
        ]),
        { heading: 'Direction notes', text: typeof value.notes === 'string' && value.notes.trim() ? value.notes : 'No direction notes saved.' },
      ],
    },
    {
      id: 'location', title: 'Location', summary: summary([value.locations, value.workModes]),
      sections: [fields('Location', [
        ['Locations', display(value.locations)],
        ['Work modes', display(value.workModes)],
        ['Willing to relocate', display(value.willingToRelocate)],
        ['Travel', display(value.travel)],
        ['Availability', display(value.availability)],
      ])],
    },
    {
      id: 'employment', title: 'Employment', summary: summary([value.employmentTypes]),
      sections: [fields('Employment', [
        ['Employment types', display(value.employmentTypes)],
        ['Minimum salary', salary(value)],
        ['Requires sponsorship', display(value.requiresSponsorship)],
      ])],
    },
    {
      id: 'work', title: 'Work', summary: summary([value.responsibilityModes, value.technologies, value.domains]),
      sections: [
        fields('Responsibilities', [
          ['Responsibility modes', display(value.responsibilityModes)],
          ['Direct reports', display(value.directReports)],
          ['Review emphasis', display(value.emphasis)],
        ]),
        fields('Environment', [
          ['Technologies', display(value.technologies)],
          ['Domains', display(value.domains)],
          ['Company sizes', display(value.companySizes)],
          ['Company stages', display(value.companyStages)],
        ]),
      ],
    },
  ];
}
