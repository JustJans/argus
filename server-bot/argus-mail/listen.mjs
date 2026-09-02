#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the runner. It reads your recent mail, works out which application each
// ➤ message is about, and writes ONE file saying where every application stands:
// ➤ data/application-status.json. It records only the kind of message and its date — never
// ➤ the subject, the sender or a line of the body; if this file ever leaks it says "an
// ➤ application was rejected on the 4th", nothing more. It can do nothing to your mailbox
// ➤ (see gmail.mjs) and reads only back to your oldest recorded application. RUN: node
// ➤ server-bot/argus-mail/listen.mjs [--dry-run]
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { listMessageIds, messageSummary, accessToken, gmailConfigured } from '../gmail.mjs';
import { classifyMessage } from './classify.mjs';
import { linkOutcomes } from './match.mjs';
import { buildStatus, summarise, applyVerdicts } from './status.mjs';
import { writeFileAtomic } from '../fs-atomic.mjs';
// ➤ The same translator the offers list uses, so both lists read alike.
import { translateTitle } from '../notify.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const APPS_PATH = join(ROOT, 'data', 'applications.jsonl');
const OUT_PATH = join(ROOT, 'data', 'application-status.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ➤ HOW FAR BACK TO READ: to the day of your OLDEST recorded application, and not one day
// ➤ further. An email that arrived before you applied cannot be an answer to it, so
// ➤ reading it would only produce noise to throw away. It also means the bot reads as
// ➤ little of your mailbox as the job allows, which is the right default for something
// ➤ with a standing key to it.
export function windowFrom(applications, { pad = 1 } = {}) {
  const stamps = applications.map(a => new Date(a.ts)).filter(d => !isNaN(d));
  if (!stamps.length) return null;
  const oldest = new Date(Math.min(...stamps));
  oldest.setDate(oldest.getDate() - pad);       // a day's margin for time zones
  return oldest;
}

// ➤ Gmail's own search syntax wants YYYY/MM/DD.
export const gmailDate = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

// ➤ The search, in two parts, and the second is not cosmetic. WHAT YOU SENT IS NOT AN
// ➤ ANSWER: Gmail's search covers Sent as well as the inbox, and your own words classify —
// ➤ "thank you very much for considering me for an interview" is an interview invitation
// ➤ as far as any pattern can tell, your own message reported back as news. Measured on
// ➤ the real window it drops exactly the 2 messages the owner sent, and the bot reads less
// ➤ of a mailbox it holds a standing key to.
export const searchFor = since => `after:${gmailDate(since)} -from:me`;

// ➤ The verdicts you gave by hand with "no N", one JSON object per line, append-only: the
// ➤ record of what you decided and when; the newest line for an id is the one that counts.
export const VERDICTS_PATH = join(ROOT, 'data', 'application-verdicts.jsonl');

function loadVerdicts() {
  if (!existsSync(VERDICTS_PATH)) return [];
  return readFileSync(VERDICTS_PATH, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function loadApplications() {
  if (!existsSync(APPS_PATH)) return [];
  return readFileSync(APPS_PATH, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ➤ How many messages the mail run will look at in total. Gmail hands back at most 500 per
// ➤ page and listMessageIds walks the pages, so this number is a real ceiling rather than
// ➤ a page size: the window starts at your oldest application and only ever grows, Gmail
// ➤ answers newest-first, so a ceiling that cut at the first page would drop the OLDEST
// ➤ messages — the applications they answered sitting on "no reply" for ever.
const PAGE = 2000;

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
  // ➤ SAY SO WHEN THE CEILING BINDS. Gmail answers newest-first and the window only grows,
  // ➤ so hitting the cap silently drops the OLDEST messages — the replies to the oldest
  // ➤ applications — and, because this status is rebuilt from scratch each run, rejections
  // ➤ and interviews already reported would quietly regress to "no reply". It must never
  // ➤ happen in silence.
  if (ids.length >= PAGE) {
    console.error(`WARNING: the mailbox has more than ${PAGE} messages in the window — the oldest`);
    console.error('were NOT read, and their applications may wrongly show as "no reply".');
    console.error('Raise PAGE in server-bot/argus-mail/listen.mjs if this keeps happening.');
  }

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
  // ➤ Your own decisions go on top of what the mail says, never under it: this job rebuilds
  // ➤ the file from scratch every night, so a hand-given answer would otherwise be wiped at
  // ➤ midnight.
  const records = applyVerdicts(buildStatus(applications, links), loadVerdicts());
  // ➤ THE TITLES ARE PUT INTO ENGLISH HERE, at build time: "mail" must answer instantly like
  // ➤ "list" and cannot wait on a translator. Once a night, kept in the file, the original
  // ➤ alongside so the posting is still findable on the employer's site.
  await Promise.all(records.map(async r => {
    const src = applications.find(a => a.id === r.id);
    const en = await translateTitle(r.title, `${src?.location || ''} ${src?.url || ''}`);
    if (en && en !== r.title) r.titleEn = en;
  }));
  const summary = summarise(records);

  const out = {
    generated: new Date().toISOString(),
    since: gmailDate(since),
    summary,
    // ➤ Counted, not stored: an email that belongs to no application of yours is somebody
    // ➤ else's business. A tie is worth knowing about (you can settle it); an orphan inside
    // ➤ this window is simply mail that is not about your job search.
    unlinked: {
      ambiguous: ties.length,
      unrelated: orphans.length,
      // ➤ WHAT the tie was about, not only the count: "1 email fit more than one application"
      // ➤ with no employer, no kind and no application numbers is not something anybody can act
      // ➤ on, and the rule that produces ties promises you can. Ids and kind only: no subject,
      // ➤ sender or text.
      cases: ties.map(t => ({
        kind: t.message?.kind || 'unknown',
        ids: (t.candidates || []).map(c => c.application?.id).filter(id => id != null),
      })).filter(x => x.ids.length),
    },
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
  console.log(`  never arrived:  ${summary.bounced}`);
  console.log(`  interview:      ${summary.interview}`);
  console.log(`  rejected:       ${summary.rejected}`);
  console.log(`  acknowledged:   ${summary.acknowledged}`);
  console.log(`  no reply:       ${summary.noreply}`);
  // ➤ GHOSTED HAS TO BE ON THIS LIST, or the lines add up only while no application has
  // ➤ passed the 60-day mark — and the first to pass it goes missing from the summary
  // ➤ without a word.
  console.log(`  ghosted:        ${summary.ghosted}`);
  console.log(`  ambiguous, for you to settle: ${ties.length}`);
  // ➤ And the arithmetic is checked rather than assumed: a state added in
  // ➤ status.mjs and forgotten here is exactly how the list above went stale.
  const counted = summary.bounced + summary.interview + summary.rejected
    + summary.acknowledged + summary.noreply + summary.ghosted;
  if (counted !== summary.applications) {
    console.log(`  ⚠️ the states above cover ${counted} of ${summary.applications} applications — one is missing from this summary.`);
  }
}

if (process.argv[1] && /(^|[\\/])listen\.mjs$/.test(process.argv[1])) {
  main().catch(e => { console.error(String(e.message)); process.exit(1); });
}
