#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the third piece of argus-discover, and the one that actually
// ➤ discovers. It answers "what else could I do?" using ESCO — the European
// ➤ Commission's official taxonomy of 3,007 occupations and 13,896 skills, with
// ➤ the relations between them, in 28 languages.
// ➤ WHY NOT COUNT WORDS: harvest-titles.mjs ranks words in job adverts, so it
// ➤ can only ever return what is already being advertised in the words you
// ➤ already searched. ESCO goes the other way — from a skill to every
// ➤ occupation that requires it — which is how it can surface a role you never
// ➤ thought to look for. Its whole point is the jump you would not have made.
// ➤ COST: free public API, no key, no tokens. Answers are cached on disk, so a
// ➤ second run costs nothing.
// ➤ IT CHANGES NOTHING. It prints a report; every decision stays yours.
// ➤ RUN: node server-bot/argus-discover/esco-match.mjs
// ➤      --terms "mooring,aquaculture"  use these instead of the CV's skills
// ➤      --top 8                        how many occupations to detail
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { buildTitleFilter } from '../scan.mjs';
import { extractCvSkills, fold } from './audit-profile.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));
const CACHE_DIR = join(SCRIPT_DIR, '.esco-cache');
// ➤ Overridable for tests, mirroring notify's ARGUS_TG_API: the e2e points
// ➤ this at a dead port so the setup's ESCO stage fails fast and falls back
// ➤ deterministically instead of depending on the network being up.
const API = process.env.ARGUS_ESCO_API || 'https://ec.europa.eu/esco/api';
// ➤ The languages Argus searches in. An occupation's name in each is the whole
// ➤ prize: it is the bridge between what you can do and how a Dutch or German
// ➤ employer writes it in the advert.
const LANGS = ['en', 'es', 'nl', 'de', 'fr'];

// ➤ ESCO is a fixed classification: the same URI returns the same answer
// ➤ forever. Caching it on disk means only the first run costs requests.
async function esco(path, key) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${key.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.json`);
  if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf-8')); } catch {} }
  // ➤ With a timeout, like every other request in the project. Without one a
  // ➤ stalled connection hangs this tool for ever with nothing on screen.
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  writeFileSync(file, JSON.stringify(json), 'utf-8');
  return json;
}

// ➤ A label is only useful to Argus if a human would put it in a job advert.
// ➤ ESCO's translations are administrative: the Spanish for "aquaculture
// ➤ mooring manager" is "reparador de estructuras de cultivo en instalaciones
// ➤ acuícolas", which no advert has ever said. Long ones and the gendered
// ➤ "masculino/femenino" pairs are dropped, and the shortest survivor wins.
export function usableLabels(labels, { maxWords = 4 } = {}) {
  const out = [];
  for (const raw of labels || []) {
    for (const half of String(raw).split('/')) {
      const s = half.trim();
      if (!s || s.split(/\s+/).length > maxWords) continue;
      if (!out.some(x => fold(x) === fold(s))) out.push(s);
    }
  }
  return out.sort((a, b) => a.length - b.length);
}

// ➤ Ranks occupations by how much of YOU they need: how many of your input
// ➤ terms map to a skill the occupation requires. Essential skills weigh double
// ➤ — an occupation that merely tolerates a skill is a weaker signal than one
// ➤ that cannot be done without it.
export function scoreOccupations(hits) {
  const byUri = new Map();
  for (const { term, occupations } of hits) {
    for (const o of occupations) {
      const e = byUri.get(o.uri) || { uri: o.uri, title: o.title, terms: new Set(), score: 0 };
      if (!e.terms.has(term)) { e.terms.add(term); e.score += o.essential ? 2 : 1; }
      byUri.set(o.uri, e);
    }
  }
  return [...byUri.values()]
    .map(e => ({ ...e, terms: [...e.terms] }))
    .sort((a, b) => b.score - a.score || b.terms.length - a.terms.length);
}

// ➤ The reusable half of this tool (2026-08-23): from a bag of terms to the
// ➤ occupations ESCO says need them — each with its ISCO code (the first two
// ➤ digits name the professional area) and its advert-usable labels. The
// ➤ onboarding drinks from this to suggest roles and degree areas straight
// ➤ from the CV. `deps.esco` is injectable so tests run without the network;
// ➤ a term ESCO does not know, or no network at all, just yields fewer
// ➤ occupations — never a throw.
export async function occupationsForTerms(terms, { top = 8, perTerm = 2, langs = ['en'], deps = {} } = {}) {
  const d = { esco, ...deps };
  // ➤ Occupations searched by NAME, per term — deliberately NOT the
  // ➤ skill→occupation graph this file's report uses (measured live
  // ➤ 2026-08-23): that graph exists for surprising jumps, and on a mixed CV
  // ➤ it crowned branch managers, bingo managers and headmasters. A name
  // ➤ search speaks the CV's own vocabulary: "accounting" finds accountants,
  // ➤ "sales negotiation" finds sales people — each term its own profession,
  // ➤ so an accountant-and-salesman CV surfaces BOTH, separately.
  const picked = new Map();
  for (const term of (terms || []).map(t => String(t).trim()).filter(Boolean).slice(0, 12)) {
    try {
      const s = await d.esco(`/search?text=${encodeURIComponent(term)}&language=en&type=occupation&limit=${perTerm}`, `search_occ_${term}`);
      for (const r of (s?._embedded?.results || []).slice(0, perTerm)) {
        const cur = picked.get(r.uri) || { uri: r.uri, title: r.title, terms: [] };
        if (!cur.terms.includes(term)) cur.terms.push(term);
        picked.set(r.uri, cur);
      }
    } catch { /* unknown term or no network: the caller falls back */ }
  }
  const out = [];
  for (const occ of [...picked.values()].slice(0, top)) {
    let detail = null;
    try { detail = await d.esco(`/resource/occupation?uri=${encodeURIComponent(occ.uri)}&language=en`, `occ_${occ.uri}`); } catch { /* label-less is still an occupation */ }
    const pref = detail?.preferredLabel || {};
    const alt = detail?.alternativeLabel || {};
    const labels = {};
    for (const L of langs) labels[L] = usableLabels([pref[L], ...(alt[L] || [])].filter(Boolean));
    out.push({ uri: occ.uri, title: occ.title, terms: occ.terms, code: String(detail?.code || ''), labels });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const top = Math.max(1, parseInt(flag('top', '8'), 10) || 8);

  const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
  const tf = portals?.title_filter || {};
  const filter = buildTitleFilter(tf);
  const known = new Set([...(tf.positive || []), ...(tf.negative || [])]
    .map(p => fold(typeof p === 'string' ? p : p.term)));

  // ➤ Input: what you can defend. The CV's skill list plus the fields declared
  // ➤ in the profile, because ESCO indexes domains ("mooring", "aquaculture")
  // ➤ far better than tool names ("OrcaFlex"), which it does not know at all.
  const cvPath = join(ROOT, 'cv.md');
  const cvSkills = existsSync(cvPath) ? extractCvSkills(readFileSync(cvPath, 'utf-8')) : [];
  const fields = (yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8'))?.search?.fields) || [];
  const terms = (flag('terms', '') ? flag('terms', '').split(',') : [...new Set([...fields, ...cvSkills])])
    .map(s => String(s).trim()).filter(Boolean);

  console.log('\nARGUS-DISCOVER — ESCO occupation match');
  console.log('Source: the European Commission classification (3,007 occupations, 13,896 skills).');
  console.log(`Asking what ${terms.length} things you can do are actually REQUIRED for.\n`);

  const hits = [];
  const unknown = [];
  for (const term of terms) {
    try {
      const s = await esco(`/search?text=${encodeURIComponent(term)}&language=en&type=skill&limit=3`, `search_skill_${term}`);
      const found = (s?._embedded?.results || []);
      if (!found.length) { unknown.push(term); continue; }
      for (const sk of found.slice(0, 2)) {
        const full = await esco(`/resource/skill?uri=${encodeURIComponent(sk.uri)}&language=en`, `skill_${sk.uri}`);
        const ess = (full?._links?.isEssentialForOccupation || []).map(o => ({ ...o, essential: true }));
        const opt = (full?._links?.isOptionalForOccupation || []).map(o => ({ ...o, essential: false }));
        if (ess.length || opt.length) hits.push({ term, occupations: [...ess, ...opt] });
      }
    } catch (e) { unknown.push(`${term} (${e.message})`); }
  }

  const ranked = scoreOccupations(hits);
  if (!ranked.length) { console.log('ESCO matched none of those to an occupation. Try --terms with domain words.'); return; }

  console.log(`${ranked.length} occupations need at least one of your terms. Top ${Math.min(top, ranked.length)}:\n`);
  for (const occ of ranked.slice(0, top)) {
    let detail = null;
    try { detail = await esco(`/resource/occupation?uri=${encodeURIComponent(occ.uri)}&language=en`, `occ_${occ.uri}`); } catch {}
    const alt = detail?.alternativeLabel || {};
    const pref = detail?.preferredLabel || {};
    console.log(`  ▸ ${occ.title}   (covers: ${occ.terms.join(', ')})`);
    for (const L of LANGS) {
      const labels = usableLabels([pref[L], ...(alt[L] || [])].filter(Boolean));
      if (labels.length) console.log(`      ${L}  ${labels.slice(0, 3).join(' · ')}`);
    }
    // ➤ Which of those names would be NEW to your search, and does the filter
    // ➤ already let that kind of title through? Both questions, side by side.
    const fresh = LANGS.flatMap(L => usableLabels([pref[L], ...(alt[L] || [])].filter(Boolean)))
      .filter(l => !known.has(fold(l)) && !filter(l));
    if (fresh.length) console.log(`      NEW to your search, and currently dropped: ${[...new Set(fresh)].slice(0, 4).join(' · ')}`);
    console.log('');
  }

  if (unknown.length) {
    console.log('── ESCO DOES NOT KNOW THESE ─────────────────────────────────');
    console.log(`  ${unknown.slice(0, 12).join(' · ')}`);
    console.log('  Expected for tool names: ESCO classifies occupations and skills,');
    console.log('  not software. OrcaFlex belongs on the CV, not in this lookup.\n');
  }
  console.log('  Nothing has been changed. Any label you like becomes a candidate,');
  console.log('  and a candidate still has to be measured before it is adopted.\n');
}

if (process.argv[1] && /esco-match\.mjs$/.test(process.argv[1])) main();
