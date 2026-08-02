#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the first piece of argus-discover. It answers one question:
// ➤ "am I searching for the right things?" — by cross-reading your CV, your
// ➤ search terms and your own past decisions.
// ➤ WHAT IT DOES NOT DO: touch the network, call a model, or change a single
// ➤ setting. It reads files and prints a report. Every change is yours to make.
// ➤ RUN: node server-bot/argus-discover/audit-profile.mjs
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { buildTitleFilter } from '../scan.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));

// ➤ Accents out and lowercase, so "Automatización" and "automatizacion" are the
// ➤ same word. The search lists carry the same concept in five languages.
export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ➤ Does the CV back this search term? Whole-word match on the folded text,
// ➤ plus a 6-letter stem so "hydrograph" is backed by "hydrographic". No
// ➤ cross-language guessing: "Amarrament" is only backed if the CV says it,
// ➤ because inferring it from "mooring" would be inventing evidence.
export function cvBacks(term, cvText) {
  const t = fold(term).trim();
  if (!t) return false;
  const cv = fold(cvText);
  // ➤ Boundaries on BOTH sides: with only a leading one, "GIS" was backed by
  // ➤ the word "gist". Prefix matching is the stem rule's job below, and that
  // ➤ one demands 6 letters precisely so short terms cannot reach it.
  if (new RegExp(`(?<![\\p{L}\\d])${t.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m)}(?![\\p{L}\\d])`, 'u').test(cv)) return true;
  const stem = t.replace(/[^a-z]/g, '');
  return stem.length >= 6 && cv.includes(stem.slice(0, 6));
}

// ➤ How the term has actually performed, from YOUR decisions.
// ➤ IMPORTANT (and the reason this tool is worth trusting): a rejection only
// ➤ counts if the offer would STILL reach you today. Half the "Naval"
// ➤ rejections were French trades — Détoureur, Calorifugeur, Tubero — that the
// ➤ filter now blocks by name. Counting those would bill the term for damage
// ➤ that has already been repaired, and send you chasing a solved problem.
export function termRecord(term, { rejected = [], applied = [], stillPasses = () => true } = {}) {
  const t = fold(term);
  const hit = o => fold(o.title).includes(t);
  const live = rejected.filter(o => hit(o) && stillPasses(o.title));
  return {
    term,
    rejected: live.length,
    rejectedAlreadyFixed: rejected.filter(hit).length - live.length,
    // ➤ A longshot is NOT a win: it was sent knowing the requirements fell
    // ➤ short, so it is no evidence the term is admitting good offers.
    applied: applied.filter(o => !o.longshot && hit(o)).length,
    longshots: applied.filter(o => o.longshot && hit(o)).length,
  };
}

// ➤ THE THREE WORD LISTS BELOW ARE MEANT TO BE EDITED. You write your reasons
// ➤ with the "no N reason" command in your own words and your own language, so
// ➤ no shipped list can know them. These are a starting set in the languages
// ➤ the engine already handles; add your own phrasings as you go, and the
// ➤ audit gets sharper. A reason that matches nothing is filed as 'other',
// ➤ never guessed at.

// ➤ Not a judgement on the offer at all: it had expired, was a duplicate, or
// ➤ the link was broken.
const NOISE = /\bclosed\b|no longer|expired|duplicate|dead link|broken link|cerrad|no acepta|duplicad|no va el link|reflotad/;

// ➤ The offer was the WRONG ROLE: the title should never have reached you.
// ➤ This is the family that points at a gap in the filters.
const WRONG_FIELD = new RegExp([
  // English
  'not (my|the right) (field|job|role|area)', 'nothing to do with',
  'wrong (field|role|sector)', "don'?t want to be", 'not interested in the role',
  // Spanish
  'no es (un )?trabajo para mi', 'no tiene nada que ver', 'no me interesa',
  'no quiero ser', 'no me gusta el puesto',
].join('|'));

// ➤ The role was RIGHT but the ad asked for more than you have — years, a
// ➤ degree, a language, a tool. Nothing to fix in the search.
const TOO_DEMANDING = /experienc|expertise|years|requirement|mandatory|skills|master|degree|fluent|language|\banos\b|\baños\b|jaar|jahre|\bans\b|requisito|grado|titulacion|carrera|licenc|estudios|idioma|aleman|holand|neerland|dutch|german|frances|nivel|conocimiento|dominio/;

// ➤ Splits a rejection reason into the families that mean opposite things:
// ➤   'requirements' → the TITLE was right, the ad asked for more than you have.
// ➤                    Nothing to fix in the search.
// ➤   'field'        → the title should never have reached you. A filter gap.
export function classifyReason(reason) {
  const r = fold(reason);
  if (!r.trim() || /^\(no reason\)$/.test(r)) return 'unstated';
  if (NOISE.test(r)) return 'noise';
  // ➤ Field first: "not my field" carries no word of the requirements family,
  // ➤ while "it asks to be a mechanical engineer" carries both and is really
  // ➤ about the degree — so the field patterns are the narrow ones, tested first.
  if (WRONG_FIELD.test(r)) return 'field';
  if (TOO_DEMANDING.test(r)) return 'requirements';
  return 'other';
}

// ➤ Pulls candidate skills out of the CV. The Skills block is found by an H2
// ➤ ("## Skills") and stays open across its sub-headings ("### Technical"),
// ➤ closing only at the next H2 — the shape almost every CV uses.
export function extractCvSkills(cvText) {
  const out = [];
  let inSkills = false;
  for (const line of String(cvText || '').split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length <= 2) inSkills = /skill|habilidad|competenc|aptitud/i.test(h[2]);
      continue;
    }
    if (!inSkills) continue;
    // ➜ Parenthesised asides go BEFORE the split, or a language line such as
    // ➜ "English: C1 (some exam 7.0, awarding body 2023)" is torn in two by the
    // ➜ comma and its tail survives as a fake skill.
    const body = line.replace(/^[-*]\s*/, '').replace(/\([^)]*\)/g, '').replace(/\*\*[^*]*:\*\*/, '').replace(/\*\*/g, '');
    for (const piece of body.split(/[,/;]/)) {
      const s = piece.replace(/\([^)]*\)/g, '').replace(/[()]/g, '').trim();
      if (!s || s.length < 3 || s.length > 34 || s.split(/\s+/).length > 4) continue;
      // ➜ Leftovers of a stripped parenthesis ("IDP 2023", "7.0") are not skills.
      if (!/[a-z]{3}/i.test(s) || /^\d/.test(s)) continue;
      // ➤ Languages and their levels are not searchable skills.
      if (/^(native|nativo|nativa|c1|c2|b1|b2|a2|a1|spanish|catalan|english|dutch|german|french)\b/i.test(s)) continue;
      out.push(s);
    }
  }
  return [...new Set(out)];
}

export function buildAudit({ cvText = '', positives = [], feedback = [], applications = [], stillPasses } = {}) {
  const terms = positives.map(p => {
    const term = typeof p === 'string' ? p : p.term;
    return { ...termRecord(term, { rejected: feedback, applied: applications, stillPasses }), backed: cvBacks(term, cvText) };
  });
  const families = {};
  for (const f of feedback) (families[classifyReason(f.reason || '')] ||= []).push(f);
  const skills = extractCvSkills(cvText);
  const missing = skills.filter(s => !positives.some(p => cvBacks(typeof p === 'string' ? p : p.term, s)));
  return { terms, families, skills, missingFromSearch: missing };
}

// ➤ ── The printed report ────────────────────────────────────────────────
function main() {
  const cvPath = join(ROOT, 'cv.md');
  if (!existsSync(cvPath)) { console.log('No cv.md found — the audit needs it to judge whether a search term is backed.'); return; }
  const cvText = readFileSync(cvPath, 'utf-8');
  const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
  const positives = portals?.title_filter?.positive || [];
  const filter = buildTitleFilter(portals?.title_filter || {});
  const readJsonl = p => (existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
  const feedback = readJsonl(join(ROOT, 'server-bot', 'feedback.jsonl'));
  const applications = readJsonl(join(ROOT, 'data', 'applications.jsonl'));
  const a = buildAudit({ cvText, positives, feedback, applications, stillPasses: t => filter(t) });

  console.log('\nARGUS-DISCOVER — profile audit');
  console.log(`${positives.length} search terms · ${feedback.length} rejections · ${applications.length} applications`);
  console.log('Rejections of offers the filter ALREADY blocks are not counted against a term.\n');

  // ➤ 1) Terms still admitting offers you turn down. Deliberately NOT called
  // ➤ "terms to remove": a term with no CV backing can mean either that the
  // ➤ search is wrong or that the CV is under-selling you, and the data cannot
  // ➤ tell those apart. The column is shown; the reading is yours.
  // ➜ The same concept is spelled five ways in the search list
  // ➜ (Instrumentación/Instrumentacio/Instrumentació...). Showing five identical
  // ➜ rows buries the report, so only the first of each family is printed.
  const seenStem = new Set();
  const noisy = a.terms.filter(t => t.rejected >= 2 && t.applied === 0)
    .sort((x, y) => y.rejected - x.rejected)
    .filter(t => {
      const stem = fold(t.term).replace(/[^a-z]/g, '').slice(0, 8);
      if (seenStem.has(stem)) return false;
      seenStem.add(stem); return true;
    });
  console.log('── TERMS THAT ADMIT OFFERS YOU ALWAYS TURN DOWN ─────────────');
  if (!noisy.length) console.log('  None: every term that still admits offers has produced an application.\n');
  else {
    console.log('  Term                       rejected  applied  longshot  in CV');
    for (const t of noisy.slice(0, 12)) {
      console.log(`  ${t.term.padEnd(25)}${String(t.rejected).padStart(8)}${String(t.applied).padStart(9)}${String(t.longshots).padStart(10)}${(t.backed ? '  yes' : '   no').padStart(7)}`);
    }
    console.log('  "in CV: no" is a question, not a verdict — it can mean the search is');
    console.log('  aimed wrong, or that the CV does not say what you actually do.\n');
  }

  // ➤ 2) The other direction: what you can defend but never search for.
  console.log('── IN YOUR CV, NOT IN YOUR SEARCH ───────────────────────────');
  console.log(`  (${a.skills.length} skills read from the CV)`);
  if (!a.missingFromSearch.length) console.log('  Nothing: every skill in the CV appears as a search term.\n');
  else console.log('  ' + a.missingFromSearch.join(' · ') + '\n');

  // ➤ 3) What your rejections are really saying.
  console.log('── WHY YOU REJECT ───────────────────────────────────────────');
  const n = k => (a.families[k] || []).length;
  console.log(`  ${String(n('requirements')).padStart(4)}  did not meet the ad  → the title was RIGHT, nothing to fix`);
  console.log(`  ${String(n('field')).padStart(4)}  not my field         → the title should never have passed`);
  console.log(`  ${String(n('noise')).padStart(4)}  dead or duplicate    → not about the filter`);
  console.log(`  ${String(n('other') + n('unstated')).padStart(4)}  unclassified`);
  const gaps = (a.families.field || []).filter(g => filter(String(g.title || ''))).slice(-8);
  console.log(gaps.length
    ? '\n  "Not my field" titles the filter STILL lets through — real gaps:'
    : '\n  Every "not my field" rejection is already blocked by the filter.');
  // ➤ Whole titles: this list is what you read to decide whether a filter has a
  // ➤ hole in it, and a title cut at 62 characters hides the end that says so.
  for (const g of gaps) console.log(`    #${g.id} ${String(g.title)}`);
  console.log('\n  Nothing above has been changed. Decide what is worth acting on.\n');
}

if (process.argv[1] && /audit-profile\.mjs$/.test(process.argv[1])) main();
