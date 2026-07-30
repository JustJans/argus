// ➤ Safe overwrite for the files holding the ONLY copy of something — the
// ➤ pending list and the judges' journal. writeFileSync killed halfway leaves
// ➤ them truncated; writing aside and renaming does not, a rename being atomic.

import { writeFileSync, renameSync } from 'fs';
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
