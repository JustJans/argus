#!/usr/bin/env node

/**
 * seen.mjs — the "seen" command. Replying "seen 412" on Telegram ends up here.
 * It flips "- [ ]" to "- [x]" on that offer's line in data/pipeline.md, so it
 * leaves the list but stays on record and is never proposed again.
 *
 *   node server-bot/seen.mjs 3        # one
 *   node server-bot/seen.mjs 3 5 7    # several at once
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
// ➤ Atomic overwrite so a crash mid-write can't truncate the pending list.
import { writeFileAtomic } from './fs-atomic.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

// ➤ These are the FIXED offer numbers (#412 as shown on Telegram), never a
// ➤ position in the list, so the wrong one can't be marked. De-duplicated
// ➤ (audit 2026-07-25): "seen 701 701" appended "| visto" twice and broke the
// ➤ "#id at end of line" shape the id counter and the parsers rely on.
const nums = [...new Set(process.argv.slice(2).map(s => Number(String(s).replace(/^#/, ''))).filter(n => Number.isInteger(n) && n > 0))];
if (nums.length === 0) {
  console.error('Usage: seen <id> [id...]   (the # number shown in the list, e.g. seen 412)');
  process.exit(1);
}

if (!existsSync(PIPELINE_PATH)) {
  console.error('pipeline.md not found');
  process.exit(1);
}

const text = readFileSync(PIPELINE_PATH, 'utf-8');
const lines = text.split('\n');

// ➤ Index of offer number -> line, built ONLY from the "## Pending" section
// ➤ and only from lines still unchecked ("- [ ] ").
let inPending = false;
const byId = new Map();
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('## Pending')) { inPending = true; continue; }
  if (lines[i].startsWith('## ') && inPending) { inPending = false; }
  if (!inPending || !/^- \[ \] /.test(lines[i])) continue;
  const m = lines[i].match(/\|\s*#(\d+)\s*$/);
  if (m) byId.set(parseInt(m[1], 10), i);
}

if (byId.size === 0) {
  console.log('No pending offers to mark.');
  process.exit(0);
}

const marked = [];
for (const n of nums) {
  const idx = byId.get(n);
  if (idx === undefined) { console.log(`#${n} is not in pending (did you already remove it?)`); continue; }
  // ➤ The "| visto" tag marks it as YOUR decision: the scanner then keeps it out
  // ➤ even if the company reposts it under a new link. Offers the bot hides on
  // ➤ its own (dead link, cleanup) carry no tag, so those CAN come back.
  lines[idx] = lines[idx].replace('- [ ] ', '- [x] ') + ' | visto';
  const label = lines[idx].split('|').slice(1, 3).join(' —').trim();
  marked.push(`#${n} ${label}`);
}

writeFileAtomic(PIPELINE_PATH, lines.join('\n'));
if (marked.length) {
  console.log('Marked as seen:');
  for (const m of marked) console.log('  ✓ ' + m);
}
