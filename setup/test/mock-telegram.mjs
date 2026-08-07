// A tiny stand-in for the Telegram Bot API, enough to replay the whole setup
// with no account and no phone. The bot points at it via ARGUS_TG_API; a
// driver script (drive-setup.mjs) plays the human. Pattern: telegram-test-api
// (github.com/jehy/telegram-test-api) and the baseApiUrl override it uses.
//
// It speaks the slice of the API the bot actually calls: getMe, getUpdates,
// sendMessage, editMessageReplyMarkup, deleteMessage, answerCallbackQuery,
// getFile, sendDocument — plus a /_test/* control plane for the driver to
// inject user messages and taps and to read what the bot sent.
import { createServer } from 'http';
import { readFileSync } from 'fs';

const PORT = Number(process.env.MOCK_PORT || 8081);
let updateSeq = 100;       // update_id counter for user→bot events
let messageSeq = 500;      // message_id counter for bot→user messages
const pendingUpdates = []; // queue the bot drains via getUpdates
const botMessages = [];    // everything the bot sent, for the driver to read
const files = {};          // file_id → local path, for getFile/download

const BOT_USER = { id: 42, is_bot: true, first_name: 'ArgusTestBot', username: 'argus_test_bot' };
const CHAT = { id: 1234567, type: 'private', first_name: 'Tester' };

function body(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => (d += c)); req.on('end', () => resolve(d));
  });
}
function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function ok(res, result) { json(res, { ok: true, result }); }

// ➤ Queue a user→bot update the bot will see on its next getUpdates.
function pushUpdate(u) { pendingUpdates.push({ update_id: updateSeq++, ...u }); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const raw = await body(req);
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams); } catch { payload = Object.fromEntries(url.searchParams); }
  const merged = { ...Object.fromEntries(url.searchParams), ...payload };

  // ── the bot's side of the API ──
  const m = path.match(/^\/bot[^/]+\/(\w+)$/) || path.match(/^\/file\/bot[^/]+\/(.+)$/);
  const method = path.startsWith('/file/') ? '_download' : (m ? m[1] : null);

  if (method === 'getMe') return ok(res, BOT_USER);
  if (method === 'getUpdates') {
    // ➤ Honour offset like the real API: drop everything below it, hand back the rest.
    const offset = Number(merged.offset || 0);
    const out = offset > 0 ? pendingUpdates.filter(u => u.update_id >= offset) : pendingUpdates.slice();
    return ok(res, out);
  }
  if (method === 'sendMessage') {
    const msg = { message_id: messageSeq++, chat: CHAT, date: 0, text: merged.text,
      reply_markup: merged.reply_markup ? (typeof merged.reply_markup === 'string' ? JSON.parse(merged.reply_markup) : merged.reply_markup) : undefined };
    botMessages.push({ kind: 'message', ...msg });
    return ok(res, msg);
  }
  if (method === 'editMessageReplyMarkup' || method === 'editMessageText') {
    botMessages.push({ kind: 'edit', message_id: Number(merged.message_id), text: merged.text });
    return ok(res, { message_id: Number(merged.message_id), chat: CHAT });
  }
  if (method === 'deleteMessage') { botMessages.push({ kind: 'delete', message_id: Number(merged.message_id) }); return ok(res, true); }
  if (method === 'answerCallbackQuery') return ok(res, true);
  if (method === 'sendDocument') { botMessages.push({ kind: 'document' }); return ok(res, { message_id: messageSeq++, chat: CHAT }); }
  if (method === 'getFile') {
    const id = merged.file_id;
    return ok(res, { file_id: id, file_path: `_local/${id}` });
  }
  if (method === '_download') {
    const id = path.split('/_local/')[1];
    const local = files[id];
    try {
      const bytes = readFileSync(local);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(bytes);
    } catch { res.writeHead(404); return res.end('no file'); }
  }

  // ── the driver's control plane ──
  if (path === '/_test/say') { pushUpdate({ message: { message_id: updateSeq, chat: CHAT, from: CHAT, date: 0, text: merged.text } }); return ok(res, true); }
  if (path === '/_test/start') {  // deep-link START: /start <code>
    pushUpdate({ message: { message_id: updateSeq, chat: CHAT, from: CHAT, date: 0, text: `/start${merged.code ? ' ' + merged.code : ''}` } });
    return ok(res, true);
  }
  if (path === '/_test/tap') { pushUpdate({ callback_query: { id: String(Date.now()), from: CHAT, message: { message_id: Number(merged.message_id), chat: CHAT }, data: merged.data } }); return ok(res, true); }
  if (path === '/_test/document') {
    const fid = `file_${Object.keys(files).length + 1}`;
    files[fid] = merged.path;
    pushUpdate({ message: { message_id: updateSeq, chat: CHAT, from: CHAT, date: 0, document: { file_id: fid, file_name: merged.name || 'cv.pdf', file_size: merged.size ? Number(merged.size) : 100000 } } });
    return ok(res, true);
  }
  if (path === '/_test/messages') return json(res, botMessages);
  if (path === '/_test/last') return json(res, botMessages.filter(x => x.kind === 'message').at(-1) || null);
  if (path === '/_test/reset') { botMessages.length = 0; return ok(res, true); }

  json(res, { ok: false, description: `mock: unhandled ${method || path}` }, 404);
});

server.listen(PORT, () => console.log(`mock-telegram on http://127.0.0.1:${PORT}`));
