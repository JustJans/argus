#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "live list" of pending offers in Telegram. Instead of
// ➤ piling up old lists in the chat, there is ONE single list: every time
// ➤ something changes (a new offer arrives, or you say seen/no/applied) the
// ➤ previous list is DELETED and an updated one is RE-SENT to the bottom of
// ➤ the chat, silently. Your commands and the bot's confirmations are never
// ➤ touched: they stay as history. The only "use-and-throw-away" thing is the list.
// ➤ WHAT IT USES: pendingOffers() (the pending offers), notifyNewOffers() (to
// ➤ draw it the same way as always, grouped by country and with links) and
// ➤ deleteTelegramMessage() (to delete the previous one). It remembers the ids
// ➤ of the list messages in data/list-message.json.
// ➤ WHEN IT RUNS: it is called by the listener (after list/seen/no/applied) and
// ➤ by the scanner (when it adds new offers).
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pendingOffers } from './list-offers.mjs';
import { notifyNewOffers, sendTelegramMessage, deleteTelegramMessage, telegramConfigured } from './notify.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
// ➤ Where the ids of the messages that make up the current list are remembered.
const STATE_PATH = join(ROOT, 'data', 'list-message.json');
// ➤ Which offer ids you have already seen in a list, so the rest (the ones that
// ➤ arrived since) can be marked [NEW].
const SEEN_PATH = join(ROOT, 'data', 'list-seen.json');

// ➤ Reads the ids of the previous list. If the file doesn't exist or is corrupt,
// ➤ it returns an empty list (no problem, there simply won't be anything to
// ➤ delete). The `path` parameter exists only so it can be tested in a test.
export function loadListIds(path = STATE_PATH) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(s.message_ids) ? s.message_ids : [];
  } catch { return []; }
}

// ➤ Saves the ids of the list that was just sent, so it can be deleted next
// ➤ time. If saving fails, it is ignored (worst case: an old list is left
// ➤ undeleted, nothing serious).
export function saveListIds(ids, path = STATE_PATH) {
  try {
    writeFileSync(path, JSON.stringify({ message_ids: ids, ts: new Date().toISOString() }) + '\n', 'utf-8');
  } catch { /* we don't break just because we couldn't save the state */ }
}

// ➤ The offer ids you have ALREADY seen in a list (used to mark the rest as
// ➤ [NEW]). Returns null when it has never been set (first run). Callers wrap
// ➤ this as `new Set(loadSeenIds() || [])`, so null becomes an EMPTY seen-set:
// ➤ on the very first list NOTHING counts as seen, so EVERYTHING shows [NEW]
// ➤ until a command runs and saveSeenIds records the current offers as seen.
// ➤ The `path` param is only for testing.
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

// ➤ THE HEART: deletes the previous list and re-sends the updated list of
// ➤ pending offers to the bottom of the chat. Options:
// ➤   alert   = true → the repost makes a sound (the scanner uses it for new
// ➤                    offers; this single list is the ONLY offer message, so
// ➤                    its ping IS the new-offers alert). Default silent.
// ➤   markSeen= true → YOU viewed the list (a command of yours), so the current
// ➤                    offers stop being "new". Offers not yet seen show [NEW].
// ➤ It answers one of THREE things, and the difference matters to whoever calls it:
// ➤   null   → Telegram is not configured, so nothing was even attempted.
// ➤   false  → it tried and FAILED; no list reached your chat.
// ➤   number → it worked, and this is how many offers are pending.
// ➤ It never throws: if something fails, it logs it but doesn't take down its
// ➤ caller (scanner or listener).
// ➤ `deps` exists so the ORDER below can be tested. It is the whole point of
// ➤ this function and it cannot be checked from the outside: any test that only
// ➤ looks at the final state passes even if the delete happens first, which is
// ➤ precisely the bug fixed on 2026-07-25.
export async function refreshList({ alert = false, markSeen = false, deps } = {}) {
  const d = deps || {
    telegramConfigured, pendingOffers, notifyNewOffers,
    sendTelegramMessage, deleteTelegramMessage,
    loadListIds, saveListIds, loadSeenIds, saveSeenIds,
  };
  if (!d.telegramConfigured()) return null;
  try {
    // ➤ ORDER FIXED 2026-07-25 (audit): the previous list used to be deleted
    // ➤ FIRST. If the resend then failed (a 429 beyond the retry, a timeout),
    // ➤ you were left with NO list at all and a half-sent one orphaned in the
    // ➤ chat. Now we SEND first and delete the old one only once the new one is
    // ➤ safely posted: the worst case is two lists for a moment, never zero.
    const oldIds = d.loadListIds();
    const offers = d.pendingOffers();

    // 2) Work out which offers are NEW: those not in the "already seen" set.
    //    Everything is [NEW] until you first view the list with a command, which
    //    marks the current offers as seen; after that only later arrivals show [NEW].
    const pendingIds = offers.map(o => o.id).filter(id => id != null);
    const seenSet = new Set(d.loadSeenIds() || []);
    const newIds = new Set(pendingIds.filter(id => !seenSet.has(id)));

    // 3) Draw and send the current list. Silent unless alert=true (new offers);
    //    the new ones are marked [NEW]. If there are no pending offers, a short
    //    notice so there is always a reference list at the bottom of the chat.
    let ids;
    if (offers.length) {
      ids = await d.notifyNewOffers(offers, { headerLabel: 'pending', silent: !alert, newIds });
      if (!Array.isArray(ids)) ids = [];
    } else {
      const id = await d.sendTelegramMessage('No pending offers.', { silent: !alert });
      ids = id != null ? [id] : [];
    }

    // 4) Save the new list's ids FIRST, so they can never be lost, and only then
    //    remove the old list. If the send above failed, ids is empty and the old
    //    list stays put rather than leaving your chat with nothing at all.
    if (ids.length) {
      d.saveListIds(ids);
      for (const id of oldIds) await d.deleteTelegramMessage(id);
    } else {
      console.log(`[${new Date().toISOString()}] live-list: the new list could not be sent; the previous one is kept.`);
      // ➤ FIX (audit 2026-07-31): SAY OUT LOUD THAT IT FAILED. This used to hand
      // ➤ back the offer count anyway, so the caller had no way to tell "the list
      // ➤ is on your phone" from "nothing was sent". The scan would then report
      // ➤ that Telegram was NOT SET UP, while those offers had already been
      // ➤ written into the pending file and into the anti-repeat history — so
      // ➤ they were never offered again, and you were never told about them once.
      if (markSeen) d.saveSeenIds(pendingIds);
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
