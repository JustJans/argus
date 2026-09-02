// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the single place from which Argus calls Claude on the server. Every caller
// ➤ gets the same launcher, the same path lookup and the same reading of the CLI's own
// ➤ complaints (spend limit, login, not installed), which count as failures whichever
// ➤ channel they arrive on.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';

// ➤ Where the "claude" program lives. Cron starts with a minimal PATH (/usr/bin:/bin, no
// ➤ /usr/local/bin), so a bare "claude" is not enough.
export const CLAUDE_BIN = ['/usr/local/bin/claude', '/usr/bin/claude'].find(p => existsSync(p)) || 'claude';

// ➤ Unmistakable signatures of the claude program complaining instead of answering —
// ➤ DELIBERATELY the CLI's exact wording, so a real letter or verdict can never be
// ➤ mistaken for an error.
const LIMIT_SIGNS = [
  /you'?ve hit your (?:monthly |weekly |daily )?(?:spend|usage) limit/i,
  /claude\.ai\/settings\/usage/i,
  /(?:spend|usage|rate|monthly|weekly) limit (?:reached|exceeded)/i,
  /\bupgrade to (?:pro|max)\b.*\bcontinue\b/i,
];
const AUTH_SIGNS = [
  /not authenticated|please (?:log ?in|sign ?in)|invalid api key|oauth token (?:expired|invalid)/i,
  /\bcredentials? (?:missing|invalid|expired)\b/i,
];
// ➤ Generic overload wording: only trusted on a SHORT output, because these
// ➤ words could legitimately appear inside a long letter.
const BUSY_SIGNS = /\boverloaded\b|\btoo many requests\b|\b429\b|\bresets? at\b/i;

// ➤ Returns 'limit' | 'auth' | null for a piece of output. null = it is a real
// ➤ answer, not a complaint.
export function claudeErrorKind(out) {
  const s = String(out || '');
  if (!s.trim()) return null;
  if (LIMIT_SIGNS.some(re => re.test(s))) return 'limit';
  if (AUTH_SIGNS.some(re => re.test(s))) return 'auth';
  // ➤ Short + generic-overload wording = a complaint. A cover letter is 180-260
  // ➤ words and a verdict is JSON, so neither is a 300-char bare "overloaded".
  if (s.length < 300 && BUSY_SIGNS.test(s)) return 'limit';
  return null;
}

// ➤ A human sentence for each failure, to send over Telegram.
export function claudeErrorMessage(kind, raw) {
  if (kind === 'limit') return 'the Claude account is at its usage limit — try again when it resets';
  // ➤ Named apart from a plain error because the fix is different: nothing is
  // ➤ broken, it simply did not finish in time, and asking again often works.
  if (kind === 'timeout') return 'Claude ran out of time before finishing — ask again, it usually works second time';
  if (kind === 'auth') return 'Claude is not authenticated on this machine (run: claude setup-token, then save it to server-bot/claude-token.json)';
  // ➤ "ENOENT" = the claude program is not installed here: cover letters and the Council are
  // ➤ the only features that need it — a missing OPTIONAL extra, not a broken bot.
  if (/ENOENT|not found/i.test(String(raw || ''))) {
    return 'the Claude CLI is not installed on this machine — it is only needed for cover letters and the Council '
      + '(install: npm i -g @anthropic-ai/claude-code, then claude setup-token). Searching works without it.';
  }
  return `Claude failed: ${String(raw || 'no output').replace(/\s+/g, ' ').slice(0, 180)}`;
}

// ➤ Runs claude headless and returns {ok, out, kind}. `ok:false` means NOTHING usable came
// ➤ back — the caller must not treat `out` as content. tokenPath =
// ➤ server-bot/claude-token.json.
export function runClaudeCli(prompt, { tokenPath, cwd, model = 'sonnet', timeoutMs = 6 * 60 * 1000, label = 'claude' } = {}) {
  let tok = null;
  try { tok = JSON.parse(readFileSync(tokenPath, 'utf-8'))?.token || null; } catch { /* no token file */ }
  const env = { ...process.env, ...(tok ? { CLAUDE_CODE_OAUTH_TOKEN: tok } : {}) };
  return new Promise(resolve => {
    execFile(CLAUDE_BIN, ['-p', prompt, '--model', model, '--allowedTools', 'Read', '--max-turns', '6'],
      { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const outText = String(stdout || '').trim();
        // ➤ 1) IT ERRORED AT ALL → failure, even with output already on screen: the CLI exits 0
        // ➤ only when it has finished, so a non-zero exit means an unfinished answer.
        if (err) {
          const raw = (outText || stderr || err.message || '').slice(0, 500);
          const kind = claudeErrorKind(raw)
            || (err.killed ? 'timeout' : 'error');
          console.log(`[${new Date().toISOString()}] ${label} FAILED (${kind}): ${raw.replace(/\s+/g, ' ').slice(0, 300)}`);
          resolve({ ok: false, out: raw, kind });
          return;
        }
        // ➤ 2) THE FIX: it "answered", but the answer is a CLI complaint
        // ➤ (the spend-limit warning arrives on stdout) → also a failure.
        const kind = claudeErrorKind(outText);
        if (kind) {
          console.log(`[${new Date().toISOString()}] ${label} FAILED (${kind}, on stdout): ${outText.replace(/\s+/g, ' ').slice(0, 300)}`);
          resolve({ ok: false, out: outText, kind });
          return;
        }
        resolve({ ok: true, out: outText, kind: null });
      });
  });
}
