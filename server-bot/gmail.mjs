#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the read-only door to your Gmail. It exists so the bot can
// ➤ see what happened AFTER you applied — the rejection, the interview, the
// ➤ silence — which is the only signal in the whole system that does not come
// ➤ from your own opinion.
// ➤
// ➤ WHY IT CANNOT DELETE ANYTHING. Three locks, and only the first one matters:
// ➤   1. THE TOKEN ITSELF. It is issued for gmail.readonly, and Google enforces
// ➤      that on their side. If this file asked to delete a message, their
// ➤      server would refuse. The guarantee does not depend on this code being
// ➤      correct, which is the point: your mailbox is not protected by my care.
// ➤   2. ONE DOOR. Every call goes through get(), which hardcodes GET. There is
// ➤      no code path here that can send any other verb.
// ➤   3. A TEST reads this file and fails if a second verb ever appears in it.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { convert } from 'html-to-text';
import { readFileSync, writeFileSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const OAUTH_PATH = join(SCRIPT_DIR, 'gmail-oauth.json');
export const TOKEN_PATH = join(SCRIPT_DIR, 'gmail-token.json');

// ➤ The ONLY scope this bot ever asks for. Read-only, enforced by Google.
// ➤ Changing this line is changing what the bot is allowed to do, so a test
// ➤ pins it: nothing else may appear here without someone meaning it.
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ➤ Reads a JSON file, or returns null. Never throws: a missing token means
// ➤ "not set up yet", which every caller has to handle anyway.
function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

// ➤ Is there anything to read the mailbox WITH? Both halves are needed: the
// ➤ client that identifies the app, and the token that says you allowed it.
// ➤ Everything that touches mail asks this first, so that a bot without Gmail
// ➤ set up says so plainly instead of failing somewhere deeper.
export function gmailConfigured() {
  return !!(loadJson(OAUTH_PATH)?.client_id && loadJson(TOKEN_PATH)?.refresh_token);
}

// ➤ Writes the token file locked to the owner (0600), like every other secret
// ➤ here. chmod is a harmless no-op where there are no POSIX permissions.
export function saveToken(obj, path = TOKEN_PATH) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* not POSIX — ignore */ }
}

// ➤ Swaps the long-lived refresh token for a short-lived access token. This is
// ➤ the only POST in the file, it goes to Google's token endpoint and not to
// ➤ the mail API, and it carries no message id — it cannot touch a message.
export async function accessToken({ oauth = loadJson(OAUTH_PATH), token = loadJson(TOKEN_PATH), fetchImpl = fetch } = {}) {
  if (!oauth?.client_id) throw new Error(`no client_id: fill ${OAUTH_PATH}`);
  if (!token?.refresh_token) throw new Error(`not authorised yet: run gmail-auth.mjs`);
  const body = new URLSearchParams({
    client_id: oauth.client_id,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  // ➤ A Desktop client created with PKCE needs no secret here (Google marks
  // ➤ client_secret optional for installed apps). If one was ever configured,
  // ➤ it is sent; if not, the exchange works without it.
  if (oauth.client_secret) body.set('client_secret', oauth.client_secret);

  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => null);
  if (!j?.access_token) {
    // ➤ invalid_grant means the refresh token is dead: revoked, or the Gmail
    // ➤ password changed (Google kills Gmail-scoped tokens on a password
    // ➤ change). Say which, because the fix is to re-run the auth script.
    const why = j?.error === 'invalid_grant'
      ? 'the saved authorisation is no longer valid (revoked, or the account password changed). Re-run gmail-auth.mjs'
      : (j?.error_description || j?.error || `HTTP ${res.status}`);
    throw new Error(`gmail auth: ${why}`);
  }
  return j.access_token;
}

// ➤ THE ONLY DOOR. Every read goes through here and the verb is written in,
// ➤ not passed in: there is deliberately no way for a caller to choose it.
async function get(path, params, token, fetchImpl = fetch) {
  // ➤ params is a list of [key, value] pairs, not an object, because Gmail
  // ➤ expects metadataHeaders repeated once per header and an object can only
  // ➤ hold the key once — asking for From, Subject and Date would silently
  // ➤ come back with only the last one.
  const url = `${API}${path}?${new URLSearchParams(params || [])}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`gmail ${path}: ${j?.error?.message || `HTTP ${res.status}`}`);
  return j;
}

// ➤ The ids of the messages matching a Gmail search query (the same syntax you
// ➤ type in Gmail's own search box, e.g. 'label:Argus newer_than:30d').
// ➤ IT FOLLOWS THE PAGES (audit 2026-07-31). Gmail hands back at most 500 ids at
// ➤ a time plus a token for the next page, and that token used to be thrown
// ➤ away — so the search stopped dead after one page, without saying so. The
// ➤ search window starts at your OLDEST application and only ever gets longer,
// ➤ and Gmail answers newest-first, so as soon as the window held more than a
// ➤ page the OLDEST replies dropped off the end: those applications sat on "no
// ➤ reply" for ever even though the answer was in the mailbox. `max` is now the
// ➤ total number of ids wanted, not the size of one page.
// ➤ The number of pages is capped too, so a query that somehow never runs out
// ➤ cannot turn the mail run into a loop that never finishes.
export async function listMessageIds(query, { max = 50, token, fetchImpl = fetch, maxPages = 20 } = {}) {
  const t = token || await accessToken({ fetchImpl });
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < maxPages && ids.length < max; page++) {
    // ➤ Only ask for what is still missing, so the last page is not oversized.
    const params = [['q', query], ['maxResults', String(Math.min(500, max - ids.length))]];
    if (pageToken) params.push(['pageToken', pageToken]);
    const j = await get('/messages', params, t, fetchImpl);
    for (const m of j.messages || []) ids.push(m.id);
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;   // ➤ no next page: that was everything there is
  }
  return ids.slice(0, max);
}

// ➤ Walks the nested structure Gmail returns and decodes every part of one
// ➤ type. A list, not one string, because a message can carry the same type
// ➤ more than once (a reply quoting the mail before it).
function collect(part, mimeType, out = []) {
  if (!part) return out;
  if (part.mimeType === mimeType && part.body?.data) {
    try { out.push(Buffer.from(part.body.data, 'base64url').toString('utf-8')); } catch { /* undecodable part, skip it */ }
  }
  for (const p of part.parts || []) collect(p, mimeType, out);
  return out;
}

// ➤ How the HTML gets turned into words. Every one of these is here because of
// ➤ something that goes wrong without it:
// ➤   TABLES: half the ATS mails lay their text out in a table, and without
// ➤     dataTable the cells run together — "Puesto" + "Marine Engineer" comes
// ➤     out "PuestoMarine Engineer", a word that exists in no language and
// ➤     matches nothing. Same fault as the bullet lists in the offer filter.
// ➤   LINKS: the href would land in the text as a URL, and tracking URLs carry
// ➤     other companies' names inside them. The words stay, the address goes.
// ➤   IMAGES: alt text is "logo", "banner", or a whole marketing sentence.
const HTML_TO_TEXT = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', format: 'dataTable' },
  ],
};

// ➤ The words of a message, wherever they are.
// ➤ PLAIN TEXT WINS when there is any, so nothing that already worked changes.
// ➤ THE HTML FALLBACK IS THE POINT: it was assumed every ATS sends a text
// ➤ alternative, and counted on the real mailbox, 51 of 116 messages do NOT —
// ➤ 44% were being judged on the subject and the two lines of the snippet.
export function messageText(payload) {
  const plain = collect(payload, 'text/plain').join('\n').trim();
  if (plain) return plain;
  const html = collect(payload, 'text/html').join('\n').trim();
  return html ? convert(html, HTML_TO_TEXT) : '';
}

// ➤ How much of a message is enough to tell a rejection from an invitation.
// ➤ The verdict is in the opening; the rest is signature, legal and footer.
// ➤ Raised from 4,000 when the HTML fallback arrived: converted HTML runs much
// ➤ longer than a text alternative (navigation, tables, legal), and at 4,000
// ➤ 15 of 116 messages were already being cut off mid-message.
export const BODY_LIMIT = 20_000;

// ➤ One message: who sent it, the subject, the date, and the opening of the
// ➤ text. NOTHING HERE IS EVER WRITTEN TO DISK — the body is read, matched
// ➤ against your applications in memory, and dropped. What survives is the
// ➤ kind of message and its date. Measured before it was widened: reading the
// ➤ body found 3 outcomes the ~200-character snippet missed and changed no
// ➤ verdict it already had, so it adds reach without adding disagreement.
export async function messageSummary(id, { token, fetchImpl = fetch } = {}) {
  const t = token || await accessToken({ fetchImpl });
  const j = await get(`/messages/${encodeURIComponent(id)}`, [['format', 'full']], t, fetchImpl);
  const headers = Object.fromEntries((j.payload?.headers || []).map(h => [String(h.name).toLowerCase(), h.value]));
  return {
    id: j.id,
    from: headers.from || '',
    subject: headers.subject || '',
    date: headers.date || '',
    snippet: j.snippet || '',
    body: messageText(j.payload).replace(/\s+/g, ' ').trim().slice(0, BODY_LIMIT),
  };
}
