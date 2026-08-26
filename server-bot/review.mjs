#!/usr/bin/env node

// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "review" mode — the pending offers one CARD at a time,
// ➤ with buttons instead of typed commands (owner-approved 2026-08-22 after
// ➤ a mockup; the 2026-07-18 veto on buttons stays for the LIST, where a
// ➤ keyboard under 25 offers cannot say which button belongs to which line).
// ➤ ONE message is the card; every tap edits it in place, so the chat stays
// ➤ clean. Decisions run the SAME actions as the typed commands — same
// ➤ records, same honesty checks — injected by the listener; the card itself
// ➤ is the confirmation, so no extra message lands in the chat.
// ➤ EVERY DECISION IS REVERSIBLE, in three layers: the decided card keeps an
// ➤ Undo button; older decisions are reachable by navigating back to their
// ➤ card; and "undo N" works typed, any time, card or no card. Undo restores
// ➤ the pending line AND removes the record the decision wrote (feedback or
// ➤ application), so a slip of the finger cannot poison the learning data.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { writeFileAtomic, withFileLock } from './fs-atomic.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pendingOffers } from './list-offers.mjs';
import { restorePendingInLines } from './seen.mjs';
import { esc, sendTelegramButtons, editTelegramButtons, answerCallback, sendTelegramMessage, deleteTelegramMessage, councilVerdicts } from './notify.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
// ➤ The whole session on disk: which message is the card, which offer it
// ➤ shows, and what was decided — {message_id, idx, offers, decisions, ts}.
// ➤ On disk and not in memory for the same reason as the list pages: the
// ➤ listener can restart between two taps, and the file is the only bridge.
export const REVIEW_STATE_PATH = join(ROOT, 'data', 'review-state.json');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
// ➤ Where "no" and "applied" append their one-line records; undo removes the
// ➤ exact line it can prove was written by the decision being reverted.
const FEEDBACK_PATH = join(SCRIPT_DIR, 'feedback.jsonl');
const APPLIED_PATH = join(ROOT, 'data', 'applications.jsonl');

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

// ➤ What the card SAYS about each decision: one word. Icons were tried on
// ➤ buttons and states (2026-08-22) and the owner pulled them the same day —
// ➤ plain labels only, and bare arrows.
const KIND_LABEL = { seen: 'Seen', no: 'Discarded', applied: 'Applied' };

// ➤ The card's keyboard. A decided offer offers only Undo and the arrows; a
// ➤ pending one offers the link plus the four actions. Only arrows that lead
// ➤ somewhere are shown — the same rule as the list's page row.
export function reviewKeyboard(state) {
  const o = state.offers[state.idx];
  const total = state.offers.length;
  const nav = [];
  if (state.idx > 0) nav.push({ label: '◀', data: 'rv:prev' });
  nav.push({ label: `${state.idx + 1}/${total}`, data: 'rv:cur' });
  if (state.idx < total - 1) nav.push({ label: '▶', data: 'rv:next' });
  if (state.decisions[o.id]) return [[{ label: 'Undo', data: 'rv:undo' }], nav];
  const rows = [];
  // ➤ A URL button with a malformed link makes Telegram refuse the WHOLE
  // ➤ message, buttons, card and all — so the row only exists for real links.
  if (/^https?:\/\//.test(o.url || '')) rows.push([{ label: 'Open offer', url: o.url }]);
  rows.push([{ label: 'Applied', data: 'rv:applied' }, { label: 'Cover', data: 'rv:cover' }]);
  rows.push([{ label: 'Seen', data: 'rv:seen' }, { label: 'No', data: 'rv:no' }]);
  rows.push(nav);
  return rows;
}

// ➤ The card's text: two lines for a pending offer, a struck title and one
// ➤ word for a decided one. Everything shown comes from a job portal or from
// ➤ the pipeline, so it is escaped — a title with "<" must not kill the card.
// ➤ The Council's word rides the title line exactly as it does on the list
// ➤ ([YES]/[MYB]/[NO], field find 2026-08-25: review shipped without it) —
// ➤ and only on the PENDING card: a decided one is a receipt, the advice
// ➤ already did its job.
export function reviewCardText(state) {
  const o = state.offers[state.idx];
  const d = state.decisions[o.id];
  const facts = [o.company, o.location, o.salary].filter(Boolean).map(esc).join(' · ');
  if (d) {
    return `<s>#${o.id} — ${esc(o.title)}</s>\n${KIND_LABEL[d.kind] || 'Decided'}${d.warn ? `\n${esc(d.warn)}` : ''}`;
  }
  return `<b>#${o.id} — ${esc(o.title)}</b>${o.verdict ? ` [${o.verdict}]` : ''}\n${facts}`;
}

// ➤ Removes ONE record from a .jsonl file: the line whose id matches — and,
// ➤ when a timestamp is known, whose ts matches too. Without a timestamp the
// ➤ LAST matching line goes (a typed "undo 845" reverting a typed "no 845");
// ➤ with one, exactly the line the button wrote. Under the file lock, like
// ➤ every writer of these files.
export function removeJsonlRecord(path, id, ts = null, io = { read: p => readFileSync(p, 'utf-8'), write: writeFileAtomic, lock: withFileLock }) {
  let removed = false;
  io.lock(path, () => {
    let text;
    try { text = io.read(path); } catch { return; /* no file: nothing to remove */ }
    const lines = text.split('\n');
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r.id !== id) continue;
        if (ts != null && r.ts !== ts) continue;
        hit = i;
        if (ts != null) break; // exact match: done. Without ts, keep going — last wins.
      } catch { /* corrupt line: not ours to touch */ }
    }
    if (hit === -1) return;
    lines.splice(hit, 1);
    io.write(path, lines.join('\n'));
    removed = true;
  });
  return removed;
}

// ➤ The undo itself, shared by the card button and the typed "undo N":
// ➤ puts the offer's line back to "- [ ]" in the pipeline (only lines carrying
// ➤ the "| visto" tag — a line hidden by the cleanup was not your decision and
// ➤ is not restored), then removes the record the decision wrote. Returns what
// ➤ actually happened, so the caller can be honest about it.
export function undoDecision(id, decision = null, deps = {}) {
  const d = {
    lock: withFileLock, read: readFileSync, write: writeFileAtomic,
    removeRecord: removeJsonlRecord,
    feedbackPath: FEEDBACK_PATH, appliedPath: APPLIED_PATH, pipelinePath: PIPELINE_PATH,
    ...deps,
  };
  let restored = false;
  d.lock(d.pipelinePath, () => {
    let text;
    try { text = d.read(d.pipelinePath, 'utf-8'); } catch { return; }
    const r = restorePendingInLines(text.split('\n'), id);
    if (r.restored) { d.write(d.pipelinePath, r.lines.join('\n')); restored = true; }
  });
  // ➤ The side record goes even when the line was already back (a double
  // ➤ undo must not leave a phantom rejection behind).
  const kind = decision?.kind;
  const ts = decision?.recTs || null;
  let recordRemoved = false;
  if (kind === 'no' || kind == null) recordRemoved = d.removeRecord(d.feedbackPath, id, ts) || recordRemoved;
  if (kind === 'applied' || kind == null) recordRemoved = d.removeRecord(d.appliedPath, id, ts) || recordRemoved;
  return { restored, recordRemoved };
}

// ➤ Opens the review: a snapshot of the pending list becomes the deck, and
// ➤ the first card is sent. The snapshot is deliberate — decided offers must
// ➤ STAY in the deck (that is where late Undo lives), which the live pending
// ➤ list cannot give. A previous card, if any, is deleted: one deck at a time.
export async function startReview(deps = {}) {
  const d = {
    pending: pendingOffers, send: sendTelegramButtons, notify: sendTelegramMessage,
    del: deleteTelegramMessage,
    load: () => loadJson(REVIEW_STATE_PATH, null),
    save: s => writeFileAtomic(REVIEW_STATE_PATH, JSON.stringify(s)),
    verdicts: councilVerdicts,
    ...deps,
  };
  const offers = d.pending().filter(o => o.id != null);
  if (!offers.length) { await d.notify('No pending offers to review.'); return null; }
  const prev = d.load();
  if (prev?.message_id != null) { try { await d.del(prev.message_id); } catch { /* already gone */ } }
  // ➤ The judges' word is read ONCE, when the deck is cut: the snapshot the
  // ➤ cards page through is frozen, so its verdicts freeze with it. Keyed by
  // ➤ url first and by #id as the fallback, same as the list. With the
  // ➤ Council off, verdicts() is null and every card reads as before.
  const v = d.verdicts();
  const state = {
    message_id: null, idx: 0,
    offers: offers.map(o => ({ id: o.id, title: o.title, company: o.company, location: o.location, salary: o.salary, url: o.url, verdict: v?.get(o.url) || v?.get('#' + o.id) || '' })),
    decisions: {}, ts: new Date().toISOString(),
  };
  const id = await d.send(reviewCardText(state), reviewKeyboard(state), { html: true });
  if (id == null) return null;
  state.message_id = id;
  d.save(state);
  return id;
}

// ➤ One tap on the card. Returns false only when the tap is not a review
// ➤ button at all, so the listener can route it elsewhere. The stored
// ➤ message_id must match the tapped message — a tap on an older card gets a
// ➤ toast, never a redraw of the wrong thing (same contract as the list).
// ➤ The action deps (seen/reject/applied/cover) are the listener's own
// ➤ command handlers in quiet mode: one code path for buttons and keyboard.
export async function handleReviewCallback(data, messageId, cbId, deps = {}) {
  const d = {
    load: () => loadJson(REVIEW_STATE_PATH, null),
    save: s => writeFileAtomic(REVIEW_STATE_PATH, JSON.stringify(s)),
    edit: editTelegramButtons, answer: answerCallback,
    start: startReview, undo: undoDecision,
    seen: null, reject: null, applied: null, cover: null,
    ...deps,
  };
  const m = String(data || '').match(/^rv:(start|prev|next|cur|seen|no|applied|cover|undo)$/);
  if (!m) return false;
  const kind = m[1];
  if (kind === 'start') { await d.answer(cbId); await d.start(); return true; }
  if (kind === 'cur') { await d.answer(cbId); return true; }
  const st = d.load();
  if (!st || st.message_id !== messageId || !Array.isArray(st.offers) || !st.offers.length) {
    await d.answer(cbId, 'This review is outdated — send "review" for a fresh one.');
    return true;
  }
  const offer = st.offers[st.idx];
  const redraw = () => d.edit(messageId, reviewCardText(st), reviewKeyboard(st), { html: true });

  if (kind === 'prev' || kind === 'next') {
    // ➤ Answer FIRST, here and below: the spinner dies the instant the tap is
    // ➤ seen (the same perceived-speed rule the page buttons follow).
    await d.answer(cbId);
    const to = st.idx + (kind === 'next' ? 1 : -1);
    st.idx = Math.min(Math.max(to, 0), st.offers.length - 1);
    d.save(st);
    await redraw();
    return true;
  }
  if (kind === 'cover') {
    await d.answer(cbId, 'Generating the cover letter — the PDF arrives here.');
    await d.cover(offer.id);
    return true;
  }
  if (kind === 'undo') {
    await d.answer(cbId);
    const r = d.undo(offer.id, st.decisions[offer.id]);
    delete st.decisions[offer.id];
    d.save(st);
    await redraw();
    // ➤ The list below the card must show the offer again.
    if (r.restored && d.refresh) await d.refresh();
    return true;
  }
  // ➤ The three decisions. A second tap on an already-decided offer only
  // ➤ stops the spinner: whatever raced it in first already holds the truth.
  if (st.decisions[offer.id]) { await d.answer(cbId); return true; }
  await d.answer(cbId);
  const act = { seen: d.seen, no: d.reject, applied: d.applied }[kind];
  const out = (await act(offer)) || {};
  st.decisions[offer.id] = {
    kind,
    // ➤ recTs pins the exact record line for undo; at orders decisions in
    // ➤ time, so a bare "undo" knows which one was last (seen has no record,
    // ➤ so recTs alone cannot order them).
    recTs: out.recTs || null,
    at: new Date().toISOString(),
    ...(out.warn ? { warn: out.warn } : {}),
  };
  d.save(st);
  await redraw();
  return true;
}
