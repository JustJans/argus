#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the state of every application you have sent. It turns the
// ➤ linked emails into one answer per offer: they replied, they said no, they
// ➤ want to talk, or nobody ever wrote back.
// ➤
// ➤ THE STATE THAT MATTERS MOST IS SILENCE. In the real mailbox there were 35
// ➤ acknowledgements and 5 rejections: companies almost never tell you no,
// ➤ they just stop. So "no reply after a while" is not missing data, it IS the
// ➤ outcome, and it has to be counted as one or the record flatters itself.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ THERE IS NO GRACE PERIOD, AND THAT IS DELIBERATE. There used to be one: an
// ➤ application younger than three days was held in a state of its own instead
// ➤ of counting as unanswered. It bought nothing. Measured on the real mailbox,
// ➤ every automated receipt arrived within the same HOUR of applying — so an
// ➤ application with no receipt is already saying something on day zero, and
// ➤ the number of days sits next to it in the report anyway. A reader can see
// ➤ that one is a day old; they could not see what a fifth colour meant.

// ➤ Ordered by how far the application got. A rejection is terminal wherever
// ➤ it arrives, so it is not on this ladder.
const RANK = { acknowledged: 1, interview: 2 };

// ➤ Builds one record per application:
// ➤   state    rejected | interview | acknowledged | noreply
// ➤   reached  everything that ever happened, in order — a rejection after an
// ➤            interview is a very different story from a form rejection, and
// ➤            one word cannot hold both
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
    // ➤ Read both: a hand-built fixture that put it one level up passed every
    // ➤ test while the real pipeline silently produced no states at all.
    const kinds = mine.map(l => l.kind || l.message?.kind).filter(Boolean);
    const applied = new Date(a.ts);
    const daysWaiting = isNaN(applied) ? null : Math.floor((now - applied) / 86_400_000);

    let state;
    if (kinds.includes('rejected')) state = 'rejected';
    else if (kinds.length) {
      // ➤ The furthest it got, not the latest thing that arrived: a second
      // ➤ automated receipt after an invitation must not walk it backwards.
      state = kinds.reduce((best, k) => (RANK[k] || 0) > (RANK[best] || 0) ? k : best, kinds[0]);
    } else state = 'noreply';

    return {
      id: a.id,
      company: a.company,
      title: a.title,
      applied: a.ts,
      longshot: !!a.longshot,
      state,
      reached: kinds,
      daysWaiting,
      // ➤ Kept so a wrong link can be traced back to the reason it was made.
      evidence: mine.map(l => ({ kind: l.kind || l.message?.kind, date: l.message.date, why: l.why, score: l.score })),
    };
  });
}

// ➤ A short human summary. EVERY application is counted, longshots included:
// ➤ you sent them, so they are part of where things stand and the totals have
// ➤ to add up to what you actually did.
// ➤ They are still reported separately underneath, for one narrow purpose: a
// ➤ longshot was sent knowing it fell short, so its rejection says nothing
// ➤ about whether the FILTER is choosing well. Anything that judges the search
// ➤ should read `excludingLongshots`; anything that reports to you should read
// ➤ the top-level numbers.
export function summarise(records) {
  const tally = list => ({
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
