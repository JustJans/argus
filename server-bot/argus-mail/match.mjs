#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: it decides WHICH application an email is about. That is the
// ➤ hard half of reading your inbox, and it is hard for a measurable reason:
// ➤ of 46 real outcome emails, only 12 name the company you applied to. The
// ➤ rest arrive from an applicant-tracking system that mentions nobody.
// ➤
// ➤ WHAT WAS MEASURED, on the real mailbox, before this was written:
// ➤   · company name        12/46 hits, and NEVER ambiguous  -> it decides
// ➤   · job title           26/46 hits, 22 of them ambiguous -> corroborates
// ➤   · date near applying  16/46 hits, ALL of them ambiguous -> corroborates
// ➤   · sender domain = the domain the offer was on: 0/46. Useless. Nobody
// ➤     replies from the site you applied on; it is always a third party.
// ➤ Hence the weights below. The company name outweighs everything else put
// ➤ together, because it is the only signal that is ever conclusive.
// ➤
// ➤ IT REFUSES TO GUESS. When the best candidate does not clearly beat the
// ➤ runner-up the email is returned as a TIE, not assigned. A wrong link tells
// ➤ you an offer was rejected when it was not, and that is worse than a gap.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { fold } from './classify.mjs';

// ➤ Words that appear in half the companies and half the job titles in this
// ➤ field. Left in, "Engineering" alone would match nearly every application.
const NOISE = new Set([
  'group', 'engineering', 'engineer', 'recruitment', 'solutions', 'services',
  'technologies', 'international', 'consulting', 'company', 'global', 'people',
  'talent', 'jobs', 'junior', 'senior', 'ingeniero', 'ingeniera', 'the', 'and',
  'sa', 'sl', 'bv', 'nv', 'gmbh', 'ag', 'ltd', 'inc', 'spa', 'srl',
]);

// ➤ The distinctive words of a name, which is all that is safe to match on.
export function tokens(s) {
  return fold(s).split(/[^a-z0-9]+/).filter(w => w.length > 3 && !NOISE.has(w));
}

// ➤ The name with everything but letters and digits removed, and the generic
// ➤ words dropped: "Jan De Nul Group" → "jandenul".
// ➤ WHY THIS EXISTS: tokens() keeps words of more than three letters, and by
// ➤ that rule "Jan De Nul Group" yields NOTHING — Jan, De and Nul are all too
// ➤ short and Group is generic. The strongest signal there is went silent for
// ➤ that employer, and a receipt whose subject read "Jan De Nul - Tender
// ➤ Engineer Offshore" failed to find the application of exactly that name.
// ➤ Compacted, it matches the "careers-jandenul.com" the mail came from too.
export function compactName(s) {
  const words = fold(s).split(/[^a-z0-9]+/).filter(w => w && !NOISE.has(w));
  return words.join('');
}

// ➤ The same treatment for the haystack, so "careers-jandenul.com" and
// ➤ "Jan De Nul" meet in the middle.
const compactAll = s => fold(s).replace(/[^a-z0-9]+/g, '');

// ➤ A WHOLE WORD, never a fragment of one: "Van Oord" reduces to the token "oord", and a
// ➤ Dutch rejection from a different company containing "beoordeling" must not score as if
// ➤ Van Oord had been named. The boundary
// ➤ is written with \p{L} rather than \b because JavaScript's \b only knows
// ➤ ASCII and would break on the first accent.
function hasWord(haystack, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\d])${esc}(?![\\p{L}\\d])`, 'iu').test(haystack);
}

// ➤ "Careers at Van Oord" <noreply@platform.com> → the bit before the address.
// ➤ Worth its own function because it turned out to be the best signal there
// ➤ is after the company name: of 38 emails that named nobody in their text,
// ➤ 30 were identified from the sender alone.
export function senderName(from) {
  const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  const name = (m ? m[1] : '').trim();
  // ➤ "Recruiting Team", "No Reply" and friends identify nothing.
  return /^(no.?reply|do.?not.?reply|notification|careers?|jobs?|talent|recruit\w*|hr|hiring|team|support|info|admin)\b/i.test(fold(name)) ? '' : name;
}

// ➤ Platform and country parts of a hostname carry no identity: what is left
// ➤ of careers.vanoord.com is the employer.
const HOST_NOISE = /^(mail|email|no-?reply|noreply|smtp|send|notify|notification|careers?|jobs?|recruit\w*|talent|apply|hire|hiring|my|app|www|eu|us|de|es|nl|be|fr|uk|com|net|org|io|co|info|cloud)$/;

// ➤ The recruiting platforms. Their domain is THEIR name, never the employer's,
// ➤ so reading a company out of it would invent one.
export const KNOWN_ATS = /workday|myworkday|successfactors|greenhouse|lever|smartrecruiters|teamtailor|recruitee|personio|softgarden|jobvite|icims|taleo|talentclue|bizneo|factorial|workable|ashby|epreselec|linkedin|indeed|adzuna|infojobs|welcometothejungle|sendgrid|mailchimp|amazonses/;

// ➤ The employer's name as it appears in the sending address, or nothing.
// ➤ "careers.vanoord.com" is worth "vanoord"; "mail.greenhouse.io" is worth
// ➤ nothing at all, because that is the recruiting platform's name and reading
// ➤ a company out of it would invent one that never applied to anybody.
export function senderDomainCore(from) {
  const host = (String(from || '').match(/@([\w.-]+)/) || [])[1] || '';
  if (!host || KNOWN_ATS.test(fold(host))) return '';
  const parts = fold(host).split('.').filter(p => !HOST_NOISE.test(p));
  return parts.sort((a, b) => b.length - a.length)[0] || '';
}

// ➤ How long after applying you might get round to typing "applied N". The
// ➤ recorded date is that moment, not the moment you applied, so a reply can
// ➤ honestly be older than the record it belongs to.
export const LOGGING_LAG_DAYS = 2;

// ➤ How well one email fits one application. Returns the score and the reasons,
// ➤ because a link you cannot explain is a link you cannot check.
export function scoreLink(message, application) {
  // ➤ The sender is searched along with the text. It matters: the employer's
  // ➤ name lives in the "From" line of mail sent BY a recruiting platform, and
  // ➤ of 38 emails naming nobody in their body, 30 were identifiable from it.
  const all = fold(`${message.subject} ${message.snippet} ${message.body || ''} ${message.from} ${senderDomainCore(message.from)}`);
  const text = fold(`${message.subject} ${message.snippet} ${message.body || ''}`);
  const why = [];

  // ➤ IDENTITY — who this is about. Without at least one of these there is no
  // ➤ candidate at all, however well everything else fits.
  let identity = 0;

  // ➤ 10: conclusive on its own, and never ambiguous in the measurement.
  const company = tokens(application.company);
  const compact = compactName(application.company);
  if (company.length && company.some(t => hasWord(all, t))) { identity += 10; why.push('company'); }
  // ➤ The same check with the punctuation squeezed out, which is the only way
  // ➤ a name made entirely of short words is recognised at all.
  else if (compact.length >= 6 && compactAll(all).includes(compact)) { identity += 10; why.push('company'); }
  // ➤ AND THE ACRONYMS. A company called "TWD" produces no tokens (three
  // ➤ letters) and is too short for the squeezed-out search above, so it was
  // ➤ invisible: a receipt from "TWD/Marine Engineer" was correctly read as a
  // ➤ receipt and then belonged to nobody. The rule above cannot simply be
  // ➤ loosened — "twd" as a loose substring would hit inside other words — so a
  // ➤ short name has to appear as a WHOLE WORD, which is exactly how a company
  // ➤ writes its own name.
  else if (compact.length >= 2 && compact.length < 6 && hasWord(all, compact)) { identity += 10; why.push('company'); }

  // ➤ 3: real but weak, so it takes TWO matching words — never one, however
  // ➤ short the title. Six of a real set of 23 applications reduce to a single
  // ➤ distinctive word, and four of those were the same word ("automation"):
  // ➤ with a one-word rule, any email mentioning it identified them all.
  const title = tokens(application.title);
  const hits = title.filter(w => hasWord(text, w)).length;
  if (hits >= 2) { identity += 3; why.push('title'); }
  // ➤ ONE shared word is NOT identity. It is how a receipt from a company you
  // ➤ never applied to ended up competing for two applications, on the strength
  // ➤ of the word "project". It only counts once something else has already
  // ➤ established who the email is about.
  else if (hits === 1 && identity > 0) { identity += 1; why.push('title-partial'); }

  // ➤ NOTHING IDENTIFIES IT. Stop here. Time and place would otherwise make
  // ➤ every unrelated email that happened to arrive that day a candidate, and
  // ➤ with several applications sent on one day that is how a receipt from a
  // ➤ company you never applied to gets filed against one you did.
  if (identity === 0) return { score: 0, why: ['nothing-identifies-it'] };

  // ➤ An email cannot be about an application that did not exist yet — but the
  // ➤ date on the application is the day you TOLD the bot, not the day you
  // ➤ applied, and those are not the same day. A real receipt arrived on the
  // ➤ 17th against an application logged on the 18th and was thrown out by half
  // ➤ a day, which is the wrong side of a rule that exists to stop nonsense.
  // ➤ Two days of slack covers logging it the next morning; anything that
  // ➤ arrived earlier than that really cannot be an answer.
  const when = new Date(message.date), applied = new Date(application.ts);
  if (!isNaN(when) && !isNaN(applied) && (when - applied) / 86_400_000 < -LOGGING_LAG_DAYS) {
    return { score: 0, why: ['arrived-before-applying'] };
  }

  // ➤ CORROBORATION — only ever added on top of an identity, never instead.
  let score = identity;
  if (!isNaN(when) && !isNaN(applied)) {
    const days = (when - applied) / 86_400_000;
    // ➤ The automated receipt lands within minutes; a rejection takes weeks.
    if (days <= 1) { score += 3; why.push('same-day'); }
    else if (days <= 5) { score += 2; why.push('within-days'); }
    else if (days <= 30) { score += 1; why.push('within-weeks'); }
  }

  const city = tokens(application.location)[0];
  if (city && hasWord(text, city)) { score += 1; why.push('city'); }

  // ➤ identity is returned separately because it must be compared FIRST. An
  // ➤ email whose subject is the exact job title of one application lost a tie
  // ➤ to another at the same employer, purely because that one was applied to
  // ➤ the same morning: a full title match and a same-day bonus were worth the
  // ➤ same. Timing corroborates an identity, it can never outrank one.
  return { score, identity, why };
}

// ➤ Links a batch of emails to a batch of applications.
// ➤   links   — one email, one application, and why
// ➤   ties    — the email fits several applications equally well
// ➤   orphans — it fits none: usually an application made before the bot kept
// ➤             a record of them at all
// ➤ margin: how far ahead the winner must be. 1 links the most; raising it
// ➤ trades links for certainty.
export function linkOutcomes(messages, applications, { margin = 1 } = {}) {
  const links = [], ties = [], orphans = [];
  for (const m of messages) {
    const ranked = applications
      .map(a => ({ application: a, ...scoreLink(m, a) }))
      .filter(x => x.score > 0)
      // ➤ Who it is about first; how well the timing fits only after that.
      .sort((x, y) => (y.identity - x.identity) || (y.score - x.score));

    if (!ranked.length) { orphans.push(m); continue; }
    // ➤ IDENTITY ALONE DECIDES WHICH VACANCY. A third route to "clear" — identity level plus a
    // ➤ better total — would let the date bonus and the city decide, the only ingredients of
    // ➤ the total that are not identity: with two applications at the SAME employer and an
    // ➤ email that names nothing but the company, the one applied to most recently would win
    // ➤ on its date bonus, and a rejection be filed against a vacancy that had not rejected
    // ➤ you. That flatly contradicts what this file says twice over: timing corroborates an
    // ➤ identity, it never outranks one. Level identity is a TIE, which is the honest answer —
    // ➤ the email is shown to you and you say which one it was. A gap costs you a question; a
    // ➤ wrong link costs you the truth.
    const clear = ranked.length === 1
      || (ranked[0].identity - ranked[1].identity) >= margin;
    if (!clear) {
      // ➤ The tie list is built on identity too, for the same reason. Demanding
      // ➤ an equal total as well would drop every candidate whose date bonus
      // ➤ happened to differ, so the bot would announce a tie and then name only
      // ➤ one side of it — which reads exactly like a decision it did not make.
      const tied = ranked.filter(r => r.identity === ranked[0].identity);
      // ➤ A BOUNCE IS THE ONE THING THAT LINKS TO ALL OF THEM. Every other kind of message is
      // ➤ about ONE vacancy, so guessing between two would put a rejection on the wrong job. A
      // ➤ bounce is not about a vacancy at all — it says mail to that ADDRESS did not get
      // ➤ through, which is equally true of every application sent there. Real case: two
      // ➤ applications to the same employer on the same day, one failure notice — reported as an
      // ➤ unresolved tie it told you nothing, and the one thing you could act on was the thing
      // ➤ that stayed silent.
      if (m.kind === 'bounced') {
        for (const t of tied) links.push({ message: m, application: t.application, score: t.score, why: [...t.why, 'bounce-hits-every-application-there'] });
        continue;
      }
      ties.push({ message: m, candidates: tied });
      continue;
    }
    links.push({ message: m, application: ranked[0].application, score: ranked[0].score, why: ranked[0].why });
  }
  return { links, ties, orphans };
}
