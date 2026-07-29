// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the single place from which Argus calls Claude on the server.
// ➤ WHY IT EXISTS: cover-letter.mjs and argus-council/engine.mjs each had their OWN
// ➤ copy of this, and the copies drifted — the Council one never learned to tell
// ➤ a "you ran out of credit" from a real answer.
// ➤ THE BUG IT FIXES (2026-07-25 audit, seen for real on 2026-07-24): when the
// ➤ account hits its monthly spend limit, the claude program prints the warning
// ➤ on its NORMAL output (stdout), not on the error channel. The old check was
// ➤ "failed only if it errored AND printed nothing", so that warning was taken
// ➤ for a valid answer: it ended up as the BODY of a cover-letter PDF ("Dear
// ➤ Hiring Manager, You've hit your monthly spend limit...") and as the three
// ➤ judges' reasoning in the Council journal. Now the text is inspected: if it
// ➤ looks like a CLI complaint, it is a FAILURE, whichever channel it arrived on.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';

// ➤ Where the "claude" program lives. WATCH OUT: the user cron starts with a
// ➤ minimal PATH (/usr/bin:/bin) with no /usr/local/bin, and a bare "claude"
// ➤ gave "spawn claude ENOENT" in production (real case: cover 594, 2026-07-18).
export const CLAUDE_BIN = ['/usr/local/bin/claude', '/usr/bin/claude'].find(p => existsSync(p)) || 'claude';

// ➤ Unmistakable signatures of the claude program complaining instead of
// ➤ answering. Kept DELIBERATELY specific (the exact wording of the CLI) so a
// ➤ real cover letter or a judge's verdict can never be mistaken for an error.
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
  if (kind === 'auth') return 'Claude is not authenticated on this machine (run: claude setup-token, then save it to server-bot/claude-token.json)';
  // ➤ "ENOENT" = the claude program is not installed here. Worth saying plainly:
  // ➤ cover letters and the Council are the only features that need it, so this
  // ➤ is a missing OPTIONAL extra, not a broken bot.
  if (/ENOENT|not found/i.test(String(raw || ''))) {
    return 'the Claude CLI is not installed on this machine — it is only needed for cover letters and the Council '
      + '(install: npm i -g @anthropic-ai/claude-code, then claude setup-token). Searching works without it.';
  }
  return `Claude failed: ${String(raw || 'no output').replace(/\s+/g, ' ').slice(0, 180)}`;
}

// ➤ Runs claude headless and returns {ok, out, kind}. `ok:false` means NOTHING
// ➤ usable came back — the caller must not treat `out` as content.
// ➤ tokenPath = server-bot/claude-token.json (the stored session).
export function runClaudeCli(prompt, { tokenPath, cwd, model = 'sonnet', timeoutMs = 6 * 60 * 1000, label = 'claude' } = {}) {
  let tok = null;
  try { tok = JSON.parse(readFileSync(tokenPath, 'utf-8'))?.token || null; } catch { /* no token file */ }
  const env = { ...process.env, ...(tok ? { CLAUDE_CODE_OAUTH_TOKEN: tok } : {}) };
  return new Promise(resolve => {
    execFile(CLAUDE_BIN, ['-p', prompt, '--model', model, '--allowedTools', 'Read', '--max-turns', '6'],
      { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const outText = String(stdout || '').trim();
        // ➤ 1) It errored and said nothing usable → failure (as before).
        if (err && !outText) {
          const raw = (stderr || err.message || '').slice(0, 500);
          const kind = claudeErrorKind(raw) || 'error';
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
