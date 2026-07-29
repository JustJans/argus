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

// ➤ Folds this run's drops into the standing record. Pure: give it the old
// ➤ store and the new drops, get the new store — no disk, so it is testable.
export function mergeDrops(store, drops, { today = '', cap = 4000 } = {}) {
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
  const kept = Object.entries(titles)
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
