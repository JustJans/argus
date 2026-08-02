#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: it reads a job email's sender and subject and says what KIND
// ➤ of thing happened: they acknowledged your application, they turned you
// ➤ down, or they want to talk. Nothing else here reads your mail; this only
// ➤ receives a few lines of text and returns a word.
// ➤ WHY IT IS WORD LISTS AND NOT A MODEL: measured on 500 real messages, these
// ➤ patterns found 46 outcomes and only 2 false alarms. A model would cost
// ➤ money per scan and be harder to correct when it is wrong.
// ➤ EDIT THESE LISTS. They cover the languages the search covers; when a
// ➤ company words a rejection in a way that is not here, the message is filed
// ➤ as unknown rather than guessed at, and adding the phrase fixes it for good.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ Accents removed and lowercased, so "recibí" and "recibi" are one thing.
export const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ➤ ── A NOTE ON DUTCH ─────────────────────────────────────────────────────
// ➤ Belgium and the Netherlands do not write the same Dutch, and this mailbox
// ➤ gets both. The differences that matter here are not accents, they are
// ➤ different words for the same thing:
// ➤   Belgium              Netherlands           meaning
// ➤   kandidatuur          sollicitatie          application
// ➤   niet weerhouden      niet geselecteerd     not selected
// ➤   opportuniteit        kans / mogelijkheid   opportunity
// ➤   contactname          contact opnemen       getting in touch
// ➤ Belgian mail also leans on the formal "u" where a Dutch company might use
// ➤ "je". A real Belgian rejection matched nothing at all because only the
// ➤ Netherlands wording was written down, so both are listed everywhere below.

// ➤ A refusal. Checked FIRST: a rejection often opens by thanking you for
// ➤ applying, so the polite acknowledgement wording is in there too and
// ➤ whichever is tested first wins.
// ➤ TWO WAYS OF SAYING IT, and both have to be here. The negative — "we will
// ➤ not continue with you" — is the obvious one. The positive is just as
// ➤ common and reads like good news until you finish the sentence: "we have
// ➤ decided to continue with OTHER candidates". A real Dutch rejection said
// ➤ exactly that ("verder te gaan met andere kandidaten") and was read as
// ➤ nothing at all, because only "niet verder" was listed.
export const REJECTED = /unfortunately|we regret|regret to inform|not (be )?(moving|proceeding|selected|continuing)|other candidates|another candidate|no longer under consideration|unsuccessful|decided to (move|proceed|continue|go) (forward |ahead )?with (other|another)|lamentamos|no hemos podido|no continuaremos|no seguiremos|otros candidatos|otro candidato|hemos decidido continuar con|no ha sido seleccion|no encaja|helaas|niet verder|verder te gaan met andere|met andere kandidaten|niet geselecteerd|geen match|niet weerhouden|niet in aanmerking|kandidatuur niet|met een andere kandidaat|leider|absage|nicht beruck|haben wir uns fur (einen anderen|andere)|entschieden, mit anderen|nous ne donnerons pas suite|votre candidature n'a pas|d'autres candidat/;

// ➤ Someone wants to speak to you. The strongest thing this can find, and the
// ➤ easiest to get wrong.
// ➤ WHAT IS NOT HERE, AND WHY: "next step(s)" and "siguiente paso" used to be.
// ➤ They are the closing line of almost every automated receipt — "we will be
// ➤ in touch about the next steps" — so once the whole body was being read
// ➤ instead of the first 200 characters, three plain acknowledgements were
// ➤ reported as interview invitations. A bare "invitation" went the same way:
// ➤ systems invite you to complete profiles and confirm addresses.
// ➤ What is left names a CONVERSATION: the word interview itself, or someone
// ➤ proposing to talk to you.
export const INTERVIEW = /\binterview\b|entrevista|\bgesprek\b|vorstellungsgesprach|schedule a (call|chat|meeting|conversation)|invite you (to|for) an? (interview|call|chat|conversation|meeting)|would like to (speak|talk|meet|arrange)|available for a (call|chat|meeting)|kennismaking|kennismakingsgesprek|een afspraak (in)?plannen|nos gustaria (hablar|conocerte|charlar)|te gustaria (hablar|charlar)|concertar una (llamada|entrevista|reunion)|agendar una (llamada|entrevista|reunion)|primera toma de contacto/;

// ➤ ── THE HARDEST THING IN THIS FILE: A PROMISE IS NOT AN INVITATION ──────
// ➤ A receipt very often describes the process that MIGHT follow, in the exact
// ➤ words a real invitation uses. A real one:
// ➤   "we will inform you whether we see the right fit TO INVITE YOU FOR AN
// ➤    INTERVIEW"
// ➤ — that is a company telling you they have not decided. Read without the
// ➤ opening of the sentence it is indistinguishable from good news, and it was
// ➤ reported as an interview until someone opened the mail and looked.
// ➤ These are the words that turn the sentence into a maybe. They are about
// ➤ THE COMPANY still deciding — deliberately NOT "if you are available" or
// ➤ "if it suits you", which is how a real invitation is worded politely.
// ➤ IT DOES NOT MATTER WHO THE CONDITION IS ABOUT (audit 2026-07-31). This list
// ➤ only knew how to spot a condition attached to the COMPANY — "if WE", "if
// ➤ SELECTED", "wenn WIR" — and walked straight past the commoner way of
// ➤ writing the very same sentence, which puts YOU in it: "if you are selected,
// ➤ we will invite you for an interview". Tested against ordinary hand-written
// ➤ receipts, that phrasing was announced as a real interview in English,
// ➤ German and Dutch — you would have been told to expect a call that nobody
// ➤ had decided to make. What makes the sentence a maybe is the word
// ➤ "selected / shortlisted / successful", not the person it is hung on, so a
// ➤ few words are now allowed in between.
// ➤ BUT ONLY THOSE WORDS (audit 2026-08-01). "a match" and "the right fit" were
// ➤ added alongside them and had to come straight back out: they describe the
// ➤ OFFER suiting YOU, not the company choosing. "If this is the right fit for
// ➤ you, we would like to invite you for an interview" is an invitation, and
// ➤ with those two in the list it was thrown away entirely — which is the very
// ➤ mistake the paragraph above warns against.
const PICKED = '(selected|shortlisted|successful|chosen)';
export const CONDITIONAL = new RegExp([
  '\\bwhether\\b', 'in case',
  // ➤ "if we ... / if your application ... / if you are selected ..."
  `if (we|there is|your (application|profile|cv|candidacy|background))`,
  `if [a-z ]{0,12}(is |are |were )?${PICKED}`,
  `when [a-z ]{0,12}(is |are |were )?${PICKED}`,
  'should (we|there|your (application|profile))',
  // ➤ Spanish
  'si (tu|su) (perfil|candidatura|solicitud)', 'en caso de', 'si (encajas|resultas|eres seleccionad|es seleccionad)',
  // ➤ Dutch: "als je/u wordt geselecteerd", "indien wij/uw", "mocht u/je"
  // ➤ Dutch. "indien wij" is the company deciding; "indien u/je" addresses the
  // ➤ reader ("indien u geïnteresseerd bent") and opens a real invitation — so
  // ➤ that form has to name a decision, as the English clauses do.
  'indien (we|wij)', 'mocht (u|je|uw)',
  'indien (u|uw|je)[a-z ]{0,20}(geselecteerd|weerhouden|geschikt|in aanmerking)',
  'als (je|u|uw)[a-z ]{0,15}(geselecteerd|geschikt)',
  // ➤ German, same split: "falls Sie Interesse/Fragen haben" is the polite
  // ➤ opening of an invitation, not a company still deciding.
  'falls (wir|ihre)', 'wenn wir',
  'falls (sie|du)[a-z ]{0,20}(ausgewahlt|ausgewaehlt|passen|geeignet)',
  'wenn (sie|du)[a-z ]{0,15}(ausgewahlt|ausgewaehlt|passen)',
  // ➤ French: "si vous êtes retenu / sélectionné"
  'si (vous|votre)[a-z ]{0,15}(retenu|selectionn)',
].join('|'));

// ➤ Does some sentence say this OUTRIGHT, rather than as a possibility?
// ➤ Sentence by sentence, and only what comes BEFORE the phrase counts: the
// ➤ condition always leads ("whether we ... to invite you"), and a later
// ➤ sentence about something else must not cancel a real invitation.
export function saidOutright(pattern, text) {
  for (const sentence of String(text).split(/[.!?;·•]+/)) {
    const m = sentence.match(pattern);
    if (m && !CONDITIONAL.test(sentence.slice(0, m.index))) return true;
  }
  return false;
}

// ➤ Only advice ABOUT interviews, not an invitation to one. Without this,
// ➤ every newsletter offering interview tips counts as good news.
// ➤ READ ONLY IN THE OPENING — see classifyMessage. These words live in the
// ➤ footer of almost every HTML mail ever sent ("read our blog", "articles",
// ➤ "guides"), so once whole bodies started being read, this cancelled a real
// ➤ interview invitation. A message declares what it IS in its subject; its
// ➤ footer only declares that a marketing department exists.
// ➤ WHOLE WORDS ONLY (audit 2026-07-31). Written as bare fragments, these words
// ➤ hid inside longer, innocent ones and quietly threw real invitations away:
// ➤ "curso" sits inside "reCURSOs humanos" and inside "proceso en curso";
// ➤ "guide" sits inside "guidelines", which is exactly what a company writes
// ➤ when it attaches joining instructions to a genuine interview invitation.
// ➤ All three were reproduced, and each time the mail was filed as nothing at
// ➤ all: the application stayed on "no reply" and was written off two months
// ➤ later. Missing an interview is the most expensive mistake this file can
// ➤ make, so anything with the power to cancel one has to match exactly.
// ➤ Bare "curso" is gone for good — on its own it is ordinary Spanish for
// ➤ "under way". Only the plural and "curso de" mean a training course.
export const ADVICE = /\btips\b|\bhow to\b|\bguides?\b|\bprepare for\b|\bconsejos\b|(?<!\ben )\bcursos?\b|\bwebinars?\b|\bblogs?\b|\barticles?\b|\bnewsletters?\b/;

// ➤ The automated receipt. Almost every ATS sends one, which is why it is by
// ➤ far the most common outcome in the mailbox.
// ➤ "Thank you" and "Thanks" are both here on purpose: the pattern used to
// ➤ spell out only the first, and "Thanks for applying" — as ordinary a way of
// ➤ putting it as exists — was read as nothing at all.
// ➤ FORMAL AND INFORMAL, in every language that has the distinction. Dutch
// ➤ "wij hebben UW sollicitatie ontvangen" went unrecognised because only the
// ➤ informal "we hebben JE sollicitatie" was written down. A company writing
// ➤ to a stranger uses the formal form, which is most of this mailbox.
// ➤ THE POLITE PADDING BREAKS IT, and that is why the middle group exists.
// ➤ "Thank you SO MUCH for your interest in joining us" is as ordinary as
// ➤ writing gets, and it matched nothing at all: the pattern wanted "thank you"
// ➤ and "for" side by side. A real receipt sat in the no-reply pile for a week
// ➤ because of two words of courtesy.
// ➤ "Reviewing your application" is here for the same message: it says plainly
// ➤ that the application arrived, which is the whole meaning of a receipt.
export const ACKNOWLEDGED = /(we have|we've) received|thanks? (you )?(so much |very much |once again |again |kindly )?for (your )?(applying|application|interest|submitting)|(is |are |currently )?reviewing (your|all) applications?|application (has been )?received|received your application|hemos recibido (tu|su)|gracias por (tu|su) (candidatura|solicitud|interes|postulacion)|candidatura recibida|bedankt voor (je|uw|jouw) (sollicitatie|kandidatuur|interesse)|(we|wij) hebben (je|uw|jouw) (sollicitatie|kandidatuur)|(sollicitatie|kandidatuur) (goed )?ontvangen|goed ontvangen|nous avons (bien )?recu|merci de votre candidature|vielen dank fur (ihre|deine) bewerbung|danke fur (deine|ihre) bewerbung|eingang (ihrer|deiner) bewerbung/;

// ➤ THE APPLICATION NEVER ARRIVED. Not a reply from anybody — the mail system
// ➤ handing your own message back. It is the most useful thing this file can
// ➤ find: everything else tells you how you did, this tells you that you did
// ➤ not compete at all, and it is fixable by applying somewhere that works.
// ➤ Found on a real mailbox: three bounces against two applications that had
// ➤ been sitting in the no-reply pile looking like ordinary silence.
// ➤ ONLY A FAILURE COUNTS, and this is the whole subtlety. The same sender
// ➤ ("Mail Delivery Subsystem") writes "Delivery Status Notification (Delay)"
// ➤ while it is still retrying, and a delay usually ends in delivery. Two of
// ➤ the three notices in one real mailbox were delays. So the sender is
// ➤ deliberately NOT part of this test — matching on it would have called all
// ➤ three a failure and told you an application was lost when it was not.
export const BOUNCED = /undelivered mail returned|delivery status notification \(failure\)|address not found|recipient address rejected|user unknown|no such user|mailbox (is )?(unavailable|full)|550[ -]5\.|domain .{0,30}not found/;

// ➤ Mailshots about jobs you have NOT applied to. They mention roles and
// ➤ companies constantly, so without this they poison everything downstream.
export const ALERT = /job alert|new jobs|jobs for you|recommended for you|nuevas ofertas|ofertas para ti|empleos recomendados|vacatures voor jou|nieuwe vacatures|neue jobs|job digest|we found \d|hemos encontrado|apply now|postula ya|solliciteer nu|unsubscribe|darse de baja/;

// ➤ The part of the list above that can ONLY be a mailshot — wording no company
// ➤ uses when writing to one person about one application. This is the set the
// ➤ early test uses, and the distinction is not academic: moving the whole list
// ➤ to the front threw away real replies (audit 2026-08-01). A Spanish refusal
// ➤ opens "lamentamos comunicarte que HEMOS ENCONTRADO otro candidato", and that
// ➤ phrase was in the list with no number after it, unlike its English twin
// ➤ "we found 3". The rejection was filed as advertising, dropped before it
// ➤ could be linked, and the application sat on "no reply" until it was given
// ➤ up for lost sixty days later.
// ➤ The calls to action and "unsubscribe" are left OUT of this set for the same
// ➤ reason: a genuine company mail can carry them too. They still count in the
// ➤ full test at the end of the function, where a message has already failed to
// ➤ be anything else.
export const ALERT_DECLARED = /job alert|new jobs|jobs for you|recommended for you|nuevas ofertas|ofertas para ti|empleos recomendados|vacatures voor jou|nieuwe vacatures|neue jobs|job digest|we found \d|hemos encontrado \d/;

// ➤ Returns one of: 'bounced' | 'rejected' | 'interview' | 'acknowledged' | 'alert' | null.
// ➤ null means "this is not about an application", and it is the honest answer
// ➤ far more often than any of the others.
export function classifyMessage({ subject = '', snippet = '', body = '', from = '' } = {}) {
  // ➤ The body is included: measured, it found 3 outcomes whose wording sat
  // ➤ past the ~200 characters of the snippet, and contradicted none.
  const text = fold(`${subject} ${snippet} ${body}`);
  if (!text.trim()) return null;

  // ➤ The opening alone. What a message IS gets said here; the body below can
  // ➤ run to a thousand words of navigation and legal boilerplate that describe
  // ➤ the sender's website, not this email.
  const opening = fold(`${subject} ${snippet}`);

  // ➤ Order matters and is not arbitrary: a rejection thanks you for applying,
  // ➤ an invitation may quote the acknowledgement it follows, and a newsletter
  // ➤ says every one of those words while meaning none of them.
  // ➤ Both of the verdicts that change what you would DO have to be said
  // ➤ outright. A receipt describes both of them as possibilities — "should we
  // ➤ continue with other candidates", "whether we invite you" — and those
  // ➤ sentences are the single most common way to be told something wrong.
  // ➤ A bounce is checked FIRST because it is not a reply at all. It quotes
  // ➤ your own message back at you, so the words of your application are in it
  // ➤ and every other pattern here would happily read them.
  if (BOUNCED.test(text)) return 'bounced';

  // ➤ A MAILSHOT IS SPOTTED BEFORE ANY MEANING IS READ INTO IT (audit
  // ➤ 2026-07-31). This test used to sit at the very bottom, where it could
  // ➤ only ever catch a digest that had already failed to match anything else
  // ➤ — while the note on ALERT above claimed it kept mailshots from
  // ➤ "poisoning everything downstream". It did not. A jobs digest carries the
  // ➤ advertising text of every vacancy it lists, so it says "apply now", "we
  // ➤ cannot take this further", "invite you for an interview"; reproduced,
  // ➤ one digest was filed as a rejection and another as an interview, both
  // ➤ against real applications you had made elsewhere.
  // ➤ ON THE OPENING ONLY, and that is deliberate. "Unsubscribe" lives in the
  // ➤ footer of nearly every company mail ever sent, so running this over the
  // ➤ whole text would throw away genuine replies — the same mistake pointing
  // ➤ the other way.
  if (ALERT_DECLARED.test(opening)) return 'alert';

  if (saidOutright(REJECTED, text)) return 'rejected';
  if (saidOutright(INTERVIEW, text) && !ADVICE.test(opening)) return 'interview';
  if (ACKNOWLEDGED.test(text)) return 'acknowledged';
  // ➤ Still a last resort, for a digest that only owns up to what it is further down.
  if (ALERT.test(text)) return 'alert';
  return null;
}

// ➤ Does this look like it came from a recruiting system rather than a person?
// ➤ Used to decide whether a message is worth trying to link at all.
export const ATS_SENDER = /(no-?reply|do-?not-?reply|noreply|careers?|recruit|talent|jobs?|hiring|apply|sollicit|empleo|bewerbung)@|@(workday|myworkday|successfactors|greenhouse|lever|smartrecruiters|teamtailor|recruitee|personio|softgarden|jobvite|icims|taleo|talentclue|bizneo|factorial|workable|ashby|epreselec)/;

// ➤ Did a recruiting system send this, or a person? Only the address is read,
// ➤ never the text — a human writing from their own company address is a
// ➤ different kind of message from a no-reply robot, and worth telling apart.
export function looksAutomated(from) {
  return ATS_SENDER.test(fold(from));
}
