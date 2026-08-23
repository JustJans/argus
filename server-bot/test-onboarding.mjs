#!/usr/bin/env node

// ➤ Tests for the onboarding's contact intake (field case 2026-08-23: an
// ➤ email typed alone sailed through in silence, and a city typed first
// ➤ landed in the email slot). parseContact reads each piece by its SHAPE,
// ➤ mergeContact lets a second round fill only the gaps, and buildProfileYaml
// ➤ writes the slots — not the typing order — into the profile.

import { parseContact, mergeContact, buildProfileYaml, cvDegreesHeld, cvSuggestions, cvProfileSuggestions, cvFullName, cvContact, optionsFor } from './onboarding.mjs';

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

// ── The CV reads the setup its defaults (no LLM: catalog regexes) ──────────
{
  const accountant = '# Camila Alegre\n## Education\nDegree in Business Administration and Accounting\n## Experience\nSenior accountant at a firm.';
  check(cvDegreesHeld(accountant), [], 'an accountant CV shows no engineering family: all six will arrive pre-excluded');

  const mech = cvDegreesHeld('## Education\nBSc Mechanical Engineering, 2023');
  check(mech.length === 1 && mech[0].includes('maschinenbau'), true, 'a mechanical degree is evidence, matched by the same regex the offer filter uses');
  const quim = cvDegreesHeld('Formación: Grado en Ingeniería Química (UPC)');
  check(quim.length === 1 && quim[0].includes('chemical'), true, 'the Spanish spelling counts too');
  const de = cvDegreesHeld('Studium: Maschinenbau, TU München');
  check(de.length === 1 && de[0].includes('maschinenbau'), true, 'and the German one');

  const s = cvSuggestions('# CV\n## Skills\n- PLC programming, SCADA\n- Mooring analysis\n## Education\nBSc Mechanical Engineering');
  check(s.fields, ['PLC programming', 'SCADA', 'Mooring analysis'], 'the fields suggestion is the CV skills block, as discover already reads it');
  check(s.degreesHeld.length, 1, 'and the held degree rides along');
  check(cvSuggestions('no headings at all').fields, [], 'a CV with no skills section suggests nothing rather than guessing');
}

// ── The CV opens with the name; the setup should not have to ask blind ─────
{
  check(cvFullName('Camila Alegre\nAccountant\ncamila@x.com'), 'Camila Alegre', 'a CV opening with the name hands it over');
  check(cvFullName('CURRICULUM VITAE\nCamila Alegre\n+34 600'), 'Camila Alegre', 'a "Curriculum Vitae" header is skipped, not mistaken for a person');
  check(cvFullName('# José-María O\'Neill Fernández de Silva'), "José-María O'Neill Fernández de Silva", 'accents, apostrophes, particles and four words still read as a name');
  check(cvFullName('camila alegre\n...'), '', 'an uncapitalised line is not claimed as the name — better no default than a wrong-looking one');
  check(cvFullName('Experienced accountant with 8 years in audit'), '', 'a sentence is not a name');
  // ➤ The trap that killed the first version: a job headline has EXACTLY a
  // ➤ name's shape. Job words disqualify; the CV's email vouches.
  check(cvFullName('Senior Accountant\nCamila Alegre\ncamila.alegre@ejemplo.com'), 'Camila Alegre',
    'a job-title first line loses to the email-backed name below it');
  check(cvFullName('Ingeniera Industrial\nAna García\nana.garcia@y.es'), 'Ana García',
    'the Spanish trade headline loses the same way');
  check(cvFullName('Senior Accountant\nBusiness Analyst\nreports@corp.com'), '',
    'a CV whose early lines are all job titles suggests NOTHING rather than a wrong name');
  // ➤ The REAL document that broke version two, verbatim as pdf-parse hands
  // ➤ it over: name split across two lines by the design, a placeholder email
  // ➤ that vouches for nothing, and a university wearing a name's shape.
  const camilaPdf = 'CAMILA\nAlegre\nContable\nBuenos Aires, Argentina\nhola@sitioincreible.com.ar\n(+54) 11 1234 5678\nlinkedin.com/in/sitioincreible\nUniversidad Argentina del Comercio\n2014 – 2018';
  check(cvFullName(camilaPdf), 'Camila Alegre',
    'the split-line name is joined, the university is disqualified, the shouting caps are tidied');
  check(cvFullName('Universidad Argentina del Comercio\n2014 - 2018\nContabilidad general'), '',
    'an institution alone suggests nothing — org words disqualify the shape');
  check(cvFullName("JOSÉ-MARÍA\nO'NEILL"), "José-María O'Neill", 'caps tidying respects hyphens and apostrophes');
  // ➤ The SECOND real document (a letter-spaced template): pdf-parse glues
  // ➤ the surname onto the tracked subtitle, and a section header wears a
  // ➤ name's shape. Verbatim, as extracted.
  const carlaPdf = 'Carla\nRodríguezL I C . E N C O N T A B I L I D A D\nLorem ipsum dolor sit amet, consectetur adipiscing elit, sed\ndo eiusmod tempor incididunt ut labore\nÁREA DE CONTABILIDAD\nhola@sitioincreible.com\n+34 123 456 789';
  check(cvFullName(carlaPdf), 'Carla Rodríguez',
    'the glued letter-spaced subtitle is peeled off the surname, and the ÁREA header never wins');

  // ➤ The contact block, off both real documents.
  check(cvContact(camilaPdf), { email: 'hola@sitioincreible.com.ar', phone: '(+54) 11 1234 5678', city: 'Buenos Aires, Argentina' },
    'email, whole phone (parenthesis included) and City, Country line all read');
  check(cvContact(carlaPdf).city, '', 'a CV with no city line suggests no city — the Missing round will ask');
  check(cvContact('CAMILA\n2014 – 2018\nUniversidad X').phone, '', 'a study-years range is never mistaken for a phone');
  check(parseContact('hola@sitioincreible.com.ar, (+54) 11 1234 5678, Buenos Aires, Argentina'),
    { email: 'hola@sitioincreible.com.ar', phone: '(+54) 11 1234 5678', city: 'Buenos Aires, Argentina' },
    'and the suggested contact line survives the same by-shape parse a typed one gets');

  check(cvSuggestions('Camila Alegre\n## Skills\n- Accounting').name, 'Camila Alegre', 'and the name rides the suggestion bag');
}

// ── The CV picks the person's OWN areas (ESCO occupations, injected) ───────
{
  const accountantCv = '# CV\n## Skills\n- Accounting, bookkeeping\n- Sales negotiation\n## Education\nGrado en Administración de Empresas';
  // ➤ A mixed career: ESCO answers with an accounting occupation AND a sales
  // ➤ one — the suggestions must carry BOTH areas, because either could be
  // ➤ the job the person actually wants next.
  const occupations = async () => ([
    { uri: 'u1', title: 'accountant', terms: ['Accounting'], code: '2411.1', labels: { en: ['accountant', 'financial auditor'] } },
    { uri: 'u2', title: 'sales representative', terms: ['Sales negotiation'], code: '3322.2', labels: { en: ['sales representative', 'account manager'] } },
  ]);
  const s = await cvProfileSuggestions(accountantCv, { occupations });
  check(s.roles, ['accountant', 'sales representative', 'financial auditor', 'account manager'],
    'the role suggestions carry BOTH professions, breadth first: one name each before any synonym');
  check(s.degreeOptions.map(o => o.label),
    ['Business Administration', 'Economics', 'Accounting / Finance', 'Marketing'],
    'the degree question now asks about the business families, not Aerospace');
  check(s.degreesHeld.length === 2 && s.degreesHeld.some(v => /administraci/.test(v)), true,
    'the ADE degree AND the accounting evidence both read as held: neither arrives pre-excluded (a manual tick is cheaper than a wrong default)');

  const eng = await cvProfileSuggestions('# CV\n## Skills\n- Mooring analysis\n## Education\nBSc Mechanical Engineering', {
    occupations: async () => ([{ uri: 'u3', title: 'marine engineer', terms: ['Mooring analysis'], code: '2144.1', labels: { en: ['marine engineer'] } }]),
  });
  check(eng.degreeOptions.some(o => o.label === 'Mechanical') && eng.degreeOptions.some(o => o.label === 'Physics'), true,
    'ISCO group 21 carries engineering AND science: both families offered');

  const offline = await cvProfileSuggestions(accountantCv, { occupations: async () => { throw new Error('no network'); } });
  check(offline.roles, [], 'no network: no role suggestions rather than invented ones');
  check(offline.degreeOptions, [], 'and the degree question falls back to the shipped catalog');
  check(offline.fields.length > 0, true, 'while the offline skill suggestions still work');

  const slow = await cvProfileSuggestions(accountantCv, {
    occupations: () => new Promise(r => setTimeout(r, 60_000, [])), deadlineMs: 50,
  });
  check(slow.roles, [], 'a hung ESCO hits the deadline and degrades instead of hanging the setup');
}

// ── The degree options survive into settings edits (audit 2026-08-23) ──────
{
  const q = { key: 'degrees_excluded', kind: 'multi', options: [{ label: 'Mechanical', value: 'mech' }] };
  const biz = [{ label: 'Economics', value: 'econom' }];
  check(optionsFor(q, { suggest: { degreeOptions: biz } }).options, biz, 'fresh CV suggestions pick the options');
  check(optionsFor(q, { answers: { degree_options: biz } }).options, biz,
    'and a settings edit, running on saved answers alone, sees the SAME families it was set up with');
  check(optionsFor(q, { answers: {} }).options, q.options, 'no record at all: the shipped catalog');
}

console.log(failures === 0 ? `All ${total} onboarding tests passed.` : `${failures}/${total} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
