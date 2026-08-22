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
import { writeFileAtomic, tempNameFor, withFileLock } from './fs-atomic.mjs';
import { classifyLiveness } from './liveness-core.mjs';
import { stripHtml } from './requirements.mjs';
import { looksLikeAnOutage } from './housekeep.mjs';
import { seenReply } from './telegram-listener.mjs';
import { buildCountryFilter, norm, buildTitleFilter, buildCompanyFilter, buildLocationFilter, parseGreenhouse, parseAshby, parseLever, greenhouseUrlWithContent, loadIdHighWater, capJobs, MAX_JOBS_PER_COMPANY } from './scan.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
// ➤ To launch real separate programs in the lock test below.
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { buildProfileYaml, pdfText } from './onboarding.mjs';

// ➤ Where this test file itself lives, so the lock test can launch standalone
// ➤ programs that import the real module rather than a copy of it.
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

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

  // ➤ The failure has to happen AFTER the scratch file exists — between the
  // ➤ write and the rename — or there is no orphan to leave and the test proves
  // ➤ nothing. That is also the real case: a process killed in that gap, or a
  // ➤ disk that fills up on the rename.
  writeFileSync(file, 'still here');
  const breakRename = {
    writeFileSync,
    renameSync: () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; },
    unlinkSync,
  };
  try { writeFileAtomic(file, 'new content', 'utf-8', breakRename); } catch { /* meant to fail */ }
  eq(readFileSync(file, 'utf-8'), 'still here', 'a failed write leaves the target untouched');
  eq(readdirSync(dir).filter(f => f.includes('.tmp')), [], 'and leaves no scratch file behind either');

  // ➤ Two writes to the SAME path must not pick the same scratch name, or the
  // ➤ 07:30 cleanup and a "seen" from Telegram can rename a mixture into place.
  ok(tempNameFor(file) !== tempNameFor(file), 'the temp name is different every time');
  // ➤ And it must sit next to the target: a rename is only atomic within one
  // ➤ filesystem, so a scratch file elsewhere would degrade into a copy.
  eq(dirname(tempNameFor(file)), dirname(file), 'the temp file sits next to its target');
  rmSync(dir, { recursive: true, force: true });
}

// ── 5b) The lock around read-decide-write ─────────────────────────────────
// ➤ The atomic write above only guarantees nobody sees HALF a file. It does
// ➤ nothing about the real danger: the scanner, the cleanup and a "seen" typed
// ➤ on Telegram all read the pending list, change their bit, and write it back.
// ➤ Measured before the lock existed: eight overlapping writers kept 200 lines
// ➤ out of 1600. These tests watch the MECHANISM, because a lock that quietly
// ➤ stopped locking would still pass every test about the file's contents.
{
  const dir = join(tmpdir(), `argus-lock-${process.pid}`);
  const file = join(dir, 'pipeline.md');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // ➤ It takes the lock, runs the work, and hands the result back.
  eq(withFileLock(file, () => 'done'), 'done', 'the lock returns what the work returned');
  ok(!existsSync(`${file}.lock`), 'and it releases the lock afterwards');

  // ➤ Released even when the work throws — otherwise one crash would block
  // ➤ every later scan for as long as the machine stayed up.
  try { withFileLock(file, () => { throw new Error('boom'); }); } catch { /* expected */ }
  ok(!existsSync(`${file}.lock`), 'a crash inside the work still releases the lock');

  // ➤ Taken BEFORE the work and released AFTER: the whole point is that the
  // ➤ read and the write happen inside it.
  const order = [];
  const spy = {
    mkdirSync: () => order.push('take'),
    rmdirSync: () => order.push('release'),
    statSync: () => ({ mtimeMs: Date.now() }),
  };
  withFileLock(file, () => order.push('work'), { io: spy });
  eq(order, ['take', 'work', 'release'], 'lock, work, unlock — in that order');

  // ➤ It really refuses when somebody else holds it: a second attempt while the
  // ➤ first is inside must not get in.
  let inner = 'not attempted';
  const said = [];
  withFileLock(file, () => {
    ok(existsSync(`${file}.lock`), 'while the work runs, the lock exists on disk');
    // ➤ Short timeout so the test does not wait for the real one.
    withFileLock(file, () => { inner = 'got in'; }, { timeoutMs: 60, log: m => said.push(m) });
  });
  eq(inner, 'got in', 'a blocked writer waits, then proceeds rather than dropping the work');
  // ➤ AND IT SAYS SO. Going ahead unlocked is deliberate, but in silence a lock
  // ➤ nobody can take degrades every write from every job with nothing to show.
  ok(said.some(m => /without it/.test(m)), 'and it says out loud that it ran unlocked');
  // ➤ The normal path stays quiet, or the log fills with a warning per write.
  const quiet = [];
  withFileLock(file, () => {}, { log: m => quiet.push(m) });
  eq(quiet.length, 0, 'while a lock taken normally says nothing at all');

  // ➤ A lock left behind by a job that was killed must not block the bot for
  // ➤ ever. One older than the timeout is treated as abandoned and cleared —
  // ➤ tested with an already-old lock, not a fresh one, or it proves nothing.
  mkdirSync(`${file}.lock`);
  const stale = Date.now() + 40;
  while (Date.now() < stale) { /* let the lock get old */ }
  let ranWithStale = false;
  withFileLock(file, () => { ranWithStale = true; }, { timeoutMs: 20 });
  ok(ranWithStale, 'a stale lock does not stop the job');
  ok(!existsSync(`${file}.lock`), 'the abandoned lock is cleared, not left behind');

  // ➤ A lock that can NEVER be taken (the folder does not exist, the disk is
  // ➤ read-only) must not stall the job for the whole timeout. It gives up at
  // ➤ once and lets the write report the real problem.
  const nowhere = join(dir, 'does', 'not', 'exist', 'pipeline.md');
  const t1 = Date.now();
  let ranAnyway = false;
  withFileLock(nowhere, () => { ranAnyway = true; }, { timeoutMs: 4000 });
  ok(ranAnyway, 'an impossible lock does not cancel the work');
  ok(Date.now() - t1 < 500, 'and it does not wait out the timeout for nothing');

  // ➤ THE REASON IT EXISTS: many read-decide-write cycles, nothing lost.
  // ➤ IN SEPARATE PROCESSES, deliberately. The first version of this test ran
  // ➤ eight "writers" inside this one process and passed with the lock REMOVED —
  // ➤ worthless, because a synchronous read-and-write inside a single Node
  // ➤ process cannot be interrupted anyway. The danger is a scan, a cleanup and
  // ➤ a "seen" as three separate programs, which is what this launches.
  writeFileSync(file, '');
  const WRITERS = 6, ROUNDS = 25;
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    `import { withFileLock, writeFileAtomic } from ${JSON.stringify(pathToFileURL(join(SELF_DIR, 'fs-atomic.mjs')).href)};`,
    `import { readFileSync } from 'fs';`,
    `const [file, who, rounds] = [process.argv[2], process.argv[3], +process.argv[4]];`,
    `for (let i = 0; i < rounds; i++) withFileLock(file, () => {`,
    `  const cur = readFileSync(file, 'utf-8');`,
    // ➤ A pause INSIDE the lock, so an unlocked version would really lose
    // ➤ lines: without it the window is too small to catch anything.
    `  const until = Date.now() + 2; while (Date.now() < until) {}`,
    `  writeFileAtomic(file, cur + who + '-' + i + '\\n');`,
    `});`,
  ].join('\n'));
  await Promise.all(Array.from({ length: WRITERS }, (_, w) => new Promise(res => {
    spawn(process.execPath, [worker, file, String(w), String(ROUNDS)], { stdio: 'ignore' }).on('exit', res);
  })));
  eq(readFileSync(file, 'utf-8').split('\n').filter(Boolean).length, WRITERS * ROUNDS,
     'six programs writing the same list at once lose nothing');

  rmSync(dir, { recursive: true, force: true });
}

// ── 5d) The "seen" reply must not claim work it did not do ────────────────
// ➤ The listener decides what to tell you by reading seen.mjs's printed output.
// ➤ It used to look for the FAILURE line and call everything else a success, so
// ➤ every other outcome — an empty pending section, a failed write, the program
// ➤ dying — still answered "Marked as seen" (audit 2026-07-31). It now reads the
// ➤ "✓ #N" lines, which are printed only for ids that were really marked.
// ➤ This is also the first test of any kind on the listener's command surface.
{
  const okOut = 'Marked as seen:\n  ✓ #412 ACME — Mooring Engineer\n  ✓ #413 BETA — Survey Engineer\n';
  eq(seenReply(['412', '413'], okOut), 'Marked as seen: #412, #413.', 'both marked, both reported');

  const partial = 'Marked as seen:\n  ✓ #412 ACME — Mooring Engineer\n#413 is not in pending (did you already remove it?)\n';
  eq(seenReply(['412', '413'], partial), 'Marked as seen: #412. Not found (already gone): #413.', 'one marked, one missing');

  const none = '#412 is not in pending (did you already remove it?)\n';
  ok(/^Nothing marked/.test(seenReply(['412'], none)), 'nothing marked is reported as nothing marked');

  // ➤ THE CASES THAT USED TO LIE. None of these prints the failure line, so the
  // ➤ old reply called every one of them a success.
  ok(/^Nothing marked/.test(seenReply(['412'], 'No pending offers to mark.')),
     'an empty pending section is not "marked"');
  ok(/^Nothing marked/.test(seenReply(['412'], '')),
     'a program that printed nothing at all is not "marked"');
  // ➤ A CRASH IS NOT "ALREADY GONE" EITHER. That sentence is also a claim about
  // ➤ the list, and it is false when the write simply failed: the offer is still
  // ➤ there, still pending, and being told it is gone means you stop chasing it.
  ok(/^Could not mark/.test(seenReply(['412'], 'Error: EACCES: permission denied')),
     'a failed write says the list could not be written, not that the offer had gone');
  ok(/^Could not mark/.test(seenReply(['412'], ['node:fs:600', '    at writeFileSync (node:fs:600:20)'].join('\n'))),
     'and a bare stack trace is read the same way');
  ok(/^Nothing marked/.test(seenReply(['412'], 'pipeline.md not found')),
     'a missing pipeline is not "marked"');

  // ➤ And a number that merely APPEARS in the output must not count as marked:
  // ➤ #41 must not be satisfied by a "✓ #412" line.
  ok(/^Nothing marked/.test(seenReply(['41'], okOut)), 'a partial number match does not count as marked');

  // ➤ IMPORTING THE LISTENER MUST NOT START THE BOT. It used to call main() at
  // ➤ the top level, so merely reading a function out of it polled Telegram with
  // ➤ the real token and executed whatever commands were waiting — which is
  // ➤ what running this very test on the server would have done.
  const li = readFileSync(join(SELF_DIR, 'telegram-listener.mjs'), 'utf-8');
  ok(/if \(process\.argv\[1\][^\n]*telegram-listener[^\n]*\{\s*\n\s*if \(process\.argv\.includes\('--once'\)\) main\(\)/.test(li),
     'the listener only starts when it IS the program being run');
}

// ── 5e) An offer number must never be handed out twice ────────────────────
// ➤ The counter lives in one small file. Lose it and the old code fell back to
// ➤ the highest number still in the pending list — a file the weekly clean-up
// ➤ DELETES from — so the counter walked backwards over every number whose line
// ➤ had gone, and a second, different job got a number you had already used.
// ➤ Answering "no 412" from an older message would then hit the wrong one
// ➤ (audit 2026-07-31). It now also reads the records that only ever grow.
{
  const dir = join(tmpdir(), `argus-ids-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const counter = join(dir, 'last-id.json');
  const apps = join(dir, 'applications.jsonl');
  const feedback = join(dir, 'feedback.jsonl');
  writeFileSync(apps, '{"id":9,"company":"GAMMA"}\n{"id":41,"company":"DELTA"}\n');
  writeFileSync(feedback, '{"id":77,"reason":"too senior"}\n');

  // ➤ The counter is there and is the highest: it wins.
  writeFileSync(counter, JSON.stringify({ lastId: 900 }));
  eq(loadIdHighWater(counter, [apps, feedback]), 900, 'the counter is used when it is present');

  // ➤ THE COUNTER IS LOST. The records still know the highest number used.
  eq(loadIdHighWater(join(dir, 'nope.json'), [apps, feedback]), 77,
     'with no counter, the records still know the highest number handed out');

  // ➤ The counter is corrupt — half-written by a crash.
  writeFileSync(counter, '{"lastId":');
  eq(loadIdHighWater(counter, [apps, feedback]), 77, 'a corrupt counter falls back to the records, not to zero');

  // ➤ A counter that has somehow gone BACKWARDS cannot lower the mark.
  writeFileSync(counter, JSON.stringify({ lastId: 5 }));
  eq(loadIdHighWater(counter, [apps, feedback]), 77, 'the mark can never go below what the records prove');

  // ➤ A corrupt line inside a record must not stop the rest being read.
  writeFileSync(apps, '{"id":9}\nthis is not json\n{"id":150}\n');
  eq(loadIdHighWater(join(dir, 'nope.json'), [apps, feedback]), 150, 'a broken line does not hide the numbers around it');

  // ➤ Nothing at all: zero, and the pipeline decides — the original behaviour.
  eq(loadIdHighWater(join(dir, 'nope.json'), [join(dir, 'nope1'), join(dir, 'nope2')]), 0,
     'with no counter and no records at all it answers zero');
  rmSync(dir, { recursive: true, force: true });
}

// ── 6a) Every board must hand over the advert text, or it is not screened ─
// ➤ The years, degree and body-language screens all read the advert BODY. Three
// ➤ parsers kept only the title and the link, so those screens ran against an
// ➤ empty string and every offer from those boards was waved through unread.
// ➤ Nothing uses them today, which is exactly why this needs a test: the day one
// ➤ is added the hole would open in silence (audit 2026-07-31).
{
  const g = parseGreenhouse({ jobs: [{ title: 'Mooring Engineer', absolute_url: 'https://x/1', location: { name: 'Rotterdam' }, content: 'We require 8 years of experience.' }] }, 'ACME');
  ok(String(g[0].description || '').includes('8 years'), 'greenhouse carries the advert text');
  const a = parseAshby({ jobs: [{ title: 'Survey Engineer', jobUrl: 'https://x/2', location: 'Madrid', descriptionHtml: '<p>Minimum 10 years.</p>' }] }, 'ACME');
  ok(String(a[0].description || '').includes('10 years'), 'ashby carries the advert text');
  const l = parseLever([{ text: 'Design Engineer', hostedUrl: 'https://x/3', categories: { location: 'Aalst' }, descriptionPlain: 'Requires a PhD in chemistry.' }], 'ACME');
  ok(String(l[0].description || '').includes('PhD'), 'lever carries the advert text');
  // ➤ A board that sends no text at all must still parse, not crash.
  eq(parseGreenhouse({ jobs: [{ title: 'T', absolute_url: 'u' }] }, 'ACME')[0].description, '', 'a board with no text yields an empty body, not undefined');

  // ➤ Greenhouse only sends the text when the URL asks for it.
  ok(greenhouseUrlWithContent('https://boards-api.greenhouse.io/v1/boards/acme/jobs').endsWith('?content=true'),
     'the greenhouse URL asks for the advert text');
  ok(greenhouseUrlWithContent('https://x/jobs?per_page=100').endsWith('&content=true'),
     'and it is appended correctly to a URL that already has a query');
  eq(greenhouseUrlWithContent('https://x/jobs?content=true'), 'https://x/jobs?content=true',
     'asking twice does not double the flag');
  eq(greenhouseUrlWithContent(''), '', 'an empty URL is left alone');
}

// ── 6c) One broken board must not fill the whole list ────────────────────
// ➤ Workday and Oracle already had a ceiling; the other boards took whatever
// ➤ the feed said. Provoked with a feed answering 20,000 postings: all 20,000
// ➤ went into the pending list — a 2.2 MB file and, with Telegram on, about 450
// ➤ messages over nine minutes (audit 2026-07-31).
{
  const said = [];
  const log = m => said.push(String(m));
  const many = n => Array.from({ length: n }, (_, i) => ({ title: `Job ${i}` }));

  eq(capJobs(many(5), 'ACME', 10, log).length, 5, 'a normal board passes through untouched');
  eq(said.length, 0, 'and nothing is said about it');

  const big = capJobs(many(20000), 'ACME', 500, log);
  eq(big.length, 500, 'a runaway board is cut to the ceiling');
  eq(big[0].title, 'Job 0', 'and it keeps the first ones, in order');
  ok(said.some(m => /20000/.test(m) && /ACME/.test(m)), 'the cut is announced, never silent');

  // ➤ Exactly at the ceiling is not a runaway.
  said.length = 0;
  eq(capJobs(many(500), 'ACME', 500, log).length, 500, 'exactly the ceiling is fine');
  eq(said.length, 0, 'and says nothing');

  // ➤ Rubbish in must not throw: a broken feed is the case this exists for.
  eq(capJobs(null, 'ACME', 500, log), [], 'a feed that returned nothing yields an empty list');
  eq(capJobs(undefined, 'ACME', 500, log), [], 'and so does no feed at all');

  // ➤ THE DEFAULT HAS TO CLEAR THE REAL BOARDS. Every check above passes its own
  // ➤ ceiling, so the shipped one could drift anywhere. It was 500, set when the
  // ➤ biggest board tracked published 368 — and connecting the consultancies put
  // ➤ Bureau Veritas at 1,985, three quarters of it unread every run.
  said.length = 0;
  ok(Number.isFinite(MAX_JOBS_PER_COMPANY), 'the shipped ceiling is a real number');
  ok(MAX_JOBS_PER_COMPANY >= 2000, 'and clears the largest board actually tracked (1,985)');
  ok(MAX_JOBS_PER_COMPANY < 20000, 'while still catching the runaway feed it exists for');
  eq(capJobs(many(1985), 'Bureau Veritas', undefined, log).length, 1985, 'so a real board passes whole');
  eq(said.length, 0, 'and is not accused of being broken');
}

// ── 6b) A hostile page must not freeze the bot ────────────────────────────
// ➤ Every job advert is downloaded and stripped of its HTML. The stripper used
// ➤ a pattern that allowed "<" inside a tag, so a page full of "<" that never
// ➤ close made it re-scan to the end of the document from every one of them —
// ➤ time squared. MEASURED on the real function: 200 KB took 6.8 s, 500 KB took
// ➤ 43 s, 1 MB did not finish in two minutes. The scan is single-threaded, so
// ➤ that is the whole bot stopped by one broken page (audit 2026-07-31).
// ➤ This test is a STOPWATCH, which is unusual and deliberate: the defect is
// ➤ not in what the function returns — the output was always correct — but in
// ➤ how long it takes, so nothing about the result could ever have caught it.
{
  const hostile = '<a '.repeat(200 * 256);      // ~200 KB of unclosed tags
  const t0 = Date.now();
  stripHtml(hostile);
  const ms = Date.now() - t0;
  // ➤ Generous on purpose: the fixed version does this in single-digit
  // ➤ milliseconds even on a slow machine, and the broken one took 6800.
  ok(ms < 1000, `200 KB of unclosed tags is stripped promptly (took ${ms} ms)`);

  // ➤ And it still strips real markup exactly as before.
  eq(stripHtml('<p>Hello <strong>world</strong> <a href="http://x/y?a=1&amp;b=2">link</a></p>'),
     'Hello world link', 'ordinary markup is still stripped correctly');
  eq(stripHtml('<ul><li>one</li><li>two</li></ul>'), 'one. two.', 'and list items still become sentences');
  // ➤ A KNOWN LIMIT, unchanged by the fix and recorded here so nobody reads it
  // ➤ as a regression: loose comparison signs in prose look exactly like a tag,
  // ➤ and the text between them is dropped. It behaved identically before, and
  // ➤ job adverts do not write "salary < 40k" in raw HTML.
  eq(stripHtml('a < b and c > d'), 'a d', 'loose comparison signs are swallowed, as they always were');
  // ➤ A ">" inside an attribute value ends the tag early — the other known
  // ➤ limit, also unchanged by the fix. Written out rather than compared
  // ➤ against the function itself, which would prove nothing.
  eq(stripHtml('<input value="5 > 3">text'), '3">text', 'a ">" inside an attribute still ends the tag early');
}

// ── 6e) Accent folding, which every text filter depends on ───────────────
// ➤ norm() strips accents before every title, company and location comparison,
// ➤ so one spelling of a term covers both. Remove the folding and this project
// ➤ silently stops matching half of Europe — with no test to say so.
{
  eq(norm('Zürich'), 'zurich', 'accents are folded away');
  eq(norm('España'), 'espana', 'and so is the tilde');
  eq(norm('Genève'), 'geneve', 'and the grave accent');
  eq(norm('MOORING'), 'mooring', 'and it lowercases');

  // ➤ The three filters that depend on it, each with the term written one way
  // ➤ and the text the other.
  const title = buildTitleFilter({ positive: ['Tôlier'], negative: [] });
  ok(title('Tolier industriel'), 'a title matches its unaccented spelling');
  ok(title('Tôlier industriel'), 'and its accented one');

  const company = buildCompanyFilter({ blocked: ['Générale'] });
  ok(!company('Generale Engineering'), 'a blocked company matches unaccented');
  ok(!company('Générale Engineering'), 'and accented');

  const loc = buildLocationFilter({ allow: ['España'] });
  ok(loc('Madrid, Espana'), 'an allowed location matches unaccented');
  ok(loc('Madrid, España'), 'and accented');
}

// ── 7a) A country you switched OFF must be off in every spelling ──────────
// ➤ countries.yml lists the accented forms as aliases on purpose — "Zürich",
// ➤ "Genève", "Österreich". The matcher folded the ALIAS but tested it against
// ➤ the raw location, so the folded term could never match the accented text:
// ➤ "Zurich" was correctly dropped and "Zürich" walked straight through. Every
// ➤ other matcher in scan.mjs folds both sides (audit 2026-07-31).
{
  const country = buildCountryFilter();
  // ➤ Reads the real countries.yml, so the assertions are about whatever is
  // ➤ switched off today rather than a fixture that can drift away from it.
  for (const name of country.off) {
    // ➤ The country's own name, and its aliases, in whatever spelling.
    ok(!country.fn(name), `a location that names ${name} is blocked`);
  }
  // ➤ The accented aliases specifically — the ones that were dead.
  const accented = ['Zürich', 'Genève', 'Österreich'];
  for (const a of accented) {
    const folded = a.normalize('NFD').replace(/[̀-ͯ]/g, '');
    // ➤ Only assert on the ones whose country is actually off right now.
    if (country.fn(folded)) continue;      // that country is on today — nothing to prove
    ok(!country.fn(a), `"${a}" is blocked exactly like "${folded}"`);
  }
  // ➤ And a country that is ON must still pass, or the filter has closed shut.
  ok(country.fn('Rotterdam, Netherlands'), 'a country you kept is not blocked');
  ok(country.fn(''), 'an empty location is not blocked');
}

// ── 7b) `/start` must not be able to destroy the CV by accident ───────────
// ➤ Question 0 of the setup is "paste your CV", and the listener routes text to
// ➤ the setup BEFORE it looks for a command — so with setup running, typing
// ➤ "list" was written over cv.md. Only copy, no confirmation, nothing to
// ➤ cancel with (audit 2026-07-31). These read the shipped files as text
// ➤ because the flow itself talks to Telegram and cannot be run here; a check
// ➤ that only tested a helper would not have caught the original defect either.
{
  const ob = readFileSync(join(SELF_DIR, 'onboarding.mjs'), 'utf-8');
  const li = readFileSync(join(SELF_DIR, 'telegram-listener.mjs'), 'utf-8');

  // ➤ Starting again over an existing profile must ASK first.
  ok(/startOnboarding\(force = false\)/.test(ob), 'starting the setup again has to be forced');
  ok(/if \(!force && loadAnswers\(\)\)/.test(ob), 'an existing profile stops /start and asks for confirmation');
  // ➤ Since 2026-08-06 the same regex also swallows the installer's deep-link
  // ➤ payload ("/start ab12cd34" from t.me/bot?start=CODE) as a plain /start.
  ok(/start\(\\s\+yes\|\\s\+\[a-z0-9\]\{6,12\}\)\?/.test(li),
     'the listener accepts "/start yes" and the deep-link payload');

  // ➤ The CV is backed up before it is replaced.
  ok(/backupBeforeOverwrite\(CV_PATH\);\s*\n\s*writePrivate\(CV_PATH/.test(ob),
     'the old CV is copied aside BEFORE the new one is written');

  // ➤ There is a way out, and it is checked before the answer is stored.
  ok(/cancel\|cancelar/.test(ob), 'a cancel word exists');
  const cancelAt = ob.indexOf('cancelOnboarding()');
  const storeAt = ob.indexOf('backupBeforeOverwrite(CV_PATH)');
  ok(cancelAt > 0 && storeAt > 0 && cancelAt < storeAt, 'cancel is handled BEFORE anything is written');
  ok(/or type "cancel" to stop/.test(ob), 'and every typed question says so on screen');
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

// ── 7) The brake that protects the pending list from a mass delete ────────
// ➤ housekeep deletes PERMANENTLY. If a whole batch comes back "dead" it is a
// ➤ portal/network problem, not real withdrawals — it must delete nothing.
// ➤ THIS BLOCK USED TO RE-IMPLEMENT THE FORMULA and assert against its own
// ➤ copy, so the real brake could be deleted from the program outright and all
// ➤ 262 tests still passed (audit 2026-07-31). It now imports the very function
// ➤ both delete paths call, which is the only version of this test worth having.
{
  ok(looksLikeAnOutage(14, 14), 'everything dead at once → refuse to delete');
  ok(looksLikeAnOutage(14, 7), 'half the list dead at once → refuse to delete');
  ok(!looksLikeAnOutage(14, 6), 'a normal handful of dead links → delete them');
  ok(!looksLikeAnOutage(14, 0), 'nothing dead → nothing to do');
  ok(looksLikeAnOutage(3, 3), 'a whole short list dying at once is an outage too');
  ok(!looksLikeAnOutage(0, 0), 'an empty list is not an outage');

  // ➤ A RATIO ALONE GETS SHORT LISTS WRONG, and did: one genuinely withdrawn
  // ➤ offer out of two is half of them, so the brake fired every run and the
  // ➤ dead link could never be cleaned. One or two dead links are what this
  // ➤ clean-up is FOR.
  ok(!looksLikeAnOutage(1, 1), 'one dead link on a one-offer list is just a dead link');
  ok(!looksLikeAnOutage(2, 1), 'and one of two');
  ok(!looksLikeAnOutage(3, 2), 'and two of three');
  ok(!looksLikeAnOutage(4, 2), 'and two of four');
  // ➤ But five or more at once is an outage whatever the list size.
  ok(looksLikeAnOutage(6, 5), 'five dead at once brakes even on a six-offer list');

  // ➤ AND THE BRAKE MUST BE WIRED IN, not merely present. Both delete paths are
  // ➤ read as text and must mention it; a refactor that quietly stopped calling
  // ➤ it would otherwise leave every test green — exactly what happened before.
  const hk = readFileSync(join(SELF_DIR, 'housekeep.mjs'), 'utf-8');
  eq((hk.match(/looksLikeAnOutage\(/g) || []).length, 3,
     'the brake is defined once and called by BOTH delete paths');
}

// ── 5d) The "seen" reply must not claim work it did not do ────────────────
// ➤ The listener decides what to tell you by reading seen.mjs's printed output.
// ➤ It used to look for the FAILURE line and call everything else a success, so
// ➤ every other outcome — an empty pending section, a failed write, the program
// ➤ dying — still answered "Marked as seen" (audit 2026-07-31). It now reads the
// ➤ "✓ #N" lines, which are printed only for ids that were really marked.
// ➤ This is also the first test of any kind on the listener's command surface.
{
  const okOut = 'Marked as seen:\n  ✓ #412 ACME — Mooring Engineer\n  ✓ #413 BETA — Survey Engineer\n';
  eq(seenReply(['412', '413'], okOut), 'Marked as seen: #412, #413.', 'both marked, both reported');

  const partial = 'Marked as seen:\n  ✓ #412 ACME — Mooring Engineer\n#413 is not in pending (did you already remove it?)\n';
  eq(seenReply(['412', '413'], partial), 'Marked as seen: #412. Not found (already gone): #413.', 'one marked, one missing');

  const none = '#412 is not in pending (did you already remove it?)\n';
  ok(/^Nothing marked/.test(seenReply(['412'], none)), 'nothing marked is reported as nothing marked');

  // ➤ THE CASES THAT USED TO LIE. None of these prints the failure line, so the
  // ➤ old reply called every one of them a success.
  ok(/^Nothing marked/.test(seenReply(['412'], 'No pending offers to mark.')),
     'an empty pending section is not "marked"');
  ok(/^Nothing marked/.test(seenReply(['412'], '')),
     'a program that printed nothing at all is not "marked"');
  // ➤ A CRASH IS NOT "ALREADY GONE" EITHER. That sentence is also a claim about
  // ➤ the list, and it is false when the write simply failed: the offer is still
  // ➤ there, still pending, and being told it is gone means you stop chasing it.
  ok(/^Could not mark/.test(seenReply(['412'], 'Error: EACCES: permission denied')),
     'a failed write says the list could not be written, not that the offer had gone');
  ok(/^Could not mark/.test(seenReply(['412'], ['node:fs:600', '    at writeFileSync (node:fs:600:20)'].join('\n'))),
     'and a bare stack trace is read the same way');
  ok(/^Nothing marked/.test(seenReply(['412'], 'pipeline.md not found')),
     'a missing pipeline is not "marked"');

  // ➤ And a number that merely APPEARS in the output must not count as marked:
  // ➤ #41 must not be satisfied by a "✓ #412" line.
  ok(/^Nothing marked/.test(seenReply(['41'], okOut)), 'a partial number match does not count as marked');

  // ➤ IMPORTING THE LISTENER MUST NOT START THE BOT. It used to call main() at
  // ➤ the top level, so merely reading a function out of it polled Telegram with
  // ➤ the real token and executed whatever commands were waiting — which is
  // ➤ what running this very test on the server would have done.
  const li = readFileSync(join(SELF_DIR, 'telegram-listener.mjs'), 'utf-8');
  ok(/if \(process\.argv\[1\][^\n]*telegram-listener[^\n]*\{\s*\n\s*if \(process\.argv\.includes\('--once'\)\) main\(\)/.test(li),
     'the listener only starts when it IS the program being run');
}

// ── 5e) An offer number must never be handed out twice ────────────────────
// ➤ The counter lives in one small file. Lose it and the old code fell back to
// ➤ the highest number still in the pending list — a file the weekly clean-up
// ➤ DELETES from — so the counter walked backwards over every number whose line
// ➤ had gone, and a second, different job got a number you had already used.
// ➤ Answering "no 412" from an older message would then hit the wrong one
// ➤ (audit 2026-07-31). It now also reads the records that only ever grow.
{
  const dir = join(tmpdir(), `argus-ids-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const counter = join(dir, 'last-id.json');
  const apps = join(dir, 'applications.jsonl');
  const feedback = join(dir, 'feedback.jsonl');
  writeFileSync(apps, '{"id":9,"company":"GAMMA"}\n{"id":41,"company":"DELTA"}\n');
  writeFileSync(feedback, '{"id":77,"reason":"too senior"}\n');

  // ➤ The counter is there and is the highest: it wins.
  writeFileSync(counter, JSON.stringify({ lastId: 900 }));
  eq(loadIdHighWater(counter, [apps, feedback]), 900, 'the counter is used when it is present');

  // ➤ THE COUNTER IS LOST. The records still know the highest number used.
  eq(loadIdHighWater(join(dir, 'nope.json'), [apps, feedback]), 77,
     'with no counter, the records still know the highest number handed out');

  // ➤ The counter is corrupt — half-written by a crash.
  writeFileSync(counter, '{"lastId":');
  eq(loadIdHighWater(counter, [apps, feedback]), 77, 'a corrupt counter falls back to the records, not to zero');

  // ➤ A counter that has somehow gone BACKWARDS cannot lower the mark.
  writeFileSync(counter, JSON.stringify({ lastId: 5 }));
  eq(loadIdHighWater(counter, [apps, feedback]), 77, 'the mark can never go below what the records prove');

  // ➤ A corrupt line inside a record must not stop the rest being read.
  writeFileSync(apps, '{"id":9}\nthis is not json\n{"id":150}\n');
  eq(loadIdHighWater(join(dir, 'nope.json'), [apps, feedback]), 150, 'a broken line does not hide the numbers around it');

  // ➤ Nothing at all: zero, and the pipeline decides — the original behaviour.
  eq(loadIdHighWater(join(dir, 'nope.json'), [join(dir, 'nope1'), join(dir, 'nope2')]), 0,
     'with no counter and no records at all it answers zero');
  rmSync(dir, { recursive: true, force: true });
}

// ── 6a) Every board must hand over the advert text, or it is not screened ─
// ➤ The years, degree and body-language screens all read the advert BODY. Three
// ➤ parsers kept only the title and the link, so those screens ran against an
// ➤ empty string and every offer from those boards was waved through unread.
// ➤ Nothing uses them today, which is exactly why this needs a test: the day one
// ➤ is added the hole would open in silence (audit 2026-07-31).
{
  const g = parseGreenhouse({ jobs: [{ title: 'Mooring Engineer', absolute_url: 'https://x/1', location: { name: 'Rotterdam' }, content: 'We require 8 years of experience.' }] }, 'ACME');
  ok(String(g[0].description || '').includes('8 years'), 'greenhouse carries the advert text');
  const a = parseAshby({ jobs: [{ title: 'Survey Engineer', jobUrl: 'https://x/2', location: 'Madrid', descriptionHtml: '<p>Minimum 10 years.</p>' }] }, 'ACME');
  ok(String(a[0].description || '').includes('10 years'), 'ashby carries the advert text');
  const l = parseLever([{ text: 'Design Engineer', hostedUrl: 'https://x/3', categories: { location: 'Aalst' }, descriptionPlain: 'Requires a PhD in chemistry.' }], 'ACME');
  ok(String(l[0].description || '').includes('PhD'), 'lever carries the advert text');
  // ➤ A board that sends no text at all must still parse, not crash.
  eq(parseGreenhouse({ jobs: [{ title: 'T', absolute_url: 'u' }] }, 'ACME')[0].description, '', 'a board with no text yields an empty body, not undefined');

  // ➤ Greenhouse only sends the text when the URL asks for it.
  ok(greenhouseUrlWithContent('https://boards-api.greenhouse.io/v1/boards/acme/jobs').endsWith('?content=true'),
     'the greenhouse URL asks for the advert text');
  ok(greenhouseUrlWithContent('https://x/jobs?per_page=100').endsWith('&content=true'),
     'and it is appended correctly to a URL that already has a query');
  eq(greenhouseUrlWithContent('https://x/jobs?content=true'), 'https://x/jobs?content=true',
     'asking twice does not double the flag');
  eq(greenhouseUrlWithContent(''), '', 'an empty URL is left alone');
}

// ── 6c) One broken board must not fill the whole list ────────────────────
// ➤ Workday and Oracle already had a ceiling; the other boards took whatever
// ➤ the feed said. Provoked with a feed answering 20,000 postings: all 20,000
// ➤ went into the pending list — a 2.2 MB file and, with Telegram on, about 450
// ➤ messages over nine minutes (audit 2026-07-31).
{
  const said = [];
  const log = m => said.push(String(m));
  const many = n => Array.from({ length: n }, (_, i) => ({ title: `Job ${i}` }));

  eq(capJobs(many(5), 'ACME', 10, log).length, 5, 'a normal board passes through untouched');
  eq(said.length, 0, 'and nothing is said about it');

  const big = capJobs(many(20000), 'ACME', 500, log);
  eq(big.length, 500, 'a runaway board is cut to the ceiling');
  eq(big[0].title, 'Job 0', 'and it keeps the first ones, in order');
  ok(said.some(m => /20000/.test(m) && /ACME/.test(m)), 'the cut is announced, never silent');

  // ➤ Exactly at the ceiling is not a runaway.
  said.length = 0;
  eq(capJobs(many(500), 'ACME', 500, log).length, 500, 'exactly the ceiling is fine');
  eq(said.length, 0, 'and says nothing');

  // ➤ Rubbish in must not throw: a broken feed is the case this exists for.
  eq(capJobs(null, 'ACME', 500, log), [], 'a feed that returned nothing yields an empty list');
  eq(capJobs(undefined, 'ACME', 500, log), [], 'and so does no feed at all');
}

// ── 6d) The guards must be WIRED IN, not merely present ──────────────────
// ➤ Every one of these is tested on its own and passes — and every one of them
// ➤ could be deleted from the place it is actually called with the whole suite
// ➤ still green. A rule nothing calls is not a rule. Each check reads the
// ➤ shipped file as text, which is crude but is the only thing that catches a
// ➤ call site quietly disappearing.
{
  const scan = readFileSync(join(SELF_DIR, 'scan.mjs'), 'utf-8');
  const hk = readFileSync(join(SELF_DIR, 'housekeep.mjs'), 'utf-8');
  const li = readFileSync(join(SELF_DIR, 'telegram-listener.mjs'), 'utf-8');

  // ➤ The per-board ceiling: without the call, one broken feed puts 20,000
  // ➤ postings straight into the pending list.
  ok(/jobs = capJobs\(jobs, [^)]+\);/.test(scan), 'the scan actually applies the per-board ceiling');

  // ➤ A BOARD THAT STOPS HALFWAY MUST BE REPORTED. Measured against a real
  // ➤ Workday tenant: when only page 1 of 42 answered and the rest returned
  // ➤ 503, the run printed 20 offers of 840, no Errors section, and a summary
  // ➤ identical to a quiet day — while the SAME failure on page 1 was reported.
  // ➤ Read as text: the bug is a missing call, and no fixture can miss it.
  ok(/collectWorkday\(c\._api, c\.name, workdayTerms, partial\)/.test(scan),
    'the scan asks Workday to report a board it could only read part of');
  ok(/collectOracle\(c\._api, c\.name, partial\)/.test(scan), 'and asks Oracle the same');
  ok(/if \(answered\) cutShort = true;/.test(scan), 'a page that fails after one worked is a truncated read');
  ok(/if \(cutShort\) onPartial\(/.test(scan), 'and that is handed back, not swallowed');
  ok(/only part of the board was read/.test(scan), 'which reaches the run summary as an error');

  // ➤ THE FIRST GATE HAD NO COUNTER. An offer thrown out for a missing or unsafe
  // ➤ link appeared in no line of the summary, no error, and no field of
  // ➤ last-scan.json. It is zero on a healthy run — which is why the day a board
  // ➤ renames the field its links come from, all of its offers would leave by
  // ➤ that door and the summary would still read like a quiet week.
  ok(/v\.stage === 'NO LINK'\) fNoLink\+\+/.test(scan), 'an offer with no usable link is counted');
  ok(!/isSafeUrl\(job\.url\)\) \{ logDrop/.test(scan), 'and no inline gate steals the drop before it can be counted');
  // ➤ Years and degree are different verdicts, and both were printed as one.
  ok(/degree_filtered: fDeg/.test(scan), 'a degree drop is counted apart from the years');
  // ➤ A LinkedIn refusing every call is a block, not a run with no matches.
  ok(/BLOCKED \(HTTP \$\{lastRefused\} on every call\)/.test(scan), 'a fully-refused LinkedIn says BLOCKED, not ran');
  // ➤ An answered ZERO never trips the no-answer alarm; naming those boards is
  // ➤ how a stale tenant (5 postings vs the real 733) gets seen at a glance.
  ok(/emptyBoards\.push\(c\.name\)/.test(scan) && /boards that answered with zero postings/.test(scan),
    'a board that answers with nothing is named in the summary');

  // ➤ A degraded feed is a quiet board, not a crash: null bodies, wrong types
  // ➤ and null items must come back as empty lists, as every parser promises.
  for (const h of [null, undefined, { jobs: 'x' }, { jobs: [null] }]) {
    let ok1 = true;
    try { ok1 = Array.isArray(parseGreenhouse(h, 'X')) && Array.isArray(parseAshby(h, 'X')); } catch { ok1 = false; }
    ok(ok1, 'a hostile feed shape does not crash greenhouse/ashby: ' + JSON.stringify(h));
  }

  // ➤ The weekly dedup keys on company+title too, and an unnamed advertiser
  // ➤ must give it nothing: two anonymous ads sharing a title are NOT one
  // ➤ vacancy, and the older one was being deleted every Sunday.
  {
    const { fuzzyKey } = await import('./housekeep.mjs');
    eq(fuzzyKey('Adzuna', 'Offshore Engineer'), '', 'housekeep: the Adzuna placeholder yields no dedup key');
    eq(fuzzyKey('LinkedIn', 'Offshore Engineer'), '', 'housekeep: and neither does the LinkedIn one');
    eq(fuzzyKey('Van Oord BV', 'Offshore Engineer'), 'van oord::offshore engineer', 'housekeep: a real employer still keys');
    ok(/\(k && seenRole\.has\(k\)\)/.test(hk) && /if \(k\) seenRole\.add\(k\)/.test(hk),
      'housekeep: and the dedup loop never writes or matches an empty key');
  }
  ok(/if \(fNoLink\) console\.log/.test(scan), 'and said out loud, but only when it is not zero');
  ok(/no_link: fNoLink/.test(scan), 'and recorded where the server can be watched from outside');

  ok(/detached: true/.test(li) && /child\.unref\(\)/.test(li),
    'the listener starts the cover letter detached and lets go of it');
  ok(!/await makeCoverLetter/.test(li), 'and does not wait for the letter itself');
  ok(/--offer/.test(li), 'handing the offer number to the program that does the work');

  // ➤ Greenhouse withholds the advert text unless the URL asks for it, so the
  // ➤ years and degree screens would run against an empty body.
  ok(/greenhouseUrlWithContent\(c\._api\.url\)/.test(scan), 'the scan actually asks Greenhouse for the advert text');

  // ➤ The counter that stops an offer number ever being handed out twice.
  ok(/nextId = Math\.max\(nextId, loadIdHighWater\(\)\)/.test(scan),
     'the scan actually consults the high-water mark before numbering');

  // ➤ The brake, on BOTH delete paths — the daily check and the weekly clean-up.
  eq((hk.match(/looksLikeAnOutage\(/g) || []).length, 3,
     'the mass-delete brake is defined once and called by both delete paths');
  ok(!/if \(false && looksLikeAnOutage/.test(hk), 'and neither call is disabled');

  // ➤ The Telegram position: treating a missing file as zero replays a day of
  // ➤ commands, which is what today's fix exists to prevent.
  ok(/loadJson\(OFFSET_PATH, null\)/.test(li), 'a missing position file is not read as zero');
  ok(/await resyncOffset\(cfg\)/.test(li), 'and it resynchronises instead');
  ok(/writeFileAtomic\(OFFSET_PATH/.test(li), 'the position is written atomically');
  ok(!/writeFileSync\(OFFSET_PATH/.test(li), 'and never with a plain write');
}

// ── 6b) A hostile page must not freeze the bot ────────────────────────────
// ➤ Every job advert is downloaded and stripped of its HTML. The stripper used
// ➤ a pattern that allowed "<" inside a tag, so a page full of "<" that never
// ➤ close made it re-scan to the end of the document from every one of them —
// ➤ time squared. MEASURED on the real function: 200 KB took 6.8 s, 500 KB took
// ➤ 43 s, 1 MB did not finish in two minutes. The scan is single-threaded, so
// ➤ that is the whole bot stopped by one broken page (audit 2026-07-31).
// ➤ This test is a STOPWATCH, which is unusual and deliberate: the defect is
// ➤ not in what the function returns — the output was always correct — but in
// ➤ how long it takes, so nothing about the result could ever have caught it.
{
  const hostile = '<a '.repeat(200 * 256);      // ~200 KB of unclosed tags
  const t0 = Date.now();
  stripHtml(hostile);
  const ms = Date.now() - t0;
  // ➤ Generous on purpose: the fixed version does this in single-digit
  // ➤ milliseconds even on a slow machine, and the broken one took 6800.
  ok(ms < 1000, `200 KB of unclosed tags is stripped promptly (took ${ms} ms)`);

  // ➤ And it still strips real markup exactly as before.
  eq(stripHtml('<p>Hello <strong>world</strong> <a href="http://x/y?a=1&amp;b=2">link</a></p>'),
     'Hello world link', 'ordinary markup is still stripped correctly');
  eq(stripHtml('<ul><li>one</li><li>two</li></ul>'), 'one. two.', 'and list items still become sentences');
  // ➤ A KNOWN LIMIT, unchanged by the fix and recorded here so nobody reads it
  // ➤ as a regression: loose comparison signs in prose look exactly like a tag,
  // ➤ and the text between them is dropped. It behaved identically before, and
  // ➤ job adverts do not write "salary < 40k" in raw HTML.
  eq(stripHtml('a < b and c > d'), 'a d', 'loose comparison signs are swallowed, as they always were');
  // ➤ A ">" inside an attribute value ends the tag early — the other known
  // ➤ limit, also unchanged by the fix. Written out rather than compared
  // ➤ against the function itself, which would prove nothing.
  eq(stripHtml('<input value="5 > 3">text'), '3">text', 'a ">" inside an attribute still ends the tag early');
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

  // ➤ TICKING "REMOTE" MUST NOT SEND EVERY REMOTE OFFER TWICE. The onboarding
  // ➤ offers it as a country, so it lands in the user's country list AND in the
  // ➤ fixed group order the message is built from — and that list is walked, so
  // ➤ a label in it twice emits its offers twice.
  {
    const remoto = yaml.load(buildProfileYaml({ ...accountant, countries: ['Germany', 'Remote'] })).search;
    const labels = remoto.countries.map(c => c.label);
    const order = [...new Set(['BERLIN', ...labels, 'REMOTE', 'OTHER', 'NO LOCATION'])];
    eq(order.filter(x => x === 'REMOTE').length, 1, 'onboarding: REMOTE appears once in the group order');
    // ➤ And the allowed places do not carry the same word twice in two cases.
    const bajas = remoto.locations.allow.map(x => String(x).toLowerCase());
    eq(bajas.length, new Set(bajas).size, 'onboarding: no place is listed twice');
  }
  ok(p.queries.includes('financial accountant'), 'the queries are built from the roles');
  ok(p.queries.includes('accounting'), 'the queries also include the fields');
  ok(!p.queries.some(q => /offshore|marine|mooring/.test(q)), 'no marine term leaks into a non-marine search');
  ok(p.locations && Array.isArray(p.locations.allow), 'the profile carries its own geography');
  ok(p.locations.allow.includes('Germany') && p.locations.allow.includes('Berlin'), 'geography = chosen countries + home city');
  eq(p.track_example_companies, false, 'the example marine employers are switched off');
  // ➤ And the whole thing must still be valid, complete config.
  ok(p.positive_titles.length > 0 && p.max_years === 2, 'the rest of the profile is still complete');
}

// ── 8b) A setup with no job titles must not inherit the example's ────────
// ➤ A punctuation-only answer to "what job titles are you looking for" reduces
// ➤ to an empty list. Writing [] tells the scanner no keyword is required, so
// ➤ every title in the world passes; leaving the key out makes it fall back to
// ➤ portals.yml — the shipped MARINE example. An accountant's bot would then
// ➤ ask the boards for accounting jobs and reject every one of them for having
// ➤ "no keyword from your field", for ever and without a word (audit
// ➤ 2026-08-01). Her own FIELDS are hers, so that is the fallback.
{
  const accountant = {
    name: 'Jane Doe', contact: 'jane@x.com, Berlin',
    fields: 'accounting, finance, audit', level: 'junior', max_years: '2',
    languages: ['en'], degrees_excluded: [], countries: ['Germany'], vetoes: [],
  };
  const blank = yaml.load(buildProfileYaml({ ...accountant, roles: ',,' })).search;
  eq(blank.positive_titles, ['accounting', 'finance', 'audit'],
     `with no usable job titles, the filter falls back to the user's OWN fields`);
  ok(!/mooring|offshore|orcaflex/i.test(JSON.stringify(blank)),
     'and never to the shipped marine example');

  // ➤ A normal answer is untouched.
  const normal = yaml.load(buildProfileYaml({ ...accountant, roles: 'accountant, controller' })).search;
  eq(normal.positive_titles, ['accountant', 'controller'], 'a real answer is used as given');

  // ➤ Nothing at all: the key stays out, because there is genuinely nothing to
  // ➤ search for — and the flow says so on screen rather than pretending.
  const nothing = yaml.load(buildProfileYaml({ ...accountant, roles: ',,', fields: '' })).search;
  eq(nothing.positive_titles, undefined, 'with neither titles nor fields the key is left out');
  const ob = readFileSync(join(SELF_DIR, 'onboarding.mjs'), 'utf-8');
  ok(/nothing to search for/.test(ob), 'and the setup tells the user so when it finishes');
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

// ── 11a) The two headings that divide the pipeline ───────────────────────
// ➤ Four modules need them: the scanner writes, the list reads, "seen" edits,
// ➤ housekeep deletes. Each used to spell them out for itself — four copies of
// ➤ one decision, which drift the moment anybody changes one of them.
// ➤ One place, one spelling, and these tests hold the four to it.
{
  const { PENDING_HEADING, PROCESSED_HEADING, isPendingHeading, isProcessedHeading, pendingIndex } =
    await import('./pipeline-format.mjs');

  eq(PENDING_HEADING, '## Pending', 'the pending heading is English');
  eq(PROCESSED_HEADING, '## Processed', 'and so is the other one');
  ok(isPendingHeading(PENDING_HEADING) && isProcessedHeading(PROCESSED_HEADING), 'each recognises its own');
  ok(pendingIndex(`# Pipeline\n\n${PENDING_HEADING}\n\n- [ ] x\n`) > 0, 'and is found inside a file');

  // ➤ A heading with something after it still counts ("## Pending (12)").
  ok(isPendingHeading('## Pending (12)'), 'a heading with a count after it still counts');
  // ➤ And nothing else does: an offer line is not a heading.
  ok(!isPendingHeading('- [ ] https://a/1 | ACME | Engineer | #1'), 'an offer line is not a heading');
  ok(!isPendingHeading('# Pipeline'), 'nor the title of the file');
  ok(!isPendingHeading(''), 'nor an empty line');
  ok(!isPendingHeading('## Pendiente'), 'and nothing that merely looks like it');
  eq(pendingIndex('# Pipeline\n\nno headings here\n'), -1, 'a file without the heading says so, rather than guessing');
  eq(pendingIndex(''), -1, 'and so does an empty file');

  // ➤ NOBODY SPELLS THEM OUT AGAIN. This is the rule the file exists for, and
  // ➤ a stray literal in one module is exactly how the two copies drifted.
  const readers = ['scan.mjs', 'seen.mjs', 'housekeep.mjs', 'list-offers.mjs'];
  for (const r of readers) {
    const src = readFileSync(new URL(`./${r}`, import.meta.url), 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    ok(!/'## Pend|"## Pend|'## Proc|"## Proc/.test(src), `${r} asks pipeline-format for the heading instead of writing it out`);
  }
}

// ── 11b) What housekeep DELETES ──────────────────────────────────────────
// ➤ The block above only checks that importing housekeep does not run it. An
// ➤ audit asked the harder question — what does it delete? — and the answer
// ➤ was that none of its 14 functions had a test, in the one module that
// ➤ destroys data. These three decide what goes.
{
  const { rewritePipelineWithout, fuzzyKey, normUrl } = await import('./housekeep.mjs');

  // ➤ THE DELETE ITSELF, on a file of our own. It matches the trimmed line
  // ➤ exactly, which is the safe way round: a line you edited in the meantime
  // ➤ stops matching and survives instead of being removed by accident.
  const dir = join(tmpdir(), `argus-hk-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'pipeline.md');
  const before = ['## Pending', '- [ ] a | Acme | Engineer | #1', '- [ ] b | Beta | Engineer | #2', '- [x] c | Gamma | Engineer | #3', ''];
  writeFileSync(p, before.join('\n'));

  const removed = rewritePipelineWithout(['- [x] c | Gamma | Engineer | #3'], p);
  const after = readFileSync(p, 'utf-8').split('\n');
  eq(removed, 1, 'housekeep: it reports how many lines it actually removed');
  ok(!after.some(l => l.includes('#3')), 'housekeep: the line asked for is gone');
  ok(after.some(l => l.includes('#1')) && after.some(l => l.includes('#2')), 'housekeep: and nothing else went with it');
  ok(after[0] === '## Pending', 'housekeep: the heading survives');

  // ➤ A line that no longer matches is NOT removed, and it says zero.
  writeFileSync(p, before.join('\n'));
  eq(rewritePipelineWithout(['- [ ] a | Acme | Engineer | #1 | visto'], p), 0,
    'housekeep: a line that changed since the decision is left alone');
  eq(rewritePipelineWithout([], p), 0, 'housekeep: asked to delete nothing, it deletes nothing');
  eq(rewritePipelineWithout(['', '   '], p), 0, 'housekeep: blank entries never match a real line');
  rmSync(dir, { recursive: true, force: true });

  // ➤ THE DUPLICATE KEY, which decides that two postings are the same job and
  // ➤ therefore that one of them dies. It has been wrong before: it used to
  // ➤ keep only the first word of the company, so "Royal IHC" and "Royal
  // ➤ Niestern Sander" shared a key and a real second vacancy was deleted.
  ok(fuzzyKey('Royal IHC', 'Engineer') !== fuzzyKey('Royal Niestern Sander', 'Engineer'),
    'housekeep: two different companies sharing a first word are NOT one job');
  eq(fuzzyKey('Connetix', 'Engineer'), fuzzyKey('Connetix Nederland', 'Engineer'),
    'housekeep: but a branch suffix does not make a second company');
  eq(fuzzyKey('Acme BV', 'Engineer'), fuzzyKey('Acme', 'Engineer'), 'housekeep: nor does a legal form');
  // ➤ The same posting re-listed with a gender tag, a percentage or an en dash
  // ➤ must give the SAME key, or your "no" is dodged by a re-post.
  eq(fuzzyKey('Acme', 'Engineer (m/w/d)'), fuzzyKey('Acme', 'Engineer'), 'housekeep: a gender tag is not a new job');
  eq(fuzzyKey('Acme', 'Engineer 80-100%'), fuzzyKey('Acme', 'Engineer'), 'housekeep: nor a workload');
  eq(fuzzyKey('Acme', 'Power Systems – Lead'), fuzzyKey('Acme', 'Power Systems - Lead'), 'housekeep: nor an en dash');
  ok(fuzzyKey('Acme', 'Engineer') !== fuzzyKey('Acme', 'Surveyor'), 'housekeep: a different role is a different job');

  // ➤ And the link normaliser, which decides whether an offer is already in
  // ➤ the history — i.e. whether deleting it lets it come back as "new".
  eq(normUrl('https://www.adzuna.es/details/123?utm_source=x'), 'https://www.adzuna.es/details/123', 'housekeep: tracking parameters are not part of a link');
  eq(normUrl('https://www.adzuna.es/details/123/'), 'https://www.adzuna.es/details/123', 'housekeep: nor a trailing slash');
  eq(normUrl('https://www.adzuna.fr/land/ad/456'), 'https://www.adzuna.fr/details/456', 'housekeep: the two Adzuna link shapes are one link');
  eq(normUrl(''), '', 'housekeep: nothing normalises to nothing');
  eq(normUrl(undefined), '', 'housekeep: and so does a missing link');
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
  // ➤ Its own imports have to travel with it. The module reads the two section
  // ➤ headings from pipeline-format.mjs, and without that file next door the
  // ➤ copy cannot even load — which is how this line came to exist.
  copyFileSync(new URL('./pipeline-format.mjs', import.meta.url), join(dir, 'server-bot', 'pipeline-format.mjs'));
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
    // ➤ "mail" is the twin of "list": one prints the offers waiting for you,
    // ➤ the other what came back from the ones you sent. Neither goes looking
    // ➤ for anything, both just print. "status" was this command's first name
    // ➤ and still answers.
    [/^(mail|status)$/i, 'mail', true], [/^(mail|status)$/i, 'status', true],
    [/^(mail|status)$/i, 'MAIL', true],
    [/^(mail|status)$/i, 'mails', false], [/^(mail|status)$/i, 'mail 3', false],
    // ➤ And it must not swallow a message that merely starts with the word.
    [/^(mail|status)$/i, 'mailbox full', false],
  ];
  for (const [re, input, want] of CMDS) eq(re.test(input), want, `command "${input}"`);
  // ➤ The reason must survive intact after the number.
  const m = 'no #412 needs 10 years of experience'.match(/^no[\s,:]*#?(\d+)[\s,.:—-]*(.*)$/i);
  eq(m[1], '412', 'the offer number is extracted');
  eq(m[2], 'needs 10 years of experience', 'the reason is kept whole');
}

// ── The CV arrives as a PDF ───────────────────────────────────────────────
// ➤ Users send the file they already have, not pasted text (field test
// ➤ 2026-08-06). This builds a real minimal PDF and runs it through the same
// ➤ extractor the onboarding uses — so a missing/broken pdf-parse install
// ➤ fails HERE, not in front of a user mid-setup. The extractor itself was
// ➤ validated live (2026-08-06) against a genuine Canva-produced CV export
// ➤ and three university sample packs with multi-column layouts: all four
// ➤ yielded clean, ordered text. The embedded PDF below only exists to keep
// ➤ this suite offline.
{
  const stream = 'BT /F1 12 Tf 72 720 Td (Marine Engineer CV probe with enough text to pass) Tj ET';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const text = await pdfText(Buffer.from(pdf, 'latin1'));
  ok(text.includes('Marine Engineer CV probe'), 'a PDF CV yields its text');
  ok(!/-- \d+ of \d+ --/.test(text), 'and the page markers are stripped out');
}

// ── Result ────────────────────────────────────────────────────────────────
// ── 14) argus-discover: the profile audit must not invent evidence ────────
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

// ── 15) argus-discover: the harvest must not propose noise ───────────────
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

// ── 16) argus-discover: the ESCO match ───────────────────────────────────
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

// ── 17) argus-discover: the blind-spot record ────────────────────────────
// ➤ It exists because the title filter's allowlist drops things silently, and
// ➤ on a real cycle 345 titles were dropped for no reason but "not on the
// ➤ list". Recurrence is the only signal it uses, so the counting has to be
// ➤ right: over-count and noise looks like a gap, under-count and a real gap
// ➤ stays invisible.
{
  const { mergeDrops, topRecurring, classifyDrop, ruleOf, formatReport, NO_FIELD, RULE, MAX_TITLES } =
    await import('./argus-discover/blind-spots.mjs');

  eq(classifyDrop('the title has no keyword from your field'), NO_FIELD, 'blind: no-keyword is the blind-spot bucket');
  eq(classifyDrop('the title has the blocked word "Senior"'), RULE, 'blind: a veto that fired is the other bucket');
  eq(ruleOf('the title has the blocked word "Technician"'), 'Technician', 'blind: the report names the rule, not the sentence');

  // ➤ THE REPORT MUST PRINT THE WHOLE TITLE. It used to cut at a fixed width,
  // ➤ so "Digital Product Manager - Energy Forecast Products" arrived clipped
  // ➤ mid-word — and a blind spot you cannot read is one you cannot act on.
  {
    const long = 'Offshore Wind Asset Integrity and Reliability Engineer for Floating Foundations';
    const ruled = 'Digital Product Manager - Energy Forecast Products';
    const report = formatReport({ updated: 'd1', titles: {
      a: { title: long, why: 'no keyword from your field', bucket: NO_FIELD, n: 4 },
      b: { title: ruled, why: 'the title has the blocked word "Manager"', bucket: RULE, n: 3 },
    } });
    // ➤ Wrapped titles span lines, so the comparison is made on the unwrapped text.
    const flat = report.replace(/\n\s+/g, ' ');
    ok(flat.includes(long), 'blind: a long title is wrapped, never cut');
    ok(flat.includes(ruled), 'blind: and so is one in the rule bucket');
    ok(report.split('\n').every(l => l.length <= 80), 'blind: while every line still fits a phone screen');

    // ➤ EACH SECTION SAYS HOW MANY IT IS NOT SHOWING. It used to print its top
    // ➤ few and stop, which reads as "that is all of them" — and the difference
    // ➤ between 12 recurring blind spots and 300 is the whole picture.
    const many = {};
    for (let i = 0; i < 40; i++) many['b' + i] = { title: `Blind Title ${i}`, bucket: NO_FIELD, n: 40 - i, why: 'no keyword from your field' };
    const big = formatReport({ updated: 'd1', titles: many });
    ok(/showing the top 12 of 39/.test(big), 'blind: the section says how many it is leaving out');
    ok(!/showing the top/.test(report), 'blind: and says nothing when it is showing them all');

    // ➤ THE WHOLE REPORT GOES OUT AS ONE MESSAGE, and Telegram refuses anything
    // ➤ over 4096 characters outright — no message at all. Now that titles are
    // ➤ printed whole, the length depends on what the boards publish, so the
    // ➤ budget is measured ESCAPED: the command sends it inside <pre>, where one
    // ➤ "&" becomes five characters.
    const escaped = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const [name, word] of [['long words', 'Palabra '], ['ampersands', 'R&D '], ['angle brackets', '<x> ']]) {
      const hostile = {};
      for (let i = 0; i < 12; i++) hostile['b' + i] = { title: word.repeat(80).trim(), bucket: NO_FIELD, n: 40 - i };
      for (let i = 0; i < 6; i++) hostile['r' + i] = { title: word.repeat(80).trim(), bucket: RULE, n: 20 - i, why: 'the title has the blocked word "Manager"' };
      const report2 = formatReport({ updated: 'd1', titles: hostile });
      ok(`<pre>${escaped(report2)}</pre>`.length < 4096, `blind: a report full of ${name} still fits one Telegram message`);
      // ➤ AND IT SAYS WHY IT IS SHORT. A section whose entries did not fit used
      // ➤ to print "nothing has recurred yet" next to "showing the top 0 of 6" —
      // ➤ two answers, one of them false.
      ok(!/showing the top 0 of/.test(report2), 'blind: a section that fits nothing does not claim to show nothing');
      if (/this message is full/.test(report2)) {
        ok(!/nothing has recurred yet/.test(report2), 'blind: and does not call a full message an empty record');
      }
    }

    // ➤ And a reason that does not match the "blocked word" shape is wrapped like
    // ➤ everything else, rather than running off the side of the screen.
    const oddReason = formatReport({ updated: 'd1', titles: {
      a: { title: 'Short', bucket: RULE, n: 3, why: 'rejected because ' + 'reason '.repeat(20) },
    } });
    ok(oddReason.split('\n').every(l => l.length <= 80), 'blind: an unusual reason wraps too');
  }

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
    // ➤ Sized against MAX_TITLES rather than a number written here, so raising
    // ➤ the ceiling does not quietly turn this into a test of nothing.
    const flood = Array.from({ length: MAX_TITLES + 100 }, (_, i) => ({ title: `Flood ${i}`, why: noField }));
    const defaulted = mergeDrops({ titles: {} }, flood, { today: 'd1' });
    eq(Object.keys(defaulted.titles).length, MAX_TITLES, 'blind: the default cap is finite and is MAX_TITLES');

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

// ── 18) The location written to pipeline.md keeps its country ─────────
// ➤ It used to be cut at 70 characters before being stored, and housekeep
// ➤ re-reads that stored text weeks later to decide whether the country is
// ➤ still one you accept. 35 of 993 real locations were long enough to be cut.
{
  const { normalizeLocation, MAX_LOCATION_CHARS } = await import('./scan.mjs');

  eq(normalizeLocation('España, España'), 'España', 'location: a repeated part is written once');
  const long = 'Steinbecker Vorstadt, Greifswald, Mecklenburg-Vorpommern, Bundesrepublik Deutschland';
  eq(normalizeLocation(long), long, 'location: a long one keeps the country at its end');
  ok(!normalizeLocation(long).includes('…'), 'location: and is not marked as cut, because it is not');

  // ➤ The ceiling that remains is a guard against a feed pasting a paragraph
  // ➤ into the field, and it must sit far above anything real (longest: 88).
  const absurd = normalizeLocation('Rotterdam, ' + 'Zuid-Holland, '.repeat(80));
  ok(absurd.length <= MAX_LOCATION_CHARS, 'location: an absurd one is still bounded');
  ok(MAX_LOCATION_CHARS >= 200, 'location: and that bound is nowhere near a real location');
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
