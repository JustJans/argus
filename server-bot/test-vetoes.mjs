#!/usr/bin/env node

// ➤ Tests for the EXPERIMENTAL veto panel (2026-08-24): the "no" that
// ➤ teaches. Everything here guards the same three promises the panel makes:
// ➤ a tap becomes a standing veto with the scanner's exact word rules, the
// ➤ user's own field can never be offered as a veto, and every tap is
// ➤ reversible (Undo on the panel, Remove on the "vetoes" list).

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadVetoes, saveVetoes, addVeto, removeVeto,
  titleNegativesWith, companyFilterWith, locationFilterWith, vetoHits,
  proposeVetoChips, sendVetoChips, handleVetoCallback, startVetoList,
} from './vetoes.mjs';
import { buildTitleFilter } from './scan.mjs';

let total = 0, failures = 0;
const ok = (cond, label) => { total++; if (!cond) { failures++; console.log(`  FAIL ${label}`); } };
const eq = (got, want, label) => {
  total++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log(`  FAIL ${label}\n    got:      ${g}\n    expected: ${w}`); }
};

// ── The store: tolerant on the way in, atomic on the way out ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'argus-vetoes-'));
  const p = join(dir, 'vetoes.json');
  eq(loadVetoes(p), { titles: [], companies: [], cities: [] }, 'a missing store is empty, not a crash');
  writeFileSync(p, '{corrupt');
  eq(loadVetoes(p), { titles: [], companies: [], cities: [] }, 'a corrupt store is empty, not a crash');
  saveVetoes({ titles: ['Divorce'], companies: ['Smith & Partners'], cities: ['Dubai'] }, p);
  eq(loadVetoes(p).titles, ['Divorce'], 'what was saved comes back');
  writeFileSync(p, JSON.stringify({ titles: 'not-an-array' }));
  eq(loadVetoes(p).titles, [], 'a wrong shape inside the store degrades to empty');
}

// ── add / remove: accent- and case-blind, always pure ──────────────────────
{
  const v0 = { titles: [], companies: [], cities: [] };
  const a1 = addVeto(v0, 'title', 'Divorce');
  ok(a1.added && a1.v.titles.includes('Divorce'), 'a veto is added');
  eq(v0.titles, [], 'and the original store object is untouched (pure)');
  ok(!addVeto(a1.v, 'title', 'divórce').added, 'the same word in another case or accent is not added twice');
  ok(!addVeto(a1.v, 'title', '   ').added, 'blank is not a veto');
  ok(!addVeto(a1.v, 'nonsense', 'x').added, 'an unknown kind is refused');
  const r1 = removeVeto(a1.v, 'title', 'DIVORCE');
  ok(r1.removed && r1.v.titles.length === 0, 'remove folds the same way add does');
  ok(!removeVeto(a1.v, 'title', 'never-there').removed, 'removing what is not there says so');
}

// ── Merging into the filters ───────────────────────────────────────────────
{
  const v = { titles: ['Divorce'], companies: ['BadCorp'], cities: ['Dubai'] };
  eq(titleNegativesWith(['Senior'], v), ['Senior', 'Divorce'], 'title vetoes append to the base negatives');
  eq(titleNegativesWith(null, v), ['Divorce'], 'and stand alone when there is no base');
  const none = { titles: [], companies: [], cities: [] };
  eq(companyFilterWith(null, none), null, 'no company vetoes leave the config exactly as it was');
  eq(companyFilterWith({ blocked: ['Old'] }, v).blocked, ['Old', 'BadCorp'], 'company vetoes append to the blocklist');
  eq(companyFilterWith(null, v).blocked, ['BadCorp'], 'and create one when there was none');
  const lf = locationFilterWith({ allow: ['spain'], block: ['Qatar'] }, v);
  eq(lf.allow, ['spain'], 'city vetoes never touch the allow list');
  eq(lf.block, ['Qatar', 'Dubai'], 'they append to the block list');
  eq(locationFilterWith(undefined, none), undefined, 'no city vetoes add no location filter');

  // ➤ The merged negative must explain itself like any hand-written one.
  const f = buildTitleFilter({ positive: ['lawyer'], negative: titleNegativesWith([], v) });
  ok(!f('Divorce Lawyer'), 'a merged veto blocks through the real filter');
  eq(f.explain('Divorce Lawyer'), 'the title has the blocked word "Divorce"', 'and --explain names the veto that fired');
  ok(f('Criminal Lawyer'), 'while the rest of the field still passes');
}

// ── vetoHits: the panel judges with the scanner's own rules ────────────────
{
  const offers = [
    { id: 1, title: 'Divorce Lawyer', company: 'Smith & Partners', location: 'Barcelona, Spain' },
    { id: 2, title: 'Criminal Lawyer', company: 'Justice LLP', location: 'Madrid, Spain' },
    { id: 3, title: 'Artificial Intelligence Engineer', company: 'BadCorp', location: '' },
    { id: 4, title: 'Family and Divorce Solicitor', company: 'Smith & Partners', location: 'Dubai, UAE' },
  ];
  eq(vetoHits('title', 'Divorce', offers).map(o => o.id), [1, 4], 'a word veto hits every title carrying the word');
  eq(vetoHits('title', 'Art', offers).length, 0, 'and stays word-bounded: "Art" does not hit Artificial');
  eq(vetoHits('title', 'Divorce Lawyer', offers).map(o => o.id), [1], 'a pair veto hits only the exact phrase');
  eq(vetoHits('company', 'Smith & Partners', offers).map(o => o.id), [1, 4], 'a company veto hits its offers');
  eq(vetoHits('city', 'Dubai', offers).map(o => o.id), [4], 'a city veto hits its location');
  eq(vetoHits('city', 'Dubai', [offers[2]]).length, 0, 'an offer with no location is never a city hit');
}

// ── proposeVetoChips: what the panel dares to offer ────────────────────────
{
  const none = { titles: [], companies: [], cities: [] };
  const chips = proposeVetoChips(
    { id: 412, title: 'Senior Divorce Lawyer (m/w/d)', company: 'Smith & Partners', location: 'Barcelona, Spain' },
    { positives: ['lawyer'], vetoes: none },
  );
  const labels = chips.map(c => c.label);
  ok(labels.includes('Divorce'), 'the distinctive word is offered');
  ok(labels.includes('Divorce Lawyer'), 'and the narrowing pair with it');
  ok(!labels.includes('Lawyer'), 'the user\'s own positive is never offered alone');
  ok(!labels.includes('Senior'), 'seniority words are not vetoes');
  ok(!labels.some(l => /^m$|^w$|^d$/i.test(l)), 'gender tags are not vetoes');
  ok(labels.includes('Company: Smith & Partners'), 'the company is offered');
  ok(labels.includes('City: Barcelona'), 'and the city, alone, without its country');

  const mooring = proposeVetoChips(
    { id: 1, title: 'Mooring Engineer', company: 'X', location: '' },
    { positives: ['mooring'], vetoes: none },
  );
  ok(!mooring.some(c => c.kind === 'title' && /mooring/i.test(c.value)), 'a bad offer in your own field cannot tempt you into vetoing the field');

  const already = proposeVetoChips(
    { id: 2, title: 'Divorce Lawyer', company: 'Smith & Partners', location: 'Barcelona, Spain' },
    { positives: [], vetoes: { titles: ['Divorce'], companies: ['Smith & Partners'], cities: ['Barcelona'] } },
  );
  ok(!already.some(c => c.value === 'Divorce'), 'a word already vetoed is not offered again');
  ok(!already.some(c => c.kind === 'company'), 'nor an already-vetoed company');
  ok(!already.some(c => c.kind === 'city'), 'nor an already-vetoed city');

  const many = proposeVetoChips(
    { id: 3, title: 'Underwater Basket Weaving Instructor Wanted Immediately', company: '', location: '' },
    { positives: [], vetoes: none },
  );
  ok(many.filter(c => !c.value.includes(' ')).length <= 3, 'at most three single words');
  ok(many.filter(c => c.value.includes(' ')).length <= 2, 'at most two pairs');

  eq(proposeVetoChips({ id: 4, title: '', company: '', location: '' }, { positives: [], vetoes: none }), [], 'nothing to read, nothing to offer');
}

// ── The panel, tap by tap, against fake Telegram and a fake store ──────────
function fakeWorld({ pending = [], positives = [] } = {}) {
  const world = {
    store: { titles: [], companies: [], cities: [] },
    chipsState: null, listState: null,
    sent: [], edited: [], deleted: [], answered: [], stripped: [], hidden: [],
    nextId: 100,
  };
  world.deps = {
    send: async (text, rows) => { world.sent.push({ text, rows }); return world.nextId++; },
    edit: async (id, text, rows) => { world.edited.push({ id, text, rows }); return true; },
    strip: async id => { world.stripped.push(id); return true; },
    del: async id => { world.deleted.push(id); return true; },
    answer: async (id, toast = '') => { world.answered.push(toast); return true; },
    pending: () => pending,
    loadV: () => world.store, saveV: v => { world.store = v; },
    loadChips: () => world.chipsState, saveChips: s => { world.chipsState = s; },
    loadList: () => world.listState, saveList: s => { world.listState = s; },
    hide: async ids => { world.hidden.push(...ids); },
    positives: () => positives,
  };
  return world;
}

{
  const pending = [
    { id: 705, title: 'Divorce Paralegal', company: 'Smith & Partners', location: 'Madrid, Spain' },
    { id: 698, title: 'Criminal Lawyer', company: 'Justice LLP', location: 'Madrid, Spain' },
  ];
  const w = fakeWorld({ pending, positives: ['lawyer'] });
  const off = { id: 412, title: 'Divorce Lawyer', company: 'Smith & Partners', location: 'Barcelona, Spain' };

  const msgId = await sendVetoChips(off, w.deps);
  eq(msgId, 100, 'the panel is sent and its message id kept');
  eq(w.chipsState.message_id, 100, 'the state is bound to that exact message');
  ok(w.sent[0].text.includes('#412'), 'the panel names the offer it came from');
  const chipCount = w.chipsState.chips.length;

  // ➤ A second rejection replaces the previous panel instead of piling up.
  await sendVetoChips(off, w.deps);
  eq(w.deleted, [100], 'a new panel deletes the old one — dead buttons never pile up');
  const panelId = w.chipsState.message_id;

  // ➤ Tap "Divorce".
  const divorceIdx = w.chipsState.chips.findIndex(c => c.value === 'Divorce');
  ok(await handleVetoCallback(`vt:a:${divorceIdx}`, panelId, 'cb1', w.deps), 'the veto namespace is ours');
  eq(w.store.titles, ['Divorce'], 'the tap became a standing veto');
  ok(w.chipsState.chips[divorceIdx].used, 'the chip is consumed, not deleted — indexes stay stable');
  const afterAdd = w.edited[w.edited.length - 1];
  ok(afterAdd.text.includes('#705'), 'the panel reports which pending offers the veto still matches');
  ok(!afterAdd.text.includes('#698'), 'and not the ones it does not');
  ok(afterAdd.rows.flat().some(b => /^Hide 1 matching now$/.test(b.label)), 'a hide-now button appears for the matches');
  ok(afterAdd.rows.flat().some(b => b.label === 'Undo Divorce'), 'with an undo right next to it');

  // ➤ A double tap on the same chip changes nothing.
  await handleVetoCallback(`vt:a:${divorceIdx}`, panelId, 'cb2', w.deps);
  eq(w.store.titles, ['Divorce'], 'a double tap does not duplicate the veto');

  // ➤ A tap on yesterday's panel is refused with a toast.
  const editsBefore = w.edited.length;
  await handleVetoCallback('vt:a:0', 55555, 'cb3', w.deps);
  ok(w.answered.some(a => /older rejection/.test(a)), 'a stale panel answers with a toast');
  eq(w.edited.length, editsBefore, 'and changes nothing');

  // ➤ Hide the matches now: the listener hides them the "seen" way.
  await handleVetoCallback('vt:h', panelId, 'cb4', w.deps);
  eq(w.hidden, [705], 'hide-now passes exactly the matching ids');
  ok(w.edited[w.edited.length - 1].text.includes('undo N'), 'and the panel says each one is still undoable');

  // ➤ Undo the veto: store clean, chip back on offer.
  await handleVetoCallback('vt:u:0', panelId, 'cb5', w.deps);
  eq(w.store.titles, [], 'undo removes the standing veto');
  ok(!w.chipsState.chips[divorceIdx].used, 'and the chip is offered again');
  eq(w.chipsState.chips.length, chipCount, 'the chips array never changed size');

  // ➤ Dismiss with nothing chosen deletes the panel outright.
  await handleVetoCallback('vt:d', panelId, 'cb6', w.deps);
  ok(w.deleted.includes(panelId), 'dismiss with nothing chosen removes the whole panel');
}

// ── The "vetoes" list panel ────────────────────────────────────────────────
{
  const w = fakeWorld({});
  w.store = { titles: ['Divorce'], companies: ['BadCorp'], cities: [] };
  const id = await startVetoList(w.deps);
  eq(id, 100, 'the list panel is sent');
  ok(w.sent[0].text.includes('Standing vetoes'), 'and titled as the standing vetoes');
  eq(w.sent[0].rows.length, 2, 'one remove button per veto');

  await handleVetoCallback('vt:r:0', id, 'cb1', w.deps);
  eq(w.store.titles, [], 'the remove tap deletes the veto');
  ok(w.edited[w.edited.length - 1].rows.length === 1, 'and the panel redraws with one button fewer');

  await handleVetoCallback('vt:r:0', 55555, 'cb2', w.deps);
  ok(w.answered.some(a => /older list/.test(a)), 'a stale list panel answers with a toast');

  const empty = fakeWorld({});
  await startVetoList(empty.deps);
  ok(/No standing vetoes/.test(empty.sent[0].text), 'an empty store says so instead of sending a blank panel');
  eq(empty.sent[0].rows.length, 0, 'with no buttons to mislead');
}

// ── Result ────────────────────────────────────────────────────────────────
if (failures) { console.log(`\n${failures}/${total} veto tests FAILED.`); process.exit(1); }
console.log(`All ${total} veto tests passed.`);
