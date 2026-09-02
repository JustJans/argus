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

// ➤ Drop-in for writeFileSync. `io` exists only so a test can watch what this does rather
// ➤ than what it leaves behind: a plain writeFileSync passes any test that only checks the
// ➤ final content.
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
// ➤ The atomic write above stops a reader seeing half a file. It does NOT stop two jobs
// ➤ reading the same list, each adding its change, and the second writer erasing the first
// ➤ (eight writers at once kept 200 of 1,600 lines) — and the scanner, housekeep and the
// ➤ listener all share one pending list.
// ➤ A DIRECTORY IS THE LOCK: mkdir either creates it or fails, atomically, on every
// ➤ filesystem, and it is held for the milliseconds of read-and-write, never for the
// ➤ minutes a job spends on HTTP. IT ALWAYS PROCEEDS: past the timeout the holder is
// ➤ presumed dead and the lock taken, because a race that loses one line is a smaller harm
// ➤ than a job that quietly does nothing. The limit: clearing an abandoned lock can itself
// ➤ race — only once it has sat untouched past the stale age, which means a job already
// ➤ died mid-write.
// ➤ sleepSync: Atomics.wait pauses without a callback and without burning a core, so the
// ➤ callers stay synchronous.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

export const LOCK_TIMEOUT_MS = 5000;

// ➤ `staleMs`: the age at which a lock is presumed to belong to a dead job. It defaults to
// ➤ the timeout but is its own knob: a test that shortens the WAIT to 60 ms must not also
// ➤ declare a 61 ms-old live lock dead and walk in.
export function withFileLock(path, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = timeoutMs, io = { mkdirSync, rmdirSync, statSync }, log = console.log } = {}) {
  const lock = `${path}.lock`;
  const started = Date.now();
  let held = false;
  while (Date.now() - started < timeoutMs) {
    try { io.mkdirSync(lock); held = true; break; } catch (err) {
      // ➤ Give up AT ONCE only when the path can never work (no such folder): waiting out the
      // ➤ timeout would stall every write for nothing, and the write itself reports the real
      // ➤ problem a moment later. EVERY OTHER ERROR IS CONTENTION AND IS RETRIED: on Windows a
      // ➤ mkdir colliding with somebody else's release comes back EPERM, not EEXIST.
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') break;
    }
    // ➤ A lock older than the timeout belonged to a job that died: clear it. A lock dated in
    // ➤ the FUTURE is abandoned too — a live one is milliseconds old, so a future stamp can
    // ➤ only be a clock that jumped, and left alone it would make every writer burn the
    // ➤ timeout and run unlocked for ever.
    try {
      const age = Date.now() - io.statSync(lock).mtimeMs;
      if (age > staleMs || age < -staleMs) { io.rmdirSync(lock); continue; }
    } catch { /* it vanished: try again */ }
    sleepSync(15);
  }
  // ➤ RUNNING UNLOCKED IS WORTH A LINE: going ahead is the right call, but done in silence a
  // ➤ read-only data folder or a lock nobody can clear degrades every write from every job
  // ➤ for ever with nothing to show for it. A real hold lasts milliseconds, so this line
  // ➤ should never appear.
  if (!held) log(`[${new Date().toISOString()}] lock on ${path} could not be taken in ${timeoutMs}ms; going ahead without it.`);
  try {
    return fn();
  } finally {
    if (held) { try { io.rmdirSync(lock); } catch { /* already gone */ } }
  }
}
