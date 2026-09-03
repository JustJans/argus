// ➤ The page where an offer really lives. An aggregator such as Adzuna re-posts other
// ➤ sites' adverts and sends the reader through a chain of bounces (its own landing page,
// ➤ a click tracker, a cookie wall) before the posting itself. This module walks that
// ➤ chain once, at scan time, so the list carries the final page and you click once.
// ➤ Measured on 35 live Adzuna adverts (2026-09-03): 28 reach their page in one bounce.
// ➤ BuscoJobs hides its source behind a login, and click trackers guarded by DataDome
// ➤ answer 403 even to a real browser: those keep the aggregator link, which still works.
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fold } from './text.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');

// ➤ Sites that only re-post: never the root, and a dead end when they offer no way on.
const AGGREGATORS = ['adzuna.', 'buscojobs.', 'jooble.', 'talent.com', 'neuvoo.', 'jobrapido.', 'careerjet.',
  'optioncarriere.', 'trovit.', 'mitula.', 'jobtome.', 'jobijoba.', 'jobted.', 'jobsora.', 'joblift.', 'kimeta.',
  'jobboerse.', 'whatjobs.', 'jobisjob.', 'jobkralle.', 'jobbydoo.'];
// ➤ Click counters that bounce on to the advert, or refuse a script with a captcha.
const TRACKERS = ['appcast.io', 'goldenbees.', 'jobroute.io', 'prng.co', 'holeest.com', 'jobg8.', 'joveo.',
  'talroo.', 'clickcast.', 'jobtarget.', 'recruitics.', 'pandologic.', 'doubleclick.'];
const TRACKER_PREFIX = /^(click|clk|track|tag|dsp|redirect)\./;
// ➤ Cookie walls that park the reader and keep the real address in a parameter.
const CONSENT = ['myprivacy.', 'consent.', 'cmp.'];
const CONSENT_PARAMS = ['callbackUrl', 'callbackurl', 'returnUrl', 'return_url', 'redirectUrl', 'redirect', 'url', 'target', 'continue'];

// ➤ 'aggregator' | 'tracker' | 'consent' | 'page' — page is anything that can host the
// ➤ advert itself: a board, an agency, an employer, an applicant-tracking system.
export function classifyHost(host) {
  const h = String(host || '').toLowerCase();
  if (CONSENT.some(c => h.startsWith(c) || h.includes('.' + c))) return 'consent';
  if (TRACKERS.some(t => h.includes(t)) || TRACKER_PREFIX.test(h)) return 'tracker';
  if (AGGREGATORS.some(a => h.includes(a))) return 'aggregator';
  return 'page';
}

// ➤ The "apply" bounce of an Adzuna details page (/land/ad/<id>?...), made absolute.
export function landLinkFrom(html, pageUrl) {
  const m = String(html || '').match(/["'](https?:\/\/[^"']*?\/land\/ad\/\d+[^"']*|\/land\/ad\/\d+[^"']*)["']/);
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), pageUrl).href; } catch { return null; }
}

// ➤ The campaign tail a board adds for the aggregator ("utm_source=adzuna", "cid=partner_
// ➤ adzuna") is not part of the advert's address; without it the same posting found twice
// ➤ compares equal, and the link you keep is the one the board itself uses.
const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|msclkid|clickid|click_id|campaign_id|mc_cid|mc_eid|_hsenc|_hsmi)$/i;
export function stripTracking(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  for (const k of [...u.searchParams.keys()]) {
    const partner = k.toLowerCase() === 'cid' && /^partner_/i.test(u.searchParams.get(k) || '');
    if (TRACKING_PARAM.test(k) || partner) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString().replace(/\?$/, '');
}

// ➤ Where a page sends the reader next by itself: a meta refresh or a script jump. Only a
// ➤ jump to ANOTHER site counts — a same-site jump is a cookie script or a homepage, never
// ➤ the advert (APEC, Ouest-France and XING all "jump" that way from a perfectly good page).
export function nextHop(html, base) {
  const h = String(html || '');
  const meta = h.match(/http-equiv=["']?refresh["']?[^>]*?url=([^"'>\s;]+)/i);
  const js = h.match(/(?:location\.href\s*=|location\.replace\(|window\.location\s*=)\s*["']([^"']+)["']/);
  let baseHost;
  try { baseHost = new URL(base).hostname; } catch { return null; }
  for (const raw of [meta?.[1], js?.[1]]) {
    if (!raw) continue;
    let u;
    try { u = new URL(raw, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname === baseHost) continue;
    return u.href;
  }
  return null;
}

// ➤ The address a cookie wall was asked to come back to, when it says so.
function consentExit(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const k of CONSENT_PARAMS) {
    const v = u.searchParams.get(k);
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

// ➤ Does the page speak of this advert at all? A board that bounced to its homepage or to
// ➤ "job no longer available" does not carry the title's longer words.
export function titleMatches(html, title) {
  const words = fold(String(title || '')).match(/[a-z0-9]{5,}/g) || [];
  if (!words.length) return true;
  const text = fold(String(html || ''));
  return words.some(w => text.includes(w));
}

// ➤ Walks the bounces from an aggregator's "apply" link to the page that holds the advert.
// ➤ `get(url)` fetches one address following HTTP redirects and answers {url, status,
// ➤ html} — injected, so the walk is tested without a network. Returns {root, hops,
// ➤ reason}: root null means "keep the link you had", and the reason says why in words.
export async function resolveRoot(landUrl, { get, title = '', maxHops = 6 } = {}) {
  const hops = [];
  let cur = landUrl;
  for (let i = 0; i < maxHops && cur; i++) {
    let r;
    try { r = await get(cur); } catch (e) { return { root: null, hops, reason: `error: ${String(e.message || e).slice(0, 60)}` }; }
    if (!r || !r.url) return { root: null, hops, reason: 'no answer' };
    let host, path;
    try { const u = new URL(r.url); host = u.hostname; path = u.pathname.replace(/\/$/, ''); } catch { return { root: null, hops, reason: 'unreadable address' }; }
    hops.push(host);
    const kind = classifyHost(host);
    if (kind === 'consent') {
      const exit = consentExit(r.url);
      if (exit) { cur = exit; continue; }
      return { root: null, hops, reason: 'cookie wall with no way back' };
    }
    if (r.status >= 400) return { root: null, hops, reason: `${kind} answered ${r.status}` };
    if (kind === 'tracker' || kind === 'aggregator') {
      const next = nextHop(r.html, r.url);
      if (next) { cur = next; continue; }
      return { root: null, hops, reason: kind === 'tracker' ? 'tracker gives no way on' : 'aggregator hides its source' };
    }
    // ➤ A real page — unless it is plainly a homepage, or never mentions the advert.
    if (!path || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(path)) return { root: null, hops, reason: 'landed on a homepage' };
    if (!titleMatches(r.html, title)) return { root: null, hops, reason: 'page does not mention the title' };
    return { root: stripTracking(r.url), hops, reason: 'page' };
  }
  return { root: null, hops, reason: 'too many bounces' };
}

// ➤ The aggregator link an offer came through, kept in the history's last column ("via")
// ➤ when the list shows the root instead: the letter writer and the Council read the
// ➤ advert's clean text there, and the scanner keeps recognising the re-post as seen.
const key = u => String(u || '').split('?')[0].replace(/\/$/, '');
export function viaFor(url, historyPath = HISTORY_PATH) {
  if (!historyPath || !existsSync(historyPath)) return null;
  const wanted = key(url);
  if (!wanted) return null;
  for (const line of readFileSync(historyPath, 'utf-8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 8 && cols[7] && key(cols[0]) === wanted) return cols[7];
  }
  return null;
}
