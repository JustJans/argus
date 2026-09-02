// ➤ Which AI CLI answers: Claude Code or Codex. The letter writer and the Council ask here
// ➤ and never name a program, so a user brings whichever plan they already pay for. The
// ➤ choice comes from portals.yml (ai.backend: auto | claude | codex); "auto" takes Claude
// ➤ when its token file exists, otherwise Codex when it is logged in, otherwise Claude — so
// ➤ the error a bare machine gets is the familiar one, naming both.
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { runClaudeCli, claudeErrorMessage } from './claude-cli.mjs';
import { runCodexCli, codexErrorMessage, codexLoggedIn } from './codex-cli.mjs';

const SERVERBOT = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SERVERBOT);
const TOKEN_PATH = join(SERVERBOT, 'claude-token.json');
const PORTALS_PATH = join(ROOT, 'portals.yml');

export function readAiConfig(portalsPath = PORTALS_PATH) {
  try {
    const ai = yaml.load(readFileSync(portalsPath, 'utf-8'))?.ai || {};
    return {
      backend: ['auto', 'claude', 'codex'].includes(ai.backend) ? ai.backend : 'auto',
      codex_model: typeof ai.codex_model === 'string' && ai.codex_model.trim() ? ai.codex_model.trim() : null,
    };
  } catch { return { backend: 'auto', codex_model: null }; }
}

// ➤ Pure, so the rule can be tested: an explicit choice wins; "auto" reads the machine.
export function chooseBackend({ backend = 'auto', hasClaudeToken = false, hasCodexLogin = false } = {}) {
  if (backend === 'claude' || backend === 'codex') return backend;
  if (hasClaudeToken) return 'claude';
  if (hasCodexLogin) return 'codex';
  return 'claude';
}

// ➤ The judges' tiers are Claude's model names; on Codex they become reasoning effort on
// ➤ the CLI's default model (or ai.codex_model), so nothing here has to know today's names.
const EFFORT = { haiku: 'low', sonnet: 'medium', opus: 'high' };

let _backend = null;
export function aiBackend() {
  if (!_backend) {
    const cfg = readAiConfig();
    _backend = chooseBackend({ backend: cfg.backend, hasClaudeToken: existsSync(TOKEN_PATH), hasCodexLogin: codexLoggedIn() });
  }
  return _backend;
}

// ➤ Runs the chosen CLI and returns {ok, out, kind} — the one contract both launchers keep.
export function runAi(prompt, { model = 'sonnet', cwd = ROOT, timeoutMs, label } = {}) {
  if (aiBackend() === 'codex') {
    const cfg = readAiConfig();
    return runCodexCli(prompt, {
      cwd,
      model: EFFORT[model] ? cfg.codex_model : model,
      effort: EFFORT[model] || null,
      timeoutMs,
      label: String(label || 'codex').replace(/^claude\b/, 'codex'),
    });
  }
  return runClaudeCli(prompt, { tokenPath: TOKEN_PATH, cwd, model, timeoutMs, label });
}

export function aiErrorMessage(kind, raw) {
  return aiBackend() === 'codex' ? codexErrorMessage(kind, raw) : claudeErrorMessage(kind, raw);
}
