#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the pending offers, for the terminal. Reads data/pipeline.md (where the
// ➤ scanner stores what it found) and shows what is still under "Pending": stable number,
// ➤ company, title, location and link. That number (#N) is the one Telegram shows and the
// ➤ one you use in "seen N" or "no N". Run by hand to review the list; the other scripts
// ➤ reuse its offer-reading function.
// ➤ ═══════════════════════════════════════════════════════════════════

/**
 * list-offers.mjs — OFFERS panel (plain-text list for the terminal).
 * The number is what you pass to `seen N` to remove an offer.
 * Pipeline line format: - [ ] url | company | title [| location]
 */

import { readFileSync, existsSync } from 'fs';
// ➤ The two headings that divide the file, asked for in one place so all four
// ➤ readers agree instead of each spelling them out for itself.
import { pendingIndex, isProcessedHeading } from './pipeline-format.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ➤ Figures out which folder this script is in to locate data/pipeline.md,
// ➤ so it works no matter where the command is run from.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

// ➤ Main function: reads pipeline.md and returns the list of pending offers.
// ➤ Each offer comes with its link, company, title, location and stable number (#N).
export function pendingOffers() {
  // ➤ If the offers file doesn't exist yet, there's nothing to list.
  if (!existsSync(PIPELINE_PATH)) return [];
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const pendIdx = pendingIndex(text);
  if (pendIdx === -1) return [];
  // ➤ Keeps only the chunk between the pending heading and the processed one:
  // ➤ what has already been dealt with is not shown.
  const lines = text.split('\n');
  const procLine = lines.findIndex(l => isProcessedHeading(l));
  const procIdx = procLine === -1 ? -1 : text.indexOf(lines[procLine]);
  const section = text.slice(pendIdx, procIdx === -1 ? text.length : procIdx);
  const offers = [];
  // ➤ Walks the format "- [ ] link | company | title | [location] | [y:years] | [s:salary] |
  // ➤ [#number]": it splits on the bars and CLASSIFIES each extra field by its shape, so an
  // ➤ offer without a location cannot show "y:2" as if it were the city.
  for (const m of section.matchAll(/^- \[ \] (\S+)\s*\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)((?:\s*\|[^\n]*)?)$/gm)) {
    const offer = { url: m[1], company: m[2].trim(), title: m[3].trim(), location: '', id: null, years: null, salary: null };
    // ➤ The remaining fields (if any), one by one: #number, y:years,
    // ➤ s:salary... and whatever is none of those is the location.
    for (const raw of (m[4] || '').split('|')) {
      const f = raw.trim();
      if (!f) continue;
      if (/^#\d+$/.test(f)) offer.id = parseInt(f.slice(1), 10);
      else if (/^y:\d+$/.test(f)) offer.years = parseInt(f.slice(2), 10);
      else if (/^s:/.test(f)) offer.salary = f.slice(2).trim() || null;
      else if (!offer.location) offer.location = f;
    }
    offers.push(offer);
  }
  return offers;
}

// ➤ Only when this file is launched directly from the terminal: prints each offer with its
// ➤ number, company, title and link, or says none are left.
if (process.argv[1] && /(^|[\\/])list-offers\.mjs$/.test(process.argv[1])) {
  const offers = pendingOffers();
  if (offers.length === 0) {
    console.log('No pending offers. Run a scan.');
  } else {
    for (const o of offers) {
      const loc = o.location ? `  [${o.location}]` : '';
      console.log(`#${o.id ?? '?'}  ${o.company} — ${o.title}${loc}`);
      console.log(`    ${o.url}`);
    }
  }
}
