#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the second piece of argus-discover. The audit asks whether you
// ➤ are searching for the right things; this one asks the MARKET what job
// ➤ titles sit next to the skills you can actually defend.
// ➤ HOW: it queries the job board by SKILL ("OrcaFlex", "mooring", "ArcGIS")
// ➤ instead of by the job titles you assumed, collects the titles that come
// ➤ back, drops the ones your filter already accepts, and ranks the words that
// ➤ are left. Those words are the candidates for config/profile.yml.
// ➤ COST: HTTP and JSON. No model, no tokens. It writes nothing and changes
// ➤ nothing — it prints a report and stops.
// ➤ RUN: node server-bot/argus-discover/harvest-titles.mjs
// ➤      --terms "orcaflex,mooring"   use these instead of the CV's skills
// ➤      --calls 8                    hard cap on API requests (default 10)
// ➤      --country es                 one country code (default: the first configured)
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { buildTitleFilter, loadAdzunaCreds } from '../scan.mjs';
import { extractCvSkills, fold } from './audit-profile.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));

// ➤ Words that carry no meaning for a job title, so they must never be
// ➤ proposed as a search term. Gender tags and contract noise included.
const STOP = new Set(('the a an and or of for in at to with de la el los las y en para con del un una une des les et' +
  ' m w d f h x nb all genders gn junior senior medior graduate stage intern trainee fulltime parttime' +
  ' engineer engineering ingeniero ingeniera ingenieur ingenieurin ingenieria technicien tecnico' +
  ' job jobs vacancy vacature offre empleo trabajo puesto oferta new nuevo').split(/\s+/));

// ➤ One Adzuna page for one query. Kept tiny and separate from scan.mjs's
// ➤ collector: that one is tuned for the daily scan (paging, dedup, liveness)
// ➤ and this only needs a list of titles.
async function askAdzuna(creds, country, term, perPage) {
  const params = new URLSearchParams({
    app_id: creds.id, app_key: creds.key,
    results_per_page: String(perPage), max_days_old: '30',
    what: term, 'content-type': 'application/json',
  });
  // ➤ Bounded, like every other request here: this runs one query per skill in
  // ➤ a loop, so a stalled connection would hang the whole harvest on the first.
  const res = await fetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`,
    { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.results || []).map(r => String(r.title || '').trim()).filter(Boolean);
}

// ➤ Splits titles into candidate terms: single words and adjacent pairs, with
// ➤ the noise removed. Pairs matter — "Hydrographic Surveyor" is a better
// ➤ search term than either half on its own.
export function candidateTerms(titles, { known = [] } = {}) {
  const knownFolded = new Set(known.map(fold));
  const counts = new Map();
  const bump = (k, title) => {
    if (!k || knownFolded.has(fold(k))) return;
    const e = counts.get(fold(k)) || { term: k, n: 0, titles: new Set() };
    e.n++; e.titles.add(title); counts.set(fold(k), e);
  };
  for (const title of titles) {
    const words = String(title).split(/[^\p{L}\d+#.]+/u).filter(Boolean)
      .filter(w => w.length >= 3 && !STOP.has(fold(w)) && !/^\d+$/.test(w));
    for (let i = 0; i < words.length; i++) {
      bump(words[i], title);
      if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`, title);
    }
  }
  return [...counts.values()].sort((a, b) => b.titles.size - a.titles.size);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const maxCalls = Math.max(1, parseInt(flag('calls', '10'), 10) || 10);

  const creds = loadAdzunaCreds();
  if (!creds) { console.log('No Adzuna credentials — this piece needs them (server-bot/adzuna-key.json).'); return; }

  const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
  const tf = portals?.title_filter || {};
  const filter = buildTitleFilter(tf);
  const positives = (tf.positive || []).map(p => (typeof p === 'string' ? p : p.term));
  const negatives = (tf.negative || []).map(p => (typeof p === 'string' ? p : p.term));
  const country = flag('country', portals?.adzuna?.countries?.[0]?.code || 'es');

  // ➤ The search terms are your SKILLS, not job titles. That is the whole idea:
  // ➤ titles are what you already assume, skills are what you can defend.
  const cvPath = join(ROOT, 'cv.md');
  const fromCv = existsSync(cvPath) ? extractCvSkills(readFileSync(cvPath, 'utf-8')) : [];
  const terms = (flag('terms', '') ? flag('terms', '').split(',') : fromCv)
    .map(s => s.trim()).filter(Boolean).slice(0, maxCalls);

  if (!terms.length) { console.log('No skills found to search with. Pass --terms "a,b,c".'); return; }

  console.log('\nARGUS-DISCOVER — title harvest');
  console.log(`Asking the market what sits next to your skills, in "${country}".`);
  console.log(`${terms.length} queries (cap ${maxCalls}): ${terms.join(' · ')}\n`);

  (async () => {
    const seen = new Map();      // title -> how many of your skills returned it
    const failures = [];
    const empties = [];          // ➜ terms the board has no advert for, at all
    for (const term of terms) {
      try {
        const titles = await askAdzuna(creds, country, term, 50);
        for (const t of titles) seen.set(t, (seen.get(t) || 0) + 1);
        if (!titles.length) empties.push(term);
        process.stdout.write(`  ${term}: ${titles.length} titles\n`);
      } catch (e) {
        failures.push(`${term}: ${e.message}`);
        process.stdout.write(`  ${term}: FAILED (${e.message})\n`);
      }
    }
    const all = [...seen.keys()];
    const covered = all.filter(t => filter(t));
    const missed = all.filter(t => !filter(t));

    console.log(`\n${all.length} distinct titles · ${covered.length} your filter already accepts · ${missed.length} it drops`);
    if (failures.length) console.log(`(${failures.length} queries failed — the numbers below are that much thinner)`);

    // ➤ A term that returns NOTHING is a finding, not an empty row. Tool names
    // ➤ ("OrcaFlex", "bathymetric") are how you describe your work; job ads use
    // ➤ domain words ("offshore", "marine"). Measured: OrcaFlex returns 0 in
    // ➤ both ES and NL while plain "offshore" returns 50 in NL — the market is
    // ➤ there, the vocabulary is not. Say so, or the zeros read as "no jobs".
    if (empties.length) {
      console.log('\n── TERMS THE MARKET NEVER WRITES DOWN ───────────────────────');
      console.log(`  ${empties.join(' · ')}`);
      console.log('  Zero results does not mean zero jobs: it means employers do not');
      console.log('  put these words in the advert. They are how YOU describe the work.');
      console.log('  Search by the domain (offshore, marine, survey), keep these for the CV.');
    }

    // ➤ The proposal: words common in the titles your filter drops. Each one is
    // ➤ measured against the same titles, so you can see what adding it costs.
    const cands = candidateTerms(missed, { known: [...positives, ...negatives] }).filter(c => c.titles.size >= 3);
    console.log('\n── CANDIDATE SEARCH TERMS ───────────────────────────────────');
    if (!cands.length) console.log('  None: nothing recurs often enough in what your filter drops.');
    else {
      console.log('  Appears in   Term');
      for (const c of cands.slice(0, 12)) console.log(`  ${String(c.titles.size).padStart(9)}   ${c.term}`);
      console.log('\n  Example titles behind the top candidate:');
      // ➤ Whole titles. These examples exist to be judged, and the judgement
      // ➤ often turns on the words a 68-character cut removed.
      for (const t of [...cands[0].titles].slice(0, 5)) console.log(`    ${t}`);
    }

    console.log('\n── TITLES DROPPED FOR HAVING NO FIELD KEYWORD ───────────────');
    const noKeyword = missed.filter(t => /no keyword/i.test(filter.explain(t))).slice(0, 10);
    for (const t of noKeyword) console.log(`    ${t}`);
    if (!noKeyword.length) console.log('    None — everything dropped hit a negative rule instead.');

    console.log('\n  Nothing has been changed. Before adopting any term, measure it:');
    console.log('  it must let in what you want without letting in what you do not.\n');
  })();
}

if (process.argv[1] && /harvest-titles\.mjs$/.test(process.argv[1])) main();
