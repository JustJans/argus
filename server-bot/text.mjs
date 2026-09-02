// ➤ The three text helpers every module needs, in one home: accent folding and the
// ➤ title-key normalisation shared by scan and housekeep, so the two ends cannot drift
// ➤ apart.

// ➤ Accents off, case kept: "Électromécanicien" → "Electromecanicien". For the
// ➤ places where case still carries meaning (a regex written in capitals, a
// ➤ company name about to be capitalised word by word).
export const unaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ➤ Accents off AND lower case: the comparison form for everything that
// ➤ matches words — filter terms, veto chips, ESCO labels, mail phrases. Must
// ➤ be applied to BOTH sides of a comparison, or accented terms silently stop
// ➤ matching accented text and a filter opens instead of closing.
export const fold = s => unaccent(s).toLowerCase();

// ➤ A title reduced to what identifies the ROLE, for telling a re-post from a new vacancy:
// ➤ gender tags ("(m/w/d)", "(x w m)", "(all genders)") and schedules ("80-100%") go,
// ➤ dashes are unified, whitespace collapsed, trailing punctuation dropped. Case is
// ➤ lowered but accents KEPT — a key is only compared with a key built the same way. The
// ➤ gender-tag pattern has no ambiguous repetition: an optional separator backtracks
// ➤ exponentially on "(m m m m …" with no closing paren, and titles come from the boards;
// ➤ separators are one mandatory run, and a fused "(mwd)" has its own branch.
export function titleKey(s) {
  return String(s).toLowerCase()
    .replace(/\(\s*(?:[mwfdxhv](?:[\s/|,.]+[mwfdxhv])+|[mwfdxhv]{2,}|all\s*genders?|gn)\s*\)/gi, ' ')
    .replace(/\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%|\b\d{2,3}\s*%/g, ' ')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim();
}
