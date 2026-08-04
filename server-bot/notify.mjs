#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT THIS IS: the "messenger" of the job searcher. This file is in charge
// ➤ of sending the new offers the scanner finds to your Telegram.
// ➤ WHAT IT DOES from start to finish: it groups the offers by country
// ➤ (Barcelona first, then Spain, France...), cleans up and translates the
// ➤ titles into English, and sends them as a message with clickable links; if
// ➤ they don't fit in one message, it splits them across several without
// ➤ cutting lines in half.
// ➤ WHEN IT RUNS: the scanner (scan.mjs, every 2 hours on the server) calls it
// ➤ when there are new offers; by hand it accepts --test and --setup.
// ➤ WHAT IT USES: telegram.json (the bot's keys) and countries.yml (countries).
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * notify.mjs — Telegram notifier for argus.
 *
 * Sends new offers to the user's Telegram when the scanner finds them.
 * Zero dependencies (Telegram Bot API over plain HTTPS).
 *
 * Setup (one time):
 *   1. In Telegram, talk to @BotFather → /newbot → copy the token.
 *   2. Put it in server-bot/telegram.json:  {"bot_token": "...", "chat_id": ""}
 *   3. Send any message to your new bot in Telegram.
 *   4. Run: node server-bot/notify.mjs --setup   (auto-detects your chat_id)
 *
 * CLI:
 *   node server-bot/notify.mjs --test    send a test message
 *   node server-bot/notify.mjs --setup   detect chat_id from your last message
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
// ➤ The user's fields (mooring/offshore/survey...) — the same list the filters
// ➤ use — to push what's "most theirs" to the top within each country.
import { USER_FIELDS, searchProfile } from './requirements.mjs';

// ➤ Paths of the config files (looked up next to this script) and the max
// ➤ size per message: Telegram cuts off at 4096 characters, we leave margin.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(SCRIPT_DIR, 'telegram.json');
const COUNTRIES_PATH = join(SCRIPT_DIR, 'countries.yml');
// ➤ Where the Council switch and its journal live, for the verdicts below.
const ROOT = dirname(SCRIPT_DIR);
const PORTALS_PATH = join(ROOT, 'portals.yml');
const JUDGE_JOURNAL_PATH = join(ROOT, 'data', 'judge-shadow.jsonl');

// ➤ How much text goes in one message before it is sent and a new one begun.
// ➤ TELEGRAM REFUSES ANYTHING OVER 4096 CHARACTERS, and refusing means you get
// ➤ no list at all — the failure is total, not partial. The margin exists
// ➤ because the count is of the VISIBLE text while what is sent carries HTML
// ➤ tags and links on top. Exported so a test can hold it under the limit: a
// ➤ mutation that raised it to 100000 passed every test there was.
export const MAX_CHUNK = 3500;
export const TELEGRAM_LIMIT = 4096;
// ➤ A backstop for the splitter, not a reading width: a line that alone exceeds
// ➤ MAX_CHUNK cannot be split off, so the whole message is refused. The longest
// ➤ real title measured is 116 characters, so nothing real ever reaches this.
export const MAX_TITLE_CHARS = 300;

// ── Country grouping (the user's priority order) ────────────────────────
// Barcelona first, then rest of Spain, France, Monaco, Belgium,
// Netherlands, Germany; remaining countries after; unknowns last.

// ➤ Your home city and target countries come from your profile
// ➤ (config/profile.yml → search.home_city / search.countries). The marine
// ➤ default below is used if the profile doesn't set them. From this ONE list
// ➤ we derive the display order, the name→group map and the Adzuna-domain map.
const DEFAULT_COUNTRIES = [
  { name: 'Spain', label: 'SPAIN', adzuna: 'es' },
  { name: 'France', label: 'FRANCE', adzuna: 'fr' },
  { name: 'Monaco', label: 'MONACO' },
  { name: 'Belgium', label: 'BELGIUM', adzuna: 'be' },
  { name: 'Netherlands', label: 'NETHERLANDS', adzuna: 'nl' },
  { name: 'Germany', label: 'GERMANY', adzuna: 'de' },
  { name: 'Switzerland', label: 'SWITZERLAND', adzuna: 'ch' },
  { name: 'Austria', label: 'AUSTRIA', adzuna: 'at' },
  { name: 'Norway', label: 'NORWAY' },
  { name: 'Denmark', label: 'DENMARK' },
  { name: 'Italy', label: 'ITALY' },
  { name: 'Ireland', label: 'IRELAND' },
];
const _COUNTRIES = (Array.isArray(searchProfile.countries) && searchProfile.countries.length)
  ? searchProfile.countries : DEFAULT_COUNTRIES;
// ➤ The home city gets its own group at the very top of the list.
const HOME_CITY = String(searchProfile.home_city || 'Barcelona');
const HOME_GROUP = HOME_CITY.toUpperCase();

// ➤ Order in which the country groups appear in the Telegram message: home city
// ➤ first, then your countries in priority order, then the catch-all groups.
// ➤ DE-DUPLICATED, because the list is walked to build the message and a label
// ➤ appearing twice sends its offers twice. The onboarding offers "Remote" as a
// ➤ country to tick, so anyone who ticks it gets REMOTE from their own list AND
// ➤ the fixed one below. A home city named like one of the countries would do
// ➤ the same.
const GROUP_ORDER = [...new Set([HOME_GROUP, ..._COUNTRIES.map(c => c.label), 'REMOTE', 'OTHER', 'NO LOCATION'])];

// ➤ From the English country name (as it arrives from the job portals) to the
// ➤ group label shown in the message.
const COUNTRY_TO_GROUP = Object.fromEntries(_COUNTRIES.map(c => [c.name, c.label]));

// ➤ Builds the "cheat sheet" to recognize countries: for each one it gathers
// ➤ its name and its nicknames (taken from countries.yml: cities,
// ➤ abbreviations...) all in lowercase, to compare them against each offer's
// ➤ location.
export function loadCountryMatchers() {
  let cfg = {};
  try { cfg = yaml.load(readFileSync(COUNTRIES_PATH, 'utf-8')) || {}; } catch {}
  const aliases = cfg.aliases || {};
  // Match in the user's priority order so e.g. "Monaco" wins over a
  // coincidental match later in the list.
  return Object.keys(COUNTRY_TO_GROUP).map(country => ({
    group: COUNTRY_TO_GROUP[country],
    keys: [country, ...(aliases[country] || [])].map(k => k.toLowerCase()),
  }));
}

// ➤ Decides which group an offer belongs to by looking at its location text:
// ➤ Barcelona beats everything else; otherwise it tries country by country;
// ➤ if it mentions remote work it goes to REMOTE; and if nothing fits, OTHER.
export function classifyLocation(loc, matchers) {
  const lower = String(loc || '').toLowerCase().trim();
  if (!lower) return 'NO LOCATION';
  if (HOME_CITY && lower.includes(HOME_CITY.toLowerCase())) return HOME_GROUP;
  for (const m of matchers) {
    // ➤ WHOLE-WORD (audit 2026-07-25): these were plain substrings, so a location
    // ➤ like "Argenteuil" was filed under BELGIUM because it contains "gent".
    // ➤ The boundary uses \p{L} because JS's \b only knows ASCII ("België").
    if (m.keys.some(k => new RegExp(`(?<![\\p{L}\\d])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'iu').test(lower))) return m.group;
  }
  // ➤ Checks whether the location says "remote", "hybrid" or "en remoto".
  if (/remote|hybrid|en remoto/i.test(lower)) return 'REMOTE';
  return 'OTHER';
}

// ➤ Country of last resort, taken from the link itself: an adzuna.nl address
// ➤ IS a Netherlands offer even when the location field came back empty. Built
// ➤ from the same profile country list, so it stays in sync on its own.
const ADZUNA_DOMAIN_GROUP = Object.fromEntries(
  _COUNTRIES.filter(c => c.adzuna).map(c => [String(c.adzuna).toLowerCase(), c.label]),
);

// ➤ Last resort: if the location said nothing, guess the country from the web
// ➤ address (an adzuna.nl link is a Netherlands offer for sure).
export function urlGroupHint(url) {
  // ➤ Looks for "adzuna." followed by two letters (the country code) in the link.
  const m = String(url || '').match(/adzuna\.([a-z]{2})\//i);
  return m ? (ADZUNA_DOMAIN_GROUP[m[1].toLowerCase()] || null) : null;
}

// ── Title / city presentation ───────────────────────────────────────

// ➤ Removes from the title the gender tags typical of Europe, like
// ➤ "(m/w/d)" in Germany or "(H/F)" in France, which only take up space.
export function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\(\s*[a-zäöü]\s*(?:\/\s*[a-zäöü.]+\s*){1,3}\)/gi, '')   // (m/w/d), (H/F), (w/m/div.)
    .replace(/\s*\(\s*all genders\s*\)/gi, '')
    .replace(/\s+[HFhf]\/[HFhf](?=\s|$)/g, '')                            // bare F/H, H/F
    .replace(/\s*[-–—|]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ➤ Words that are only a country (not a city): if the "city" turns out to be
// ➤ one of these, it isn't shown, because the message's group already says it.
// ➤ Country names ONLY — never city aliases, or "Madrid" would stop showing.
// ➤ Includes the multilingual base set AND the configured countries' names/labels.
const COUNTRY_WORDS = new Set([
  'spain', 'españa', 'espana', 'france', 'monaco', 'mónaco', 'belgium',
  'belgië', 'belgique', 'belgie', 'netherlands', 'nederland', 'holland',
  'germany', 'deutschland', 'norway', 'norge', 'noruega', 'denmark',
  'danmark', 'italy', 'italia', 'ireland', 'éire', 'europe', 'emea',
  ..._COUNTRIES.flatMap(c => [String(c.name).toLowerCase(), String(c.label).toLowerCase()]),
]);

// ➤ Takes the NOISE out of a title and nothing else: contract parentheticals
// ➤ ("(Temp Agency)"), trailing acronym lists ("... DWDM / MPLS-TP / TDM") and
// ➤ sector tags every offer here already carries ("- NAVAL Sector").
// ➤ IT NO LONGER SHORTENS: a 72-character cut hit 41 of 1,006 real titles, and
// ➤ Telegram wraps a long line by itself, so there was only a title to lose.
export function compactTitle(title) {
  let t = String(title || '');

  // ➤ Removes parentheticals like "(freelance)" or "(temp agency)" that add nothing.
  t = t.replace(/\s*\(\s*(?:temp(?:orary)?(?:\s+agency)?|interim|ett|zzp|freelance|w2|contract(?:or)?)\s*\)/gi, '');

  // ➤ Removes the trailing "acronym tail" (e.g. " DWDM / MPLS-TP / TDM").
  t = t.replace(/\s+[A-Z0-9][A-Z0-9-]{2,}(?:\s*\/\s*[^/]{1,40})+\s*$/, '');

  // ➤ Removes dash-separated chunks that only name the sector ("Sector NAVAL").
  const segs = t.split(/\s+[-–—]\s+/).filter(seg => {
    const words = seg.trim().split(/\s+/);
    const hasSectorWord = /\b(?:sector|secteur|sektor|branche)\b/i.test(seg);
    return !(hasSectorWord && words.length <= 4);
  });
  t = segs.join(' - ');

  t = t.replace(/\s{2,}/g, ' ').replace(/\s*[-–—|/]\s*$/g, '').trim();

  // ➤ For the splitter, not for reading — see MAX_TITLE_CHARS. It fires only on
  // ➤ a broken feed pasting a whole ad into the title.
  if (t.length > MAX_TITLE_CHARS) {
    const cut = t.slice(0, MAX_TITLE_CHARS);
    t = cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\-–—/]\s*$/, '') + '…';
  }
  return t;
}

// ➤ The city = the first locality of the location string, with the region and
// ➤ province dropped: "Marín (Pontevedra) | Lugo, España, Galicia" → "Marín".
// ➤ If there is no real city it returns empty and none is shown.
export function cityOf(location) {
  // ➤ The "· reflotada" marker (from the amnesty, removed 2026-07-18 at the user's
  // ➤ request) still appears in old lines inside the location — it's stripped
  // ➤ here so it doesn't show up as part of the city name.
  let city = String(location || '').replace(/\s*·\s*reflotada\s*/gi, ' ').split(/[|,]/)[0]
    .replace(/\([^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/^reflotada$/i.test(city)) return '';
  // ➤ Discards useless values: empty, "n/a" or things like "5 locations".
  if (!city || /^n\/a$/i.test(city) || /^\d+\s+locations$/i.test(city)) return '';
  if (COUNTRY_WORDS.has(city.toLowerCase())) return '';
  return city;
}

// ➤ Memory of the translations already done, so the same title isn't asked for
// ➤ twice within one send.
const _tcache = new Map();

// ➤ Which language a job title in a given country is written in. Used only as
// ➤ a second attempt, when the automatic detection has already given up.
// ➤ Written WITHOUT accents, and the text is stripped of them before matching.
// ➤ Not tidiness: JavaScript's \b only knows ASCII, so "\bbelgië\b" never
// ➤ matches "België" — the ë is not a word character to it, so there is no
// ➤ boundary to find and the country goes unrecognised. Folding both sides
// ➤ also means "Espana" and "España" are the same word, which is how the job
// ➤ boards actually spell it: both.
const COUNTRY_LANG = [
  [/\bfrance\b|\bfrancia\b|\bfrankrijk\b|\bmonaco\b|\.fr[/?]|\.fr$/i, 'fr'],
  [/\bspain\b|\bespana\b|\bspanje\b|\bspanien\b|\.es[/?]|\.es$/i, 'es'],
  [/\bgermany\b|\bdeutschland\b|\balemania\b|\bduitsland\b|\.de[/?]|\.de$/i, 'de'],
  [/\bnetherlands\b|\bnederland\b|\bholanda\b|\bpaises bajos\b|\.nl[/?]|\.nl$/i, 'nl'],
  [/\bbelgium\b|\bbelgie\b|\bbelgique\b|\bbelgica\b|\.be[/?]|\.be$/i, 'nl'],
  [/\bitaly\b|\bitalia\b|\.it[/?]|\.it$/i, 'it'],
  [/\bportugal\b|\.pt[/?]|\.pt$/i, 'pt'],
];
const unaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
export const languageOfPlace = place => (COUNTRY_LANG.find(([re]) => re.test(unaccent(place))) || [])[1] || '';

// ➤ fetchImpl is injectable so the two-attempt logic can be tested without a
// ➤ network. It was not, and a mutation run proved the cost: deleting the
// ➤ country hint entirely — the whole reason non-English titles arrive in
// ➤ English — left the suite green, because nothing exercised this at all.
async function askTranslator(title, sl, fetchImpl = fetch) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=en&dt=t&q=`
    + encodeURIComponent(title);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return '';
  const data = await res.json();
  return (data?.[0] || []).map(seg => seg?.[0] || '').join('').trim();
}

// ➤ Translates the title into English with Google's free translator (no key).
// ➤ If it fails or takes more than 8 seconds, the original title is used.
// ➤ EVERY title goes through it. A "looks foreign" heuristic was tried first
// ➤ and failed on ASCII German compounds ("Nachrichtentechnik"), which reached
// ➤ the phone untranslated. English input comes back unchanged, and a scan
// ➤ notifies a handful of offers at most, so the cost is nil.
// ➤
// ➤ THE SECOND ATTEMPT IS WHY FRENCH WAS NOT WORKING. Job titles are three or
// ➤ four words long, and on those the automatic detection guesses badly:
// ➤ "Charpentier naval H/F" is reported as ENGLISH, so it comes back exactly as
// ➤ it went in and reaches the phone in French. Told the language outright it
// ➤ answers "Shipwright M/F". The country the job is in is the hint, and being
// ➤ wrong about it costs nothing — an English title handed over as French comes
// ➤ back unchanged, which is what a wrong guess should do.
export async function translateTitle(title, place = '', { fetchImpl = fetch, cache = _tcache } = {}) {
  const key = `${title} ${place}`;
  if (cache.has(key)) return cache.get(key);
  let out = title;
  try {
    const auto = await askTranslator(title, 'auto', fetchImpl);
    if (auto) out = auto;
    // ➤ Unchanged means one of two things: it was already English, or the
    // ➤ detection failed. Only the country can tell those apart.
    if (out.toLowerCase() === title.toLowerCase()) {
      const sl = languageOfPlace(place);
      if (sl) {
        const forced = await askTranslator(title, sl, fetchImpl);
        if (forced) out = forced;
      }
    }
  } catch { /* keep original */ }
  cache.set(key, out);
  return out;
}

// ➤ Reads telegram.json (the file with the bot's key and your chat number).
// ➤ If it doesn't exist or is malformed, it returns "nothing" instead of breaking.
function loadCfg() {
  if (!existsSync(CFG_PATH)) return null;
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf-8')); } catch { return null; }
}

// ➤ Says whether Telegram is ready to use: both things are needed, the bot's
// ➤ key and the chat_id (your "mailbox number" on Telegram).
export function telegramConfigured() {
  const c = loadCfg();
  return Boolean(c?.bot_token && c?.chat_id);
}

// ➤ Calls the Telegram hub to run a command (send a message, read messages...).
// ➤ If Telegram asks to wait because of too much sending, it waits the time it
// ➤ says and retries ONCE before giving up.
async function api(token, method, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (j.ok) return j.result;
    // Flood control: Telegram tells us how long to wait — honour it once.
    // (Multi-message lists died halfway here before this retry existed.)
    const retryAfter = j.parameters?.retry_after;
    if (retryAfter && attempt === 0) {
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    throw new Error(`telegram ${method}: ${j.description || res.status}`);
  }
}

// ➤ Sends a text to your chat and RETURNS the number (message_id) of the
// ➤ message, so it can be deleted later (the "live list" needs it). silent=true
// ➤ sends it with no sound or notification. If not configured yet, null.
// ➤ Disables link previews so the screen doesn't get cluttered.
export async function sendTelegramMessage(text, { html = false, silent = false } = {}) {
  const c = loadCfg();
  if (!c?.bot_token || !c?.chat_id) return null;
  const result = await api(c.bot_token, 'sendMessage', {
    chat_id: c.chat_id,
    text,
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(silent ? { disable_notification: true } : {}),
    disable_web_page_preview: true,
  });
  return result?.message_id ?? null;
}

// ➤ Same as the previous one but returns only true/false (so the rest of the
// ➤ bot, which only wants to know if it was sent, doesn't change).
export async function sendTelegram(text, opts = {}) {
  return (await sendTelegramMessage(text, opts)) !== null;
}

// ➤ Deletes a chat message by its id. The "live list" uses it to remove the
// ➤ previous list before re-sending the updated one. If the message no longer
// ➤ exists (Telegram or you deleted it), Telegram returns an error and it's
// ➤ silently ignored here: it's not a real failure.
export async function deleteTelegramMessage(messageId) {
  const c = loadCfg();
  if (!c?.bot_token || !c?.chat_id || messageId == null) return false;
  try {
    await api(c.bot_token, 'deleteMessage', { chat_id: c.chat_id, message_id: messageId });
    return true;
  } catch (e) {
    // ➤ Telegram refuses to delete a message older than 48h. Say it once in the
    // ➤ log instead of failing mutely, so a list that stays in the chat has an
    // ➤ explanation (audit 2026-07-25).
    console.log(`[${new Date().toISOString()}] could not delete message ${messageId} (older than 48h?): ${String(e && e.message).slice(0, 80)}`);
    return false;
  }
}

// ── Inline BUTTONS (used only by the one-time onboarding / settings) ─────────
// ➤ The daily commands stay typed (the user's rule); buttons are only for the
// ➤ one-time setup, where multi-selecting from a fixed list (countries,
// ➤ languages...) is much nicer than typing. `rows` is a 2D array of
// ➤ {label, data}: each inner array is one row of buttons. `data` is the short
// ➤ payload (<=64 bytes) Telegram sends back when the button is tapped.

// ➤ Turns our simple {label,data} rows into Telegram's inline_keyboard shape.
function toInlineKeyboard(rows) {
  return { inline_keyboard: (rows || []).map(row => row.map(b => ({ text: b.label, callback_data: b.data }))) };
}

// ➤ Sends a message WITH buttons. Returns the message_id so the buttons can be
// ➤ edited in place as the user toggles them.
export async function sendTelegramButtons(text, rows, { html = false, silent = false } = {}) {
  const c = loadCfg();
  if (!c?.bot_token || !c?.chat_id) return null;
  const result = await api(c.bot_token, 'sendMessage', {
    chat_id: c.chat_id,
    text,
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(silent ? { disable_notification: true } : {}),
    reply_markup: toInlineKeyboard(rows),
    disable_web_page_preview: true,
  });
  return result?.message_id ?? null;
}

// ➤ Edits an existing button message in place (its text AND its buttons) — used
// ➤ to show a toggled ✅ without sending a whole new message.
export async function editTelegramButtons(messageId, text, rows, { html = false } = {}) {
  const c = loadCfg();
  if (!c?.bot_token || !c?.chat_id || messageId == null) return false;
  try {
    await api(c.bot_token, 'editMessageText', {
      chat_id: c.chat_id,
      message_id: messageId,
      text,
      ...(html ? { parse_mode: 'HTML' } : {}),
      reply_markup: toInlineKeyboard(rows),
      disable_web_page_preview: true,
    });
    return true;
  } catch { return false; }   // "message is not modified" and stale ids are harmless here
}

// ➤ Acknowledges a button tap so Telegram stops the little loading spinner on
// ➤ the user's side. Optional short toast text.
export async function answerCallback(callbackId, text = '') {
  const c = loadCfg();
  if (!c?.bot_token || callbackId == null) return false;
  try {
    await api(c.bot_token, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
    return true;
  } catch { return false; }
}

// ➤ Affinity score of a title (2026-07-18): +2 if it's one of the user's fields
// ➤ (mooring/offshore/survey...), +1 if it's junior/graduate. Used ONLY to
// ➤ order the display — never to filter. Exported so it can be tested in
// ➤ test-filter.mjs.
export function offerAffinity(title) {
  const t = String(title || '');
  return (USER_FIELDS.test(t) ? 2 : 0) + (/\bjunior\b|\bgraduate\b/i.test(t) ? 1 : 0);
}

// ➤ (The inline BUTTONS under each offer were tested on 2026-07-18 and the user
// ➤ removed them that same day: the owner prefers typing the commands. Do not reintroduce them.)

// ➤ Sends a FILE (for example the PDF of a cover letter) to your Telegram
// ➤ chat, with an optional caption. The "cover" command uses it. Unlike normal
// ➤ messages, files go in a special "envelope" (multipart) that Telegram
// ➤ requires for attachments.
export async function sendTelegramDocument(filePath, caption = '') {
  const c = loadCfg();
  if (!c?.bot_token || !c?.chat_id) return false;
  const fd = new FormData();
  fd.append('chat_id', String(c.chat_id));
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  const name = filePath.split(/[\\/]/).pop();
  fd.append('document', new Blob([readFileSync(filePath)]), name);
  const res = await fetch(`https://api.telegram.org/bot${c.bot_token}/sendDocument`, {
    method: 'POST', body: fd, signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json().catch(() => null);
  if (!j?.ok) console.error('sendDocument failed:', j?.description || res.status);
  return !!j?.ok;
}

// ➤ Swaps the symbols &, < and > for their safe codes so Telegram doesn't
// ➤ confuse them with formatting commands (bold, links...).
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// ➤ Same as the previous one, but also protects quotes (needed when the text
// ➤ goes inside a web address).
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

/**
 * Send a batch of offers ({company,title,location,url}) grouped by country
 * in the user's priority order (Barcelona → Spain → France → Monaco → Belgium
 * → Netherlands → Germany → rest).
 *
 * Sent as ONE message whenever possible: each offer is a single hyperlinked
 * line (HTML mode) — Telegram's 4096 limit counts the VISIBLE text after
 * entity parsing, so URLs inside <a href> cost nothing. Splits only on truly
 * huge batches, repeating the plain country header (no "(cont.)" markers).
 */
// ➤ THE MAIN FUNCTION: takes the list of new offers and sends them to your
// ➤ Telegram grouped by country, each as a line with a clickable link. It
// ➤ tries to fit everything in ONE message; if there are too many, it splits
// ➤ them across several, repeating the header of the country where it cut.
// ➤ ── THE COUNCIL'S WORD ON EACH OFFER ───────────────────────────────────
// ➤ What the shadow judges decided, one tag per offer: show → [YES],
// ➤ tie → [MYB], hide → [NO]. Read from the journal the Council appends after
// ➤ each scan, and spoken on the list ONLY while portals.yml has the Council
// ➤ switched on — with it off, the list does not change by one character.
// ➤ Returns null when off; a Map (possibly empty) when on, so an offer the
// ➤ judges have not reached yet simply says nothing until the next pass.
export function councilVerdicts({ portalsPath = PORTALS_PATH, journalPath = JUDGE_JOURNAL_PATH } = {}) {
  try {
    if (yaml.load(readFileSync(portalsPath, 'utf-8'))?.council?.enabled !== true) return null;
  } catch { return null; }
  const WORD = { show: 'YES', tie: 'MYB', hide: 'NO' };
  const map = new Map();
  try {
    for (const line of readFileSync(journalPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const word = WORD[r.council];
        if (!word) continue;
        if (r.url) map.set(r.url, word);
        if (r.id != null) map.set('#' + r.id, word);
      } catch { /* a half-written last line: the next refresh reads it whole */ }
    }
  } catch { /* switched on but nothing judged yet */ }
  return map;
}

export async function notifyNewOffers(offers, { headerLabel = 'new', silent = false, newIds = null } = {}) {
  if (!offers?.length || !telegramConfigured()) return false;

  // ➤ Step 1: sort the offers into buckets by country. If the location gave no
  // ➤ hints, it tries to guess from the web address (adzuna.es → Spain).
  const matchers = loadCountryMatchers();
  const verdicts = councilVerdicts();
  const groups = new Map();
  for (const o of offers) {
    let g = classifyLocation(o.location, matchers);
    if (g === 'NO LOCATION' || g === 'OTHER') g = urlGroupHint(o.url) || g;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }

  // ➤ Step 2: prepare each offer's "pretty" title:
  // ➤ strip tags → translate to English → shorten.
  const displayTitle = new Map();
  for (const o of offers) {
    // ➤ The location goes with it: it is the only clue to the language when
    // ➤ the automatic detection gives up, which on short titles it often does.
    displayTitle.set(o, compactTitle(cleanTitle(await translateTitle(cleanTitle(o.title), `${o.location || ''} ${o.url || ''}`))));
  }

  // ➤ Step 3: build the message header with today's date (Madrid time) and how
  // ➤ many offers there are.
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
  const plural = offers.length === 1 ? '' : 's';
  const label = headerLabel === 'new' ? 'new' : headerLabel;
  const headerTxt = `${date} — ${offers.length} ${label} offer${plural}`;
  let chunk = esc(headerTxt) + '\n\n';
  let currentGroup = null;

  let sentAny = false;
  // ➤ Here the ids of each sent message are stored (a long list may be split
  // ➤ into several). The "live list" uses them to delete them later.
  const messageIds = [];
  // ➤ "flush" = send what's accumulated so far and start a new message.
  // ➤ Between messages it waits 1.2 seconds so as not to overwhelm Telegram.
  const flush = async () => {
    if (chunk.trim()) {
      if (sentAny) await new Promise(r => setTimeout(r, 1200)); // pace multi-message lists
      const id = await sendTelegramMessage(chunk.trimEnd(), { html: true, silent });
      if (id != null) messageIds.push(id);
      sentAny = true;
    }
    chunk = '';
  };

  // ➤ Adds the country header to the message in bold (e.g. "SPAIN").
  const addGroupHeader = (name) => {
    const txt = name;
    chunk += `<b>${esc(txt)}</b>\n\n`;
  };

  // ➤ Step 4: walk through the countries in their priority order and keep
  // ➤ adding each one's offers, always making sure they fit in the message.
  for (const groupName of GROUP_ORDER) {
    const list = groups.get(groupName);
    if (!list?.length) continue;
    // ➤ If the country header no longer fits, send what's accumulated first.
    if (chunk.length + groupName.length + 12 > MAX_CHUNK) await flush();
    addGroupHeader(groupName);
    currentGroup = groupName;

    // ➤ Order by affinity (2026-07-18, approved improvement): within each
    // ➤ country, what's "most yours" on top (the user's fields +2, junior/graduate
    // ➤ +1). It only changes the visual ORDER — it doesn't filter or hide
    // ➤ anything; on equal affinity the arrival order is kept (Node's sort is stable).
    list.sort((a, b) => offerAffinity(b.title) - offerAffinity(a.title));

    for (const o of list) {
      // ➤ Build the offer line: title - company - city (the city is omitted if
      // ➤ it just repeats the country), with the offer number in front. Since
      // ➤ 2026-07-18, if known, the required years and the salary are added
      // ➤ ("~" = Adzuna estimate, not data from the posting).
      const city = cityOf(o.location);
      const parts = [displayTitle.get(o) || compactTitle(cleanTitle(o.title)), o.company];
      if (city && city.toLowerCase() !== groupName.toLowerCase()) parts.push(city);
      if (o.years != null) parts.push(`${o.years}y exp`);
      if (o.salary) parts.push(o.salary);
      // ➤ Mark offers that arrived since you last viewed the list with [NEW] at
      // ➤ the start (newIds comes from the live list; null = don't mark any).
      const isNew = newIds && o.id != null && newIds.has(o.id);
      const newTag = isNew ? '[NEW] ' : '';
      const idTag = o.id ? `#${o.id} ` : '';
      // ➤ The Council's word rides on the line itself, after the link, so the
      // ➤ verdict lands in the same glance as the offer.
      const word = verdicts && (verdicts.get(o.url) ?? verdicts.get('#' + o.id));
      const councilTag = word ? ` [${word}]` : '';
      const lineTxt = `- ${newTag}${idTag}${parts.join(' - ')}${councilTag}`;
      // ➤ Build the line FIRST, then ask whether it fits. What goes to
      // ➤ Telegram is the markup, not the words: every line carries
      // ➤ <a href="the whole URL">, and measuring only the visible text made
      // ➤ the real message 1.8x the size counted — about 6,300 characters
      // ➤ against a 4,096 limit, so past roughly thirty offers in one country
      // ➤ the list simply stopped being sent.
      const lineHtml = `- ${isNew ? '<b>[NEW]</b> ' : ''}${esc(idTag)}<a href="${escAttr(o.url)}">${esc(parts.join(' - '))}</a>${esc(councilTag)}\n\n`;
      if (chunk.length + lineHtml.length > MAX_CHUNK) {
        await flush();
        addGroupHeader(currentGroup);
      }
      // ➤ The line is added as a link: tapping it on the phone opens the offer.
      // ➤ [NEW] (in bold) goes first when the offer is new.
      chunk += lineHtml;
    }
  }
  await flush();
  // ➤ Returns the ids of the sent messages (the "live list" remembers them to
  // ➤ delete them next time). A non-empty array also counts as "yes, it was
  // ➤ sent" for whoever only checks whether something was sent.
  return messageIds;
}

// ── CLI ─────────────────────────────────────────────────────────────

// ➤ "--setup" mode (initial configuration): detects only your chat_id. You
// ➤ must have sent any message to the bot beforehand; it reads that message,
// ➤ notes the number in telegram.json and sends you a confirmation to your phone.
// ➤ EXIT CODES, because the setup scripts react differently to each and a user staring
// ➤ at "Unauthorized" cannot tell them apart:
// ➤   2 = the token itself is wrong (a typo when pasting) → ask for it again.
// ➤   1 = the token works but you have not messaged the bot yet, or the network
// ➤       is down → the fix is yours to do, then re-run this.
async function cliSetup() {
  const c = loadCfg();
  if (!c?.bot_token) {
    console.error('telegram.json missing or has no bot_token. Create it first:');
    console.error('  {"bot_token": "123456:ABC...", "chat_id": ""}');
    process.exit(1);
  }
  // ➤ WAIT for the message instead of demanding it already arrived (field test
  // ➤ 2026-08-03): the user sent their message and pressed Enter within a
  // ➤ second or two, the single getUpdates came back empty, and the dead end
  // ➤ forced them to restart the whole setup. Telegram can lag a few seconds,
  // ➤ so this polls for up to half a minute before declaring nothing there.
  let updates;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      updates = await api(c.bot_token, 'getUpdates', {});
    } catch (e) {
      // ➤ Telegram answers a bad token two different ways, and both mean the
      // ➤ same thing: 401 Unauthorized when the token is well-formed but wrong,
      // ➤ 404 Not Found when it is not even token-shaped. Saying so plainly is
      // ➤ the whole point — the raw error used to send people looking for a
      // ➤ problem with their chat, when the token was simply mistyped.
      if (/unauthorized|not found|HTTP 40[14]/i.test(e.message)) {
        console.error('Telegram rejected the bot token: it is not a valid one.');
        console.error('Check it against the token @BotFather gave you (it looks like 123456789:AAH...),');
        console.error(`and correct it in ${CFG_PATH}, or re-run the setup script to paste it again.`);
        process.exit(2);
      }
      throw e;
    }
    if ((updates || []).some(u => u.message?.chat?.id) || Date.now() >= deadline) break;
    console.log('No message yet — still looking (the bot keeps checking for ~30 seconds)...');
    await new Promise(r => setTimeout(r, 5_000));
  }
  const withChat = (updates || []).reverse().find(u => u.message?.chat?.id);
  if (!withChat) {
    console.error('The token works, but the bot has received no messages yet.');
    console.error('Open Telegram, find your bot, send it any message, then re-run this.');
    process.exit(1);
  }
  const chat = withChat.message.chat;
  c.chat_id = String(chat.id);
  writeFileSync(CFG_PATH, JSON.stringify(c, null, 2) + '\n', 'utf-8');
  // ➤ telegram.json holds the bot token — keep it readable only by you (0600).
  // ➤ On systems without POSIX permissions (e.g. Windows) this is a harmless no-op.
  try { chmodSync(CFG_PATH, 0o600); } catch { /* not POSIX — ignore */ }
  await sendTelegram(`Connected. I'll notify you here when there are new offers.`);
  console.log(`chat_id ${c.chat_id} (${chat.first_name || chat.username || 'chat'}) saved. Confirmation sent.`);
}

// ➤ "--test" mode: sends a test message to check that everything works.
async function cliTest() {
  if (!telegramConfigured()) {
    console.error('Not configured. Fill server-bot/telegram.json and run --setup first.');
    process.exit(1);
  }
  await sendTelegram('Test message. The channel works.');
  console.log('Test message sent.');
}

// ➤ This block only runs when the file is launched by hand (node notify.mjs
// ➤ --setup or --test), never when another module imports it. The path
// ➤ separator is part of the check so "test-notify.mjs" can't trigger it.
if (process.argv[1] && /(^|[\\/])notify\.mjs$/.test(process.argv[1])) {
  const arg = process.argv[2];
  if (arg === '--setup') cliSetup().catch(e => { console.error(e.message); process.exit(1); });
  else if (arg === '--test') cliTest().catch(e => { console.error(e.message); process.exit(1); });
  else {
    console.log('Usage: node server-bot/notify.mjs --setup | --test');
    console.log(`Configured: ${telegramConfigured() ? 'yes' : 'no'}`);
  }
}
