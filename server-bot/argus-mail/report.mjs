#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "status" command's text.
// ➤
// ➤ NOTHING IS CUT SHORT. Clipping company and job titles with an ellipsis to keep every
// ➤ row on one line produces things like "Production Automation Sys…" — less information
// ➤ than the full name, and it looks broken. Long rows wrap on a phone, and that is fine.
// ➤
// ➤ THE ORDER IS HOW FAR EACH ONE GOT, least first: no answer, receipt, rejection,
// ➤ interview. EVERY CIRCLE HAS ITS WORD NEXT TO IT — five colours and five numbers mean
// ➤ nothing unless you already know the code.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ Escaped because company and job titles come from job boards and really do
// ➤ contain "&" and "<". Telegram rejects the whole message if they arrive raw.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ➤ FOUR COLOURS, NOT SIX: past four the reader is decoding a legend instead of reading a
// ➤ list (a blue "just sent" and an orange "never arrived" were both tried and thrown
// ➤ out). So a line in the count can cover MORE THAN ONE state: ghosted and rejected share
// ➤ one — after two months of silence the answer is the same, and the difference survives
// ➤ where it belongs, in the record, not as a second shade of red.
const STATES = [
  // ➤ Listed first, and grouped with the ones that never answered, because that is what it
  // ➤ is — except that this one is still in your hands: nobody read the application, so
  // ➤ applying again is a real move.
  { keys: ['bounced'], dot: '⚪', label: 'Never arrived', title: 'Never arrived' },
  { keys: ['noreply'], dot: '⚪', label: 'N/A', title: 'N/A' },
  { keys: ['acknowledged'], dot: '🟡', label: 'Received', title: 'Received' },
  { keys: ['rejected', 'ghosted'], dot: '🔴', label: 'Rejected/Ghosted', title: 'Rejected' },
  // ➤ ALWAYS SHOWN, even at zero, and it is the only one: every other state is hidden when
  // ➤ nobody is in it, because an empty count is not news — but this is the one you are
  // ➤ doing all of it for, so "0 Interview" says something, and a missing green circle reads
  // ➤ as a fault.
  { keys: ['interview'], dot: '🟢', label: 'Interview', title: 'Interview', always: true },
];

// ➤ Which ones are worth reading one by one (a rejection is closed: counted above and left
// ➤ there). Spelled out as the STATE KEYS of the entries above rather than a second
// ➤ hand-written list: a state added to STATES and forgotten here would be counted in the
// ➤ header and never listed — and the stray-state guard below would not notice, because it
// ➤ only checks against STATES.
const LISTED_LABELS = ['Never arrived', 'N/A', 'Received', 'Interview'];
const LISTED = STATES.filter(s => LISTED_LABELS.includes(s.title)).flatMap(s => s.keys);

// ➤ The whole message, as one string of Telegram HTML: a count line, then a section per
// ➤ state worth reading one by one. Takes the file the nightly run wrote and nothing else
// ➤ — no clock, no network, no disk — so `mail` answers the instant it is typed.
export function formatStatus(status) {
  // ➤ AN ARRAY, not merely something with a length: a string has a length too, so a status
  // ➤ file whose "applications" arrived as text would sail past this guard and die on the
  // ➤ next line with "apps.filter is not a function" (found by feeding the command a
  // ➤ deliberately malformed file). A half-written file, a bad merge or a hand edit does
  // ➤ produce that shape, and the answer to a broken file is to say so, not a stack trace.
  if (!Array.isArray(status?.applications) || !status.applications.length) {
    return 'No applications on record yet. Mark one with <code>applied N</code> and this fills up.';
  }
  const apps = status.applications;
  const of = keys => apps.filter(a => keys.includes(a.state));
  const out = [];

  out.push(`<b>Applications — ${apps.length}</b>`);
  // ➤ NOTHING MAY FALL BETWEEN THE STATES. The states this report knows about are the ones
  // ➤ listed above; an application in any other state would appear in no section AND in no
  // ➤ count while the header line right here still added it to the total — numbers that
  // ➤ quietly contradict each other, and one of your applications nowhere on the screen. It
  // ➤ is an easy state to reach: rename a state in one file and forget the other. A report
  // ➤ that admits it is confused is better than one that hides an application, so it says so
  // ➤ out loud, with the unknown names.
  const KNOWN = new Set(STATES.flatMap(s => s.keys));
  const stray = apps.filter(a => !KNOWN.has(a.state));
  if (stray.length) out.push(`⚠️ ${stray.length} application(s) in an unknown state: ${[...new Set(stray.map(a => a.state))].join(', ')}`);
  // ➤ A state nobody is in says nothing worth a line — "0 never arrived · 0 ghosted" was
  // ➤ most of the count and none of the information. The one exception is the interview:
  // ➤ what all of this is for, so its count belongs there whatever it says.
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
      // ➤ In English wherever there is an English version; the employer's own wording stays in
      // ➤ the file, so the posting is still findable on their site, and what reaches the phone
      // ➤ reads in one language.
      out.push(`#${a.id} ${esc(a.company)} - ${esc(a.titleEn || a.title)}${days}`);
    }
  }

  if (status.unlinked?.ambiguous) {
    out.push('');
    out.push(`<i>${status.unlinked.ambiguous} email(s) fit more than one application and were left unassigned.</i>`);
    // ➤ NAME THEM. A bare count is not something you can act on: it does not say which
    // ➤ applications are tangled, nor whether the message was a refusal or an invitation — and
    // ➤ an invitation left unassigned is the most expensive thing this whole module handles.
    // ➤ With the numbers in front of you, "no N" settles a refusal and you know to go and read
    // ➤ the mail yourself when it is an invitation.
    const cases = status.unlinked.cases || [];
    for (const t of cases.slice(0, 5)) {
      const label = { interview: 'an interview', rejected: 'a refusal', acknowledged: 'a receipt', bounced: 'a bounce' }[t.kind] || 'a message';
      out.push(`<i>  · ${label} that fits ${t.ids.map(i => '#' + i).join(' or ')}</i>`);
    }
    // ➤ SAY WHAT WAS LEFT OUT: stopping in silence reads as "that was all", and
    // ➤ the sixth could be the interview invitation.
    if (cases.length > 5) out.push(`<i>  · and ${cases.length - 5} more, in data/application-status.json</i>`);
  }
  return out.join('\n');
}
