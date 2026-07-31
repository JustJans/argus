// ➤ Safe overwrite for the files holding the ONLY copy of something — the
// ➤ pending list and the judges' journal. writeFileSync killed halfway leaves
// ➤ them truncated; writing aside and renaming does not, a rename being atomic.

import { writeFileSync, renameSync, mkdirSync, rmdirSync, statSync } from 'fs';
import { randomBytes } from 'crypto';

// ➤ The scratch name to write to before renaming. UNIQUE per write (audit
// ➤ 2026-07-25): with a fixed ".tmp" the 07:30 housekeep and a seen.mjs fired
// ➤ from Telegram shared one scratch file and could rename a mixture of both
// ➤ into place. It sits NEXT TO the target on purpose — a rename is only
// ➤ atomic within one filesystem, so a temp file in /tmp would silently
// ➤ degrade into a copy on a machine where /tmp is its own mount.
export function tempNameFor(path) {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

// ➤ Drop-in for writeFileSync.
// ➤ `io` exists only so a test can watch what this does rather than only what
// ➤ it leaves behind: a plain writeFileSync to the target passes any test that
// ➤ checks the final content, which is exactly how a rewrite could quietly
// ➤ remove the protection this file exists to give.
export function writeFileAtomic(path, data, encoding = 'utf-8', io = { writeFileSync, renameSync }) {
  const tmp = tempNameFor(path);
  io.writeFileSync(tmp, data, encoding);
  io.renameSync(tmp, path);
}

// ➤ ── READ, DECIDE, WRITE — WITHOUT LOSING SOMEBODY ELSE'S WORK ───────────
// ➤ The atomic write above stops a reader ever seeing half a file. It does
// ➤ NOT stop this: two jobs read the same list, each adds its own change, and
// ➤ the second one to write erases the first. Measured on the real writer,
// ➤ eight writers going at once kept 200 of 1600 lines.
// ➤
// ➤ THAT IS NOT THEORETICAL HERE. Several scheduled jobs share one pending
// ➤ list: the scanner appends every two hours, housekeep deletes twice a day,
// ➤ the Telegram listener rewrites it every time you mark an offer — every
// ➤ minute, so it can land in the middle of either. Their cron locks are all
// ➤ DIFFERENT, which only stops a job overlapping itself.
// ➤
// ➤ A DIRECTORY IS THE LOCK. mkdir either creates it or fails, in one step,
// ➤ on every filesystem — no flag, no library, and nothing left running. It is
// ➤ held for the milliseconds of the read-and-write, never for the minutes a
// ➤ job spends on HTTP.
// ➤ IT ALWAYS PROCEEDS RATHER THAN GIVING UP: after the timeout it assumes the
// ➤ holder died and takes the lock. Refusing instead would mean silently
// ➤ dropping an offer or ignoring a decision, and a race that loses one line is
// ➤ a smaller harm than a job that quietly does nothing.
// ➤ THE LIMIT OF THAT CHOICE, stated plainly: clearing an abandoned lock can
// ➤ itself race, so two jobs could both get in — but only once a lock has sat
// ➤ untouched for five seconds, which means a job was already killed mid-write.
// ➤ A real hold lasts milliseconds, so in normal running it cannot arise.
export const LOCK_TIMEOUT_MS = 5000;

export function withFileLock(path, fn, { timeoutMs = LOCK_TIMEOUT_MS, io = { mkdirSync, rmdirSync, statSync } } = {}) {
  const lock = `${path}.lock`;
  const started = Date.now();
  let held = false;
  while (Date.now() - started < timeoutMs) {
    try { io.mkdirSync(lock); held = true; break; } catch (err) {
      // ➤ Give up AT ONCE only when this path can never work — there is no such
      // ➤ folder. Waiting out the full timeout there would stall every write by
      // ➤ five seconds for nothing, and the write itself reports the real
      // ➤ problem a moment later.
      // ➤ EVERY OTHER ERROR IS TREATED AS CONTENTION AND RETRIED. The first
      // ➤ version only retried on "already exists", and the six-process test
      // ➤ caught it losing 15 lines of 150: on Windows a mkdir that collides
      // ➤ with somebody else's release comes back EPERM, not EEXIST, and that
      // ➤ writer walked straight in without the lock.
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') break;
    }
    // ➤ A lock older than the timeout belonged to a job that died. Clear it.
    try {
      const age = Date.now() - io.statSync(lock).mtimeMs;
      if (age > timeoutMs) { io.rmdirSync(lock); continue; }
    } catch { /* it vanished: try again */ }
    // ➤ Busy-wait on purpose: this is a synchronous path, the wait is
    // ➤ milliseconds, and making it async would mean rewriting four callers.
    const until = Date.now() + 15;
    while (Date.now() < until) { /* spin */ }
  }
  try {
    return fn();
  } finally {
    if (held) { try { io.rmdirSync(lock); } catch { /* already gone */ } }
  }
}
