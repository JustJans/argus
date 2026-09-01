// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the Council's test suite. It checks — WITH NO network and WITHOUT
// ➤ writing anything — that the deterministic pieces work: the ballot (2 of 3), the
// ➤ vote reader (parseVerdict in several formats), the dropped-offer parsing, the
// ➤ prompt assembly and the reconciliation with the user's real decision.
// ➤ The AI call is MOCKed (Claude is never really called here).
// ➤ WHEN IT RUNS: manually, "node server-bot/argus-council/test-council.mjs",
// ➤ after touching any Council file. It prints how many passed and
// ➤ exits with code 0 (all good) or 1 (something failed).
// ➤ ═══════════════════════════════════════════════════════════════════════

import { parseVerdict, JUDGES } from './judges.mjs';
import { councilVote } from './vote.mjs';
import { buildJudgePrompt } from './engine.mjs';
import { sampleDropped, formatCouncilEntry, offerKey, filterUnjudged, bodyVerdict, MIN_BODY_CHARS, hostOf } from './judge-shadow.mjs';
import { buildUserDecisions, decideFor } from './reconcile.mjs';

let passed = 0;
const fails = [];
// ➤ Simple comparison: if it doesn't match, the failure is recorded with its label.
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; } else { fails.push(`${label}\n    expected: ${e}\n    actual:   ${a}`); }
}
function ok(cond, label) { if (cond) { passed++; } else { fails.push(label); } }

// ── 1) The ballot: councilVote (majority 2 of 3, ties, nulls) ───────────────
eq(councilVote(['show', 'show', 'hide']), 'show', 'vote: 2 show wins');
eq(councilVote(['hide', 'hide', 'show']), 'hide', 'vote: 2 hide wins');
eq(councilVote(['show', 'show', 'show']), 'show', 'vote: 3 show');
eq(councilVote(['hide', 'hide', 'hide']), 'hide', 'vote: 3 hide');
eq(councilVote(['show', 'hide', null]), 'tie', 'vote: 1-1 with null = tie');
eq(councilVote([null, null, null]), 'tie', 'vote: all nulls = tie');
eq(councilVote(['show', null, null]), 'tie', 'vote: only 1 vote = tie (insufficient)');
eq(councilVote(['hide', null, null]), 'tie', 'vote: only 1 hide = tie');
// ➤ Also accepts full judge objects (not just the vote word).
eq(councilVote([{ vote: 'show' }, { vote: 'show' }, { vote: null }]), 'show', 'vote: judge-objects 2 show');
eq(councilVote([{ vote: 'hide' }, { vote: 'show' }, { vote: 'hide' }]), 'hide', 'vote: judge-objects 2 hide');
eq(councilVote([]), 'tie', 'vote: empty array = tie');

// ── 2) The vote reader: parseVerdict in several formats ─────────────────
// ➤ Clean JSON in English.
eq(parseVerdict('{"vote":"show","reason":"encaja","confidence":0.9}'),
  { vote: 'show', reason: 'encaja', confidence: 0.9 }, 'parse: clean JSON show');
// ➤ JSON with "hide" and confidence.
eq(parseVerdict('{"vote":"hide","reason":"pide STCW","confidence":0.8}'),
  { vote: 'hide', reason: 'pide STCW', confidence: 0.8 }, 'parse: clean JSON hide');
// ➤ JSON embedded in chatty text (the judge rambled on).
{
  const r = parseVerdict('Tras pensarlo, mi veredicto es:\n{"vote":"show","reason":"joya OrcaFlex","confidence":0.95}\nGracias.');
  eq({ vote: r.vote, confidence: r.confidence }, { vote: 'show', confidence: 0.95 }, 'parse: embedded JSON');
}
// ➤ Keys in Spanish (voto/razón/confianza).
{
  const r = parseVerdict('{"voto":"mostrar","razón":"survey marino","confianza":0.7}');
  eq({ vote: r.vote, confidence: r.confidence }, { vote: 'show', confidence: 0.7 }, 'parse: Spanish keys + mostrar');
}
eq(parseVerdict('{"voto":"ocultar","razón":"es de IA","confianza":0.85}').vote, 'hide', 'parse: ocultar = hide');
// ➤ Loose text with NO JSON: just the vote word.
eq(parseVerdict('Yo diría que hay que mostrar esta oferta.').vote, 'show', 'parse: loose text mostrar');
eq(parseVerdict('Claramente hide, no encaja.').vote, 'hide', 'parse: loose text hide');
// ➤ Confidence "80" (no decimals) normalizes to 0.8.
eq(parseVerdict('{"vote":"show","reason":"x","confidence":80}').confidence, 0.8, 'parse: confidence 80 -> 0.8');
// ➤ No readable vote → null and confidence 0 (doesn't count in the ballot).
{
  const r = parseVerdict('No lo tengo claro, mmm.');
  eq({ vote: r.vote, confidence: r.confidence }, { vote: null, confidence: 0 }, 'parse: no vote = null');
}
// ➤ Empty string / garbage → null.
eq(parseVerdict('').vote, null, 'parse: empty = null');
eq(parseVerdict('{roto').vote, null, 'parse: broken JSON no vote = null');
// ➤ Confidence always stays between 0 and 1.
ok(parseVerdict('{"vote":"show","reason":"x","confidence":5}').confidence <= 1, 'parse: out-of-range confidence gets clamped');

// ── 3) Parsing of dropped offers (scan-explain.txt) ────────────────────────────
{
  const explain = [
    'LISTA DE DECISIONES DEL ESCANEO — 2026-07-20 10:00',
    'Resumen por motivo:',
    '  TITLE: 2',
    '',
    '[TITLE] title out of field — Mechanical Design Engineer | ACME | Madrid (adzuna)',
    '[LANGUAGE] title in German — Automatisierungsingenieur | Bosch | Hamburg (linkedin)',
    '[YEARS/DEGREE] requires 5 years — Senior Offshore Engineer | DEME | (no location) (workday)',
    '[LOCATION] outside area — Marine Engineer | XYZ | London (adzuna)',
    '[✅ NEW] passes — Graduate Mooring Engineer | SBM | Rotterdam (workday)',
  ].join('\n');
  const s = sampleDropped(explain, 5);
  eq(s.length, 3, 'dropped: only TITLE/LANGUAGE/YEARS-DEGREE (3 of 5)');
  eq({ title: s[0].title, company: s[0].company, location: s[0].location, url: s[0].url, botDecision: s[0].botDecision },
    { title: 'Mechanical Design Engineer', company: 'ACME', location: 'Madrid', url: '', botDecision: 'dropped:TITLE' },
    'dropped: fields extracted correctly');
  eq(s[2].location, '', 'dropped: "(no location)" -> empty');
  eq(sampleDropped(explain, 1).length, 1, 'dropped: respects the limit');
  eq(sampleDropped(explain, 0).length, 0, 'dropped: limit 0 -> nothing');
}

// ── 3b) The human-readable log: formatCouncilEntry ─────────────────────────────────
{
  const rec = {
    id: 636, company: 'ICT Group', title: 'PCS7 Engineer', botDecision: 'presented',
    council: 'hide',
    verdicts: {
      good: { vote: 'show', reason: 'parece de su campo', confidence: 0.9 },
      bad: { vote: 'hide', reason: 'exige neerlandés\n  fluido', confidence: 0.92 },
      ugly: { vote: 'hide', reason: 'idioma bloquea', confidence: 0.97 },
    },
  };
  const s = formatCouncilEntry(rec);
  ok(s.includes('#636 · ICT Group — PCS7 Engineer'), 'log: offer header');
  ok(s.includes('COUNCIL: HIDE'), 'log: Council verdict in uppercase');
  ok(s.includes('Good show/0.90') && s.includes('Bad hide/0.92') && s.includes('Ugly hide/0.97'), 'log: votes and confidence of all 3');
  ok(s.includes('Bad  — exige neerlandés fluido'), 'log: reason with collapsed line breaks');
  // ➤ Null judge (failed): shows "n/a/0.00" without breaking.
  ok(formatCouncilEntry({ company: 'X', title: 'Y', council: 'tie', verdicts: { good: {}, bad: {}, ugly: {} } }).includes('Good n/a/0.00'), 'log: null judge -> n/a');
}

// ── 3c) Anti-repeat lock: offerKey + filterUnjudged ─────────────────
{
  // ➤ Key by clean URL (without the "?..." tail), or company::title if there's no URL.
  eq(offerKey({ url: 'https://x.com/job/5?utm=a&b=2' }), 'https://x.com/job/5', 'key: url without query');
  eq(offerKey({ url: 'https://x.com/job/5/' }), 'https://x.com/job/5', 'key: url without trailing slash');
  eq(offerKey({ company: 'ACME', title: 'Mooring Eng' }), 'acme::mooring eng', 'key: no url -> company::title');
  // ➤ filterUnjudged keeps only what has NOT been judged.
  const judged = new Set(['https://x.com/1', 'acme::mooring eng']);
  const work = [
    { url: 'https://x.com/1' },                    // already judged (by url)
    { url: 'https://x.com/2' },                    // new
    { company: 'ACME', title: 'Mooring Eng' },     // already judged (no url)
    { company: 'Nova', title: 'Survey Eng' },      // new
  ];
  const out = filterUnjudged(work, judged);
  eq(out.length, 2, 'dedup: 2 new remain out of 4');
  eq(out.map(o => o.url || o.company), ['https://x.com/2', 'Nova'], 'dedup: they are the correct ones');
  eq(filterUnjudged(work, new Set()).length, 4, 'dedup: empty registry -> nothing is skipped');
}

// ── 4) Prompt assembly (buildJudgePrompt) ────────────────────────────
{
  const judge = { key: 'good', prompt: 'INSTRUCCIONES-DEL-JUEZ', model: 'haiku' };
  const offer = { title: 'Mooring Engineer', company: 'Acme Marine', location: 'Barcelona' };
  const p = buildJudgePrompt(judge, offer, 'Trabajo con OrcaFlex y normas DNV.');
  ok(p.includes('INSTRUCCIONES-DEL-JUEZ'), 'prompt: includes the judge instructions');
  ok(p.includes('Mooring Engineer') && p.includes('Acme Marine'), 'prompt: includes title and company');
  ok(p.includes('OrcaFlex'), 'prompt: includes the body');
  // ➤ No body: warns to judge by title only (doesn't break).
  ok(buildJudgePrompt(judge, offer, '').includes('judge by the title alone'), 'prompt: no body warns');
}

// ── 4b) The degree rule must keep its escape clause ──────────────────
// ➤ 2026-07-27: the three judges used to treat "degree in X OR COMPARABLE" as a
// ➤ closed door, while the deterministic filter (DEG_ALT, since 2026-07-18)
// ➤ keeps those offers. The Council would have deleted #664 and #705 — both
// ➤ ones the owner applied to. The nuance is now in all three prompts; if anyone
// ➤ removes it, this test fails instead of the bot silently over-blocking again.
{
  for (const j of JUDGES) {
    ok(/or equivalent experience|gelijkaardige|vergelijkbare/.test(j.prompt),
      `prompt ${j.key}: keeps the "or equivalent degree" escape`);
  }
}

// ── 5) Journal record format (one valid JSON line) ────────────
{
  // ➤ Record built the same way judgeOffer does (without calling the AI).
  const rec = {
    ts: '2026-07-20T10:15:00.000Z', id: 412, company: 'SBM', title: 'Mooring Engineer',
    url: 'https://x/1', source: 'pending', botDecision: 'presented',
    verdicts: {
      good: { vote: 'show', reason: 'joya', confidence: 0.9 },
      bad: { vote: 'show', reason: 'sin prueba de descarte', confidence: 0.6 },
      ugly: { vote: 'hide', reason: 'función comercial', confidence: 0.5 },
    },
    council: 'show', userDecision: null,
  };
  const round = JSON.parse(JSON.stringify(rec));
  eq(round, rec, 'journal: the line is valid JSON and round-trips');
  eq(councilVote([rec.verdicts.good, rec.verdicts.bad, rec.verdicts.ugly]), 'show', 'journal: council matches the ballot');
  const keys = Object.keys(rec).sort();
  eq(keys, ['botDecision', 'company', 'council', 'id', 'source', 'title', 'ts', 'url', 'userDecision', 'verdicts'], 'journal: has all the fields');
}

// ── 6) Reconciliation with the user's real decision ─────────────────────────
{
  const idx = buildUserDecisions({
    applied: [{ id: 412, url: 'https://x/1' }],
    feedback: [{ id: 500, url: 'https://x/2' }],
    pipelineText: '- [x] https://x/3 | ACME | Marine Eng | #600 | visto\n',
  });
  eq(decideFor({ id: 412, url: 'https://x/1' }, idx), 'show', 'reconcile: applied = show');
  eq(decideFor({ id: 500, url: 'https://x/2' }, idx), 'hide', 'reconcile: rejected = hide');
  eq(decideFor({ id: 600, url: 'https://x/3' }, idx), 'seen', 'reconcile: seen = seen');
  eq(decideFor({ id: 999, url: 'https://x/none' }, idx), null, 'reconcile: undecided = null');
  // ➤ Matches by URL even if the id isn't in the index.
  eq(decideFor({ id: null, url: 'https://x/1' }, idx), 'show', 'reconcile: matches by URL without id');
  // ➤ Precedence: applied overrides rejected if the same offer is in both.
  {
    const idx2 = buildUserDecisions({
      applied: [{ id: 7, url: 'https://x/7' }],
      feedback: [{ id: 7, url: 'https://x/7' }],
      pipelineText: '',
    });
    eq(decideFor({ id: 7, url: 'https://x/7' }, idx2), 'show', 'reconcile: applied overrides rejected');
  }
  // ➤ A LONGSHOT is a sent application that must NOT grade the Council as right
  // ➤ — the user knew the requirements fell short. It stays out of the ground
  // ➤ truth, so an offer only longshot-ted comes back undecided.
  {
    const idx3 = buildUserDecisions({
      applied: [{ id: 729, url: 'https://x/729', longshot: true, reason: 'three years required' }],
      feedback: [],
      pipelineText: '',
    });
    eq(decideFor({ id: 729, url: 'https://x/729' }, idx3), null, 'reconcile: a longshot is NOT show');
  }
  // ➤ And it must not silence a real rejection of the same offer either.
  {
    const idx4 = buildUserDecisions({
      applied: [{ id: 8, url: 'https://x/8', longshot: true }],
      feedback: [{ id: 8, url: 'https://x/8' }],
      pipelineText: '',
    });
    eq(decideFor({ id: 8, url: 'https://x/8' }, idx4), 'hide', 'reconcile: a longshot does not override a rejection');
  }
}

// ── Result ──────────────────────────────────────────────────────────────
// ➤ bodyVerdict: what the judges are given, and whether asking them is worth it
// ➤ (2026-08-26, case #1005: a cookie wall judged as a YES).
{
  const page = (text, status = 200) => ({ text, status });
  eq(bodyVerdict({ title: 'Rigger' }, page('', 0)), 'judge', 'no URL → judged by title (the dropped samples, by design)');
  eq(bodyVerdict({ url: 'https://x/1' }, page('', 0)), 'retry', 'no answer at all → retry, never a verdict');
  eq(bodyVerdict({ url: 'https://x/1' }, page('', 429)), 'retry', 'a rate limit → retry');
  eq(bodyVerdict({ url: 'https://x/1' }, page('', 403)), 'retry', 'a block → retry');
  eq(bodyVerdict({ url: 'https://x/1' }, page('', 503)), 'retry', 'a server error → retry');
  eq(bodyVerdict({ url: 'https://x/1' }, page('', 404)), 'blind', 'a page that is gone → blind, not retried forever');
  eq(bodyVerdict({ url: 'https://x/1' }, page('   \n ')), 'blind', 'a 200 with only whitespace → blind');
  eq(bodyVerdict({ url: 'https://x/1' }, page('Accept cookies. Menu. Login.')), 'blind', 'a 200 that answered with chrome only → blind');
  eq(bodyVerdict({ url: 'https://x/1' }, page('x'.repeat(MIN_BODY_CHARS))), 'judge', 'exactly the floor is enough to judge');
  eq(bodyVerdict({ url: 'https://x/1' }, page('x'.repeat(MIN_BODY_CHARS - 1))), 'blind', 'one under the floor is blind');
  eq(bodyVerdict({ url: 'https://x/1' }, page('x'.repeat(50)), 40), 'judge', 'the floor comes from config');
  eq(hostOf('https://www.adzuna.fr/details/5863783815'), 'adzuna.fr', 'the board behind a URL, without www');
  eq(hostOf('https://careers.bureauveritas.com/job/x/1/'), 'careers.bureauveritas.com', 'a careers subdomain is its own board');
  eq(hostOf(''), '', 'no URL → no board');
  const blind = formatCouncilEntry({ id: 1005, company: 'Indra', title: 'Ingeniero', botDecision: 'presented', council: 'blind', bodyChars: 41, verdicts: {} });
  ok(blind.includes('COUNCIL: BLIND') && blind.includes('41 characters'), 'a blind record prints what the page gave, not votes');
  ok(!/good|bad|ugly/i.test(blind), 'and no judge line, since nobody was asked');
}

if (fails.length) {
  console.error(`\n${fails.length} council test(s) FAILED:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${passed} passed, ${fails.length} failed.`);
  process.exit(1);
}
console.log(`All ${passed} council tests passed.`);
process.exit(0);
