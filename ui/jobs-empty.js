'use strict';
/** Why the Jobs list is empty, with its one next step: no account, the feed still loading or unavailable, or a truly empty
 *  publication window. `action` is `connect` (the Settings account button) or `retry` (load the feed again). */
window.jobsEmptyState = ({ paired, catalogue } = {}, rangeText = 'in this window') => {
  if (!paired) return { text: 'Connect your account to see new jobs.', label: 'Connect account', action: 'connect' };
  if (catalogue?.status === 'failed') {
    return {
      membership: { text: 'New jobs need a recruiters.rip subscription.', label: 'Open account', action: 'connect' },
      reconnect: { text: 'Your account couldn’t load new jobs. Check it, then try again.', label: 'Open account', action: 'connect' },
      offline: { text: 'Couldn’t reach recruiters.rip. Check your internet connection.', label: 'Retry', action: 'retry' },
    }[catalogue.reason] ?? { text: 'Couldn’t load new jobs.', label: 'Retry', action: 'retry' };
  }
  if (catalogue?.status !== 'ready') return { text: 'Loading jobs…' };
  return { text: `No jobs published ${rangeText}. Choose a longer range.` };
};
