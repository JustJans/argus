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
export const CONDITIONAL = /\bwhether\b|in case|if (we|selected|successful|shortlisted|there is|your (application|profile|cv|candidacy|background))|should (we|there|your (application|profile))|si (tu|su) (perfil|candidatura|solicitud)|en caso de|si (encajas|resultas|eres seleccionad)|indien (we|wij|uw)|mocht (u|je|uw)|falls (wir|ihre)|wenn wir/;

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
export const ADVICE = /tips|how to|guide|prepare for|consejos|curso|webinar|blog|article|newsletter/;

// ➤ The automated receipt. Almost every ATS sends one, which is why it is by
// ➤ far the most common outcome in the mailbox.
// ➤ "Thank you" and "Thanks" are both here on purpose: the pattern used to
// ➤ spell out only the first, and "Thanks for applying" — as ordinary a way of
// ➤ putting it as exists — was read as nothing at all.
// ➤ FORMAL AND INFORMAL, in every language that has the distinction. Dutch
// ➤ "wij hebben UW sollicitatie ontvangen" went unrecognised because only the
// ➤ informal "we hebben JE sollicitatie" was written down. A company writing
// ➤ to a stranger uses the formal form, which is most of this mailbox.
export const ACKNOWLEDGED = /(we have|we've) received|thanks? (you )?for (your )?(applying|application|interest|submitting)|application (has been )?received|received your application|hemos recibido (tu|su)|gracias por (tu|su) (candidatura|solicitud|interes|postulacion)|candidatura recibida|bedankt voor (je|uw|jouw) (sollicitatie|kandidatuur|interesse)|(we|wij) hebben (je|uw|jouw) (sollicitatie|kandidatuur)|(sollicitatie|kandidatuur) (goed )?ontvangen|goed ontvangen|nous avons (bien )?recu|merci de votre candidature|vielen dank fur (ihre|deine) bewerbung|danke fur (deine|ihre) bewerbung|eingang (ihrer|deiner) bewerbung/;

// ➤ Mailshots about jobs you have NOT applied to. They mention roles and
// ➤ companies constantly, so without this they poison everything downstream.
export const ALERT = /job alert|new jobs|jobs for you|recommended for you|nuevas ofertas|ofertas para ti|empleos recomendados|vacatures voor jou|nieuwe vacatures|neue jobs|job digest|we found \d|hemos encontrado|apply now|postula ya|solliciteer nu|unsubscribe|darse de baja/;

// ➤ Returns one of: 'rejected' | 'interview' | 'acknowledged' | 'alert' | null.
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
  if (saidOutright(REJECTED, text)) return 'rejected';
  if (saidOutright(INTERVIEW, text) && !ADVICE.test(opening)) return 'interview';
  if (ACKNOWLEDGED.test(text)) return 'acknowledged';
  if (ALERT.test(text)) return 'alert';
  return null;
}

// ➤ Does this look like it came from a recruiting system rather than a person?
// ➤ Used to decide whether a message is worth trying to link at all.
export const ATS_SENDER = /(no-?reply|do-?not-?reply|noreply|careers?|recruit|talent|jobs?|hiring|apply|sollicit|empleo|bewerbung)@|@(workday|myworkday|successfactors|greenhouse|lever|smartrecruiters|teamtailor|recruitee|personio|softgarden|jobvite|icims|taleo|talentclue|bizneo|factorial|workable|ashby|epreselec)/;

export function looksAutomated(from) {
  return ATS_SENDER.test(fold(from));
}
