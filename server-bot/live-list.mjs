#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "live list" of pending offers in Telegram. Instead of piling up old
// ➤ lists in the chat there is ONE: every time something changes (a new offer, or you say
// ➤ seen/no/applied) the previous list is DELETED and an updated one RE-SENT to the bottom
// ➤ of the chat, silently. Your commands and the bot's confirmations stay as history; only
// ➤ the list is use-and-throw-away. Uses pendingOffers(), notifyNewOffers() (drawn grouped
// ➤ by country, with links) and deleteTelegramMessage(); the list message ids live in
// ➤ data/list-message.json. Called by the listener (after list/seen/no/applied) and by the
// ➤ scanner (when it adds offers).
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pendingOffers } from './list-offers.mjs';
import { notifyNewOffers, sendTelegramMessage, deleteTelegramMessage, telegramConfigured } from './notify.mjs';
import { withFileLock } from './fs-atomic.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
// ➤ Where the ids of the messages that make up the current list are remembered.
const STATE_PATH = join(ROOT, 'data', 'list-message.json');
// ➤ Which offer ids you have already seen in a list, so the rest (the ones that
// ➤ arrived since) can be marked [NEW].
const SEEN_PATH = join(ROOT, 'data', 'list-seen.json');

// ➤ Reads the ids of the previous list; a missing or corrupt file means an empty list
// ➤ (nothing to delete). `path` exists only for tests.
export function loadListIds(path = STATE_PATH) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(s.message_ids) ? s.message_ids : [];
  } catch { return []; }
}

// ➤ Saves the ids of the list just sent, so it can be deleted next time. A failed save is
// ➤ ignored: at worst an old list is left undeleted.
export function saveListIds(ids, path = STATE_PATH) {
  try {
    writeFileSync(path, JSON.stringify({ message_ids: ids, ts: new Date().toISOString() }) + '\n', 'utf-8');
  } catch { /* we don't break just because we couldn't save the state */ }
}

// ➤ The offer ids you have ALREADY seen in a list (the rest show [NEW]); null when never
// ➤ set, which callers turn into an empty set — so on the very first list EVERYTHING shows
// ➤ [NEW] until a command marks the current offers seen. `path` is only for testing.
export function loadSeenIds(path = SEEN_PATH) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(s.ids) ? s.ids : null;
  } catch { return null; }
}

// ➤ Remembers the offer ids you have now seen (so they aren't [NEW] next time).
export function saveSeenIds(ids, path = SEEN_PATH) {
  try { writeFileSync(path, JSON.stringify({ ids, ts: new Date().toISOString() }) + '\n', 'utf-8'); }
  catch { /* not critical: at worst an offer is marked [NEW] one extra time */ }
}

// ➤ THE HEART: deletes the previous list and re-sends the pending offers to the bottom of the chat.
// ➤   alert   = true → makes a sound: this one list is the ONLY offer message, so its ping IS the alert.
// ➤   markSeen= true → YOU viewed the list (your own command): the current offers stop being [NEW].
// ➤ It answers one of THREE things, and the difference matters to the caller:
// ➤   null   → Telegram is not configured, nothing was attempted.
// ➤   false  → it tried and FAILED; no list reached your chat.
// ➤   number → it worked: how many offers are pending.
// ➤ It never throws: a failure is logged, never thrown at the scanner or the listener.
// ➤ `deps` exists so the ORDER below can be tested — a test that only looks at the final
// ➤ state passes even if the delete happens first.
export async function refreshList({ alert = false, markSeen = false, deps } = {}) {
  const d = deps || {
    telegramConfigured, pendingOffers, notifyNewOffers,
    sendTelegramMessage, deleteTelegramMessage,
    loadListIds, saveListIds, loadSeenIds, saveSeenIds,
  };
  if (!d.telegramConfigured()) return null;
  try {
    // ➤ SEND FIRST, delete the old list only once the new one is safely posted: if the resend
    // ➤ fails (a 429 beyond the retry, a timeout), the worst case is two lists for a moment,
    // ➤ never zero.
    const oldIds = d.loadListIds();
    const offers = d.pendingOffers();

    // ➤ 2) Work out which offers are NEW: those not in the "already seen" set. Everything is
    // ➤ [NEW] until you first view the list with a command; after that only later arrivals
    // ➤ show it.
    const pendingIds = offers.map(o => o.id).filter(id => id != null);
    const seenSet = new Set(d.loadSeenIds() || []);
    const newIds = new Set(pendingIds.filter(id => !seenSet.has(id)));

    // ➤ 3) Draw and send the current list, silent unless alert=true (new offers), the new ones
    // ➤ marked [NEW]. With nothing pending, a short notice, so a reference list always sits at
    // ➤ the bottom of the chat.
    let ids;
    if (offers.length) {
      // ➤ paged: the whole list is ONE message showing a page, with Prev/Next buttons editing it
      // ➤ in place — a 60-offer list does not arrive as three stacked messages.
      ids = await d.notifyNewOffers(offers, { headerLabel: 'pending', silent: !alert, newIds, paged: true });
      if (!Array.isArray(ids)) ids = [];
    } else {
      const id = await d.sendTelegramMessage('No pending offers.', { silent: !alert });
      ids = id != null ? [id] : [];
    }

    // ➤ 4) Save the new list's ids FIRST, so they can never be lost, and only then remove the
    // ➤ old list. If the send failed, ids is empty and the old list stays put rather than
    // ➤ leaving the chat with nothing.
    if (ids.length) {
      // ➤ RECONCILED UNDER LOCK. Scanner, housekeep and listener are separate processes; if each
      // ➤ worked from the ids loaded before its send, whoever saved second would erase the
      // ➤ other's freshly-sent list from the state without deleting it — a stale list orphaned
      // ➤ in the chat for ever, the exact artifact this module exists to remove. The lock covers
      // ➤ only the read-and-save milliseconds (never the sends); whatever the state named at
      // ➤ that instant joins the delete pile, so the loser's list is swept instead of stranded.
      let toDelete = oldIds;
      withFileLock(STATE_PATH, () => {
        const current = d.loadListIds();
        toDelete = [...new Set([...oldIds, ...current])].filter(id => !ids.includes(id));
        d.saveListIds(ids);
      });
      for (const id of toDelete) await d.deleteTelegramMessage(id);
    } else {
      console.log(`[${new Date().toISOString()}] live-list: the new list could not be sent; the previous one is kept.`);
      // ➤ SAY OUT LOUD THAT IT FAILED: the caller must be able to tell "the list is on your
      // ➤ phone" from "nothing was sent", because by now the offers are already in the pending
      // ➤ file and in the anti-repeat history — silence here would mean they are never offered
      // ➤ again and you were never told once. AND THE [NEW] TAGS SURVIVE: nothing is marked seen
      // ➤ when the list never left the server.
      return false;
    }
    if (markSeen) d.saveSeenIds(pendingIds);
    return offers.length;
  } catch (e) {
    console.log(`[${new Date().toISOString()}] refreshList failed: ${String(e.message).slice(0, 200)}`);
    // ➤ A crash is a FAILURE, not "Telegram is not configured". Only the config
    // ➤ check at the top of the function is allowed to answer null.
    return false;
  }
}

// ➤ Allows refreshing the list by hand from the terminal: node live-list.mjs
if (process.argv[1] && /(^|[\\/])live-list\.mjs$/.test(process.argv[1])) {
  refreshList().then(n => console.log(
    n === null ? 'Telegram not configured.'
    : n === false ? 'The list could NOT be sent (see the message above).'
    : `List updated: ${n} pending.`));
}
