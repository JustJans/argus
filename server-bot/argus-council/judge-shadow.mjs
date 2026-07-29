// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the HARNESS of "The Council". It's the only file that runs on
// ➤ its own (via cron or by hand). It OBSERVES what Argus already decided and
// ➤ rethinks it with the 3 judges, noting the result in ITS OWN log. It runs in
// ➤ SHADOW: it decides NOTHING, it does NOT touch pipeline.md or any other bot file.
// ➤ WHAT IT DOES, start to finish:
// ➤   1. Reads the config (the council: block in portals.yml). If it is not
// ➤      on (enabled:false or the block is missing), it does NOTHING and exits.
// ➤   2. Gathers the offers to judge: the PRESENTED ones (pending, with URL) +
// ➤      a SAMPLE of dropped ones (by title, from data/scan-explain.txt).
// ➤   3. Drops the ones it ALREADY judged before (anti-repeat lock): each offer
// ➤      goes through the Council ONLY once, even if it stays pending and cron
// ➤      sees it again. For each NEW offer: it fetches its body (fetchOfferBody),
// ➤      runs the 3 judges, computes the verdict (2 of 3) and logs it.
// ➤ WHEN IT RUNS: CHAINED right after the scan (same cron line:
// ➤ «scan ; council»), with flock, reading the freshly written pipeline.md.
// ➤ ARCHITECTURE: Argus (the scanner) is the BASE and works on its own — it filters
// ➤ and sends the offers to Telegram by itself. The Council is the OPTIONAL layer
// ➤ "Argus Plus": it only adds its opinion (in shadow, to the log); if it's turned off
// ➤ (council.enabled:false) Argus keeps working the same. It can also be run by hand to test.
// ➤ WHAT IT USES (read-only): pendingOffers() from list-offers.mjs (presented),
// ➤ data/scan-explain.txt (sample of dropped), fetchOfferBody() from
// ➤ cover-letter.mjs (body), and the Council's judges/engine/ballot-box. The ONLY
// ➤ thing it writes are TWO of its own files: data/judge-shadow.jsonl (a machine
// ➤ log, one JSON line per offer) and data/council-log.txt (the SAME
// ➤ content but READABLE by you, with each judge's vote and reason).
// ➤ Neither belongs to the pipeline: it's still pure shadow.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { pendingOffers } from '../list-offers.mjs';
import { fetchOfferBody } from '../cover-letter.mjs';
import { JUDGES } from './judges.mjs';
import { runJudge } from './engine.mjs';
import { councilVote } from './vote.mjs';

// ➤ Paths: council/ → server-bot/ → argus/ (the project root).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));
const PORTALS_PATH = join(ROOT, 'portals.yml');
const EXPLAIN_PATH = join(ROOT, 'data', 'scan-explain.txt');
const JOURNAL_PATH = join(ROOT, 'data', 'judge-shadow.jsonl');
const LOG_PATH = join(ROOT, 'data', 'council-log.txt');   // ➤ the READABLE log

// ➤ ── ANTI-REPEAT ("1 batch per offer, don't repeat it") ──────────
// ➤ Unique key of an offer: its clean URL (without the tail after "?") if any;
// ➤ if not (dropped ones come with no URL), company+title. Used to tell whether
// ➤ an offer ALREADY went through the Council.
export function offerKey(o) {
  // ➤ Same Adzuna normalisation as scan/housekeep (audit 2026-07-25): this third
  // ➤ copy never received it, so the SAME offer arriving once as /land/ad/ and
  // ➤ once as /details/ counted as two and was judged (and paid for) twice.
  const u = String(o.url || '').split('?')[0].replace(/\/$/, '')
    .replace(/^(https?:\/\/[^/]*adzuna\.[a-z.]+)\/land\/ad\/(\d+)$/, '$1/details/$2');
  if (u) return u;
  return `${String(o.company || '').toLowerCase().trim()}::${String(o.title || '').toLowerCase().trim()}`;
}

// ➤ Reads from the judge-shadow.jsonl log the keys of everything ALREADY judged.
// ➤ If the file doesn't exist yet, nothing has been judged (empty set).
function loadJudgedKeys() {
  const keys = new Set();
  try {
    for (const line of readFileSync(JOURNAL_PATH, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { keys.add(offerKey(JSON.parse(line))); } catch {}
    }
  } catch {}
  return keys;
}

// ➤ Removes from the work list the offers that were already judged at some point.
// ➤ Pure function (takes the list and the set of keys) → easy to test.
export function filterUnjudged(work, judgedKeys) {
  return work.filter(o => !judgedKeys.has(offerKey(o)));
}

// ➤ Formats an offer's verdict in a READABLE way (what gets written to
// ➤ council-log.txt): the offer, each judge's vote and confidence on one line,
// ➤ the Council's ruling, and below each judge's reason. It's the same
// ➤ format as the draft you reviewed. Pure function → easy to test.
export function formatCouncilEntry(rec) {
  const v = rec.verdicts || {};
  const g = v.good || {}, b = v.bad || {}, u = v.ugly || {};
  const vote = j => `${j.vote ?? 'n/a'}/${Number(j.confidence ?? 0).toFixed(2)}`;
  // ➤ FULL reason: only whitespace/newlines are collapsed so it fits on
  // ➤ one line. It is NOT truncated (it used to be cut at 220 and split sentences).
  const reason = s => String(s || '').replace(/\s+/g, ' ').trim();
  const id = rec.id != null ? `#${rec.id} · ` : '';
  return [
    `${id}${rec.company || '(no company)'} — ${rec.title || '(no title)'}`,
    `   bot: ${rec.botDecision}  →  COUNCIL: ${String(rec.council).toUpperCase()}   (Good ${vote(g)} · Bad ${vote(b)} · Ugly ${vote(u)})`,
    `   Good — ${reason(g.reason)}`,
    `   Bad  — ${reason(b.reason)}`,
    `   Ugly — ${reason(u.reason)}`,
    '',
  ].join('\n');
}

// ➤ Reads the council: block from portals.yml. If it's missing or off, returns
// ➤ an object with enabled:false (so the harness doesn't run). It never breaks: on
// ➤ any read problem, it behaves as "off".
export function readCouncilConfig() {
  try {
    const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    const c = cfg.council || {};
    return {
      enabled: c.enabled === true,
      model: c.model || null,            // ➤ null = each judge uses its default model
      sample_dropped: Number.isInteger(c.sample_dropped) ? c.sample_dropped : 0,
    };
  } catch {
    return { enabled: false, model: null, sample_dropped: 0 };
  }
}

// ➤ Reads a SAMPLE of DROPPED offers from data/scan-explain.txt. It only
// ➤ keeps the ones the filter killed by title/language/years (the interesting
// ➤ false negatives) and returns only the first `limit`. NOTE: that
// ➤ file does NOT carry the URL, so these offers are judged BY title ONLY
// ➤ (empty body). Line format:
// ➤   [REASON] explanation — Title | Company | Location (source)
export function sampleDropped(text, limit) {
  if (!limit || limit <= 0) return [];
  const wanted = new Set(['TITLE', 'LANGUAGE', 'YEARS/DEGREE']);
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\[([^\]]+)\]\s+(.*)$/);
    if (!m) continue;
    const stage = m[1].trim();
    if (!wanted.has(stage)) continue;
    // ➤ The reason may contain em-dashes; the offer chunk is the
    // ➤ LAST segment after " — ".
    const parts = m[2].split(' — ');
    if (parts.length < 2) continue;
    const offerPart = parts[parts.length - 1];
    const fields = offerPart.split(' | ');
    if (fields.length < 2) continue;
    const title = fields[0].trim();
    const company = fields[1].trim();
    // ➤ The location (if any) has "(source)" at the end: it gets cleaned.
    let location = (fields[2] || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (location === '(no location)') location = '';
    out.push({ url: '', company, title, location, id: null, source: 'dropped', botDecision: `dropped:${stage}` });
    if (out.length >= limit) break;
  }
  return out;
}

// ➤ Judges ONE offer with the 3 judges and returns the full record ready
// ➤ to save. `model` (if provided) forces the model of all judges.
async function judgeOffer(offer, model) {
  // ➤ Fetches the body only if there's a URL (dropped ones don't carry it → title only).
  let body = '';
  if (offer.url) { try { body = await fetchOfferBody(offer.url); } catch { body = ''; } }
  const verdicts = {};
  // ➤ One judge at a time (sequential): the volume is low and this keeps the server
  // ➤ from getting overloaded with 3 AI calls at once.
  for (const judge of JUDGES) {
    verdicts[judge.key] = await runJudge(judge, offer, body, model ? { model } : {});
  }
  const council = councilVote([verdicts.good, verdicts.bad, verdicts.ugly]);
  return {
    ts: new Date().toISOString(),
    id: offer.id ?? null,
    company: offer.company || '',
    title: offer.title || '',
    url: offer.url || '',
    source: offer.source || 'pending',
    botDecision: offer.botDecision || 'presented',
    verdicts,
    council,
    userDecision: null, // ➤ reconcile.mjs fills this in when the user decides
  };
}

// ➤ Main routine of the harness (only runs if the Council is on).
async function main() {
  const cfg = readCouncilConfig();
  if (!cfg.enabled) {
    console.log('The Council is off (council.enabled != true in portals.yml). Nothing to do.');
    return;
  }
  // ➤ --limit N (optional, for manual testing): cap on offers to judge.
  const args = process.argv.slice(2);
  const li = args.indexOf('--limit');
  const limit = li !== -1 ? parseInt(args[li + 1], 10) : Infinity;

  // ➤ 1) The PRESENTED ones: the pending offers Argus showed (they carry URL and id).
  const presented = pendingOffers().map(o => ({ ...o, source: 'pending', botDecision: 'presented' }));
  // ➤ 2) The SAMPLE of dropped ones (by title), if the file exists.
  const dropped = existsSync(EXPLAIN_PATH)
    ? sampleDropped(readFileSync(EXPLAIN_PATH, 'utf-8'), cfg.sample_dropped)
    : [];
  let work = [...presented, ...dropped];
  // ➤ Removes the ones ALREADY judged: this way each offer goes through the Council ONCE,
  // ➤ even if it stays pending and cron sees it again in 2 h.
  const before = work.length;
  work = filterUnjudged(work, loadJudgedKeys());
  const skipped = before - work.length;
  if (Number.isFinite(limit)) work = work.slice(0, limit);

  if (!work.length) {
    console.log(`No NEW offers to judge (${skipped} already-judged were skipped).`);
    return;
  }
  console.log(`The Council: ${work.length} NEW offer(s) to judge (${skipped} already-judged skipped).`);

  // ➤ Header of the readable log (with date), to separate each batch.
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  appendFileSync(LOG_PATH, `\n════════ The Council — ${stamp} ════════\n${work.length} offer(s): ${presented.length} presented + ${dropped.length} sampled dropped\n\n`);

  let done = 0, failed = 0;
  const tally = { show: 0, hide: 0, tie: 0 };
  for (const offer of work) {
    const rec = await judgeOffer(offer, cfg.model);
    // ➤ If NO judge could speak (Claude out of credit, not authenticated, down),
    // ➤ this is NOT a verdict: we do not journal it. Journalling it would mark
    // ➤ the offer as "already judged" and it would never be looked at again —
    // ➤ which is exactly what happened on 2026-07-24. Skipping it means the next
    // ➤ run retries it; we stop the batch because the rest would fail the same.
    const votes = Object.values(rec.verdicts || {});
    if (votes.length && votes.every(v => v && v.failed)) {
      failed++;
      const why = String(votes[0].reason || '').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`  [!] ${rec.title} — ${rec.company}: the judges could not answer (${why}). NOT journalled; it will be retried.`);
      break;
    }
    // ➤ It APPENDS to BOTH logs; it never overwrites anything.
    appendFileSync(JOURNAL_PATH, JSON.stringify(rec) + '\n');   // ➤ for the machine
    appendFileSync(LOG_PATH, formatCouncilEntry(rec));          // ➤ readable by you
    tally[rec.council] = (tally[rec.council] || 0) + 1;
    done++;
    console.log(`  [${done}/${work.length}] ${rec.council.toUpperCase()} — ${rec.title} — ${rec.company} (bot: ${rec.botDecision})`);
  }
  // ➤ Footer with the batch summary.
  if (failed) appendFileSync(LOG_PATH, `Batch stopped: the judges could not answer (${failed} offer(s) left unjudged; they will be retried).\n`);
  appendFileSync(LOG_PATH, `Summary: SHOW ${tally.show} · HIDE ${tally.hide} · ties ${tally.tie}\n`);
  console.log(`Done. ${done} offer(s) → data/judge-shadow.jsonl (machine) and data/council-log.txt (readable).`);
}

// ➤ Guard anchored to the file name: main() runs ONLY when launching
// ➤ this script directly, not when importing it from the tests. WARNING: if the
// ➤ file is renamed, this regex must ALSO be updated (as in scan.mjs).
if (process.argv[1] && /(^|[\\/])judge-shadow\.mjs$/.test(process.argv[1])) {
  main().catch(e => { console.error('The Council failed:', e?.message || e); process.exit(1); });
}
