#!/usr/bin/env node

/**
 * seen.mjs — the "seen" command. Replying "seen 412" on Telegram ends up here.
 * It flips "- [ ]" to "- [x]" on that offer's line in data/pipeline.md, so it
 * leaves the list but stays on record and is never proposed again.
 *
 *   node server-bot/seen.mjs 3        # one
 *   node server-bot/seen.mjs 3 5 7    # several at once
 */

import { readFileSync, existsSync } from 'fs';
// ➤ Atomic overwrite so a crash mid-write can't truncate the pending list.
import { writeFileAtomic } from './fs-atomic.mjs';
import { isPendingHeading } from './pipeline-format.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

// ➤ These are the FIXED offer numbers (#412 as shown on Telegram), never a
// ➤ position in the list, so the wrong one can't be marked. De-duplicated
// ➤ (audit 2026-07-25): "seen 701 701" appended "| visto" twice and broke the
// ➤ "#id at end of line" shape the id counter and the parsers rely on.
export function parseIds(argv) {
  return [...new Set(argv.map(s => Number(String(s).replace(/^#/, ''))).filter(n => Number.isInteger(n) && n > 0))];
}

// ➤ Index of offer number -> line, built ONLY from the pending section
// ➤ and only from lines still unchecked ("- [ ] ").
export function indexPending(lines) {
  let inPending = false;
  const byId = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (isPendingHeading(lines[i])) { inPending = true; continue; }
    if (lines[i].startsWith('## ') && inPending) { inPending = false; }
    if (!inPending || !/^- \[ \] /.test(lines[i])) continue;
    const m = lines[i].match(/\|\s*#(\d+)\s*$/);
    if (m) byId.set(parseInt(m[1], 10), i);
  }
  return byId;
}

// ➤ The marking itself, kept pure so it can be tested: this writes to the ONLY
// ➤ copy of your pending list and marks it by the FIXED offer number, so an
// ➤ off-by-one here would file the wrong job away without saying so.
// ➤ Returns the new lines plus what to report; it never touches disk.
export function markSeenInLines(lines, nums) {
  const out = [...lines];
  const byId = indexPending(out);
  const marked = [], missing = [];
  for (const n of nums) {
    const idx = byId.get(n);
    if (idx === undefined) { missing.push(n); continue; }
    // ➤ The "| visto" tag marks it as YOUR decision: the scanner then keeps it
    // ➤ out even if the company reposts it under a new link. Offers the bot
    // ➤ hides on its own (dead link, cleanup) carry no tag, so those CAN come
    // ➤ back. Dropping the tag would silently undo that promise.
    out[idx] = out[idx].replace('- [ ] ', '- [x] ') + ' | visto';
    const label = out[idx].split('|').slice(1, 3).join(' —').trim();
    marked.push(`#${n} ${label}`);
  }
  return { lines: out, marked, missing, hadPending: byId.size > 0 };
}

// ➤ From here down it is only the command-line wrapper: read, call the above,
// ➤ write, report. Skipped when this file is imported by a test.
if (process.argv[1] && /(^|[\\/])seen\.mjs$/.test(process.argv[1])) {
  const nums = parseIds(process.argv.slice(2));
  if (nums.length === 0) {
    console.error('Usage: seen <id> [id...]   (the # number shown in the list, e.g. seen 412)');
    process.exit(1);
  }
  if (!existsSync(PIPELINE_PATH)) {
    console.error('pipeline.md not found');
    process.exit(1);
  }
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const res = markSeenInLines(text.split('\n'), nums);

  if (!res.hadPending) {
    console.log('No pending offers to mark.');
    process.exit(0);
  }
  for (const n of res.missing) console.log(`#${n} is not in pending (did you already remove it?)`);

  writeFileAtomic(PIPELINE_PATH, res.lines.join('\n'));
  if (res.marked.length) {
    console.log('Marked as seen:');
    for (const m of res.marked) console.log('  ✓ ' + m);
  }
}
