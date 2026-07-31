#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the two headings that divide data/pipeline.md — the offers
// ➤ waiting for you, and the ones already dealt with.
// ➤
// ➤ WHY IT IS A FILE OF ITS OWN. Four modules need them: the scanner writes,
// ➤ the list reads, "seen" edits and housekeep deletes. Each used to spell
// ➤ them out for itself — four copies of one decision, which drift the moment
// ➤ anybody changes one of them. One place, one spelling.
// ➤
// ➤ CHANGING THEM MEANS CHANGING YOUR FILE TOO. data/pipeline.md already on
// ➤ disk carries the old heading, and a heading that stops being recognised
// ➤ does not raise an error — the list simply comes back empty, which tells
// ➤ you nothing about why. Rename the file at the same time, and keep a copy.
// ➤ ═══════════════════════════════════════════════════════════════════════

export const PENDING_HEADING = '## Pending';
export const PROCESSED_HEADING = '## Processed';

// ➤ startsWith rather than equals: a heading may carry something after it
// ➤ ("## Pending (12)") without ceasing to be the heading.
export const isPendingHeading = line => String(line || '').startsWith(PENDING_HEADING);
export const isProcessedHeading = line => String(line || '').startsWith(PROCESSED_HEADING);

// ➤ Where the pending section starts in a whole file, or -1. For the readers
// ➤ that work on the text rather than line by line.
export const pendingIndex = text => String(text || '').indexOf(PENDING_HEADING);
