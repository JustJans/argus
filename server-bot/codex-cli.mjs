// ➤ The single place from which Argus calls Codex, OpenAI's CLI — the twin of
// ➤ claude-cli.mjs, so a user with a ChatGPT plan instead of a Claude one gets the letters
// ➤ and the Council. Kept to the smallest surface the CLI documents for scripts: the
// ➤ prompt goes in on stdin, the final answer comes out in a file (-o), the sandbox is
// ➤ read-only. Anything beyond that is optional and dropped, with one retry, the day a
// ➤ version rejects it — flags come and go between releases; those three have not.
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

// ➤ Where the "codex" program lives. Cron starts with a minimal PATH, so the usual global
// ➤ npm locations are tried first; on Windows npm installs a .cmd shim, which needs a shell.
const WIN = process.platform === 'win32';
export const CODEX_BIN = (WIN ? [] : [
  '/usr/local/bin/codex', '/usr/bin/codex',
  join(homedir(), '.npm-global', 'bin', 'codex'), join(homedir(), '.local', 'bin', 'codex'),
]).find(p => existsSync(p)) || (WIN ? 'codex.cmd' : 'codex');

// ➤ Find the program before spawning it, so "not installed" is one clear answer instead of
// ➤ the shell's localised complaint: a bare name is looked up along PATH (with the .cmd and
// ➤ .exe endings Windows uses), a path is taken as given.
export function resolveBin(bin, path = process.env.PATH || '') {
  if (/[\\/]/.test(bin)) return existsSync(bin) ? bin : null;
  const exts = WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(path).split(WIN ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) { const p = join(dir, bin + ext); if (existsSync(p)) return p; }
  }
  return null;
}

// ➤ Is there a Codex login on this machine? Its credentials live in $CODEX_HOME/auth.json.
export function codexLoggedIn() {
  return existsSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'));
}

// ➤ The CLI complaining instead of answering, in its own words: the usage-limit banner of
// ➤ the ChatGPT plans, the 401 a missing login produces, and an argument a version no
// ➤ longer knows (that last one is not a failure yet: the call is retried without extras).
const LIMIT_SIGNS = [/you'?ve (?:hit|reached) your usage limit/i, /usage limit (?:reached|exceeded)/i];
const AUTH_SIGNS = [/401 unauthorized/i, /missing bearer/i, /not logged in/i, /please (?:log ?in|sign ?in)/i, /run `?codex login/i];
const ARGS_SIGNS = /unexpected argument|unrecognized (?:option|argument)|unknown (?:option|argument)/i;
const BUSY_SIGNS = /\b429\b|too many requests|rate limit/i;

// ➤ 'limit' | 'auth' | 'args' | null — null means a real answer.
export function codexErrorKind(out) {
  const s = String(out || '');
  if (!s.trim()) return null;
  if (LIMIT_SIGNS.some(re => re.test(s))) return 'limit';
  if (AUTH_SIGNS.some(re => re.test(s))) return 'auth';
  if (ARGS_SIGNS.test(s)) return 'args';
  if (s.length < 300 && BUSY_SIGNS.test(s)) return 'limit';
  return null;
}

// ➤ A human sentence for each failure, to send over Telegram.
export function codexErrorMessage(kind, raw) {
  if (kind === 'limit') return 'the Codex account is at its usage limit — try again when it resets';
  if (kind === 'timeout') return 'Codex ran out of time before finishing — ask again, it usually works second time';
  if (kind === 'auth') return 'Codex is not logged in on this machine (run: codex login — on a server without a browser, codex login --device-auth)';
  if (/ENOENT|not found|is not recognized/i.test(String(raw || ''))) {
    return 'the Codex CLI is not installed on this machine — it is only needed for cover letters and the Council '
      + '(install: npm i -g @openai/codex, then codex login). Searching works without it.';
  }
  return `Codex failed: ${String(raw || 'no output').replace(/\s+/g, ' ').slice(0, 180)}`;
}

// ➤ The command line, as a pure function so the tests can see it. The "required" part is
// ➤ the documented script interface; the "optional" part is the polish a version may drop:
// ➤ running outside a git checkout (an unzipped install is one), leaving no session files
// ➤ behind, and the reasoning effort the judges' tiers map to. Values go unquoted: the CLI
// ➤ takes a value that is not TOML as a literal string, and unquoted survives every shell.
export function codexArgs({ out, cwd, model = null, effort = null, withOptional = true }) {
  const required = ['exec', '-', '-o', out, '-s', 'read-only', '-C', cwd, ...(model ? ['-m', model] : [])];
  const optional = ['--skip-git-repo-check', '--ephemeral', ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])];
  return withOptional ? [...required, ...optional] : required;
}

// ➤ Runs codex headless and returns {ok, out, kind}, the same contract as runClaudeCli:
// ➤ `ok:false` means NOTHING usable came back and `out` must not be treated as content.
export function runCodexCli(prompt, { cwd, model = null, effort = null, timeoutMs = 6 * 60 * 1000, label = 'codex', bin = CODEX_BIN } = {}) {
  const outFile = join(tmpdir(), `argus-codex-${process.pid}-${randomBytes(4).toString('hex')}.txt`);
  const readAnswer = () => { try { return readFileSync(outFile, 'utf-8').trim(); } catch { return ''; } };
  const tidy = () => { try { unlinkSync(outFile); } catch { /* never written */ } };
  // ➤ On Windows the shim runs through the shell, so a path with a space needs its quotes.
  const shellSafe = a => (WIN && /\s/.test(a) ? `"${a}"` : a);
  const exe = resolveBin(bin);
  const attempt = withOptional => new Promise(resolve => {
    if (!exe) {
      console.log(`[${new Date().toISOString()}] ${label} FAILED (error): spawn ${bin} ENOENT`);
      resolve({ ok: false, out: `spawn ${bin} ENOENT`, kind: 'error' });
      return;
    }
    const args = codexArgs({ out: outFile, cwd, model, effort, withOptional }).map(shellSafe);
    const child = execFile(shellSafe(exe), args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: WIN, windowsHide: true },
      (err, stdout, stderr) => {
        const answer = readAnswer() || String(stdout || '').trim();
        tidy();
        if (err) {
          const raw = (String(stderr || '').trim() || answer || err.message || '').slice(-600);
          const kind = codexErrorKind(raw) || (err.killed ? 'timeout' : 'error');
          console.log(`[${new Date().toISOString()}] ${label} FAILED (${kind}): ${raw.replace(/\s+/g, ' ').slice(-300)}`);
          resolve({ ok: false, out: raw, kind });
          return;
        }
        // ➤ It "answered", but the answer is a complaint, or nothing at all → a failure too.
        const kind = codexErrorKind(answer) || (answer ? null : 'error');
        if (kind) {
          console.log(`[${new Date().toISOString()}] ${label} FAILED (${kind}, on output): ${(answer || 'no output').replace(/\s+/g, ' ').slice(0, 300)}`);
          resolve({ ok: false, out: answer, kind });
          return;
        }
        resolve({ ok: true, out: answer, kind: null });
      });
    child.stdin.on('error', () => { /* the process died before reading: the callback reports it */ });
    child.stdin.end(prompt);
  });
  return attempt(true).then(res => (res.kind === 'args' ? attempt(false) : res));
}
