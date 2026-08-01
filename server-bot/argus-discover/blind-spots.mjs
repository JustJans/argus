#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the record of what the title filter throws away, so that the
// ➤ throwing away stops being silent.
// ➤ WHY IT EXISTS: the filter demands a word from a hand-written list of your
// ➤ field. That works when a field is a tidy noun. Yours is not — offshore,
// ➤ automation, GIS, aquaculture, hydrology — so any list is incomplete, and a
// ➤ title outside it vanishes without a trace. Measured on one real cycle:
// ➤ 1,308 titles dropped, 977 by a rule you wrote from your own rejections and
// ➤ 331 for no reason but "not on the list". "Asset Integrity Engineer" was in
// ➤ that 331.
// ➤ HOW IT AVOIDS BECOMING NOISE: it does not try to guess which of the 331
// ➤ matter — cross-referencing them against the CV was tried and returns
// ➤ "support" and "management". It counts RECURRENCE instead. A one-off barman
// ➤ appears once and goes; a role you are systematically blind to comes back
// ➤ every week. Recurrence needs no theory about what your field is.
// ➤ IT CHANGES NOTHING. scan.mjs feeds it; this file only reads and prints.
// ➤ RUN: node server-bot/argus-discover/blind-spots.mjs [--limit 12]
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileAtomic } from '../fs-atomic.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));
export const STORE_PATH = join(ROOT, 'data', 'blind-spots.json');

// ➤ Two buckets, because they mean opposite things and deserve opposite
// ➤ reactions. NO_FIELD: nothing objected to it, it simply was not on the list
// ➤ — the blind spot proper. RULE: a veto you wrote fired; useful to see in
// ➤ case a rule is firing wider than you meant (a "técnico" or "auxiliar" post
// ➤ can genuinely fit, and today those are blocked outright).
export const NO_FIELD = 'no-field';
export const RULE = 'rule';

// ➤ Same title from two boards is one title.
const key = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ➤ Pulls the offending word out of the filter's sentence, so the report can
// ➤ print the rule rather than the prose around it.
export function ruleOf(why) {
  const m = String(why || '').match(/blocked word "([^"]+)"/i);
  return m ? m[1] : String(why || '').slice(0, 30);
}

export function classifyDrop(why) {
  return /no keyword from your field/i.test(String(why || '')) ? NO_FIELD : RULE;
}

// ➤ How long an entry may go unseen before it is forgotten. This is the real
// ➤ bound on the file: a blind spot is something that KEEPS coming back, so one
// ➤ nothing has thrown away for two months is not one any more.
export const STALE_DAYS = 60;

// ➤ The date N days before the given YYYY-MM-DD, as YYYY-MM-DD. Returns ''
// ➤ when there is no date to work from, and every comparison then passes.
export function daysBefore(today, days) {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(days)) return '';
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

// ➤ THE CEILING. It used to be 4,000, and a record that had been running a
// ➤ while sat exactly on it with every single slot held by a title already seen
// ➤ twice — so nothing new could ever be counted a second time and the record
// ➤ had quietly stopped learning. Measured against a real file: at 4,000 a new
// ➤ title never reaches n=2; at 10,000 it does. 20,000 is that with room to
// ➤ spare, and still only a few megabytes on disk. The real bound here is the
// ➤ 60-day window above, not this number — the cap is only a backstop in case
// ➤ something goes wrong.
export const MAX_TITLES = 20000;

// ➤ Folds this run's drops into the standing record. Pure: give it the old
// ➤ store and the new drops, get the new store — no disk, so it is testable.
export function mergeDrops(store, drops, { today = '', cap = MAX_TITLES, staleDays = STALE_DAYS } = {}) {
  const titles = { ...(store?.titles || {}) };
  for (const d of drops) {
    const k = key(d.title);
    if (!k) continue;
    const prev = titles[k];
    titles[k] = {
      // ➤ First spelling wins. Boards publish the same role in several cases
      // ➤ ("ASSET INTEGRITY ENGINEER", "asset integrity engineer"); letting the
      // ➤ latest win would leave you reading whichever shouted last.
      title: prev?.title || d.title,
      why: d.why || '',
      // ➤ The caller decides the bucket by re-testing the title without the
      // ➤ field list, which is the only way to know whether a rule would have
      // ➤ killed it anyway. classifyDrop is the fallback for old records and
      // ➤ reads the reason text, which over-reports the blind-spot bucket.
      bucket: d.bucket || classifyDrop(d.why),
      n: (prev?.n || 0) + 1,
      first: prev?.first || today,
      last: today,
    };
  }
  // ➤ Bounded on purpose: a scan every two hours would grow this forever.
  // ➤ What survives a cull is what recurs, which is exactly what we are after.
  // ➤
  // ➤ BUT A FULL STORE STOPS LEARNING (audit 2026-07-31). Sorting by count
  // ➤ alone means every entry that has ever been seen twice outranks every
  // ➤ newcomer for ever. Measured on a real record: 3,905 of the 4,000 slots
  // ➤ were held by entries at n>=2, leaving 95 for the ~1,250 distinct new
  // ➤ titles a single cycle throws away. A role that only started appearing
  // ➤ last week was evicted before it could ever be counted twice — and being
  // ➤ counted twice is the entire definition of the thing this file exists to
  // ➤ find. Two changes, and deliberately NOT a third. Ranking newcomers ahead
  // ➤ of proven ones was tried and rejected: with a tight ceiling a wave of
  // ➤ one-offs would evict the very titles the record exists to surface, which
  // ➤ is a worse fault than the one being fixed.
  const stale = daysBefore(today, staleDays);
  const kept = Object.entries(titles)
    // ➤ 1. FORGET WHAT STOPPED COMING BACK. An entry nothing has thrown away
    // ➤ for two months is history, not a blind spot, and it is holding a slot a
    // ➤ live one needs. This, not the ceiling, is what really bounds the file.
    // ➤ Entries with no date are kept: they predate this rule.
    .filter(([, t]) => !t.last || !stale || String(t.last) >= stale)
    // ➤ 2. And a ceiling high enough that there are slots left over — see
    // ➤ MAX_TITLES above for the measurement.
    .sort((a, b) => b[1].n - a[1].n || String(b[1].last).localeCompare(String(a[1].last)))
    .slice(0, cap);
  return { updated: today, titles: Object.fromEntries(kept) };
}

// ➤ The report: what keeps coming back. Seen once is noise by definition, so
// ➤ the default floor is 2 — a title has to have been thrown away twice before
// ➤ it is worth a second of your attention.
export function topRecurring(store, { bucket = NO_FIELD, limit = 12, minSeen = 2 } = {}) {
  return Object.values(store?.titles || {})
    .filter(t => t.bucket === bucket && t.n >= minSeen)
    .sort((a, b) => b.n - a.n || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
}

export function loadStore(path = STORE_PATH) {
  if (!existsSync(path)) return { updated: '', titles: {} };
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { updated: '', titles: {} }; }
}

export function saveStore(store, path = STORE_PATH) {
  writeFileAtomic(path, JSON.stringify(store));
}

// ➤ The same text the Telegram command sends, built here so both the terminal
// ➤ and the chat say exactly the same thing.
export function formatReport(store, { limit = 12 } = {}) {
  const blind = topRecurring(store, { bucket: NO_FIELD, limit });
  const ruled = topRecurring(store, { bucket: RULE, limit: 6 });
  const total = Object.keys(store?.titles || {}).length;
  if (!total) return 'Nothing recorded yet. The record fills up as scans run.';

  const out = [`BLIND SPOTS — ${total} distinct titles thrown away, last updated ${store.updated || '?'}`, ''];
  out.push('NOT ON YOUR LIST (nothing objected — you just never see these)');
  if (!blind.length) out.push('  nothing has recurred yet');
  for (const t of blind) out.push(`  ${String(t.n).padStart(3)}x  ${t.title.slice(0, 58)}`);
  out.push('');
  out.push('A RULE OF YOURS FIRED (check none is firing wider than you meant)');
  if (!ruled.length) out.push('  nothing has recurred yet');
  // ➤ Show the RULE, not the sentence around it: "the title has the blocked
  // ➤ word X" truncates to "the title has the blocked word Te", which hides the
  // ➤ only part that matters.
  for (const t of ruled) out.push(`  ${String(t.n).padStart(3)}x  ${t.title.slice(0, 46)}  — ${ruleOf(t.why)}`);
  out.push('');
  out.push('Recurrence is the whole signal: seen once is noise, seen weekly is a gap.');
  return out.join('\n');
}

if (process.argv[1] && /blind-spots\.mjs$/.test(process.argv[1])) {
  const i = process.argv.indexOf('--limit');
  const limit = i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 12;
  console.log('\n' + formatReport(loadStore(), { limit: limit || 12 }) + '\n');
}
