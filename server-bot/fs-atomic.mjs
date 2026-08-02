// ➤ Safe overwrite for the files holding the ONLY copy of something — the
// ➤ pending list and the judges' journal. writeFileSync killed halfway leaves
// ➤ them truncated; writing aside and renaming does not, a rename being atomic.

import { writeFileSync, renameSync, mkdirSync, rmdirSync, statSync, unlinkSync } from 'fs';
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
export function writeFileAtomic(path, data, encoding = 'utf-8', io = { writeFileSync, renameSync, unlinkSync }) {
  const tmp = tempNameFor(path);
  try {
    io.writeFileSync(tmp, data, encoding);
    io.renameSync(tmp, path);
  } catch (err) {
    // ➤ SWEEP UP THE SCRATCH FILE WHEN THE WRITE FAILS (audit 2026-07-31). Your
    // ➤ real file is safe whatever happens — that is the whole point of writing
    // ➤ aside first — but until now a failed write abandoned its scratch file,
    // ➤ and nothing anywhere in the project ever deleted one. Provoked in
    // ➤ testing: three kills between the write and the rename left three orphans
    // ➤ sitting in the data folder; a full disk left one behind per attempt. So
    // ➤ the litter piled up hardest exactly when the disk was already full.
    // ➤ The error is re-thrown untouched: tidying up must not hide the failure
    // ➤ from the caller.
    try { (io.unlinkSync || unlinkSync)(tmp); } catch { /* never got created, or already gone */ }
    throw err;
  }
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
// ➤ A real pause inside synchronous code. This used to be a spin loop, which
// ➤ burns a whole core: harmless for the milliseconds of normal contention, but
// ➤ a permanent failure (a read-only data folder, a full disk) meant five
// ➤ seconds at 100% CPU on EVERY write, from every job, for as long as the
// ➤ machine stayed broken. Atomics.wait sleeps without a callback, so the four
// ➤ callers stay synchronous.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

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
    // ➤ A lock dated in the FUTURE is abandoned too: a live one is milliseconds
    // ➤ old, so a future stamp can only be a clock that jumped. Without this it
    // ➤ is never reaped, and every writer then burns the whole timeout and runs
    // ➤ unlocked — for ever, and there the writes do succeed.
    try {
      const age = Date.now() - io.statSync(lock).mtimeMs;
      if (age > timeoutMs || age < -timeoutMs) { io.rmdirSync(lock); continue; }
    } catch { /* it vanished: try again */ }
    sleepSync(15);
  }
  try {
    return fn();
  } finally {
    if (held) { try { io.rmdirSync(lock); } catch { /* already gone */ } }
  }
}
