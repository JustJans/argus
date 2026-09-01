// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ EXPERIMENTAL (2026-08-24, in no release yet): the "no" that teaches.
// ➤
// ➤ WHAT IT IS: until now "no N reason" only wrote a record a human reads
// ➤ when hand-tuning the filters. This makes the rejection ACT: right after
// ➤ one, the bot reads the rejected offer and offers one-tap standing vetoes
// ➤ — the distinctive words of its title, its company, its city. One tap and
// ➤ offers matching it never reach the list again.
// ➤ WHY BUTTONS AND NOT A COMMAND: a "veto <word>" command makes the user do
// ➤ the analysis. The offer is right there; the bot can propose and the user
// ➤ only has to recognise. Free text stays what it was — the reason record.
// ➤ WHY A FILE OF ITS OWN (data/vetoes.json): the profile is REGENERATED from
// ➤ the onboarding answers on every settings edit, so anything written into
// ➤ profile.yml by another door gets silently wiped. This store survives, and
// ➤ scan + housekeep merge it into the filters they build.
// ➤ EVERY VETO IS REVERSIBLE: Undo on the panel just after the tap, and the
// ➤ "vetoes" command lists every standing one with a remove button.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileAtomic } from './fs-atomic.mjs';
// ➤ The hit test reuses the REAL filter builders, so "would this veto block
// ➤ that offer" is answered by exactly the code that will do the blocking.
import { buildTitleFilter, buildCompanyFilter, buildLocationFilter } from './filters.mjs';
import { fold as foldText } from './text.mjs';
import { sendTelegramButtons, editTelegramButtons, clearTelegramButtons, deleteTelegramMessage, answerCallback, cityOf, esc } from './notify.mjs';
import { pendingOffers } from './list-offers.mjs';
import { searchProfile } from './requirements.mjs';
import yaml from 'js-yaml';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
export const VETOES_PATH = join(ROOT, 'data', 'vetoes.json');
// ➤ Two panels, each bound to its own message id so a tap on yesterday's
// ➤ buttons cannot act on today's state (same binding review and the
// ➤ onboarding use — the stale-tap lesson of the 2026-08-23 field test).
export const CHIPS_STATE_PATH = join(ROOT, 'data', 'veto-chips.json');
export const LIST_STATE_PATH = join(ROOT, 'data', 'veto-list.json');

const fold = s => foldText(s).trim();

// ➤ kind → array name in the store. Three kinds only, one per thing the
// ➤ rejected offer can teach: its title words, its company, its city.
const KINDS = { title: 'titles', company: 'companies', city: 'cities' };

export function loadVetoes(path = VETOES_PATH) {
  let raw = null;
  if (existsSync(path)) { try { raw = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* corrupt = empty, never a crash */ } }
  return {
    titles: Array.isArray(raw?.titles) ? raw.titles.map(String) : [],
    companies: Array.isArray(raw?.companies) ? raw.companies.map(String) : [],
    cities: Array.isArray(raw?.cities) ? raw.cities.map(String) : [],
  };
}

export function saveVetoes(v, path = VETOES_PATH) {
  writeFileAtomic(path, JSON.stringify(v, null, 2));
}

// ➤ Pure: give it the store and get the new store, so it is testable and the
// ➤ disk write stays in one place. Duplicates (accent- and case-blind) no-op.
export function addVeto(v, kind, value) {
  const key = KINDS[kind];
  if (!key || !String(value || '').trim()) return { v, added: false };
  if (v[key].some(x => fold(x) === fold(value))) return { v, added: false };
  return { v: { ...v, [key]: [...v[key], String(value).trim()] }, added: true };
}

export function removeVeto(v, kind, value) {
  const key = KINDS[kind];
  if (!key) return { v, removed: false };
  const kept = v[key].filter(x => fold(x) !== fold(value));
  return { v: { ...v, [key]: kept }, removed: kept.length !== v[key].length };
}

// ➤ ── Merging into the filters ──────────────────────────────────────────
// ➤ scan.mjs and housekeep.mjs call these when they build their filters, so
// ➤ a veto behaves exactly like a hand-written negative — same word rules,
// ➤ same --explain output naming the word that fired.

export function titleNegativesWith(base, v) {
  return [...(base || []), ...v.titles];
}

export function companyFilterWith(cf, v) {
  if (!v.companies.length) return cf;
  return { ...(cf || {}), blocked: [...((cf || {}).blocked || []), ...v.companies] };
}

export function locationFilterWith(lf, v) {
  if (!v.cities.length) return lf;
  return { ...(lf || {}), block: [...((lf || {}).block || []), ...v.cities] };
}

// ➤ Which of these offers would the veto block? Answered by the real filter
// ➤ builders with ONLY the veto loaded, so the panel's "also hides #705"
// ➤ claim and the scanner's future behaviour cannot drift apart.
export function vetoHits(kind, value, offers) {
  if (kind === 'title') {
    const f = buildTitleFilter({ positive: [], negative: [value] });
    return offers.filter(o => !f(o.title));
  }
  if (kind === 'company') {
    const f = buildCompanyFilter({ blocked: [value] });
    return offers.filter(o => !f(o.company));
  }
  const f = buildLocationFilter({ block: [value] });
  return offers.filter(o => o.location && !f(o.location));
}

// ➤ ── What to propose ───────────────────────────────────────────────────
// ➤ Words that could be ANY job: vetoing one would express nothing about
// ➤ this rejection. Generic job nouns, seniority, gender tags and the
// ➤ articles of the five languages the engine already speaks.
const CHIP_STOP = new Set((
  'the a an and or of for in at to with de la el los las del un una unas unos y o en para con al ' +
  'van het een en bij voor met und der die das im bei fur mit le les des du et a au aux ' +
  'junior senior medior lead principal graduate trainee intern internship stage stagiair praktikant werkstudent ' +
  'm w d f h x nb all genders gn ' +
  'engineer engineers ingeniero ingeniera ingenieur ingenieurin ingenieria technician tecnico tecnica technicus techniker ' +
  'manager specialist consultant analyst analista assistant asistente officer coordinator coordinador supervisor operator operador ' +
  'developer expert professional staff member medewerker mitarbeiter employee ' +
  'job jobs vacancy vacature offre empleo trabajo puesto oferta stelle new nuevo'
).split(/\s+/));

// ➤ A chip must never be able to kill the user's own search: tapping
// ➤ "Mooring" away because one mooring offer was bad would silently veto the
// ➤ whole field. For a SINGLE word the test is containment both ways,
// ➤ accent-blind ("moor"/"mooring" in either direction is too close to the
// ➤ field to offer). A PAIR always narrows — "Divorce Lawyer" blocks only
// ➤ divorce lawyers however much "lawyer" is a positive — so a pair is only
// ➤ blocked when it IS a positive, whole and equal.
function clashesWithPositives(chip, positives, { phrase = false } = {}) {
  const w = fold(chip);
  return positives.some(p => {
    const q = fold(typeof p === 'string' ? p : p?.term);
    if (!q) return false;
    return phrase ? w === q : (w.includes(q) || q.includes(w));
  });
}

const alreadyVetoed = (word, v) => v.titles.some(t => fold(t) === fold(word));

// ➤ Words that tie a job name to its complement: "Pulidor DE suelos", "Head OF
// ➤ Engineering", "Monteur VAN installaties". A phrase may bridge ONE of them,
// ➤ which is what lets a role written the Romance way survive as a single
// ➤ concept instead of arriving cut in half. Locatives ("en", "in", "at") are
// ➤ deliberately absent: "suelos EN Campamento" is a place, not a job — and
// ➤ "<trade> en <town>" is exactly how the odd-job marketplaces write theirs.
const CHIP_BRIDGE = new Set('de del da das di du des van von der den of'.split(' '));

// ➤ From one rejected offer to at most seven buttons: the job as ONE phrase
// ➤ first (narrower, so safer to tap), then the distinctive words on their
// ➤ own, then the company and the city.
export function proposeVetoChips(offer, { positives = [], vetoes = null } = {}) {
  const v = vetoes || { titles: [], companies: [], cities: [] };
  const chips = [];
  const title = String(offer.title || '');
  // ➤ Tokens WITH their position, because a phrase is cut from the title
  // ➤ verbatim: a rebuilt "Pulidor de suelos" would not match the
  // ➤ "Pulidor/a de suelos" it came from, and a veto that matches nothing is
  // ➤ worse than no veto — it looks like it worked.
  const toks = [...title.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ w: m[0], at: m.index }));
  const words = toks.map(t => t.w);
  const usable = w => w.length >= 4 && !/^\d+$/.test(w) && !CHIP_STOP.has(fold(w));
  const free = (chip, opts) => !clashesWithPositives(chip, positives, opts) && !alreadyVetoed(chip, v);

  const distinctive = [];
  for (const w of words) {
    if (!usable(w) || !free(w)) continue;
    if (!distinctive.some(d => fold(d) === fold(w))) distinctive.push(w);
  }
  const isDistinctive = w => distinctive.slice(0, 3).some(d => fold(d) === fold(w));

  // ➤ Two content words with nothing between them but a bridge word and the
  // ➤ gender scraps a split leaves behind ("Pulidor/a" → "Pulidor" + "a").
  const content = toks.filter(t => usable(t.w));
  const phrases = [];
  for (let i = 0; i < content.length - 1; i++) {
    const a = content[i], b = content[i + 1];
    const between = toks.filter(t => t.at > a.at && t.at < b.at).map(t => t.w);
    if (between.some(w => w.length > 1 && !CHIP_BRIDGE.has(fold(w)))) continue;
    if (between.filter(w => CHIP_BRIDGE.has(fold(w))).length > 1) continue;
    if (!isDistinctive(a.w) && !isDistinctive(b.w)) continue;
    const span = title.slice(a.at, b.at + b.w.length).trim();
    if (!free(span, { phrase: true })) continue;
    if (!phrases.some(p => fold(p) === fold(span))) phrases.push(span);
  }
  for (const p of phrases.slice(0, 2)) chips.push({ kind: 'title', value: p, label: p });
  for (const w of distinctive.slice(0, 3)) chips.push({ kind: 'title', value: w, label: w });

  const company = String(offer.company || '').trim();
  if (company && !v.companies.some(c => fold(c) === fold(company))) {
    chips.push({ kind: 'company', value: company, label: `Company: ${company}` });
  }
  // ➤ cityOf and NOTHING ELSE. It already refuses to call a country a city,
  // ➤ and an earlier fallback to the raw first segment walked straight around
  // ➤ that guard: an offer located plain "España" offered "City: España", one
  // ➤ tap from vetoing the whole country.
  const city = cityOf(offer.location || '');
  if (city && !v.cities.some(c => fold(c) === fold(city))) {
    chips.push({ kind: 'city', value: city, label: `City: ${city}` });
  }
  // ➤ Every chip must block the offer it was proposed from. A button that
  // ➤ changes nothing is the worst button on the panel, because tapping it
  // ➤ reads as done.
  return chips.filter(c => vetoHits(c.kind, c.value, [offer]).length === 1);
}

// ➤ ── The panel after a "no" ────────────────────────────────────────────

function loadState(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

const KIND_WORD = { title: 'titles with', company: 'offers from', city: 'offers in' };

// ➤ Up to eight ids by name, then an honest count — never a cut-off list that
// ➤ pretends to be complete.
function idList(ids) {
  const shown = ids.slice(0, 8).map(h => '#' + h).join(', ');
  return ids.length > 8 ? `${shown} and ${ids.length - 8} more` : shown;
}

// ➤ Chip indexes in callback data point into the ORIGINAL chips array, which
// ➤ never shrinks — a consumed chip is only marked used. So a tap that races
// ➤ a redraw still lands on the chip its button named, or on nothing.
function chipsPanel(state) {
  const lines = [
    `<b>Teach the filter</b> from #${state.offer.id} — ${esc(state.offer.title)} (${esc(state.offer.company)})`,
    'One tap = a standing veto. The words below are the posting\'s own, in its own language: that is the text future postings are matched against.',
  ];
  for (const a of state.added) {
    const hits = a.hits || [];
    lines.push(`Vetoed ${KIND_WORD[a.kind]} <b>${esc(a.value)}</b>${hits.length ? ` — still on your list: ${idList(hits)}` : ' — nothing else on your list matches'}`);
  }
  const live = state.chips.map((c, i) => ({ ...c, i })).filter(c => !c.used);
  const rows = [];
  for (let i = 0; i < live.length; i += 2) {
    rows.push(live.slice(i, i + 2).map(c => ({ label: c.label, data: `vt:a:${c.i}` })));
  }
  const tail = [];
  const pendingHits = [...new Set(state.added.flatMap(a => a.hits || []))];
  if (pendingHits.length) tail.push({ label: `Hide ${pendingHits.length} matching now`, data: 'vt:h' });
  if (state.added.length) tail.push({ label: `Undo ${state.added[state.added.length - 1].value}`, data: `vt:u:${state.added.length - 1}` });
  tail.push({ label: state.added.length ? 'Done' : 'Nothing to veto', data: 'vt:d' });
  rows.push(tail);
  return { text: lines.join('\n'), rows };
}

function vetoDeps(over = {}) {
  return {
    send: (text, rows) => sendTelegramButtons(text, rows, { html: true }),
    edit: (id, text, rows) => editTelegramButtons(id, text, rows, { html: true }),
    strip: clearTelegramButtons,
    del: deleteTelegramMessage,
    answer: answerCallback,
    pending: pendingOffers,
    loadV: loadVetoes, saveV: saveVetoes,
    loadChips: () => loadState(CHIPS_STATE_PATH), saveChips: s => writeFileAtomic(CHIPS_STATE_PATH, JSON.stringify(s)),
    loadList: () => loadState(LIST_STATE_PATH), saveList: s => writeFileAtomic(LIST_STATE_PATH, JSON.stringify(s)),
    // ➤ Injected by the listener: hide these pending ids the same way a typed
    // ➤ "seen" would (so each one stays undoable with "undo N").
    hide: null,
    positives: activePositives,
    ...over,
  };
}

// ➤ The user's own POSITIVE terms, from wherever the scanner would take them
// ➤ (profile first, the shipped example otherwise). Chips are screened against
// ➤ these so a bad mooring offer can never tempt you into vetoing "Mooring".
export function activePositives() {
  if (Array.isArray(searchProfile.positive_titles)) return searchProfile.positive_titles;
  try {
    const config = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
    return (config?.title_filter?.positive || []);
  } catch { return []; }
}

// ➤ Called by the listener right after a typed "no N" lands. `offer` is read
// ➤ BEFORE the rejection removes it from the list. Only the latest panel
// ➤ lives: the previous one (if any) is deleted so dead buttons never pile up.
export async function sendVetoChips(offer, deps = {}) {
  const d = vetoDeps(deps);
  const chips = proposeVetoChips(offer, { positives: d.positives(), vetoes: d.loadV() });
  if (!chips.length) return null;
  const prev = d.loadChips();
  if (prev?.message_id) await d.del(prev.message_id);
  const state = {
    message_id: null,
    offer: { id: offer.id, title: offer.title, company: offer.company, location: offer.location || '' },
    chips, added: [],
  };
  const { text, rows } = chipsPanel(state);
  const id = await d.send(text, rows);
  if (id == null) return null;
  state.message_id = id;
  d.saveChips(state);
  return id;
}

// ➤ ── The "vetoes" command: see everything taught, remove any of it ─────

function listPanel(v) {
  const items = [
    ...v.titles.map(x => ({ kind: 'title', value: x, label: `Title: ${x}` })),
    ...v.companies.map(x => ({ kind: 'company', value: x, label: `Company: ${x}` })),
    ...v.cities.map(x => ({ kind: 'city', value: x, label: `City: ${x}` })),
  ];
  if (!items.length) return { items, text: 'No standing vetoes. After you reject an offer with "no N", the bot offers what to veto from it.', rows: [] };
  const text = [`<b>Standing vetoes</b> — ${items.length}`, 'These never reach your list. Tap one to remove it.'].join('\n');
  const rows = items.map((it, i) => [{ label: `Remove ${it.label}`, data: `vt:r:${i}` }]);
  return { items, text, rows };
}

export async function startVetoList(deps = {}) {
  const d = vetoDeps(deps);
  const prev = d.loadList();
  if (prev?.message_id) await d.del(prev.message_id);
  const { items, text, rows } = listPanel(d.loadV());
  const id = await d.send(text, rows);
  if (id != null && items.length) d.saveList({ message_id: id, items });
  return id;
}

// ➤ ── The taps ──────────────────────────────────────────────────────────
// ➤ Returns true if the callback was ours (the listener stops routing then).
// ➤ Answer FIRST, act after — the spinner on the user's phone must die in
// ➤ milliseconds whatever the disk is doing (the review-mode rule).
export async function handleVetoCallback(data, messageId, cbId, deps = {}) {
  if (!/^vt:/.test(String(data || ''))) return false;
  const d = vetoDeps(deps);

  // ── The remove taps live on the "vetoes" list panel ──
  if (/^vt:r:/.test(data)) {
    const st = d.loadList();
    const stale = !st || st.message_id !== messageId;
    await d.answer(cbId, stale ? 'These buttons belong to an older list. Type "vetoes" for a fresh one.' : '');
    if (stale) return true;
    const it = st.items[parseInt(data.slice(5), 10)];
    if (!it) return true;
    const { v, removed } = removeVeto(d.loadV(), it.kind, it.value);
    if (removed) d.saveV(v);
    const { items, text, rows } = listPanel(v);
    await d.edit(messageId, text, rows);
    d.saveList({ message_id: messageId, items });
    return true;
  }

  // ── Everything else lives on the chips panel ──
  const st = d.loadChips();
  const stale = !st || st.message_id !== messageId;
  await d.answer(cbId, stale ? 'These buttons belong to an older rejection.' : '');
  if (stale) return true;

  if (data === 'vt:d') {
    // ➤ Nothing chosen → the panel vanishes; something chosen → the text (the
    // ➤ record of what was vetoed) stays and only the buttons go.
    if (st.added.length) await d.strip(messageId); else await d.del(messageId);
    d.saveChips({ message_id: null });
    return true;
  }

  if (data === 'vt:h') {
    const ids = [...new Set(st.added.flatMap(a => a.hits || []))];
    if (ids.length && d.hide) await d.hide(ids);
    for (const a of st.added) a.hits = [];
    const { text, rows } = chipsPanel(st);
    await d.edit(messageId, `${text}\nHidden: ${idList(ids)} (each one still answers to "undo N").`, rows);
    d.saveChips(st);
    return true;
  }

  if (/^vt:u:/.test(data)) {
    const a = st.added[parseInt(data.slice(5), 10)];
    if (!a) return true;
    const { v, removed } = removeVeto(d.loadV(), a.kind, a.value);
    if (removed) d.saveV(v);
    st.added = st.added.filter(x => x !== a);
    if (st.chips[a.chipIdx]) st.chips[a.chipIdx].used = false;
    const { text, rows } = chipsPanel(st);
    await d.edit(messageId, text, rows);
    d.saveChips(st);
    return true;
  }

  if (/^vt:a:/.test(data)) {
    const i = parseInt(data.slice(5), 10);
    const chip = st.chips[i];
    if (!chip || chip.used) return true;   // double-tap, or a chip already consumed
    const { v, added } = addVeto(d.loadV(), chip.kind, chip.value);
    if (added) d.saveV(v);
    const hits = vetoHits(chip.kind, chip.value, d.pending()).map(o => o.id).filter(n => n != null);
    chip.used = true;
    st.added.push({ kind: chip.kind, value: chip.value, hits, chipIdx: i });
    const { text, rows } = chipsPanel(st);
    await d.edit(messageId, text, rows);
    d.saveChips(st);
    return true;
  }

  return true;
}
