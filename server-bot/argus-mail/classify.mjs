#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ Given a job email's sender and subject, says what KIND of thing happened:
// ➤ acknowledged, turned down, or they want to talk. It opens no mailbox — a
// ➤ few lines in, one word out. Word lists, not a model: on 500 real messages
// ➤ they found 46 outcomes with 2 false alarms, cost nothing per scan and are
// ➤ easy to fix. EDIT THEM; wording missing from any of the languages here is
// ➤ filed as unknown rather than guessed at.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ Accents removed and lowercased, so "recibí" and "recibi" are one thing.
import { fold } from '../text.mjs';
export { fold };

// ➤ ── DUTCH: BELGIUM AND THE NETHERLANDS ──────────────────────────────────
// ➤ Both write here, and they differ in words, not accents — Belgian first:
// ➤ kandidatuur/sollicitatie (application), niet weerhouden/niet geselecteerd
// ➤ (not selected), opportuniteit/kans, contactname/contact opnemen, plus a
// ➤ formal "u". A real Belgian rejection matched nothing, so both are listed.

// ➤ A refusal, and it has to be caught in both directions: the negative ("we
// ➤ will not continue with you") and the positive, which reads like good news
// ➤ until the sentence ends — "continue with OTHER candidates", "verder te
// ➤ gaan met andere kandidaten".
// ➤ "not to (go|move) forward" added 2026-08-05: a real employer wrote "we
// ➤ have decided not to go forward with your application" — negation BEFORE
// ➤ the verb, which neither "not moving/proceeding" nor "decided to go
// ➤ forward with another" covered, so two real rejections sat as acknowledged.
export const REJECTED = /unfortunately|we regret|regret to inform|not (be )?(moving|proceeding|selected|continuing)|not to (go|move) (forward|ahead)|not to proceed|other candidates|another candidate|no longer under consideration|unsuccessful|decided to (move|proceed|continue|go) (forward |ahead )?with (other|another)|lamentamos|no hemos podido|no continuaremos|no seguiremos|otros candidatos|otro candidato|hemos decidido continuar con|no ha sido seleccion|no encaja|helaas|niet verder|verder te gaan met andere|met andere kandidaten|niet geselecteerd|geen match|niet weerhouden|niet in aanmerking|kandidatuur niet|met een andere kandidaat|leider|absage|nicht beruck|haben wir uns fur (einen anderen|andere)|entschieden, mit anderen|nous ne donnerons pas suite|votre candidature n'a pas|d'autres candidat/;

// ➤ Someone wants to speak to you: the strongest verdict and the easiest to
// ➤ get wrong, so every phrase here names a CONVERSATION and nothing less.
// ➤ ABSENT ON PURPOSE: "next step(s)" and "siguiente paso" close almost every
// ➤ automated receipt and turned 3 of them into invitations; a bare
// ➤ "invitation" goes the same way, systems inviting you to complete profiles.
export const INTERVIEW = /\binterview\b|entrevista|\bgesprek\b|vorstellungsgesprach|schedule a (call|chat|meeting|conversation)|invite you (to|for) an? (interview|call|chat|conversation|meeting)|would like to (speak|talk|meet|arrange)|available for a (call|chat|meeting)|kennismaking|kennismakingsgesprek|een afspraak (in)?plannen|nos gustaria (hablar|conocerte|charlar)|te gustaria (hablar|charlar)|concertar una (llamada|entrevista|reunion)|agendar una (llamada|entrevista|reunion)|primera toma de contacto/;

// ➤ ── A PROMISE IS NOT AN INVITATION ──────────────────────────────────────
// ➤ Receipts describe what MIGHT follow in the words of a real invitation:
// ➤ "we will inform you whether we see the right fit TO INVITE YOU FOR AN
// ➤ INTERVIEW" is a company that has not decided, and it was read as one.
// ➤ These words mark that pending decision — deliberately NOT "if you are
// ➤ available" or "if it suits you", which is how a genuine invitation is
// ➤ politely worded. WHO it hangs on is irrelevant ("if YOU are selected, we
// ➤ will invite you" passed as a real interview in English, German and Dutch),
// ➤ so the maybe is pinned to selected/shortlisted/successful, a few words
// ➤ apart, and to nothing else — "a match" and "the right fit" describe the
// ➤ OFFER suiting YOU, and binned real invitations.
const PICKED = '(selected|shortlisted|successful|chosen)';
export const CONDITIONAL = new RegExp([
  '\\bwhether\\b', 'in case',
  `if (we|there is|your (application|profile|cv|candidacy|background))`,
  `if [a-z ]{0,12}(is |are |were )?${PICKED}`,
  `when [a-z ]{0,12}(is |are |were )?${PICKED}`,
  'should (we|there|your (application|profile))',
  // ➤ Spanish
  'si (tu|su) (perfil|candidatura|solicitud)', 'en caso de', 'si (encajas|resultas|eres seleccionad|es seleccionad)',
  // ➤ Dutch: "indien wij" is the company deciding, but "indien u/je" also opens
  // ➤ invitations, so that form must name a decision as the English clauses do.
  'indien (we|wij)', 'mocht (u|je|uw)',
  'indien (u|uw|je)[a-z ]{0,20}(geselecteerd|weerhouden|geschikt|in aanmerking)',
  'als (je|u|uw)[a-z ]{0,15}(geselecteerd|geschikt)',
  // ➤ German, same split: "falls Sie Interesse haben" opens an invitation.
  'falls (wir|ihre)', 'wenn wir',
  'falls (sie|du)[a-z ]{0,20}(ausgewahlt|ausgewaehlt|passen|geeignet)',
  'wenn (sie|du)[a-z ]{0,15}(ausgewahlt|ausgewaehlt|passen)',
  // ➤ French
  'si (vous|votre)[a-z ]{0,15}(retenu|selectionn)',
].join('|'));

// ➤ Does a sentence say this OUTRIGHT rather than as a possibility? One
// ➤ sentence at a time, so a later one cannot cancel a real invitation, and
// ➤ only what precedes the phrase counts: the condition always leads.
export function saidOutright(pattern, text) {
  for (const sentence of String(text).split(/[.!?;·•]+/)) {
    const m = sentence.match(pattern);
    if (m && !CONDITIONAL.test(sentence.slice(0, m.index))) return true;
  }
  return false;
}

// ➤ Advice ABOUT interviews, not an invitation to one: without this every
// ➤ newsletter of interview tips reads as good news.
// ➤ OPENING ONLY (see classifyMessage): these words fill the footer of almost
// ➤ every HTML mail, a marketing department talking rather than the message,
// ➤ and over a whole body they cancelled a real invitation.
// ➤ WHOLE WORDS ONLY: as fragments they hide inside innocent ones and bin
// ➤ invitations — "curso" in "recursos humanos", "guide" in "guidelines",
// ➤ which is what a company attaches to a real one. Missing an interview is
// ➤ the costliest mistake this file can make, so anything able to cancel one
// ➤ must match exactly; "en curso" is out entirely, being ordinary Spanish
// ➤ for "under way".
export const ADVICE = /\btips\b|\bhow to\b|\bguides?\b|\bprepare for\b|\bconsejos\b|(?<!\ben )\bcursos?\b|\bwebinars?\b|\bblogs?\b|\barticles?\b|\bnewsletters?\b/;

// ➤ The automated receipt, the commonest outcome by far: nearly every ATS
// ➤ sends one. Three things it must tolerate, each having swallowed a real
// ➤ receipt — "Thanks" as well as "Thank you"; the formal as well as the
// ➤ informal wherever a language has both (Dutch "uw sollicitatie": a company
// ➤ writing to a stranger is formal, which is most of this mailbox); and
// ➤ polite padding between the thanks and the "for" ("thank you SO MUCH for
// ➤ your interest"), which the middle group absorbs. "Reviewing your
// ➤ application" is here because it says the same thing plainly.
export const ACKNOWLEDGED = /(we have|we've) received|thanks? (you )?(so much |very much |once again |again |kindly )?for (your )?(applying|application|interest|submitting)|(is |are |currently )?reviewing (your|all) applications?|application (has been )?received|received your application|hemos recibido (tu|su)|gracias por (tu|su) (candidatura|solicitud|interes|postulacion)|candidatura recibida|bedankt voor (je|uw|jouw) (sollicitatie|kandidatuur|interesse)|(we|wij) hebben (je|uw|jouw) (sollicitatie|kandidatuur)|(sollicitatie|kandidatuur) (goed )?ontvangen|goed ontvangen|nous avons (bien )?recu|merci de votre candidature|vielen dank fur (ihre|deine) bewerbung|danke fur (deine|ihre) bewerbung|eingang (ihrer|deiner) bewerbung/;

// ➤ THE APPLICATION NEVER ARRIVED — the mail system handing your own message
// ➤ back, not a reply from anybody. The most useful verdict here: everything
// ➤ else says how you did, this says you never competed and can apply again.
// ➤ A real mailbox held 3.
// ➤ ONLY A FAILURE COUNTS. The same sender also writes "Delivery Status
// ➤ Notification (Delay)" while it is still retrying, and a delay usually ends
// ➤ in delivery (2 of those 3 did), so the sender is no part of this test.
export const BOUNCED = /undelivered mail returned|delivery status notification \(failure\)|address not found|recipient address rejected|user unknown|no such user|mailbox (is )?(unavailable|full)|550[ -]5\.|domain .{0,30}not found/;

// ➤ Mailshots about jobs you have NOT applied to. They name roles and
// ➤ companies constantly, so unspotted they poison everything downstream.
export const ALERT = /job alert|new jobs|jobs for you|recommended for you|nuevas ofertas|ofertas para ti|empleos recomendados|vacatures voor jou|nieuwe vacatures|neue jobs|job digest|we found \d|hemos encontrado|apply now|postula ya|solliciteer nu|unsubscribe|darse de baja/;

// ➤ The part of the list above that can ONLY be a mailshot — wording no company
// ➤ uses to one person about one application. The early test uses this set, and
// ➤ the narrowing is not academic: "hemos encontrado" with no number after it
// ➤ also opens a Spanish refusal ("... hemos encontrado otro candidato"), which
// ➤ spent sixty days filed as advertising. Calls to action and "unsubscribe"
// ➤ stay out too, genuine company mail carrying them; they still count in the
// ➤ full test at the end, where a message has failed to be anything else.
export const ALERT_DECLARED = /job alert|new jobs|jobs for you|recommended for you|nuevas ofertas|ofertas para ti|empleos recomendados|vacatures voor jou|nieuwe vacatures|neue jobs|job digest|we found \d|hemos encontrado \d/;

// ➤ Returns 'bounced' | 'rejected' | 'interview' | 'acknowledged' | 'alert' |
// ➤ null. null means "not about an application", and it is the honest answer
// ➤ far more often than any of the others.
export function classifyMessage({ subject = '', snippet = '', body = '', from = '' } = {}) {
  // ➤ The body is included: it found 3 outcomes whose wording sat past the
  // ➤ snippet's ~200 characters, and contradicted none.
  const text = fold(`${subject} ${snippet} ${body}`);
  if (!text.trim()) return null;

  // ➤ The opening alone. A mail says what it IS here; the body can run to a
  // ➤ thousand words of navigation and legal boilerplate about the sender.
  const opening = fold(`${subject} ${snippet}`);

  // ➤ The order is not arbitrary: a rejection thanks you for applying, an
  // ➤ invitation may quote the acknowledgement it follows, and a newsletter
  // ➤ says all of those words meaning none of them. The two verdicts that
  // ➤ change what you would DO must be said outright, a receipt offering both
  // ➤ as possibilities. The bounce leads because it is not a reply at all: it
  // ➤ quotes your own application back, which every pattern below would read.
  if (BOUNCED.test(text)) return 'bounced';

  // ➤ A MAILSHOT IS SPOTTED BEFORE ANY MEANING IS READ INTO IT: a digest
  // ➤ carries the advertising text of every vacancy it lists, so from the
  // ➤ bottom of the function one was filed as a rejection and another as an
  // ➤ interview, against real applications made elsewhere.
  // ➤ ON THE OPENING ONLY: "unsubscribe" sits in the footer of nearly every
  // ➤ company mail, so over the whole text this would bin genuine replies.
  if (ALERT_DECLARED.test(opening)) return 'alert';

  if (saidOutright(REJECTED, text)) return 'rejected';
  if (saidOutright(INTERVIEW, text) && !ADVICE.test(opening)) return 'interview';
  if (ACKNOWLEDGED.test(text)) return 'acknowledged';
  // ➤ Last resort, for a digest that only owns up to what it is further down.
  if (ALERT.test(text)) return 'alert';
  return null;
}

// ➤ Does this look like it came from a recruiting system rather than a person?
// ➤ Used to decide whether a message is worth trying to link at all.
export const ATS_SENDER = /(no-?reply|do-?not-?reply|noreply|careers?|recruit|talent|jobs?|hiring|apply|sollicit|empleo|bewerbung)@|@(workday|myworkday|successfactors|greenhouse|lever|smartrecruiters|teamtailor|recruitee|personio|softgarden|jobvite|icims|taleo|talentclue|bizneo|factorial|workable|ashby|epreselec)/;

// ➤ Only the address is read, never the text: a human writing from their own
// ➤ company address is a different kind of message from a no-reply robot.
export function looksAutomated(from) {
  return ATS_SENDER.test(fold(from));
}
