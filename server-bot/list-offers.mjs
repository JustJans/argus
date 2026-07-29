#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the list of pending offers, to view it in the terminal.
// ➤ Reads the data/pipeline.md file (where the scanner stores the offers
// ➤ it found) and shows the ones still under "Pending": their stable
// ➤ number, company, title, location and link. That number (#N) is the same
// ➤ one that arrives via Telegram and the one you use when replying "seen N" or "no N".
// ➤ WHEN IT RUNS: manually, when you want to review the list; also,
// ➤ other bot scripts reuse the offer-reading function from here.
// ➤ ═══════════════════════════════════════════════════════════════════

/**
 * list-offers.mjs — OFFERS panel (plain-text list for the terminal).
 * The number is what you pass to `visto N` to remove an offer.
 * Pipeline line format: - [ ] url | company | title [| location]
 */

import { readFileSync, existsSync } from 'fs';
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
  const pendIdx = text.indexOf('## Pending');
  if (pendIdx === -1) return [];
  const procIdx = text.indexOf('## Processed');
  // ➤ Keeps only the chunk of the file between the "## Pending" heading
  // ➤ and the "## Processed" heading: what's already handled isn't shown.
  const section = text.slice(pendIdx, procIdx === -1 ? text.length : procIdx);
  const offers = [];
  // ➤ Walks line by line through the format "- [ ] link | company | title |
  // ➤ [location] | [y:years] | [s:salary] | [#number]". Instead of a single
  // ➤ brittle formula, it splits on the bars and CLASSIFIES each extra field by
  // ➤ its shape (audit 2026-07-18: the previous trick failed when the
  // ➤ offer had no location and showed "y:2" as if it were the city).
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

// ➤ This block only runs when you launch this file directly from the
// ➤ terminal (not when another script uses it internally): it prints each offer
// ➤ with its number, company, title and link, or reports if none are left.
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
