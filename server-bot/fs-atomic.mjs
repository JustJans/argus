// ➤ Safe overwrite for the files holding the ONLY copy of something — the
// ➤ pending list and the judges' journal. writeFileSync killed halfway leaves
// ➤ them truncated; writing aside and renaming does not, a rename being atomic.

import { writeFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';

// ➤ Drop-in for writeFileSync. UNIQUE temp name per write (audit 2026-07-25):
// ➤ with a fixed ".tmp" the 07:30 housekeep and a seen.mjs fired from Telegram
// ➤ shared one scratch file and could rename a mixture of both into place.
export function writeFileAtomic(path, data, encoding = 'utf-8') {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, encoding);
  renameSync(tmp, path);
}
