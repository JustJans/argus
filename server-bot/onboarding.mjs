#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the one-time SETUP flow over Telegram. A new user runs `/start`
// ➤ and Argus walks them through a short questionnaire (CV + a few questions,
// ➤ some with buttons) and writes their profile to config/profile.yml + cv.md,
// ➤ so the generic engine becomes THEIR job searcher. `settings` re-opens any
// ➤ single question later to edit it. The daily commands stay typed; buttons
// ➤ are only used here, where multi-selecting from a fixed list is nicer.
// ➤ HOW IT WORKS: a tiny state machine. The current step + the answers so far
// ➤ live in data/onboarding-state.json. Text answers arrive as normal messages;
// ➤ button taps arrive as callback_query (routed here by telegram-listener.mjs).
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ➤ Write a file that holds personal data (CV, profile, saved answers) and lock
// ➤ it to owner-only (0600) so another local user on a shared box can't read it.
// ➤ chmod is a harmless no-op on systems without POSIX permissions (e.g. Windows).
function writePrivate(path, data) {
  writeFileSync(path, data, 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* not POSIX — ignore */ }
}

// ➤ Keep the old version before replacing a document you could not retype from
// ➤ memory. Exactly ONE backup is kept (<file>.bak): enough to undo an accident,
// ➤ and it can never pile up copies of a private file over the months.
// ➤ Best-effort on purpose — if the backup fails the setup carries on, because
// ➤ refusing to save the CV you just pasted would be the worse outcome.
function backupBeforeOverwrite(path) {
  try {
    if (!existsSync(path)) return;
    copyFileSync(path, `${path}.bak`);
    try { chmodSync(`${path}.bak`, 0o600); } catch { /* not POSIX — ignore */ }
  } catch { /* nothing to keep, or nowhere to keep it */ }
}
import {
  sendTelegram, sendTelegramButtons, editTelegramMarkup, clearTelegramButtons, answerCallback, downloadTelegramFile,
} from './notify.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const STATE_PATH = join(ROOT, 'data', 'onboarding-state.json');
const ANSWERS_PATH = join(ROOT, 'data', 'onboarding-answers.json');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const CV_PATH = join(ROOT, 'cv.md');
const COVER_EXAMPLE_PATH = join(ROOT, 'config', 'cover-example.md');

// ── Catalogs for the button questions ────────────────────────────────────
// ➤ Countries offered as buttons. Each carries the display label and (when it
// ➤ exists) the Adzuna domain code, so the written profile is complete.
// ➤ aliases = the country's NATIVE spellings, emitted into locations.allow
// ➤ (audit 2026-08-08). The allow gate is a plain substring test with no
// ➤ translation, and offers arrive written in their own language —
// ➤ "München, Bayern, Deutschland" contains no "Germany", so for onboarded
// ➤ users nearly every native-spelled location died at the gate in silence
// ➤ (the FR/DE-blocked-for-days incident portals.yml already documents).
// ➤ Full names only: the substring match makes short codes ("ES") unsafe.
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
// ➤ Degrees offered as buttons → the regex fragment written to degrees_excluded.
// ➤ Each value carries the native spellings too (#798, 2026-08-05): "mécanique"
// ➤ ends in -que, "électrique"/"Elektrotechnik" open with é/elek, and the
// ➤ German and Dutch names for whole majors were simply absent from the stems.
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
// ➤ The COMPLETED answers are the source of truth (data/onboarding-answers.json).
// ➤ The profile.yml is generated FROM them, so editing one field regenerates
// ➤ the file WITHOUT losing the others. null = the user hasn't set up yet.
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
  // ➤ Every TYPED question says on screen how to get out. While the setup is
  // ➤ waiting for text your normal commands stop working — whatever you type is
  // ➤ taken as the answer — so the way out has to be written where you're looking.
  const prompt = (q.kind === 'single' || q.kind === 'multi') ? q.prompt : `${q.prompt}\n\n(or type "cancel" to stop)`;
  // ➤ SEND FIRST, persist AFTER (audit 2026-08-08). The state used to be saved
  // ➤ before the prompt went out, so one failed Telegram send left the file
  // ➤ pointing at a question nobody ever saw — and the next thing the user
  // ➤ typed was silently recorded as its answer. Failing before the save just
  // ➤ re-asks the same question, which is harmless.
  if (q.kind === 'single' || q.kind === 'multi') {
    const msgId = await sendTelegramButtons(prompt, buttonRows(q, s.answers[q.key]));
    s.msgId = msgId;
    saveState(s);
  } else if (q.kind === 'skip-text') {
    // ➤ The optional question carries its way out as a button (owner,
    // ➤ 2026-08-23). Typing "skip" still works; typed text still answers.
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
// ➤ `/start` → begin the full setup from question 0.
// ➤ IT ASKS FIRST IF YOU ALREADY HAVE A PROFILE (audit 2026-07-31). Question 0
// ➤ is "paste your CV", and the listener hands any text you type to the setup
// ➤ BEFORE it looks for a command — so with the setup already running, typing
// ➤ "list" wrote the word "list" over your entire CV. There was no confirmation,
// ➤ nothing to cancel with, and cv.md is the only copy: it is what your cover
// ➤ letters are built from. `settings` already refuses to run without a profile;
// ➤ this is the same guard pointing the other way.
export async function startOnboarding(force = false) {
  if (!force && loadAnswers()) {
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

// ➤ A way out. Without this the only escape from the setup was answering all
// ➤ twelve questions or hand-editing a state file over SSH — and every message
// ➤ you typed meanwhile was being written into your profile.
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
  // ➤ Every question, the CV included: replacing it is the whole point of being
  // ➤ able to edit one field. (This was written as a filter that filtered
  // ➤ nothing, which reads like a rule and is not one.)
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

// ➤ Reads the contact answer by the SHAPE of each piece, not its position
// ➤ (field test 2026-08-23): the email is the part with an @, the phone the
// ➤ part that is digits, and whatever remains is the city — in any order, any
// ➤ of them alone. The old positional read put "Barcelona, mail@x" city-first
// ➤ into the email slot and fed the search a phone number as the home city.
export function parseContact(text) {
  const out = { email: '', phone: '', city: '' };
  const leftovers = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const p = raw.trim();
    if (!p) continue;
    if (!out.email && /\S+@\S+\.\S+/.test(p)) { out.email = p; continue; }
    if (!out.phone && /^\+?[\d\s().-]+$/.test(p) && (p.match(/\d/g) || []).length >= 6) { out.phone = p.replace(/\s+/g, ' '); continue; }
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

// ➤ Handles a TEXT message while onboarding/editing is active (CV paste, name,
// ➤ roles, cover example...). Returns true if it consumed the message.
export async function handleOnboardingText(text) {
  const s = loadState();
  if (!s || !s.active) return false;
  // ➤ CANCEL IS CHECKED FIRST, before the question is even looked at — and
  // ➤ before anything is stored. That is the whole point: while the setup runs
  // ➤ every text you send is kept as an answer, so there has to be one word
  // ➤ that never is.
  if (/^(cancel|cancelar)$/i.test(String(text || '').trim())) {
    await cancelOnboarding();
    return true;
  }
  const q = s.mode === 'edit' ? Q_BY_KEY[s.editKey] : QUESTIONS[s.step];
  if (!q || !(q.kind === 'text' || q.kind === 'cv' || q.kind === 'skip-text' || q.kind === 'contact')) return false;

  const value = String(text || '').trim();
  if (q.kind === 'contact') {
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
    // ➤ Say ONCE what was understood and what is absent — the old flow took
    // ➤ "just an email" and marched on in silence, and the city it lost is
    // ➤ what the cover letters and the home-city search group run on. One
    // ➤ round, never a nag: the second answer (or Skip) always moves on.
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
  if (q.kind === 'cv') {
    // ➤ Keep the previous CV before overwriting it. Your copy is not a git repo
    // ➤ and nothing else holds this file, so without the backup a single
    // ➤ mistyped message costs you the document every cover letter starts from.
    backupBeforeOverwrite(CV_PATH);
    writePrivate(CV_PATH, value + '\n');
    s.answers.cv = 'saved';
  } else if (q.kind === 'skip-text') {
    if (!/^skip$/i.test(value) && value) {
      writePrivate(COVER_EXAMPLE_PATH, value + '\n');
      s.answers[q.key] = 'saved';
    }
  } else {
    // ➤ Short text answers (name, contact, roles, fields) are single-line by
    // ➤ nature; collapse any pasted line breaks to spaces so they can't corrupt
    // ➤ the generated YAML. (The CV above keeps its line breaks — it's a document.)
    s.answers[q.key] = value.replace(/\s+/g, ' ');
  }
  await advance(s);
  return true;
}

// ➤ Extracts the text of a PDF. pdf-parse v2 (npm "pdf-parse") does the work
// ➤ locally — no service, no key. Its "-- N of M --" page markers are noise in
// ➤ a CV and are stripped. Exported so the tests can feed it a real PDF.
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

// ➤ Handles a DOCUMENT while the setup waits for the CV: users send the PDF
// ➤ they already have, not pasted text (field test 2026-08-06). Only the CV
// ➤ question consumes files; anywhere else the document is left unanswered
// ➤ and the question on screen still applies. Returns true if consumed.
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
  // ➤ BOUND TO ITS MESSAGE (field test 2026-08-23), like the list pages and
  // ➤ the review card already are: a tap on an already-closed question used to
  // ➤ land on the CURRENT one — same o:N data, same button positions — so
  // ➤ re-ticking the finished degrees list ticked France and Germany on the
  // ➤ countries list. A tap whose message is not the live question only gets
  // ➤ a toast.
  if (s.msgId != null && messageId != null && messageId !== s.msgId) {
    await answerCallback(cbId, 'That question is already closed — the active one is below.');
    return true;
  }
  // ➤ The Skip button: one tap does what typing "skip" always did — move on
  // ➤ without saving anything more. The optional question wears it, and so
  // ➤ does the contact follow-up (whatever was recognised is already saved).
  if (data === 'skip' && (q?.kind === 'skip-text' || (q?.kind === 'contact' && s.contactPending))) {
    delete s.contactPending;
    await answerCallback(cbId);
    await advance(s);
    return true;
  }
  if (!q || !(q.kind === 'single' || q.kind === 'multi')) { await answerCallback(cbId); return false; }

  if (data === 'done') {                       // multi finished
    await answerCallback(cbId);
    await advance(s);
    return true;
  }
  const m = String(data).match(/^o:(\d+)$/);
  if (!m) { await answerCallback(cbId); return false; }
  const opt = q.options[Number(m[1])];
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
    // ➤ Keyboard-only edit (2026-08-23): editMessageText resent the whole
    // ➤ prompt on every tick and was most of why ticking felt slow.
    if (s.msgId) await editTelegramMarkup(s.msgId, buttonRows(q, s.answers[q.key]));
  }
  return true;
}

// ➤ Moves to the next step (setup) or ends the single edit, then persists.
async function advance(s) {
  // ➤ The finished question loses its keyboard FIRST: dead buttons left on
  // ➤ old questions were being re-tapped, and their o:N landed on the next
  // ➤ question's options (the binding above now refuses those taps; this
  // ➤ removes the temptation). Best-effort — the binding is the guarantee.
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
  // ➤ No saveState here (audit 2026-08-08): askCurrent persists AFTER the
  // ➤ prompt is delivered — saving the advanced step first was the bug.
  await askCurrent(s);
}

// ➤ End of setup: write everything and confirm.
async function finish(s) {
  saveAnswers(s.answers);
  writeProfile(s.answers);
  clearState();
  // ➤ If neither the job titles nor the fields gave us anything, the profile
  // ➤ cannot filter and the list will stay empty. Say so now, while the user is
  // ➤ still here, instead of leaving them to wonder for a week.
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
  // ➤ NOTE: newlines (\n, \r) are in the trigger set too — a value pasted across
  // ➤ two lines used to be written unquoted, which broke the whole YAML file and
  // ➤ silently reverted every filter to the built-in defaults.
  const str = String(s);
  return /[:#{}\[\],&*!|>'"%@`\\\n\r]/.test(str) ? `'${str.replace(/'/g, "''")}'` : str;
}
function splitList(text) {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}
// ➤ Turn a plain word the user typed into a regex fragment that matches it
// ➤ LITERALLY. The "fields" answer is free text (e.g. "C++", "R&D") and later
// ➤ becomes a regex (requirements.mjs); without this, "C++" is an invalid regex
// ➤ and "(a+)+$" would be a catastrophic-backtracking one. Escaping every regex
// ➤ metacharacter makes the term safe and match exactly what was typed. (The
// ➤ hand-authored marine defaults keep their regex power — they never pass here.)
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildProfileYaml(a) {
  // ➤ Contact, structured first (2026-08-23): the onboarding now stores what
  // ➤ each piece IS, so nothing here depends on the order the user typed.
  // ➤ The positional split stays as the fallback for answers saved before —
  // ➤ every settings edit regenerates this file from the old record.
  const legacyContact = splitList(a.contact);
  const cp = a.contact_parts || null;
  const cEmail = cp ? cp.email : (legacyContact[0] || '');
  const cPhone = cp ? cp.phone : (legacyContact[1] || '');
  const cCity = cp ? cp.city : legacyContact.slice(2).join(', ');
  // ➤ AN EMPTY LIST OF ROLES SWITCHES THE TITLE FILTER OFF (audit 2026-07-31).
  // ➤ An answer that is only spaces or only commas comes out as [], and the
  // ➤ title filter reads an empty positive list as "no keyword required" — so
  // ➤ every job title in the world passes and the only thing left between you
  // ➤ and the entire market is the deal-breaker list. That is the opposite of
  // ➤ what a blank answer means. So when there is nothing usable the key is
  // ➤ left out of the file altogether and the rules already in force stay.
  const roles = splitList(a.roles);
  // ➤ WHAT TO SEARCH FOR, WHEN THE ROLES ANSWER GAVE US NOTHING USABLE
  // ➤ (audit 2026-08-01). A punctuation-only answer reduces to an empty list,
  // ➤ and neither obvious option is right: writing [] tells the scanner no
  // ➤ keyword is required, so every title in the world passes; leaving the key
  // ➤ out makes it fall back to portals.yml, whose list is the shipped MARINE
  // ➤ example — so an accountant's bot would ask the boards for accounting jobs
  // ➤ and then reject every one of them for having "no keyword from your
  // ➤ field", for ever, without a word.
  // ➤ The fields answered two questions later ARE the user's own, so they are
  // ➤ what the filter falls back to. A worse filter than a proper list of
  // ➤ titles, but about the right line of work, which is the part that matters.
  // ➤ Fields become regexes downstream, so each typed word is escaped to match
  // ➤ literally (roles do NOT need it — scan.mjs escapes title terms itself).
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
  // ➤ The phrases sent to the job boards: the roles the user is after, plus
  // ➤ their fields, so the stream of offers is THEIRS and not the example one.
  // ➤ Roles first (they are the strongest signal), fields after, de-duplicated.
  const queries = [...new Set([...roles, ...fields].map(s => s.toLowerCase()))].slice(0, 8);
  // ➤ The geography to keep: the chosen countries plus the home city.
  // ➤ Case-insensitively unique: "Remote" the country and "remote" the way of
  // ➤ working are the same entry to the filter, and writing both put the word in
  // ➤ the file twice.
  const allowLocations = [...new Map([
    // ➤ Name AND native spellings (audit 2026-08-08): the allow gate compares
    // ➤ substrings with no translation, and offers name their country the way
    // ➤ the posting's own language does.
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
`;
}

// ➤ Writes the generated profile to config/profile.yml.
function writeProfile(answers) {
  try { writePrivate(PROFILE_PATH, buildProfileYaml(answers)); }
  catch (e) { console.log(`onboarding: could not write profile: ${e.message}`); }
}
