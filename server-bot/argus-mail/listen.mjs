#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the runner. It reads your recent mail, works out which of your
// ➤ applications each message is about, and writes ONE file saying where every
// ➤ application stands: data/application-status.json.
// ➤
// ➤ WHAT IT WRITES ABOUT YOUR MAIL: the kind of message and its date. Never
// ➤ the subject, never the sender, never a line of the body. If this file ever
// ➤ leaks it says "an application was rejected on the 4th", nothing more.
// ➤ WHAT IT CANNOT DO: anything to your mailbox. See gmail.mjs.
// ➤ HOW MUCH IT READS: only back to your oldest recorded application. Nothing
// ➤ before that can be an answer to anything the bot knows about.
// ➤ RUN: node server-bot/argus-mail/listen.mjs [--dry-run]
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { listMessageIds, messageSummary, accessToken, gmailConfigured } from '../gmail.mjs';
import { classifyMessage } from './classify.mjs';
import { linkOutcomes } from './match.mjs';
import { buildStatus, summarise } from './status.mjs';
import { writeFileAtomic } from '../fs-atomic.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const APPS_PATH = join(ROOT, 'data', 'applications.jsonl');
const OUT_PATH = join(ROOT, 'data', 'application-status.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ➤ HOW FAR BACK TO READ: to the day of your OLDEST recorded application, and
// ➤ not one day further. An email that arrived before you applied cannot be an
// ➤ answer to it, so reading it would only produce noise to throw away — the
// ➤ first version read 120 days and spent most of its effort on 36 messages
// ➤ belonging to applications made before there was anywhere to record them.
// ➤ It also means the bot reads as little of your mailbox as the job allows,
// ➤ which is the right default for something with a standing key to it.
export function windowFrom(applications, { pad = 1 } = {}) {
  const stamps = applications.map(a => new Date(a.ts)).filter(d => !isNaN(d));
  if (!stamps.length) return null;
  const oldest = new Date(Math.min(...stamps));
  oldest.setDate(oldest.getDate() - pad);       // a day's margin for time zones
  return oldest;
}

// ➤ Gmail's own search syntax wants YYYY/MM/DD.
export const gmailDate = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

// ➤ The search. Two parts, and the second one is not cosmetic.
// ➤ WHAT YOU SENT IS NOT AN ANSWER. Gmail's search covers Sent as well as the
// ➤ inbox, so a reply you wrote comes back with everything else — and your own
// ➤ words classify: a real one in this mailbox reads "muchas gracias por
// ➤ considerarme para una entrevista", which is an interview invitation as far
// ➤ as any pattern can tell. It would be your own message reported back to you
// ➤ as news. Measured on the real window: this drops exactly the 2 messages
// ➤ the owner sent and nothing else, and it means the bot reads less of the mailbox,
// ➤ which is the right direction for something holding a standing key to it.
export const searchFor = since => `after:${gmailDate(since)} -from:me`;

function loadApplications() {
  if (!existsSync(APPS_PATH)) return [];
  return readFileSync(APPS_PATH, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ➤ How many messages to look at. Gmail caps a page at 500 and that is several
// ➤ months of a normal mailbox, which is more than enough: an application older
// ➤ than that has already told you its answer, one way or another.
const PAGE = 500;

async function main() {
  if (!gmailConfigured()) {
    console.error('Gmail is not set up. Run: node server-bot/gmail-auth.mjs');
    process.exit(1);
  }
  const applications = loadApplications();
  if (!applications.length) {
    console.log('No applications on record yet — nothing to find the state of.');
    return;
  }

  const since = windowFrom(applications);
  const token = await accessToken();
  const ids = await listMessageIds(searchFor(since), { max: PAGE, token });
  console.log(`Reading ${ids.length} messages since ${gmailDate(since)}, the day of your oldest`);
  console.log('recorded application, skipping anything you sent yourself.');
  console.log('Read and dropped: what is kept is the kind of message and its date.');

  // ➤ A few at a time. This is a mailbox, not a load test, and the whole job
  // ➤ runs unattended: there is nothing to gain by being in a hurry.
  const queue = [...ids];
  const messages = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try { messages.push(await messageSummary(id, { token })); } catch { /* skip the unreadable one */ }
    }
  }));

  const outcomes = messages
    .map(m => ({ ...m, kind: classifyMessage(m) }))
    .filter(m => m.kind && m.kind !== 'alert');

  const { links, ties, orphans } = linkOutcomes(outcomes, applications);
  const records = buildStatus(applications, links);
  const summary = summarise(records);

  const out = {
    generated: new Date().toISOString(),
    since: gmailDate(since),
    summary,
    // ➤ Counted, not stored: an email that belongs to no application of
    // ➤ yours is somebody else's business and there is no reason to keep it.
    // ➤ A tie is worth knowing about (you can settle it); an orphan inside
    // ➤ this window is simply mail that is not about your job search.
    unlinked: { ambiguous: ties.length, unrelated: orphans.length },
    applications: records,
  };

  if (dryRun) {
    console.log('\n--- dry run, nothing written ---');
  } else {
    writeFileAtomic(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(`\nWritten to ${OUT_PATH}`);
  }

  console.log('');
  console.log(`  applications:   ${summary.applications} (${summary.longshots} longshot)`);
  console.log(`  interview:      ${summary.interview}`);
  console.log(`  rejected:       ${summary.rejected}`);
  console.log(`  acknowledged:   ${summary.acknowledged}`);
  console.log(`  no reply:       ${summary.noreply}`);
  console.log(`  ambiguous, for you to settle: ${ties.length}`);
}

if (process.argv[1] && /(^|[\\/])listen\.mjs$/.test(process.argv[1])) {
  main().catch(e => { console.error(String(e.message)); process.exit(1); });
}
