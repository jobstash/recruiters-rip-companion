import { fail } from './state.mjs';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const list = (maxLength, maxItems) => ({ type: 'array', items: string(maxLength), maxItems, uniqueItems: true });
export const CONTACT_FIELDS = Object.freeze({
  name: { label: 'Full name', maxLength: 300 },
  firstName: { label: 'First name', maxLength: 150 },
  lastName: { label: 'Last name', maxLength: 150 },
  preferredName: { label: 'Preferred name', maxLength: 300 },
  email: { label: 'Email address', type: 'email', maxLength: 320 },
  phone: { label: 'Phone number', type: 'tel', maxLength: 100 },
  location: { label: 'Current location', maxLength: 300 },
  country: { label: 'Country of residence', maxLength: 200 },
  addressLine1: { label: 'Address line 1', maxLength: 500 },
  addressLine2: { label: 'Address line 2', maxLength: 500 },
  city: { label: 'Town or city', maxLength: 300 },
  postalCode: { label: 'Postcode / ZIP code', maxLength: 100 },
  linkedinUrl: { label: 'LinkedIn profile URL', type: 'url', maxLength: 2048 },
});
export const profileFields = {
  ...Object.fromEntries(Object.entries(CONTACT_FIELDS).map(([key, field]) => [key, nullable(string(field.maxLength))])),
  headline: nullable(string(500)), links: list(2048, 20),
  roleCapabilities: nullable(list(200, 30)), seniority: nullable(string(200)), skills: nullable(list(200, 100)),
};
function valid(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => valid(value, option));
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && value.trim().length > 0 && value.length <= schema.maxLength;
  return Array.isArray(value) && value.length <= schema.maxItems && new Set(value).size === value.length && value.every(item => valid(item, schema.items));
}
export function validateProfilePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) fail('INVALID_INPUT', 'Provide explicit profile fields to save.');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(profileFields, key) || !valid(value, profileFields[key])) fail('INVALID_INPUT', 'Provide supported profile fields with valid values.');
    if (value === null) continue;
    if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('INVALID_INPUT', 'Provide a valid email address.');
    if (key === 'linkedinUrl') {
      let url;
      try { url = new URL(value); } catch { fail('INVALID_INPUT', 'Provide a LinkedIn profile URL.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hostname.replace(/^www\./, '') !== 'linkedin.com' || !url.pathname.startsWith('/in/'))
        fail('INVALID_INPUT', 'Provide a LinkedIn profile URL.');
    }
  }
  return patch;
}
/** Partial patches never derive name parts or overwrite unrelated profile fields. */
export function patchProfile(career, patch) {
  validateProfilePatch(patch);
  for (const [key, value] of Object.entries(patch)) career.profile[key] = structuredClone(value);
  const saved = Object.keys(patch);
  if (!Object.hasOwn(patch, 'name') && typeof patch.firstName === 'string' && typeof patch.lastName === 'string') {
    career.profile.name = `${patch.firstName.trim()} ${patch.lastName.trim()}`;
    saved.push('name');
  }
  return saved;
}
