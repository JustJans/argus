#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ Tests for reading the inbox. Every fixture here is INVENTED: real mail
// ➤ never goes into a test file, and a test that needs a live mailbox is a
// ➤ test nobody can run.
// ➤ RUN: node server-bot/argus-mail/test-mail.mjs   (part of `npm test`)
// ➤ ═══════════════════════════════════════════════════════════════════════

import { classifyMessage, looksAutomated } from './classify.mjs';
import { scoreLink, linkOutcomes, tokens, senderName, senderDomainCore } from './match.mjs';
import { buildStatus, summarise, applyVerdicts } from './status.mjs';
import { windowFrom, gmailDate, searchFor } from './listen.mjs';
import { formatStatus } from './report.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ── 1) Telling the four kinds of message apart ────────────────────────────
{
  const c = (subject, snippet = '', body = '') => classifyMessage({ subject, snippet, body, from: 'x@y.com' });

  eq(c('Your application to Acme'), null, 'a bare subject with no wording decides nothing');
  eq(c('We have received your application'), 'acknowledged', 'the automated receipt');
  eq(c('Hemos recibido tu candidatura'), 'acknowledged', 'the receipt in Spanish');
  eq(c('Bedankt voor je sollicitatie'), 'acknowledged', 'and in Dutch');
  eq(c('Vielen Dank für Ihre Bewerbung'), 'acknowledged', 'and in German, accents and all');

  eq(c('Unfortunately we will not be proceeding'), 'rejected', 'a refusal');
  eq(c('Lamentamos comunicarte que no continuaremos'), 'rejected', 'a refusal in Spanish');
  eq(c('Helaas gaan we niet verder met je sollicitatie'), 'rejected', 'a refusal in Dutch');
  // ➤ The SAME refusal put positively. A real one read "we hebben beslist om
  // ➤ met andere kandidaten verder te gaan" — we have decided to continue
  // ➤ with OTHER candidates — and matched nothing, because only the negative
  // ➤ form was listed. It reads like good news until the sentence ends.
  eq(c('Betreft uw sollicitatie', 'Na een grondige beoordeling hebben we beslist om met andere kandidaten verder te gaan'),
    'rejected', 'a Dutch refusal phrased as continuing with others');
  eq(c('Your application', 'We have decided to move forward with other candidates'),
    'rejected', 'and the same in English');

  // ➤ BELGIAN Dutch is not Netherlands Dutch, and this mailbox gets both.
  // ➤ Different words for the same thing, not different spellings.
  eq(c('Uw kandidatuur', 'Uw kandidatuur werd helaas niet weerhouden voor deze functie'),
    'rejected', 'Belgian "niet weerhouden" is a refusal');
  eq(c('Sollicitatie', 'Je bent niet geselecteerd voor deze vacature'),
    'rejected', 'and the Netherlands equivalent "niet geselecteerd"');
  eq(c('Kandidatuur', 'Wij hebben uw kandidatuur goed ontvangen'),
    'acknowledged', 'Belgian "kandidatuur" is an application too');
  eq(c('Sollicitatie', 'We hebben je sollicitatie ontvangen'),
    'acknowledged', 'as is the Netherlands "sollicitatie"');
  eq(c('Uitnodiging', 'We willen graag een afspraak inplannen voor een kennismakingsgesprek'),
    'interview', 'a Belgian invitation to meet');

  // ➤ ONE PATTERN AT A TIME. The sentences above each contain several
  // ➤ matching phrases, so removing any single one of them left the tests
  // ➤ green: they proved the sentence was understood, not the pattern.
  // ➤ These carry exactly one trigger each.
  eq(c('Uw kandidatuur', 'Uw kandidatuur werd niet weerhouden'), 'rejected', 'BE "niet weerhouden", alone');
  eq(c('Sollicitatie', 'Je bent niet geselecteerd'), 'rejected', 'NL "niet geselecteerd", alone');
  eq(c('Update', 'We hebben besloten verder te gaan met andere profielen'), 'rejected', 'the positive phrasing, alone');
  eq(c('Update', 'Uw profiel komt niet in aanmerking'), 'rejected', 'BE "niet in aanmerking", alone');
  eq(c('Bedankt', 'Bedankt voor uw kandidatuur'), 'acknowledged', 'the formal register, alone');

  // ➤ FORMAL and informal. Companies write to a stranger with "u", and the
  // ➤ pattern only knew "je": a real receipt went unrecognised.
  eq(c('Sollicitatie Junior Automation Engineer', 'Wij hebben uw sollicitatie goed ontvangen voor de vacature'),
    'acknowledged', 'a Dutch receipt in the formal register');
  eq(c('Bedankt', 'Bedankt voor uw sollicitatie'), 'acknowledged', 'and a formal thank-you');

  // ➤ That same receipt says feedback may come by telephone and asks when
  // ➤ you can be called. It is still a receipt, not an invitation to talk.
  eq(c('Sollicitatie', 'U kunt binnen de 48 uur feedback van ons verwachten. Deze feedback kan per mail zijn of een telefonische contactname. Wij hebben uw sollicitatie ontvangen'),
    'acknowledged', 'a receipt that mentions a possible phone call is not an interview');

  eq(c('Invitation to interview'), 'interview', 'an invitation');
  // ➤ THE BOILERPLATE OF EVERY AUTOMATED RECEIPT. "next steps" was in the
  // ➤ interview list, which was harmless while only a 200-character snippet
  // ➤ was read and reported three plain acknowledgements as invitations the
  // ➤ moment whole bodies were.
  eq(c('Thank you for your application', 'We will be in touch soon to let you know about the next steps'),
    'acknowledged', 'a promise of "next steps" is a receipt, not an invitation');
  eq(c('Thanks for applying', 'We will contact you about the next steps in the process'),
    'acknowledged', 'however it is worded');
  eq(c('Your application', 'We invite you to complete your candidate profile'),
    null, 'being invited to fill in a form is not being invited to talk');
  // ➤ And what a real one looks like.
  eq(c('Your application', 'We would like to speak with you about the role'),
    'interview', 'someone proposing to talk IS an invitation');
  eq(c('Tu candidatura', 'Nos gustaria hablar contigo la semana que viene'),
    'interview', 'and in Spanish');
  eq(c('Nos gustaría hablar contigo'), 'interview', 'an invitation in Spanish');

  // ➤ A rejection usually opens by thanking you for applying. Whichever
  // ➤ pattern is tested first decides, so the order is the behaviour.
  eq(c('Thank you for your application', 'Unfortunately we have decided to move with other candidates'),
    'rejected', 'a polite rejection is a rejection, not a receipt');
  // ➤ And an invitation that quotes the receipt it follows.
  eq(c('Re: we have received your application', 'We would like to schedule a call with you'),
    'interview', 'an invitation that quotes the receipt is still an invitation');

  // ➤ ── FOUR REAL MISSES, all found by reading the N/A pile ────────────────
  // ➤ POLITE PADDING. "Thank you SO MUCH for your interest" is as ordinary as
  // ➤ writing gets and it matched nothing: the pattern wanted "thank you" and
  // ➤ "for" side by side. A real receipt sat in no-reply for a week over two
  // ➤ words of courtesy.
  eq(c('Thanks for putting us on your roadmap!', '',
    'Thank you so much for your interest in joining us and considering us as part of your career journey!'),
    'acknowledged', 'an adverb between "thank you" and "for" no longer hides a receipt');
  eq(c('Update', 'Thank you very much for your application'), 'acknowledged', 'and any of the usual ones');
  // ➤ And the other half of the same message: saying they are reading it is
  // ➤ saying it arrived, which is what a receipt means.
  eq(c('We are on it', '', 'Our team is currently reviewing your application, and we will be in touch.'),
    'acknowledged', '"reviewing your application" is a receipt');
  eq(c('Applied', '', 'Our team is carefully reviewing all applications.'),
    'acknowledged', 'however they phrase it');

  // ➤ THE BOUNCE. Not a reply at all — the mail system handing your own message
  // ➤ back. It is the only outcome here you can still do something about.
  eq(c('Delivery Status Notification (Failure)', '',
    'Your message could not be delivered. Address not found.'),
    'bounced', 'a failure notice means the application never arrived');
  eq(c('Undelivered Mail Returned to Sender', '', 'user unknown'),
    'bounced', 'however the mail server words it');
  // ➤ THE TRAP, and the reason the SENDER is not part of the test: the same
  // ➤ "Mail Delivery Subsystem" writes delay notices while it is still trying,
  // ➤ and a delay usually ends in delivery. Two of the three notices in a real
  // ➤ mailbox were delays; matching on the sender would have called all three
  // ➤ a failure and reported an application lost when it was not.
  ok(c('Delivery Status Notification (Delay)', '',
    'Your message has not been delivered yet. Gmail will keep trying.') !== 'bounced',
    'a DELAY is not a failure');
  // ➤ A bounce quotes your own application back, so it is tested FIRST: every
  // ➤ other pattern here would happily read the words of your covering letter.
  eq(c('Delivery Status Notification (Failure)', '',
    'Address not found. --- Original message --- Thank you for your interest in the role, I am applying for...'),
    'bounced', 'the quoted original does not turn a bounce into something else');

  // ➤ The newsletters. Without this every mailshot becomes an outcome.
  eq(c('5 new jobs for you this week'), 'alert', 'a job alert is not an outcome');
  ok(c('Interview tips to help you prepare') !== 'interview', 'advice ABOUT interviews is never read as an invitation');
  eq(c('How to prepare for your interview', 'unsubscribe'), 'alert', 'nor is a guide');

  // ➤ THE GUARD READS THE OPENING ONLY, and this is why. Every HTML mail ends
  // ➤ in the same footer — read our blog, browse our articles, career guides —
  // ➤ and when whole bodies started being read that footer cancelled a real
  // ➤ invitation. Measured on the mailbox: exactly one outcome was lost this
  // ➤ way, and it was an interview, the outcome that matters most.
  eq(c('Your application', 'We would like to schedule a call with you',
    'Read our blog for interview tips and how to prepare. Browse articles and guides. Newsletter. Unsubscribe.'),
    'interview', 'a marketing footer does not cancel an invitation in the body');
  // ➤ But a genuine piece of advice still announces itself where it always did.
  ok(c('Interview tips', 'how to prepare for your first interview', 'a long body about interviews') !== 'interview',
    'while advice named in the subject is still not an invitation');

  // ➤ A PROMISE IS NOT AN INVITATION. This is the real sentence, from the real
  // ➤ receipt that was reported as an interview until the owner opened the mail:
  // ➤ a university saying it has NOT decided, in the exact words a genuine
  // ➤ invitation uses. Read past the "whether" and it is good news.
  eq(c('Thanks for your application for the position of Platform & Automation Engineer',
    'A message from the recruitment team',
    'We have received your application in good order. After the closing date, we will inform you as soon as possible whether we see the right fit to invite you for an interview. This may be online or on our campus.'),
    'acknowledged', 'a conditional "whether ... invite you for an interview" is a receipt, not an invitation');

  // ➤ The same trap on the other side: a receipt describing the rejection that
  // ➤ MIGHT come. "Other candidates" alone would read it as a refusal.
  eq(c('We have received your application', '',
    'Should we decide to continue with other candidates, we will let you know.'),
    'acknowledged', 'a conditional refusal is not a refusal');

  // ➤ And the sentences that must survive the guard, or it has eaten the
  // ➤ feature it was protecting.
  eq(c('Your application', 'We would like to invite you for an interview next Tuesday'),
    'interview', 'an outright invitation is still an invitation');
  eq(c('Your application', 'If you are available on Tuesday, we would like to invite you for an interview'),
    'interview', 'and so is a politely conditional one — the condition is about YOUR diary, not their decision');
  eq(c('Update', 'Unfortunately we have decided to continue with other candidates'),
    'rejected', 'an outright refusal is still a refusal');
  // ➤ The condition only cancels the sentence it leads. A later sentence that
  // ➤ says it outright still counts.
  eq(c('Update', 'We will let you know whether there is a fit. We would like to invite you for an interview on Monday'),
    'interview', 'a conditional sentence does not silence the one after it');

  // ➤ THE CONDITION CAN NAME YOU INSTEAD OF THEM (audit 2026-07-31). The list
  // ➤ used to spell out only the company's side — "if we", "if selected",
  // ➤ "wenn wir" — and missed the commoner phrasing that names the candidate.
  // ➤ All four of these were reported as real interviews.
  eq(c('Application received', '', 'Thank you for applying. If you are selected, we will invite you for an interview.'),
    'acknowledged', 'EN: "if YOU are selected" is a maybe, not an interview');
  eq(c('Sollicitatie ontvangen', '', 'Bedankt voor je sollicitatie. Als je wordt geselecteerd nodigen we je uit voor een gesprek.'),
    'acknowledged', 'NL: "als je wordt geselecteerd" is a maybe');
  eq(c('Ihre Bewerbung', '', 'Vielen Dank für Ihre Bewerbung. Wenn Sie ausgewählt werden, laden wir Sie zu einem Interview ein.'),
    'acknowledged', 'DE: "wenn Sie ausgewählt werden" is a maybe');
  eq(c('Solicitud recibida', '', 'Gracias por tu solicitud. Si eres seleccionado te invitaremos a una entrevista.'),
    'acknowledged', 'ES: "si eres seleccionado" is a maybe');
  eq(c('We got your application', '', 'Thank you for your application. When you are shortlisted we will invite you to an interview.'),
    'acknowledged', '"when you are shortlisted" is a maybe too');
  // ➤ And with no receipt wording at all the honest answer is "not about an
  // ➤ application" — never an interview.
  eq(c('Process', '', 'When you are shortlisted we will invite you to an interview.'),
    null, 'a bare conditional with no receipt wording is nothing, not an invitation');

  // ➤ THE ADVICE GUARD MUST NOT EAT A REAL INVITATION (audit 2026-07-31). It
  // ➤ was written as bare substrings, so "curso" inside "reCURSOs humanos" and
  // ➤ "guide" inside "guidelines" cancelled genuine invitations — the message
  // ➤ then became nothing at all and the application sat on "no reply" until it
  // ➤ was given up for lost. Losing an interview is the most expensive mistake
  // ➤ this file can make.
  eq(c('Entrevista', 'Le escribe el departamento de recursos humanos. Queremos agendar una entrevista el jueves.'),
    'interview', '"recursos humanos" does not cancel an invitation');
  eq(c('Proceso', 'Su proceso está en curso. Nos gustaría invitarle a una entrevista la semana que viene.'),
    'interview', '"en curso" (under way) does not cancel an invitation');
  eq(c('Interview', 'Please read the attached guidelines. We would like to invite you to an interview on Monday.'),
    'interview', '"guidelines" does not cancel an invitation');
  // ➤ And the guard still does its job: real advice about interviews is not one.
  eq(c('5 tips to prepare for your interview', 'Read our tips on how to prepare for an interview.'),
    null, 'a newsletter of interview tips is still not an interview');
  eq(c('Cursos de preparación', 'Nuestros cursos te ayudan a preparar una entrevista.'),
    null, 'a training-course mailshot is still not an interview');

  // ➤ A MAILSHOT IS READ AS A MAILSHOT FIRST (audit 2026-07-31). The alert test
  // ➤ used to run last, so it could only catch a digest that matched nothing
  // ➤ else — while a digest carries the text of the jobs it advertises and
  // ➤ therefore says "we cannot proceed" and "invite you for an interview".
  eq(c('New jobs for you', '', 'New roles matching your search at ACME. Apply now. Unfortunately we cannot proceed with some searches. Unsubscribe here.'),
    'alert', 'a digest quoting a refusal is a digest');
  eq(c('New jobs for you', '', 'Jobs for you at ACME. Companies invite you for an interview when they like your profile. Apply now. Unsubscribe.'),
    'alert', 'a digest quoting an invitation is a digest');
  // ➤ But the footer of a GENUINE reply must not turn it into one: "unsubscribe"
  // ➤ sits at the bottom of almost every company mail ever sent, which is why
  // ➤ the early test reads the opening only.
  eq(c('Invitation to interview', 'We would like to invite you for an interview on Monday.',
    'We would like to invite you for an interview on Monday. --- To stop receiving these emails, unsubscribe here.'),
    'interview', 'an "unsubscribe" footer does not turn a real invitation into a mailshot');

  // ➤ ── THREE THINGS TODAY'S OWN FIXES BROKE (audit 2026-08-01) ────────────
  // ➤ Every one of these worked before this morning. They are here because a
  // ➤ fix that quietly breaks something is worse than the bug it fixed, and
  // ➤ because the suite passed on all three.

  // ➤ 1. A SPANISH REFUSAL IS NOT ADVERTISING. Moving the mailshot test to the
  // ➤ front put "hemos encontrado" — with no number after it, unlike its
  // ➤ English twin "we found 3" — ahead of the refusal test. "Lamentamos
  // ➤ comunicarte que hemos encontrado otro candidato" was filed as a mailshot,
  // ➤ dropped before it could be linked, and the application sat on "no reply"
  // ➤ until it was given up for lost sixty days later.
  eq(c('Sobre tu candidatura', 'Lamentamos comunicarte que hemos encontrado otro candidato cuyo perfil se ajusta mejor al puesto.'),
    'rejected', 'a Spanish refusal opening "hemos encontrado otro candidato" is a refusal');
  eq(c('Nuevas ofertas de empleo', 'Hemos encontrado 12 ofertas para ti. Postula ya.'),
    'alert', 'and the mailshot it was confused with is still a mailshot');
  // ➤ A call to action and an unsubscribe line are NOT enough on their own:
  // ➤ genuine company mail carries them too, which is why they are left out of
  // ➤ the early test and only count in the fallback at the end.
  eq(c('Your application', 'Unfortunately we will not be proceeding. Apply now for other roles, or unsubscribe here.'),
    'rejected', 'a refusal that ends with a call to action is still a refusal');

  // ➤ 2. A CONDITION ABOUT YOUR DIARY IS NOT A MAYBE. Widening the conditional
  // ➤ list to cover "if YOU are selected" also swept in "a match" and "the
  // ➤ right fit", which describe the OFFER suiting you — ordinary polite
  // ➤ invitation wording. The invitation then classified as nothing at all.
  eq(c('Your application', 'If this is the right fit for you, we would like to invite you for an interview on Thursday.'),
    'interview', 'an invitation conditioned on YOUR preference is still an invitation');
  eq(c('Your application', 'If Thursday is a match for you, we would like to invite you for an interview.'),
    'interview', 'and one conditioned on YOUR diary');
  // ➤ While the sentence the widening was for stays a maybe.
  eq(c('Thanks for applying', 'Thank you for your application. If you are selected we will invite you for an interview.'),
    'acknowledged', 'the company still choosing is still a maybe');

  // ➤ 3. THE COMMONEST COURSE MAILSHOT CAME BACK. Making the advice guard
  // ➤ whole-word kept only the plural "cursos", so "curso online" — the usual
  // ➤ shape of the thing — stopped being recognised and a course advert was
  // ➤ reported as an interview.
  eq(c('Curso online de entrevistas', 'Nuestro curso online te prepara para una entrevista de trabajo.'),
    null, 'a singular "curso" mailshot is not an interview');
  eq(c('Interview help', 'Read our blogs. Our workshop will invite you for an interview rehearsal.'),
    null, 'and neither is a blog round-up, plural included');
  // ➤ And the Spanish that forced whole words in the first place still passes:
  // ➤ "en curso" means under way, and comes BEFORE the word.
  eq(c('Proceso', 'Su proceso está en curso. Nos gustaría invitarle a una entrevista la semana que viene.'),
    'interview', '"en curso" (under way) still does not cancel an invitation');

  // ➤ ── REAL INVITATIONS ──────────────────────────────────────────────────
  // ➤ Not invented. These are the shapes the only genuine interview process in
  // ➤ this mailbox actually took, and they are here because the morning was
  // ➤ spent nearly deleting the word that catches every one of them: the bare
  // ➤ noun. Two newsletters had matched on it, and tightening the pattern to
  // ➤ silence them would have cost all six of these.
  eq(c('Invitation to interview'), 'interview', 'the subject a recruiter actually writes');
  eq(c('HM interview - Jr. A&C'), 'interview', 'and the calendar invite that follows it');
  eq(c('Looking forward with you', 'Hola, queria agradecerte nuevamente por tu tiempo en la entrevista conmigo'),
    'interview', 'a thank-you after the conversation: it happened, so it counts');
  eq(c('Cancelado: HM interview - Jr. A&C'), 'interview', 'a cancellation still means there was one');

  ok(looksAutomated('noreply@acme.com') && looksAutomated('careers@x.io'), 'no-reply senders are recognised');
  ok(!looksAutomated('marta.lopez@acme.com'), 'a person is not an automated sender');
}

// ── 2) Reading the employer out of the sender ─────────────────────────────
// ➤ The measurement that motivated this: of 38 emails naming no company in
// ➤ their text, 30 were identifiable from the "From" line alone.
{
  eq(senderName('"Van Oord Careers" <noreply@platform.com>'), 'Van Oord Careers', 'the display name is read');
  eq(senderName('Recruiting Team <noreply@x.com>'), '', 'a generic team name identifies nobody');
  eq(senderName('no-reply@x.com'), '', 'an address with no display name gives nothing');

  eq(senderDomainCore('jobs@careers.vanoord.com'), 'vanoord', 'the platform parts of a host are stripped');
  eq(senderDomainCore('noreply@myworkday.com'), '', 'a known ATS domain names no employer');
  eq(senderDomainCore('noreply@linkedin.com'), '', 'nor does a job board');
}

// ── 3) Linking an email to the right application ──────────────────────────
{
  const apps = [
    { id: 1, company: 'Van Oord', title: 'Offshore Engineer', location: 'Rotterdam', ts: '2026-07-01T09:00:00Z' },
    { id: 2, company: 'Jan De Nul Group', title: 'Project Engineer', location: 'Aalst', ts: '2026-07-01T10:00:00Z' },
  ];
  const at = (subject, from, date, snippet = '') => ({ subject, from, date, snippet });

  // ➤ The company named in the text: conclusive.
  const a = linkOutcomes([at('Your application to Van Oord', 'x@y.com', '2026-07-01T12:00:00Z')], apps);
  eq(a.links.length, 1, 'a named company links');
  eq(a.links[0].application.id, 1, 'and to the right application');

  // ➤ Named only in the sender, which is the case the text can never reach.
  const b = linkOutcomes([at('Your application', '"Van Oord Recruitment" <noreply@ats.com>', '2026-07-01T12:00:00Z')], apps);
  eq(b.links.length, 1, 'a company named only in the sender still links');
  eq(b.links[0].application.id, 1, 'to the right one');
  ok(b.links[0].why.includes('company'), 'and says the company was recognised');

  // ➤ A faceless receipt naming nobody: not a tie, an orphan. Nothing in it
  // ➤ points at any application, so there is no candidate to be torn between.
  const c = linkOutcomes([at('Thanks for applying', 'noreply@ats.com', '2026-07-01T12:00:00Z', 'engineer position')], apps);
  eq(c.links.length, 0, 'a receipt that identifies nothing is not linked');
  eq(c.orphans.length, 1, 'and it is an orphan, not a tie');

  // ➤ A REAL tie, and one that has already happened here: two open roles at
  // ➤ the same employer, applied to on the same day. The email names the
  // ➤ company, which fits both equally. Guessing would invent an outcome for
  // ➤ one of them, so it is handed back unresolved.
  const twoRoles = [
    { id: 7, company: 'ATEXIS', title: 'Design Engineer', location: 'Madrid', ts: '2026-07-01T09:00:00Z' },
    { id: 8, company: 'ATEXIS', title: 'Systems Engineer', location: 'Madrid', ts: '2026-07-01T09:30:00Z' },
  ];
  const t = linkOutcomes([at('We have received your application', '"ATEXIS" <noreply@ats.com>', '2026-07-01T12:00:00Z')], twoRoles);
  eq(t.links.length, 0, 'two roles at one employer are not guessed between');
  eq(t.ties.length, 1, 'the email is reported as a tie');
  eq(t.ties[0].candidates.length, 2, 'with both candidates named, so you can decide');

  // ➤ THE SAME TIE, BUT APPLIED TO ON DIFFERENT DAYS (audit 2026-07-31). This
  // ➤ is the case the test above could never reach: both applications were half
  // ➤ an hour apart, so they earned the same date bonus and the totals matched.
  // ➤ Three weeks apart, the bonuses differ — and the old rule accepted a
  // ➤ better TOTAL as proof of identity, so a rejection naming only the
  // ➤ employer was filed against whichever role was applied to more recently.
  // ➤ Timing cannot say which vacancy an email is about. It never could.
  const farApart = [
    { id: 9, company: 'ATEXIS', title: 'Design Engineer', location: 'Madrid', ts: '2026-06-05T09:00:00Z' },
    { id: 10, company: 'ATEXIS', title: 'Systems Engineer', location: 'Madrid', ts: '2026-06-28T09:00:00Z' },
  ];
  const far = linkOutcomes([at('Unfortunately we will not proceed', '"ATEXIS" <noreply@ats.com>', '2026-07-01T12:00:00Z')], farApart);
  eq(far.links.length, 0, 'a more recent application does not win a rejection');
  eq(far.ties.length, 1, 'it is still a tie');
  eq(far.ties[0].candidates.map(x => x.application.id).sort((a, b) => a - b), [9, 10], 'and BOTH roles are named, not just the recent one');

  // ➤ What still resolves it: something that says WHICH role. The title in the
  // ➤ subject raises one side's identity, and identity is the only thing
  // ➤ allowed to break the tie.
  const named = linkOutcomes([at('Your application for the Systems Engineer role', '"ATEXIS" <noreply@ats.com>', '2026-07-01T12:00:00Z')], farApart);
  eq(named.links.length, 1, 'naming the role does resolve it');
  eq(named.links[0].application.id, 10, 'and it lands on that role');

  // ➤ Mail predating the application cannot be about it.
  const d = linkOutcomes([at('Your application to Van Oord', 'x@y.com', '2026-06-01T12:00:00Z')], apps);
  eq(d.links.length, 0, 'an email older than the application is not linked');

  // ➤ Nothing matches at all: an application the bot never recorded.
  const e = linkOutcomes([at('Thanks from Somewhere Else Ltd', 'x@nowhere.com', '2026-07-02T12:00:00Z')], apps);
  eq(e.orphans.length, 1, 'an unrelated email is an orphan, not a bad link');
  // ➤ Arriving the same day is not evidence of anything. Before this, every
  // ➤ stray email that landed on a busy day became a candidate for whatever
  // ➤ was applied to that day.
  const g = linkOutcomes([at('Some newsletter', 'x@nowhere.com', '2026-07-01T11:00:00Z')], apps);
  eq(g.orphans.length, 1, 'timing alone never makes a candidate');
  eq(scoreLink(at('Some newsletter', 'x@nowhere.com', '2026-07-01T11:00:00Z'), apps[0]).score, 0, 'and it scores zero');

  // ➤ THE ACRONYM EMPLOYER. A company called "TWD" produces no tokens (three
  // ➤ letters) and is too short for the squeezed-out substring search, so it
  // ➤ was invisible: a receipt from "TWD/Marine Engineer" was read correctly as
  // ➤ a receipt and then belonged to nobody.
  {
    const app = { id: 1, company: 'TWD', title: 'TWD - Marine Engineer', location: 'Nederland', ts: '2026-07-18T09:00:00Z' };
    const msg = { subject: "We're excited you applied to TWD!", snippet: 'Thank you for applying to the Marine Engineer position at TWD',
      from: 'TWD/Marine Engineer <no-reply@recruitee-email.com>', date: '2026-07-18T10:00:00Z', body: '' };
    ok(scoreLink(msg, app).identity >= 10, 'a three-letter employer is identified');
    // ➤ But as a WHOLE WORD only. Loosening the substring rule instead would
    // ➤ have matched "twd" inside anything that happened to contain it.
    const other = { subject: 'Newsletter', snippet: 'betwd and other nonsense words', from: 'x@y.com', date: '2026-07-19T10:00:00Z', body: '' };
    eq(scoreLink(other, app).score, 0, 'and never inside another word');
  }

  // ➤ THE DATE ON THE APPLICATION IS WHEN YOU TOLD THE BOT, not when you
  // ➤ applied. A real receipt arrived on the 17th against a record written on
  // ➤ the 18th and was thrown out by half a day.
  {
    const app = { id: 1, company: 'Bjak', title: 'Applied AI Engineer', location: 'Spain', ts: '2026-07-18T07:00:00Z' };
    const dayBefore = { subject: 'Thanks!', snippet: 'Bjak team here', from: 'x@ashbyhq.com', date: '2026-07-17T12:00:00Z', body: '' };
    ok(scoreLink(dayBefore, app).score > 0, 'a reply logged a day late still links');
    // ➤ The rule still exists, though: something from last month cannot be an
    // ➤ answer to this week's application.
    const longBefore = { ...dayBefore, date: '2026-06-17T12:00:00Z' };
    eq(scoreLink(longBefore, app).score, 0, 'but a month earlier is still impossible');
    eq(scoreLink(longBefore, app).why[0], 'arrived-before-applying', 'and it says so');
  }

  // ➤ The generic words must not carry a match on their own.
  eq(tokens('Engineering Group SA'), [], 'a company name of only generic words yields nothing to match on');
  ok(tokens('Van Oord').length > 0, 'a real name does');
  const f = linkOutcomes([at('Your application', 'noreply@ats.com', '2026-07-01T12:00:00Z', 'engineering group')], apps);
  eq(f.links.length, 0, 'so "engineering group" alone links to nobody');

  // ➤ WHOLE WORDS ONLY. "Van Oord" reduces to the token "oord", and a Dutch
  // ➤ rejection from an unrelated company contained "beoordeling" — so Van
  // ➤ Oord scored as though it had been named, and came within one point of
  // ➤ being told it had been rejected.
  const dutch = at('Betreft uw sollicitatie', 'info@elsewhere.be', '2026-07-02T12:00:00Z',
    'Na een grondige beoordeling hebben we beslist om verder te gaan');
  eq(scoreLink(dutch, apps[0]).score, 0, '"beoordeling" does not count as "Van Oord"');
  eq(linkOutcomes([dutch], apps).orphans.length, 1, 'and the email stays unlinked');
  // ➤ The real name still matches, boundary and all.
  ok(scoreLink(at('Van Oord update', 'x@y.com', '2026-07-02T12:00:00Z'), apps[0]).score > 0, 'the actual name still matches');

  // ➤ The SAME boundary rule has to hold for job titles. "Offshore" sits
  // ➤ inside plenty of longer words, and a title matched as a substring
  // ➤ would score on any of them.
  // ➤ Two title words, and BOTH only as fragments of longer words. It takes
  // ➤ two to make a match at all, so one fragment proves nothing on its own.
  const twoWordTitle = [{ id: 11, company: 'Somewhere', title: 'Offshore Wind Analyst', location: 'X', ts: '2026-07-01T09:00:00Z' }];
  const buried = at('Nieuwsbrief', 'x@y.com', '2026-07-02T12:00:00Z', 'over offshoreactiviteiten en windmolenparken');
  eq(scoreLink(buried, twoWordTitle[0]).score, 0, 'title words buried inside longer words do not count');
  // ➤ The same two words, standing on their own, do.
  const proper = at('Vacature', 'x@y.com', '2026-07-02T12:00:00Z', 'the offshore wind role you applied for');
  ok(scoreLink(proper, twoWordTitle[0]).why.includes('title'), 'the same words as whole words do match');

  // ➤ ONE title word, and nothing else at all. Without an identity already
  // ➤ established it must not create a candidate: this is how an email from
  // ➤ a company never applied to competed for two real applications.
  const oneWord = at('Vacature', 'x@nowhere.com', '2026-07-02T12:00:00Z', 'a project manager role somewhere else');
  eq(scoreLink(oneWord, apps[1]).score, 0, 'a single shared title word is not identity on its own');
  eq(linkOutcomes([oneWord], apps).orphans.length, 1, 'so the email stays an orphan');
  // ➤ Even when the title reduces to that one word and nothing else. Six of
  // ➤ a real set of 23 applications were like this, four of them sharing
  // ➤ "automation": one word could have identified all four at once.
  const single = [{ id: 9, company: 'Somewhere', title: 'Automation Engineer', location: 'X', ts: '2026-07-01T09:00:00Z' }];
  const mentions = at('Newsletter', 'x@nowhere.com', '2026-07-02T12:00:00Z', 'the future of automation in industry');
  eq(scoreLink(mentions, single[0]).score, 0, 'a one-word title is not identified by that word alone');
  eq(linkOutcomes([mentions], single).orphans.length, 1, 'and such an email is an orphan');
  // ➤ But once the company IS named, that same single word corroborates.
  const withCompany = at('Jan De Nul', 'x@y.com', '2026-07-02T12:00:00Z', 'about the project you applied for');
  ok(scoreLink(withCompany, apps[1]).why.includes('title-partial'), 'and it does count once the company is known');
}

// ── 4) The state of each application ──────────────────────────────────────
{
  const apps = [
    { id: 1, company: 'A', title: 'T', ts: '2026-07-01T09:00:00Z' },
    { id: 2, company: 'B', title: 'T', ts: '2026-07-01T09:00:00Z' },
    { id: 3, company: 'C', title: 'T', ts: '2026-07-01T09:00:00Z' },
    { id: 4, company: 'D', title: 'T', ts: '2026-07-20T09:00:00Z' },
    { id: 5, company: 'E', title: 'T', ts: '2026-06-01T09:00:00Z' },
    { id: 6, company: 'F', title: 'T', ts: '2026-07-01T09:00:00Z', longshot: true },
  ];
  const link = (id, kind, date) => ({ application: apps.find(a => a.id === id), kind, message: { date }, why: ['company'], score: 10 });
  const links = [
    link(1, 'acknowledged', '2026-07-01T10:00:00Z'),
    link(2, 'acknowledged', '2026-07-01T10:00:00Z'),
    link(2, 'rejected', '2026-07-10T10:00:00Z'),
    link(3, 'acknowledged', '2026-07-01T10:00:00Z'),
    link(3, 'interview', '2026-07-05T10:00:00Z'),
    link(6, 'rejected', '2026-07-03T10:00:00Z'),
  ];
  const recs = buildStatus(apps, links, { today: new Date('2026-07-25T00:00:00Z') });
  const st = id => recs.find(r => r.id === id).state;

  eq(st(1), 'acknowledged', 'a receipt and nothing more');
  eq(st(2), 'rejected', 'a rejection is terminal');
  eq(st(3), 'interview', 'an invitation beats the receipt that came first');
  eq(st(4), 'noreply', 'applied five days ago with no receipt at all: receipts arrive within the hour, so five days is silence');
  eq(st(5), 'noreply', 'nobody ever wrote back');

  // ➤ NO GRACE PERIOD. There used to be a separate state for anything under
  // ➤ three days old. It is gone: no receipt is no receipt, and how recent it
  // ➤ is shows as a number of days beside the row.
  const fresh = buildStatus([{ id: 9, company: 'Z', title: 'T', ts: '2026-07-25T08:00:00Z' }], [],
    { today: new Date('2026-07-25T09:00:00Z') });
  eq(fresh[0].state, 'noreply', 'one sent an hour ago is unanswered too, not a state of its own');
  eq(fresh[0].daysWaiting, 0, 'and it says how fresh it is');

  // ➤ A BOUNCE OUTRANKS EVERYTHING, because it is not a verdict on you — it is
  // ➤ the reason there is no verdict, and the only state here you can still act
  // ➤ on. Even a rejection afterwards does not change that the first attempt
  // ➤ never arrived.
  const bounced = buildStatus([{ id: 7, company: 'Q', title: 'T', ts: '2026-07-01T09:00:00Z' }], [
    { application: { id: 7 }, kind: 'bounced', message: { date: '2026-07-01T10:00:00Z', kind: 'bounced' }, why: ['company'], score: 12 },
    { application: { id: 7 }, kind: 'acknowledged', message: { date: '2026-07-02T10:00:00Z', kind: 'acknowledged' }, why: ['company'], score: 12 },
  ], { today: new Date('2026-07-10T00:00:00Z') });
  eq(bounced[0].state, 'bounced', 'a bounce wins over anything else on the same application');

  // ➤ GHOSTED. Two months of nothing and waiting stops being waiting.
  {
    const day = (d) => `2026-${String(d).padStart(2, '0')}-01T09:00:00Z`;
    const now = new Date('2026-07-31T00:00:00Z');
    // ➤ Never answered, and it has been long enough.
    const old = buildStatus([{ id: 30, company: 'C', title: 'T', ts: day(1) }], [], { today: now });
    eq(old[0].state, 'ghosted', 'silence for two months is an answer');
    // ➤ Same silence, but recent: still just silence.
    const recent = buildStatus([{ id: 31, company: 'C', title: 'T', ts: day(7) }], [], { today: now });
    eq(recent[0].state, 'noreply', 'three weeks of it is not');

    // ➤ COUNTED FROM THE LAST THING THAT HAPPENED, not from the application. An
    // ➤ employer that acknowledged you in July has been quiet since July.
    const ackLate = buildStatus([{ id: 32, company: 'C', title: 'T', ts: day(1) }],
      [{ application: { id: 32 }, kind: 'acknowledged', message: { date: day(7), kind: 'acknowledged' }, why: [], score: 10 }],
      { today: now });
    eq(ackLate[0].state, 'acknowledged', 'an old application acknowledged recently is not ghosted');
    const ackOld = buildStatus([{ id: 33, company: 'C', title: 'T', ts: day(1) }],
      [{ application: { id: 33 }, kind: 'acknowledged', message: { date: day(1), kind: 'acknowledged' }, why: [], score: 10 }],
      { today: now });
    eq(ackOld[0].state, 'ghosted', 'but one acknowledged two months ago and silent since is');

    // ➤ Neither of the two settled states ages out: a rejection is already
    // ➤ answered, and an interview is worth chasing rather than writing off.
    for (const [id, kind] of [[34, 'rejected'], [35, 'interview']]) {
      const r = buildStatus([{ id, company: 'C', title: 'T', ts: day(1) }],
        [{ application: { id }, kind, message: { date: day(1), kind }, why: [], score: 10 }], { today: now });
      eq(r[0].state, kind, `a ${kind} is never turned into a ghost by the calendar`);
    }
    // ➤ Nor is one that never arrived: that has its own answer already.
    const b = buildStatus([{ id: 36, company: 'C', title: 'T', ts: day(1) }],
      [{ application: { id: 36 }, kind: 'bounced', message: { date: day(1), kind: 'bounced' }, why: [], score: 10 }], { today: now });
    eq(b[0].state, 'bounced', 'and neither is a bounce');
  }

  // ➤ WHAT YOU KNOW BEATS WHAT THE INBOX SAYS. Some employers never write —
  // ➤ the verdict is on their own portal, or their address bounces and nobody
  // ➤ fixes it — so the application would sit under "no reply" for ever while
  // ➤ you already know how it ended. "no N" records it, and it has to survive
  // ➤ the nightly rebuild, which starts from the mail every single time.
  {
    const base = buildStatus([
      { id: 20, company: 'Portal Co', title: 'T', ts: '2026-07-01T09:00:00Z' },
      { id: 21, company: 'Other Co', title: 'T', ts: '2026-07-01T09:00:00Z' },
    ], [], { today: new Date('2026-07-20T00:00:00Z') });
    eq(base[0].state, 'noreply', 'without a verdict it is silence, as before');

    const after = applyVerdicts(base, [{ id: 20, state: 'rejected', reason: 'their portal says closed', ts: '2026-07-19T10:00:00Z' }]);
    eq(after[0].state, 'rejected', 'your decision is applied');
    eq(after[0].decidedByYou, true, 'and marked as yours, not read from an email');
    eq(after[0].decidedWhy, 'their portal says closed', 'with the reason kept');
    eq(after[1].state, 'noreply', 'while the others are untouched');

    // ➤ What actually happened is NOT rewritten: your decision changes the
    // ➤ verdict, not the history of the messages.
    const withMail = buildStatus([{ id: 22, company: 'C', title: 'T', ts: '2026-07-01T09:00:00Z' }],
      [{ application: { id: 22 }, kind: 'acknowledged', message: { date: '2026-07-01T10:00:00Z', kind: 'acknowledged' }, why: [], score: 10 }],
      { today: new Date('2026-07-20T00:00:00Z') });
    const closed = applyVerdicts(withMail, [{ id: 22, state: 'rejected', ts: '2026-07-19T10:00:00Z' }]);
    eq(closed[0].state, 'rejected', 'a verdict overrides what the mail said');
    eq(closed[0].reached, ['acknowledged'], 'but the receipt that really arrived is still on the record');

    // ➤ Change your mind and the newest line wins; the file is append-only.
    const twice = applyVerdicts(base, [
      { id: 20, state: 'rejected', ts: '2026-07-19T10:00:00Z' },
      { id: 20, state: 'interview', ts: '2026-07-20T10:00:00Z' },
    ]);
    eq(twice[0].state, 'interview', 'the newest decision is the one that counts');

    // ➤ A junk line must not take the file down with it.
    eq(applyVerdicts(base, [null, { id: 'x' }, { state: 'rejected' }])[0].state, 'noreply', 'unusable lines are ignored');
    eq(applyVerdicts(base, []).length, 2, 'and no verdicts changes nothing');
  }

  // ➤ AND IT LINKS TO EVERY APPLICATION AT THAT EMPLOYER. Every other message
  // ➤ is about ONE vacancy, so a tie must not be guessed. A bounce is about the
  // ➤ ADDRESS, and mail that did not get through did not get through for any of
  // ➤ them. Real case: two applications to one employer the same day, one
  // ➤ failure notice — reported as an unresolved tie it says nothing useful.
  {
    const twin = [
      { id: 10, company: 'Machinebouw Banen', title: 'Project Engineer Offshore Wind', location: '', ts: '2026-07-22T09:00:00Z' },
      { id: 11, company: 'Machinebouw Banen', title: 'Project Engineer Starter', location: '', ts: '2026-07-22T09:00:00Z' },
    ];
    const note = { subject: 'Delivery Status Notification (Failure)', snippet: 'Address not found',
      body: 'machinebouwbanen', from: 'mailer-daemon@googlemail.com', date: '2026-07-23T09:00:00Z' };
    const out = linkOutcomes([{ ...note, kind: 'bounced' }], twin);
    eq(out.ties.length, 0, 'a bounce is never left as an unresolved tie');
    eq(out.links.length, 2, 'it lands on both applications sent to that employer');
    // ➤ Anything else in the same position still refuses to guess.
    const receipt = { ...note, subject: 'We have received your application', snippet: '', kind: 'acknowledged' };
    eq(linkOutcomes([receipt], twin).ties.length, 1, 'while a receipt in the same position is still a tie');
  }
  ok(!JSON.stringify(recs).includes('waiting'), 'the word waiting appears in no record at all');

  // ➤ Everything that happened is kept: "rejected after an interview" and
  // ➤ "rejected by a form" are not the same story, and one word cannot hold both.
  eq(recs.find(r => r.id === 3).reached, ['acknowledged', 'interview'], 'the whole path is recorded');

  // ➤ An invitation arriving after another receipt must not walk it backwards.
  const back = buildStatus([apps[2]], [
    link(3, 'interview', '2026-07-05T10:00:00Z'),
    link(3, 'acknowledged', '2026-07-06T10:00:00Z'),
  ], { today: new Date('2026-07-25T00:00:00Z') });
  eq(back[0].state, 'interview', 'a later receipt does not undo an invitation');

  // ➤ Longshots are counted apart: they were sent knowing they fell short, so
  // ➤ folding them in makes the search look worse than it is.
  const s = summarise(recs);
  eq(s.applications, 6, 'every application is counted');
  eq(s.rejected, 2, 'including the longshot that was rejected');
  eq(s.longshots, 1, 'and the longshots are named');
  // ➤ The one place they must NOT count: judging whether the filter chooses
  // ➤ well. A longshot was sent knowing it fell short, so its rejection is
  // ➤ not evidence against the search.
  eq(s.excludingLongshots.rejected, 1, 'the filter is judged without them');
  eq(s.excludingLongshots.interview, 1, 'and keeps the rest');
}

// ── 5) End to end, through the real pipeline ──────────────────────────────
// ➤ Every block above builds its own fixtures, and that is how a real failure
// ➤ hid: the hand-made links carried the classification in a place the actual
// ➤ linker does not put it, so buildStatus read undefined and every
// ➤ application came back "waiting" while the tests stayed green.
// ➤ This one starts from raw messages and lets classify -> link -> status run
// ➤ as they do in production. No hand-built links anywhere.
{
  const apps = [
    { id: 1, company: 'Van Oord', title: 'Offshore Engineer', location: 'Rotterdam', ts: '2026-07-01T09:00:00Z' },
    { id: 2, company: 'Fugro', title: 'Survey Engineer', location: 'Nootdorp', ts: '2026-07-02T09:00:00Z' },
    { id: 3, company: 'Boskalis', title: 'Marine Engineer', location: 'Papendrecht', ts: '2026-06-01T09:00:00Z' },
  ];
  const raw = [
    { subject: 'We have received your application', snippet: 'Van Oord thanks you', from: 'noreply@ats.com', date: '2026-07-01T10:00:00Z' },
    { subject: 'Fugro: unfortunately', snippet: 'we will not be proceeding', from: 'noreply@ats.com', date: '2026-07-09T10:00:00Z' },
    { subject: '5 new jobs for you', snippet: 'unsubscribe', from: 'alerts@board.com', date: '2026-07-03T10:00:00Z' },
  ];

  const outcomes = raw.map(m => ({ ...m, kind: classifyMessage(m) })).filter(m => m.kind && m.kind !== 'alert');
  eq(outcomes.length, 2, 'end-to-end: the alert is dropped, the two outcomes survive');

  const { links } = linkOutcomes(outcomes, apps);
  eq(links.length, 2, 'end-to-end: both outcomes link');

  const recs = buildStatus(apps, links, { today: new Date('2026-07-25T00:00:00Z') });
  const st = id => recs.find(r => r.id === id).state;
  eq(st(1), 'acknowledged', 'end-to-end: the receipt reaches the status file');
  eq(st(2), 'rejected', 'end-to-end: and so does the rejection');
  eq(st(3), 'noreply', 'end-to-end: the one nobody answered');

  const s = summarise(recs);
  ok(s.acknowledged === 1 && s.rejected === 1 && s.noreply === 1,
    'end-to-end: the summary counts what actually happened, not zeroes');
  ok(s.answered === 2, 'end-to-end: two of the three actually got a reply');
}

// ── 5b) What YOU sent is never an answer ──────────────────────────────────
// ➤ Gmail's search covers Sent as well as the inbox, and your own reply to a
// ➤ recruiter reads "thank you very much for considering me for an interview",
// ➤ which every pattern here calls an invitation. That is your own message
// ➤ reported to you as news. Found on a live mailbox: two such messages sat
// ➤ inside the read window; neither linked, but that was luck, not design.
{
  const since = new Date('2026-07-17T00:00:00Z');
  const q = searchFor(since);
  ok(q.includes('-from:me'), 'the search excludes anything you sent');
  ok(q.includes('after:2026/7/17'), 'and still starts at your oldest application');

  // ➤ The sentence itself, so the reason this filter exists cannot be
  // ➤ forgotten: without the filter, THIS is an interview.
  eq(classifyMessage({ subject: 'Re: Invitation to interview', from: 'you@example.com',
    snippet: 'Thank you very much for considering me for an interview' }),
    'interview', 'your own reply does classify as one — which is exactly why it must never be read');
}

// ── 6) How much of the mailbox it opens ───────────────────────────────────
// ➤ The window is derived from your own applications, not from a number
// ➤ somebody picked. Reading further back cannot find an answer to anything
// ➤ recorded, and every extra day is more of your mail read for nothing.
{
  const apps = [
    { id: 1, ts: '2026-07-18T19:45:00Z' },
    { id: 2, ts: '2026-07-30T09:38:00Z' },
    { id: 3, ts: '2026-07-20T09:00:00Z' },
  ];
  const from = windowFrom(apps);
  eq(from.toISOString().slice(0, 10), '2026-07-17', 'the window starts a day before the OLDEST application');
  ok(from < new Date(apps[0].ts), 'and never after it');

  eq(windowFrom([]), null, 'no applications, no window');
  eq(windowFrom([{ id: 1, ts: 'not a date' }]), null, 'an unreadable date does not become a window');

  // ➤ Gmail wants YYYY/M/D, not an ISO string: a wrong format silently returns
  // ➤ the whole mailbox instead of erroring.
  eq(gmailDate(new Date('2026-07-05T00:00:00Z')), '2026/7/5', 'the date is in the format Gmail search expects');
  ok(!/-|T|Z/.test(gmailDate(new Date())), 'never an ISO timestamp');
}

// ── 7) The message you actually read on the phone ────────────────────
{
  const status = {
    generated: '2026-07-30T00:00:00Z',
    summary: {},
    unlinked: { ambiguous: 2, unrelated: 9 },
    applications: [
      { id: 1, company: 'Van Oord', title: 'Offshore Engineer', state: 'interview', reached: ['interview'], daysWaiting: 6, longshot: false, evidence: [] },
      { id: 2, company: 'R&D <Marine>', title: 'Survey Engineer', state: 'acknowledged', reached: ['acknowledged'], daysWaiting: 4, longshot: false, evidence: [] },
      { id: 3, company: 'Quiet Ltd', title: 'Production Automation Systems Engineer', state: 'noreply', reached: [], daysWaiting: 9, longshot: false, evidence: [] },
      { id: 4, company: 'Reach Co', title: 'Lead Engineer', state: 'noreply', reached: [], daysWaiting: 1, longshot: true, evidence: [] },
      { id: 5, company: 'Nope BV', title: 'Marine Engineer', state: 'rejected', reached: ['rejected'], daysWaiting: 8, longshot: false, evidence: [] },
    ],
  };
  const txt = formatStatus(status);
  const lines = txt.split('\n');

  // ➤ An application belongs to ONE state. Listing the silent ones again
  // ➤ under "waiting" read as two different things and was one.
  for (const id of [1, 2, 3, 4, 5]) {
    const hits = lines.filter(l => l.includes('#' + id)).length;
    ok(hits <= 1, 'application #' + id + ' appears at most once');
  }

  // ➤ The three you can still do something about are listed one by one.
  ok(txt.includes('#3') && txt.includes('#4'), 'the ones nobody replied to are listed');
  ok(txt.includes('#2'), 'and one that was acknowledged');
  ok(txt.includes('#1'), 'and an interview');
  ok(!txt.includes('#5'), 'a rejection is counted, not listed — it is closed');
  ok(/🔴 1 Rejected\/Ghosted/.test(txt), 'but it is in the count line');

  // ➤ THERE IS NO BLUE CIRCLE. It stood for "sent less than three days ago",
  // ➤ which is not a thing that needs its own colour: the number of days is
  // ➤ right there on the row.
  ok(!txt.includes('🔵'), 'no blue circle anywhere');
  ok(!/just sent|waiting/i.test(txt), 'and no state named after being recent');
  // ➤ Every entry in the count line carries exactly one dot, and so does every
  // ➤ section heading. Written as a property rather than a number, because the
  // ➤ number changes every time a state is added and a stale count then fails
  // ➤ for a reason that has nothing to do with what it is guarding.
  const countLine = lines[1];
  const groups = countLine.split('·').length;
  eq((countLine.match(/\p{Extended_Pictographic}/gu) || []).length, groups, 'one dot per entry in the count line');
  const headings = lines.filter(l => /^<b>\p{Extended_Pictographic}/u.test(l));
  eq(headings.length, lines.filter(l => /^<b>/.test(l)).length - 1, 'and one on every section heading');

  // ➤ Least progress first: N/A, received, rejected, interview.
  const at = s => txt.indexOf(s);
  ok(at('⚪ 2 N/A') >= 0 && at('🟡 1 Received') > at('⚪ 2 N/A'), 'N/A is counted before received');
  ok(at('🔴 1 Rejected/Ghosted') > at('🟡 1 Received'), 'received before rejected');
  ok(at('🟢 1 Interview') > at('🔴 1 Rejected/Ghosted'), 'and rejected before interview');
  ok(at('<b>⚪ N/A</b>') >= 0 && at('<b>🟡 Received</b>') > at('<b>⚪ N/A</b>'), 'the sections follow the same order');
  ok(at('<b>🟢 Interview</b>') > at('<b>🟡 Received</b>'), 'with interview last');

  // ➤ A STATE NOBODY IS IN GETS NO LINE. "0 never arrived · 0 ghosted" was
  // ➤ most of the count and none of the information.
  ok(!/0 (N\/A|Received|Rejected|Never)/.test(lines[1]), 'the count line carries no empty states');
  ok(!/never arrived/i.test(txt), 'and no heading for a state with nobody in it');

  // ➤ EXCEPT THE INTERVIEW, which is always there. It is what all of this is
  // ➤ for: "0 Interview" says something, and a green circle missing from the
  // ➤ line reads as a fault rather than as an answer.
  {
    const none = formatStatus({ applications: [
      { id: 1, company: 'A', title: 'T', state: 'noreply', reached: [], daysWaiting: 5 },
    ] });
    ok(/🟢 0 Interview/.test(none), 'the green is on the line even at zero');
    ok(!/<b>🟢 Interview<\/b>/.test(none), 'but there is no empty section under it');
  }

  // ➤ FOUR COLOURS. Every state does not need one of its own — past four you
  // ➤ are decoding a legend instead of reading a list. Blue ("just sent") and
  // ➤ orange ("never arrived") were both tried and both thrown out.
  eq([...new Set(txt.match(/\p{Extended_Pictographic}/gu) || [])].length <= 4, true, 'no more than four colours in the whole message');
  ok(!txt.includes('🟠') && !txt.includes('🔵'), 'and neither orange nor blue is one of them');

  // ➤ Ghosted shares the red with a rejection: after two months of silence the
  // ➤ answer is the same one, and a second shade of red only asks the reader to
  // ➤ remember which is which.
  {
    const g = formatStatus({ applications: [
      { id: 1, company: 'A', title: 'T', state: 'ghosted', reached: [], daysWaiting: 70 },
      { id: 2, company: 'B', title: 'T', state: 'rejected', reached: ['rejected'], daysWaiting: 30 },
    ] });
    ok(/🔴 2 Rejected\/Ghosted/.test(g), 'the two are counted together under one red');
    ok(!/🔴 \d+ Rejected(?!\/)/.test(g), 'and never as two separate reds');
  }

  // ➤ Longest silence at the top: with no separate state for the recent ones,
  // ➤ this is what keeps the ones worth chasing where they can be seen.
  ok(at('#3 Quiet Ltd') < at('#4 Reach Co'), 'nine days of silence is listed above one');

  // ➤ Every circle is spelled out. Colours and bare numbers meant nothing to
  // ➤ anyone who did not already know the code by heart.
  for (const [dot, word] of [['⚪', 'N/A'], ['🟡', 'Received'], ['🔴', 'Rejected/Ghosted'], ['🟢', 'Interview']]) {
    ok(new RegExp(dot + ' \\d+ ' + word.replace('/', '\\/')).test(txt), `the ${dot} circle says what it means`);
  }

  // ➤ IN ENGLISH WHEREVER THERE IS AN ENGLISH VERSION. The offers list has
  // ➤ always translated titles; this list never did, so a Spanish posting
  // ➤ reached the phone in Spanish. The employer's own wording stays in the
  // ➤ file — the posting has to remain findable on their site — but what is
  // ➤ printed reads in one language.
  {
    const withEn = formatStatus({ applications: [
      { id: 9, company: 'Gaviplas', title: 'Ingeniero de automatización industrial',
        titleEn: 'Industrial automation engineer', state: 'noreply', reached: [], daysWaiting: 8 },
    ] });
    ok(withEn.includes('Industrial automation engineer'), 'the English version is what gets printed');
    ok(!withEn.includes('automatización'), 'and the original is not shown as well');
    // ➤ No English version, no problem: the original is better than nothing.
    const noEn = formatStatus({ applications: [
      { id: 9, company: 'X', title: 'Ingeniero naval', state: 'noreply', reached: [], daysWaiting: 8 },
    ] });
    ok(noEn.includes('Ingeniero naval'), 'an untranslated title still shows');
  }

  // ➤ NOTHING IS CLIPPED. Cutting "Production Automation Systems Engineer"
  // ➤ down to "Production Automation Sys…" tells you less and looks broken.
  ok(!txt.includes('…'), 'no ellipsis anywhere');
  ok(txt.includes('Production Automation Systems Engineer'), 'a long job title survives whole');
  ok(txt.includes('#3 Quiet Ltd - Production Automation Systems Engineer (9d)'), 'company, title and the wait, all of it');

  // ➤ It still has to fit a phone.
  ok(lines.length <= 20, 'the message stays short (' + lines.length + ' lines)');
  ok(txt.length < 3500, 'and well inside the Telegram limit');

  ok(txt.includes(' - '), 'fields are separated with a hyphen');
  ok(!lines.slice(2).some(l => l.includes('·')), 'the middle dot appears only in the count line, never in a listing');

  // ➤ Job boards send company names with & and <> in them, and a raw one
  // ➤ makes Telegram reject the whole message.
  ok(txt.includes('R&amp;D') && txt.includes('&lt;Marine&gt;'), 'company names are escaped');
  ok(!/[^&]&(?!amp;|lt;|gt;)/.test(txt), 'no unescaped ampersand survives');

  // ➤ The old footer told you nothing you could use.
  ok(!/got a reply/.test(txt), 'no arithmetic footer');
  ok(!/Receipts always arrive/.test(txt), 'no explanatory paragraph');
  ok(!/Last checked/.test(txt), 'no staleness note');

  eq(formatStatus({ applications: [] }).includes('No applications on record'), true, 'an empty record says so plainly');
  // ➤ A BROKEN FILE MUST SAY SO, NOT THROW. The guard used to ask for a
  // ➤ length, and a string has one — so "applications" arriving as text walked
  // ➤ past it and died on the next line with "apps.filter is not a function".
  // ➤ Found by feeding the command a deliberately malformed file, not by
  // ➤ reading the code.
  for (const junk of [{ applications: 'not an array' }, { applications: 42 }, { applications: {} }, {}, null, undefined, 'nonsense']) {
    let out;
    try { out = formatStatus(junk); } catch (e) { out = `THREW ${e.message}`; }
    ok(typeof out === 'string' && out.includes('No applications on record'),
      `a malformed status file is answered, not thrown at: ${JSON.stringify(junk)}`);
  }
}

// ── 7b) A tie has to be answerable, or it is not worth reporting ─────────
// ➤ The rule that produces ties says "the message is shown and you say which
// ➤ one it was". Nothing was shown: only the COUNT reached the report, so it
// ➤ said "1 email fit more than one application" and named no employer, no
// ➤ kind and no application. Today's tie rule made that outcome commoner, so
// ➤ the promise had to be kept (audit 2026-08-01).
{
  const twoAtOne = [
    { id: 664, company: 'ACME', title: 'Mooring Engineer', state: 'noreply', ts: '2026-07-01T09:00:00Z' },
    { id: 665, company: 'ACME', title: 'Survey Engineer', state: 'noreply', ts: '2026-07-01T09:30:00Z' },
  ];
  const txt = formatStatus({ applications: twoAtOne,
    unlinked: { ambiguous: 1, unrelated: 0, cases: [{ kind: 'interview', ids: [664, 665] }] } });
  ok(/fit more than one application/.test(txt), 'the count is still reported');
  ok(/#664 or #665/.test(txt), 'and the applications it is torn between are named');
  ok(/an interview/.test(txt), 'and what kind of message it was — an unassigned interview is the costly one');

  // ➤ A refusal reads differently, because "no N" can settle it.
  const rej = formatStatus({ applications: twoAtOne,
    unlinked: { ambiguous: 1, unrelated: 0, cases: [{ kind: 'rejected', ids: [664, 665] }] } });
  ok(/a refusal that fits #664 or #665/.test(rej), 'a tied refusal says so');

  // ➤ An old status file written before this existed has no cases; it must
  // ➤ still print, not throw.
  const legacy = formatStatus({ applications: twoAtOne, unlinked: { ambiguous: 2, unrelated: 0 } });
  ok(/fit more than one application/.test(legacy), 'a status file from before this change still reports');

  // ➤ And with nothing tied, nothing is said about ties at all.
  ok(!/fit more than one/.test(formatStatus({ applications: twoAtOne, unlinked: { ambiguous: 0, unrelated: 3 } })),
     'no ties, no line');

  // ➤ Only five are listed, and the message has to SAY the rest exist: stopping
  // ➤ in silence reads as "that was all", and the sixth could be the interview.
  const manyCases = Array.from({ length: 8 }, (_, i) => ({ kind: 'rejected', ids: [664, 665, i] }));
  const capped = formatStatus({ applications: twoAtOne, unlinked: { ambiguous: 8, unrelated: 0, cases: manyCases } });
  eq((capped.match(/that fits/g) || []).length, 5, 'at most five tied messages are listed');
  ok(/and 3 more/.test(capped), 'and the ones left out are counted, not hidden');
}

// ── 7c) The longest silence is read first ────────────────────────────────
// ➤ The "no reply" pile is sorted by how long you have been waiting, so the
// ➤ application that has been silent longest is the first thing you see. It is
// ➤ one line of code and nothing pinned it: remove the sort and the report
// ➤ still prints, just in an order that buries the one worth chasing.
{
  // ➤ daysWaiting is computed upstream by status.mjs and carried on the record;
  // ➤ the report sorts on it rather than re-deriving it from the date.
  const txt = formatStatus({ applications: [
    { id: 1, company: 'Recent', title: 'A', state: 'noreply', daysWaiting: 3 },
    { id: 2, company: 'Oldest', title: 'B', state: 'noreply', daysWaiting: 40 },
    { id: 3, company: 'Middle', title: 'C', state: 'noreply', daysWaiting: 20 },
  ] });
  const order = ['Oldest', 'Middle', 'Recent'].map(n => txt.indexOf(n));
  ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2],
     'the longest silence is listed first, then in descending order');
}

// ── 8) No application may fall between the states ───────────────────────
// ➤ The report knows six states. One in any OTHER state appeared in no section
// ➤ AND in no count, while the header kept printing the full total — so the
// ➤ figures silently disagreed and an application was simply not on the screen.
// ➤ It happened for real: a state was renamed in one file and not the other
// ➤ (audit 2026-07-31).
{
  const base = { applications: [
    { id: 1, company: 'ACME', title: 'Mooring Engineer', state: 'noreply', ts: '2026-07-01T09:00:00Z' },
    { id: 2, company: 'BETA', title: 'Survey Engineer', state: 'acknowledged', ts: '2026-07-02T09:00:00Z' },
  ] };
  const clean = formatStatus(base);
  ok(!/unknown state/.test(clean), 'a report with only known states says nothing about unknown ones');

  const odd = { applications: [...base.applications,
    { id: 3, company: 'GAMMA', title: 'Design Engineer', state: 'waiting', ts: '2026-07-03T09:00:00Z' }] };
  const txt = formatStatus(odd);
  ok(/unknown state/.test(txt), 'an application in an unrecognised state is reported, not hidden');
  ok(/waiting/.test(txt), 'and the state is named so it can be tracked down');
  ok(/Applications . 3/.test(txt), 'the header still counts it');
}

if (fail) { console.log(`\n${fail}/${pass + fail} mail tests FAILED.`); process.exit(1); }
console.log(`All ${pass} mail tests passed.`);
