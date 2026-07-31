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

// ➤ The four states, in the order they are shown, with the word for the colour.
// ➤ THERE IS NO FIFTH. A blue "just sent" used to sit at the end for anything
// ➤ under three days old; it was removed because it told a reader nothing the
// ➤ number of days beside each row does not already say.
const STATES = [
  { key: 'noreply', dot: '⚪', label: 'N/A', title: 'N/A' },
  { key: 'acknowledged', dot: '🟡', label: 'received', title: 'Received' },
  { key: 'rejected', dot: '🔴', label: 'rejected', title: 'Rejected' },
  { key: 'interview', dot: '🟢', label: 'interview', title: 'Interview' },
];

// ➤ Which ones are worth reading one by one. A rejection is closed: it is
// ➤ counted above and left there.
const LISTED = ['noreply', 'acknowledged', 'interview'];

export function formatStatus(status) {
  if (!status?.applications?.length) {
    return 'No applications on record yet. Mark one with <code>applied N</code> and this fills up.';
  }
  const apps = status.applications;
  const of = key => apps.filter(a => a.state === key);
  const out = [];

  out.push(`<b>Applications — ${apps.length}</b>`);
  out.push(STATES.map(s => `${s.dot} ${of(s.key).length} ${s.label}`).join(' · '));

  for (const s of STATES) {
    let list = LISTED.includes(s.key) ? of(s.key) : [];
    if (!list.length) continue;
    // ➤ Longest silence first. With no separate state for the recent ones,
    // ➤ this is what keeps the ones worth chasing at the top of the section.
    if (s.key === 'noreply') list = list.slice().sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));
    out.push('');
    out.push(`<b>${s.dot} ${s.title}</b>`);
    for (const a of list) {
      // ➤ How long nobody has answered is the point of that section. In
      // ➤ brackets because job titles have hyphens of their own ("Applied AI
      // ➤ Engineer - AI Neobank App"), and a third one read as part of the job.
      // ➤ Only when it is a real number: an application with an unreadable date
      // ➤ printed "(nulld)".
      const days = s.key === 'noreply' && typeof a.daysWaiting === 'number' ? ` (${a.daysWaiting}d)` : '';
      out.push(`#${a.id} ${esc(a.company)} - ${esc(a.title)}${days}`);
    }
  }

  if (status.unlinked?.ambiguous) {
    out.push('');
    out.push(`<i>${status.unlinked.ambiguous} email(s) fit more than one application and were left unassigned.</i>`);
  }
  return out.join('\n');
}
