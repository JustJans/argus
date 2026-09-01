#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ One answer per application, built from its linked emails: they replied,
// ➤ they said no, they want to talk, or nobody ever wrote back.
// ➤
// ➤ SILENCE IS THE STATE THAT MATTERS. The real mailbox held 35 receipts and
// ➤ 5 rejections: companies stop writing instead of saying no. So "no reply
// ➤ after a while" is not missing data, it IS the outcome, and counting it as
// ➤ one is what keeps the record from flattering itself.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ NO GRACE PERIOD, DELIBERATELY. An application younger than three days used
// ➤ to be held in a state of its own. It bought nothing: every automated
// ➤ receipt in the real mailbox arrived within the same HOUR of applying, so
// ➤ an application with no receipt is already saying something on day zero.
// ➤ The age sits next to it in the report anyway, and a reader understands
// ➤ "one day old" where they could not read a fifth colour.

// ➤ WHEN WAITING BECOMES AN ANSWER: two months of nothing is a no that nobody
// ➤ bothered to write. Counted from the LAST thing that happened, not from the
// ➤ day you applied — an employer who acknowledged you in July and went quiet
// ➤ has been quiet since July. An interview is never ghosted: that conversation
// ➤ is worth chasing, and calling it dead on a calendar would be the bot
// ➤ deciding for you.
export const GHOSTED_AFTER_DAYS = 60;

// ➤ Ordered by how far the application got. A rejection is terminal wherever
// ➤ it arrives, so it is not on this ladder.
const RANK = { acknowledged: 1, interview: 2 };

// ➤ WHAT YOU KNOW BEATS WHAT THE INBOX SAYS. Some employers never write: they
// ➤ post the verdict on their own portal, or their address bounces and they
// ➤ never notice. Nothing arrives, so nothing can be read, and the application
// ➤ sits under "no reply" for ever although you already know how it ended.
// ➤ `no N` records that, and it has to be replayed here because the nightly
// ➤ run rebuilds everything from mail and would otherwise erase your answer
// ➤ every midnight. Verdicts are { id, state, reason, ts }; newest wins.
export function applyVerdicts(records, verdicts) {
  if (!verdicts?.length) return records;
  const latest = new Map();
  for (const v of verdicts) {
    if (!v || !Number.isFinite(Number(v.id)) || !v.state) continue;
    const prev = latest.get(Number(v.id));
    if (!prev || new Date(v.ts || 0) >= new Date(prev.ts || 0)) latest.set(Number(v.id), v);
  }
  return records.map(r => {
    const v = latest.get(Number(r.id));
    // ➤ `reached` is left alone on purpose: it is what actually HAPPENED, and
    // ➤ your decision does not rewrite the history of the messages.
    return v ? { ...r, state: v.state, decidedByYou: true, decidedWhy: v.reason || '' } : r;
  });
}

// ➤ ONE RECORD PER APPLICATION, built from the messages linked to it:
// ➤   state        bounced, rejected, interview, acknowledged, noreply or
// ➤                ghosted
// ➤   reached      every kind of message that ever arrived, in order. A
// ➤                rejection AFTER an interview is a different story from a
// ➤                form rejection, and one word cannot hold both
// ➤   daysWaiting  how long since you applied
// ➤   evidence     why each link was made, so a wrong one can be traced
// ➤ `today` is injected rather than read from the clock, because a function
// ➤ that decides things by date cannot be tested if it insists on now.
export function buildStatus(applications, links, { today = new Date() } = {}) {
  const byApp = new Map();
  for (const l of links) {
    const id = l.application.id;
    if (!byApp.has(id)) byApp.set(id, []);
    byApp.get(id).push(l);
  }

  const now = today instanceof Date ? today : new Date(today);

  return applications.map(a => {
    const mine = (byApp.get(a.id) || []).slice().sort((x, y) => new Date(x.message.date) - new Date(y.message.date));
    // ➤ linkOutcomes leaves the classification on the MESSAGE, not on the link.
    // ➤ Reading only one of the two made every test pass on a hand-built
    // ➤ fixture while the real pipeline produced no states at all.
    const kinds = mine.map(l => l.kind || l.message?.kind).filter(Boolean);
    const applied = new Date(a.ts);
    const daysWaiting = isNaN(applied) ? null : Math.floor((now - applied) / 86_400_000);

    let state;
    // ➤ IT NEVER ARRIVED, so nothing else that happened to it matters. First because it is not
    // ➤ a verdict on you but the reason there is none — and the only one of these states you
    // ➤ can still do something about. UNLESS SOMETHING CAME BACK: match.mjs deliberately fans
    // ➤ an ambiguous bounce out to every application at the same employer, so a bounce sitting
    // ➤ next to a receipt, a rejection or an interview is proof the bounce belonged to ANOTHER
    // ➤ application there — not that this one never arrived. Burying an interview under "Never
    // ➤ arrived" is the loss this module calls its most expensive.
    const replied = kinds.some(k => k === 'acknowledged' || k === 'interview' || k === 'rejected');
    if (kinds.includes('bounced') && !replied) state = 'bounced';
    else if (kinds.includes('rejected')) state = 'rejected';
    else if (kinds.length) {
      // ➤ The furthest it got, not the latest thing that arrived: a second
      // ➤ automated receipt after an invitation must not walk it backwards.
      state = kinds.reduce((best, k) => (RANK[k] || 0) > (RANK[best] || 0) ? k : best, kinds[0]);
    } else state = 'noreply';

    // ➤ Only the two states still open can age into `ghosted`: a rejection is
    // ➤ already answered, and an interview is worth chasing.
    const lastEvent = mine.length ? new Date(mine[mine.length - 1].message.date) : applied;
    const daysSince = isNaN(lastEvent) ? null : Math.floor((now - lastEvent) / 86_400_000);
    if ((state === 'noreply' || state === 'acknowledged') && daysSince != null && daysSince >= GHOSTED_AFTER_DAYS) {
      state = 'ghosted';
    }

    return {
      id: a.id,
      company: a.company,
      title: a.title,
      applied: a.ts,
      longshot: !!a.longshot,
      state,
      reached: kinds,
      daysWaiting,
      evidence: mine.map(l => ({ kind: l.kind || l.message?.kind, date: l.message.date, why: l.why, score: l.score })),
    };
  });
}

// ➤ A short human summary. EVERY application is counted, longshots included:
// ➤ you sent them, so the totals have to add up to what you actually did.
// ➤ They are also reported apart, for one narrow purpose: a longshot was sent
// ➤ knowing it fell short, so its rejection says nothing about whether the
// ➤ FILTER is choosing well. Anything that judges the search should read
// ➤ `excludingLongshots`; anything that reports to you, the top-level numbers.
export function summarise(records) {
  const tally = list => ({
    bounced: list.filter(r => r.state === 'bounced').length,
    ghosted: list.filter(r => r.state === 'ghosted').length,
    interview: list.filter(r => r.state === 'interview').length,
    rejected: list.filter(r => r.state === 'rejected').length,
    acknowledged: list.filter(r => r.state === 'acknowledged').length,
    noreply: list.filter(r => r.state === 'noreply').length,
    answered: list.filter(r => r.reached.length).length,
  });
  const real = records.filter(r => !r.longshot);
  return {
    applications: records.length,
    longshots: records.length - real.length,
    ...tally(records),
    excludingLongshots: tally(real),
  };
}
