#!/usr/bin/env node

// ➤ Tests for the onboarding's contact intake (field case 2026-08-23: an
// ➤ email typed alone sailed through in silence, and a city typed first
// ➤ landed in the email slot). parseContact reads each piece by its SHAPE,
// ➤ mergeContact lets a second round fill only the gaps, and buildProfileYaml
// ➤ writes the slots — not the typing order — into the profile.

import { parseContact, mergeContact, buildProfileYaml } from './onboarding.mjs';

let total = 0, failures = 0;
const check = (got, want, label) => {
  total++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log(`  FAIL ${label}\n    got:      ${g}\n    expected: ${w}`); }
};

// ── parseContact: shape, not position ──────────────────────────────────────
check(parseContact('camila@ejemplo.com'),
  { email: 'camila@ejemplo.com', phone: '', city: '' },
  'an email typed alone is understood as the email');
check(parseContact('Barcelona, +34 600 000 000, x@y.com'),
  { email: 'x@y.com', phone: '+34 600 000 000', city: 'Barcelona' },
  'city-first still lands every piece in its slot');
check(parseContact('600-000-000'),
  { email: '', phone: '600-000-000', city: '' },
  'a dashed number is still a phone');
check(parseContact('Calle 5'),
  { email: '', phone: '', city: 'Calle 5' },
  'a stray digit is not a phone — it stays with the city');
check(parseContact('x@y.com; Sant Cugat, Barcelona'),
  { email: 'x@y.com', phone: '', city: 'Sant Cugat, Barcelona' },
  'every unclaimed piece joins the city');
check(parseContact(''),
  { email: '', phone: '', city: '' },
  'empty in, empty out');
check(parseContact(' , ; '),
  { email: '', phone: '', city: '' },
  'separators alone give nothing');

// ── mergeContact: rounds fill gaps, never overwrite ────────────────────────
check(mergeContact({ email: 'a@b.co', phone: '', city: '' }, parseContact('Barcelona, 600 111 222')),
  { email: 'a@b.co', phone: '600 111 222', city: 'Barcelona' },
  'the second round fills only the gaps');
check(mergeContact({ email: 'a@b.co', phone: '600 111 222', city: 'Roma' }, parseContact('z@z.co, 700 000 000, Oslo')),
  { email: 'a@b.co', phone: '600 111 222', city: 'Roma' },
  'and never overwrites what the first round said');

// ── buildProfileYaml: the slots reach the profile, order be damned ─────────
{
  const y = buildProfileYaml({ name: 'N', contact_parts: { email: 'e@x.com', phone: '', city: 'Sant Cugat, Barcelona' } });
  const line = k => y.split('\n').find(l => l.trim().startsWith(k)) || '';
  check(line('email:').includes('e@x.com'), true, 'the structured email lands in the profile');
  check(line('location:').includes('Sant Cugat, Barcelona'), true, 'the full city string rides location');
  check(line('letter_city:').includes('Sant Cugat') && !line('letter_city:').includes('Barcelona'), true,
    'letter_city keeps only the first segment — what the search home group wants');
}
{
  // ➤ Answers saved BEFORE the structured intake still regenerate correctly:
  // ➤ every settings edit rebuilds the profile from the stored answers.
  const y = buildProfileYaml({ name: 'N', contact: 'a@b.co, 600 111 222, Roma' });
  const line = k => y.split('\n').find(l => l.trim().startsWith(k)) || '';
  check(line('email:').includes('a@b.co') && line('phone:').includes('600 111 222') && line('letter_city:').includes('Roma'),
    true, 'a legacy positional answer still fills every slot');
}

console.log(failures === 0 ? `All ${total} onboarding tests passed.` : `${failures}/${total} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
