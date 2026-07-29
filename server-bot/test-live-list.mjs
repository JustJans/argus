#!/usr/bin/env node
// ➤ Tests for the "live list": they check the pure part (remembering and reading the ids
// ➤ of the list messages), without touching Telegram. They use a temporary file.

import { loadListIds, saveListIds, loadSeenIds, saveSeenIds } from './live-list.mjs';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };

const p = join(tmpdir(), `argus-live-list-test-${process.pid}.json`);

// ➤ Saving and reading back returns the same ids.
saveListIds([10, 20, 30], p);
check('round-trip preserves the ids', JSON.stringify(loadListIds(p)) === JSON.stringify([10, 20, 30]));

// ➤ File with garbage → empty list (does not break).
writeFileSync(p, 'this is not json', 'utf-8');
check('corrupt file → []', loadListIds(p).length === 0);

// ➤ The field is not an array → empty list.
writeFileSync(p, JSON.stringify({ message_ids: 'nope' }), 'utf-8');
check('message_ids non-array → []', loadListIds(p).length === 0);

// ➤ File that does not exist → empty list.
check('nonexistent file → []', loadListIds(join(tmpdir(), `argus-nope-${process.pid}.json`)).length === 0);

// ➤ Save an empty list and read back → empty.
saveListIds([], p);
check('save empty → []', loadListIds(p).length === 0);

// ➤ Seen-ids (used to mark offers as [NEW]): round-trip, and null when NEVER
// ➤ set (first run, baseline) vs [] when explicitly empty.
const sp = join(tmpdir(), `argus-seen-test-${process.pid}.json`);
saveSeenIds([1, 2, 3], sp);
check('seen round-trip', JSON.stringify(loadSeenIds(sp)) === JSON.stringify([1, 2, 3]));
check('seen never-set → null', loadSeenIds(join(tmpdir(), `argus-seen-none-${process.pid}.json`)) === null);
writeFileSync(sp, 'garbage', 'utf-8');
check('seen corrupt → null', loadSeenIds(sp) === null);
saveSeenIds([], sp);
check('seen save empty → [] (not null)', Array.isArray(loadSeenIds(sp)) && loadSeenIds(sp).length === 0);

try { rmSync(p); } catch { /* best-effort cleanup */ }
try { rmSync(sp); } catch { /* best-effort cleanup */ }

if (fail === 0) console.log(`All ${pass} live-list tests passed.`);
else { console.log(`${fail} live-list test(s) FAILED`); process.exit(1); }
