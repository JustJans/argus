#!/usr/bin/env node

// ➤ Tests for the review mode (review.mjs): the card's keyboard and text, the
// ➤ tap handling with its honesty rules (outdated card, double taps), and the
// ➤ undo pieces — the pipeline restore and the record removal — that keep a
// ➤ slip of the finger from leaving any trace. Everything runs on injected
// ➤ fakes: no Telegram, no disk, no bot.

import { reviewKeyboard, reviewCardText, handleReviewCallback, startReview, undoDecision, removeJsonlRecord } from './review.mjs';
import { restorePendingInLines } from './seen.mjs';
import { toInlineKeyboard } from './notify.mjs';

let total = 0, failures = 0;
function check(actual, expected, label) {
  total++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.log(`  FAIL ${label}\n    got:      ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
  }
}

// ➤ A three-offer deck; the middle one carries HTML-hostile text and a link
// ➤ Telegram would refuse as a URL button.
const mkState = (over = {}) => ({
  message_id: 500, idx: 0,
  offers: [
    { id: 855, title: 'Offshore Project Engineer', company: 'CSL OWL SRI B.V.', location: 'Rotterdam', salary: null, url: 'https://example.com/a' },
    { id: 856, title: 'Instrumentation <Engineer>', company: 'Technip & Co', location: 'Cartagena', salary: '€30k', url: 'ftp://not-a-web-link' },
    { id: 844, title: 'Service Engineer Marine', company: 'AXS', location: 'Rotterdam', salary: '€54k', url: 'https://example.com/c' },
  ],
  decisions: {}, ts: 'x', ...over,
});

// ── The keyboard ───────────────────────────────────────────────────────────
{
  const kb = reviewKeyboard(mkState());
  check(kb.length, 4, 'a pending card has four rows');
  check(kb[0], [{ label: 'Open offer', url: 'https://example.com/a' }], 'the first row is the link to the posting');
  check(kb[1], [{ label: 'Applied', data: 'rv:applied' }, { label: 'Cover', data: 'rv:cover' }], 'then Applied and Cover');
  check(kb[2], [{ label: 'Seen', data: 'rv:seen' }, { label: 'No', data: 'rv:no' }], 'then Seen and No');
  check(kb[3], [{ label: '1/3', data: 'rv:cur' }, { label: '▶', data: 'rv:next' }], 'the first card has no back arrow');

  const mid = reviewKeyboard(mkState({ idx: 1 }));
  check(mid.length, 3, 'a malformed link gets NO Open row — Telegram would refuse the whole card');
  check(mid[2], [{ label: '◀', data: 'rv:prev' }, { label: '2/3', data: 'rv:cur' }, { label: '▶', data: 'rv:next' }], 'a middle card offers both arrows');

  const done = reviewKeyboard(mkState({ decisions: { 855: { kind: 'no', at: 't' } } }));
  check(done, [
    [{ label: 'Undo', data: 'rv:undo' }],
    [{ label: '1/3', data: 'rv:cur' }, { label: '▶', data: 'rv:next' }],
  ], 'a decided card offers only Undo and the arrows');
}

// ── The card text ──────────────────────────────────────────────────────────
{
  check(reviewCardText(mkState()),
    '<b>#855 — Offshore Project Engineer</b>\nCSL OWL SRI B.V. · Rotterdam',
    'a pending card: bold title, then the facts that exist');
  check(reviewCardText(mkState({ idx: 1 })),
    '<b>#856 — Instrumentation &lt;Engineer&gt;</b>\nTechnip &amp; Co · Cartagena · €30k',
    'portal text is escaped — a title with < must not kill the card');
  check(reviewCardText(mkState({ decisions: { 855: { kind: 'no', at: 't' } } })),
    '<s>#855 — Offshore Project Engineer</s>\nDiscarded',
    'a decided card: struck title and one word');
  check(reviewCardText(mkState({ decisions: { 855: { kind: 'applied', at: 't', warn: 'Recorded, but <x>' } } })),
    '<s>#855 — Offshore Project Engineer</s>\nApplied\nRecorded, but &lt;x&gt;',
    'a warning rides the card, escaped');
}

// ── Tap handling ───────────────────────────────────────────────────────────
const wire = (state) => {
  const calls = [];
  const deps = {
    load: () => state,
    save: s => calls.push(['save', s.idx]),
    edit: (id, text, kb) => calls.push(['edit', id, text, kb]),
    answer: (id, msg) => calls.push(['answer', msg || null]),
    seen: async o => { calls.push(['seen', o.id]); return {}; },
    reject: async o => { calls.push(['reject', o.id]); return { recTs: 'T1' }; },
    applied: async o => { calls.push(['applied', o.id]); return { recTs: 'T2', warn: 'Recorded, but it could not be removed from the list.' }; },
    cover: async n => calls.push(['cover', n]),
    undo: (n, dec) => { calls.push(['undo', n, dec?.kind || null]); return { restored: true, recordRemoved: true }; },
    refresh: () => calls.push(['refresh']),
    start: async () => calls.push(['start']),
  };
  return { calls, deps };
};

{
  const { calls, deps } = wire(mkState());
  check(await handleReviewCallback('o:2', 500, 'cb', deps), false, 'an onboarding tap is not a review tap: falls through');
  check(calls.length, 0, 'and nothing was sent for it');

  check(await handleReviewCallback('rv:cur', 500, 'cb', deps), true, 'the counter is handled');
  check(calls, [['answer', null]], 'but only stops the spinner');
}

{
  const { calls, deps } = wire(mkState());
  await handleReviewCallback('rv:next', 999, 'cb', deps);
  check(calls, [['answer', 'This review is outdated — send "review" for a fresh one.']],
    'a tap on an OLDER card gets the outdated toast, never a redraw');
}

{
  const st = mkState();
  const { calls, deps } = wire(st);
  await handleReviewCallback('rv:next', 500, 'cb', deps);
  check(st.idx, 1, 'next moves to the second offer');
  check(calls[0], ['answer', null], 'the spinner dies first');
  check(calls[2][2].includes('#856'), true, 'and the card redraws with the next offer');
  st.idx = 2;
  await handleReviewCallback('rv:next', 500, 'cb', deps);
  check(st.idx, 2, 'next on the last card clamps: no wrap-around');
}

{
  const st = mkState();
  const { calls, deps } = wire(st);
  await handleReviewCallback('rv:no', 500, 'cb', deps);
  check(calls.some(c => c[0] === 'reject' && c[1] === 855), true, 'No runs the same rejection the typed command runs');
  check(st.decisions[855].kind, 'no', 'the decision is remembered');
  check(st.decisions[855].recTs, 'T1', 'with the record timestamp undo will need');
  check(typeof st.decisions[855].at, 'string', 'and when it happened');
  const drawn = calls.filter(c => c[0] === 'edit').pop();
  check(drawn[2].includes('Discarded'), true, 'the card now says Discarded');
  check(drawn[3][0], [{ label: 'Undo', data: 'rv:undo' }], 'and offers Undo');

  const before = calls.filter(c => c[0] === 'reject').length;
  await handleReviewCallback('rv:no', 500, 'cb', deps);
  check(calls.filter(c => c[0] === 'reject').length, before, 'a second tap on a decided card runs NOTHING twice');
}

{
  const st = mkState();
  const { calls, deps } = wire(st);
  await handleReviewCallback('rv:applied', 500, 'cb', deps);
  const drawn = calls.filter(c => c[0] === 'edit').pop();
  check(drawn[2].includes('Recorded, but it could not be removed'), true,
    'the honesty warning from the action rides the card');
}

{
  const st = mkState({ decisions: { 855: { kind: 'no', recTs: 'T1', at: 't' } } });
  const { calls, deps } = wire(st);
  await handleReviewCallback('rv:undo', 500, 'cb', deps);
  check(calls.some(c => c[0] === 'undo' && c[1] === 855 && c[2] === 'no'), true, 'Undo reverts THIS offer with its own decision');
  check(st.decisions[855], undefined, 'the decision is forgotten');
  check(calls.some(c => c[0] === 'refresh'), true, 'and the list refreshes so the offer shows again');
  const drawn = calls.filter(c => c[0] === 'edit').pop();
  check(drawn[3].length, 4, 'the card is back to the full pending keyboard');
}

{
  const { calls, deps } = wire(mkState());
  await handleReviewCallback('rv:cover', 500, 'cb', deps);
  check(calls, [['answer', 'Generating the cover letter — the PDF arrives here.'], ['cover', 855]],
    'Cover only launches the letter: the offer stays pending, the card untouched');
}

{
  const { calls, deps } = wire(mkState());
  await handleReviewCallback('rv:start', 500, 'cb', deps);
  check(calls, [['answer', null], ['start']], 'the list button opens a fresh review');
}

// ── startReview ────────────────────────────────────────────────────────────
{
  const calls = [];
  const r = await startReview({
    pending: () => [],
    notify: async m => calls.push(['notify', m]),
    send: async () => { calls.push(['send']); return 1; },
    load: () => null, save: () => {}, del: async () => {},
  });
  check(r, null, 'no pending offers: no card');
  check(calls, [['notify', 'No pending offers to review.']], 'it says so instead of going silent');
}

{
  const calls = [];
  let saved = null;
  const r = await startReview({
    pending: () => mkState().offers,
    notify: async () => {},
    send: async (text, kb) => { calls.push(['send', text.slice(0, 12), kb.length]); return 777; },
    load: () => ({ message_id: 321 }),
    save: s => { saved = s; },
    del: async id => calls.push(['del', id]),
  });
  check(r, 777, 'the card id comes back');
  check(calls[0], ['del', 321], 'the previous card is deleted first: one deck at a time');
  check(saved.message_id, 777, 'the state binds to the new card');
  check(saved.offers.length, 3, 'the deck is the pending snapshot');
  check(saved.idx, 0, 'starting at the first offer');
}

// ── The undo pieces ────────────────────────────────────────────────────────
{
  const lines = [
    '## Pendientes',
    '- [x] https://x/a | Adzuna | Fontanero | España | #845 | visto',
    '- [x] https://x/b | Dead Co | Old role | #700',
    '- [ ] https://x/c | Live Co | Open role | #900',
  ];
  const r = restorePendingInLines(lines, 845);
  check(r.restored, true, 'a line hidden by YOUR decision is restored');
  check(r.lines[1], '- [ ] https://x/a | Adzuna | Fontanero | España | #845', 'unchecked, tag removed, fields intact');
  check(restorePendingInLines(lines, 700).restored, false, 'a line the cleanup hid (no tag) is NOT yours to restore');
  check(restorePendingInLines(lines, 900).restored, false, 'a line already pending has nothing to restore');
  check(restorePendingInLines(lines, 111).restored, false, 'an unknown number restores nothing');
}

{
  const mkIo = (text) => {
    const state = { text, writes: [] };
    return {
      state,
      io: {
        read: () => { if (state.text == null) { throw new Error('ENOENT'); } return state.text; },
        write: (p, t) => { state.text = t; state.writes.push(t); },
        lock: (p, fn) => fn(),
      },
    };
  };
  const A = '{"ts":"t1","id":845,"reason":"a"}';
  const B = '{"ts":"t2","id":845,"reason":"b"}';
  const C = '{"ts":"t3","id":900,"reason":"c"}';
  let f = mkIo([A, B, C, ''].join('\n'));
  check(removeJsonlRecord('p', 845, 't1', f.io), true, 'an exact ts match is removed');
  check(f.state.text, [B, C, ''].join('\n'), 'and only that line went');

  f = mkIo([A, B, C, ''].join('\n'));
  check(removeJsonlRecord('p', 845, null, f.io), true, 'without a ts, the LAST record of that offer goes');
  check(f.state.text, [A, C, ''].join('\n'), 'the earlier one survives');

  f = mkIo([A, ''].join('\n'));
  check(removeJsonlRecord('p', 999, null, f.io), false, 'an unknown id removes nothing');
  f = mkIo(null);
  check(removeJsonlRecord('p', 845, null, f.io), false, 'a missing file removes nothing and does not throw');
}

{
  const calls = [];
  const deps = {
    lock: (p, fn) => fn(),
    read: () => '- [x] https://x/a | A | B | #845 | visto',
    write: (p, t) => calls.push(['write', t]),
    removeRecord: (p, id, ts) => { calls.push(['rm', p.split(/[\\/]/).pop(), id, ts]); return true; },
    feedbackPath: 'F/feedback.jsonl', appliedPath: 'D/applications.jsonl', pipelinePath: 'D/pipeline.md',
  };
  const r = undoDecision(845, { kind: 'no', recTs: 'T1' }, deps);
  check(r, { restored: true, recordRemoved: true }, 'undo of a "no": line back AND record gone');
  check(calls, [
    ['write', '- [ ] https://x/a | A | B | #845'],
    ['rm', 'feedback.jsonl', 845, 'T1'],
  ], 'exactly the feedback record its decision wrote — applications untouched');

  calls.length = 0;
  undoDecision(845, null, deps);
  check(calls.filter(c => c[0] === 'rm').map(c => c[1]), ['feedback.jsonl', 'applications.jsonl'],
    'a typed undo with no card context sweeps both record files by offer number');
}

// ── The keyboard wire format ───────────────────────────────────────────────
{
  check(toInlineKeyboard([[{ label: 'Open offer', url: 'https://x' }, { label: 'No', data: 'rv:no' }]]),
    { inline_keyboard: [[{ text: 'Open offer', url: 'https://x' }, { text: 'No', callback_data: 'rv:no' }]] },
    'a url button becomes a Telegram link button, a data button a callback');
}

console.log(failures === 0 ? `All ${total} review tests passed.` : `${failures}/${total} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
