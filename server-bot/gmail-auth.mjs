#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the ONE-TIME authorisation for the Gmail reader. You run it,
// ➤ a browser opens, you approve, and it writes gmail-token.json. After that
// ➤ the bot renews itself and this file is never needed again.
// ➤ RUN IT ON A MACHINE WITH A BROWSER — your laptop, not the headless
// ➤ server. Google removed the old copy-the-code flow, so the reply has to
// ➤ come back to a little server this script opens on 127.0.0.1. Copy
// ➤ gmail-token.json to the server afterwards.
// ➤
// ➤ IT DOES NEED THE CLIENT SECRET, despite what the documentation says.
// ➤ Google's own page marks client_secret "Optional" for installed apps and
// ➤ states that they "cannot keep secrets" — so this was first written without
// ➤ one. Their token endpoint then answers "client_secret is missing". The
// ➤ documentation and the server disagree; the server wins. PKCE is still used
// ➤ (it is what protects the code in transit), the secret is simply required
// ➤ alongside it.
// ➤ WHAT IT ASKS FOR: gmail.readonly, and nothing else.
// ➤ RUN: node server-bot/gmail-auth.mjs
// ➤ ═══════════════════════════════════════════════════════════════════════

import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { SCOPE, AUTH_ENDPOINT, TOKEN_ENDPOINT, OAUTH_PATH, TOKEN_PATH, saveToken } from './gmail.mjs';

// ➤ base64url: the same bytes as base64 but with the three characters that
// ➤ mean something else inside a URL swapped out, and no padding.
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ➤ PKCE: we invent a random secret (the verifier), send only its HASH (the
// ➤ challenge) to Google, and reveal the verifier when redeeming the code.
// ➤ Anyone who intercepts the code cannot use it without the verifier, which
// ➤ never left this process. That is what replaces the client secret.
export function pkcePair() {
  const verifier = b64url(randomBytes(64));            // 86 chars, within 43-128
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ➤ The consent URL. Exported so a test can pick it apart without a browser.
export function buildAuthUrl({ clientId, redirectUri, challenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // ➤ offline is what makes Google issue a REFRESH token; without it we get
    // ➤ an access token that dies in an hour and the bot stops overnight.
    access_type: 'offline',
    // ➤ Forces the consent screen even if you have approved before, which is
    // ➤ the only way to be handed a refresh token on a second run.
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${p}`;
}

// ➤ THIS SCRIPT DOES NOT OPEN A BROWSER, ON PURPOSE.
// ➤ It used to try, and an OAuth URL turns out to be an awkward thing to hand
// ➤ to an operating system: `cmd /c start` reads the "&" between parameters as
// ➤ "end of command" and delivered only the first one, and rundll32 mangled it
// ➤ a different way and opened a mailto: link. Both failures looked like a bug
// ➤ in the URL, and the URL was correct every time.
// ➤ You run this once, ever. Printing the address and letting you click it is
// ➤ one second of your life and removes a whole class of platform bug from the
// ➤ one step where a confusing error is most expensive.

async function main() {
  let oauth;
  try { oauth = JSON.parse(readFileSync(OAUTH_PATH, 'utf-8')); } catch { oauth = null; }
  if (!oauth?.client_id) {
    console.error(`No client_id. Create ${OAUTH_PATH} with {"client_id": "...apps.googleusercontent.com"}`);
    process.exit(1);
  }
  // ➤ Checked BEFORE opening the browser. Without it Google accepts the
  // ➤ consent, hands back a code, and only then refuses to redeem it — so you
  // ➤ approve access, wait, and get an error, for a reason known up front.
  if (!oauth.client_secret || /PEGA|PASTE|\.\.\./i.test(oauth.client_secret)) {
    console.error(`No client_secret in ${OAUTH_PATH}.`);
    console.error('Google marks it optional for desktop apps but its token endpoint requires it.');
    console.error('Add one in the Cloud console (Clients > your client > Add secret) and paste it in.');
    process.exit(1);
  }

  const { verifier, challenge } = pkcePair();

  // ➤ A server on a random free port, listening only on the loopback address:
  // ➤ nothing outside this machine can reach it, and it lives for one request.
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out after 5 minutes waiting for the browser')), 5 * 60_000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      const got = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // ➤ Settle only once the reply has actually gone out, and close the
      // ➤ server from here rather than from a finally(). Tearing the loop down
      // ➤ while a response is still in flight is what produced a libuv
      // ➤ assertion on Windows instead of a readable error.
      res.end(got
        ? '<h2>Argus is authorised.</h2><p>You can close this tab and go back to the terminal.</p>'
        : `<h2>Authorisation failed</h2><p>${err || 'no code returned'}</p>`,
      () => {
        clearTimeout(timer);
        // ➤ Keep-alive sockets hold the server open; close them explicitly or
        // ➤ the process hangs after a perfectly successful authorisation.
        server.closeAllConnections?.();
        server.close(() => (got ? resolve(got) : reject(new Error(err || 'no code returned'))));
      });
    });

    const url = buildAuthUrl({ clientId: oauth.client_id, redirectUri, challenge });
    console.log('\n' + '='.repeat(72));
    console.log('OPEN THIS ADDRESS in a browser ON THIS MACHINE (ctrl+click, or copy it');
    console.log('whole — it is one line, and it must not be cut short):');
    console.log('='.repeat(72) + '\n');
    console.log(url + '\n');
    console.log('='.repeat(72));
    console.log('It asks for ONE permission: "View your email messages and settings".');
    console.log('If you are shown anything else, close the tab and say so.');
    console.log('Google will also warn the app is not verified — expected for a personal');
    console.log('app: choose Advanced, then "Go to Argus".');
    console.log('\nWaiting for you to approve (5 minutes)...');
  }).catch(e => { try { server.closeAllConnections?.(); server.close(); } catch {} throw e; });

  // ➤ Redeem the code. The verifier proves we are the same process that asked.
  const body = new URLSearchParams({
    client_id: oauth.client_id,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  // ➤ Always sent: the check above already refused to start without it.
  body.set('client_secret', oauth.client_secret);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => null);
  if (!j?.refresh_token) {
    console.error(`Authorisation failed: ${j?.error_description || j?.error || `HTTP ${res.status}`}`);
    if (j?.access_token) console.error('Google returned an access token but no refresh token. Re-run: the consent must be granted again.');
    process.exit(1);
  }

  // ➤ Only the refresh token is kept. The access token is short-lived and the
  // ➤ reader fetches a fresh one each run, so there is nothing to store.
  saveToken({ refresh_token: j.refresh_token, scope: j.scope || SCOPE, obtained: new Date().toISOString() });
  console.log(`Done. Authorisation saved to ${TOKEN_PATH} (owner-only).`);
  console.log(`Scope granted: ${j.scope || SCOPE}`);
  console.log('\nCopy that file to the server and the bot can read — and only read — your mail.');
}

if (process.argv[1] && /(^|[\\/])gmail-auth\.mjs$/.test(process.argv[1])) {
  main().catch(e => { console.error(String(e.message)); process.exit(1); });
}
