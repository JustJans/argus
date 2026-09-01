// ➤ The three text helpers every module used to carry its own copy of.
// ➤ Seven accent-folders had grown across the engine, five identical and two
// ➤ near misses; the title-key normalisation was pasted into scan and
// ➤ housekeep separately and had already drifted once. One home, one meaning.

// ➤ Accents off, case kept: "Électromécanicien" → "Electromecanicien". For the
// ➤ places where case still carries meaning (a regex written in capitals, a
// ➤ company name about to be capitalised word by word).
export const unaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ➤ Accents off AND lower case: the comparison form for everything that
// ➤ matches words — filter terms, veto chips, ESCO labels, mail phrases. Must
// ➤ be applied to BOTH sides of a comparison, or accented terms silently stop
// ➤ matching accented text and a filter opens instead of closing.
export const fold = s => unaccent(s).toLowerCase();

// ➤ A title reduced to what identifies the ROLE, for telling a re-post from a
// ➤ new vacancy: gender tags "(m/w/d)" / "(x w m)" / "(all genders)" and
// ➤ schedules "80-100%" vary between postings of the same job and go, dashes
// ➤ are unified, whitespace collapsed, trailing punctuation dropped. Case is
// ➤ lowered but accents are KEPT on purpose — a key is only ever compared with
// ➤ a key built the same way from the same source.
// ➤ The gender-tag pattern is written WITHOUT ambiguous repetition (CodeQL
// ➤ round, 2026-08-24): an optional-separator form backtracked exponentially
// ➤ on a title like "(m m m m …" with no closing paren, and titles come from
// ➤ the boards. Separators are one mandatory run; a fused "(mwd)" has its own
// ➤ branch.
export function titleKey(s) {
  return String(s).toLowerCase()
    .replace(/\(\s*(?:[mwfdxhv](?:[\s/|,.]+[mwfdxhv])+|[mwfdxhv]{2,}|all\s*genders?|gn)\s*\)/gi, ' ')
    .replace(/\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%|\b\d{2,3}\s*%/g, ' ')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim();
}
