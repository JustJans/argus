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

// ➤ WHEN WAITING BECOMES AN ANSWER. Two months of nothing is a no that nobody
// ➤ bothered to write. Counted from the LAST thing that happened, not from the
// ➤ day you applied: an employer who acknowledged you in July and went quiet
// ➤ has been quiet since July, not since the application.
// ➤ An interview is never ghosted — that conversation is worth chasing, and
// ➤ calling it dead on a calendar would be the bot deciding for you.
export const GHOSTED_AFTER_DAYS = 60;

// ➤ Ordered by how far the application got. A rejection is terminal wherever
// ➤ it arrives, so it is not on this ladder.
const RANK = { acknowledged: 1, interview: 2 };

// ➤ Builds one record per application:
// ➤   state    bounced | rejected | interview | acknowledged | noreply
// ➤   reached  everything that ever happened, in order — a rejection after an
// ➤            interview is a very different story from a form rejection, and
// ➤            one word cannot hold both
// ➤ WHAT YOU KNOW BEATS WHAT THE INBOX SAYS. Some employers never write: they
// ➤ post the verdict on their own portal, or their address bounces and they
// ➤ never notice. Nothing arrives, so nothing can be read, and the application
// ➤ sits under "no reply" for ever although you already know how it ended.
// ➤ `no N` records that, and this is where it wins: the nightly run rebuilds
// ➤ everything from mail, so without an override it would erase your answer
// ➤ every midnight. Shape: { id, state, reason, ts }, newest wins.
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
    // ➤ IT NEVER ARRIVED, so nothing else that happened to it matters. Checked
    // ➤ before the rest because it is not a verdict on you — it is the reason
    // ➤ there is no verdict, and the only one of these states you can still do
    // ➤ something about.
    if (kinds.includes('bounced')) state = 'bounced';
    else if (kinds.includes('rejected')) state = 'rejected';
    else if (kinds.length) {
      // ➤ The furthest it got, not the latest thing that arrived: a second
      // ➤ automated receipt after an invitation must not walk it backwards.
      state = kinds.reduce((best, k) => (RANK[k] || 0) > (RANK[best] || 0) ? k : best, kinds[0]);
    } else state = 'noreply';

    // ➤ GHOSTED. Two months of nothing after the last thing that happened, and
    // ➤ waiting stops being waiting. Only from the two states that are still
    // ➤ open: a rejection is already answered and an interview is worth
    // ➤ chasing, so neither is aged out by a calendar.
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
