// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "reality judge". Weeks later it fills in the userDecision field of
// ➤ each line in data/judge-shadow.jsonl from what the user ACTUALLY decided, which turns
// ➤ the shadow log into a grade. Sources: data/applications.jsonl → 'show' ("applied N"),
// ➤ server-bot/feedback.jsonl → 'hide' ("no N ..."), "| visto" marks in pipeline.md →
// ➤ 'seen'. Each line whose userDecision is still empty is matched by URL (preferred) or
// ➤ by id, precedence applied > rejected > seen, and the file is rewritten. Runs by hand
// ➤ or on an occasional cron; calls neither the AI nor the network; writes only its own
// ➤ journal.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
// ➤ Atomic overwrite so a crash mid-write can't truncate the judges' journal.
import { writeFileAtomic, withFileLock } from '../fs-atomic.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVERBOT = dirname(SCRIPT_DIR);
const ROOT = dirname(SERVERBOT);
const JOURNAL_PATH = join(ROOT, 'data', 'judge-shadow.jsonl');
const APPLIED_PATH = join(ROOT, 'data', 'applications.jsonl');
const FEEDBACK_PATH = join(SERVERBOT, 'feedback.jsonl');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

// ➤ Reads a .jsonl file and returns the list of valid objects (skips empty or
// ➤ corrupt lines without breaking).
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* corrupt line: ignored */ }
  }
  return out;
}

// ➤ The "user's real decision" map per offer, as two indexes (by URL and by id) pointing
// ➤ to 'show' | 'hide' | 'seen'. Precedence: applied(show) over rejected(hide) over seen —
// ➤ a submitted application wins over any other mark.
export function buildUserDecisions({ applied = [], feedback = [], pipelineText = '' } = {}) {
  const byUrl = new Map();
  const byId = new Map();
  // ➤ Applied from LOWEST to HIGHEST precedence, so the last write
  // ➤ (the strongest one) wins.
  const put = (rec, decision) => {
    if (rec?.url) byUrl.set(rec.url, decision);
    if (rec?.id != null) byId.set(String(rec.id), decision);
  };
  // ➤ 1) seen: the "| visto" lines from pipeline.md. They carry a "#id" and a URL.
  for (const line of String(pipelineText).split('\n')) {
    if (!/\|\s*visto\s*$/.test(line)) continue;
    const idm = line.match(/#(\d+)/);
    const urlm = line.match(/https?:\/\/\S+/);
    if (idm) byId.set(idm[1], 'seen');
    if (urlm) byUrl.set(urlm[0], 'seen');
  }
  // ➤ 2) rejected (hide): overrides the seen ones.
  for (const r of feedback) put(r, 'hide');
  // ➤ 3) applied (show): overrides everything.
  // ➤ EXCEPT a longshot: "longshot N" means it was sent while knowing the
  // ➤ requirements fall short, so it is NOT evidence the offer suited the user
  // ➤ and must not grade the Council as right. It stays out of the ground truth
  // ➤ entirely — 'seen' from the pipeline still applies if it was looked at.
  for (const r of applied) if (!r.longshot) put(r, 'show');
  return { byUrl, byId };
}

// ➤ Given a journal line and the indexes, decides what the user put (or null if
// ➤ they have not decided it yet). The URL wins over the id.
export function decideFor(rec, { byUrl, byId }) {
  if (rec?.url && byUrl.has(rec.url)) return byUrl.get(rec.url);
  if (rec?.id != null && byId.has(String(rec.id))) return byId.get(String(rec.id));
  return null;
}

function main() {
  if (!existsSync(JOURNAL_PATH)) {
    console.log('data/judge-shadow.jsonl does not exist yet. Nothing to reconcile.');
    return;
  }
  const idx = buildUserDecisions({
    applied: readJsonl(APPLIED_PATH),
    feedback: readJsonl(FEEDBACK_PATH),
    pipelineText: existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '',
  });

  // ➤ READ-FILL-REWRITE UNDER LOCK. This runs by hand or on its own cron, OUTSIDE the
  // ➤ scan+council flock — and the Council appends a verdict per offer across a batch that
  // ➤ lasts minutes. A line appended between this read and the rewrite would be erased: that
  // ➤ offer re-judged later (three paid AI calls repeated) and its history gone. The lock is
  // ➤ held for the milliseconds of the read and write only; the shrink guard stays as the
  // ➤ second line of defence.
  let filled = 0;
  withFileLock(JOURNAL_PATH, () => {
    const records = readJsonl(JOURNAL_PATH);
    for (const rec of records) {
      // ➤ Only the ones without a decision yet are filled (already-set values are not overwritten).
      if (rec.userDecision) continue;
      const d = decideFor(rec, idx);
      if (d) { rec.userDecision = d; filled++; }
    }
    // ➤ SAFETY: this rewrites the WHOLE journal from the lines it managed to parse, so any
    // ➤ unreadable line would be silently deleted. A journal is history: we refuse to shrink
    // ➤ it.
    const onDisk = readFileSync(JOURNAL_PATH, 'utf-8').split('\n').filter(l => l.trim()).length;
    if (records.length < onDisk) {
      console.error(`Refusing to rewrite the journal: ${onDisk} lines on disk but only ${records.length} readable. Nothing was changed.`);
      return;
    }
    writeFileAtomic(JOURNAL_PATH, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    console.log(`Reconciled ${filled} offer(s) with the user's real decision (out of ${records.length} in the log).`);
  });
}

// ➤ Guard anchored to the filename: run main() ONLY when launched directly, not
// ➤ when imported from the tests. (If it is renamed, update this regex.)
if (process.argv[1] && /(^|[\\/])reconcile\.mjs$/.test(process.argv[1])) {
  main();
}
