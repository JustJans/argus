// ➤ Safe overwrite for the files holding the ONLY copy of something — the
// ➤ pending list and the judges' journal. writeFileSync killed halfway leaves
// ➤ them truncated; writing aside and renaming does not, a rename being atomic.

import { writeFileSync, renameSync, mkdirSync, rmdirSync, statSync, unlinkSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';

// ➤ Keeps a cron log from growing for ever: the Linux/mac schedule appends listener.log
// ➤ and scan.log on every run. Called by the writer itself at startup — the shell keeps
// ➤ the file open with O_APPEND, so a truncation here never corrupts its writes; they
// ➤ continue at the new end. Over the cap, the newest tail is kept.
export function trimLog(path, maxBytes = 5 * 1024 * 1024, keepBytes = 1024 * 1024) {
  try {
    if (statSync(path).size <= maxBytes) return;
    const tail = readFileSync(path).subarray(-keepBytes);
    writeFileSync(path, tail);
  } catch { /* no log yet, or unreadable — nothing to trim */ }
}

// ➤ The scratch name to write to before renaming. UNIQUE per write, so two jobs writing
// ➤ the same target never share a scratch file. It sits NEXT TO the target on purpose — a
// ➤ rename is only atomic within one filesystem, so a temp file in /tmp would silently
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
    // ➤ SWEEP UP THE SCRATCH FILE WHEN THE WRITE FAILS. The real file is safe whatever happens
    // ➤ — that is the point of writing aside first — but an abandoned scratch file is litter
    // ➤ that piles up hardest exactly when the disk is already full. The error is re-thrown
    // ➤ untouched: tidying up must not hide the failure from the caller.
    try { (io.unlinkSync || unlinkSync)(tmp); } catch { /* never got created, or already gone */ }
    throw err;
  }
}

// ➤ ── READ, DECIDE, WRITE — WITHOUT LOSING SOMEBODY ELSE'S WORK ───────────
// ➤ The atomic write above stops a reader ever seeing half a file. It does NOT stop this:
// ➤ two jobs read the same list, each adds its own change, and the second one to write
// ➤ erases the first (eight writers at once kept 200 of 1,600 lines). That is real here:
// ➤ the scanner, housekeep and the Telegram listener all share one pending list, and their
// ➤ cron locks only stop a job overlapping itself.
// ➤ A DIRECTORY IS THE LOCK: mkdir either creates it or fails, in one step, on every
// ➤ filesystem — no flag, no library, nothing left running — and it is held for the
// ➤ milliseconds of the read-and-write, never for the minutes a job spends on HTTP. IT
// ➤ ALWAYS PROCEEDS RATHER THAN GIVING UP: after the timeout it assumes the holder died
// ➤ and takes the lock; refusing would mean silently dropping an offer or ignoring a
// ➤ decision, and a race that loses one line is a smaller harm than a job that quietly
// ➤ does nothing. THE LIMIT OF THAT CHOICE: clearing an abandoned lock can itself race, so
// ➤ two jobs could both get in — but only once a lock has sat untouched past the stale
// ➤ age, which means a job was already killed mid-write.
// ➤ A real pause inside synchronous code: Atomics.wait sleeps without a callback and
// ➤ without burning a core, so the callers stay synchronous.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

export const LOCK_TIMEOUT_MS = 5000;

// ➤ `staleMs` is the age at which a lock is presumed to belong to a dead job.
// ➤ It defaults to the timeout, as it always did, but is its own knob: a test
// ➤ that shortens the WAIT to 60ms must not also declare a 61ms-old live lock
// ➤ dead, reap it and walk in — which is exactly what made the "runs unlocked
// ➤ and says so" test flicker with the load on the machine.
export function withFileLock(path, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = timeoutMs, io = { mkdirSync, rmdirSync, statSync }, log = console.log } = {}) {
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
      if (age > staleMs || age < -staleMs) { io.rmdirSync(lock); continue; }
    } catch { /* it vanished: try again */ }
    sleepSync(15);
  }
  // ➤ RUNNING UNLOCKED IS WORTH A LINE. Going ahead anyway is the right call —
  // ➤ see above — but doing it in silence means a data folder that has gone
  // ➤ read-only, or a lock nobody can clear, degrades every write from every job
  // ➤ for ever with nothing to show for it. A real hold lasts milliseconds, so
  // ➤ this line should never appear; if it does, it is the only warning there is.
  if (!held) log(`[${new Date().toISOString()}] lock on ${path} could not be taken in ${timeoutMs}ms; going ahead without it.`);
  try {
    return fn();
  } finally {
    if (held) { try { io.rmdirSync(lock); } catch { /* already gone */ } }
  }
}
