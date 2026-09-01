#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the guard on the Gmail reader. Its job is not to check that
// ➤ reading works — it is to check that WRITING cannot.
// ➤ WHY IT IS SHAPED LIKE THIS: the real guarantee is the token, which Google
// ➤ issues read-only and enforces on their side. These tests defend the layer
// ➤ below it: that this repository never grows a call that would try.
// ➤ Some of them read the source file as text. That is deliberate. A test that
// ➤ only exercises the functions cannot see a new function someone adds later.
// ➤ RUN: node server-bot/test-gmail.mjs   (part of `npm test`)
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SCOPE, AUTH_ENDPOINT, TOKEN_ENDPOINT, BODY_LIMIT, accessToken, listMessageIds, messageSummary, messageText } from './gmail.mjs';
import { buildAuthUrl, pkcePair } from './gmail-auth.mjs';
import { harness } from './test-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { ok, eq, done } = harness('gmail');

// ── 1) The scope is read-only, and pinned ─────────────────────────────────
{
  eq(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly', 'the scope is exactly gmail.readonly');
  ok(!/\.modify|\.compose|\.send|mail\.google\.com|\.insert|\.settings\.b/.test(SCOPE), 'no write-capable scope is requested');
}

// ── 2) No verb other than GET may exist in the Gmail reader ───────────────
// ➤ Read as TEXT on purpose: this catches a call added tomorrow by someone who
// ➤ never runs the function it lives in.
{
  const src = readFileSync(join(HERE, 'gmail.mjs'), 'utf-8');
  const verbs = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map(m => m[1]);
  // ➤ One POST is expected and only one: the token refresh, which talks to
  // ➤ Google's auth endpoint and cannot name a message.
  eq(verbs.filter(v => v !== 'GET' && v !== 'POST'), [], 'no verb other than GET or POST appears');
  eq(verbs.filter(v => v === 'POST').length, 1, 'exactly one POST exists (the token refresh)');
  ok(/TOKEN_ENDPOINT, \{\s*\n\s*method: 'POST'/.test(src) || src.includes("fetchImpl(TOKEN_ENDPOINT, {"), 'and that POST goes to the token endpoint, not the mail API');

  // ➤ The destructive Gmail endpoints, by name. None may be mentioned at all.
  for (const danger of ['/trash', '/untrash', '/batchDelete', '/batchModify', '/modify', '/send', '/drafts', '/import']) {
    ok(!src.includes(danger), `the reader never names ${danger}`);
  }
  ok(!/\bmethod:\s*'DELETE'/.test(src), 'the word DELETE never appears as a verb');

  // ➤ The verb must be WRITTEN IN, never passed in. A `method: verb` — even
  // ➤ one defaulting to GET — hands the choice to whoever calls next, and the
  // ➤ checks above would not notice: the default keeps the literal 'GET' in
  // ➤ the file. So every method: must be followed by a quoted constant.
  const assigned = [...src.matchAll(/method:\s*([^,\n}]+)/g)].map(m => m[1].trim());
  eq(assigned.filter(v => !/^'(GET|POST)'$/.test(v)), [], 'every verb is a literal, never a variable');

  // ➤ And the one door takes no verb argument of its own.
  const sig = (src.match(/async function get\(([^)]*)\)/) || [])[1] || '';
  ok(!/verb|method/i.test(sig), 'the internal getter accepts no verb parameter');
}

// ── 3) The reader really only issues GET, at runtime ──────────────────────
// ➤ The text check above can be fooled by a computed verb. This one watches
// ➤ what actually goes out.
{
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push({ url: String(url), method: opts?.method });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'abc' }], id: 'abc', snippet: 's', payload: { headers: [] } }) };
  };
  await listMessageIds('label:Argus', { token: 'fake-access-token', fetchImpl: fakeFetch });
  await messageSummary('abc', { token: 'fake-access-token', fetchImpl: fakeFetch });
  eq(seen.map(s => s.method), ['GET', 'GET'], 'both mail calls went out as GET');
  ok(seen.every(s => s.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me')), 'and to the Gmail API only');
  // ➤ The body IS fetched, and that was a deliberate change: measured, it
  // ➤ found 3 outcomes the ~200-character snippet missed and changed no
  // ➤ verdict it already had. The guarantee moved rather than disappeared —
  // ➤ it is read and dropped, never written. Block 7 holds it to that.
  ok(seen[1].url.includes('format=full'), 'the message is fetched in full');
  // ➤ IT FOLLOWS THE PAGES (audit 2026-07-31). Gmail returns at most 500 ids
  // ➤ and a token for the next page; that token was discarded, so the search
  // ➤ silently stopped at one page. Because Gmail answers newest-first and the
  // ➤ search window starts at the OLDEST application, the messages that fell
  // ➤ off were the oldest — and those applications stayed on "no reply" for
  // ➤ ever with nothing said.
  {
    const pages = [
      { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
      { messages: [{ id: 'c' }], nextPageToken: 'p3' },
      { messages: [{ id: 'd' }] },                       // no token: the end
    ];
    const urls = [];
    let i = 0;
    const paged = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => pages[i++] }; };
    const ids = await listMessageIds('q', { token: 'x', fetchImpl: paged, max: 100 });
    eq(ids, ['a', 'b', 'c', 'd'], 'every page is read, not just the first');
    eq(urls.length, 3, 'and it stops as soon as there is no next page');
    ok(urls[1].includes('pageToken=p2'), 'the second call asks for the second page');

    // ➤ The total wanted is respected, so a huge mailbox cannot run away.
    let k = 0;
    const endless = async () => { k++; return { ok: true, status: 200, json: async () => ({ messages: [{ id: `m${k}` }], nextPageToken: 'more' }) }; };
    const capped = await listMessageIds('q', { token: 'x', fetchImpl: endless, max: 3 });
    eq(capped.length, 3, 'it stops at the number asked for');

    // ➤ And a query that never ends cannot loop for ever.
    let n = 0;
    const forever = async () => { n++; return { ok: true, status: 200, json: async () => ({ messages: [{ id: `x${n}` }], nextPageToken: 'more' }) }; };
    await listMessageIds('q', { token: 'x', fetchImpl: forever, max: 1e9, maxPages: 4 });
    eq(n, 4, 'the number of pages is bounded');
  }
  ok(!seen[1].url.includes('format=raw'), 'but never as raw MIME');
  // ➤ Bounded — still. The ceiling went up with the HTML fallback (converted
  // ➤ markup runs far longer than a text alternative) but "bounded" is the
  // ➤ property being pinned, not the number: without one, a long quoted thread
  // ➤ would be held in memory whole.
  ok(BODY_LIMIT > 0 && BODY_LIMIT <= 50_000, 'and the body kept is bounded');
}

// ── 4) A dead authorisation must say so, not fail obscurely ───────────────
{
  const dead = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  let msg = '';
  try {
    await accessToken({ oauth: { client_id: 'x' }, token: { refresh_token: 'y' }, fetchImpl: dead });
  } catch (e) { msg = e.message; }
  ok(/no longer valid/i.test(msg) && /gmail-auth/.test(msg), 'a revoked token explains itself and names the fix');

  let missing = '';
  try { await accessToken({ oauth: { client_id: 'x' }, token: null, fetchImpl: dead }); }
  catch (e) { missing = e.message; }
  ok(/not authorised yet/i.test(missing), 'a missing token says it was never set up');
}

// ── 5) The authorisation URL ──────────────────────────────────────────────
{
  const { verifier, challenge } = pkcePair();
  ok(verifier.length >= 43 && verifier.length <= 128, 'the PKCE verifier is a legal length');
  ok(challenge !== verifier, 'the challenge is a hash of the verifier, not the verifier');
  ok(!/[+/=]/.test(challenge), 'the challenge is base64url, with no padding or unsafe characters');

  const url = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:1234', challenge }));
  eq(`${url.origin}${url.pathname}`, AUTH_ENDPOINT, 'it points at Google, not at us');
  eq(url.searchParams.get('scope'), SCOPE, 'it asks for the read-only scope and nothing more');
  eq(url.searchParams.get('code_challenge_method'), 'S256', 'PKCE uses S256, not plain');
  eq(url.searchParams.get('response_type'), 'code', 'it is the authorisation-code flow');
  eq(url.searchParams.get('access_type'), 'offline', 'offline, so a refresh token is issued at all');
  ok(url.searchParams.get('redirect_uri').startsWith('http://127.0.0.1:'), 'the reply comes back to this machine only');
  ok(!url.search.includes('client_secret'), 'no secret travels in the URL');
  eq(TOKEN_ENDPOINT, 'https://oauth2.googleapis.com/token', 'the token endpoint is Google\'s');
}

// ── 6) The script must not try to open a browser itself ─────────────
// ➤ Two attempts, two different corruptions of the same correct URL: cmd
// ➤ cut it at the first "&", rundll32 turned it into a mailto:. Both looked
// ➤ like a bug in the URL. The address is now printed for you to click, and
// ➤ this test keeps it that way.
{
  // ➤ Comments are stripped first: the file EXPLAINS why it does not open a
  // ➤ browser, and naming rundll32 in that explanation must not read as using
  // ➤ it. A test that cannot tell code from prose deletes its own documentation.
  const src = readFileSync(join(HERE, 'gmail-auth.mjs'), 'utf-8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const opener of ['rundll32', 'xdg-open', 'Start-Process', 'FileProtocolHandler']) {
    ok(!src.includes(opener), `the code never shells out to ${opener}`);
  }
  for (const spawner of ['execFile(', 'spawn(', 'exec(', 'execSync(', "from 'child_process'"]) {
    ok(!src.includes(spawner), `it never reaches for ${spawner}`);
  }
  const url = buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:1234', challenge: 'abc' });
  ok(url.includes('&') && !/\s/.test(url), 'the URL is one unbroken line, so copying it whole is possible');
}

// ── 7) The body is read, and never written ──────────────────────
// ➤ Block 3 used to guarantee the body never left Gmail. It does now, because
// ➤ the clues are in it. So the guarantee has to hold one step later: what
// ➤ lands on disk is the KIND of message and its date, never a word of your
// ➤ mail. If that ever stops being true, this fails.
{
  const { buildStatus } = await import('./argus-mail/status.mjs');
  const apps = [{ id: 1, company: 'Acme', title: 'Engineer', ts: '2026-07-01T09:00:00Z' }];
  const links = [{
    application: apps[0],
    why: ['company'],
    score: 13,
    message: {
      id: 'm1',
      kind: 'rejected',
      date: '2026-07-02T09:00:00Z',
      from: 'Someone Private <person@example.com>',
      subject: 'A subject that must not be stored',
      snippet: 'a snippet that must not be stored',
      body: 'THE BODY OF THE EMAIL WHICH MUST NEVER REACH DISK',
    },
  }];
  const written = JSON.stringify(buildStatus(apps, links, { today: new Date('2026-07-10T00:00:00Z') }));

  ok(!written.includes('THE BODY OF THE EMAIL'), 'the body is not in what gets written');
  ok(!written.includes('must not be stored'), 'neither the subject nor the snippet is');
  ok(!written.includes('person@example.com'), 'nor the sender');
  ok(!written.includes('Someone Private'), 'nor their name');
  // ➤ What SHOULD survive: enough to say what happened and when.
  ok(written.includes('rejected'), 'the kind of message does survive');
  ok(written.includes('2026-07-02'), 'and its date');
}

// ── 8) Getting the words out of a message, whatever shape it arrives in ───
// ➤ It was assumed every ATS sends a plain-text alternative alongside the
// ➤ HTML. Counted on the real mailbox: 51 of 116 messages send only HTML, so
// ➤ 44% were being judged on the subject and two lines of snippet.
{
  const b64 = s => Buffer.from(s, 'utf-8').toString('base64url');
  const plainPart = t => ({ mimeType: 'text/plain', body: { data: b64(t) } });
  const htmlPart = h => ({ mimeType: 'text/html', body: { data: b64(h) } });

  // ➤ Plain text still wins wherever it exists, so nothing that already
  // ➤ worked changes behaviour — the fallback only fills a hole.
  const both = { mimeType: 'multipart/alternative', parts: [plainPart('the plain one'), htmlPart('<p>the html one</p>')] };
  eq(messageText(both).trim(), 'the plain one', 'plain text is preferred when the message carries both');

  // ➤ The hole itself: HTML and nothing else.
  const htmlOnly = { mimeType: 'multipart/alternative', parts: [htmlPart('<p>Unfortunately we have decided to move forward with other candidates.</p>')] };
  ok(/Unfortunately we have decided/.test(messageText(htmlOnly)), 'an HTML-only message is read');

  // ➤ And when there are no parts at all — the whole message IS the HTML.
  eq(messageText(htmlPart('<p>bare html</p>')).trim(), 'bare html', 'a single-part HTML message is read too');

  // ➤ Nested: real ATS mail is multipart/mixed wrapping multipart/alternative.
  const nested = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [htmlPart('<p>buried deep</p>')] }] };
  ok(messageText(nested).includes('buried deep'), 'and one buried two levels down');

  // ➤ TABLE CELLS MUST NOT FUSE. Half these mails lay the text out in a table;
  // ➤ without the dataTable setting this comes back "PuestoMarine Engineer",
  // ➤ which is a word in no language and matches nothing. Exactly the bullet-
  // ➤ list fault that had to be fixed in the offer filter.
  const table = htmlPart('<table><tr><td>Puesto</td><td>Marine Engineer</td></tr></table>');
  const cells = messageText(table).replace(/\s+/g, ' ');
  ok(cells.includes('Puesto Marine Engineer'), 'table cells stay separate words');
  ok(!/PuestoMarine/.test(cells), 'they never run together');

  // ➤ Same for anything the markup separates but the eye reads as two lines.
  ok(/Hola\s+Adios/.test(messageText(htmlPart('<p>Hola</p><p>Adios</p>'))), 'paragraphs stay apart');
  // ➤ List items come out bulleted ("* uno"), so what is checked is the
  // ➤ property that matters — they are two words, not one.
  const items = messageText(htmlPart('<ul><li>uno</li><li>dos</li></ul>')).replace(/\s+/g, ' ');
  ok(/\buno\b/.test(items) && /\bdos\b/.test(items) && !/unodos/.test(items), 'and list items');

  // ➤ Link addresses stay out: tracking URLs carry other companies' names
  // ➤ inside them, and the matcher would read those as evidence.
  const link = messageText(htmlPart('<a href="https://track.vanoord.example/x?c=SomeOtherCorp">Ver oferta</a>'));
  ok(link.includes('Ver oferta'), 'the words of a link survive');
  ok(!/SomeOtherCorp|https?:/.test(link), 'but not its address');

  // ➤ Entities have to become characters or "R&amp;D" never matches "R&D".
  ok(messageText(htmlPart('<p>R&amp;D&nbsp;Marine</p>')).includes('R&D'), 'entities are decoded');

  // ➤ Nothing at all is an empty string, not a crash: a message can be an
  // ➤ attachment with no text part whatsoever.
  eq(messageText({ mimeType: 'application/pdf', body: { attachmentId: 'x' } }), '', 'a message with no text at all comes back empty');
  eq(messageText(null), '', 'and so does nothing');

  // ➤ A part that will not decode must not take the rest of the message down.
  const broken = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: null } }, htmlPart('<p>still here</p>')] };
  ok(messageText(broken).includes('still here'), 'one unreadable part does not lose the others');
}

done();
