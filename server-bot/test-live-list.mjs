#!/usr/bin/env node
// ➤ Tests for the "live list": they check the pure part (remembering and reading the ids
// ➤ of the list messages), without touching Telegram. They use a temporary file.

import { loadListIds, saveListIds, loadSeenIds, saveSeenIds, refreshList } from './live-list.mjs';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { harness as testKit } from './test-harness.mjs';

const { ok, eq, done } = testKit('live-list');
const check = (name, cond) => ok(cond, name);

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

// ── refreshList: the ORDER is the whole point ────────────────────────────
// ➤ It used to delete the previous list FIRST. When the resend then failed you
// ➤ were left with no list at all. Nothing checked that until now, because the
// ➤ final state looks identical either way — only the order tells them apart.
const fakeOffers = [{ id: 1, title: 'Mooring Engineer', company: 'ACME', location: 'Spain', url: 'https://x/1' }];

function harness({ sendReturns = [11, 12], offers = fakeOffers, previous = [7, 8] } = {}) {
  const log = [];
  const deps = {
    telegramConfigured: () => true,
    pendingOffers: () => offers,
    notifyNewOffers: async () => { log.push('send'); return sendReturns; },
    sendTelegramMessage: async () => { log.push('send-empty'); return sendReturns[0] ?? null; },
    deleteTelegramMessage: async id => { log.push('delete:' + id); },
    loadListIds: () => previous,
    saveListIds: ids => { log.push('save:' + ids.join(',')); },
    loadSeenIds: () => [],
    saveSeenIds: ids => { log.push('seen:' + ids.join(',')); },
  };
  return { log, deps };
}

// ➤ Each step must have HAPPENED before its order is compared: indexOf returns
// ➤ -1 for a missing entry, and -1 is smaller than everything, so an ordering
// ➤ check on its own silently passes when the step was dropped entirely.
const happy = harness();
await refreshList({ deps: happy.deps });
check('the new list is sent', happy.log.includes('send'));
check('the new ids are saved', happy.log.includes('save:11,12'));
check('sends the new list before deleting the old one', happy.log.indexOf('send') < happy.log.indexOf('delete:7'));
check('saves the new ids before deleting the old ones', happy.log.indexOf('save:11,12') < happy.log.indexOf('delete:7'));
check('every previous message is deleted', happy.log.includes('delete:7') && happy.log.includes('delete:8'));

// ➤ The failure that motivated the fix: the send does not go through.
const failed = harness({ sendReturns: [] });
await refreshList({ deps: failed.deps });
check('a failed send deletes nothing', !failed.log.some(l => l.startsWith('delete:')));
check('a failed send saves no ids', !failed.log.some(l => l.startsWith('save:')));

// ➤ markSeen is what stops offers showing [NEW] for ever, and it must record
// ➤ the ids that were actually on the list.
const seen = harness();
await refreshList({ deps: seen.deps, markSeen: true });
check('markSeen records the listed offer ids', seen.log.includes('seen:1'));
const notSeen = harness();
await refreshList({ deps: notSeen.deps });
check('without markSeen nothing is marked seen', !notSeen.log.some(l => l.startsWith('seen:')));

// ➤ A list that never left the server has not been seen. Marking it seen anyway
// ➤ spent the [NEW] tags on offers that were never shown, so the next list to
// ➤ arrive presented them as old news.
const failedSeen = harness({ sendReturns: [] });
await refreshList({ deps: failedSeen.deps, markSeen: true });
check('a failed send does not spend the [NEW] tags', !failedSeen.log.some(l => l.startsWith('seen:')));

// ➤ With no offers left it still posts the placeholder, so the chat always ends
// ➤ in a list rather than in the last thing you typed.
const empty = harness({ offers: [] });
await refreshList({ deps: empty.deps });
check('an empty list still posts a notice', empty.log.includes('send-empty'));

// ➤ It must never take its caller down: a throwing dependency is reported, not
// ➤ thrown. It answers FALSE, meaning "it failed" — deliberately not null, which
// ➤ means "Telegram is not set up" (audit 2026-07-31). The two used to be the
// ➤ same answer, so the scan's own summary said the bot was unconfigured when in
// ➤ fact a send had failed and offers had been written to the pending list
// ➤ without ever reaching the phone.
const boom = harness();
boom.deps.pendingOffers = () => { throw new Error('pipeline unreadable'); };
check('a throwing dependency is reported as a failure, not as a crash', await refreshList({ deps: boom.deps }) === false);

// ➤ And the three answers stay apart from each other.
const off = harness();
off.deps.telegramConfigured = () => false;
check('not configured answers null', await refreshList({ deps: off.deps }) === null);

const nosend = harness();
nosend.deps.notifyNewOffers = async () => [];      // the send produced no message
check('a send that posted nothing answers false', await refreshList({ deps: nosend.deps }) === false);

const okrun = harness();
check('a successful refresh answers the number of pending offers', typeof (await refreshList({ deps: okrun.deps })) === 'number');

try { rmSync(p); } catch { /* best-effort cleanup */ }
try { rmSync(sp); } catch { /* best-effort cleanup */ }

done();
