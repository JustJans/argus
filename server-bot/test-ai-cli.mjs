// ➤ The AI launchers, with NO real CLI: the pure rules (which backend, which flags, which
// ➤ complaint) and the Codex launcher driven against a stand-in program that behaves like
// ➤ the real one did when measured — final answer in the -o file, "unexpected argument"
// ➤ on exit 2, the usage-limit banner, the 401 of a missing login.
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { harness } from './test-harness.mjs';
import { codexErrorKind, codexErrorMessage, codexArgs, runCodexCli, resolveBin } from './codex-cli.mjs';
import { chooseBackend, readAiConfig } from './ai-cli.mjs';

const { ok, eq, done } = harness('ai-cli');

// ── The CLI's complaints, in its own words ──────────────────────────────
eq(codexErrorKind('ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'), 'auth', 'a 401 is a missing login');
eq(codexErrorKind('Not logged in'), 'auth', 'and so is "Not logged in"');
eq(codexErrorKind("🖐 You've hit your usage limit. Limits reset every 5h and every week."), 'limit', 'the plan banner is a limit');
eq(codexErrorKind("You've reached your usage limit. Upgrade your plan or try again after 3pm"), 'limit', 'in either wording');
eq(codexErrorKind('HTTP 429 Too Many Requests'), 'limit', 'a short 429 is a limit');
eq(codexErrorKind("error: unexpected argument '--ephemeral' found"), 'args', 'a flag this version does not know is its own kind');
eq(codexErrorKind('Dear Hiring Manager, I am writing to apply for the Mooring Engineer position. ' + 'x'.repeat(400)), null, 'a real letter is an answer');
eq(codexErrorKind('{"vote":"show","reason":"fits","confidence":0.8}'), null, 'and so is a verdict');
eq(codexErrorKind(''), null, 'nothing is not a complaint');
ok(/codex login/.test(codexErrorMessage('auth', '')), 'the login message says what to run');
ok(/device-auth/.test(codexErrorMessage('auth', '')), 'and names the headless way');
ok(/@openai\/codex/.test(codexErrorMessage('error', 'spawn codex ENOENT')), 'not installed says how to install');
ok(/@openai\/codex/.test(codexErrorMessage('error', "'codex' is not recognized as an internal or external command")), 'in cmd.exe wording too');
ok(/usage limit/.test(codexErrorMessage('limit', '')), 'the limit message says so');

// ── The command line: the documented core, plus the polish a version may drop ──
{
  const a = codexArgs({ out: '/tmp/o.txt', cwd: '/srv/argus', model: null, effort: 'low' });
  eq(a.slice(0, 8), ['exec', '-', '-o', '/tmp/o.txt', '-s', 'read-only', '-C', '/srv/argus'], 'prompt on stdin, answer to a file, read-only, in the bot folder');
  ok(a.includes('--skip-git-repo-check') && a.includes('--ephemeral'), 'the optional flags ride along by default');
  ok(a.includes('model_reasoning_effort=low') && !a.some(x => x.includes('"')), 'the effort goes unquoted — a value that is not TOML is taken literally');
  ok(!a.includes('-m'), 'no model is named unless asked: today\'s default name will not be tomorrow\'s');
  const b = codexArgs({ out: 'o', cwd: 'c', model: 'gpt-x', effort: null, withOptional: false });
  eq(b, ['exec', '-', '-o', 'o', '-s', 'read-only', '-C', 'c', '-m', 'gpt-x'], 'without the optional part only the core stays, plus the model when named');
}

// ── Which backend ───────────────────────────────────────────────────────
eq(chooseBackend({ backend: 'codex', hasClaudeToken: true }), 'codex', 'an explicit choice wins over what is installed');
eq(chooseBackend({ backend: 'claude', hasCodexLogin: true }), 'claude', 'either way');
eq(chooseBackend({ backend: 'auto', hasClaudeToken: true, hasCodexLogin: true }), 'claude', 'auto: Claude first when its token exists');
eq(chooseBackend({ backend: 'auto', hasClaudeToken: false, hasCodexLogin: true }), 'codex', 'auto: Codex when only it is logged in');
eq(chooseBackend({ backend: 'auto' }), 'claude', 'auto on a bare machine: Claude, so the error names both');
eq(chooseBackend({}), 'claude', 'no settings at all reads as auto');
{
  const dir = join(tmpdir(), `argus-ai-cfg-${process.pid}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const p = join(dir, 'portals.yml');
  writeFileSync(p, 'ai:\n  backend: codex\n  codex_model: gpt-x\n');
  eq(readAiConfig(p), { backend: 'codex', codex_model: 'gpt-x' }, 'the ai block is read');
  writeFileSync(p, 'ai:\n  backend: something-else\n  codex_model: ""\n');
  eq(readAiConfig(p), { backend: 'auto', codex_model: null }, 'a backend that is not one of the three reads as auto, an empty model as none');
  writeFileSync(p, 'council:\n  enabled: false\n');
  eq(readAiConfig(p), { backend: 'auto', codex_model: null }, 'no ai block: auto');
  eq(readAiConfig(join(dir, 'missing.yml')), { backend: 'auto', codex_model: null }, 'no file: auto, not a crash');
  rmSync(dir, { recursive: true, force: true });
}

// ── The launcher against a stand-in codex ───────────────────────────────
const dir = join(tmpdir(), `argus-fake-codex-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const fakeJs = join(dir, 'fake-codex.js');
const argvLog = join(dir, 'argv.json');
writeFileSync(fakeJs, [
  "const fs = require('fs');",
  'const argv = process.argv.slice(2);',
  "const mode = process.env.FAKE_CODEX_MODE || 'ok';",
  "const out = argv[argv.indexOf('-o') + 1];",
  "let stdin = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', d => { stdin += d; });",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(" + JSON.stringify(argvLog) + ", JSON.stringify(argv));",
  "  if (mode === 'reject-optional' && argv.includes('--ephemeral')) { process.stderr.write(\"error: unexpected argument '--ephemeral' found\\n\"); process.exit(2); }",
  "  if (mode === 'auth') { process.stderr.write('ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\\n'); process.exit(1); }",
  "  if (mode === 'limit') { fs.writeFileSync(out, \"You've hit your usage limit. Limits reset every 5h and every week.\"); process.exit(0); }",
  "  if (mode === 'silent') { process.exit(0); }",
  "  process.stderr.write('progress goes to stderr\\n');",
  "  fs.writeFileSync(out, 'ANSWER: ' + stdin.length + ' chars');",
  '  process.exit(0);',
  '});',
].join('\n'));
let bin;
if (process.platform === 'win32') {
  bin = join(dir, 'codex.cmd');
  writeFileSync(bin, `@node "${fakeJs}" %*\r\n`);
} else {
  bin = join(dir, 'codex');
  writeFileSync(bin, `#!/bin/sh\nexec node "${fakeJs}" "$@"\n`);
  chmodSync(bin, 0o755);
}
eq(resolveBin(join(dir, 'no-such-codex')), null, 'a path that does not exist resolves to nothing');
eq(resolveBin(bin), bin, 'a path that exists is taken as given');
eq(resolveBin('codex', dir), bin, 'a bare name is found along PATH, with the ending this platform uses');
eq(resolveBin('codex', join(dir, 'empty-dir-that-is-not-there')), null, 'and not found when PATH has nothing');
const run = (mode, opts = {}) => { process.env.FAKE_CODEX_MODE = mode; return runCodexCli('Hello there', { cwd: dir, effort: 'low', timeoutMs: 30_000, bin, label: 'test codex', ...opts }); };

{
  const r = await run('ok');
  eq([r.ok, r.kind, r.out], [true, null, 'ANSWER: 11 chars'], 'the prompt arrives whole on stdin and the answer comes back from the -o file');
  const argv = JSON.parse(readFileSync(argvLog, 'utf-8'));
  ok(argv.includes('--ephemeral') && argv.includes('model_reasoning_effort=low'), 'the first attempt carries the optional flags');
  ok(!existsSync(argv[argv.indexOf('-o') + 1]), 'the answer file is swept up afterwards');
}
{
  const r = await run('reject-optional');
  eq([r.ok, r.out], [true, 'ANSWER: 11 chars'], 'a version that rejects an optional flag is asked again without them, and answers');
  const argv = JSON.parse(readFileSync(argvLog, 'utf-8'));
  ok(!argv.includes('--ephemeral') && !argv.includes('--skip-git-repo-check') && !argv.includes('-c'), 'the retry carries only the documented core');
  eq(argv.slice(0, 2), ['exec', '-'], 'and still reads the prompt from stdin');
}
{
  const r = await run('limit');
  eq([r.ok, r.kind], [false, 'limit'], 'the usage banner printed as the answer is a failure, never a letter');
}
{
  const r = await run('auth');
  eq([r.ok, r.kind], [false, 'auth'], 'a 401 on stderr with exit 1 is a missing login');
  ok(/codex login/.test(codexErrorMessage(r.kind, r.out)), 'and the message says what to run');
}
{
  const r = await run('silent');
  eq([r.ok, r.kind], [false, 'error'], 'exit 0 with nothing written is not an answer');
}
{
  const r = await run('ok', { bin: join(dir, 'no-such-codex') });
  ok(!r.ok && /@openai\/codex/.test(codexErrorMessage(r.kind, r.out)), 'a missing program says how to install it');
}
delete process.env.FAKE_CODEX_MODE;
rmSync(dir, { recursive: true, force: true });

done();
