#!/usr/bin/env node

// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the Telegram "remote control" for your job search: it reads the messages
// ➤ YOU send to the bot and turns them into actions — search now, list the pending offers,
// ➤ a cover-letter PDF (cover N), remove offers (seen, or "no" with a reason). WHEN IT
// ➤ RUNS: always — one quiet long-polling connection to Telegram, reacting within about a
// ➤ second; the schedule only revives it if it dies. Uses telegram.json (bot keys),
// ➤ telegram-offset.json (where it was reading), notify.mjs, list-offers.mjs, seen.mjs,
// ➤ scan.mjs, cover-letter.mjs, and writes feedback.jsonl (your rejections).
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * telegram-listener.mjs — Telegram as a remote control for argus.
 *
 * Long-polls getUpdates in a loop: Telegram holds each request open up to
 * POLL_SECONDS and answers the instant something arrives, so a command or a
 * button tap is handled in about a second instead of waiting for the next
 * scheduled run (cron rounded that wait up to a whole minute — the single
 * biggest reason the bot ever felt slow). Processes messages FROM THE USER'S
 * CHAT ONLY, replies, and goes back to waiting. The every-minute schedule is
 * now a watchdog: a run that finds a live listener yields at once (flock on
 * Linux, IgnoreNew on Windows, listener-alive.json everywhere), and a run
 * that finds none BECOMES the listener. `--once` keeps the old single pass
 * for tests and the diagnose scripts.
 *
 * Commands:
 *   search                launch a full scan now (scan.mjs)
 *   list                  send the current pending offers (grouped digest)
 *   cover N               generate + send the cover-letter PDF for offer N
 *   applied N             log a SENT application (data/applications.jsonl)
 *   longshot N [reason]   same, but flagged: you know you fall short of it
 *   mail                  where every application you sent stands (from your inbox)
 *   seen N [N...]         hide offer(s) from the pending list
 *   no N [reason]         hide an offer AND record why to feedback.jsonl
 *   vetoes                the standing vetoes taught after a "no", tap to remove
 *   anything else         help text
 *
 * State: telegram-offset.json (last processed update_id) and
 * listener-alive.json (pid + heartbeat of the running listener, so two can
 * never poll at once — two pollers steal each other's updates).
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { writeFileAtomic, trimLog, withFileLock } from './fs-atomic.mjs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendTelegram, sendTelegramMessage, deleteTelegramMessage, esc, TG_API, editTelegramButtons, answerCallback, listPageKeyboard, LIST_PAGES_PATH } from './notify.mjs';
import { pendingOffers } from './list-offers.mjs';
// ➤ The "live list": deletes the previous list and re-sends the updated one to the
// ➤ bottom of the chat every time it changes (after list/seen/no/applied).
import { refreshList } from './live-list.mjs';
// ➤ The PDF cover-letter generator (cover N), and the one-time setup / settings flow (CV +
// ➤ profile questions, some with buttons), which writes config/profile.yml + cv.md.
import {
  startOnboarding, startSettings, handleOnboardingText, handleOnboardingCallback, handleOnboardingDocument, onboardingActive,
} from './onboarding.mjs';
// ➤ The review mode: the pending offers one card at a time, with buttons. Decisions run
// ➤ THIS file's command handlers in quiet mode, so a button and a typed command are one
// ➤ code path.
import { startReview, handleReviewCallback, undoDecision, REVIEW_STATE_PATH } from './review.mjs';
// ➤ EXPERIMENTAL: the "no" that teaches — a one-tap veto panel after each typed rejection,
// ➤ and the "vetoes" command to manage them.
import { sendVetoChips, handleVetoCallback, startVetoList } from './vetoes.mjs';

// ➤ Paths and basic settings: where this script lives, the project's root
// ➤ folder and the configuration files.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const CFG_PATH = join(SCRIPT_DIR, 'telegram.json');
const OFFSET_PATH = join(SCRIPT_DIR, 'telegram-offset.json');
// ➤ Who is listening right now: {pid, ts}. Refreshed every HEARTBEAT_MS while
// ➤ alive; anyone who finds it fresher than ALIVE_STALE_MS yields instead of
// ➤ starting a second poller. (.gitignore's server-bot/*.json rule covers it.)
const ALIVE_PATH = join(SCRIPT_DIR, 'listener-alive.json');
// ➤ How long Telegram may hold each getUpdates open: 50 is the Bot API docs' own
// ➤ long-polling example — under common 60 s proxy timeouts, and the request still returns
// ➤ the instant an update arrives.
const POLL_SECONDS = 50;
const HEARTBEAT_MS = 30_000;
// ➤ Three missed heartbeats: a crashed listener is replaced within ~90 s plus the
// ➤ watchdog's minute; a live one doing a long "search" is never usurped, because the
// ➤ heartbeat keeps beating between awaits.
const ALIVE_STALE_MS = 90_000;
// ➤ Planned self-restart, taken only on an idle cycle so nothing is dropped: bounds any
// ➤ slow leak to six hours; the watchdog brings a fresh listener within a minute.
const RECYCLE_MS = 6 * 60 * 60 * 1000;

// ➤ Reads a data file (JSON format); if it doesn't exist or is corrupt,
// ➤ returns the fallback value instead of breaking the program.
function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

// ➤ Is that process still running? Signal 0 delivers nothing, it only checks; EPERM means
// ➤ "exists but is not yours" — alive. `kill` is injectable so tests can stage
// ➤ live/dead/foreign pids.
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try { kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

// ➤ Claims (or re-claims) the "I am the listener" slot — at startup to decide who runs,
// ➤ and every heartbeat to refresh the stamp. Returns false when ANOTHER listener holds a
// ➤ fresh claim: the caller must not poll, because Telegram gives getUpdates to one
// ➤ consumer only and two pollers steal each other's updates. A stale stamp or a dead pid
// ➤ is taken over. The read-check-write sits under the directory lock so two starters
// ➤ cannot both claim the same gap.
export function claimListenerSlot(selfPid, deps = {}) {
  const d = {
    load: () => loadJson(ALIVE_PATH, null),
    save: s => writeFileAtomic(ALIVE_PATH, JSON.stringify(s)),
    alive: pidAlive, now: Date.now, staleMs: ALIVE_STALE_MS,
    lock: fn => withFileLock(ALIVE_PATH, fn),
    ...deps,
  };
  let owned = false;
  d.lock(() => {
    const cur = d.load();
    const otherHoldsIt = cur && Number.isInteger(cur.pid) && cur.pid !== selfPid
      && Number.isFinite(cur.ts) && Math.abs(d.now() - cur.ts) < d.staleMs && d.alive(cur.pid);
    if (otherHoldsIt) return;
    d.save({ pid: selfPid, ts: d.now() });
    owned = true;
  });
  return owned;
}

// ➤ Works out "where we got to" again WITHOUT running anything, when the position file is
// ➤ missing or unreadable: offset -1 hands back only the most recent update, so the
// ➤ position is learnt and written down and nothing is handled this tick — starting from
// ➤ zero would replay every command of the last 24 hours. On the very first run there are
// ➤ no updates at all; the next tick then starts from zero with an empty backlog, which is
// ➤ harmless.
async function resyncOffset(cfg) {
  try {
    const res = await fetch(`${TG_API}/bot${cfg.bot_token}/getUpdates?offset=-1&timeout=0`,
      { signal: AbortSignal.timeout(15_000) });
    const j = await res.json().catch(() => null);
    if (!j?.ok) return false;
    const last = (j.result || []).at(-1);
    // ➤ AN EMPTY QUEUE STILL HAS TO LEAVE A POSITION BEHIND: writing nothing means a fresh
    // ➤ install never creates the file, the next tick comes straight back here, and the tick
    // ➤ that finally finds something records it WITHOUT handling it — the very first command
    // ➤ anyone typed, swallowed. Nothing waiting means nothing to replay, so zero is the safe
    // ➤ start.
    const offset = last ? last.update_id + 1 : 0;
    writeFileAtomic(OFFSET_PATH, JSON.stringify({ offset }));
    console.log(`[${new Date().toISOString()}] telegram position was missing; starting from ${offset}${last ? ' (the backlog was skipped, not replayed)' : ''}.`);
    return true;
  } catch { return false; /* no network: the next tick tries again */ }
}

// ➤ Runs another of the bot's scripts (for example seen.mjs, the one that marks offers as
// ➤ seen) and collects everything it prints, to forward to you via Telegram.
// ➤ process.execPath, not 'node': children run on the EXACT same runtime as this process —
// ➤ immune to PATH surprises, and on Windows, where the schedule runs the bot as
// ➤ argus.exe, every child shows up in Task Manager under the product's name instead of as
// ➤ an anonymous node.exe.
function runNode(script, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [join(SCRIPT_DIR, script), ...args], { cwd: ROOT, timeout: 60_000 },
      (err, stdout, stderr) => resolve((stdout || '') + (stderr || '') + (err && !stdout && !stderr ? String(err.message) : '')));
  });
}

// ➤ Help text: the reply when a message matches no command. HTML: <b> header, <code>
// ➤ commands (they stand out and copy with one tap); no user data goes in, so the raw tags
// ➤ are safe.
const HELP =
  '<b>Argus — commands</b>\n' +
  '<i>N = the number shown next to each offer, e.g. #675</i>\n' +
  '\n' +
  '<code>list</code> — show the pending offers\n' +
  '<code>review</code> — go through them one by one, with buttons\n' +
  '<code>search</code> — search for new offers now\n' +
  '<code>seen N</code> — remove offer(s) from the list\n' +
  '<code>undo N</code> — put an offer back after seen/no/applied\n' +
  '<code>no N reason</code> — remove an offer and note why; then one tap can turn it into a standing veto\n' +
  '<code>vetoes</code> — every veto you taught this way, tap one to remove it\n' +
  '<code>applied N</code> — mark as applied (removes it from the list)\n' +
  '<code>interview N</code> — record an interview the inbox cannot see (a call, your own calendar)\n' +
  '<code>longshot N reason</code> — applied, but you know you fall short\n' +
  '<code>mail</code> — where every application you sent stands\n' +
  '<code>cover N</code> — make the cover-letter PDF for offer N\n' +
  '<code>settings</code> — edit your profile (CV, roles, countries...)\n' +
  '<code>help</code> — show this list';

// ➤ File where your rejections are recorded with their reason, one per line.
const FEEDBACK_PATH = join(SCRIPT_DIR, 'feedback.jsonl');

// ➤ Turns a page of the live list on a Prev/Next tap. The pages were written to disk by
// ➤ the process that sent the list and this runs in a LATER listener process, so the file
// ➤ is the only bridge; the stored message_id must match the tapped message — a tap on an
// ➤ older list gets a toast, never a redraw of the wrong thing. Returns false only when
// ➤ the tap is not a page button at all, so the caller can route it on.
// ➤ Dependency-injected so the honesty rules are testable.
export async function flipListPage(data, messageId, cbId, deps = {}) {
  const d = {
    loadPages: () => loadJson(LIST_PAGES_PATH, null),
    editButtons: editTelegramButtons, answer: answerCallback, keyboard: listPageKeyboard,
    ...deps,
  };
  const m = String(data || '').match(/^pg:(\d+|cur)$/);
  if (!m) return false;
  if (m[1] === 'cur') { await d.answer(cbId); return true; }   // the page counter: just stop the spinner
  const st = d.loadPages();
  if (!st || st.message_id !== messageId || !Array.isArray(st.pages) || !st.pages.length) {
    await d.answer(cbId, 'This list is outdated — send "list" for a fresh one.');
    return true;
  }
  const total = st.pages.length;
  const n = Math.min(Math.max(parseInt(m[1], 10), 1), total);
  // ➤ Answer FIRST: the button's spinner dies the instant the tap is seen and the page swaps
  // ➤ in right behind it; the other order left the button "loading" for the whole edit
  // ➤ round-trip.
  await d.answer(cbId);
  await d.editButtons(messageId, st.pages[n - 1], d.keyboard(n, total), { html: true });
  return true;
}

// ➤ Splits a long report on line boundaries into Telegram-sized messages —
// ➤ the same 3500-char discipline notify.mjs applies to the offers list.
export function chunkLines(text, max = 3500) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

// ➤ What to tell you after a "seen" command, given the ids you asked for and everything
// ➤ seen.mjs printed. HONEST: only the "  ✓ #N ..." lines seen.mjs prints for each id it
// ➤ really marked are believed — any other outcome is reported as not done.
export function seenReply(ids, out) {
  const text = String(out || '');
  const marked = ids.filter(i => new RegExp(`^\\s*✓ #${i}\\b`, 'm').test(text));
  const missing = ids.filter(i => !marked.includes(i));
  const tag = list => list.map(i => `#${i}`).join(', ');
  if (marked.length && missing.length) return `Marked as seen: ${tag(marked)}. Not found (already gone): ${tag(missing)}.`;
  if (marked.length) return `Marked as seen: ${tag(marked)}.`;
  // ➤ "ALREADY GONE" IS ALSO A CLAIM ABOUT YOUR LIST, and false when the write simply failed
  // ➤ (a full disk, a read-only folder, the program killed): the offer is still pending, and
  // ➤ told it is gone you stop chasing it. Output that looks like a crash is reported as
  // ➤ such.
  if (/[A-Za-z]*Error[:\s]|EACCES|EPERM|ENOSPC|ENOTDIR|^\s+at .+:\d+/m.test(text)) {
    return `Could not mark ${tag(missing)}: the list could not be written. Nothing was changed — try again.`;
  }
  return `Nothing marked: ${tag(missing)} ${missing.length > 1 ? 'are' : 'is'} not in the pending list (already removed?).`;
}

// ➤ Records something about an application you already SENT that you learnt where the bot
// ➤ cannot read: the employer's portal, a phone call, a bounced address — or an interview
// ➤ arranged outside the inbox (a Calendar event you create mails its invite FROM you, and
// ➤ the mail reading skips your own messages on purpose). Its own file, not
// ➤ feedback.jsonl: feedback is "this offer was not for me" and trains the filter; this is
// ➤ "this is how the application went" and must NOT — you were right to apply. Returns
// ➤ true if it found an application with that number.
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
  // ➤ ESCAPED. The title and company come from a job portal and the reason is what you typed
  // ➤ — none of it is ours. Sent as HTML unescaped, a "<" or "&" makes Telegram refuse the
  // ➤ whole message, so the confirmation never arrives while the file has already changed.
  const said = state === 'interview'
    ? `Interview recorded for #${n}: ${esc(app.title)} — ${esc(app.company)}. It shows in <code>mail</code> now.`
    : `Closed #${n}: ${esc(app.title)} — ${esc(app.company)}. It now shows as rejected in <code>mail</code>.`;
  await sendTelegram(said + (reason ? `\nNote: ${esc(reason)}` : ''), { html: true });
  return true;
}

// ➤ The "no N reason" command ("no 3 needs 5 years of experience"): removes offer 3 from
// ➤ pending AND records why in feedback.jsonl — your rejection history, to be read before
// ➤ touching the filters. quiet: the review card runs this same function for its "No"
// ➤ button, records and honesty checks identical, but the card is the confirmation so the
// ➤ chat message is skipped. Returns what the card and a later undo need: found, gone, and
// ➤ the record's ts.
async function rejectWithReason(n, reason, { quiet = false } = {}) {
  // n is the STABLE offer id (#412 as shown on Telegram), never a position.
  const offers = pendingOffers();
  // ➤ Find the offer whose fixed number matches the one you typed.
  const off = offers.find(o => o.id === n);
  if (!off) {
    if (quiet) return { found: false };
    // ➤ NOT PENDING — so it may be one you already SENT. Some employers never write back (the
    // ➤ verdict sits on their portal, or their address bounces unnoticed), and that
    // ➤ application would sit under "no reply" for ever although you know how it ended. Same
    // ➤ word for the same meaning: "no" closes it, and the answer survives the nightly
    // ➤ rebuild.
    if (await recordApplicationState(n, 'rejected', reason)) return { found: true };
    await sendTelegram(`There's no pending offer with the number #${n} (did you already remove it?). The numbers appear on each offer in the list.`);
    return { found: false };
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
  // ➤ Read what seen.mjs SAYS it removed before confirming, exactly as the plain `seen`
  // ➤ command does: this reuse must not confirm success over a failed write.
  const gone = new RegExp(`^\\s*✓ #${n}\\b`, 'm').test(String(seenOut || ''));
  if (!quiet) await sendTelegram(`Discarded #${n}: ${off.title} — ${off.company}.${rec.reason ? ` Reason: ${rec.reason}` : ''}${gone ? '' : '\nWarning: it could not be removed from the pending list (write failed) — it may show up again. Try "seen ' + n + '".'}`);
  // ➤ The confirmation stays; the list refreshes without this offer.
  await refreshList({ markSeen: true });
  return { found: true, gone, recTs: rec.ts };
}

// ➤ Launches the full scanner (scan.mjs, the same one that runs every 2 h) and WAITS for
// ➤ it, returning everything it prints. Generous timeout (10 min): it queries many
// ➤ portals.
function runScan() {
  return new Promise(resolve => {
    execFile(process.execPath, [join(SCRIPT_DIR, 'scan.mjs')],
      // ➤ ARGUS_SKIP_LIST_REFRESH tells the scanner NOT to refresh the list; this listener
      // ➤ refreshes it at the end of forceScan(), so the list ends up BELOW the "Search
      // ➤ finished" message.
      { cwd: ROOT, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ARGUS_SKIP_LIST_REFRESH: '1' } },
      (err, stdout, stderr) => resolve((stdout || '') + (stderr || '')));
  });
}

// ➤ The "cover N" command: checks the offer exists, says it has started, and HANDS THE
// ➤ WORK TO A SEPARATE PROGRAM — cover-letter.mjs sends the PDF itself. Waiting here would
// ➤ cost everything else: Claude takes minutes, this listener runs under a lock, and
// ➤ "seen", "list" and "no" would do nothing meanwhile.
async function coverCommand(n) {
  const off = pendingOffers().find(o => o.id === n);
  if (!off) {
    return sendTelegram(`There's no pending offer with the number #${n}. The numbers appear next to each offer in the list.`);
  }
  // ➤ The "Generating..." note is sent FIRST so its id can travel with the child, which
  // ➤ deletes it once the letter (or the failure) has arrived — the mail report's clean-up.
  const progressId = await sendTelegramMessage(`Generating the cover letter for #${n}: ${off.title} — ${off.company}.`);
  // ➤ detached + unref + ignored streams: the child outlives this process, so
  // ➤ the lock is released the moment we finish, not when the letter is written.
  const args = [join(SCRIPT_DIR, 'cover-letter.mjs'), '--offer', String(n)];
  if (progressId != null) args.push('--progress-msg', String(progressId));
  const child = execFile(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
}

// ➤ The "search" command: a job search RIGHT now, without waiting for the 2 h scan. It
// ➤ says it started, the scanner itself sends any new offers, and at the end it confirms
// ➤ how many came up. A couple of minutes.
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
  // ➤ And NOW the list at the bottom, after the confirmation (the scanner was launched with
  // ➤ ARGUS_SKIP_LIST_REFRESH), so the list stays the last message whether or not anything
  // ➤ new came up.
  await refreshList({ markSeen: true });
}

// ➤ Record of SENT applications ("applied N"): data/applications.jsonl, the bot's own file.
const APPLIED_PATH = join(ROOT, 'data', 'applications.jsonl');

// ➤ The "applied N" command: records the application with date and data and removes the
// ➤ offer from pending for good — a position applied to must not be proposed again even if
// ➤ reposted. "longshot": applying to something you KNOW you fall short of; still a sent
// ➤ application (same file, same removal, same block on coming back) but flagged
// ➤ longshot:true, because argus-council/reconcile.mjs treats applications.jsonl as ground
// ➤ truth for SHOW and an application sent in hope would grade the Council on a false
// ➤ positive.
async function markApplied(n, { longshot = false, reason = '', quiet = false } = {}) {
  const off = pendingOffers().find(o => o.id === n);
  if (!off) {
    if (quiet) return { found: false };
    await sendTelegram(`There's no pending offer with the number #${n}. The numbers appear next to each offer in the list.`);
    return { found: false };
  }
  const rec = { ts: new Date().toISOString(), id: n, company: off.company, title: off.title, location: off.location, url: off.url };
  // ➤ The two extra fields only appear on longshots, so every line written
  // ➤ before this existed keeps reading exactly as it did.
  if (longshot) {
    rec.longshot = true;
    if (reason) rec.reason = reason;
  }
  writeFileSync(APPLIED_PATH, JSON.stringify(rec) + '\n', { flag: 'a' });
  // ➤ Same honesty as `seen` and `no`: confirm only what seen.mjs reports actually removed,
  // ➤ and say so when the write failed.
  const seenOut = await runNode('seen.mjs', [String(n)]);
  const gone = new RegExp(`^\\s*✓ #${n}\\b`, 'm').test(String(seenOut || ''));
  const tag = longshot ? 'longshot' : 'applied';
  console.log(`[${new Date().toISOString()}] ${tag} #${n} → ${off.title} — ${off.company}${reason ? ` | ${reason}` : ''}`);
  if (!quiet) await sendTelegram((longshot
    ? `Longshot recorded: #${n} ${off.title} — ${off.company}.${reason ? `\nShort on: ${reason}` : ''}`
    : `Application recorded: #${n} ${off.title} — ${off.company}.`)
    + (gone ? '' : `\nWarning: it could not be removed from the pending list (write failed) — it may show up again. Try "seen ${n}".`));
  // ➤ The confirmation stays; the list refreshes without this offer.
  await refreshList({ markSeen: true });
  return { found: true, gone, recTs: rec.ts };
}

// ➤ What the review card's buttons run: this file's own command handlers in
// ➤ quiet mode. The card is the confirmation; the wrappers hand back only what
// ➤ the card and a later undo need (the record's ts, and a warning when the
// ➤ honesty check says the list write failed).
// ➤ What the veto panel needs from this listener: hiding matched pending
// ➤ offers exactly as a typed "seen" would (each stays undoable with
// ➤ "undo N"), plus the list refresh that follows any removal.
function vetoTapDeps() {
  return {
    hide: async ids => {
      await runNode('seen.mjs', ids.map(String));
      await refreshList({ markSeen: true });
    },
  };
}

function reviewDeps() {
  return {
    seen: async o => {
      const out = await runNode('seen.mjs', [String(o.id)]);
      const gone = new RegExp(`^\\s*✓ #${o.id}\\b`, 'm').test(String(out || ''));
      await refreshList({ markSeen: true });
      return gone ? {} : { warn: 'It could not be removed from the list — it may still be pending.' };
    },
    reject: async o => {
      const r = await rejectWithReason(o.id, '', { quiet: true });
      if (!r.found) return { warn: 'It was no longer in the pending list — nothing was recorded.' };
      return { recTs: r.recTs, ...(r.gone ? {} : { warn: 'Recorded, but it could not be removed from the list.' }) };
    },
    applied: async o => {
      const r = await markApplied(o.id, { quiet: true });
      if (!r.found) return { warn: 'It was no longer in the pending list — nothing was recorded.' };
      return { recTs: r.recTs, ...(r.gone ? {} : { warn: 'Recorded, but it could not be removed from the list.' }) };
    },
    cover: coverCommand,
    refresh: () => refreshList({ markSeen: true }),
  };
}

// ➤ "undo 845" (or a bare "undo" for the last card decision): the offer comes back to
// ➤ pending and the record its decision wrote (feedback or application) is removed, so a
// ➤ slip of the finger leaves no trace. Works for typed decisions too — any offer hidden
// ➤ with the "| visto" tag.
async function undoCommand(t) {
  const st = loadJson(REVIEW_STATE_PATH, null);
  const mNum = t.match(/(\d+)/);
  let n = mNum ? parseInt(mNum[1], 10) : null;
  if (n == null) {
    const entries = Object.entries(st?.decisions || {});
    if (!entries.length) {
      await sendTelegram('Nothing to undo: no recent card decision. Use "undo N" with the offer number.');
      return;
    }
    entries.sort((a, b) => String(a[1].at || '').localeCompare(String(b[1].at || '')));
    n = parseInt(entries[entries.length - 1][0], 10);
  }
  const decision = st?.decisions?.[String(n)] || null;
  const r = undoDecision(n, decision);
  if (st?.decisions && st.decisions[String(n)]) {
    delete st.decisions[String(n)];
    writeFileAtomic(REVIEW_STATE_PATH, JSON.stringify(st));
  }
  if (r.restored) {
    await sendTelegram(`#${n} is back in the pending list${r.recordRemoved ? ', and the record of that decision was removed' : ''}.`);
    await refreshList({ markSeen: true });
  } else if (r.recordRemoved) {
    await sendTelegram(`#${n}: the record of that decision was removed. The offer itself was not restored (already pending, or hidden by the cleanup rather than by you).`);
  } else {
    await sendTelegram(`Nothing to undo for #${n}: no decision of yours found on it.`);
  }
}

// ➤ "applied N" → record that you SENT the application: logged in data/applications.jsonl
// ➤ and the offer drops off pending (and won't come back even if reposted); "applied5"
// ➤ without a space also works. "longshot 729 I don't have the 3 years" is checked BEFORE
// ➤ "applied" so the two never race; the trailing text is the requirement you fall short
// ➤ of.
// ➤ "mail": where every application you sent stands — the twin of "list". It RE-READS THE
// ➤ INBOX FIRST, so it never answers with yesterday; if Gmail cannot be read right now the
// ➤ last report is shown with its date. The nightly run keeps the report fresh unasked;
// ➤ "status" still answers too, its first name.
async function mailCommand() {
  const { formatStatus } = await import('./argus-mail/report.mjs');
  const workingId = await sendTelegramMessage('Reading your inbox — this takes a minute.', { silent: true });
  const refreshed = await new Promise(resolve => {
    execFile(process.execPath, [join(SCRIPT_DIR, 'argus-mail', 'listen.mjs')],
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
  // ➤ ONE mail report in the chat, not a pile: each "mail" replaces the previous one, the
  // ➤ live list's discipline — send FIRST, delete after, so a failed send never leaves the
  // ➤ chat with no report; the previous ids ride in data/mail-message.json. CHUNKED like the
  // ➤ offers list: Telegram refuses anything over 4096 chars, and around 60 listed
  // ➤ applications a single send would fail every time, exactly when there is most to
  // ➤ report.
  const MAIL_MSG_PATH = join(ROOT, 'data', 'mail-message.json');
  const prev = loadJson(MAIL_MSG_PATH, null);
  const ids = [];
  for (const chunk of chunkLines(formatStatus(status) + esc(stale))) {
    const id = await sendTelegramMessage(chunk, { html: true });
    if (id != null) ids.push(id);
  }
  if (ids.length) {
    writeFileAtomic(MAIL_MSG_PATH, JSON.stringify({ message_ids: ids, ts: new Date().toISOString() }));
    // ➤ Older installs stored a single message_id; both shapes are honoured.
    const prevIds = prev?.message_ids || (prev?.message_id != null ? [prev.message_id] : []);
    for (const pid of prevIds) {
      if (!ids.includes(pid)) await deleteTelegramMessage(pid);
    }
  }
}

// ➤ THE COMMAND TABLE. One entry per command, tried top to bottom, first match
// ➤ wins — and the order is part of the meaning in two places: "longshot N"
// ➤ sits before "applied N" so the two can never race, and "no N" sits before
// ➤ the bare "no" that asks which offer you meant. Every command is
// ➤ case-insensitive and offer numbers are accepted with or without "#".
const COMMANDS = [
  // ➤ Every command is case-insensitive, and offer numbers are accepted with or without the
  // ➤ hash ("#412" or "412"). "help" (or "/help") → the list of commands.
  { match: /^\/?help$/i, run: async (t) => {
    await sendTelegram(HELP, { html: true });
  } },
  // ➤ "/start" → the one-time setup (CV + profile questions). "/start yes" confirms
  // ➤ replacing a profile you already have: the first question is "paste your CV", and from
  // ➤ then on ANY text you type is stored as an answer — so starting again by accident would
  // ➤ cost you the CV. "/start abc12345" is the installer's deep link (t.me/bot?start=CODE):
  // ➤ Telegram delivers the code as a payload, and it reads as a plain /start.
  { match: /^\/?start(\s+yes|\s+[a-z0-9]{6,12})?$/i, run: async (t) => {
    await startOnboarding(/\s+yes$/i.test(t));
  } },
  // ➤ "settings" → edit any profile answer later (menu with buttons).
  { match: /^\/?settings$/i, run: async (t) => {
    await startSettings();
  } },
  // ➤ Is the message "seen" followed by one or more numbers? → mark as seen.
  { match: /^seen(\s+#?\d+)+$/i, run: async (t) => {
    const ids = t.split(/\s+/).slice(1).map(s => s.replace(/^#/, ''));
    const out = await runNode('seen.mjs', ids);
    await sendTelegram(seenReply(ids, out));
    // ➤ The confirmation above stays; only the list refreshes (the previous one is
    // ➤ deleted and re-sent without those offers).
    await refreshList({ markSeen: true });
  } },
  // ➤ Is it "search" (or "scan")? → launch a full scan right now.
  { match: /^(search|scan)$/i, run: async (t) => {
    await forceScan();
  } },
  // ➤ Is it "cover 412" (or "cover #412")? → generate the cover-letter
  // ➤ PDF for that offer and send it here.
  { match: /^cover\s*#?\d+$/i, run: async (t) => {
    const n = parseInt(t.match(/(\d+)/)[1], 10);
    await coverCommand(n);
  } },
  // ➤ "list" → the pending offers grouped by country. Per-offer buttons ON THE LIST are
  // ➤ vetoed — under a 25-offer message no button can say which offer it belongs to; they
  // ➤ live on the review CARD, one offer per message. The list keeps only navigation and the
  // ➤ review entry.
  { match: /^list$/i, run: async (t) => {
    // ➤ "list" refreshes the live list: deletes the previous one and re-sends the pending
    // ➤ offers to the bottom of the chat (if there are none, it says "No pending offers"). AND
    // ➤ IT ANSWERS WHEN IT CANNOT: if the send failed or Telegram was not configured, silence
    // ➤ would leave you staring at a chat that ignored you, with no way to tell that from
    // ➤ "there is nothing new".
    const r = await refreshList({ markSeen: true });
    if (r === false) await sendTelegram('The list could not be sent just now. Try again in a moment.');
  } },
  // ➤ "review" → the pending offers one card at a time, with buttons. The
  // ➤ same flow the list's "Review one by one" button opens.
  { match: /^review$/i, run: async (t) => {
    await startReview();
  } },
  { match: /^undo(\s+#?\d+)?$/i, run: t => undoCommand(t) },
  { match: /^(mail|status)$/i, run: () => mailCommand() },
  { match: /^longshot[\s,:]*#?\d+/i, run: async (t) => {
    const m = t.match(/^longshot[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    await markApplied(parseInt(m[1], 10), { longshot: true, reason: m[2].trim() });
  } },
  { match: /^applied[\s,:]*#?\d+/i, run: async (t) => {
    const m = t.match(/^applied[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    const n = parseInt(m[1], 10);
    await markApplied(n);
    // ➤ "applied N" ignores anything typed after the number, and that silence once filed an
    // ➤ application-sent-in-hope as a normal one. It still is one — but say so, and point at
    // ➤ the command that keeps the nuance.
    if (m[2].trim()) {
      // ➤ WITH html:true, and the typed note escaped: this message is built out of <code> tags,
      // ➤ and without a parse mode they arrive as literal text mid-sentence.
      await sendTelegram(`Note: "${esc(m[2].trim())}" was not saved — <code>applied</code> only reads the number.\nIf you meant you fall short of it, use <code>longshot ${n} ${esc(m[2].trim())}</code> instead.`, { html: true });
    }
  } },
  // ➤ "interview 749 friday 9am" — an interview arranged where the inbox cannot see it: a
  // ➤ phone call, LinkedIn, or a Calendar event you created yourself (its invite mail comes
  // ➤ FROM you, and mail reading skips your own). The trailing text is an optional note,
  // ➤ kept with the record.
  { match: /^interview[\s,:]*#?\d+/i, run: async (t) => {
    const m = t.match(/^interview[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    const n = parseInt(m[1], 10);
    if (!(await recordApplicationState(n, 'interview', m[2].trim()))) {
      await sendTelegram(`No application with the number #${n}. <code>interview</code> works on applications you marked with <code>applied</code>.`, { html: true });
    }
  } },
  // ➤ Is it "no 3 reason..." (or stuck together "no3")? → reject the offer recording why.
  // ➤ The separator is optional: "no5" typed quickly must not fall through to the help text.
  { match: /^no[\s,:]*#?\d+/i, run: async (t) => {
    // ➤ Split the offer number from the reason text.
    const m = t.match(/^no[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
    const n = parseInt(m[1], 10);
    // ➤ Read the offer BEFORE the rejection removes it from the list: the
    // ➤ veto panel below needs its title, company and city.
    const off = pendingOffers().find(o => o.id === n);
    await rejectWithReason(n, m[2].trim());
    // ➤ EXPERIMENTAL: a typed "no" earns a one-tap veto panel built from what was just
    // ➤ rejected. Typed path only for now — the review cards keep their own rhythm.
    if (off) await sendVetoChips(off, vetoTapDeps());
  } },
  { match: /^vetoes$/i, run: async (t) => {
    await startVetoList(vetoTapDeps());
  } },
  // ➤ Does it start with "no" but WITHOUT a number ("No, needs 5 years...")?
  // ➤ → ask which one you mean, instead of dumping generic help.
  { match: /^no\b/i, run: async (t) => {
    await sendTelegram('Which one do you mean? Tell me the number shown next to the offer, e.g.:\nno #412 needs 10 years of experience');
  } },
];

// ➤ The listener's "brain": takes the text of one of your messages, finds the first
// ➤ command in the table that matches it and runs that one action. If nothing fits, it
// ➤ sends the help text.
async function handle(text) {
  const t = text.trim();
  console.log(`[${new Date().toISOString()}] cmd: ${t.slice(0, 100)}`);
  const cmd = COMMANDS.find(c => c.match.test(t));
  if (cmd) { await cmd.run(t); return; }
  // ➤ Nothing matched: send the help text with the available commands.
  await sendTelegram(HELP, { html: true });
}

// ➤ Main routine: asks Telegram for new messages since last time, handles them one by one
// ➤ ONLY from your chat, and records where the reading got to so nothing repeats after a
// ➤ cut. pollSeconds > 0 makes it a LONG POLL (Telegram holds the request open and answers
// ➤ the instant something arrives); 0 keeps the plain pass for --once, tests and the
// ➤ diagnose scripts. Returns how many updates the pass saw, so the loop can tell idle
// ➤ from busy. The two setup nags repeat on every pass; a person at a terminal needs them
// ➤ once, not every seven seconds.
let saidLinkPending = false;
let saidNotConfigured = false;
async function main({ pollSeconds = 0 } = {}) {
  // ➤ The cron log this run appends to must not grow for ever (Linux/mac; the
  // ➤ file does not exist on Windows, where output is discarded).
  trimLog(join(SCRIPT_DIR, 'listener.log'));
  const cfg = loadJson(CFG_PATH, null);
  // ➤ A token but no chat yet: FINISH THE LINK OURSELVES. Any listener polling this bot —
  // ➤ this one, or a survivor of an earlier install — CONSUMES the "hi" the setup console is
  // ➤ waiting for, and the console would wait for ever. The listener is the rightful owner
  // ➤ of getUpdates, so it completes the link itself; the console notices the chat_id
  // ➤ appearing in telegram.json and moves on.
  if (cfg?.bot_token && !cfg?.chat_id) {
    try {
      // ➤ The WHOLE backlog, not offset=-1: a negative offset returns only the newest update and
      // ➤ — per Telegram's own API doc — forgets every earlier one, so an owner who tapped START
      // ➤ and then typed anything before this tick would have the /start confirmed away, the bot
      // ➤ mute with nothing to show why. A plain getUpdates confirms nothing and hands back
      // ➤ everything pending.
      const res = await fetch(`${TG_API}/bot${cfg.bot_token}/getUpdates?timeout=0`,
        { signal: AbortSignal.timeout(15_000) });
      const j = await res.json().catch(() => null);
      const backlog = (j?.result || []).filter(u => u.message?.chat);
      if (!backlog.length) {
        if (process.stdout.isTTY && !saidLinkPending) {
          saidLinkPending = true;
          console.log('Almost there: telegram.json has a token but no chat_id. Send your bot any message and this links itself within seconds.');
        }
        return 0;
      }
      // ➤ When the installer wrote a link_code, only the /start carrying that code may bind the
      // ➤ chat — a stranger who stumbles on the bot before its owner taps START cannot claim it
      // ➤ (the random start-token idea follows Advanced Web Machinery's write-up,
      // ➤ advancedweb.hu). Without a code — the by-hand path — the first message binds, as
      // ➤ always.
      const binder = cfg.link_code
        ? backlog.find(u => String(u.message.text || '').trim() === `/start ${cfg.link_code}`)
        : backlog[0];
      if (!binder) return 0; // code set, tap not seen yet — leave the queue untouched
      cfg.chat_id = String(binder.message.chat.id);
      delete cfg.link_code;
      // ➤ Atomic like every other state file: a crash mid-write would leave invalid JSON in the
      // ➤ ONE file holding the token, and the bot would go mute until the setup is run again.
      writeFileAtomic(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
      // ➤ Position BEFORE the linking message, not after: this same tick then PROCESSES it.
      // ➤ Pressing START on the t.me link is one tap that links the chat AND begins the profile
      // ➤ questions — the /start must not be swallowed by the greeting.
      writeFileAtomic(OFFSET_PATH, JSON.stringify({ offset: binder.update_id }));
      await sendTelegram('Connected.');
      console.log(`chat_id ${cfg.chat_id} learned from the first message and saved.`);
      // ➤ No return: the normal flow below reads the offset just written and
      // ➤ handles the message that did the linking.
    } catch { return 0; /* no network: the next pass tries again */ }
  }
  // ➤ Not configured yet: nothing to do. Said only when a person ran it by hand — from the
  // ➤ schedule, stdout is not a terminal and silence is correct, or the log would gain one
  // ➤ identical line per pass for ever.
  if (!cfg?.bot_token || !cfg?.chat_id) {
    if (process.stdout.isTTY && !saidNotConfigured) {
      saidNotConfigured = true;
      console.log('Not set up yet: server-bot/telegram.json is missing its bot_token. Run the one-line installer from the README, or setup\\setup-windows.bat / bash setup/setup-linux-mac.sh');
    }
    return 0;
  }

  // ➤ Asks Telegram for the pending messages from the last one read, waiting at most 15
  // ➤ seconds. WHERE WE GOT TO LAST TIME is the one thing stopping a command running twice:
  // ➤ Telegram keeps 24 hours of messages, so "start from 0" means REPLAY A WHOLE DAY —
  // ➤ every `applied N`, `no N`, `cover N` since yesterday, again. So a missing or
  // ➤ unreadable file is NOT treated as zero: it resynchronises (latest update only,
  // ➤ position written, nothing run this tick). One tick's messages can be missed, which you
  // ➤ would notice and retype; a day of commands re-running is not something you could undo.
  const state = loadJson(OFFSET_PATH, null);
  if (!state || !Number.isInteger(state.offset)) {
    // ➤ fresh = the file never existed: the listener's very first run, not a
    // ➤ corruption of an established install.
    const fresh = !existsSync(OFFSET_PATH);
    const ok = await resyncOffset(cfg);
    // ➤ THE FIRST /start MUST NOT FALL IN A HOLE: a brand-new user types /start during the
    // ➤ setup, this first tick then synchronises PAST it — deliberately, replaying history is
    // ➤ worse — and would leave the user in front of a silent bot. Say the bot is alive and
    // ➤ what to type. Only on a virgin install (setup never completed), so an established bot
    // ➤ that loses its offset file does not greet its owner like a stranger.
    if (ok && fresh && !existsSync(join(ROOT, 'data', 'onboarding-answers.json'))) {
      await sendTelegram('Argus is listening now. Send /start to set up your profile.');
    }
    return 0;
  }
  // ➤ The long poll: with pollSeconds > 0 this fetch sits open until something arrives (or
  // ➤ the window closes empty) — Telegram's push channel, not lost time. The abort guard
  // ➤ stays 15 s PAST the window, so it only fires when the connection itself has died.
  const res = await fetch(
    `${TG_API}/bot${cfg.bot_token}/getUpdates?offset=${state.offset}&timeout=${pollSeconds}`,
    { signal: AbortSignal.timeout(pollSeconds * 1000 + 15_000) },
  );
  const j = await res.json().catch(() => null);
  // ➤ 409 means another process is consuming getUpdates RIGHT NOW (a second listener, or a
  // ➤ diagnose pass). Thrown, not swallowed: the loop counts it and walks away after a
  // ➤ streak, leaving the queue to the other consumer.
  if (!j?.ok) {
    if (j?.error_code === 409) throw new Error('409: another process is polling getUpdates');
    return 0;
  }

  // ➤ Iterate over each new message, in order of arrival.
  for (const u of j.result || []) {
    // ➤ ANOTHER RUN MAY HAVE TAKEN OVER. "search" and "mail" hold this loop for minutes; on
    // ➤ installs without a lock (macOS ships no flock) the next minute's run reads the
    // ➤ advanced offset and handles the rest of the batch — so this run must not resume from
    // ➤ its stale in-memory array and execute those same commands a second time. The offset
    // ➤ file on disk is the single truth of what is already done.
    const disk = loadJson(OFFSET_PATH, null);
    if (disk && Number.isInteger(disk.offset) && disk.offset > u.update_id) continue;
    // ➤ Save progress BEFORE running the command: if the program
    // ➤ crashed midway, on restart it wouldn't repeat commands already done.
    state.offset = u.update_id + 1;
    // ➤ Persisted BEFORE handling, so a crash cannot replay the command — and written
    // ➤ aside-then-renamed, so a crash cannot leave this file half written either: this is the
    // ➤ one file whose corruption replays a day of commands rather than losing one.
    writeFileAtomic(OFFSET_PATH, JSON.stringify(state));
    // ➤ Button taps (onboarding / settings) arrive as callback_query, not as a
    // ➤ message. Route them to the onboarding handler.
    const cb = u.callback_query;
    if (cb) {
      if (String(cb.message?.chat?.id) !== String(cfg.chat_id)) continue; // your chat only
      try {
        // ➤ Review-card taps first, page turns second, everything else to the onboarding. Each
        // ➤ handler answers false only for data that is not its own, so the chain never eats a
        // ➤ foreign tap.
        if (await handleVetoCallback(cb.data, cb.message?.message_id, cb.id, vetoTapDeps())) continue;
        if (await handleReviewCallback(cb.data, cb.message?.message_id, cb.id, reviewDeps())) continue;
        if (await flipListPage(cb.data, cb.message?.message_id, cb.id)) continue;
        await handleOnboardingCallback(cb.data, cb.id, cb.message?.message_id);
      }
      catch (e) { try { await sendTelegram(`Error: ${String(e.message).slice(0, 200)}`); } catch { /* Telegram unreachable: nothing left to tell */ } }
      continue;
    }
    const msg = u.message;
    if (!msg) continue;
    // ➤ Security: ignore any message that doesn't come from YOUR chat.
    if (String(msg.chat?.id) !== String(cfg.chat_id)) continue; // the user's chat only
    // ➤ If a command fails, you're notified via Telegram instead of dying silently.
    try {
      // ➤ A FILE while the setup waits for the CV: people send the PDF they already have, not
      // ➤ pasted text. Only the CV question eats documents; everything else needs text.
      if (msg.document && onboardingActive() && await handleOnboardingDocument(msg.document)) continue;
      if (!msg.text) continue;
      // ➤ While setup/settings is waiting for a typed answer, the text goes
      // ➤ there; otherwise it's a normal command.
      if (onboardingActive() && await handleOnboardingText(msg.text)) continue;
      await handle(msg.text);
    } catch (e) {
      try { await sendTelegram(`Error: ${String(e.message).slice(0, 200)}`); } catch { /* Telegram unreachable: nothing left to tell */ }
    }
  }
  return (j.result || []).length;
}

// ➤ The always-on loop. One pass per long poll; between passes it checks the
// ➤ three reasons to bow out, each of which the watchdog schedule repairs
// ➤ within a minute by starting a fresh listener:
// ➤   - its own file changed on disk (an update landed: restart into new code);
// ➤   - ten passes failed in a row (network gone, or a 409 poll war: stop
// ➤     fighting and come back clean);
// ➤   - six hours old and the cycle was idle (bounds any slow leak, and an
// ➤     idle moment means nothing in hand to drop).
// ➤ A heartbeat timer stamps listener-alive.json every 30s EVEN MID-PASS — a
// ➤ "search" holds a pass for minutes, and a beat written only between passes
// ➤ would look dead to the watchdog, which would then start a second poller.
async function runForever() {
  if (!claimListenerSlot(process.pid)) {
    // ➤ Only a person at a terminal hears this; from the schedule, yielding in
    // ➤ silence is the normal case on machines without flock (macOS, Windows).
    if (process.stdout.isTTY) console.log('Another listener is already running; this one yields to it.');
    return;
  }
  const selfPath = fileURLToPath(import.meta.url);
  const bornMtime = (() => { try { return statSync(selfPath).mtimeMs; } catch { return 0; } })();
  const born = Date.now();
  console.log(`[${new Date().toISOString()}] listener up (pid ${process.pid}): long-polling Telegram, ${POLL_SECONDS}s a cycle.`);
  const heartbeat = setInterval(() => {
    if (!claimListenerSlot(process.pid)) {
      console.log(`[${new Date().toISOString()}] another listener took the slot; this one exits.`);
      process.exit(0);
    }
  }, HEARTBEAT_MS);
  // ➤ unref: the timer must never be what keeps a finished process alive.
  heartbeat.unref();
  let failures = 0;
  for (;;) {
    const passStart = Date.now();
    let handled = 0;
    try {
      handled = await main({ pollSeconds: POLL_SECONDS });
      failures = 0;
    } catch (e) {
      failures += 1;
      console.log(`[${new Date().toISOString()}] listener pass failed (${failures} in a row): ${String(e?.message).slice(0, 200)}`);
      if (failures >= 10) {
        console.log(`[${new Date().toISOString()}] giving up after ${failures} failed passes; the schedule restarts a fresh listener within a minute.`);
        return;
      }
    }
    let mtime = bornMtime;
    try { mtime = statSync(selfPath).mtimeMs; } catch { /* transient stat error: not an update */ }
    if (mtime !== bornMtime) {
      console.log(`[${new Date().toISOString()}] listener code changed on disk; exiting so the schedule starts the new version.`);
      return;
    }
    if (Date.now() - born >= RECYCLE_MS && handled === 0) {
      console.log(`[${new Date().toISOString()}] routine recycle after ${Math.round((Date.now() - born) / 3600_000)}h; the schedule restarts it.`);
      return;
    }
    // ➤ Pace the fast-return paths (not configured, no network, 409): without a long poll to
    // ➤ sit in, the loop would spin. Five seconds keeps the setup flow snappy without
    // ➤ hammering anything.
    if (Date.now() - passStart < 2000) await new Promise(r => setTimeout(r, 5000));
  }
}

// ➤ Startup: `--once` keeps the single pass (tests, diagnose scripts, anything that must
// ➤ not stay resident); otherwise the always-on loop. If something blows up it exits
// ➤ quietly — the watchdog launches a fresh one within a minute. ONLY WHEN THIS FILE IS
// ➤ THE PROGRAM BEING RUN: polling on import would make a test that merely reads a
// ➤ function out of it poll Telegram with the real token and execute whatever commands
// ➤ were waiting.
if (process.argv[1] && /(^|[\\/])telegram-listener\.mjs$/.test(process.argv[1])) {
  if (process.argv.includes('--once')) main().catch(() => process.exit(0));
  else runForever().catch(() => process.exit(0));
}
