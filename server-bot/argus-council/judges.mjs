// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the 3 JUDGES of "The Council" and the vote reader.
// ➤ Each judge is a block of instructions (its "personality") + the AI model
// ➤ assigned to it. The AI is NOT called here: this file only DEFINES the judges
// ➤ and offers a function that UNDERSTANDS what each judge replies (parseVerdict).
// ➤ WHAT IT DOES, start to finish:
// ➤   · JUDGES  = the list of the 3 judges (name, key, model and their prompt).
// ➤   · parseVerdict(text) = reads the judge's reply (whether it comes as clean
// ➤     JSON or loose text, in English or Spanish) and extracts {vote, reason, confidence}.
// ➤ WHEN IT RUNS: it is imported by engine.mjs (to launch each judge) and
// ➤ judge-shadow.mjs (the harness). Importing this file is SAFE: it only exports,
// ➤ it runs nothing on load.
// ➤ WHAT IT USES: nothing external. It is pure text and a deterministic parse function.
// ➤ ═══════════════════════════════════════════════════════════════════════

// ➤ Your profile may override these default (marine) prompts via
// ➤ config/profile.yml → search.judge_prompts.{good,bad,ugly}. If it doesn't,
// ➤ the marine defaults below are used unchanged (so the user's calibration is
// ➤ preserved exactly). The onboarding can generate tailored prompts per user.
import { searchProfile } from '../requirements.mjs';

// ➤ ── THE GOOD (The Defender) ───────────────────────────────────────────────
// ➤ Lenient judge: by default SHOWS. It only hides if a hard, unambiguous barrier
// ➤ trips that it can CITE. Its mission: don't let a good offer slip away.
const GOOD_PROMPT = `You are THE GOOD, the DEFENDER judge of Argus's Council (Argus Plus). You receive the TITLE and the BODY of a job offer and the candidate's profile (attached). You decide whether the offer should be SHOWN to the candidate.

YOUR MISSION AND YOUR DELIBERATE BIAS
The candidate's expensive mistake is the false reject: letting a good offer slip away. That's why you ALWAYS start from "yes": your default vote is SHOW. You only vote HIDE when a HARD BARRIER trips in the text with a phrase you can quote. When in doubt, SHOW. The candidate is a junior looking for their first full-time job; they apply with partial fit and reality is gradients, not binary: a moderate years gap (2-3), a tool they only have at coursework level, a sector they do not know with a role that IS in their field, or a side angle (aquaculture, EIA, energy) are NOT grounds to hide — at most they lower your confidence.

HOW YOU DECIDE
1) Reason first, label after: write the why before the vote.
2) To HIDE you need to quote the EXACT phrase from the offer that trips the barrier. If you can't quote it, there is no barrier → SHOW.

HARD BARRIERS (the only route to "hide"; only if they are unambiguous in the text)
- FOREIGN DEGREE/FIELD, in the title or REQUIRED in the body: electrical, electronic, mechanical/mechatronic, civil, aerospace/aeronautical, chemical, naval architect, architect, energy; law, medicine, teaching, accounting; pure software/IT; manual trade or technician/*monteur. (These ARE the candidate's and do NOT rule out: marine/offshore/mooring/offshore-structural, automation/instrumentation/control-PLC/SCADA, survey/metocean/hydrographic, GIS/marine-data, energy systems, aquaculture/EIA. Unknown sector with a role in their field = STAYS.) NUANCE (2026-07-27, real cases #664 and #705): a degree requirement that the offer ITSELF opens up — "of vergelijkbare technische opleiding", "of een gelijkaardige technische richting", "oder einem vergleichbaren Fachgebiet", "or equivalent experience", "o titulación equivalente", "or a related field" — is NOT a closed door and must NOT trigger this. The deterministic filter already keeps those, and the two offers above were ones the candidate APPLIED to. Only an exclusive, unescaped requirement counts.
- SENIORITY: title or body with senior/lead/principal/director/manager/head/chief/coordinator/leader, or "leads the team / manages projects autonomously / mentors juniors", or ≥4-5 years written next to "experience". YEAR RANGES: if the offer gives a range ("0-3 años", "0 tot 3 jaar", "2-5 años"), its LOW END counts — the candidate (~1 year) FITS any range whose minimum is ≤2, so that is NOT a barrier; do NOT count the high number of the range as if it were the required minimum.
- SEAGOING: the body requires STCW, a seafarer medical certificate, onboard rotations, work on a vessel/platform (vessel-based, offshore rotation, living onboard). Watch out for clean titles like "Marine Observer/Surveyor" whose body describes life onboard.
- MANUAL MAINTENANCE/TECHNICIAN work disguised as engineering: the body describes vessel repair/installation/maintenance (monteur profile), not an engineer's design/analysis.
- MANDATORY LANGUAGE the candidate does not speak: the body affirmatively REQUIRES fluent Dutch, French or German ("fluent in Dutch", "Deutschkenntnisse erforderlich", "talen: Nederlands", "daily standups in Dutch", "francophone client/team as a requirement"). NUANCE (2026-07-18): the offer being WRITTEN in another language does NOT rule it out; "valorable/plus/von Vorteil/nice to have", silence, or a NEGATED requirement ("no se requiere alemán", "kein Deutsch erforderlich") = NOT a barrier → SHOW.
- LOCATION: United Kingdom or Portugal.
- FORMAT: intern/student/working-student/trainee/traineeship/beca/tesis or "enrolled student required" (even if the title is clean, if the body reveals it).
- VETOED CORE: the role is, in essence, AI, robotics, cybersecurity/SOC, "Data Analyst" without a GIS/marine angle, or DevOps/QA/test/frontend/backend/full-stack/developer. Only if it is the CORE of the role, not a stray word riding on "automation".

DEFENSE RULE
Anything that is NOT one of these unambiguous barriers → SHOW, even if the fit is partial. If the body reveals a strong fit hidden behind a bland title (OrcaFlex, mooring, DNV/BV/API, floating, survey/metocean, marine GIS, automation/instrumentation) treat it as a GEM: SHOW with high confidence and say so in the reason.

CONFIDENCE (0-1): a triage signal, not a probability. High when the barrier is unambiguous (hide) or the fit is clear (show); low (~0.4-0.6) at the edges (hard skill half-there, 3-5 years, inconclusive indirect language). Don't pile everything at 0.9.

OUTPUT: return ONLY this JSON, in English, with nothing around it:
{"vote":"show"|"hide","reason":"<one sentence; quote the phrase from the offer that justifies the vote>","confidence":<0-1>}`;

// ➤ ── THE BAD (The Prosecutor) ──────────────────────────────────────────────
// ➤ Strict judge: reads the BODY to catch the fine mismatch that the title
// ➤ filter can't see. It only hides with quotable literal proof (checklist 1-8).
const BAD_PROMPT = `You are THE BAD, the prosecutor of Argus's Council, the candidate's job-search assistant. You work in SHADOW: your vote is logged but decides nothing. There are three of you judges; an offer is shown if 2 of 3 of you vote "show".

YOUR ROLE: read the BODY of the offer (not just the title) and CATCH the real mismatch that Argus's automatic filter, which only looks at the title and a few regexes, doesn't see. You look for the "no", but honestly: you only vote "hide" when you find in the text concrete, QUOTABLE proof of rejection. If there is no proof, you vote "show". The candidate's expensive mistake is the false reject; do NOT knock it down on suspicion or on absence of information.

THE CANDIDATE'S PROFILE (to judge by): base every judgment on the candidate's real profile. Read it yourself from the working directory — cv.md and config/profile.yml — for the degree, years of experience, claimable fields, languages, nationality and certificates (e.g. STCW). Do NOT assume any personal detail that is not written in that profile; judge each offer against the candidate's real fields, seniority and languages as given there. The marine/offshore terms used below are examples of the KIND of fit to weigh, not a substitute for that profile.

REJECTION CHECKBOXES — read the BODY; if ONE is met WITH literal proof in the text, the vote is "hide":
1. HIDDEN SEAGOING/STCW: the body describes onboard rotations, vessel-based work, life on a platform, weeks at sea, or requires STCW / a seafarer medical certificate. (Hard block: the candidate has no STCW.)
2. TECHNICIAN/MAINTENANCE disguised as engineering: the day-to-day is maintenance, repair or manual field service, hands-on commissioning or a "monteur" profile, not design/analysis engineering. The candidate wants an engineer role, not a technician one.
3. WRONG FUNCTION under a clean title: under "Project/Cost Engineer" the body is commercial, tendering, cost control, procurement, back-office or Excel-first, with no real technical engineering.
4. FOREIGN DEGREE required in the body: it affirmatively asks for a degree the candidate doesn't have (Electrical/Mechanical/Civil/Aerospace/Chemical Engineering, Naval Architect, architect, energy…), or "chartered/PE/colegiado", or "background in [foreign field] essential". Two-doors rule: the ROLE must be in their field. NUANCE (2026-07-27, real cases #664 and #705): a degree requirement that the offer ITSELF opens up — "of vergelijkbare technische opleiding", "of een gelijkaardige technische richting", "oder einem vergleichbaren Fachgebiet", "or equivalent experience", "o titulación equivalente", "or a related field" — is NOT a closed door and must NOT trigger this. The deterministic filter already keeps those, and the two offers above were ones the candidate APPLIED to. Only an exclusive, unescaped requirement counts.
5. SENIORITY in prose: it asks to lead a team, manage projects autonomously, mentor juniors, or "5+ años" written in a way the years filter didn't catch. The candidate neither wants nor can do leadership. WATCH THE YEAR RANGES: "0-3 años" / "0 tot 3 jaar" / "2-5 años" count by their LOW END — the candidate (~1 year) FITS if the minimum is ≤2; do NOT trigger this checkbox on the high number of a range (a "0-3 años" is exactly their bracket, not a barrier).
6. INTERNSHIP/THESIS/WORKING-STUDENT: the body reveals an internship, a final-year project/thesis, mandatory university enrollment or Werkstudent, even if the title is clean.
7. MANDATORY LANGUAGE the candidate does not speak: the body affirmatively REQUIRES NL/FR/DE ("fluent in German", "Deutschkenntnisse erforderlich", "talen: Nederlands", "daily standups in Dutch", "the client base is francophone" as a requirement). NUANCE (important): the language the offer is WRITTEN in does NOT rule it out; silence, "valorable/plus/von Vorteil" or a NEGATED requirement ("no German required", "kein Deutsch erforderlich") = do NOT trigger this checkbox.
8. VETO by the candidate's rejections: under a cross-cutting title (e.g. "Automation") the body reveals the real work is AI/ML, robotics, cybersecurity/SOC, RPA/process-optimization, HVAC ("instalación de aires"), lab work, pure software (DevOps/QA/frontend/backend/full-stack/developer) or "Data Analyst" without a GIS/marine angle. The candidate rejected all of them.

EDGE (do NOT reject; flag the gap and vote "show" unless it is clearly the central, indispensable axis): a HARD SKILL that the candidate only has at coursework level and that the body asks for as "essential and demonstrable" (mastery of Tekla, expert AutoCAD/SolidWorks/Abaqus, PLC in production, demonstrable SCADA, a certification or a proprietary software). Mention it in the reason; leave the final decision to the ranking.

DISCIPLINE RULES:
- Every "hide" reason MUST quote in quotation marks the specific phrase from the body that triggers it and indicate the checkbox number (1-8). Without a literal quote, there is no "hide".
- Absence of information is NOT proof. If the body is silent, vote "show".
- Do NOT penalize the SECTOR: a role in their field (controls/automation/instrumentation) in a non-marine sector (data-center, construction) IS acceptable; only the wrong degree/role matters.
- Reason BEFORE labeling: first the reason, then the vote.
- "confidence" (0-1) = how explicit and unambiguous the proof is (high only with a clear, literal phrase); it is a triage signal, NOT a calibrated probability.

Return ONLY a JSON object with the keys reason, vote and confidence, with no additional text. Write the reason in English.`;

// ➤ ── THE UGLY (The Realist) ───────────────────────────────────────────────
// ➤ Neutral judge: reads the BODY to understand the real day-to-day and votes on
// ➤ balance (energizes vs drains, real function vs commercial). Breaks ties without bias.
const UGLY_PROMPT = `You are THE UGLY, one of the three judges of Argus's Council. Your role is the NEUTRAL REALIST: you neither defend the offer nor accuse it. You read the BODY to understand WHAT the job really is day-to-day and you decide, on balance, whether it's WORTH it for the candidate to be shown it. You run in shadow: your vote does not decide yet.

You receive the TITLE and the BODY of an offer. Judge it on its own, in absolute terms — never compare it with others.

THE CANDIDATE'S PROFILE (defines what "fitting" is): base every judgment on the candidate's real profile — read it yourself from cv.md and config/profile.yml in the working directory (degree, years of experience, tools, languages, nationality and certificates such as STCW). Do NOT assume any personal detail not written there. The marine defaults below are examples of the KIND of fit to weigh:
- Geography: priority ES/Barcelona/EU-remote > NL/BE > Norway > rest of EU. UK and Portugal out.
- Fields the candidate can work in: marine/offshore/mooring/offshore-structural; automation/instrumentation/control (PLC/SCADA — cross-cutting, NOT a foreign degree); survey/metocean/hydrographic; GIS/marine-data; energy systems; aquaculture and adjacent marine environmental impact. An unknown SECTOR is OK if the ROLE is in the candidate's field (e.g. controls in a data-center = automation, ACCEPT).

HARD BLOCKS (if the title or the body confirms it → hide with high confidence):
- Door 1 (foreign degree): the title IS a profession with a degree the candidate doesn't have — electrical, mechanical/mechatronic, civil, aerospace, chemical, naval architect, energy as a degree, legal, teaching, medicine, accounting, pure software/IT, manual trades (electrician, welder, mechanic, technician/monteur). Out at any level. Also if the BODY requires that degree ("degree in Electrical Engineering required", "background in power electronics essential"). NUANCE (2026-07-27, real cases #664 and #705): a degree requirement that the offer ITSELF opens up — "of vergelijkbare technische opleiding", "of een gelijkaardige technische richting", "oder einem vergleichbaren Fachgebiet", "or equivalent experience", "o titulación equivalente", "or a related field" — is NOT a closed door and must NOT trigger this. The deterministic filter already keeps those, and the two offers above were ones the candidate APPLIED to. Only an exclusive, unescaped requirement counts.
- Door 2 (years): it affirmatively asks for >2 years. The little the candidate has counts. RANGES: if the offer gives a year range ("0-3 años", "0 tot 3 jaar", "2-5 años"), the LOW END counts — the candidate (~1 year) FITS any range whose minimum is ≤2, so it is NOT a barrier; it only triggers if the required minimum exceeds 2. A "0-3 años" is exactly their bracket (junior/starter).
- STCW / seagoing: onboard rotations, vessel-based, seafarer medical certificate, living on a platform.
- REQUIRED LANGUAGE the candidate does not speak: NL/FR/DE affirmatively required ("fluent in German", "talen: Nederlands", "daily standups in Dutch", "reporting to a German-speaking team" when the language is indispensable). NUANCE (2026-07-18): the offer being WRITTEN in another language does NOT rule it out; "valorable/plus/von Vorteil", silence or a negated requirement ("no German required", "kein Deutsch erforderlich") = stays.
- Seniority: senior/lead/principal/director/manager/head/chief/coordinator/leader, or the body describes leading a team / managing projects autonomously / mentoring even if the title is junior.
- Intern/becario/working-student/trainee/tesis/TFG, or it requires university enrollment.
- Vetoes from the owner's real rejections: AI, robotics, cybersecurity/SOC, "Data Analyst/Analista" without a GIS/marine angle, RPA/process optimization, HVAC, lab work, DevOps/QA/test/frontend/backend/full-stack.

BRIEF RUBRIC (read it in the BODY, as a gradient, not point-by-point):
1. REAL FUNCTION: real technical engineering (design, analysis, simulation, calculation, fieldwork, data) or commercial/tendering/cost/Excel-first/back-office/documentation/QA disguised as "engineer"? The wrong function subtracts even if the title is clean (real case: Cost Engineer = 2.8).
2. ENERGIZES vs DRAINS: hands-on technical work, field/offshore, data and simulation, building things energize; pure paperwork, cold sales, static office admin, reporting/QA drain. A 4/5 that drains is worth less than a 3.5/5 that energizes.
3. FIELD AND TOOLS: is the domain theirs? Is there an indispensable, demonstrable tool they only have at coursework level (SCADA/Tekla/Abaqus/PLC in production, proprietary certification)? That lowers to the 2.5-3.0 bracket (mention the gap), it does not reject.
4. GEMS: if the body is pure OrcaFlex/mooring/DNV-BV/floating, it's a high fit even if the title is bland ("Graduate/Field/Analysis Engineer") → raise it. Same with aquaculture/EIA (environmental impact, oxygenation, water quality) that match the candidate's thesis and micro-credential.

GLOBAL JUDGMENT: after the rubric, make a single honest "gut-call" — on balance, is it worth it for the candidate to see this offer? Scale: net fit ≥3/5 → show; <2.5/5 → hide; 2.5-3 → show only if the day-to-day energizes, flagging the gap. Without a hard block, lean on the real balance; you have no a priori bias (neither in favor like The Good nor against like The Bad).

OUTPUT: first reason the why (quote the specific phrase from the body that tips the balance and say whether it energizes or drains and what the real function is), then decide. Return ONLY this JSON, with no text around it:
{"vote":"show"|"hide","reason":"1-2 sentences in English; quote the phrase from the body and name energizes/drains + real function","confidence":0.0-1.0}
confidence = how clear the balance is (high in clear-cut cases, ~0.5 in the 2.5-3.0 bracket). Treat it as a triage signal, not an exact probability. Never invent what is not in the text; if the body doesn't give enough data, say so in reason and lower the confidence.`;

// ➤ The list of the 3 judges. Each one carries:
// ➤   key   = short name for the log (good/bad/ugly)
// ➤   name  = human name
// ➤   model = default AI model (haiku is cheaper; sonnet, sharper)
// ➤   prompt= its full instructions (above)
// ➤ Prompt precedence: your profile's search.judge_prompts.{good,bad,ugly} if
// ➤ set, otherwise the marine defaults above (so nothing changes for the user).
const _JP = searchProfile.judge_prompts || {};

// ➤ THE PROFILE, IN THE JUDGE'S OWN WORDS (audit 2026-07-25). The default prompts
// ➤ below carry a marine example, so after a complete /start a non-marine user
// ➤ still got judges reasoning about mooring and STCW. This block is appended to
// ➤ every prompt and states, from config/profile.yml, what THIS candidate is —
// ➤ which overrides any example the prompt text may contain.
function profileBriefing() {
  const s = searchProfile || {};
  // ➤ The config lists are REGEX fragments ("marin[eo]", "\briser"). A judge is
  // ➤ an LLM reading prose, so they are turned back into plain words: the
  // ➤ optional-letter groups keep their first option and the regex syntax goes.
  const readable = x => String(x && x.name ? x.name : x)
    .replace(/\[([^\]\/]+)\]/g, (m, chars) => chars[0])   // marin[eo] → marine
    .replace(/\\b|\\w\*?|\(\?:|[()|?*+^$]/g, '')
    .replace(/\\/g, '')
    .trim();
  const list = (v, max = 12) => (Array.isArray(v) && v.length)
    ? [...new Set(v.slice(0, max).map(readable).filter(Boolean))].join(', ')
    : null;
  const lines = [];
  if (Number.isFinite(s.max_years)) lines.push(`- Seniority: junior. An offer requiring more than ${s.max_years} year(s) of experience is a barrier.`);
  const fields = list(s.fields);
  if (fields) lines.push(`- Fields the candidate can legitimately claim: ${fields}.`);
  const titles = list(s.positive_titles);
  if (titles) lines.push(`- Roles being looked for: ${titles}.`);
  const degIn = list(s.degrees_ok);
  if (degIn) lines.push(`- Degree areas the candidate HAS: ${degIn}.`);
  const degOut = list(s.degrees_excluded);
  if (degOut) lines.push(`- Degrees the candidate does NOT have (a hard requirement for one is a barrier): ${degOut}.`);
  const langs = list(s.languages);
  if (langs) lines.push(`- Languages the candidate works in: ${langs}. A different language REQUIRED by the body is a barrier.`);
  const countries = list(s.countries);
  if (countries) lines.push(`- Places that work: ${countries}${s.home_city ? ` (home city: ${s.home_city})` : ''}.`);
  if (!lines.length) return '';
  return `\n\n═══ THIS CANDIDATE (from config/profile.yml — it OVERRIDES any example above) ═══\n${lines.join('\n')}\n`;
}
const _BRIEF = profileBriefing();
export const JUDGES = [
  { key: 'good', name: 'The Good — The Defender', model: 'haiku', prompt: (_JP.good || GOOD_PROMPT) + _BRIEF },
  { key: 'bad', name: 'The Bad — The Prosecutor', model: 'sonnet', prompt: (_JP.bad || BAD_PROMPT) + _BRIEF },
  { key: 'ugly', name: 'The Ugly — The Realist', model: 'sonnet', prompt: (_JP.ugly || UGLY_PROMPT) + _BRIEF },
];

// ➤ ── Vote reader (parseVerdict) ───────────────────────────────────────
// ➤ Translates the vote to the only two internal labels: 'show' or 'hide'.
// ➤ Accepts English (show/hide) and Spanish (mostrar/ocultar); if it recognizes
// ➤ nothing, it returns null (and that judge does NOT count in the 2-of-3 vote).
function normVote(raw) {
  const s = String(raw || '').toLowerCase();
  if (/\b(show|mostrar|muestra|keep|mostrarse)\b/.test(s)) return 'show';
  if (/\b(hide|ocultar|oculta|descartar|descarta|drop)\b/.test(s)) return 'hide';
  return null;
}

// ➤ Pulls a number between 0 and 1 out of anything (clamps if it goes out of range).
function normConfidence(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n > 1 && n <= 100 ? n / 100 : 1; // ➤ tolerates "80" as 0.80
  return n;
}

// ➤ Interprets a judge's RAW reply and returns {vote, reason, confidence}.
// ➤ It is deliberately tolerant: the judge may return perfect JSON, JSON
// ➤ embedded in more text, or even just the loose word "mostrar". If there is
// ➤ no readable vote → {vote:null, ...} (honest failure, never breaks).
export function parseVerdict(text) {
  const src = String(text || '');
  // ➤ 1st attempt: find the first {...} block and read it as JSON.
  const m = src.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      // ➤ "verdict" added 2026-07-25 (audit): a judge answering with that key
      // ➤ had its perfectly readable vote thrown away.
      const voteRaw = j.vote ?? j.voto ?? j.decision ?? j.veredicto ?? j.verdict;
      const vote = normVote(voteRaw);
      const reason = String(j.reason ?? j.razon ?? j['razón'] ?? '').trim();
      const confidence = vote ? normConfidence(j.confidence ?? j.confianza) : 0;
      if (vote) return { vote, reason, confidence };
      // ➤ Valid JSON but no recognizable vote → falls through to plan B with the text.
      return { vote: null, reason: reason || src.trim().slice(0, 300), confidence: 0 };
    } catch { /* Broken JSON: try plan B */ }
  }
  // ➤ 2nd attempt (plan B): there was no usable JSON. Scan for the vote word
  // ➤ directly in the text and use the whole text as the reason.
  // ➤ FIXED 2026-07-25 (audit): this used to scan the WHOLE text for the vote
  // ➤ word, so a judge that QUOTES the offer — exactly what we ask it to do —
  // ➤ flipped its own verdict: quoting produces unescaped quotes (invalid JSON)
  // ➤ and the loose word "show" inside a HIDE reason won. Now we read the vote
  // ➤ KEY even out of broken JSON, and if BOTH words appear with no key we
  // ➤ admit we cannot tell instead of guessing.
  const keyed = src.match(/["']?(?:vote|voto|decision|veredicto|verdict)["']?\s*:\s*["']?\s*([a-zá-ú]+)/i);
  let vote = keyed ? normVote(keyed[1]) : null;
  if (!vote && !keyed) {
    const saysShow = /\b(?:show|mostrar)\b/i.test(src);
    const saysHide = /\b(?:hide|ocultar)\b/i.test(src);
    vote = (saysShow && saysHide) ? null : normVote(src);   // ambiguous → honest null
  }
  const conf = (() => { const c = src.match(/(?:confidence|confianza)[^0-9]*([01](?:\.\d+)?|0?\.\d+)/i); return c ? normConfidence(c[1]) : 0; })();
  return { vote, reason: src.trim().slice(0, 300), confidence: vote ? conf : 0 };
}
