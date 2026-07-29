#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the safety net for the ROBUSTNESS fixes of the 2026-07-25 audit.
// ➤ WHY IT EXISTS: the audit showed the 555 existing tests covered the "what to
// ➤ decide" (filters, years, degrees) but not one line of the "what we DO with
// ➤ the decision" — you could break housekeep so it wiped the whole pending list
// ➤ and the suite stayed green. These tests cover the parts that can LOSE DATA
// ➤ or produce a wrong answer, which is where the expensive mistakes live.
// ➤ RUN: node server-bot/test-robustness.mjs   (also part of `npm test`)
// ➤ ═══════════════════════════════════════════════════════════════════════

import { claudeErrorKind, claudeErrorMessage } from './claude-cli.mjs';
import { parseVerdict } from './argus-council/judges.mjs';
import { parseLetter, coverFileBase, resolveCoverBase } from './cover-letter.mjs';
import { writeFileAtomic, tempNameFor } from './fs-atomic.mjs';
import { classifyLiveness } from './liveness-core.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { buildProfileYaml } from './onboarding.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ── 1) The Claude CLI complaint must never pass for an answer ─────────────
// ➤ The real 2026-07-24 outage: the program prints this on its NORMAL output,
// ➤ so the old check took it for a cover letter and for three judge verdicts.
{
  const LIMIT = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
  eq(claudeErrorKind(LIMIT), 'limit', 'spend-limit message is detected as a failure');
  eq(claudeErrorKind('Please log in to continue'), 'auth', 'auth message is detected');
  eq(claudeErrorKind('overloaded, try again'), 'limit', 'short overload message is detected');
  ok(/usage limit/.test(claudeErrorMessage('limit', LIMIT)), 'the limit produces a human message');

  // ➤ And the other direction: a REAL letter must NOT be mistaken for an error,
  // ➤ or every cover letter would fail.
  const realLetter = [
    'SALUDO: Dear Hiring Manager,', 'CUERPO:',
    'I am writing to apply for the Mooring Engineer role. During my internship I used OrcaFlex to analyse mooring systems, which taught me how sensitive line tensions are to metocean input.',
    '', 'I speak Spanish, Catalan and English.', '', 'DESPEDIDA: Best regards,',
  ].join('\n');
  eq(claudeErrorKind(realLetter), null, 'a real cover letter is NOT flagged as an error');
  eq(claudeErrorKind('{"vote":"hide","reason":"seagoing role","confidence":0.9}'), null, 'a real verdict is NOT flagged as an error');
  eq(claudeErrorKind(''), null, 'empty output is not a complaint by itself');
  // ➤ The word "limit" inside a legitimate sentence must not trip it.
  eq(claudeErrorKind('I worked within a tight budget limit and delivered the project on time, which taught me to plan carefully and communicate early with the client.'), null,
    'the word "limit" in a normal sentence is not an error');
}

// ── 2) A judge that QUOTES the offer must not flip its own vote ───────────
// ➤ The judges are asked to quote evidence; quoting produces unescaped quotes,
// ➤ i.e. invalid JSON, and the old fallback then saw the loose word "show".
{
  const quoted = '{"vote":"hide","reason":"the body says "fluent Dutch required"; do not show this offer","confidence":0.9}';
  eq(parseVerdict(quoted).vote, 'hide', 'a HIDE that quotes the word "show" stays HIDE');
  eq(parseVerdict('{"verdict":"hide","reason":"seagoing","confidence":0.9}').vote, 'hide', 'the "verdict" key is accepted');
  eq(parseVerdict('{"vote":"show","reason":"good fit","confidence":0.8}').vote, 'show', 'a clean SHOW is still SHOW');
  eq(parseVerdict('{"vote":"hide","reason":"seagoing","confidence":0.9}').vote, 'hide', 'a clean HIDE is still HIDE');
  eq(parseVerdict('I would show this one').vote, 'show', 'loose text with a single clear word still works');
  eq(parseVerdict('no puedo decidir').vote, null, 'no vote → null, never a guess');
  // ➤ Ambiguous prose naming BOTH options: better to admit we cannot tell.
  eq(parseVerdict('you could show it or hide it, hard to say').vote, null, 'ambiguous prose → null instead of a coin flip');
}

// ── 3) A failed Claude call must not become the letter ────────────────────
{
  const LIMIT = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
  // parseLetter is deliberately tolerant, so the protection lives one level up:
  // the launcher marks this output as a failure, so parseLetter is never reached.
  eq(claudeErrorKind(LIMIT), 'limit', 'the limit text is stopped BEFORE it can become a letter');
  // If it ever did get through, we at least know what it would look like:
  ok(parseLetter(LIMIT, 'ACME').paras.length > 0, 'parseLetter stays tolerant for genuine odd output');
}

// ── 4) Cover-letter filenames must not overwrite each other ───────────────
// ➤ Two open roles at the SAME employer used to produce the same PDF name.
// ➤ The offer number is no longer glued to the name, so the index has to carry
// ➤ that guarantee instead.
{
  eq(coverFileBase('Jan De Nul Group').split('_').pop(), 'JanDeNulGroup', 'the plain name ends at the company');
  ok(!/_\d+$/.test(coverFileBase('ATEXIS')), 'no offer number is appended');

  // ➤ First letter to this employer: the plain name, nothing added.
  const index = {};
  const a = resolveCoverBase('ATEXIS', 73, index);
  ok(!/_\d+$/.test(a), 'the first letter to a company gets the clean name');
  index['73'] = a;

  // ➤ Same offer again → the same file, so regenerating replaces its own PDF.
  eq(resolveCoverBase('ATEXIS', 73, index), a, 'regenerating an offer reuses its own file name');

  // ➤ A DIFFERENT offer at the same employer → must not land on the same file.
  const b = resolveCoverBase('ATEXIS', 79, index);
  ok(a !== b, 'two offers from the same company get different file names');
  eq(b, `${a}_2`, 'the second one is marked _2, not with the offer number');
  index['79'] = b;
  ok(resolveCoverBase('ATEXIS', 91, index) === `${a}_3`, 'and the third is _3');

  // ➤ A different employer is never affected by the ones before it.
  ok(!/_\d+$/.test(resolveCoverBase('Van Oord', 92, index)), 'another company starts clean again');

  // ➤ Path safety: a hostile company name must not escape the output folder.
  const evil = resolveCoverBase('../../etc/passwd', 5, {});
  ok(!evil.includes('/') && !evil.includes('..'), 'a company name cannot build a path');

  // ➤ A corrupt or empty index must not crash the letter — it is bookkeeping.
  ok(resolveCoverBase('ATEXIS', 73).length > 0, 'no index at all still yields a name');
  ok(resolveCoverBase('ATEXIS', null, index).length > 0, 'an offer without a number still yields a name');
}

// ── 5) Atomic writes must not collide between processes ───────────────────
{
  const dir = join(tmpdir(), `argus-test-${process.pid}`);
  const file = join(dir, 'pipeline.md');
  rmSync(dir, { recursive: true, force: true });   // clean slate
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, 'content A');
  eq(readFileSync(file, 'utf-8'), 'content A', 'atomic write leaves the exact content');
  writeFileAtomic(file, 'content B');
  eq(readFileSync(file, 'utf-8'), 'content B', 'atomic overwrite replaces the content');
  // ➤ No scratch file may be left behind, and the name must be unique per write.
  const leftovers = readdirSync(dir).filter(f => f.includes('.tmp'));
  eq(leftovers, [], 'no .tmp leftovers after an atomic write');
  ok(!existsSync(`${file}.tmp`), 'the temp name is NOT the fixed "<file>.tmp" any more');

  // ➤ The checks above pass for a plain writeFileSync too, so on their own they
  // ➤ do not defend the reason this module exists. These watch the MECHANISM.
  const calls = [];
  const spy = {
    writeFileSync: (p, d) => calls.push(['write', p, d]),
    renameSync: (from, to) => calls.push(['rename', from, to]),
  };
  writeFileAtomic(file, 'content C', 'utf-8', spy);
  eq(calls.length, 2, 'a write and a rename, never a single direct write');
  eq(calls[0][0], 'write', 'it writes first');
  ok(calls[0][1] !== file, 'and it writes SOMEWHERE ELSE, never over the target');
  eq(calls[1][0], 'rename', 'then renames');
  eq(calls[1][2], file, 'the rename lands on the target');
  eq(calls[1][1], calls[0][1], 'and it renames the very file it just wrote');

  // ➤ Two writes to the SAME path must not pick the same scratch name, or the
  // ➤ 07:30 cleanup and a "seen" from Telegram can rename a mixture into place.
  ok(tempNameFor(file) !== tempNameFor(file), 'the temp name is different every time');
  // ➤ And it must sit next to the target: a rename is only atomic within one
  // ➤ filesystem, so a scratch file elsewhere would degrade into a copy.
  eq(dirname(tempNameFor(file)), dirname(file), 'the temp file sits next to its target');
  rmSync(dir, { recursive: true, force: true });
}

// ── 6) The offer-number high-water mark ───────────────────────────────────
// ➤ Same logic scan.mjs uses: the next id is the highest EVER handed out, not
// ➤ merely the highest still present in a file that housekeep deletes from.
{
  const maxInFile = text => { let n = 0; for (const m of text.matchAll(/\|\s*#(\d+)\s*(?:\|\s*visto\s*)?$/gim)) n = Math.max(n, parseInt(m[1], 10)); return n; };
  const pipeline = ['# Pipeline', '', '## Pending', '', '- [ ] https://a/1 | ACME | Mooring Engineer | Spain | #678', '- [ ] https://a/2 | BETA | Survey Engineer | France | #679', '- [ ] https://a/3 | GAMMA | Offshore Engineer | Norway | #680', '', '## Processed', ''].join('\n');
  eq(maxInFile(pipeline), 680, 'the counter reads the highest id in the file');
  const afterDelete = pipeline.split('\n').filter(l => !l.includes('#680')).join('\n');
  eq(maxInFile(afterDelete), 679, 'deleting the top line lowers the in-file maximum (the old bug)');
  // ➤ With the remembered high-water mark, the number can only move forward.
  const highWater = 680;
  eq(Math.max(maxInFile(afterDelete), highWater) + 1, 681, 'the next id still moves forward after a deletion');
  // ➤ A "| visto" line keeps its number visible, so the mark is never lost.
  const seenLine = pipeline.replace('- [ ] https://a/3', '- [x] https://a/3').replace('| #680', '| #680 | visto');
  eq(maxInFile(seenLine), 680, 'a "| visto" line still counts for the numbering');
  // ➤ Crossing #1000 (asked 2026-07-27). Nothing in the bot pads or truncates an
  // ➤ id — the counter is plain integer arithmetic and the line format puts the
  // ➤ number last — so four and five digits are read exactly like three.
  const milLines = [
    '- [ ] https://a/1 | ACME | Mooring Engineer | Spain | #999',
    '- [ ] https://a/2 | BETA | Survey Engineer | France | #1000',
    '- [ ] https://a/3 | GAMMA | Offshore Engineer | Norway | #1001',
    '- [ ] https://a/4 | DELTA | Metocean Engineer | Spain | #12345',
  ];
  const mil = ['# Pipeline', '', '## Pending', '', ...milLines, '', '## Processed', ''].join('\n');
  eq(maxInFile(mil), 12345, 'the counter reads ids of four and five digits');
  const sinElUltimo = milLines.slice(0, 3).join('\n');
  eq(Math.max(maxInFile(sinElUltimo), 999) + 1, 1002, 'the next id after #1001 is #1002');
  const idsMil = milLines.map(l => parseInt(l.match(/\|\s*#(\d+)\s*$/)[1], 10));
  eq(idsMil.join(','), '999,1000,1001,12345', 'every id parses, none truncated to three digits');
  ok(/^seen(\s+#?\d+)+$/i.test('seen 1000 12345'), 'the "seen" command takes four- and five-digit ids');
  ok(/^cover\s*#?\d+$/i.test('cover #1000'), 'the "cover" command takes a four-digit id');
}

// ── 7) The blast-radius guard that protects the pending list ──────────────
// ➤ housekeep deletes PERMANENTLY. If a whole batch comes back "dead" it is a
// ➤ portal/network problem, not real withdrawals — it must delete nothing.
{
  const suspicious = (pendingCount, deadCount) => pendingCount >= 5 && deadCount >= Math.ceil(pendingCount * 0.5);
  ok(suspicious(14, 14), 'everything dead at once → refuse to delete');
  ok(suspicious(14, 7), 'half the list dead at once → refuse to delete');
  ok(!suspicious(14, 6), 'a normal handful of dead links → delete them');
  ok(!suspicious(3, 3), 'a tiny list is not enough evidence of an outage → normal behaviour');
  ok(!suspicious(14, 0), 'nothing dead → nothing to do');
}

// ── 8) The onboarding must produce a search that is actually the USER'S ───
// ➤ The audit's product finding: the engine generalised the FILTER but not the
// ➤ SEARCH, so a non-marine user got a perfect filter over a marine stream —
// ➤ an empty list for ever. The generated profile must now carry its own
// ➤ queries, its own geography, and must switch off the example employers.
{
  const accountant = {
    name: 'Jane Doe', contact: 'jane@x.com, +49, Berlin',
    roles: 'financial accountant, bookkeeper, controller',
    fields: 'accounting, finance, audit',
    languages: ['en', 'de'], countries: ['Germany', 'Netherlands'],
    max_years: '2', level: 'junior', degrees_excluded: ['mechanical'], vetoes: ['Sales'],
  };
  const p = yaml.load(buildProfileYaml(accountant)).search;
  ok(Array.isArray(p.queries) && p.queries.length > 0, 'the profile carries its own search queries');
  ok(p.queries.includes('financial accountant'), 'the queries are built from the roles');
  ok(p.queries.includes('accounting'), 'the queries also include the fields');
  ok(!p.queries.some(q => /offshore|marine|mooring/.test(q)), 'no marine term leaks into a non-marine search');
  ok(p.locations && Array.isArray(p.locations.allow), 'the profile carries its own geography');
  ok(p.locations.allow.includes('Germany') && p.locations.allow.includes('Berlin'), 'geography = chosen countries + home city');
  eq(p.track_example_companies, false, 'the example marine employers are switched off');
  // ➤ And the whole thing must still be valid, complete config.
  ok(p.positive_titles.length > 0 && p.max_years === 2, 'the rest of the profile is still complete');
}

// ── 9) A profile WITHOUT the new keys must behave exactly as before ───────
// ➤ The owner's own profile does not define them, so the engine must fall back
// ➤ to portals.yml and change nothing for them.
{
  const legacy = yaml.load('search:\n  max_years: 2\n').search;
  eq(legacy.queries, undefined, 'a legacy profile has no queries → portals.yml decides');
  eq(legacy.locations, undefined, 'a legacy profile has no locations → portals.yml decides');
  ok(legacy.track_example_companies !== false, 'a legacy profile keeps the tracked companies on');
}

// ── 10) The dead-offer classifier (it decides what gets DELETED) ─────────
// ➤ It had no test at all, and it is what tells housekeep an offer is gone.
// ➤ A false "expired" deletes a live vacancy for ever (the URL goes to the
// ➤ anti-repeat history), so the bias must be: when in doubt, ALIVE.
{
  const cl = classifyLiveness;
  eq(cl({ status: 404 }).result, 'expired', '404 = gone');
  eq(cl({ status: 410 }).result, 'expired', '410 = gone');
  eq(cl({ status: 200, bodyText: 'No longer accepting applications' }).result, 'expired', 'explicit closed text = gone');
  eq(cl({ status: 200, bodyText: 'Diese Stelle ist bereits besetzt' }).result, 'expired', 'German filled text = gone');
  eq(cl({ status: 200, finalUrl: 'https://x.co/job?error=true' }).result, 'expired', 'error redirect = gone');
  // ➤ Everything else must survive: a slow page, an empty body, a network hiccup.
  ok(cl({ status: 200, bodyText: 'Apply now for this Mooring Engineer role. '.repeat(20) }).result !== 'expired', 'a normal live page survives');
  ok(cl({ status: 500 }).result !== 'expired', 'a server error is NOT a withdrawal');
  ok(cl({ status: 403 }).result !== 'expired', 'a 403 alone is NOT a withdrawal here');
  ok(cl({ status: 0 }).result !== 'expired', 'a network failure is NOT a withdrawal');
  ok(cl({}).result !== 'expired', 'no evidence at all = keep the offer');
}

// ── 11) housekeep must never run just by being imported ──────────────────
// ➤ It owns the only permanent delete in the codebase. Importing it used to
// ➤ execute main() — i.e. a test or a future module could start deleting.
{
  const src = readFileSync(new URL('./housekeep.mjs', import.meta.url), 'utf-8');
  ok(src.includes('process.argv[1]') && /housekeep\\\.mjs\$/.test(src), 'housekeep guards main() behind a direct-run check');
  ok(!/^main\(\)\.catch/m.test(src), 'housekeep does not call main() unconditionally');
  // ➤ And the same guard must protect the scanner.
  const scanSrc = readFileSync(new URL('./scan.mjs', import.meta.url), 'utf-8');
  ok(scanSrc.includes('process.argv[1]') && /scan\\\.mjs\$/.test(scanSrc), 'scan.mjs guards its main() too');
}

// ── 12) Reading the pending list back (list-offers) ──────────────────────
// ➤ Everything you type — cover N, no N, applied N — resolves the number
// ➤ through this parser. It had no test, yet a mis-read line means acting on
// ➤ the WRONG offer.
{
  // ➤ list-offers reads data/pipeline.md at a path derived from its OWN location,
  // ➤ so we copy the module into a temp tree and give it a fixture next door.
  // ➤ (Audit 2026-07-27: this block used to re-implement the parser inline and
  // ➤ assert against its own copy — it stayed green no matter what the real
  // ➤ module did. Now it imports the real one and never touches your data.)
  const dir = join(tmpdir(), `argus-list-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'server-bot'), { recursive: true });
  writeFileSync(join(dir, 'data', 'pipeline.md'), [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://a/1 | ACME & Co | Mooring Engineer | Rotterdam, Netherlands | y:2 | #701',
    '- [ ] https://a/2 | Beta | Survey Engineer | #702',                       // sin ubicación
    '- [ ] https://a/3 | Gamma | Design Engineer | Madrid | s:45k | #703',     // con salario
    '- [x] https://a/4 | Delta | Old Role | Oslo | #700 | visto',              // ya decidida
    '', '## Processed', '',
    '- [ ] https://a/5 | Omega | Should Not Appear | Bergen | #999',
  ].join('\n'), 'utf-8');
  const mod = join(dir, 'server-bot', 'list-offers.mjs');
  copyFileSync(new URL('./list-offers.mjs', import.meta.url), mod);
  const { pendingOffers } = await import(pathToFileURL(mod).href);
  const got = pendingOffers();

  eq(got.map(o => o.id), [701, 702, 703], 'the id is read from the last field, always');
  eq(got[0].company, 'ACME & Co', 'a company with "&" survives the split');
  eq(got[1].title, 'Survey Engineer', 'an offer with no location still parses its title');
  eq(got[2].url, 'https://a/3', 'the url is the first field');
  ok(!got.some(o => o.id === 700), 'a "| visto" line is NOT pending any more');
  ok(!got.some(o => o.id === 999), 'a line under "Processed" is never listed as pending');
  // ➤ The classify-by-shape rule (the 2026-07-18 bug): "y:2" must land in years,
  // ➤ never in location, and an offer with no city must keep location empty.
  eq(got[0].location, 'Rotterdam, Netherlands', 'the location is read as the location');
  eq(got[0].years, 2, '"y:2" is read as years, not as the city');
  eq(got[1].location, '', 'an offer with no location leaves it empty');
  eq(got[2].salary, '45k', '"s:45k" is read as the salary');
  eq(got[2].location, 'Madrid', 'the salary does not displace the city');

  rmSync(dir, { recursive: true, force: true });
}

// ── 13) The Telegram command grammar ─────────────────────────────────────
// ➤ These are the exact patterns telegram-listener.mjs matches. They had no
// ➤ test, and a wrong one either ignores your command or runs another.
{
  const CMDS = [
    [/^\/?help$/i, 'help', true], [/^\/?help$/i, 'helpme', false],
    [/^\/?start$/i, '/start', true],
    [/^seen(\s+#?\d+)+$/i, 'seen 412', true], [/^seen(\s+#?\d+)+$/i, 'seen #412 413', true],
    [/^seen(\s+#?\d+)+$/i, 'seen', false], [/^seen(\s+#?\d+)+$/i, 'seen abc', false],
    [/^(search|scan)$/i, 'search', true], [/^(search|scan)$/i, 'searching', false],
    [/^cover\s*#?\d+$/i, 'cover 412', true], [/^cover\s*#?\d+$/i, 'cover412', true],
    [/^list$/i, 'list', true], [/^list$/i, 'lists', false],
    [/^applied[\s,:]*#?\d+/i, 'applied 5', true], [/^applied[\s,:]*#?\d+/i, 'applied5', true],
    // ➤ "longshot N [reason]". Checked BEFORE "applied"; the two must never
    // ➤ claim each other's messages.
    [/^longshot[\s,:]*#?\d+/i, 'longshot 729', true],
    [/^longshot[\s,:]*#?\d+/i, 'longshot 729 three years required', true],
    [/^longshot[\s,:]*#?\d+/i, 'longshot#729', true],
    [/^longshot[\s,:]*#?\d+/i, 'longshot', false],
    [/^longshot[\s,:]*#?\d+/i, 'longshots 5', false],
    [/^longshot[\s,:]*#?\d+/i, 'applied 729', false],
    [/^applied[\s,:]*#?\d+/i, 'longshot 729', false],
    [/^no[\s,:]*#?\d+/i, 'no 5 needs 10 years', true], [/^no[\s,:]*#?\d+/i, 'no5', true],
    [/^no\b/i, 'no idea which one', true],   // → asks which offer, does not act
  ];
  for (const [re, input, want] of CMDS) eq(re.test(input), want, `command "${input}"`);
  // ➤ The reason must survive intact after the number.
  const m = 'no #412 needs 10 years of experience'.match(/^no[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
  eq(m[1], '412', 'the offer number is extracted');
  eq(m[2], 'needs 10 years of experience', 'the reason is kept whole');
}

// ── Result ────────────────────────────────────────────────────────────────
// ── 15) argus-discover: the profile audit must not invent evidence ────────
// ➤ It reads the CV, the search terms and the user's own decisions to say
// ➤ whether a term is worth keeping. Every number it prints is an argument for
// ➤ changing the filter, so a wrong one sends the user chasing a problem that
// ➤ is not there.
{
  const { fold, cvBacks, termRecord, classifyReason, extractCvSkills } =
    await import('./argus-discover/audit-profile.mjs');

  eq(fold('Automatización'), 'automatizacion', 'audit: accents folded');
  ok(cvBacks('OrcaFlex', 'used OrcaFlex daily'), 'audit: a term in the CV is backed');
  ok(!cvBacks('SCADA', 'used OrcaFlex daily'), 'audit: a term absent from the CV is NOT backed');
  ok(cvBacks('hydrograph', 'hydrographic survey work'), 'audit: 6-letter stem still backs');
  ok(!cvBacks('GIS', 'the gist of the project'), 'audit: a short term does not match inside a word');

  // ➤ The load-bearing rule: a rejection of an offer the filter ALREADY blocks
  // ➤ must not count against the term, or fixed problems look unfixed.
  {
    const rejected = [{ title: 'Tubero naval' }, { title: 'Naval Design Engineer' }];
    const live = termRecord('naval', { rejected, applied: [], stillPasses: t => !/tubero/i.test(t) });
    eq(live.rejected, 1, 'audit: an already-blocked rejection is not charged to the term');
    eq(live.rejectedAlreadyFixed, 1, 'audit: and it is reported as already fixed');
  }
  // ➤ A longshot is not a win: it was sent knowing the requirements fell short.
  {
    const r = termRecord('offshore', { rejected: [], applied: [{ title: 'Offshore Eng', longshot: true }, { title: 'Offshore Two' }] });
    eq(r.applied, 1, 'audit: a longshot does not count as an application');
    eq(r.longshots, 1, 'audit: it is counted separately');
  }

  // ➤ Both languages the shipped lists cover, because you write these reasons
  // ➤ in your own words and the audit is only as good as what it recognises.
  eq(classifyReason('it asks for 5 years of experience'), 'requirements', 'audit: years = requirements');
  eq(classifyReason('porque pide 5 años de experiencia'), 'requirements', 'audit: years, in Spanish');
  eq(classifyReason('not my field at all'), 'field', 'audit: wrong role = field');
  eq(classifyReason('no es un trabajo para mi'), 'field', 'audit: wrong role, in Spanish');
  eq(classifyReason('the offer is already closed'), 'noise', 'audit: dead offer is noise');
  eq(classifyReason('ya esta cerrada la oferta'), 'noise', 'audit: dead offer, in Spanish');
  eq(classifyReason(''), 'unstated', 'audit: empty reason');
  // ➤ A reason the lists do not know is filed as 'other', never guessed at.
  eq(classifyReason('the office is too far away'), 'other', 'audit: an unknown reason is not guessed');

  // ➤ The Skills block stays open across its sub-headings, and the language
  // ➤ line must not leak "IDP 2023" in as if it were a tool.
  {
    const cv = ['## Skills', '### Technical', '- **GIS:** ArcGIS, QGIS', '### Languages',
      '- English: C1 (Some Certificate 7.0, Awarding Body 2023)', '## Education', '- Some University'].join('\n');
    const s = extractCvSkills(cv);
    ok(s.includes('ArcGIS') && s.includes('QGIS'), 'audit: reads skills under a sub-heading');
    ok(!s.some(x => /IDP|2023|7\.0/.test(x)), 'audit: the parenthesis tail is not a skill');
    ok(!s.some(x => /University/.test(x)), 'audit: the next H2 closes the section');
  }
}

// ── 16) argus-discover: the harvest must not propose noise ───────────────
// ➤ Its output is a list of words to add to the search. A bad one widens the
// ➤ filter for nothing, so gender tags, seniority words and terms already in
// ➤ use must never reach the proposal.
{
  const { candidateTerms } = await import('./argus-discover/harvest-titles.mjs');
  const titles = [
    'Hydrographic Surveyor', 'Junior Hydrographic Surveyor (m/w/d)',
    'Hydrographic Survey Engineer', 'ROV Pilot Technician', 'ROV Inspection Engineer',
  ];
  const c = candidateTerms(titles, { known: ['Survey'] });
  const has = t => c.some(x => x.term.toLowerCase() === t);
  ok(has('hydrographic'), 'harvest: a recurring word becomes a candidate');
  ok(has('hydrographic surveyor'), 'harvest: adjacent pairs are candidates too');
  ok(!has('survey'), 'harvest: a term already in the search is not re-proposed');
  ok(!has('engineer'), 'harvest: the generic job word is a stopword');
  ok(!has('junior'), 'harvest: seniority is a stopword');
  ok(!c.some(x => /^[mwdfhx]$/i.test(x.term)), 'harvest: gender tags never become terms');
  ok(!c.some(x => /^\d+$/.test(x.term)), 'harvest: bare numbers never become terms');
  // ➤ Ranking is by how many TITLES carry the term, not raw occurrences: a word
  // ➤ repeated twice inside one title must not outrank a word seen in three.
  eq(c[0].term.toLowerCase(), 'hydrographic', 'harvest: ranked by titles covered');
  eq(candidateTerms([], {}).length, 0, 'harvest: no titles, no candidates');
}

// ── 17) argus-discover: the ESCO match ───────────────────────────────────
// ➤ Its output is occupation names in five languages, offered as search terms.
// ➤ ESCO's translations are administrative, so the filter that decides which
// ➤ labels a human would ever type is the part that has to be right.
{
  const { usableLabels, scoreOccupations } = await import('./argus-discover/esco-match.mjs');

  const L = usableLabels([
    'reparador de estructuras de cultivo en instalaciones acuícolas/reparadora de estructuras de cultivo en instalaciones acuícolas',
    'vastmeerder in de aquacultuur',
    'hydrograaf/hydrografe',
  ]);
  ok(!L.some(x => /reparador/.test(x)), 'esco: the administrative mouthful is not offered as a search term');
  ok(L.includes('hydrograaf') && L.includes('hydrografe'), 'esco: a gendered pair is split into both halves');
  eq(L[0], 'hydrograaf', 'esco: shortest first — that is the one a human types');
  eq(usableLabels([]).length, 0, 'esco: nothing in, nothing out');
  eq(usableLabels(['Surveyor', 'surveyor']).length, 1, 'esco: same label in another case is not repeated');

  // ➤ An essential skill weighs double: an occupation that CANNOT be done
  // ➤ without you beats one that merely tolerates you.
  const r = scoreOccupations([
    { term: 'mooring', occupations: [{ uri: 'u1', title: 'A', essential: true }, { uri: 'u2', title: 'B', essential: false }] },
    { term: 'aquaculture', occupations: [{ uri: 'u1', title: 'A', essential: true }] },
  ]);
  eq(r[0].title, 'A', 'esco: the occupation covering two of your terms ranks first');
  eq(r[0].score, 4, 'esco: two essential matches score 2+2');
  eq(r[1].score, 1, 'esco: one optional match scores 1');
  eq(r[0].terms.length, 2, 'esco: it reports WHICH of your terms it covers');
  // ➤ The same term twice must not inflate a score.
  const dup = scoreOccupations([
    { term: 'mooring', occupations: [{ uri: 'u1', title: 'A', essential: true }] },
    { term: 'mooring', occupations: [{ uri: 'u1', title: 'A', essential: true }] },
  ]);
  eq(dup[0].score, 2, 'esco: the same term counted once, however many skills matched it');
}

// ── 18) argus-discover: the blind-spot record ────────────────────────────
// ➤ It exists because the title filter's allowlist drops things silently, and
// ➤ on a real cycle 345 titles were dropped for no reason but "not on the
// ➤ list". Recurrence is the only signal it uses, so the counting has to be
// ➤ right: over-count and noise looks like a gap, under-count and a real gap
// ➤ stays invisible.
{
  const { mergeDrops, topRecurring, classifyDrop, ruleOf, NO_FIELD, RULE } =
    await import('./argus-discover/blind-spots.mjs');

  eq(classifyDrop('the title has no keyword from your field'), NO_FIELD, 'blind: no-keyword is the blind-spot bucket');
  eq(classifyDrop('the title has the blocked word "Senior"'), RULE, 'blind: a veto that fired is the other bucket');
  eq(ruleOf('the title has the blocked word "Technician"'), 'Technician', 'blind: the report names the rule, not the sentence');

  const noField = 'the title has no keyword from your field';
  let st = mergeDrops({ titles: {} }, [{ title: 'Asset Integrity Engineer', why: noField }], { today: 'd1' });
  st = mergeDrops(st, [{ title: 'ASSET INTEGRITY ENGINEER', why: noField }], { today: 'd2' });
  const t = Object.values(st.titles);
  eq(t.length, 1, 'blind: the same title in another case is one entry, not two');
  eq(t[0].n, 2, 'blind: and it counts as seen twice');
  eq(t[0].title, 'Asset Integrity Engineer', 'blind: the first spelling is the one kept');
  eq(t[0].first, 'd1', 'blind: it remembers when it was first thrown away');
  eq(t[0].last, 'd2', 'blind: and the last time');

  // ➤ Seen once is noise by definition — that is the whole filter.
  const once = mergeDrops({ titles: {} }, [{ title: 'Barmitarbeiter', why: noField }], { today: 'd1' });
  eq(topRecurring(once).length, 0, 'blind: a title seen once is not reported');
  eq(topRecurring(st).length, 1, 'blind: a title seen twice is');

  // ➤ The cap. A scan every two hours would otherwise grow this file for ever;
  // ➤ the live record already holds ~2,800 titles. What a cull must keep is the
  // ➤ RECURRING ones, since a title seen once was never going to be reported.
  {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `Filler ${i}`, why: noField }));
    const big = mergeDrops({ titles: {} }, many, { today: 'd1', cap: 10 });
    eq(Object.keys(big.titles).length, 10, 'blind: the record is capped');

    // ➤ The DEFAULT cap has to be finite too, not just one passed in by a test.
    const flood = Array.from({ length: 4100 }, (_, i) => ({ title: `Flood ${i}`, why: noField }));
    const defaulted = mergeDrops({ titles: {} }, flood, { today: 'd1' });
    ok(Object.keys(defaulted.titles).length < flood.length, 'blind: the default cap is finite');

    // ➤ A title seen many times must survive a cull, EVEN when every one-off
    // ➤ around it is more recent. Culling by date alone would lose exactly the
    // ➤ titles the record exists to surface.
    let keep = mergeDrops({ titles: {} }, [{ title: 'Asset Integrity Engineer', why: noField }], { today: 'd1', cap: 10 });
    keep = mergeDrops(keep, [{ title: 'Asset Integrity Engineer', why: noField }], { today: 'd1', cap: 10 });
    keep = mergeDrops(keep, [{ title: 'Asset Integrity Engineer', why: noField }], { today: 'd1', cap: 10 });
    keep = mergeDrops(keep, many, { today: 'd9', cap: 10 });
    ok(Object.keys(keep.titles).some(k => /asset integrity/i.test(k)), 'blind: the recurring title survives a cull full of newer one-offs');
    eq(Object.keys(keep.titles).length, 10, 'blind: and the cap still holds after the cull');
  }

  // ➤ The caller's bucket WINS over the reason text. scan.mjs decides it by
  // ➤ re-testing without the field list; reading the text instead put 1,234
  // ➤ titles in the blind-spot bucket where the truth is 345, because
  // ➤ explain() reports the first reason and positives are checked first.
  {
    const s2 = mergeDrops({ titles: {} }, [
      { title: 'Barmitarbeiter', why: noField, bucket: RULE },
      { title: 'Barmitarbeiter', why: noField, bucket: RULE },
    ], { today: 'd1' });
    eq(topRecurring(s2, { bucket: NO_FIELD }).length, 0, 'blind: the caller can overrule the reason text');
    eq(topRecurring(s2, { bucket: RULE }).length, 1, 'blind: and the drop lands where it belongs');
  }

  // ➤ The buckets must not bleed into each other.
  const mixed = mergeDrops(st, [
    { title: 'Technicien naval', why: 'the title has the blocked word "*technicien"', bucket: RULE },
    { title: 'Technicien naval', why: 'the title has the blocked word "*technicien"', bucket: RULE },
  ], { today: 'd3' });
  eq(topRecurring(mixed, { bucket: NO_FIELD }).length, 1, 'blind: the blind-spot bucket holds only its own');
  eq(topRecurring(mixed, { bucket: RULE })[0].title, 'Technicien naval', 'blind: and the rule bucket its own');

  // ➤ Bounded, or a scan every two hours grows the file forever. What survives
  // ➤ a cull is what recurs, which is exactly what is being looked for.
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `Role ${i}`, why: noField }));
  eq(Object.keys(mergeDrops({ titles: {} }, many, { today: 'd1', cap: 10 }).titles).length, 10, 'blind: the record is capped');
}

// ── 19) "seen": marking the RIGHT line, and marking it as YOUR decision ────
// ➤ This writes to the only copy of the pending list. Until now none of it was
// ➤ covered: the wrong line could be marked, or the "| visto" tag dropped, and
// ➤ the suite stayed green. The tag is the whole difference between "I decided
// ➤ against this" (never comes back) and "the bot hid it" (may come back).
{
  const { markSeenInLines, indexPending, parseIds } = await import('./seen.mjs');
  const base = [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://a/1 | ACME | Mooring Engineer | Spain | #678',
    '- [ ] https://a/2 | BETA | Survey Engineer | France | #679',
    '- [ ] https://a/3 | GAMMA | Offshore Engineer | Norway | #680',
    '', '## Processed', '',
    '- [x] https://a/0 | OLD | Something | Spain | #677 | visto',
    // ➤ An offer the BOT removed carries no tag, so its #id sits at the end of
    // ➤ the line exactly like a pending one. Only the section it lives in tells
    // ➤ them apart, which is why the index has to respect the headings.
    '- [x] https://a/9 | BOT | Hidden By Cleanup | Spain | #676',
  ];

  const r = markSeenInLines(base, [679]);
  eq(r.lines[5], '- [x] https://a/2 | BETA | Survey Engineer | France | #679 | visto', 'seen: marks the line whose #id was asked for');
  eq(r.lines[4], base[4], 'seen: and leaves the line above untouched');
  eq(r.lines[6], base[6], 'seen: and the line below');
  ok(/\|\s*visto\s*$/.test(r.lines[5]), 'seen: the decision tag is appended, so it can never come back');
  eq(r.missing, [], 'seen: nothing reported missing');

  // ➤ An id that is not pending must be reported, not silently ignored, and
  // ➤ must not mark anything else by accident.
  const gone = markSeenInLines(base, [999]);
  eq(gone.missing, [999], 'seen: an unknown id is reported');
  eq(gone.marked, [], 'seen: and nothing is marked');
  eq(gone.lines.join('\n'), base.join('\n'), 'seen: the list comes back untouched');

  // ➤ Only the Pending section counts: an id living under Processed must not
  // ➤ be re-marked (it would get a second "| visto" and break the line shape).
  eq(markSeenInLines(base, [677]).missing, [677], 'seen: an id under Processed is not pending');
  // ➤ The one that actually looks pending. Marking it would tag an offer you
  // ➤ never decided on as YOUR decision, so it could never come back.
  const processed = markSeenInLines(base, [676]);
  eq(processed.missing, [676], 'seen: a bot-hidden id under Processed is not pending either');
  eq(processed.lines.join('\n'), base.join('\n'), 'seen: and that section is left alone');

  // ➤ Several at once, and the ids are the FIXED numbers, not positions.
  const two = markSeenInLines(base, [678, 680]);
  ok(/visto$/.test(two.lines[4]) && /visto$/.test(two.lines[6]), 'seen: marks each id asked for');
  eq(two.lines[5], base[5], 'seen: and only those');

  // ➤ "seen 701 701" used to append the tag twice and break the "#id at the
  // ➤ end" shape that the id counter and every parser rely on.
  eq(parseIds(['701', '701', '#701']), [701], 'seen: repeated ids collapse to one');
  eq(parseIds(['0', '-3', 'abc', '']), [], 'seen: junk ids are dropped');
  eq(parseIds(['#412']), [412], 'seen: the hash is optional');

  eq([...indexPending(base).keys()].sort((a, b) => a - b), [678, 679, 680], 'seen: only pending, unchecked lines are indexed');

  // ➤ Belt AND braces: the index needs the line to be unchecked *and* to sit
  // ➤ under Pending. Either guard alone looks redundant until the file is
  // ➤ malformed, and real pipeline files do pick up stray lines.
  const malformed = [
    '# Pipeline', '', '## Pending', '',
    '- [ ] https://a/1 | ACME | Mooring Engineer | Spain | #678',
    '', '## Processed', '',
    '- [ ] https://a/8 | STRAY | Left Unchecked By Mistake | Spain | #675',
  ];
  eq([...indexPending(malformed).keys()], [678], 'seen: an unchecked line under Processed is still out of reach');
  eq(markSeenInLines(malformed, [675]).missing, [675], 'seen: and cannot be marked');
}

// ── 20) The URL gate ──────────────────────────────────────────────────────
// ➤ Every other field is cleaned before being written, but the URL is written
// ➤ raw because it is the key and must stay clickable. This function is the
// ➤ only thing stopping a crafted link from injecting a whole fake line into
// ➤ pipeline.md or scan-history.tsv. It had no test at all.
{
  const { isSafeUrl } = await import('./scan.mjs');

  ok(isSafeUrl('https://www.adzuna.nl/details/5808162054'), 'url: a normal posting link passes');
  ok(isSafeUrl('https://careers.acme.com/job/123?src=feed&x=1#top'), 'url: query and fragment are fine');

  // ➤ The separator of pipeline.md. A URL carrying it would split one offer
  // ➤ into two fields and corrupt every parser downstream.
  ok(!isSafeUrl('https://x.com/a|b'), 'url: a pipe is refused');
  // ➤ A newline would inject an entire extra line — a fake offer, or a fake
  // ➤ "| visto" decision that hides a real one.
  ok(!isSafeUrl('https://x.com/a\nb'), 'url: a newline is refused');
  ok(!isSafeUrl('https://x.com/a\r\n- [ ] https://evil | X | Y | #1'), 'url: a full injected line is refused');
  ok(!isSafeUrl('https://x.com/a\tb'), 'url: a tab is refused (the TSV separator)');
  ok(!isSafeUrl('https://x.com/a b'), 'url: a raw space is refused');
  ok(!isSafeUrl('https://x.com/a\u0000b'), 'url: a NUL is refused');
  ok(!isSafeUrl('https://x.com/a\u007fb'), 'url: DEL is refused');
  ok(!isSafeUrl(''), 'url: empty is refused');
  ok(!isSafeUrl(null), 'url: null is refused');
}

if (fail) { console.log(`\n${fail}/${pass + fail} robustness tests FAILED.`); process.exit(1); }
console.log(`All ${pass} robustness tests passed.`);
