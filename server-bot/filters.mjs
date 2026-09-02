// ➤ The three filters an offer must pass — title, company, location — and the word rules
// ➤ they share. It depends on text.mjs only, so scan, housekeep, the veto panel and the
// ➤ tests can all import it without a cycle in the module graph.
import { fold } from './text.mjs';

// ── Title filter ────────────────────────────────────────────────────
// ➤ Two lists from portals.yml: positives (the title must contain at least one) and
// ➤ negatives (one hit discards). Positives are case-insensitive SUBSTRINGS of word stems
// ➤ ("Mooring" → "Moorings Analyst", "Oceanograph" → "Oceanography") — except short
// ➤ acronyms (GIS, PLC, ROV...), which get word boundaries: "GIS" once matched inside
// ➤ "Lo·gis·tiek". Negatives are whole words with an optional plural, so "Intern" blocks
// ➤ "Interns" but not "International", and "Lead" blocks "Lead Engineer" but not
// ➤ "Leadership".

// ➤ HOW A WORD IS COMPARED: lower case AND without accents, on both sides. A French board
// ➤ writes "Electromécanicien Naval" while a veto says "Électromécanicien" — the same word
// ➤ to a person, a different first letter to a computer. Folding both sides fixes the
// ➤ whole class at once instead of adding spellings by hand; fold only one side and
// ➤ accented terms quietly stop matching.
export const norm = fold;

// ➤ Builds the search pattern of a "bounded" word: it requires
// ➤ the word to appear whole, not hidden inside another. If the word
// ➤ starts with "*", it counts as the end of a compound word (useful in Dutch
// ➤ and German: "*monteur" catches "Servicemonteur").
export function boundaryRegex(term, optionalPlural) {
  // Leading "*" = suffix match (no start boundary). Needed for Dutch/German
  // compound words: "*monteur" catches "Servicemonteur", "*manager" catches
  // "Projektmanager". The optional tail also covers plural and German female
  // forms: Technikerin, Projektmanagerin.
  const suffixMode = term.startsWith('*');
  const raw = suffixMode ? term.slice(1) : term;
  // ➤ Escapes special symbols so they're searched literally. Folded first, so
  // ➤ the pattern is accent-free and only ever meets accent-free text.
  const esc = norm(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = (!suffixMode && /^\w/.test(raw)) ? '\\b' : '';
  // ➤ Optionally allows the plural and the German female forms (Technikerin,
  // ➤ Projektmanagerinnen) without opening the door to other words: "-es" for the Spanish
  // ➤ plural in -ores (Soldadores), "-en" for the German and Dutch plural (Bacheloranden,
  // ➤ Senioren, Directeuren).
  const trail = /\w$/.test(raw) ? (optionalPlural ? '(?:s|es|en|in|innen)?\\b' : '\\b') : '';
  return new RegExp(lead + esc + trail, 'i');
}

// ➤ Is it a short acronym (2-6 uppercase/numbers, like GIS, PLC, ROV)?
// ➤ Acronyms are searched as whole words to avoid false positives.
const ACRONYM = /^[A-Z0-9.&-]{2,6}$/; // GIS, PLC, SCADA, FPSO, ROV...

// ➤ COMPANY blocklist (portals.yml → company_filter.blocked): no offer from those
// ➤ companies gets in, whatever its title. Whole word, case-insensitive. Returns true if
// ➤ the company PASSES; .explain() says which term blocked it (--explain).
export function buildCompanyFilter(cf) {
  const vetoes = (cf?.blocked || []).map(t => ({ label: String(t), re: boundaryRegex(String(t), false) }));
  const fn = (company) => !vetoes.some(v => v.re.test(norm(company)));
  fn.explain = (company) => vetoes.find(v => v.re.test(norm(company)))?.label || null;
  return fn;
}

// ➤ Builds the function that decides whether a title passes the filter: it must
// ➤ contain some positive word and no negative one.
export function buildTitleFilter(tf) {
  const positives = (tf?.positive || []).map(term => {
    if (ACRONYM.test(term)) {
      const re = boundaryRegex(term, false);
      return (s) => re.test(s);
    }
    const k = norm(term);
    return (s) => s.includes(k);
  });
  // ➤ Negatives take two shapes in the YAML: a plain "Term" blocks always; { term: "T",
  // ➤ unless: [...] } blocks only when none of the unless words appear in the title
  // ➤ ("Consultant, unless offshore wind"). Each negative keeps its LABEL so --explain can
  // ➤ say which word blocked.
  const negatives = (tf?.negative || []).map(t => {
    if (t && typeof t === 'object' && t.term) {
      const re = boundaryRegex(t.term, true);
      // ➤ WORD-aware rescue: each unless word is matched with its own boundary, so "Windows"
      // ➤ does not rescue as "wind".
      const unlessRe = (t.unless || []).map(u => boundaryRegex(String(u), true));
      return { label: t.term, test: (s) => re.test(s) && !unlessRe.some(u => u.test(s)) };
    }
    const re = boundaryRegex(t, true);
    return { label: String(t), test: (s) => re.test(s) };
  });
  // ➤ A PLACE IS NOT A FIELD. Boards glue the region into the title — "Chirurgien
  // ➤ orthopédiste - Seine-Maritime (76)", a nanny "à MARINES" — and a positive like
  // ➤ "Maritime" or "Marine" then fires on the geography. Before the positives are checked,
  // ➤ every segment of the offer's own location that appears verbatim in the title is masked
  // ➤ out, so the field words have to be in the JOB part. Only whole location segments of
  // ➤ five letters or more: "Offshore Engineer" in "Offshore Base, Aberdeen" loses nothing.
  // ➤ Negatives still read the whole title — a blocked word inside a place name still
  // ➤ blocks, the conservative direction.
  const placeSegments = location => String(location || '').split(/[,;|]/)
    .map(s => norm(s).trim()).filter(s => s.length >= 5);
  const withoutPlaces = (lower, location) => {
    let masked = lower;
    for (const seg of placeSegments(location)) if (masked.includes(seg)) masked = masked.split(seg).join(' ');
    return masked;
  };
  const anyPositive = s => positives.length === 0 || positives.some(p => p(s));
  const fn = (title, location = '') => {
    const lower = norm(title);
    if (!anyPositive(withoutPlaces(lower, location))) return false;
    return !negatives.some(neg => neg.test(lower));
  };
  // ➤ .explain(title, location): same verdict as the filter, but RETURNS the
  // ➤ reason for the discard as text (for the "why each offer was discarded"
  // ➤ list, --explain mode). If the offer passes the title, it returns null.
  fn.explain = (title, location = '') => {
    const lower = norm(title);
    if (!anyPositive(withoutPlaces(lower, location))) {
      // ➤ Say WHICH kind of miss it was: no field word at all, or one that
      // ➤ only sat inside the place name — the reader of --explain then knows
      // ➤ whether to touch the positives or to shrug at the geography.
      return anyPositive(lower)
        ? 'the title\'s only keyword from your field is part of its place name'
        : 'the title has no keyword from your field';
    }
    const hit = negatives.find(neg => neg.test(lower));
    return hit ? `the title has the blocked word "${hit.label}"` : null;
  };
  return fn;
}

// ── Location filter (portals.yml — fixed hard rules) ────────────────
// ➤ Block terms use the acronym rule too: "UK" must not match inside "Ukraine"; longer
// ➤ names stay substring ("Saudi" → "Saudi Arabia").

// ➤ Builds the function that detects blocked locations in a text.
function buildBlockMatcher(blockTerms) {
  // ➤ Every term is matched as a WHOLE WORD, not a loose substring: "Peru" must not block
  // ➤ Perugia nor "Oman" Romans-sur-Isère, while "Saudi" still catches "Saudi Arabia".
  const matchers = (blockTerms || []).map(term => {
    const re = boundaryRegex(term, false);
    return (s) => re.test(s);
  });
  return (text) => {
    if (!text) return false;
    const lower = norm(text);
    return matchers.some(m => m(lower));
  };
}

// ➤ Builds the complete location filter: first it discards the
// ➤ blocked ones, and if there's an allow list, it requires being in it.
// ➤ An empty location always passes (it'll be resolved later).
export function buildLocationFilter(lf) {
  if (!lf) return Object.assign(() => true, { blockHit: () => false });
  const allow = (lf.allow || []).map(norm);
  const blockHit = buildBlockMatcher(lf.block);
  // ➤ ONE SEAT YOU CAN TAKE IS ENOUGH. A posting open in several places arrives as one
  // ➤ string ("Barcelona, ES; Dubai, AE"); read whole, the block list sees Dubai and the
  // ➤ real job in Barcelona is lost. Each place is judged on its own and the offer survives
  // ➤ if any one of them passes.
  const one = (place) => {
    if (blockHit(place)) return false;
    if (allow.length === 0) return true;
    const lower = norm(place);
    return allow.some(k => lower.includes(k));
  };
  const fn = (loc) => {
    if (!loc) return true;
    const places = String(loc).split(';').map(x => x.trim()).filter(Boolean);
    return places.length ? places.some(one) : one(String(loc));
  };
  // ➤ The blocked-country detector is exposed separately so it can also be
  // ➤ applied to the TITLE: multi-location Workday jobs say "2 Locations" and
  // ➤ carry the real country only in the title ("Shell Graduate Programme
  // ➤ 2026 - Qatar").
  fn.blockHit = blockHit;
  return fn;
}
