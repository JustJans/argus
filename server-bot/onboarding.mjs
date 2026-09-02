#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the one-time SETUP over Telegram. `/start` walks a new user through a
// ➤ short questionnaire (CV + a few questions, some with buttons) and writes
// ➤ config/profile.yml + cv.md, so the generic engine becomes THEIR job searcher;
// ➤ `settings` re-opens any single question later. HOW IT WORKS: a tiny state machine —
// ➤ the current step and the answers so far live in data/onboarding-state.json; text
// ➤ answers arrive as messages, button taps as callback_query (routed here by
// ➤ telegram-listener.mjs).
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

// ➤ Write a file holding personal data (CV, profile, saved answers) locked to owner-only
// ➤ (0600), so another local user on a shared box can't read it. chmod is a harmless no-op
// ➤ without POSIX permissions (Windows).
function writePrivate(path, data) {
  writeFileSync(path, data, 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* not POSIX — ignore */ }
}
function appendPrivate(path, data) {
  const before = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writePrivate(path, before + data);
}

// ➤ Keep the old version before replacing a document you could not retype from memory:
// ➤ exactly ONE backup (<file>.bak), enough to undo an accident without piling up copies.
// ➤ Best-effort — refusing to save the CV you just pasted would be worse than a failed
// ➤ backup.
function backupBeforeOverwrite(path) {
  try {
    if (!existsSync(path)) return;
    copyFileSync(path, `${path}.bak`);
    try { chmodSync(`${path}.bak`, 0o600); } catch { /* not POSIX — ignore */ }
  } catch { /* nothing to keep, or nowhere to keep it */ }
}
import {
  sendTelegram, sendTelegramMessage, deleteTelegramMessage, sendTelegramButtons, editTelegramMarkup, clearTelegramButtons, answerCallback, downloadTelegramFile,
} from './notify.mjs';
// ➤ Terms → ESCO occupations (free EU API, disk-cached): what turns a CV's skills into the
// ➤ person's actual professional area(s) — an accountant's, a salesman's, or both.
import { occupationsForTerms } from './esco.mjs';
import { fold } from './text.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const STATE_PATH = join(ROOT, 'data', 'onboarding-state.json');
const ANSWERS_PATH = join(ROOT, 'data', 'onboarding-answers.json');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const CV_PATH = join(ROOT, 'cv.md');
// ➤ A pasted message that fills Telegram's limit is almost certainly not the end of the
// ➤ document: from this length on, the setup waits for the rest before moving on.
const CV_CHUNK_HINT = 3900;
const COVER_EXAMPLE_PATH = join(ROOT, 'config', 'cover-example.md');

// ── Catalogs for the button questions ────────────────────────────────────
// ➤ Countries offered as buttons, each with its display label and (when it exists) the
// ➤ Adzuna domain code. aliases = the country's NATIVE spellings, emitted into
// ➤ locations.allow: that gate is a plain substring test with no translation, and
// ➤ "München, Bayern, Deutschland" contains no "Germany". Full names only — the substring
// ➤ match makes short codes ("ES") unsafe.
const COUNTRY_CATALOG = [
  { name: 'Spain', label: 'SPAIN', adzuna: 'es', aliases: ['España'] },
  { name: 'France', label: 'FRANCE', adzuna: 'fr' },
  { name: 'Germany', label: 'GERMANY', adzuna: 'de', aliases: ['Deutschland'] },
  { name: 'Netherlands', label: 'NETHERLANDS', adzuna: 'nl', aliases: ['Nederland', 'Holland'] },
  { name: 'Belgium', label: 'BELGIUM', adzuna: 'be', aliases: ['België', 'Belgique'] },
  { name: 'United Kingdom', label: 'UK', adzuna: 'gb', aliases: ['UK', 'Great Britain'] },
  { name: 'Ireland', label: 'IRELAND', adzuna: 'ie', aliases: ['Éire'] },
  { name: 'Italy', label: 'ITALY', adzuna: 'it', aliases: ['Italia'] },
  { name: 'Switzerland', label: 'SWITZERLAND', adzuna: 'ch', aliases: ['Schweiz', 'Suisse', 'Svizzera'] },
  { name: 'Austria', label: 'AUSTRIA', adzuna: 'at', aliases: ['Österreich'] },
  { name: 'Norway', label: 'NORWAY', aliases: ['Norge'] },
  { name: 'Denmark', label: 'DENMARK', aliases: ['Danmark'] },
  { name: 'United States', label: 'US', adzuna: 'us', aliases: ['USA'] },
  { name: 'Canada', label: 'CANADA', adzuna: 'ca' },
  { name: 'Remote', label: 'REMOTE' },
];
// ➤ Language code → the regex fragments used to detect it being REQUIRED in an
// ➤ offer body. Any language the user does NOT select becomes "blocked".
const LANG_BLOCK = {
  de: ['german', 'deutsch\\w*', 'alem[áa]n'],
  fr: ['french', 'fran[çc]ais\\w*', 'franc[ée]s'],
  nl: ['dutch', 'nederlands', 'neerland[ée]s', 'flemish', 'vlaams'],
  it: ['italian', 'italiano', 'italien'],
  pt: ['portuguese', 'portugu[êe]s'],
};
// ➤ Degrees offered as buttons → the regex fragment written to degrees_excluded, native
// ➤ spellings included: "mécanique" ends in -que, "électrique"/"Elektrotechnik" open with
// ➤ é/elek, the German and Dutch names for whole majors have their own stems.
const DEGREE_CATALOG = [
  { label: 'Mechanical', value: 'mechanical|m[eé]c[áa]ni[ckq]|maschinenbau|werktuigbouw' },
  { label: 'Electrical', value: '[eé]l[eé][ck]tr[io]|electr[óo]nic' },
  { label: 'Civil', value: 'civil engineer|g[ée]nie civil|bauingenieur|civiele techniek' },
  { label: 'Chemical', value: 'chemical|chemistry|chemie\\b|qu[íi]mic|chimi' },
  { label: 'Aerospace', value: 'aerospace|a[ée]ronauti[ckq]|a[ée]rospatial|raumfahrt|ruimtevaart|luftfahrt' },
  { label: 'Computer Science', value: 'computer scien|inform[áa]ti[ckq]' },
];
// ➤ Common deal-breakers → the negative title keyword written to the profile.
const VETO_CATALOG = [
  { label: 'Sales', value: 'Sales' },
  { label: 'Internships', value: 'Intern' },
  { label: 'Night shifts', value: 'Night shift' },
  { label: 'Seagoing / rotations', value: 'Roustabout' },
  { label: 'Pure software', value: 'Developer' },
  { label: 'AI / ML', value: 'AI Engineer' },
  { label: 'Technician', value: 'Technician' },
];
// ➤ Seniority terms added to the negative titles when the user picks "Junior".
const SENIORITY_NEGATIVES = ['Senior', 'Lead', 'Principal', 'Manager', 'Director', 'Head of', 'Chief'];

// ── The questionnaire ────────────────────────────────────────────────────
// ➤ kind: 'cv' | 'text' | 'single' | 'multi' | 'skip-text'.
// ➤ options for single/multi are {label, value}; multi answers are arrays.
const QUESTIONS = [
  { key: 'cv', kind: 'cv',
    prompt: 'Argus setup\n\nFirst, your CV: attach it as a PDF (the paperclip button) or paste its text. It becomes the basis for filtering and for your cover letters.' },
  { key: 'name', kind: 'text',
    prompt: 'Your full name (used to sign cover letters):' },
  { key: 'contact', kind: 'contact',
    prompt: 'Contact details: email, phone, city — comma-separated, any order, and any of them alone is fine. The city goes in your cover letters; the email and phone are only kept in your profile for you to copy when applying.' },
  { key: 'roles', kind: 'text',
    prompt: 'Job titles you are looking for (comma-separated). e.g. automation engineer, PLC, controls, instrumentation' },
  { key: 'fields', kind: 'text',
    prompt: 'Fields you can legitimately claim (experience or degree), comma-separated. e.g. marine, offshore, automation, GIS' },
  { key: 'level', kind: 'single', prompt: 'Your target level:',
    options: [{ label: 'Junior', value: 'junior' }, { label: 'Mid', value: 'mid' }, { label: 'Senior', value: 'senior' }] },
  { key: 'max_years', kind: 'single',
    prompt: 'Maximum years of experience an offer can require (more than that is dropped):',
    options: [{ label: '1', value: '1' }, { label: '2', value: '2' }, { label: '3', value: '3' }, { label: '5', value: '5' }, { label: '7+', value: '7' }] },
  { key: 'languages', kind: 'multi', prompt: 'Languages you can work in (tap to select, then Done):',
    options: [
      { label: 'English', value: 'en' }, { label: 'Spanish', value: 'es' }, { label: 'Catalan', value: 'ca' },
      { label: 'French', value: 'fr' }, { label: 'German', value: 'de' }, { label: 'Dutch', value: 'nl' },
      { label: 'Italian', value: 'it' }, { label: 'Portuguese', value: 'pt' },
    ] },
  { key: 'degrees_excluded', kind: 'multi',
    prompt: 'Degrees offers often require that you do NOT have (tap to select, then Done):',
    options: DEGREE_CATALOG },
  { key: 'countries', kind: 'multi',
    prompt: 'Countries you want (tap to select; unselected = excluded from the search). Then Done:',
    options: COUNTRY_CATALOG.map(c => ({ label: c.label, value: c.name })) },
  { key: 'vetoes', kind: 'multi', prompt: 'Deal-breakers to always exclude (tap to select, then Done):',
    options: VETO_CATALOG },
  { key: 'cover_example', kind: 'skip-text',
    prompt: 'Optional: paste a cover letter you like as an example.' },
];
const Q_BY_KEY = Object.fromEntries(QUESTIONS.map((q, i) => [q.key, { ...q, index: i }]));

// ➤ What the CV itself can tell the setup — no LLM, the rule-based route the open-source
// ➤ resume parsers use, with the buttons as the human confirmation. Degrees: the catalog's
// ➤ values are ALREADY multilingual regexes (the stems the offer filter matches), so the
// ➤ CV is tested against the very definition of each family. A family the CV shows is NOT
// ➤ pre-ticked as excluded; everything else is. Over- or under-detection costs one tap
// ➤ either way: a default, never a decision.
export function cvDegreesHeld(cvText, catalog = DEGREE_CATALOG) {
  const t = String(cvText || '');
  return catalog
    .filter(o => { try { return new RegExp(o.value, 'i').test(t); } catch { return false; } })
    .map(o => o.value);
}

// ➤ The person's name, read the way rule-based resume parsers read it: CVs open with the
// ➤ name, so the first early line that LOOKS like one — two to four capitalised words, no
// ➤ digits, no @, not a header word like "Curriculum" — is it. A miss means no suggestion;
// ➤ a wrong hit costs one retype. Name particles stay lowercase in real names (Fernández
// ➤ DE Silva, VAN der Berg), so "every word capitalised" would reject half of Europe.
const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'van', 'von', 'der', 'den', 'da', 'das', 'dos', 'di', 'du', 'le', 'el', 'al', 'bin', 'ter']);
// ➤ Job words: "Senior Accountant" has exactly a name's SHAPE. Anything that
// ➤ names a trade is a headline, not a person.
const NAME_JOB_WORDS = /(senior|junior|engineer|ingenier|developer|programmer|manager|accountant|contable|contabilidad|contador|auditor|analyst|analista|consultant|consultor|technician|t[ée]cnic|director|specialist|especialista|assistant|asistente|coordinator|coordinador|administrat|abogad|enfermer|nurse|profesor|teacher|designer|dise[ñn]ador|scientist|cient[íi]fic|architect|arquitect|comercial|sales|ventas|marketing|finanzas|student|estudiante|graduate|graduad|licenciad|doctor|lawyer|freelance|responsable|executive|officer)/i;
const NAME_SECTION_WORDS = /(experience|experiencia|education|formaci[óo]n|skills|habilidades|languages|idiomas|summary|resumen|objective|objetivo|profile|perfil|about|sobre m[íi]|contact|direcci[óo]n|address|phone|tel[ée]fono|\b[áa]rea de\b)/i;

// ➤ Designed CVs letter-space their subtitles — L I C . E N C O N T A B I…
// ➤ — and pdf-parse glues the first of those capitals onto the word before
// ➤ it ("RodríguezL"). Only lines showing such a run are touched: the glued
// ➤ capital is split back off, and the run itself — display art, not words —
// ➤ is dropped, leaving the real words standing ("Rodríguez").
function unglueDisplayText(line) {
  if (!/(?:\b[\p{Lu}]\b[\s.]*){4,}/u.test(line)) return line;
  const spaced = line.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  const out = [];
  let run = [];
  const flush = () => { if (run.length < 4) out.push(...run); run = []; };
  for (const tk of spaced.split(/\s+/)) {
    if (/^[\p{Lu}.]$/u.test(tk)) { run.push(tk); continue; }
    flush();
    out.push(tk);
  }
  flush();
  return out.join(' ').trim();
}
// ➤ Institutions and companies wear name-shaped clothes too ("Universidad Argentina del
// ➤ Comercio" passes the shape test).
const NAME_ORG_WORDS = /(universi|instituto|institut|college|escuela|school|academ|colegio|fundaci|foundation|\bS\.?L\.?\b|\bS\.?A\.?\b|GmbH|B\.?V\.?\b|Ltd|Inc\b|Corp\b)/i;
const foldLetters = s => fold(s).replace(/[^a-z]/g, '');

// ➤ PDFs shout — CAMILA — and a signature should not: only fully-uppercase words are
// ➤ touched, each segment around apostrophes and hyphens capitalised (O'NEILL → O'Neill,
// ➤ JOSÉ-MARÍA → José-María).
function tidyNameCase(name) {
  return String(name).split(' ').map(w => {
    if (!/^[\p{Lu}][\p{Lu}'.’-]+$/u.test(w)) return w;
    return w.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  }).join(' ');
}

// ➤ Feature SCORING, as the open-source parsers do it — never "first line wins", because a
// ➤ CV's first line is as often a headline or an address. With plain text the two
// ➤ strongest features are: job words DISQUALIFY a line, and the CV's own EMAIL vouches
// ➤ for one — mail locals are built from names, so "camilaalegre@" backs "Camila Alegre"
// ➤ and nothing else. No line scores → no suggestion.
export function cvFullName(cvText) {
  const text = String(cvText || '');
  const email = foldLetters((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/) || [''])[0].split('@')[0]);
  const lines = text.split(/\r?\n/).map(l => unglueDisplayText(l.replace(/^#+\s*/, '').trim())).filter(Boolean).slice(0, 15);
  // ➤ Candidates are single lines AND pairs of adjacent short lines, in order: designed CVs
  // ➤ split the name across two lines — CAMILA on one, Alegre on the next — and one word
  // ➤ alone can never pass the two-word floor.
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    candidates.push(lines[i]);
    const a = lines[i], b = lines[i + 1];
    if (b && a.split(/\s+/).length <= 2 && b.split(/\s+/).length <= 3) candidates.push(`${a} ${b}`);
  }
  let best = '';
  let bestScore = 0;
  for (const line of candidates) {
    if (/[\d@/,:|()]/.test(line) || line.length > 48) continue;
    if (/curr[íi]cul|resume|\bcv\b|v[íi]tae/i.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    let caps = 0;
    let shaped = true;
    for (const w of words) {
      if (/^[\p{Lu}][\p{L}'.-]*$/u.test(w)) { caps += 1; continue; }
      if (NAME_PARTICLES.has(w.toLowerCase())) continue;
      shaped = false;
      break;
    }
    if (!shaped || caps < 2) continue;
    let score = 1;
    if (NAME_JOB_WORDS.test(line)) score -= 3;
    if (NAME_SECTION_WORDS.test(line)) score -= 3;
    if (NAME_ORG_WORDS.test(line)) score -= 3;
    if (email) {
      const backed = words.map(foldLetters).filter(w => w.length >= 3 && email.includes(w)).length;
      score += backed >= 2 ? 4 : backed === 1 ? 2 : 0;
    }
    if (score > bestScore) { bestScore = score; best = line; }
  }
  return bestScore >= 1 ? tidyNameCase(best) : '';
}

// ➤ The contact block, straight off the CV, so the setup never asks for an email the
// ➤ document has just printed. Email is a regex; a phone needs nine digits or a +/(
// ➤ opening, so the year range "2014 – 2018" — eight digits with a dash — can never pass
// ➤ for one; the city is the early "Place, Country" line: comma-separated capitalised
// ➤ words with no digits and no trade/org words. Any piece can be missing.
export function cvContact(cvText) {
  const text = String(cvText || '');
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
  let phone = '';
  for (const m of text.matchAll(/(?:\+|\()[\d\s()+.-]{8,}|\b\d[\d\s().-]{8,}\d\b/g)) {
    const cand = m[0].trim();
    const digits = (cand.match(/\d/g) || []).length;
    if (digits >= 9 || (digits >= 8 && /^[+(]/.test(cand))) { phone = cand.replace(/\s+/g, ' '); break; }
  }
  let city = '';
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 12)) {
    if (!line.includes(',') || /[\d@]/.test(line) || line.length > 40) continue;
    if (NAME_JOB_WORDS.test(line) || NAME_ORG_WORDS.test(line) || NAME_SECTION_WORDS.test(line)) continue;
    const parts = line.split(',').map(p => p.trim());
    if (parts.length > 3 || parts.some(p => !/^[\p{Lu}][\p{L}\s.'-]*$/u.test(p))) continue;
    city = line;
    break;
  }
  return { email, phone, city };
}

// ➤ Pulls candidate skills out of the CV: section heading + keyword rules, no model, no
// ➤ network. The Skills block opens at an H2 ("## Skills"), stays open across sub-headings
// ➤ ("### Technical") and closes at the next H2 — the shape almost every CV uses.
export function extractCvSkills(cvText) {
  const out = [];
  let inSkills = false;
  for (const line of String(cvText || '').split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length <= 2) inSkills = /skill|habilidad|competenc|aptitud/i.test(h[2]);
      continue;
    }
    if (!inSkills) continue;
    // ➤ ➜ Parenthesised asides go BEFORE the split, or "English: C1 (some exam 7.0, awarding
    // ➤ body 2023)" is torn in two by the comma and its tail survives as a fake skill.
    const body = line.replace(/^[-*]\s*/, '').replace(/\([^)]*\)/g, '').replace(/\*\*[^*]*:\*\*/, '').replace(/\*\*/g, '');
    for (const piece of body.split(/[,/;]/)) {
      const s = piece.replace(/\([^)]*\)/g, '').replace(/[()]/g, '').trim();
      if (!s || s.length < 3 || s.length > 34 || s.split(/\s+/).length > 4) continue;
      // ➜ Leftovers of a stripped parenthesis ("IDP 2023", "7.0") are not skills.
      if (!/[a-z]{3}/i.test(s) || /^\d/.test(s)) continue;
      // ➤ Languages and their levels are not searchable skills.
      if (/^(native|nativo|nativa|c1|c2|b1|b2|a2|a1|spanish|catalan|english|dutch|german|french)\b/i.test(s)) continue;
      out.push(s);
    }
  }
  return [...new Set(out)];
}

// ➤ Everything the CV volunteers, in one bag the state can carry.
export function cvSuggestions(cvText) {
  const contact = cvContact(cvText);
  return {
    name: cvFullName(cvText),
    contact,
    contactText: [contact.email, contact.phone, contact.city].filter(Boolean).join(', '),
    degreesHeld: cvDegreesHeld(cvText),
    fields: extractCvSkills(cvText).slice(0, 8),
  };
}

// ➤ Degree families by professional AREA, so an accountant is asked about Economics and
// ➤ ADE, not Aerospace. Multilingual regexes like DEGREE_CATALOG (which IS the engineering
// ➤ area). Curated and small: the degrees offers in each area actually name.
const AREA_DEGREES = {
  business: [
    { label: 'Business Administration', value: "business admin|ADE\\b|betriebswirtschaft|BWL\\b|bedrijfskunde|administraci[óo]n de empresas|gestion d'entreprise" },
    { label: 'Economics', value: 'econom' },
    { label: 'Accounting / Finance', value: 'accounting|contabilidad|finance|finanzas|rechnungswesen|comptabilit' },
    { label: 'Marketing', value: 'marketing|publicidad' },
  ],
  ict: [
    { label: 'Computer Science', value: 'computer scien|inform[áa]ti[ckq]' },
    { label: 'Telecommunications', value: 'telecom' },
  ],
  health: [
    { label: 'Medicine', value: 'medicin|medizin' },
    { label: 'Nursing', value: 'nursing|enfermer|verpleegkunde|krankenpflege' },
    { label: 'Pharmacy', value: 'pharmac|farmacia|pharmazie' },
  ],
  law: [{ label: 'Law', value: 'law degree|derecho|rechtswissenschaft|droit\\b|rechten\\b' }],
  education: [{ label: 'Education', value: 'education degree|magisterio|pedagog|lehramt' }],
  science: [
    { label: 'Physics', value: 'physics|f[íi]sica|physik' },
    { label: 'Biology', value: 'biolog' },
    { label: 'Chemistry', value: 'chemistry|chemie\\b|qu[íi]mic|chimi' },
  ],
};

// ➤ ISCO-08 sub-major group (the occupation code's first two digits) → areas.
// ➤ 21 carries both: it holds physicists AND engineers.
const ISCO_TO_AREA = {
  21: ['engineering', 'science'], 31: ['engineering'],
  12: ['business'], 13: ['business'], 14: ['business'], 24: ['business'], 33: ['business'], 41: ['business'], 52: ['business'],
  25: ['ict'], 35: ['ict'],
  22: ['health'], 32: ['health'],
  26: ['law'],
  23: ['education'],
};

// ➤ The full CV reading: skills stay local; the skills are then matched to ESCO
// ➤ occupations, whose labels become ROLE suggestions and whose ISCO areas pick which
// ➤ DEGREE families the question should even ask about. Every area the CV shows
// ➤ contributes — a person who was accountant AND salesman gets both, because either could
// ➤ be the job they actually want. No network, or ESCO knowing none of the terms, degrades
// ➤ to the offline suggestions — never an error, never a guess.
export async function cvProfileSuggestions(cvText, deps = {}) {
  const out = { ...cvSuggestions(cvText), roles: [], degreeOptions: [] };
  let occs = [];
  try {
    // ➤ top 8, matching the role row's own cap: top 6 was slicing off the
    // ➤ LAST term's occupations — on a mixed CV, exactly the second trade.
    const lookup = (deps.occupations || occupationsForTerms)(out.fields, { top: 8 });
    // ➤ A hard 20s ceiling for the WHOLE stage: the setup must never feel hung.
    occs = (await Promise.race([lookup, new Promise(r => setTimeout(r, deps.deadlineMs || 20_000, null))])) || [];
  } catch { occs = []; }
  // ➤ Breadth first: one label from EVERY occupation before any second one, or the first
  // ➤ profession's synonyms eat all eight slots and the CV's OTHER trade never appears. The
  // ➤ singular/plural fold keeps bookkeeper/bookkeepers twins out.
  const roles = [];
  const seenRole = new Set();
  for (const pass of [0, 1]) {
    for (const o of occs) {
      const label = (o.labels?.en?.length ? o.labels.en : [o.title]).filter(Boolean)[pass];
      if (!label) continue;
      const key = String(label).toLowerCase().replace(/s$/, '');
      if (seenRole.has(key)) continue;
      seenRole.add(key);
      roles.push(String(label));
    }
  }
  out.roles = roles.slice(0, 8);
  const areas = [...new Set(occs.flatMap(o => ISCO_TO_AREA[String(o.code).slice(0, 2)] || []))];
  const opts = [];
  for (const a of areas) {
    for (const d of (a === 'engineering' ? DEGREE_CATALOG : AREA_DEGREES[a] || [])) {
      if (!opts.some(x => x.label === d.label)) opts.push(d);
    }
  }
  out.degreeOptions = opts.slice(0, 10);
  // ➤ Held-degree evidence runs against the catalog the user will SEE.
  out.degreesHeld = cvDegreesHeld(cvText, out.degreeOptions.length ? out.degreeOptions : DEGREE_CATALOG);
  return out;
}

// ➤ The one intake wrapper both CV paths share: an honest "working on it" note while ESCO
// ➤ is consulted (seconds, once — cached), deleted when done. Falls back to the offline
// ➤ suggestions on any trouble.
async function readCvForSuggestions(cvText) {
  const noteId = await sendTelegramMessage('Reading your CV — matching it against the EU occupation map takes a few seconds.', { silent: true });
  let suggest;
  try { suggest = await cvProfileSuggestions(cvText); }
  catch { suggest = cvSuggestions(cvText); }
  if (noteId != null) { try { await deleteTelegramMessage(noteId); } catch { /* the note stays; harmless */ } }
  return suggest;
}

// ➤ The options a question actually shows: the CV-picked degree families when they exist,
// ➤ the shipped catalog otherwise. One resolver everywhere a question's options are read,
// ➤ so the keyboard and the tap never see two different lists.
export function optionsFor(q, s) {
  if (q.key === 'degrees_excluded') {
    // ➤ Fresh suggestions first, then the options SAVED with the answers — what a settings
    // ➤ edit runs on, long after the setup's state is gone.
    const opts = s?.suggest?.degreeOptions?.length ? s.suggest.degreeOptions
      : (s?.answers?.degree_options?.length ? s.answers.degree_options : null);
    if (opts) return { ...q, options: opts };
  }
  return q;
}

// ── State ────────────────────────────────────────────────────────────────
// ➤ { mode: 'setup' | 'edit', step, editKey, answers:{}, msgId } — msgId is the
// ➤ current button message, so it can be edited in place as options toggle.
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { return null; }
}
function saveState(s) {
  try { writePrivate(STATE_PATH, JSON.stringify(s)); } catch { /* best-effort */ }
}
function clearState() {
  try { writePrivate(STATE_PATH, JSON.stringify({ active: false })); } catch { /* best-effort */ }
}
// ➤ The COMPLETED answers (data/onboarding-answers.json) are the source of truth:
// ➤ profile.yml is generated FROM them, so editing one field regenerates the file without
// ➤ losing the others. null = not set up yet.
function loadAnswers() {
  try { return JSON.parse(readFileSync(ANSWERS_PATH, 'utf-8')); } catch { return null; }
}
function saveAnswers(a) {
  try { writePrivate(ANSWERS_PATH, JSON.stringify(a)); } catch { /* best-effort */ }
}
// ➤ True while a setup or an edit is waiting for the user's next message/tap.
export function onboardingActive() {
  const s = loadState();
  return !!(s && s.active);
}

// ── Rendering the button questions ─────────────────────────────────────────
// ➤ Builds the inline-keyboard rows for a question. Selected options get a ✅.
// ➤ Two options per row; multi questions add a final "Done" row.
function buttonRows(q, selected) {
  const sel = new Set(selected || []);
  const opts = q.options.map((o, i) => ({
    label: (q.kind === 'multi' && sel.has(o.value) ? '✅ ' : '') + o.label,
    data: `o:${i}`,
  }));
  const rows = [];
  for (let i = 0; i < opts.length; i += 2) rows.push(opts.slice(i, i + 2));
  if (q.kind === 'multi') rows.push([{ label: 'Done', data: 'done' }]);
  return rows;
}

// ➤ Sends the current question (text prompt, or a message with buttons). For
// ➤ button questions it stores the message id so taps can edit it in place.
async function askCurrent(s) {
  const q = s.mode === 'edit' ? Q_BY_KEY[s.editKey] : QUESTIONS[s.step];
  if (!q) return finish(s);
  // ➤ Every TYPED question says on screen how to get out: while the setup waits for text
  // ➤ your normal commands stop working — whatever you type is the answer — so the way out
  // ➤ must be written where you're looking.
  let prompt = (q.kind === 'single' || q.kind === 'multi') ? q.prompt : `${q.prompt}\n\n(or type "cancel" to stop)`;
  // ➤ CV-informed defaults: the degrees list arrives pre-ticked — excluded — for every
  // ➤ family the CV shows no sign of, and the fields question carries the CV's own skills as
  // ➤ a one-tap suggestion. Defaults, never decisions: the user confirms every tick.
  const qq = optionsFor(q, s);
  if (q.key === 'degrees_excluded' && s.suggest && s.answers[q.key] == null) {
    const held = new Set(s.suggest.degreesHeld || []);
    s.answers[q.key] = qq.options.map(o => o.value).filter(v => !held.has(v));
    // ➤ The options RIDE WITH the answers: a later settings edit rebuilds its state from the
    // ➤ saved answers alone, and without this the keyboard would fall back to the shipped
    // ➤ catalog — wrong ticks, and the CV-picked families unreachable for ever after.
    if (s.suggest.degreeOptions?.length) s.answers.degree_options = s.suggest.degreeOptions;
    prompt += s.suggest.degreeOptions?.length
      ? "\n\nThese families come from your CV's own professional area, pre-ticked where it shows no such degree. Adjust if needed, then Done."
      : '\n\nPre-ticked from your CV: the degrees it shows no sign of. Adjust if needed, then Done.';
  }
  // ➤ Typed questions with a CV-derived answer ready: the name from the CV's opening line,
  // ➤ the contact from its contact block, roles from the ESCO occupations of its area(s),
  // ➤ fields from its own skills. One tap takes it; typing still wins.
  const sug = q.key === 'contact' ? s.suggest?.contactText : s.suggest?.[q.key];
  const sugText = Array.isArray(sug) ? sug.join(', ') : String(sug || '');
  if ((q.key === 'name' || q.key === 'contact' || q.key === 'fields' || q.key === 'roles') && sugText && !s.answers[q.key]) {
    prompt += `\n\nSuggested from your CV: ${sugText}\nSend your own, or take ${Array.isArray(sug) ? 'these' : 'it'} with the button.`;
    const msgId = await sendTelegramButtons(prompt, [[{ label: Array.isArray(sug) ? 'Use suggestions' : 'Use suggestion', data: 'use' }]]);
    s.msgId = msgId;
    saveState(s);
    return;
  }
  // ➤ SEND FIRST, persist AFTER: a state saved before the prompt goes out would, on one
  // ➤ failed Telegram send, point at a question nobody saw — and the next thing typed would
  // ➤ be recorded as its answer. Failing before the save just re-asks the question.
  if (q.kind === 'single' || q.kind === 'multi') {
    const msgId = await sendTelegramButtons(prompt, buttonRows(qq, s.answers[q.key]));
    s.msgId = msgId;
    saveState(s);
  } else if (q.kind === 'skip-text') {
    // ➤ The optional question carries its way out as a button. Typing "skip" still works;
    // ➤ typed text still answers.
    const msgId = await sendTelegramButtons(prompt, [[{ label: 'Skip', data: 'skip' }]]);
    s.msgId = msgId;
    saveState(s);
  } else {
    await sendTelegram(prompt);
    s.msgId = null;
    saveState(s);
  }
}

// ── Public entry points ─────────────────────────────────────────────────
// ➤ `/start` → begin the full setup from question 0, ASKING FIRST IF YOU ALREADY HAVE A
// ➤ PROFILE: question 0 is "paste your CV", and while the setup runs the listener hands
// ➤ ANY text you type to it before looking for a command — typing "list" would overwrite
// ➤ your entire CV, the only copy your cover letters are built from. `settings` refuses to
// ➤ run without a profile; this is the same guard the other way. A CV worth protecting is
// ➤ longer than the shipped placeholder and does not say so.
function hasRealCv() {
  try {
    const t = readFileSync(CV_PATH, 'utf-8');
    return t.length > 400 && !/this is a placeholder/i.test(t);
  } catch { return false; }
}

export async function startOnboarding(force = false) {
  if (!force && (loadAnswers() || hasRealCv())) {
    await sendTelegram([
      'You already have a profile set up.',
      '',
      'Starting again REPLACES your CV and every answer.',
      'To change one thing instead, type <code>settings</code>.',
      '',
      'To go ahead anyway, type <code>/start yes</code>.',
    ].join('\n'), { html: true });
    return;
  }
  const s = { active: true, mode: 'setup', step: 0, answers: {}, msgId: null };
  saveState(s);
  await askCurrent(s);
}

// ➤ A way out. Without it the only escape from the setup was answering all twelve
// ➤ questions or hand-editing a state file over SSH — with every message typed meanwhile
// ➤ written into the profile.
export async function cancelOnboarding() {
  clearState();
  await sendTelegram('Setup cancelled. Nothing else was changed.');
}

// ➤ `settings` → show a menu to edit ANY single answer later.
export async function startSettings() {
  // ➤ Guard: without a completed profile, regenerating from a single edit would
  // ➤ wipe the rest. Point the user to /start instead.
  if (!loadAnswers()) {
    await sendTelegram('No profile yet. Type /start to set it up first.');
    return;
  }
  const rows = [];
  // ➤ Every question, the CV included: replacing it is the whole point of being able to edit one field.
  const editable = QUESTIONS;
  for (let i = 0; i < editable.length; i += 2) {
    rows.push(editable.slice(i, i + 2).map(q => ({ label: labelFor(q.key), data: `edit:${q.key}` })));
  }
  await sendTelegramButtons('Settings — tap a field to edit it:', rows);
}
function labelFor(key) {
  return {
    cv: 'CV', name: 'Name', contact: 'Contact', roles: 'Target roles', fields: 'Fields',
    level: 'Level', max_years: 'Max years', languages: 'Languages',
    degrees_excluded: 'Excluded degrees', countries: 'Countries', vetoes: 'Deal-breakers',
    cover_example: 'Cover example',
  }[key] || key;
}

// ➤ Reads the contact answer by the SHAPE of each piece, not its position: the email has
// ➤ an @, the phone is digits, whatever remains is the city — any order, any of them
// ➤ alone. A positional read would put "Barcelona, mail@x" city-first into the email slot.
export function parseContact(text) {
  const out = { email: '', phone: '', city: '' };
  const leftovers = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const p = raw.trim();
    if (!p) continue;
    if (!out.email && /\S+@\S+\.\S+/.test(p)) { out.email = p; continue; }
    if (!out.phone && /^[+(]?[\d\s()+.-]+$/.test(p) && (p.match(/\d/g) || []).length >= 6) { out.phone = p.replace(/\s+/g, ' '); continue; }
    leftovers.push(p);
  }
  // ➤ Every unclaimed piece is the city ("Sant Cugat, Barcelona" arrives as two).
  out.city = leftovers.join(', ');
  return out;
}

// ➤ A second round only FILLS GAPS: what the first answer established stays.
export function mergeContact(base, extra) {
  const b = base || { email: '', phone: '', city: '' };
  return { email: b.email || extra.email, phone: b.phone || extra.phone, city: b.city || extra.city };
}

// ➤ One road for the contact answer, typed or tapped: the [Use suggestion] button feeds
// ➤ the CV's own contact line through here, so a CV missing a piece gets the same honest
// ➤ "Missing: ..." round.
async function applyContactAnswer(s, value) {
  // ➤ "skip" moves on with whatever exists — sharing nothing is a valid
  // ➤ answer, and some people will not give a phone number.
  if (/^skip$/i.test(value)) {
    delete s.contactPending;
    s.answers.contact_parts = s.answers.contact_parts || { email: '', phone: '', city: '' };
    s.answers.contact = s.answers.contact || '';
    await advance(s);
    return true;
  }
  const parts = mergeContact(s.contactPending ? s.answers.contact_parts : null, parseContact(value));
  s.answers.contact_parts = parts;
  s.answers.contact = [parts.email, parts.phone, parts.city].filter(Boolean).join(', ');
  const missing = ['email', 'phone', 'city'].filter(k => !parts[k]);
  // ➤ Say ONCE what was understood and what is absent — "just an email" must not march on in
  // ➤ silence, because the city it would lose is what the cover letters and the home-city
  // ➤ group run on. One round, never a nag: the second answer (or Skip) always moves on.
  if (missing.length && !s.contactPending) {
    const got = ['email', 'phone', 'city'].filter(k => parts[k]);
    const msgId = await sendTelegramButtons(
      `Saved: ${got.join(', ') || 'nothing recognisable yet'}. Missing: ${missing.join(' and ')} — send ${missing.length > 1 ? 'them' : 'it'} now, or Skip.`,
      [[{ label: 'Skip', data: 'skip' }]],
    );
    s.contactPending = true;
    s.msgId = msgId;
    saveState(s);
    return true;
  }
  delete s.contactPending;
  await advance(s);
  return true;
}

// ➤ Handles a TEXT message while onboarding/editing is active (CV paste, name,
// ➤ roles, cover example...). Returns true if it consumed the message.
export async function handleOnboardingText(text) {
  const s = loadState();
  if (!s || !s.active) return false;
  // ➤ CANCEL IS CHECKED FIRST, before the question is even looked at and before anything is
  // ➤ stored: while the setup runs every text you send is kept as an answer, so there has to
  // ➤ be one word that never is.
  if (/^(cancel|cancelar)$/i.test(String(text || '').trim())) {
    await cancelOnboarding();
    return true;
  }
  const q = s.mode === 'edit' ? Q_BY_KEY[s.editKey] : QUESTIONS[s.step];
  if (!q || !(q.kind === 'text' || q.kind === 'cv' || q.kind === 'skip-text' || q.kind === 'contact')) return false;

  const value = String(text || '').trim();
  if (q.kind === 'contact') return applyContactAnswer(s, value);
  // ➤ Still collecting a CV that arrived in pieces: append rather than replace, and move
  // ➤ on only when the user says it is complete.
  if (s.answers.cvPartial && q.kind === 'cv') {
    if (/^done$/i.test(value)) {
      s.answers.cvPartial = false;
      try { s.suggest = await readCvForSuggestions(readFileSync(CV_PATH, 'utf-8')); } catch { /* no CV, no suggestions */ }
      await advance(s);
      return true;
    }
    appendPrivate(CV_PATH, '\n' + value + '\n');
    saveState(s);
    await sendTelegram('Added. Paste more, or type "done" when the CV is complete.');
    return true;
  }
  if (q.kind === 'cv') {
    // ➤ Keep the previous CV before overwriting it: your copy is not a git repo and nothing
    // ➤ else holds this file, so without the backup one mistyped message costs the document
    // ➤ every cover letter starts from.
    backupBeforeOverwrite(CV_PATH);
    writePrivate(CV_PATH, value + '\n');
    s.answers.cv = 'saved';
    if (value.length >= CV_CHUNK_HINT) {
      s.answers.cvPartial = true;
      saveState(s);
      await sendTelegram('Got that piece. Telegram splits long messages, so if your CV continues, paste the rest now — I will add it on. When it is complete, type "done".');
      return true;
    }
    s.answers.cvPartial = false;
    s.suggest = await readCvForSuggestions(value);
  } else if (q.kind === 'skip-text') {
    if (!/^skip$/i.test(value) && value) {
      writePrivate(COVER_EXAMPLE_PATH, value + '\n');
      s.answers[q.key] = 'saved';
    }
  } else {
    // ➤ Short text answers (name, contact, roles, fields) are single-line by nature: pasted
    // ➤ line breaks collapse to spaces so they can't corrupt the generated YAML. (The CV keeps
    // ➤ its line breaks — it's a document.)
    s.answers[q.key] = value.replace(/\s+/g, ' ');
  }
  await advance(s);
  return true;
}

// ➤ Extracts the text of a PDF locally with pdf-parse v2 — no service, no key. Its "-- N
// ➤ of M --" page markers are noise in a CV and are stripped. Exported so the tests can
// ➤ feed it a real PDF.
export async function pdfText(buf) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try {
    const out = await parser.getText();
    return String(out?.text || '').replace(/^\s*-- \d+ of \d+ --\s*$/gm, '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ➤ Handles a DOCUMENT while the setup waits for the CV (people send the PDF they have).
// ➤ Only the CV question consumes files; elsewhere the document is left unanswered and the
// ➤ question on screen still applies. Returns true if consumed.
export async function handleOnboardingDocument(doc) {
  const s = loadState();
  if (!s || !s.active) return false;
  const q = s.mode === 'edit' ? Q_BY_KEY[s.editKey] : QUESTIONS[s.step];
  if (!q || q.kind !== 'cv') return false;
  const name = String(doc?.file_name || '').toLowerCase();
  // ➤ Word documents on purpose get their own line: "export it as PDF" is a
  // ➤ button every editor has, while a generic refusal reads as a dead end.
  if (/\.(docx?|odt|rtf|pages)$/.test(name)) {
    await sendTelegram('I can read PDF or plain text. Export the CV as a PDF (every editor has "Save as PDF") and send that.');
    return true;
  }
  if (!/\.(pdf|txt|md)$/.test(name)) {
    await sendTelegram('That file type I cannot read. Send the CV as a PDF, or paste its text.');
    return true;
  }
  const buf = await downloadTelegramFile(doc.file_id);
  if (!buf) {
    await sendTelegram('The file could not be downloaded — send it again, or paste the text.');
    return true;
  }
  let text = '';
  try { text = name.endsWith('.pdf') ? await pdfText(buf) : buf.toString('utf-8'); }
  catch { /* unreadable: the length check below answers */ }
  text = String(text || '').trim();
  // ➤ A scanned PDF has pages but no words; 200 characters separates that
  // ➤ from any real CV.
  if (text.length < 200) {
    await sendTelegram('That PDF has no readable text — is it a scan? Export a text-based PDF from your editor, or paste the text.');
    return true;
  }
  backupBeforeOverwrite(CV_PATH);
  writePrivate(CV_PATH, text + '\n');
  s.answers.cv = 'saved';
  s.suggest = await readCvForSuggestions(text);
  await advance(s);
  return true;
}

// ➤ Handles a BUTTON tap (callback_query.data) while active. `cbId` acknowledges
// ➤ the tap. Returns true if consumed.
export async function handleOnboardingCallback(data, cbId, messageId = null) {
  const s = loadState();
  // ➤ "edit:<key>" can arrive from the settings menu even when not mid-flow.
  if (String(data || '').startsWith('edit:')) {
    const key = data.slice(5);
    // ➤ Edit starts from the SAVED answers (source of truth), so regenerating
    // ➤ the profile keeps every other field intact.
    const base = loadAnswers();
    if (!base) { await answerCallback(cbId); await sendTelegram('No profile yet. Type /start first.'); return true; }
    if (Q_BY_KEY[key]) {
      const st = { active: true, mode: 'edit', editKey: key, answers: base, msgId: null };
      saveState(st);
      await answerCallback(cbId);
      await askCurrent(st);
      return true;
    }
  }
  if (!s || !s.active) { await answerCallback(cbId); return false; }
  const q = s.mode === 'edit' ? Q_BY_KEY[s.editKey] : QUESTIONS[s.step];
  // ➤ BOUND TO ITS MESSAGE, like the list pages and the review card: a tap on an
  // ➤ already-closed question must not land on the CURRENT one (same o:N data, same
  // ➤ positions — re-ticking a finished degrees list would tick countries). A tap on any
  // ➤ other message only gets a toast.
  if (s.msgId != null && messageId != null && messageId !== s.msgId) {
    await answerCallback(cbId, 'That question is already closed — the active one is below.');
    return true;
  }
  // ➤ The Skip button: one tap does what typing "skip" always did — move on without saving
  // ➤ more. The optional question wears it, and so does the contact follow-up (whatever was
  // ➤ recognised is already saved).
  if (data === 'skip' && (q?.kind === 'skip-text' || (q?.kind === 'contact' && s.contactPending))) {
    delete s.contactPending;
    await answerCallback(cbId);
    await advance(s);
    return true;
  }
  // ➤ [Use suggestion] on the contact question rides the SAME road as typing
  // ➤ it: parsed by shape, and a CV missing a piece gets the Missing round.
  if (data === 'use' && q?.kind === 'contact' && s.suggest?.contactText && !s.contactPending) {
    await answerCallback(cbId);
    await applyContactAnswer(s, s.suggest.contactText);
    return true;
  }
  // ➤ The [Use suggestion(s)] button on name, fields and roles: the
  // ➤ CV-derived answer lands exactly as if it had been typed.
  if (data === 'use' && (q?.key === 'name' || q?.key === 'fields' || q?.key === 'roles')) {
    const sug = s.suggest?.[q.key];
    const val = Array.isArray(sug) ? sug.join(', ') : String(sug || '');
    if (val) {
      s.answers[q.key] = val;
      await answerCallback(cbId);
      await advance(s);
      return true;
    }
  }
  if (!q || !(q.kind === 'single' || q.kind === 'multi')) { await answerCallback(cbId); return false; }

  if (data === 'done') {                       // multi finished
    await answerCallback(cbId);
    await advance(s);
    return true;
  }
  const m = String(data).match(/^o:(\d+)$/);
  if (!m) { await answerCallback(cbId); return false; }
  // ➤ Resolved through the same lens the keyboard was drawn with, so a tap
  // ➤ can never land on a different option than the one it showed.
  const qq = optionsFor(q, s);
  const opt = qq.options[Number(m[1])];
  if (!opt) { await answerCallback(cbId); return false; }

  if (q.kind === 'single') {
    s.answers[q.key] = opt.value;
    await answerCallback(cbId);
    await advance(s);
  } else {                                     // multi: toggle and redraw in place
    const cur = new Set(s.answers[q.key] || []);
    cur.has(opt.value) ? cur.delete(opt.value) : cur.add(opt.value);
    s.answers[q.key] = [...cur];
    saveState(s);
    await answerCallback(cbId);
    // ➤ Keyboard-only edit: editMessageText resends the whole prompt on every tick and was
    // ➤ most of why ticking felt slow.
    if (s.msgId) await editTelegramMarkup(s.msgId, buttonRows(qq, s.answers[q.key]));
  }
  return true;
}

// ➤ Moves to the next step (setup) or ends the single edit, then persists.
async function advance(s) {
  // ➤ The finished question loses its keyboard FIRST: dead buttons on old questions were
  // ➤ being re-tapped, their o:N landing on the next question's options (the binding above
  // ➤ refuses those taps; this removes the temptation). Best-effort — the binding is the
  // ➤ guarantee.
  if (s.msgId != null) {
    try { await clearTelegramButtons(s.msgId); } catch { /* cosmetic */ }
    s.msgId = null;
  }
  if (s.mode === 'edit') {
    saveAnswers(s.answers);
    writeProfile(s.answers);
    clearState();
    await sendTelegram(`Updated: ${labelFor(s.editKey)}.`);
    return;
  }
  s.step += 1;
  if (s.step >= QUESTIONS.length) return finish(s);
  // ➤ No saveState here: askCurrent persists AFTER the prompt is delivered — saving the
  // ➤ advanced step first would record a question nobody saw.
  await askCurrent(s);
}

// ➤ End of setup: write everything and confirm.
async function finish(s) {
  saveAnswers(s.answers);
  writeProfile(s.answers);
  clearState();
  // ➤ If neither the job titles nor the fields gave anything, the profile cannot filter and
  // ➤ the list will stay empty: say so now, while the user is still here, instead of leaving
  // ➤ them to wonder for a week.
  const usable = splitList(s.answers.roles).length || splitList(s.answers.fields).length;
  await sendTelegram(usable
    ? 'Setup complete. Your profile is saved. Type "search" to find offers, or "settings" to edit anything.'
    : 'Setup saved, but it has nothing to search for: neither the job titles nor the fields question got a usable answer, so every offer would be rejected. Type "settings" and fill in one of them.');
}

// ── Writing the profile (config/profile.yml) ───────────────────────────────
// ➤ Turns the collected answers into a clean, commented config/profile.yml.
// ➤ Only fields the user answered are written; the engine fills the rest with
// ➤ its defaults. Written as a template string so the comments survive (a YAML
// ➤ dump would strip them).
function yamlList(items) {
  return (items && items.length) ? items.map(x => `\n    - ${quote(x)}`).join('') : ' []';
}
function quote(s) {
  // ➤ Quote values YAML could misread (regex fragments, leading symbols) with
  // ➤ SINGLE quotes: unlike double quotes, YAML does NOT process backslash
  // ➤ escapes inside them, so "deutsch\w*" survives verbatim. A literal single
  // ➤ quote inside is doubled ('').
  // ➤ NOTE: newlines are in the trigger set too — a value pasted across two lines and
  // ➤ written unquoted breaks the whole YAML file and silently reverts every filter to the
  // ➤ built-in defaults.
  const str = String(s);
  return /[:#{}\[\],&*!|>'"%@`\\\n\r]/.test(str) ? `'${str.replace(/'/g, "''")}'` : str;
}
function splitList(text) {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}
// ➤ Turn a plain word the user typed into a regex fragment that matches it LITERALLY: the
// ➤ "fields" answer is free text ("C++", "R&D") that later becomes a regex; unescaped,
// ➤ "C++" is invalid and "(a+)+$" a catastrophic-backtracking one. (The hand-authored
// ➤ marine defaults keep their regex power — they never pass here.)
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ➤ The Council prompts a user wrote into config/profile.yml (search.judge_prompts) are
// ➤ not an answer to any question, so a settings edit — which rebuilds the file from the
// ➤ answers alone — would silently erase them. They are read back from the file being
// ➤ replaced and written again, verbatim, at the end of the search block.
function currentJudgePrompts() {
  try {
    const jp = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'))?.search?.judge_prompts;
    return jp && typeof jp === 'object' ? jp : null;
  } catch { return null; }
}
function judgePromptsBlock(jp) {
  if (!jp || typeof jp !== 'object' || !Object.keys(jp).length) return '';
  const block = yaml.dump({ judge_prompts: jp }, { lineWidth: -1, noRefs: true });
  return '\n  # ➤ Your own prompts for the Council\'s judges, kept across settings edits.\n'
    + block.split('\n').map(l => (l ? '  ' + l : l)).join('\n');
}

export function buildProfileYaml(a, keep = {}) {
  // ➤ Contact, structured first: the onboarding stores what each piece IS, so nothing here
  // ➤ depends on the order the user typed. The positional split stays as the fallback for
  // ➤ answers saved before — every settings edit regenerates this file from the old record.
  const legacyContact = splitList(a.contact);
  const cp = a.contact_parts || null;
  const cEmail = cp ? cp.email : (legacyContact[0] || '');
  const cPhone = cp ? cp.phone : (legacyContact[1] || '');
  const cCity = cp ? cp.city : legacyContact.slice(2).join(', ');
  // ➤ AN EMPTY LIST OF ROLES WOULD SWITCH THE TITLE FILTER OFF: an answer of only spaces or
  // ➤ commas comes out as [], which the title filter reads as "no keyword required" — every
  // ➤ job title in the world passes and only the deal-breaker list stands between you and
  // ➤ the market, the opposite of what a blank answer means. With nothing usable the key is
  // ➤ left out and the rules in force stay.
  const roles = splitList(a.roles);
  // ➤ WHAT TO SEARCH FOR WHEN THE ROLES ANSWER GAVE NOTHING USABLE. Neither obvious option
  // ➤ is right: [] tells the scanner no keyword is required; leaving the key out falls back
  // ➤ to portals.yml's shipped MARINE example, so an accountant's bot would fetch accounting
  // ➤ jobs and reject every one for having "no keyword from your field", for ever, in
  // ➤ silence. The fields answered two questions later ARE the user's own, so they are the
  // ➤ fallback: a worse filter than a proper list of titles, but about the right line of
  // ➤ work. Fields become regexes downstream, so each word is escaped to match literally
  // ➤ (roles do not need it — scan.mjs escapes title terms itself).
  const fields = splitList(a.fields).map(reEscape);
  const titleTerms = roles.length ? roles : splitList(a.fields);
  const langs = a.languages || [];
  const blocked = Object.entries(LANG_BLOCK)
    .filter(([code]) => !langs.includes(code))
    .flatMap(([, frags]) => frags);
  const countries = COUNTRY_CATALOG.filter(c => (a.countries || []).includes(c.name));
  const negatives = [
    ...(a.level === 'junior' ? SENIORITY_NEGATIVES : []),
    ...(a.vetoes || []),
  ];
  // ➤ First segment only: the search's home-city group wants "Sant Cugat",
  // ➤ not "Sant Cugat, Barcelona" — the full string keeps riding `location`.
  const homeCity = String(cCity || '').split(',')[0].trim();
  // ➤ The phrases sent to the job boards: the user's roles plus their fields, so the stream
  // ➤ of offers is THEIRS and not the example one — roles first (the strongest signal),
  // ➤ fields after, de-duplicated.
  const queries = [...new Set([...roles, ...fields].map(s => s.toLowerCase()))].slice(0, 8);
  // ➤ The geography to keep: the chosen countries plus the home city, case-insensitively
  // ➤ unique — "Remote" the country and "remote" the way of working are one entry to the
  // ➤ filter, and writing both put the word in the file twice.
  const allowLocations = [...new Map([
    // ➤ Name AND native spellings: the allow gate compares substrings with no translation, and
    // ➤ offers name their country the way the posting's own language does.
    ...countries.flatMap(c => [c.name, ...(c.aliases || [])]),
    ...(homeCity ? [homeCity] : []),
    ...((a.countries || []).includes('Remote') ? ['remote'] : []),
  ].map(v => [v.toLowerCase(), v])).values()];

  return `# Argus profile — generated by the Telegram onboarding (/start). Edit here
# or re-run any question with "settings".

candidate:
  full_name: ${quote(a.name || '')}
  letter_name: ${quote(a.name || '')}
  email: ${quote(cEmail)}
  phone: ${quote(cPhone)}
  location: ${quote(cCity)}
  letter_city: ${quote(homeCity)}

# What the engine reads to filter and judge for you.
search:
  max_years: ${Number(a.max_years) || 2}

  languages:${yamlList(langs)}
  languages_blocked:${yamlList(blocked)}

  home_city: ${quote(homeCity)}
  countries:${countries.length ? countries.map(c => `\n    - { name: ${c.name}, label: ${c.label}${c.adzuna ? `, adzuna: ${c.adzuna}` : ''} }`).join('') : ' []'}
${titleTerms.length ? `\n  positive_titles:${yamlList(titleTerms)}${roles.length ? '' : '\n  # (taken from your fields: the job-titles question was left unanswered)'}` : '\n  # positive_titles: THE SETUP HAS NOTHING TO SEARCH FOR. Answer the job-titles\n  # question with `settings` — until then every offer will be rejected.'}
  negative_titles:${yamlList(negatives)}

  fields:${yamlList(fields)}
  degrees_ok:${yamlList(fields)}
  degrees_excluded:${yamlList(a.degrees_excluded || [])}
  zero_skill_fields:${yamlList([])}
  skill_titles:${yamlList(roles)}

  # ➤ Written EMPTY on purpose (2026-07-27). A term listed here exempts an offer
  # ➤ from the years cap and the degree cuts — a tool or standard so specific to
  # ➤ you that any offer naming it is worth seeing, whatever else it asks for.
  # ➤ Most people have none, and leaving the key out entirely would silently
  # ➤ inherit the shipped marine example's own term. Add yours if you have one.
  priority_terms:${yamlList([])}

  # ➤ WHERE THE OFFERS ARE LOOKED FOR (added 2026-07-25). Without this the
  # ➤ engine would filter YOUR profile against the example marine stream that
  # ➤ portals.yml queries, and your list would simply stay empty for ever.
  # ➤ These are the phrases sent to the job boards. Edit freely: broad works
  # ➤ better than narrow, because the title filter above does the precision.
  queries:${yamlList(queries)}
  # ➤ Only offers whose location contains one of these is kept (empty = keep
  # ➤ every location and let the country toggle decide).
  locations:
    allow:${yamlList(allowLocations)}
    block: []
  # ➤ portals.yml also follows a list of specific employers as a worked marine
  # ➤ example. false = do not spend requests on them; your search comes from the
  # ➤ queries above. Set it to true if that example list happens to fit you.
  track_example_companies: false
${judgePromptsBlock(keep.judge_prompts)}`;
}

// ➤ Writes the generated profile to config/profile.yml.
function writeProfile(answers) {
  try { writePrivate(PROFILE_PATH, buildProfileYaml(answers, { judge_prompts: currentJudgePrompts() })); }
  catch (e) { console.log(`onboarding: could not write profile: ${e.message}`); }
}
