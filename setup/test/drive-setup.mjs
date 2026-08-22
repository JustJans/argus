// Plays the human through the whole first-run setup against the mock, printing
// the exact conversation a real user would see. It copies the repo to a scratch
// dir (so nothing real is touched), simulates the installer writing the token,
// taps START on the deep link, then answers every onboarding question the way a
// person would — sending a real PDF for the CV — and reports what the bot said.
//
//   node setup/test/drive-setup.mjs <scratchDir> <samplePdf>
import { execFileSync, spawn } from 'child_process';
import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = resolve(process.argv[2] || join(REPO, '.setup-test-work'));
const PORT = 8081;

// ➤ A real, text-based PDF built here so the harness needs no external file
// ➤ (a downloaded sample kept getting quarantined). Same shape the robustness
// ➤ suite uses; the extractor reads its text.
function makeSamplePdf(path) {
  // ➤ Long enough to clear the "is it a scan?" 200-char guard, so this exercises
  // ➤ the real PDF-accepted branch, not the rejection one.
  const lines = [
    'Alex Rivera - Automation Engineer',
    'Barcelona, Spain - alex@example.com - +34 600 000 000',
    'EXPERIENCE: Automation Engineer at Marine Controls Ltd 2024-present.',
    'Commissioned PLC and SCADA panels for offshore vessels and floating wind.',
    'EDUCATION: BSc in Automation and Industrial Electronics, 2020-2024.',
    'LANGUAGES: Spanish native, English C1. SKILLS: PLC, SCADA, Python, OrcaFlex.',
  ];
  let y = 740;
  const stream = lines.map(l => `BT /F1 11 Tf 60 ${y -= 16} Td (${l}) Tj ET`).join('\n');
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n'; const off = [];
  for (const o of objs) { off.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, Buffer.from(pdf, 'latin1'));
}
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ── 1) a clean throwaway copy of the bot ──
log('Preparing a scratch copy at', WORK);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const d of ['server-bot', 'config', 'modes']) cpSync(join(REPO, d), join(WORK, d), { recursive: true });
for (const f of ['portals.yml', 'package.json', 'cv.md']) cpSync(join(REPO, f), join(WORK, f));
mkdirSync(join(WORK, 'data'), { recursive: true });
const PDF = join(WORK, 'sample-cv.pdf');
makeSamplePdf(PDF);
try { symlinkSync(join(REPO, 'node_modules'), join(WORK, 'node_modules'), 'junction'); }
catch { cpSync(join(REPO, 'node_modules'), join(WORK, 'node_modules'), { recursive: true }); }
// ➤ the installer's job: token saved, chat not yet linked, a deep-link code.
const CODE = 'abc12345';
writeFileSync(join(WORK, 'server-bot', 'telegram.json'),
  JSON.stringify({ bot_token: '123456789:TESTTESTTESTTESTTESTTESTTESTTEST01', chat_id: '', link_code: CODE }));

// ── 2) the mock Telegram server ──
const mock = spawn(process.execPath, [join(REPO, 'setup', 'test', 'mock-telegram.mjs')],
  { env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: 'inherit' });
await sleep(600);

const api = async (p, params = {}) => {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u); return r.json();
};
const tick = () => {   // one --once pass, like one watchdog run (must terminate)
  try {
    execFileSync(process.execPath, [join('server-bot', 'telegram-listener.mjs'), '--once'],
      { cwd: WORK, env: { ...process.env, ARGUS_TG_API: BASE }, timeout: 120000, stdio: 'pipe' });
  } catch (e) { log('  (listener exited non-zero:', String(e.message).split('\n')[0], ')'); }
};
let cursor = 0;
const drain = async () => {
  const all = await api('/_test/messages');
  const fresh = all.slice(cursor); cursor = all.length;
  for (const m of fresh) {
    if (m.kind === 'message') log('  BOT »', JSON.stringify(m.text));
    else if (m.kind === 'edit') log('  BOT ✎ (edited buttons)');
    else if (m.kind === 'delete') log('  BOT ✗ (deleted a message)');
    else if (m.kind === 'document') log('  BOT 📎 (sent a document)');
  }
  return fresh;
};
// ➤ Only the CURRENT prompt counts: the last actual message the bot sent. If it
// ➤ carries buttons it is a tap question; if not, it is a typed one. Looking at
// ➤ any earlier keyboard would re-tap a question already answered.
const currentPrompt = async () => {
  const all = await api('/_test/messages');
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].kind === 'message') return all[i];
  }
  return null;
};

try {
  log('\n=== USER taps START on the t.me link ===');
  await api('/_test/start', { code: CODE });
  tick(); await drain();

  log('\n=== USER sends the CV as a PDF ===');
  await api('/_test/document', { path: PDF, name: 'MyResume.pdf', size: '90000' });
  tick(); await drain();

  // ── answer whatever the bot asks, up to a sane cap ──
  const TEXT = { name: 'Alex Rivera', contact: 'alex@example.com, +34 600 000 000, Barcelona',
    roles: 'automation engineer, controls', fields: 'automation, marine', cover_example: 'skip' };
  let guardName = null;
  for (let step = 0; step < 20; step++) {
    const prompt = await currentPrompt();
    const text = prompt?.text || '';
    const kb = prompt?.reply_markup?.inline_keyboard;
    if (/setup complete|nothing to search|profile is saved/i.test(text)) { log('\n=== SETUP COMPLETE ==='); break; }

    if (kb) {
      const flat = kb.flat();
      const use = flat.find(b => b.callback_data === 'use');
      const done = flat.find(b => b.callback_data === 'done');
      if (use) { log('  USER taps [Use this]'); await api('/_test/tap', { message_id: prompt.message_id, data: 'use' }); }
      else if (done) { log('  USER taps [Done]'); await api('/_test/tap', { message_id: prompt.message_id, data: 'done' }); }
      else { const first = flat.find(b => b.callback_data?.startsWith('o:')); log(`  USER taps [${first?.text}]`); await api('/_test/tap', { message_id: prompt.message_id, data: first.callback_data }); }
    } else {
      // ➤ a typed question: pick a canned answer by what it asks for
      let ans = 'skip';
      if (/full name/i.test(text)) ans = TEXT.name;
      else if (/contact/i.test(text)) ans = TEXT.contact;
      else if (/job titles|roles/i.test(text)) ans = TEXT.roles;
      else if (/fields you can/i.test(text)) ans = TEXT.fields;
      else if (/cover letter/i.test(text)) ans = TEXT.cover_example;
      if (text === guardName) { log('  (no progress — stopping)'); break; }
      guardName = text;
      log(`  USER types: ${JSON.stringify(ans)}`);
      await api('/_test/say', { text: ans });
    }
    tick(); await drain();
  }

  log('\n=== FINAL PROFILE written by the bot ===');
  const prof = join(WORK, 'config', 'profile.yml');
  if (existsSync(prof)) {
    const y = execFileSync(process.execPath, ['-e', `const s=require('fs').readFileSync(${JSON.stringify(prof)},'utf8'); process.stdout.write(s.split(String.fromCharCode(10)).slice(0,40).join(String.fromCharCode(10)))`]).toString();
    log(y);
  } else log('  (no profile.yml was written!)');
} finally {
  mock.kill();
}
