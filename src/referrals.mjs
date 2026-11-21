import { fail } from './mcp/state.mjs';

const drafts = {
  interviewing: 'I got a job interview! I’ve been keeping track of my applications with recruiters.rip.',
  offer: 'I got a job offer! I’ve been keeping track of my applications with recruiters.rip.',
  hired: 'I accepted a new job! I’ve been keeping track of my applications with recruiters.rip.',
};

/** Only this process resolves an invite URL or an external destination. No card data enters the device request. */
export function createReferralActions({ platform, origin, accountKey, copyText, openExternal }) {
  let invite;
  return {
    async read() {
      const key = accountKey();
      if (!key) fail('PAIRING_REQUIRED', 'Connect your account to get an invite link.');
      const result = await platform('referrals', {});
      if (key !== accountKey()) fail('IDENTITY_CHANGED', 'Your account changed. Open Free months again.');
      const { code, availableMonths, earnedMonths } = result ?? {};
      if (typeof code !== 'string' || !/^[a-f0-9]{12}$/.test(code) || ![availableMonths, earnedMonths].every(n => Number.isSafeInteger(n) && n >= 0))
        fail('DEVICE_REQUEST_FAILED', 'Your invite and balance could not be read. Try again.');
      const link = new URL(`/r/${code}`, origin).href;
      invite = { key, link, code };
      return { code, link, availableMonths, earnedMonths };
    },
    copy(code) {
      if (!invite || invite.key !== accountKey() || invite.code !== code) fail('IDENTITY_CHANGED', 'Open Free months again to copy your current invite.');
      return { copied: copyText(invite.link) };
    },
    async share(stage) {
      if (typeof stage !== 'string' || !Object.hasOwn(drafts, stage)) fail('INVALID_INPUT', 'Choose an interview, offer or new job to share.');
      const url = new URL('https://x.com/intent/tweet');
      url.searchParams.set('text', drafts[stage]);
      await openExternal(url.href);
    },
  };
}
