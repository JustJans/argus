#!/usr/bin/env node

// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the Telegram "remote control" for your job search.
// ➤ It reads the messages YOU send to the bot's chat and turns them into actions:
// ➤ launch a search now (search), view the pending offers (list),
// ➤ generate an offer's cover-letter PDF (cover N), or
// ➤ remove offers from the list (seen, or "no" with a reason to improve the filter).
// ➤ WHEN IT RUNS: the server launches it automatically every minute;
// ➤ it processes whatever new has arrived, replies via Telegram and shuts down.
// ➤ WHAT IT USES: telegram.json (bot keys), telegram-offset.json (remembers where
// ➤ it was reading), notify.mjs (send messages/PDFs), list-offers.mjs
// ➤ (pending offers), seen.mjs (mark as seen), scan.mjs (search),
// ➤ cover-letter.mjs (cover letters), and writes to feedback.jsonl (your rejections).
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * telegram-listener.mjs — Telegram as a remote control for argus.
 *
 * Runs every minute via cron (serialised with flock). Polls getUpdates,
 * processes messages FROM THE USER'S CHAT ONLY, replies, and exits.
 *
 * Commands:
 *   search                launch a full scan now (scan.mjs)
 *   list                  send the current pending offers (grouped digest)
 *   cover N               generate + send the cover-letter PDF for offer N
 *   applied N             log a SENT application (data/applications.jsonl)
 *   longshot N [reason]   same, but flagged: you know you fall short of it
 *   mail                  where every application you sent stands (from your inbox)
 *   blind                 titles the filter keeps discarding (your blind spots)
 *   seen N [N...]         hide offer(s) from the pending list
 *   no N [reason]         hide an offer AND record why to feedback.jsonl
 *   anything else         help text
 *
 * State: telegram-offset.json (last processed update_id). Lock: flock in
 * the cron line prevents overlapping runs while a scan is ongoing.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendTelegram, sendTelegramMessage, deleteTelegramMessage, esc } from './notify.mjs';
import { pendingOffers } from './list-offers.mjs';
// ➤ The "live list": deletes the previous list and re-sends the updated one to the
// ➤ bottom of the chat every time it changes (after list/seen/no/applied).
import { refreshList } from './live-list.mjs';
// ➤ The PDF cover-letter generator (the "cover N" command).
// ➤ The one-time setup / settings flow (CV + profile questions, some with
// ➤ buttons). It writes config/profile.yml + cv.md.
import {
  startOnboarding, startSettings, handleOnboardingText, handleOnboardingCallback, onboardingActive,
} from './onboarding.mjs';

// ➤ Paths and basic settings: where this script lives, the project's root
// ➤ folder and the configuration files.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const CFG_PATH = join(SCRIPT_DIR, 'telegram.json');
const OFFSET_PATH = join(SCRIPT_DIR, 'telegram-offset.json');

// ➤ Reads a data file (JSON format); if it doesn't exist or is corrupt,
// ➤ returns the fallback value instead of breaking the program.
function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

// ➤ Works out "where we got to" again WITHOUT running anything. Used when the
// ➤ position file is missing or unreadable: asking Telegram with offset -1 hands
// ➤ back only the most recent update, so we learn the current position and write
// ➤ it down. Nothing is handled on this tick — that is the point. The
// ➤ alternative, starting from zero, replays every command of the last 24 hours.
// ➤ On the very first run there are no updates at all and there is nothing to
// ➤ record; the next tick then starts from zero with an empty backlog, which
// ➤ comes to the same thing and is harmless.
async function resyncOffset(cfg) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/getUpdates?offset=-1&timeout=0`,
      { signal: AbortSignal.timeout(15_000) });
    const j = await res.json().catch(() => null);
    if (!j?.ok) return false;
    const last = (j.result || []).at(-1);
    // ➤ AN EMPTY QUEUE STILL HAS TO LEAVE A POSITION BEHIND. Writing nothing
    // ➤ meant a fresh install never created the file, so the next tick came
    // ➤ straight back here — and the tick that finally found something recorded
    // ➤ it and returned WITHOUT handling it. The very first command anyone ever
    // ➤ typed was swallowed in silence. Nothing waiting means nothing to
    // ➤ replay, so zero is the safe position to start from.
    const offset = last ? last.update_id + 1 : 0;
    writeFileAtomic(OFFSET_PATH, JSON.stringify({ offset }));
    console.log(`[${new Date().toISOString()}] telegram position was missing; starting from ${offset}${last ? ' (the backlog was skipped, not replayed)' : ''}.`);
    return true;
  } catch { return false; /* no network: the next tick tries again */ }
}

// ➤ Runs another of the bot's scripts (for example seen.mjs, the one that marks
// ➤ offers as seen) and collects everything it prints, to forward to you via Telegram.
function runNode(script, args) {
  return new Promise(resolve => {
    execFile('node', [join(SCRIPT_DIR, script), ...args], { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => resolve((stdout || '') + (stderr || '') + (err && !stdout && !stderr ? String(err.message) : '')));
  });
}

// ➤ Help text: it's what the bot replies to you when the message doesn't
// ➤ match any known command.
// ➤ Sent with HTML formatting (parse_mode HTML): <b> bold header, <code>
// ➤ monospaced commands (they stand out and copy with one tap). No user data
// ➤ goes in here, so the raw tags are safe.
const HELP =
  '<b>Argus — commands</b>\n' +
  '<i>N = the number shown next to each offer, e.g. #675</i>\n' +
  '\n' +
  '<code>list</code> — show the pending offers\n' +
  '<code>search</code> — search for new offers now\n' +
  '<code>seen N</code> — remove offer(s) from the list\n' +
  '<code>no N reason</code> — remove an offer and note why (improves the filter)\n' +
  '<code>applied N</code> — mark as applied (removes it from the list)\n' +
  '<code>interview N</code> — record an interview the inbox cannot see (a call, your own calendar)\n' +
  '<code>longshot N reason</code> — applied, but you know you fall short\n' +
  '<code>mail</code> — where every application you sent stands\n' +
  '<code>blind</code> — titles the filter keeps discarding (your blind spots)\n' +
  '<code>cover N</code> — make the cover-letter PDF for offer N\n' +
  '<code>settings</code> — edit your profile (CV, roles, countries...)\n' +
  '<code>help</code> — show this list';

// ➤ File where your rejections are recorded with their reason, one per line.
const FEEDBACK_PATH = join(SCRIPT_DIR, 'feedback.jsonl');

// ➤ What to tell you after a "seen" command, given the ids you asked for and
// ➤ everything seen.mjs printed.
// ➤ HONEST reply (2026-07-25): it used to say "Marked as seen" even when the
// ➤ number did not exist (already handled, or removed by the 07:30 clean-up),
// ➤ so you believed you had filed an offer that was never touched.
// ➤ IT NOW READS WHAT WAS MARKED, not what failed (audit 2026-07-31). The
// ➤ reply was built by looking for "#N is not in pending" and calling
// ➤ everything else a success — so any OTHER outcome (an empty pending
// ➤ section, a failed write, the program dying) still answered "Marked as
// ➤ seen", which is exactly the dishonesty the earlier fix set out to remove.
// ➤ seen.mjs prints a "  ✓ #N ..." line for each id it really marked, and that
// ➤ list is the only thing worth believing.
// ➤ Exported and pure so it can be tested: the command surface of this file had
// ➤ no test at all, which is why a reply could go on lying for a week.
export function seenReply(ids, out) {
  const text = String(out || '');
  const marked = ids.filter(i => new RegExp(`^\\s*✓ #${i}\\b`, 'm').test(text));
  const missing = ids.filter(i => !marked.includes(i));
  const tag = list => list.map(i => `#${i}`).join(', ');
  if (marked.length && missing.length) return `Marked as seen: ${tag(marked)}. Not found (already gone): ${tag(missing)}.`;
  if (marked.length) return `Marked as seen: ${tag(marked)}.`;
  // ➤ "ALREADY GONE" IS ALSO A CLAIM ABOUT YOUR LIST, and it is false when the
  // ➤ write simply failed — a full disk, a folder gone read-only, the program
  // ➤ killed. The offer is still there and still pending, and being told it is
  // ➤ gone means you stop chasing it. If the output looks like a crash rather
  // ➤ than an answer, say so instead.
  if (/[A-Za-z]*Error[:\s]|EACCES|EPERM|ENOSPC|ENOTDIR|^\s+at .+:\d+/m.test(text)) {
    return `Could not mark ${tag(missing)}: the list could not be written. Nothing was changed — try again.`;
  }
  return `Nothing marked: ${tag(missing)} ${missing.length > 1 ? 'are' : 'is'} not in the pending list (already removed?).`;
}

// ➤ Records something about an application you already SENT that you learnt
// ➤ somewhere the bot cannot read: the employer's own portal, a phone call, a
// ➤ bounced address they never fixed — or an interview arranged outside the
// ➤ inbox (real case: a Calendar event you create yourself mails its invite
// ➤ FROM you, and the mail reading skips your own messages on purpose).
// ➤ It is written to its own file rather than to feedback.jsonl because the two
// ➤ mean different things: feedback is "this offer was not for me" and trains
// ➤ the filter; this is "this is how the application went" and must NOT — you
// ➤ were right to apply.
// ➤ Returns true if it found an application with that number.
async function recordApplicationState(n, state, reason) {
  const path = join(ROOT, 'data', 'applications.jsonl');
  let app = null;
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id === n) app = r; } catch { /* corrupt line */ }
    }
  } catch { return false; }
  if (!app) return false;

  const rec = { ts: new Date().toISOString(), id: n, state, reason: reason || '' };
  writeFileSync(join(ROOT, 'data', 'application-verdicts.jsonl'), JSON.stringify(rec) + '\n', { flag: 'a' });
  console.log(`[${rec.ts}] application #${n} → ${state} → ${app.title} — ${app.company}`);
  // ➤ ESCAPED (audit 2026-07-31). The title and the company come from a job
  // ➤ portal and the reason is what you typed — none of it is ours. Sent as
  // ➤ HTML without escaping, a title carrying "<" or "&" makes Telegram refuse
  // ➤ the whole message, so the confirmation that the application was closed
  // ➤ never arrives while the file has already changed.
  const said = state === 'interview'
    ? `Interview recorded for #${n}: ${esc(app.title)} — ${esc(app.company)}. It shows in <code>mail</code> now.`
    : `Closed #${n}: ${esc(app.title)} — ${esc(app.company)}. It now shows as rejected in <code>mail</code>.`;
  await sendTelegram(said + (reason ? `\nNote: ${esc(reason)}` : ''), { html: true });
  return true;
}

// ➤ The "no N reason" command ("no 3 needs 5 years of experience"): removes
// ➤ offer 3 from pending AND records why it didn't fit in feedback.jsonl.
// ➤ That file is your rejection history — read it before touching the filters,
// ➤ so any change to them comes from your real criteria (and with tests).
async function rejectWithReason(n, reason) {
  // n is the STABLE offer id (#412 as shown on Telegram), never a position.
  const offers = pendingOffers();
  // ➤ Find the offer whose fixed number matches the one you typed.
  const off = offers.find(o => o.id === n);
  if (!off) {
    // ➤ NOT PENDING — so it may be one you already SENT. Some employers never
    // ➤ write back: they post the verdict on their own portal, or their address
    // ➤ bounces and nobody notices. That application would sit under "no reply"
    // ➤ for ever although you already know how it ended. Same word for the same
    // ➤ meaning: "no" closes it, and the answer survives the nightly rebuild.
    if (await recordApplicationState(n, 'rejected', reason)) return;
    await sendTelegram(`There's no pending offer with the number #${n} (did you already remove it?). The numbers appear on each offer in the list.`);
    return;
  }
  // ➤ Build the rejection entry: date, offer data and your reason.
  const rec = {
    ts: new Date().toISOString(),
    id: n, company: off.company, title: off.title, location: off.location, url: off.url,
    reason: reason || '(no reason)',
  };
  writeFileSync(FEEDBACK_PATH, JSON.stringify(rec) + '\n', { flag: 'a' });
  // ➤ Besides recording it, mark it as seen so it drops off the list.
  const seenOut = await runNode('seen.mjs', [String(n)]);
  console.log(`[${new Date().toISOString()}] no #${n} → ${off.title} — ${off.company} | seen: ${seenOut.trim().split('\n').pop()}`);
  await sendTelegram(`Discarded #${n}: ${off.title} — ${off.company}.${rec.reason ? ` Reason: ${rec.reason}` : ''}`);
  // ➤ The confirmation stays; the list refreshes without this offer.
  await refreshList({ markSeen: true });
}

// ➤ Launches the full scanner (scan.mjs, the same one that runs on its own every 2h) and
// ➤ WAITS for it to finish, returning everything it prints. Generous timeout
// ➤ (10 min) because it queries many portals. It's a task separate from the bot.
function runScan() {
  return new Promise(resolve => {
    execFile('node', [join(SCRIPT_DIR, 'scan.mjs')],
      // ➤ ARGUS_SKIP_LIST_REFRESH: tells the scanner NOT to refresh the list
      // ➤ itself; this listener refreshes it at the end of forceScan(), so that
      // ➤ the list ends up BELOW the "Search finished" message (at the bottom of the chat).
      { cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ARGUS_SKIP_LIST_REFRESH: '1' } },
      (err, stdout, stderr) => resolve((stdout || '') + (stderr || '')));
  });
}

// ➤ The "cover N" command. It checks the offer exists, says it has started, and
// ➤ HANDS THE WORK TO A SEPARATE PROGRAM — cover-letter.mjs sends you the PDF
// ➤ itself when it is done.
// ➤ WAITING HERE COST EVERYTHING ELSE. Claude takes minutes to write a letter,
// ➤ this listener runs once a minute under a lock, and the next run is skipped
// ➤ while this one is busy — so for those minutes "seen", "list" and "no" did
// ➤ nothing at all, with no sign of why.
async function coverCommand(n) {
  const off = pendingOffers().find(o => o.id === n);
  if (!off) {
    return sendTelegram(`There's no pending offer with the number #${n}. The numbers appear next to each offer in the list.`);
  }
  // ➤ The "Generating..." note is sent FIRST so its id can travel with the
  // ➤ child, which deletes it once the letter (or the failure) has arrived —
  // ➤ the same clean-up the mail report does.
  const progressId = await sendTelegramMessage(`Generating the cover letter for #${n}: ${off.title} — ${off.company}.`);
  // ➤ detached + unref + ignored streams: the child outlives this process, so
  // ➤ the lock is released the moment we finish, not when the letter is written.
  const args = [join(SCRIPT_DIR, 'cover-letter.mjs'), '--offer', String(n)];
  if (progressId != null) args.push('--progress-msg', String(progressId));
  const child = execFile('node', args, { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
}

// ➤ The "search" command: launches a job search RIGHT now (without waiting for the
// ➤ automatic scan every 2h). It notifies you when it starts; the scanner itself
// ➤ sends you the new offers if there are any; and when it finishes it confirms how many
// ➤ came up. It may take a couple of minutes.
async function forceScan() {
  await sendTelegram('Searching for new offers. This may take a few minutes.');
  const out = await runScan();
  // ➤ The scanner prints "New offers added: N" — that's how I get how many there were.
  const m = out.match(/New offers added:\s*(\d+)/);
  if (!m) {
    await sendTelegram('Search finished. Couldn\'t read the result; use "list" to see them.');
  } else {
    const n = parseInt(m[1], 10);
    if (n === 0) await sendTelegram('Search finished. No new offers.');
    else await sendTelegram(`Search finished. ${n} new offer(s), sent.`);
  }
  // ➤ And NOW yes, the list at the bottom: after the confirmation. (The scanner
  // ➤ didn't refresh it because we launched it with ARGUS_SKIP_LIST_REFRESH.) That way the
  // ➤ list stays as the last message, whether you triggered it (search) or there were no new ones.
  await refreshList({ markSeen: true });
}

// ➤ Record of SENT applications (the "applied N" command): history in
// ➤ data/applications.jsonl (the bot's own file; the applications.md from the
// ➤ original system is left untouched — it's from another flow and has been idle since May).
const APPLIED_PATH = join(ROOT, 'data', 'applications.jsonl');

// ➤ The "applied N" command: records the application with date and data, and removes the
// ➤ offer from pending (forever — a position already applied to must not
// ➤ be proposed again even if the company reposts it).
// ➤ "longshot": applying to something you KNOW you fall short of, on the off
// ➤ chance. It is still a sent application — same file, same removal from the
// ➤ list, same block on the offer coming back — but it carries longshot:true so
// ➤ nothing downstream reads it as "the bot got this one right".
// ➤ Why it matters: argus-council/reconcile.mjs treats applications.jsonl as the
// ➤ ground truth for SHOW. Without the flag, an application sent in hope tells
// ➤ it the opposite of the truth and grades the Council on a false positive.
async function markApplied(n, { longshot = false, reason = '' } = {}) {
  const off = pendingOffers().find(o => o.id === n);
  if (!off) {
    await sendTelegram(`There's no pending offer with the number #${n}. The numbers appear next to each offer in the list.`);
    return;
  }
  const rec = { ts: new Date().toISOString(), id: n, company: off.company, title: off.title, location: off.location, url: off.url };
  // ➤ The two extra fields only appear on longshots, so every line written
  // ➤ before this existed keeps reading exactly as it did.
  if (longshot) {
    rec.longshot = true;
    if (reason) rec.reason = reason;
  }
  writeFileSync(APPLIED_PATH, JSON.stringify(rec) + '\n', { flag: 'a' });
  await runNode('seen.mjs', [String(n)]);
  const tag = longshot ? 'longshot' : 'applied';
  console.log(`[${new Date().toISOString()}] ${tag} #${n} → ${off.title} — ${off.company}${reason ? ` | ${reason}` : ''}`);
  await sendTelegram(longshot
    ? `Longshot recorded: #${n} ${off.title} — ${off.company}.${reason ? `\nShort on: ${reason}` : ''}`
    : `Application recorded: #${n} ${off.title} — ${off.company}.`);
  // ➤ The confirmation stays; the list refreshes without this offer.
  await refreshList({ markSeen: true });
}

// ➤ The listener's "brain": takes the text of one of your messages, works out which
// ➤ command it corresponds to (trying patterns one by one, top to bottom) and
// ➤ runs the matching action. If nothing fits, it sends the help text.
async function handle(text) {
  const t = text.trim();
  console.log(`[${new Date().toISOString()}] cmd: ${t.slice(0, 100)}`);

  // ➤ Every command is case-insensitive, and offer numbers are accepted with
  // ➤ or without the hash ("#412" or "412").
  // ➤ Is it "help" (or "/help")? → show the list of commands.
  if (/^\/?help$/i.test(t)) {
    await sendTelegram(HELP, { html: true });
    return;
  }
  // ➤ "/start" → the one-time setup (CV + profile questions).
  // ➤ "/start yes" confirms replacing a profile you already have: the first
  // ➤ question is "paste your CV", and from then on ANY text you type is stored
  // ➤ as an answer — so starting again by accident used to cost you the CV.
  if (/^\/?start(\s+yes)?$/i.test(t)) {
    await startOnboarding(/\s+yes$/i.test(t));
    return;
  }
  // ➤ "settings" → edit any profile answer later (menu with buttons).
  if (/^\/?settings$/i.test(t)) {
    await startSettings();
    return;
  }
  // ➤ Is the message "seen" followed by one or more numbers? → mark as seen.
  if (/^seen(\s+#?\d+)+$/i.test(t)) {
    const ids = t.split(/\s+/).slice(1).map(s => s.replace(/^#/, ''));
    const out = await runNode('seen.mjs', ids);
    await sendTelegram(seenReply(ids, out));
    // ➤ The confirmation above stays; only the list refreshes (the previous one is
    // ➤ deleted and re-sent without those offers).
    await refreshList({ markSeen: true });
    return;
  }
  // ➤ Is it "search" (or "scan")? → launch a full scan right now.
  if (/^(search|scan)$/i.test(t)) {
    await forceScan();
    return;
  }
  // ➤ Is it "cover 412" (or "cover #412")? → generate the cover-letter
  // ➤ PDF for that offer and send it here.
  if (/^cover\s*#?\d+$/i.test(t)) {
    const n = parseInt(t.match(/(\d+)/)[1], 10);
    await coverCommand(n);
    return;
  }
  // ➤ Is it "list"? → send the pending offers grouped by country, as always
  // ➤ (the buttons from 2026-07-18 were tried and the user removed them that same day:
  // ➤ the owner prefers typing the commands — don't reintroduce them).
  if (/^list$/i.test(t)) {
    // ➤ "list" now refreshes the live list: deletes the previous one and re-sends the
    // ➤ pending offers to the bottom of the chat (if there are none, it says "No pending offers").
    // ➤ AND IT ANSWERS WHEN IT CANNOT (audit 2026-07-31). If the send failed or
    // ➤ Telegram was not configured, this command produced no list, no error and
    // ➤ no reply of any kind — you were left staring at a chat that had simply
    // ➤ ignored you, with no way to tell that from "there is nothing new".
    const r = await refreshList({ markSeen: true });
    if (r === false) await sendTelegram('The list could not be sent just now. Try again in a moment.');
    return;
  }
  // ➤ Is it "applied N"? → record that you SENT the application:
  // ➤ it's logged in data/applications.jsonl (your history of sent applications) and
  // ➤ the offer drops off pending (and won't come back even if reposted).
  // ➤ (optional separator — "applied5" without a space is also valid, audit)
  // ➤ "longshot 729 I don't have the 3 years" — checked BEFORE "applied" so the
  // ➤ two never race, and the trailing text is kept as the requirement you fall
  // ➤ short of (same shape as "no N reason").
  // ➜ "blind": the titles the filter keeps throwing away. Not a list of
  // ➜ mistakes — most of it is correctly discarded — but the only way a gap in
  // ➜ the field list becomes visible instead of staying silent.
  // ➜ "mail": where every application you have sent stands. The twin of
  // ➜ "list" — one shows the offers waiting for you, the other what came back
  // ➜ from the ones you sent. It RE-READS THE INBOX FIRST (2026-08-05): the
  // ➜ report used to be whatever the nightly run left, so "mail" could answer
  // ➜ with yesterday. If Gmail cannot be read right now (down, token expired),
  // ➜ the last report is shown with its date rather than nothing. The nightly
  // ➜ run stays — it keeps the report fresh without being asked.
  // ➜ "status" still answers too: it was the first name this had.
  if (/^(mail|status)$/i.test(t)) {
    const { formatStatus } = await import('./argus-mail/report.mjs');
    const workingId = await sendTelegramMessage('Reading your inbox — this takes a minute.', { silent: true });
    const refreshed = await new Promise(resolve => {
      execFile('node', [join(SCRIPT_DIR, 'argus-mail', 'listen.mjs')],
        { cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
        (err) => resolve(!err));
    });
    const status = loadJson(join(ROOT, 'data', 'application-status.json'), null);
    if (workingId != null) await deleteTelegramMessage(workingId);
    if (!status) {
      await sendTelegram('No status yet. Set Gmail up first (see server-bot/argus-mail/README.md); the report appears after the first read.');
      return;
    }
    const stale = refreshed ? '' : `\n\nThe inbox could not be read just now — this is the report from ${String(status.generated || '').slice(0, 10)}.`;
    // ➤ ONE mail report in the chat, not a pile: each "mail" replaces the
    // ➤ previous report, the same discipline as the live list. Send FIRST,
    // ➤ delete after — a failed send must never leave the chat with no report
    // ➤ at all. The previous id rides in data/mail-message.json.
    const MAIL_MSG_PATH = join(ROOT, 'data', 'mail-message.json');
    const prev = loadJson(MAIL_MSG_PATH, null);
    const id = await sendTelegramMessage(formatStatus(status) + esc(stale), { html: true });
    if (id != null) {
      writeFileAtomic(MAIL_MSG_PATH, JSON.stringify({ message_id: id, ts: new Date().toISOString() }));
      if (prev?.message_id != null && prev.message_id !== id) await deleteTelegramMessage(prev.message_id);
    }
    return;
  }
  if (/^blind$/i.test(t)) {
    const { loadStore, formatReport } = await import('./argus-discover/blind-spots.mjs');
    const report = formatReport(loadStore(), { limit: 10 });
    // ➤ WITH html:true (audit 2026-07-31). The report was wrapped in <pre> and
    // ➤ carefully escaped, then sent with no parse mode — so Telegram delivered
    // ➤ it verbatim and you read "<pre>" and "&amp;" on the screen. Escaping now
    // ➤ goes through the same helper the rest of the bot uses, not a second
    // ➤ hand-written copy of it that omitted ">".
    await sendTelegram(`<pre>${esc(report)}</pre>`, { html: true });
    return;
  }
  if (/^longshot[\s,:]*#?\d+/i.test(t)) {
    const m = t.match(/^longshot[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    await markApplied(parseInt(m[1], 10), { longshot: true, reason: m[2].trim() });
    return;
  }
  if (/^applied[\s,:]*#?\d+/i.test(t)) {
    const m = t.match(/^applied[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    const n = parseInt(m[1], 10);
    await markApplied(n);
    // ➤ "applied N" ignores anything typed after the number, and that silence
    // ➤ once filed an application-sent-in-hope as a normal one. It still is a
    // ➤ normal application — but say so, and point at the command that keeps
    // ➤ the nuance.
    if (m[2].trim()) {
      // ➤ WITH html:true, and the typed note escaped (audit 2026-07-31): this
      // ➤ message is built out of <code> tags and was sent with no parse mode,
      // ➤ so the tags arrived as literal text in the middle of the sentence.
      await sendTelegram(`Note: "${esc(m[2].trim())}" was not saved — <code>applied</code> only reads the number.\nIf you meant you fall short of it, use <code>longshot ${n} ${esc(m[2].trim())}</code> instead.`, { html: true });
    }
    return;
  }
  // ➤ "interview 749 friday 9am" — an interview arranged where the inbox cannot
  // ➤ see it: a phone call, LinkedIn, or a Calendar event you created yourself
  // ➤ (its invite mail comes FROM you, and mail reading skips your own). The
  // ➤ trailing text is an optional note, kept with the record.
  if (/^interview[\s,:]*#?\d+/i.test(t)) {
    const m = t.match(/^interview[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    const n = parseInt(m[1], 10);
    if (!(await recordApplicationState(n, 'interview', m[2].trim()))) {
      await sendTelegram(`No application with the number #${n}. <code>interview</code> works on applications you marked with <code>applied</code>.`, { html: true });
    }
    return;
  }
  // ➤ Is it "no 3 reason..." (or stuck together "no3")? → reject the offer
  // ➤ recording why. (Optional separator — audit 2026-07-18: "no5"
  // ➤ typed quickly fell through to the help text.)
  if (/^no[\s,:]*#?\d+/i.test(t)) {
    // ➤ Split the offer number from the reason text.
    const m = t.match(/^no[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    await rejectWithReason(parseInt(m[1], 10), m[2].trim());
    return;
  }
  // ➤ Does it start with "no" but WITHOUT a number ("No, needs 5 years...")?
  // ➤ → ask which one you mean, instead of dumping generic help.
  if (/^no\b/i.test(t)) {
    await sendTelegram('Which one do you mean? Tell me the number shown next to the offer, e.g.:\nno #412 needs 10 years of experience');
    return;
  }
  // ➤ Nothing matched: send the help text with the available commands.
  await sendTelegram(HELP, { html: true });
}

// ➤ Main routine: asks Telegram whether there are new messages since the
// ➤ last time, processes them one by one ONLY those coming from your chat, and records
// ➤ where the reading is up to so it doesn't repeat commands if something is cut off.
async function main() {
  const cfg = loadJson(CFG_PATH, null);
  // ➤ A token but no chat yet: FINISH THE LINK OURSELVES (field test
  // ➤ 2026-08-05). The moment any listener polls this bot — this one, or a
  // ➤ survivor of an earlier install — it CONSUMES the "hi" the setup console
  // ➤ is waiting for, and the console then waits two minutes for a message
  // ➤ that no longer exists, for ever. The listener is the rightful owner of
  // ➤ getUpdates, so it completes the link itself; the console notices the
  // ➤ chat_id appearing in telegram.json and moves on.
  if (cfg?.bot_token && !cfg?.chat_id) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/getUpdates?offset=-1&timeout=0`,
        { signal: AbortSignal.timeout(15_000) });
      const j = await res.json().catch(() => null);
      const chat = (j?.result || []).map(u => u.message?.chat).filter(Boolean).at(-1);
      if (chat) {
        writeFileSync(CFG_PATH, JSON.stringify({ ...cfg, chat_id: String(chat.id) }, null, 2) + '\n', 'utf-8');
        await sendTelegram('Connected. Finish the setup in the console; when it says Done, send /start here to build your profile.');
        console.log(`chat_id ${chat.id} learned from the first message and saved.`);
      } else if (process.stdout.isTTY) {
        console.log('Almost there: telegram.json has a token but no chat_id. Send your bot any message and this links itself within a minute.');
      }
    } catch { /* no network: the next tick tries again */ }
    return;
  }
  // ➤ Not configured yet: nothing to do. It says so only when a person ran it
  // ➤ by hand — from cron, stdout is not a terminal and silence is correct, or
  // ➤ the log would gain one identical line every minute for ever.
  if (!cfg?.bot_token || !cfg?.chat_id) {
    if (process.stdout.isTTY) {
      console.log('Not set up yet: server-bot/telegram.json is missing its bot_token. Run the one-line installer from the README, or setup\\setup-windows.bat / bash setup/setup-linux-mac.sh');
    }
    return;
  }

  // ➤ Asks Telegram for the pending messages starting from the last one already read,
  // ➤ with a maximum wait of 15 seconds so it doesn't hang.
  // ➤ WHERE WE GOT TO LAST TIME — the one thing stopping a command being run
  // ➤ twice. Telegram keeps 24 hours of messages and hands back everything from
  // ➤ the offset onwards, so "start from 0" does not mean "start fresh", it
  // ➤ means REPLAY A WHOLE DAY: every `applied N`, every `no N`, every `cover N`
  // ➤ you typed since yesterday, executed again.
  // ➤ So a missing or unreadable file is NOT treated as zero (audit 2026-07-31).
  // ➤ It resynchronises instead: ask Telegram for the latest update only, write
  // ➤ that position down, and run nothing this tick. One tick's messages can be
  // ➤ missed that way, which you would notice and could retype; a day of
  // ➤ commands running themselves again is not something you could undo.
  const state = loadJson(OFFSET_PATH, null);
  if (!state || !Number.isInteger(state.offset)) {
    // ➤ fresh = the file never existed: the listener's very first run, not a
    // ➤ corruption of an established install.
    const fresh = !existsSync(OFFSET_PATH);
    const ok = await resyncOffset(cfg);
    // ➤ THE FIRST /start FELL IN A HOLE (field test 2026-08-03): a brand-new
    // ➤ user types /start during the setup, this first tick then synchronises
    // ➤ PAST it — deliberately, replaying history is worse — and the user is
    // ➤ left in front of a silent bot. Say the bot is alive and what to type.
    // ➤ Only on a virgin install (setup never completed), so an established
    // ➤ bot that loses its offset file does not greet its owner like a stranger.
    if (ok && fresh && !existsSync(join(ROOT, 'data', 'onboarding-answers.json'))) {
      await sendTelegram('Argus is listening now. Send /start to set up your profile.');
    }
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${cfg.bot_token}/getUpdates?offset=${state.offset}&timeout=0`,
    { signal: AbortSignal.timeout(15_000) },
  );
  const j = await res.json().catch(() => null);
  if (!j?.ok) return;

  // ➤ Iterate over each new message, in order of arrival.
  for (const u of j.result || []) {
    // ➤ Save progress BEFORE running the command: if the program
    // ➤ crashed midway, on restart it wouldn't repeat commands already done.
    state.offset = u.update_id + 1;
    // ➤ Persisted BEFORE handling, so a crash cannot replay the command — and
    // ➤ written aside-then-renamed, so a crash cannot leave this file half
    // ➤ written either. It was the only plain writeFileSync left in the project,
    // ➤ on the one file whose corruption replays a day of commands rather than
    // ➤ losing one (audit 2026-07-31).
    writeFileAtomic(OFFSET_PATH, JSON.stringify(state));
    // ➤ Button taps (onboarding / settings) arrive as callback_query, not as a
    // ➤ message. Route them to the onboarding handler.
    const cb = u.callback_query;
    if (cb) {
      if (String(cb.message?.chat?.id) !== String(cfg.chat_id)) continue; // your chat only
      try { await handleOnboardingCallback(cb.data, cb.id); }
      catch (e) { try { await sendTelegram(`Error: ${String(e.message).slice(0, 200)}`); } catch {} }
      continue;
    }
    const msg = u.message;
    if (!msg?.text) continue;
    // ➤ Security: ignore any message that doesn't come from YOUR chat.
    if (String(msg.chat?.id) !== String(cfg.chat_id)) continue; // the user's chat only
    // ➤ If a command fails, you're notified via Telegram instead of dying silently.
    try {
      // ➤ While setup/settings is waiting for a typed answer, the text goes
      // ➤ there; otherwise it's a normal command.
      if (onboardingActive() && await handleOnboardingText(msg.text)) continue;
      await handle(msg.text);
    } catch (e) {
      try { await sendTelegram(`Error: ${String(e.message).slice(0, 200)}`); } catch {}
    }
  }
}

// ➤ Startup: runs the main routine; if something blows up, the program exits
// ➤ quietly (the scheduled task will launch it again the next minute).
// ➤ ONLY WHEN THIS FILE IS THE PROGRAM BEING RUN. It used to start on import,
// ➤ so anything that so much as read a function out of this file started the
// ➤ bot: a test importing it would have polled Telegram with the real token and
// ➤ executed whatever commands were waiting. Every other module in the project
// ➤ already guards its entry point this way (audit 2026-07-31).
if (process.argv[1] && /(^|[\\/])telegram-listener\.mjs$/.test(process.argv[1])) {
  main().catch(() => process.exit(0));
}
