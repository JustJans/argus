#!/usr/bin/env node
/**
 * requirements.mjs — reads an offer body and extracts, in 6 languages
 * (EN/ES/CA/FR/DE/NL), the YEARS of experience demanded and whether a DEGREE
 * the candidate lacks is required. Exports only functions; writes nothing.
 *
 * WHY: the portal APIs carry title + location only, so "10 years in oil & gas"
 * looks like a graduate role until you read the body. The owner (2026-07-06):
 * "it should stop the whole list filling up with offers impossible for my case."
 *
 * DESIGN — conservative by construction: a false keep costs one tap on
 * Telegram, a false drop loses a good offer in silence. So a number only counts
 * next to an EXPERIENCE word, company boasts are guarded out, ranges take the
 * LOW end, several requirements take the MINIMUM, and any doubt keeps it.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { convert } from 'html-to-text';

// ➤ SEARCH PROFILE loader. The user-specific lists (fields, degrees, skills)
// ➤ live in config/profile.yml under `search:`, NOT in this code — that's what
// ➤ makes the engine generic for any sector. Each list is turned into a
// ➤ case-insensitive regex; if the file or a key is missing, the marine/
// ➤ offshore defaults further down are used, so nothing breaks.
const _CFG_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'config', 'profile.yml');
function loadSearchProfile() {
  try { return (yaml.load(readFileSync(_CFG_PATH, 'utf-8')) || {}).search || {}; }
  catch { return {}; }
}
const _SEARCH = loadSearchProfile();
// ➤ Exposed so other modules (scan.mjs, notify.mjs) read the SAME profile from
// ➤ one place instead of each re-loading config/profile.yml.
export const searchProfile = _SEARCH;
// ➤ Config list -> one case-insensitive regex. A term may be a pattern (what the
// ➤ onboarding writes: "m[eé]c[áa]ni[ckq]") or plain text typed by hand ("C++",
// ➤ "Node.js"). Whatever does not compile as a pattern is taken as plain text — escaped,
// ➤ and said so on stderr — instead of dropped, so a term like "C++" cannot vanish in
// ➤ silence. An EMPTY list means "filter OFF" (NEVER_MATCH); a MISSING key means "not
// ➤ configured" and only then do the marine defaults apply.
const NEVER_MATCH = /(?!)/;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export function profileTerm(item) {
  const term = String(item ?? '').trim();
  if (!term) return null;
  try { new RegExp(term); return { source: term, literal: false }; }
  catch { return { source: escapeRegex(term), literal: true }; }
}
function profileRegex(list, fallback) {
  if (Array.isArray(list) && list.length === 0) return NEVER_MATCH;
  if (!Array.isArray(list) || !list.length) return fallback;
  const terms = list.map(profileTerm).filter(Boolean);
  for (const t of terms) {
    if (t.literal) console.warn(`[profile] "${String(t.source).replace(/\\(.)/g, '$1')}" is not a valid pattern; taken as plain text.`);
  }
  if (!terms.length) return fallback;
  try { return new RegExp(terms.map(t => t.source).join('|'), 'i'); }
  catch { return fallback; }
}

// ➤ The word "years" in the 6 languages. The closing \b is added where it is
// ➤ used, so French "an(s)" can't fire inside "analyst"/"and".
// ➤ The Catalan singular "any" is left out and the plural made strict ("anys"): it
// ➤ collides with the English "any".
const YEAR = '(?:years?|yrs?|años?|anys|ans?|jahren?|jaar|jaren)';

// ➤ "Experience" in the 6 languages: a number only counts as a requirement if
// ➤ one of these sits next to it. (Text is already lowercased.)
const EXP = /experien|experiè|expérien|erfahrung|ervaring/;

// ➤ Requirement VERBS, an alternative gate to EXP: "the role requires 5+ years in WMS
// ➤ projects" never says "experience" but clearly asks for years. The NEG guard below
// ➤ still protects against false positives.
const REQ = /\brequir|\brequier|\brequisit|\bexige|\bexigen|\berforder|\bvereist|must have|you have|you bring/;

// ➤ The company talking about ITSELF, not about you: "for over 25 years, our experience…",
// ➤ "sommige met 25 jaar ervaring". Adzuna pages carry the whole "about us" next to the
// ➤ job, so these show up constantly; a marker in the context window makes the number not
// ➤ count even though EXP matched. Generous on purpose: ignoring a number can only KEEP an
// ➤ offer, never drop it.
const NEG = /combined|collective|cumulative|founded|established|in business|in the market|en el mercado|op de markt|sur le marché|am markt|of history|de historia|of experience delivering|years young|our experi|our team|our expert|for over|with over|on over|built on|building on|we have|we bring|we are a|is a leading|leader in|leading provider|team of|sommige|some of our|some with|years serving|years in business|thanks to|gracias a|dank |is your partner|we deliver|we provide|we offer|we serve|trusted by|serving clients|our company|our history|proudly|since 19|since 20|warrant|garant[ií]|guarantee/;

// ➤ Finds "number + years", ranges included ("3-5 years", "3 a 5 años", "2 or 5 years"),
// ➤ and keeps the LOW end. The lookarounds keep the number a standalone 1-2 digit integer,
// ➤ so GE's "building on over 130 years…" can't match "13".
const YEARS_RE = new RegExp(
  // ➤ DECIMALS: without them "1.5 years of experience" fails at the "1" and the scanner
  // ➤ matches the "5" instead, reading FIVE years and dropping a junior offer.
  `(?<!\\d)(\\d{1,2})(?:[.,]\\d+)?(?!\\d)\\s*(?:[-–—+]|\\s+(?:to|a|à|y|and|und|en|bis|tot|hasta|or|o|ou|oder|of)\\s+)?\\s*(?:\\d{1,2})?\\s*\\+?\\s*(?:(?:more|m[áa]s|mehr|meer|plus)\\s+(?:de\\s+|d['']\\s*)?)?${YEAR}\\b`,
  'gi',
);
// ➤ "3 or more years" / "3 o más años": the "more/más" between the number and "years" is
// ➤ allowed, so the requirement reads as 3.

// ➤ ── Numbers written as WORDS ────────────────────────────────────────────
// ➤ The detector above only reads DIGITS, so a requirement spelled out ("vijf jaar", "fünf
// ➤ Jahre") would go unnoticed. We translate those words to their digit BEFORE searching,
// ➤ and everything above keeps working unchanged. Word→digit map (0-15) in the 6
// ➤ languages. Unique keys; when the same spelling exists in two languages with the SAME
// ➤ value, it goes only once.
const NUM_WORDS = {
  zero: 0, cero: 0, 'zéro': 0, null: 0, nul: 0,
  one: 1, uno: 1, un: 1, une: 1, ein: 1, eins: 1, een: 1,
  two: 2, dos: 2, deux: 2, zwei: 2, twee: 2,
  three: 3, tres: 3, trois: 3, drei: 3, drie: 3,
  four: 4, cuatro: 4, quatre: 4, vier: 4,
  five: 5, cinco: 5, cinc: 5, cinq: 5, 'fünf': 5, funf: 5, vijf: 5,
  six: 6, seis: 6, sis: 6, sechs: 6, zes: 6,
  // ➤ Catalan "set" (7) is left out: "a broad skill set years in the making" would read as SEVEN years.
  seven: 7, siete: 7, sept: 7, sieben: 7, zeven: 7,
  eight: 8, ocho: 8, vuit: 8, huit: 8, acht: 8,
  nine: 9, nueve: 9, nou: 9, neuf: 9, neun: 9, negen: 9,
  ten: 10, diez: 10, deu: 10, dix: 10, zehn: 10, tien: 10,
  // ➤ Spanish "once" (11) is left out: a very common English word.
  eleven: 11, onze: 11, elf: 11,
  twelve: 12, doce: 12, dotze: 12, douze: 12, 'zwölf': 12, zwolf: 12, twaalf: 12,
  thirteen: 13, trece: 13, fourteen: 14, catorce: 14, fifteen: 15, quince: 15,
};
// ➤ The range separators (same as YEARS_RE) and the two alternations: ALL the words (for
// ➤ ranges) and only those of 3+ (the ones that discard on their own), longest first.
const _numKeys = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length);
const NUM_ALL = _numKeys.join('|');
const NUM_BIG = _numKeys.filter(w => NUM_WORDS[w] >= 3).join('|');
const SP_RANGE_SEP = `(?:[-–—]|\\s+(?:to|a|à|y|and|und|en|tot|bis|hasta|or|o|ou|oder)\\s+)`;
const SPELLED_RANGE = new RegExp(`\\b(${NUM_ALL})\\b(${SP_RANGE_SEP})(${NUM_ALL})\\b(\\s*\\+?\\s*${YEAR}\\b)`, 'gi');
const SPELLED_SINGLE = new RegExp(`\\b(${NUM_BIG})\\b(\\s*\\+?\\s*${YEAR}\\b)`, 'gi');

// ➤ Two passes:
// ➤  (A) RANGES, both ends ("nul tot drie jaar" → "0 tot 3 jaar"). Translating
// ➤      only "drie" would leave "nul tot 3", and a 0-3 range — junior, and
// ➤      good for the user — would then be read as a flat 3.
// ➤  (B) STANDALONE of 3+ ("vijf jaar" → "5 jaar"). A standalone 0-2 is left
// ➤      alone: those are years the user accepts, so the offer is kept anyway.
function normalizeSpelledYears(t) {
  let out = t.replace(SPELLED_RANGE, (_, a, sep, b, tail) =>
    `${NUM_WORDS[a.toLowerCase()]}${sep}${NUM_WORDS[b.toLowerCase()]}${tail}`);
  out = out.replace(SPELLED_SINGLE, (_, w, tail) => `${NUM_WORDS[w.toLowerCase()]}${tail}`);
  return out;
}

// ➤ The rule: if it demands it, drop it; if it says nothing or says NOT required, keep it
// ➤ — silence benefits the candidate. Four guards, checked in the number's own SENTENCE so
// ➤ a "valorable" elsewhere cannot cancel a real requirement. (1) NEGATED: "you don't need
// ➤ 5 years", "brauchen keine 5 Jahre".
const NEG_YEARS = /\b(?:don'?t|doesn'?t|do not|does not|no|not|never|without|sin|keine?n?|nicht|niet|geen|pas)\b[^.!?;]{0,40}\b(?:need\w*|requir\w*|requier\w*|requerid\w*|necessary|necesari\w*|necesit\w*|mandatory|compulsory|obligatori\w*|imprescindible|verplicht|exig\w*|erforderlich|brauch\w*|besoin|nodig|vereist)\b|\b(?:brauch\w*|necesit\w*|need\w*)\b[^.!?;]{0,10}\b(?:keine?|geen|niet|no)\b|no importa|da igual (?:si|cu[áa]nt)|whether you have|not a requirement/i;
// ➤ (2) SOFTENED: "ideally 4 years", "se valoran 5 años" — desirable, not a floor.
const SOFT_YEARS = /preferred|preferably|ideally|idealerweise|nice to have|a plus|an asset|bonus|desirable|deseable|valorable|se valoran?|von vorteil|w[üu]nschenswert|bij voorkeur|een pr[ée]|pluspunt|de pr[ée]f[ée]rence|souhait|not essential|optiona?l|opcional|facultativ\w*|freiwillig|no (?:es )?(?:imprescindible|excluyente)/i;
// ➤ (3) CAP: "up to 5 years" caps what they accept, it does not ask for it.
const CAP_BEFORE = /(?:up to|bis zu|maximaal|jusqu'?[àa]|max\.?|maximum(?: of)?|m[áa]ximo(?: de)?|hasta un m[áa]ximo de)\s*$/i;
// ➤ (4) DURATION of the JOB, not of your past: "contrato de 2 años", "a 2-year
// ➤ assignment". Only counted ATTACHED before the number. The filler words carry their own
// ➤ whitespace INSIDE the repetition and "de" is spelled once, not twice: repeating bare
// ➤ alternatives with two of them matching the same text is the recipe for exponential
// ➤ backtracking on a near-miss — and this regex runs against a window of every advert
// ➤ body.
const DURATION_BEFORE = /(?:contra(?:ct|to)s?|contrat|vertrag|dienstverband|arbeitsvertrag|assignment|secondment|mission|duraci[óo]n|duration|dur[ée]e|looptijd|laufzeit|posting|placement|project)\s*(?:(?:is|es|ist|van|of|for|por|pour|f[üu]r|d[ée]e?|:)\s*)*(?:an?\s+)?$/i;

const WINDOW = 50; // chars of context scanned around each number match

// ➤ The guards read the segment BETWEEN COMMAS around the match, plus the previous segment
// ➤ when short ("Ideally, 4 años…") and the next one always ("5 años, aunque no
// ➤ imprescindibles,…") — a "preferred" about another topic must not cancel a real
// ➤ requirement. A softener that opens the NEXT segment and then names a FIELD ("…,
// ➤ ideally in offshore wind") modifies the field, not the requirement: softener +
// ➤ preposition → that segment stays out of the guard zone. A bare ", preferred" still
// ➤ cancels.
const SOFT_FIELD_NEXT = /\b(?:ideally|preferably|preferable|preferiblemente|idealmente|idealerweise|bij voorkeur|de pr[ée]f[ée]rence|voorkeur)\s+(?:in|en|im|dans|with|met|op|auf|from|de|du|des)\b/i;

function guardZone(t, cs, ce, idx) {
  const clause = t.slice(cs, ce);
  const rel = Math.min(Math.max(idx - cs, 0), clause.length);
  const parts = [];
  let p = 0;
  for (const seg of clause.split(',')) { parts.push({ start: p, end: p + seg.length, seg }); p += seg.length + 1; }
  let i = parts.findIndex(s => rel >= s.start && rel <= s.end);
  if (i === -1) i = 0;
  let zone = parts[i].seg;
  if (i > 0 && parts[i - 1].seg.trim().length <= 25) zone = parts[i - 1].seg + ',' + zone;
  if (i + 1 < parts.length && !SOFT_FIELD_NEXT.test(parts[i + 1].seg)) zone = zone + ',' + parts[i + 1].seg;
  return zone;
}

// ➤ Internal engine: returns EACH years requirement found in the text with its context
// ➤ snippet, to look at WHAT those years are asked in, not just how many.
function collectYearHits(text) {
  if (!text) return [];
  // ➤ Lowercases, unifies spaces and translates years written as words to digits ("vijf
  // ➤ jaar" → "5 jaar"). Typographic apostrophes fold first: NEG_YEARS's "don'?t" can't see
  // ➤ U+2019, and "You don’t need 5 years" must not read as a firm requirement.
  const t = normalizeSpelledYears(String(text).replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' '));
  const hits = [];
  let m;
  YEARS_RE.lastIndex = 0;
  // ➤ Goes through the text looking for each occurrence of "number + years".
  while ((m = YEARS_RE.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    // ➤ Only numbers between 1 and 30 count: outside that it's not a real requirement.
    if (!(n >= 1 && n <= 30)) continue;
    // ➤ Cuts out the text snippet around the number to examine its context.
    const ctx = t.slice(Math.max(0, m.index - WINDOW), Math.min(t.length, YEARS_RE.lastIndex + WINDOW));
    // ➤ Needs an "experience" word or a requirement verb beside the number, and no company
    // ➤ boast; anything less is not counted and the offer is KEPT. The boast check reads the
    // ➤ WHOLE SENTENCE: the giveaway comes after the comma — "With 25 years of experience…,
    // ➤ Acme is your partner." The negated/softened checks below stay bound to the comma
    // ➤ segment on purpose (r30).
    let ss = m.index, se = m.index;
    while (ss > 0 && !/[.!?;]/.test(t[ss - 1])) ss--;
    while (se < t.length && !/[.!?;]/.test(t[se])) se++;
    const sentence = t.slice(ss, se);
    if ((EXP.test(ctx) || REQ.test(ctx)) && !NEG.test(ctx) && !NEG.test(sentence)) {
      // ➤ Guards: if the number's own segment negates or softens the requirement, it does not
      // ➤ count and the offer stays.
      let cs = m.index, ce = m.index;
      while (cs > 0 && !/[.!?;]/.test(t[cs - 1])) cs--;
      while (ce < t.length && !/[.!?;]/.test(t[ce])) ce++;
      const zone = guardZone(t, cs, ce, m.index);
      if (NEG_YEARS.test(zone) || SOFT_YEARS.test(zone)) continue;
      const before = t.slice(Math.max(0, m.index - 20), m.index);
      // ➤ "up to / máximo" right before? It's a cap, not a minimum → doesn't count.
      if (CAP_BEFORE.test(before)) continue;
      // ➤ "contrato de / contract van" right before? It's the DURATION of the
      // ➤ position, not an experience requirement → doesn't count.
      if (DURATION_BEFORE.test(before)) continue;
      // ➤ "more than 3 years" / "más de 3 años" means 4+, so the number goes up by one. Company
      // ➤ boasts with "for/with/on over" are already killed by NEG.
      const strict = /(more than|más de|mas de|plus de|mehr als|meer dan|over)\s*$/.test(before);
      hits.push({ n: strict ? n + 1 : n, ctx });
    }
  }
  return hits;
}

// ➤ CLASSIC FUNCTION: the years of experience an offer asks for (the LOWEST if several),
// ➤ or null when unclear — and in doubt the offer is KEPT.
export function extractRequiredYears(text) {
  const hits = collectYearHits(text);
  return hits.length ? Math.min(...hits.map(h => h.n)) : null;
}

// ➤ Fields the candidate can defend with their CV. Automation/PLC is deliberately NOT
// ➤ here: those roles are welcome but they have zero years in them, so "2 años en un
// ➤ puesto similar" on a PLC job disqualifies them. The stems cover
// ➤ maritime/marítimo/maritiem/maritim in one go.
export const USER_FIELDS = profileRegex(_SEARCH.fields, /mooring|amarre|offshore|marin[eo]|mar[ií]tim|maritiem|naval|orcaflex|subsea|\briser|floating|fpso|flng|umbilical|seabed|nearshore|metocean|hydrograph|hidrogr[áa]f|oceanogr[áa]f|oceanograph|survey|\bgis\b|aquacultur|acuicultur|coastal|costero/i);

// ➤ Priority terms that EXEMPT an offer from the years-cap and degree cuts; marine default = orcaflex.
export const PRIORITY_KEEP = profileRegex(_SEARCH.priority_terms, /orcaflex/i);

// ➤ Phrases that tie the years to a SPECIFIC FIELD: "en un puesto similar",
// ➤ "in a similar role", or directly a technology that the user doesn't have.
const SIMILAR_ROLE = /similar|equivalente|équivalent|vergleichbar|soortgelijk|misma posici|mismas funciones|same (role|position)|gleicher position/i;
// ➤ Marine DEFAULT only when the key is ABSENT. An onboarded profile that sets
// ➤ zero_skill_fields to an empty list means "no zero-skill filter" (→ NEVER_MATCH).
const ZERO_SKILLS = ('zero_skill_fields' in _SEARCH) ? profileRegex(_SEARCH.zero_skill_fields, NEVER_MATCH) : /\bplcs?\b|scada|rob[óo]t|programaci[óo]n|programming|programm(eur|ier)|software|cloud|crm|\bsap\b|\bjava|\.net|typescript/i;

// ➤ "SEVERAL years" with NO number: the German "mehrjährige Berufserfahrung" carries no
// ➤ figure, so the check above returns nothing. Asking for varios/several/mehrere years of
// ➤ experience means at least 3, over the default threshold of 2. Only forms attached to
// ➤ "experience" in 5 languages, with the same negated/soft guards; German has both the
// ➤ adjective ("mehrjährige") and the noun phrasing ("mehrere Jahre Berufserfahrung"),
// ➤ Dutch likewise ("meerjarige" / "meerdere jaren").
const MULTI_YEARS = /\b(?:several|multiple|many)\s+years[''s]*\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?experience|\bvarios\s+a[ñn]os\s+de\s+(?:\w+\s+){0,2}?experiencia|\bplusieurs\s+ann[ée]es\s+d.(?:\w+\s+){0,2}?exp[ée]rience|\b(?:mehr|lang)j[äa]hrige?\w*\s+(?:\w+\s+){0,2}?\w*erfahrung\w*|\bmehrere\s+jahre\s+(?:\w+\s+){0,2}?\w*erfahrung\w*|\bmeerdere\s+jaren\s+(?:\w+\s+){0,2}?\w*ervaring|\bmeerjarige\s+(?:\w+\s+){0,2}?\w*ervaring/gi;

function multiYearScreen(text, maxYears) {
  const t = String(text || '').replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' ');
  MULTI_YEARS.lastIndex = 0;
  let m;
  while ((m = MULTI_YEARS.exec(t)) !== null) {
    // ➤ Same mechanics as years with a number: sentence + segment between
    // ➤ commas, and if it's negated or softened ("wünschenswert"), it doesn't count.
    let cs = m.index, ce = m.index;
    while (cs > 0 && !/[.!?;]/.test(t[cs - 1])) cs--;
    while (ce < t.length && !/[.!?;]/.test(t[ce])) ce++;
    // ➤ Company boasts too: "Thanks to our many years of experience, we are a leading
    // ➤ provider…" must not drop a junior offer — this path consults the boast list (NEG) on
    // ➤ the whole sentence, like the numbered path.
    if (NEG.test(t.slice(cs, ce))) continue;
    const zone = guardZone(t, cs, ce, m.index);
    if (NEG_YEARS.test(zone) || SOFT_YEARS.test(zone)) continue;
    // ➤ "varios" only discards if the user's threshold is below 3.
    return maxYears < 3 ? { years: '3+', drop: true, why: 'over-threshold' } : null;
  }
  return null;
}

// ➤ THE VERDICT: how many years is not enough — look at IN WHAT. More than the threshold →
// ➤ out; 1-2 years but "in a similar role" or in a technology the user has at zero, with
// ➤ neither context nor title in their fields → out (they can't back them up); generic
// ➤ years → kept; no clear years → kept.
export function experienceScreen(text, title, maxYears) {
  const hits = collectYearHits(text);
  // ➤ "several/mehrjährige years" is checked ALWAYS, not only when no number appears: "1
  // ➤ year with Excel. Several years in the field required." must score as several, not 1.
  const multi = multiYearScreen(text, maxYears);
  if (!hits.length) return multi;
  if (multi && multi.drop) return multi;
  // ➤ The offer's base requirement is the LOWEST of the ones it mentions.
  const min = hits.reduce((a, b) => (a.n <= b.n ? a : b));
  if (min.n > maxYears) return { years: min.n, drop: true, why: 'over-threshold' };
  const fieldSpecific = SIMILAR_ROLE.test(min.ctx) || ZERO_SKILLS.test(min.ctx);
  if (min.n >= 1 && fieldSpecific && !USER_FIELDS.test(min.ctx) && !USER_FIELDS.test(String(title || ''))) {
    return { years: min.n, drop: true, why: 'field-mismatch' };
  }
  return { years: min.n, drop: false, why: 'within-threshold' };
}

// ➤ Offers with a clean title (Project Engineer) often demand in the TEXT a degree the
// ➤ candidate lacks. "degree/master's/bachelor" in 6 languages — but NOT "ingeniería",
// ➤ which in Spanish names the degree AND the discipline and fires on "5 años de
// ➤ experiencia en ingeniería mecánica". "opleiding" is how Dutch postings say it
// ➤ ("afgeronde hbo-opleiding..."): without it the whole Dutch demand is invisible, majors
// ➤ and all. The stems match inside German/Dutch COMPOUNDS too ("Bachelorabschluss",
// ➤ "bacheloropleiding", "Bachelorstudium") and "licenciatur" reaches "licenciatura".
const DEGREE_WORD = /\b(?:degree|master'?s?|bachelor'?s?|m\.?sc|b\.?sc|b\.?eng|diploma|dipl[oô]me?|grado|m[áa]ster|titulaci[óo]n|licenciatur\w*|\w*studium|hochschulabschluss|\w*abschluss|\w*opleiding)\b/gi;
// ➤ Named majors the user does NOT have: if the requested degree is only these and names
// ➤ none of their fields, the offer is impossible for them. In the marine example
// ➤ "industrial" and "civil" only count next to "engineer/génie" — industrial AUTOMATION
// ➤ is in scope. Accents are folded ("el[eé]ctr[io]", or "eléctrica" slips through) and
// ➤ the stems carry every language the boards actually write in: "mécanique" ends in -que,
// ➤ "électrique"/"Elektrotechnik" open with é/elek, and the German and Dutch names for
// ➤ whole majors (Maschinenbau, Werktuigbouwkunde, Bauingenieur, Chemie, Raumfahrt) are
// ➤ spelled out.
const GATED_DEGREE = profileRegex(_SEARCH.degrees_excluded, /[eé]l[eé][ck]tr[io]|electr[óo]nic|electromechanic|electromec[áa]nic|mechanical|m[eé]c[áa]ni[ckq]|maschinenbau|werktuigbouw|mechatronic|m[eé]catr[óo]ni[ckq]|aerospace|aeroespacial|a[ée]ronauti[ckq]|a[ée]rospatial|raumfahrt|ruimtevaart|luftfahrt|chemical|chemistry|chemie\b|qu[íi]mic|chimi|civil engineer|g[ée]nie civil|bauingenieur|civiele techniek|computer scien|inform[áa]ti[ckq]|industrial engineer/i);
// ➤ Fields where the user DOES have a degree, or that save the offer ("marine or
// ➤ related"): near the requested degree, the offer is kept.
const USER_DEGREE_OK = profileRegex(_SEARCH.degrees_ok, /marin[eo]|mar[ií]tim|maritiem|naval|offshore|ocean|oceano|metocean|hydro|hidro|\bgeo|environ|\bambient|survey|\bgis\b|coastal|costero|nautic|n[áa]utic/i);

// ➤ For each "degree" word, read the ~60 chars after it (where the majors are listed): a
// ➤ major they lack with none of their fields nearby = impossible, out. It never acts on
// ➤ titles from their field or their skills — "even if it's not from my field it may
// ➤ interest me, e.g. automation engineer junior" — so it only cuts generic and clearly
// ➤ unrelated titles.
const DEGREE_TITLE_SAFE = ('skill_titles' in _SEARCH) ? profileRegex(_SEARCH.skill_titles, NEVER_MATCH) : /automat|instrument|\bplc\b|scada|\bcontrol/i;

// ➤ DEGREE GUARDS: if it demands it, drop it; if it doesn't state it or says it's NOT
// ➤ required, keep it. ANY mention of a degree the user doesn't have must not discard by
// ➤ itself — the offer may say it isn't needed, that equivalent experience works, or that
// ➤ the degree is the FOUNDER's. Four guards, looking at the degree's SENTENCE: (1)
// ➤ NEGATED DEGREE: "a degree ... is not required", "no se requiere titulación"...
const DEG_NEG = /\b(?:no|not|n'?t|don'?t|without|sin|geen|niet|nicht|kein\w*|pas)\b[^.!?;]{0,40}\b(?:require[sd]?|requerid\w*|requier\w*|necessary|necesari\w*|needed|essential|mandatory|compulsory|verplicht|imprescindible|excluyente|erforderlich|vereist|requis|exig[ée]\w*|obligatori\w*)\b|no se (?:requiere|exige|necesita)|not (?:a )?(?:requirement|must|dealbreaker)/i;
// ➤ (2) SOFTENED DEGREE: "preferred", "nice to have", "valorable pero no
// ➤ excluyente", "ideally"... = desirable, not a closed door.
const DEG_SOFT = /preferred|preferably|ideally|idealerweise|nice to have|a plus|an asset|bonus|desirable|deseable|valorable|se valora|no excluyente|not essential|optiona?l|opcional|facultativ\w*|freiwillig|wenn m[öo]glich|von vorteil|w[üu]nschenswert|bij voorkeur|pluspunt|een pr[ée]|de pr[ée]f[ée]rence|souhait/i;
// ➤ (3) ALTERNATIVE PATH ("or equivalent experience"): the degree is not a hard barrier.
// ➤ Two levels: any form inside the degree's own segment, but only unambiguous ones in the
// ➤ NEXT sentence — an "or equivalent support" from a relocation line must not cancel a
// ➤ real degree. The French way out has more shapes than "ou expérience équivalente" ("ou
// ➤ dans une discipline équivalente"); one clause covers the family: "ou [dans une]
// ➤ [discipline/formation/diplôme/filière] équivalent(e)".
const DEG_ALT = /or (?:an? )?equivalent|equivalent (?:work )?experience|equivalent combination|in lieu of|o (?:experiencia )?equivalente|experiencia equivalente|ou (?:dans une |d'une )?(?:discipline |formation |dipl[oô]me |fili[èe]re |exp[ée]rience )?[ée]quivalent\w*|gleichwertig\w*|gelijkwaardig\w*|or (?:relevant|comparable) (?:hands-on )?experience/i;
const DEG_ALT_NEXT = /equivalent (?:work )?experience|experience in lieu|in lieu of a degree|experiencia equivalente|exp[ée]rience [ée]quivalente|gleichwertige\w* (?:erfahrung|berufserfahrung)|gelijkwaardige ervaring/i;
// ➤ (4) SOMEONE ELSE'S DEGREE: "our founder has a degree in..." talks about
// ➤ the company's team, not about what's demanded of the candidate.
const DEG_THIRD = /\b(?:our|nuestr[oa]s?|unser\w*|notre|ons|onze)\s+(?:founder\w*|ceo|cto|lead\w*|head\w*|team\w*|expert\w*|senior\w*|engineer\w*|director\w*|fundador\w*|equipo|jefe\w*)/i;

// ➤ No master's held, so a firmly required one always discards — the title exemption
// ➤ covers unrelated MAJORS, not a study level. Saved if the sentence also accepts a
// ➤ bachelor, or on the usual guards. Only "máster" or "master + degree word" count: the
// ➤ folded form alone hits "Harbour Master".
const MASTER_DEGREE = /\bmaster'?s?\s+(?:degree|diploma)|\bmaster\s+of\s+(?:science|engineering|arts)|\bmaster\s+(?:in|en)\s+(?:\w+\s+)?(?:engineering|science|ingenier|ciencia)|\bmsc\b|\bm\.\s?sc\b|\bm[áa]ster\s+(?:en|in|de|of)\b|\bmáster\b|masterabschluss|masterstudium|masteropleiding/gi;
const BACHELOR_ALT = /\bbachelor|\bb\.?\s?sc\b|\bb\.?eng\b|\bgrado\b|licenciatur|\bhbo\b|undergraduate|bachiller/i;

function masterRequired(t) {
  MASTER_DEGREE.lastIndex = 0;
  let m;
  while ((m = MASTER_DEGREE.exec(t)) !== null) {
    let cs = m.index, ce = m.index;
    while (cs > 0 && !/[.!?;]/.test(t[cs - 1])) cs--;
    while (ce < t.length && !/[.!?;]/.test(t[ce])) ce++;
    if (BACHELOR_ALT.test(t.slice(cs, ce))) continue;   // a degree also works → the user fits
    const zone = guardZone(t, cs, ce, m.index);
    if (DEG_NEG.test(zone) || DEG_SOFT.test(zone) || DEG_THIRD.test(zone) || DEG_ALT.test(zone)) continue;
    let ne = ce + 1;
    while (ne < t.length && !/[.!?;]/.test(t[ne])) ne++;
    if (DEG_ALT_NEXT.test(t.slice(ce + 1, ne))) continue;
    return true;
  }
  return false;
}

export function degreeScreen(text, title) {
  const ttl = String(title || '');
  // ➤ Typographic apostrophes fold to ASCII first: a real posting wrote "A Master's degree"
  // ➤ with U+2019 and the master's rule — the ONE rule that pierces the automation-title
  // ➤ exemption below — never matched it.
  const t0 = String(text || '').replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' ');
  // ➤ Order matters: the master's rule goes FIRST and pierces every title exemption, own
  // ➤ field included (a "Marine Surveyor" wearing "Education: Master's Degree in Naval
  // ➤ Engineering" is still impossible); it already stands down for a bachelor alternative,
  // ➤ a softener or an equivalence clause. Own-field titles stay exempt from the MAJORS scan
  // ➤ below — there the false drop is the expensive one.
  if (masterRequired(t0)) return true;
  if (USER_FIELDS.test(ttl)) return false;
  if (DEGREE_TITLE_SAFE.test(ttl)) return false;
  const t = t0;
  DEGREE_WORD.lastIndex = 0;
  let m;
  while ((m = DEGREE_WORD.exec(t)) !== null) {
    // ➤ The degree's SENTENCE is computed first and both windows are clipped to it, so they
    // ➤ never cross full stops: "Bachelor degree required. ...mechanical systems on site" must
    // ➤ not read "mechanical" as a required major.
    let cs = m.index, ce = m.index;
    while (cs > 0 && !/[.!?;]/.test(t[cs - 1])) cs--;
    while (ce < t.length && !/[.!?;]/.test(t[ce])) ce++;
    const win = t.slice(m.index, Math.min(m.index + 60, ce));               // list of majors
    // ➤ field escape: the WHOLE sentence, not a window — in a normal list of majors ("Bachelor
    // ➤ degree in Mechanical Engineering, Electrical Engineering, Industrial Engineering,
    // ➤ Naval Architecture or a related field") the user's OWN discipline can sit far from the
    // ➤ degree word.
    const near = t.slice(cs, ce);
    if (!(GATED_DEGREE.test(win) && !USER_DEGREE_OK.test(near))) continue;
    // ➤ Guards on the degree's own segment: negation, softening or third person. A guard skips
    // ➤ this mention; the rest of the text goes on.
    const zone = guardZone(t, cs, ce, m.index);
    if (DEG_NEG.test(zone) || DEG_SOFT.test(zone) || DEG_THIRD.test(zone) || DEG_ALT.test(zone)) continue;
    // ➤ Next sentence (up to the next strong punctuation) for the "in lieu of".
    let ne = ce + 1;
    while (ne < t.length && !/[.!?;]/.test(t[ne])) ne++;
    if (DEG_ALT_NEXT.test(t.slice(ce + 1, ne))) continue;
    return true;
  }
  return false;
}

// ➤ Pulls ONLY the offer's description out of an Adzuna page (<section class="adp-body">);
// ➤ the rest is menus and related ads in the country's language, which would make the
// ➤ body-language check useless. Returns '' without the marker — the caller then skips the
// ➤ check.
export function extractAdzunaJd(html) {
  const s = String(html || '');
  // ➤ Note `[^<>]` (not `[^>]`) in every tag pattern: a tag is read only up to the next
  // ➤ angle bracket of ANY kind, so a stray "<" in the page cannot let the pattern run past
  // ➤ the tag and hand the years and degree checks a cut or wrong body.
  const open = s.match(/<section[^<>]*\bclass\s*=\s*["']([^"']*\badp-body\b[^"']*)["'][^<>]*>/i);
  if (!open) return '';
  // ➤ Count nesting instead of stopping at the first </section>, or a nested one truncates
  // ➤ the body. Latent today, correct if Adzuna changes.
  let i = open.index + open[0].length, depth = 1;
  const tag = /<(\/?)section\b[^<>]*>/gi;
  tag.lastIndex = i;
  let mt;
  while ((mt = tag.exec(s)) !== null) {
    depth += mt[1] ? -1 : 1;
    if (depth === 0) return stripHtml(s.slice(i, mt.index));
  }
  return stripHtml(s.slice(i)); // unclosed section → to the end
}

// ➤ HTML → plain text for the screens, on a real parser: regexes cannot parse HTML — a
// ➤ nested comment, "--!>" as a comment end, junk in a closing tag are all shapes a
// ➤ browser accepts and a pattern does not. The parser knows the shapes; what stays here
// ➤ is the SENTENCE rule the screens depend on and the whitespace discipline. Named
// ➤ entities become their character ("&eacute;" → "é") rather than a space, so an accented
// ➤ word in an advert survives whole for the requirement regexes.
export function stripHtml(html) {
  // ➤ Each </li> ends a sentence. Bullets carry no final stop, so flattened they merge into
  // ➤ one sentence and an "is a plus" from the next bullet cancels a real requirement. ONLY
  // ➤ </li>: doing it to </p> breaks the softening of a "Nice to have:" heading. "--!>" ends
  // ➤ a comment in every browser; the parser only knows "-->", and would otherwise read the
  // ➤ rest of the page as comment.
  const withStops = String(html || '').replaceAll('--!>', '-->').replace(/<\/li\s*>/gi, '. </li>');
  const text = convert(withStops, {
    wordwrap: false,
    selectors: [
      // ➤ Code and styling are not the advert. noscript IS: it is what a page
      // ➤ says to a reader without JavaScript.
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'hr', format: 'skip' },
      // ➤ No decorations: the library would write "[url]" after links, bullets
      // ➤ before items, "> " before quotes and HEADINGS IN CAPITALS.
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'ul', format: 'inline' },
      { selector: 'ol', format: 'inline' },
      { selector: 'li', format: 'inline' },
      { selector: 'blockquote', format: 'block' },
      // ➤ Table cells as blocks, so neighbouring cells never glue into one word.
      { selector: 'table', format: 'block' },
      { selector: 'tr', format: 'block' },
      { selector: 'td', format: 'block' },
      { selector: 'th', format: 'block' },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(h => ({ selector: h, options: { uppercase: false } })),
    ],
  });
  return text
    // ➤ "5&#160;years" must read as five years: the no-break space is not a space to the regexes.
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    // ➤ A bullet that ALREADY carried a final period got another ("x.. ").
    .replace(/\.(?:\s*\.)+/g, '.')
    .trim();
}
