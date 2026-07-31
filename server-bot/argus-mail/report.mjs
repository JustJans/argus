#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "status" command's text.
// ➤
// ➤ NOTHING IS CUT SHORT. An earlier version clipped company and job titles
// ➤ with an ellipsis to keep every row on one line, which produced things like
// ➤ "Production Automation Sys…" — less information than the full name and it
// ➤ looks broken. Long rows wrap on a phone, and that is fine.
// ➤
// ➤ THE ORDER IS HOW FAR EACH ONE GOT, least first: no answer, receipt,
// ➤ rejection, interview. EVERY CIRCLE HAS ITS WORD NEXT TO IT — the count
// ➤ line used to be five colours and five numbers and meant nothing unless you
// ➤ already knew the code.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ Escaped because company and job titles come from job boards and really do
// ➤ contain "&" and "<". Telegram rejects the whole message if they arrive raw.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ➤ FOUR COLOURS, NOT SIX. Every state the code tracks does not need a colour
// ➤ of its own in the message: past four the reader is decoding a legend
// ➤ instead of reading a list. A blue "just sent" and an orange "never
// ➤ arrived" were both tried and both thrown out for that.
// ➤ So a line in the count can cover MORE THAN ONE state. Ghosted and rejected
// ➤ share one — after two months of silence the answer is the same, and the
// ➤ difference between "they said no" and "they never said anything" survives
// ➤ where it belongs, in the record, not as a second shade of red.
const STATES = [
  // ➤ Listed first, and grouped with the ones that never answered, because
  // ➤ that is what it is — the difference being that this one is still in your
  // ➤ hands: nobody read the application, so applying again is a real move.
  { keys: ['bounced'], dot: '⚪', label: 'Never arrived', title: 'Never arrived' },
  { keys: ['noreply'], dot: '⚪', label: 'N/A', title: 'N/A' },
  { keys: ['acknowledged'], dot: '🟡', label: 'Received', title: 'Received' },
  { keys: ['rejected', 'ghosted'], dot: '🔴', label: 'Rejected/Ghosted', title: 'Rejected' },
  // ➤ ALWAYS SHOWN, even at zero, and it is the only one. Every other state is
  // ➤ hidden when nobody is in it because an empty count is not news — but
  // ➤ this is the one you are doing all of it for, so "0 Interview" says
  // ➤ something, and a green circle missing from the line reads as a fault.
  { keys: ['interview'], dot: '🟢', label: 'Interview', title: 'Interview', always: true },
];

// ➤ Which ones are worth reading one by one. A rejection is closed: it is
// ➤ counted above and left there.
const LISTED = ['bounced', 'noreply', 'acknowledged', 'interview'];

// ➤ The whole message, as one string of Telegram HTML: a count line, then a
// ➤ section per state worth reading one by one. Takes the file the nightly run
// ➤ wrote and nothing else — no clock, no network, no disk — so the `mail`
// ➤ command answers the instant it is typed.
export function formatStatus(status) {
  if (!status?.applications?.length) {
    return 'No applications on record yet. Mark one with <code>applied N</code> and this fills up.';
  }
  const apps = status.applications;
  const of = keys => apps.filter(a => keys.includes(a.state));
  const out = [];

  out.push(`<b>Applications — ${apps.length}</b>`);
  // ➤ A state nobody is in says nothing worth a line — "0 never arrived · 0
  // ➤ ghosted" was most of the count and none of the information. The one
  // ➤ exception is the interview: that is what all of this is for, so its
  // ➤ count belongs there whatever it says.
  out.push(STATES.map(s => ({ s, n: of(s.keys).length })).filter(x => x.n || x.s.always)
    .map(({ s, n }) => `${s.dot} ${n} ${s.label}`).join(' · '));

  for (const s of STATES) {
    let list = of(s.keys.filter(k => LISTED.includes(k)));
    if (!list.length) continue;
    // ➤ Longest silence first. With no separate state for the recent ones,
    // ➤ this is what keeps the ones worth chasing at the top of the section.
    if (s.keys.includes('noreply')) list = list.slice().sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));
    out.push('');
    out.push(`<b>${s.dot} ${s.title}</b>`);
    for (const a of list) {
      // ➤ How long nobody has answered is the point of that section. In
      // ➤ brackets because job titles have hyphens of their own ("Applied AI
      // ➤ Engineer - AI Neobank App"), and a third one read as part of the job.
      // ➤ Only when it is a real number: an application with an unreadable date
      // ➤ printed "(nulld)".
      const days = s.keys.includes('noreply') && typeof a.daysWaiting === 'number' ? ` (${a.daysWaiting}d)` : '';
      // ➤ In English wherever there is an English version. The employer's own
      // ➤ wording is kept in the file, so the posting is still findable on
      // ➤ their site; what reaches the phone reads in one language.
      out.push(`#${a.id} ${esc(a.company)} - ${esc(a.titleEn || a.title)}${days}`);
    }
  }

  if (status.unlinked?.ambiguous) {
    out.push('');
    out.push(`<i>${status.unlinked.ambiguous} email(s) fit more than one application and were left unassigned.</i>`);
  }
  return out.join('\n');
}
