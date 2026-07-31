#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT THIS FILE IS: the main job-offer scanner.
// ➤ Every 2 hours (launched by the server's automatic scheduler) it visits
// ➤ the job portals (Workday, Oracle, Greenhouse, Ashby, Lever, Adzuna
// ➤ and LinkedIn), collects the new offers, discards the ones that don't fit
// ➤ (by title, country, language or years of experience required), removes
// ➤ the duplicates and the ones already dead, records the good ones in the
// ➤ data/pipeline.md list and the data/scan-history.tsv history, and sends
// ➤ them to you on Telegram grouped by country (using notify.mjs).
// ➤ It reads the configuration from portals.yml (companies and filters) and
// ➤ from server-bot/countries.yml (countries turned on/off).
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * scan.mjs (server-bot) — Zero-token portal scanner
 *
 * Sources, all pure HTTP + JSON (zero Claude tokens):
 *   - Greenhouse / Ashby / Lever   (by domain detection)
 *   - Workday      workday: { tenant, dc, site }   in portals.yml
 *   - Oracle Cloud oracle:  { host, site }         in portals.yml
 *   - Adzuna       adzuna: { queries: [...] }      in portals.yml
 *
 * On top of portals.yml filters it applies a per-country toggle
 * (server-bot/countries.yml), drops dead Adzuna links (liveness),
 * dedups across scans by normalised URL AND company+title, and can
 * notify new offers via Telegram (server-bot/telegram.json).
 *
 * Usage:
 *   node server-bot/scan.mjs
 *   node server-bot/scan.mjs --dry-run
 *   node server-bot/scan.mjs --company Fugro
 *   node server-bot/scan.mjs --explain --dry-run
 */

// ➤ Tools this file needs: read/write files, read the YAML
// ➤ configuration, and the requirements reader (years of experience
// ➤ required and degree demanded) from the body of the offers.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
// ➤ Atomic full-file overwrite (temp file + rename) so a crash mid-write can't
// ➤ truncate the pending list. Used for the pipeline.md rewrite below.
import { writeFileAtomic, withFileLock } from './fs-atomic.mjs';
import { PENDING_HEADING, PROCESSED_HEADING, pendingIndex } from './pipeline-format.mjs';
// ➜ The blind-spot record: what the title filter throws away. Fed here,
// ➜ read by argus-discover. See that file for why recurrence is the signal.
import { mergeDrops, loadStore, saveStore } from './argus-discover/blind-spots.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { experienceScreen, degreeScreen, stripHtml, extractAdzunaJd, searchProfile, PRIORITY_KEEP } from './requirements.mjs';

const parseYaml = yaml.load;

// ── Paths (argus root = parent of server-bot/) ─────────────────
// ➤ Here we record the paths of every file the scanner uses: the
// ➤ configuration, the offer list, the history and the state of the
// ➤ last scan. This way the rest of the program doesn't repeat paths by hand.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);

const PORTALS_PATH = join(ROOT, 'portals.yml');
const COUNTRIES_PATH = join(SCRIPT_DIR, 'countries.yml');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const STATE_PATH = join(SCRIPT_DIR, 'last-scan.json');

// ➤ Makes sure the data/ folder exists before writing to it.
mkdirSync(join(ROOT, 'data'), { recursive: true });

// ➤ Loads Argus's "dead offer" detector (server-bot/liveness-core.mjs);
// ➤ if for whatever reason it were missing, it uses a minimal plan B: it only
// ➤ considers an offer dead if the site answers "doesn't exist" (404 or 410 errors).
let classifyLiveness;
try {
  ({ classifyLiveness } = await import('file://' + join(SCRIPT_DIR, 'liveness-core.mjs').replace(/\\/g, '/')));
} catch {
  classifyLiveness = ({ status }) =>
    (status === 404 || status === 410)
      ? { result: 'expired', reason: `HTTP ${status}` }
      : { result: 'active', reason: 'fallback' };
}

// ➤ Prudence limits: how many requests at a time (so as not to overload)
// ➤ and how long to wait at most for each response (15 seconds).
const CONCURRENCY = 8;
const LIVENESS_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;

// ── Small helpers ───────────────────────────────────────────────────

// ➤ Cleans a text by removing the characters that would break the format of
// ➤ the lists (vertical bars, tabs, line breaks).
function sanitizeField(s) {
  // ➤ HTML ENTITIES are decoded here (audit 2026-07-25): portals return titles
  // ➤ like "Gearboxes &amp; Powertrain" and that "&amp;" was reaching Telegram
  // ➤ verbatim, because only the offer BODY was ever decoded.
  return String(s || '')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39|rsquo|lsquo);/gi, "'")
    .replace(/&(?:lt|#60);/gi, '<').replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:ndash|#8211);/gi, '-').replace(/&(?:mdash|#8212);/gi, '—')
    .replace(/[|\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ➤ A job link is only trusted if it parses as a normal http(s) URL with no
// ➤ whitespace, control characters or "|". Every other field is cleaned with
// ➤ sanitizeField before being written, but the URL is written raw (it is a key
// ➤ and must stay clickable), so a crafted link with a newline inside could
// ➤ otherwise inject a whole fake line into pipeline.md or scan-history.tsv.
// ➤ A genuine portal link never looks like this, so we drop the offer at the gate.
export function isSafeUrl(u) {
  const s = String(u || '');
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // reject "|", plus space/tab/newline and any other control character
    if (ch === '|' || code < 0x21 || code === 0x7f) return false;
  }
  try {
    const { protocol } = new URL(s);
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

// ➤ Fixes the location: removes repeated parts ("España, España" → "España")
// ➤ and trims it if it's very long.
function normalizeLocation(loc) {
  const parts = String(loc || '').split(',').map(p => p.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(p); }
  }
  let out = unique.join(', ');
  if (out.length > 70) out = out.slice(0, 67) + '…';
  return out;
}

// ➤ Simplifies a web address so it can be compared: it removes the tracking
// ➤ "tail" that changes on every visit. Without this, the same Adzuna offer
// ➤ would look new on every scan. Also (2026-07-18): Adzuna's
// ➤ /land/ad/<id> bounce and its /details/<id> page are THE SAME offer,
// ➤ so for comparison they are both mapped to /details/<id> — without this, the switch
// ➤ to /details links would have made "new" every offer already seen.
export function normUrl(u) {
  const s = (u || '').split('?')[0].replace(/\/$/, '');
  return s.replace(/^(https?:\/\/[^/]*adzuna\.[a-z.]+)\/land\/ad\/(\d+)$/, '$1/details/$2');
}

// ── API detection ───────────────────────────────────────────────────

// ➤ Looks at each company's entry in portals.yml and figures out which job
// ➤ portal it uses (Workday, Oracle, Greenhouse, Ashby or Lever), to know
// ➤ how to ask it for the offer list. If it recognizes none, it returns
// ➤ "nothing" and that company is skipped.
function detectApi(company) {
  // Workday (explicit config block)
  if (company.workday?.tenant && company.workday?.site) {
    const { tenant, dc = 'wd3', site } = company.workday;
    return {
      type: 'workday',
      url: `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      meta: { tenant, dc, site },
    };
  }

  // Oracle Cloud Recruiting (explicit config block)
  if (company.oracle?.host && company.oracle?.site) {
    const { host, site } = company.oracle;
    return { type: 'oracle', url: null, meta: { host, site } };
  }

  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // ➤ Checks whether the company's careers site is the "Ashby" type
  // ➤ by looking at whether its address contains "jobs.ashbyhq.com".
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // ➤ The same but for the "Lever" portal.
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }

  // ➤ And the same for "Greenhouse" (accepts the European .eu variant).
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── Parsers ─────────────────────────────────────────────────────────
// ➤ Each portal returns its offers in a different format. These
// ➤ "translator" functions convert each portal's response into the
// ➤ same common format: title, link, company and location.

function parseGreenhouse(json, name) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.absolute_url || '', company: name,
    location: j.location?.name || '',
  }));
}
function parseAshby(json, name) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.jobUrl || '', company: name,
    location: j.location || '',
  }));
}
function parseLever(json, name) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '', url: j.hostedUrl || '', company: name,
    location: j.categories?.location || '',
  }));
}
// ➤ Workday translator. Important detail: when an offer says
// ➤ "2 Locations" (several locations without saying which), the
// ➤ location is left empty so as not to discard it by mistake; further below there is a step
// ➤ that finds out the real locations of those offers.
function parseWorkday(json, name, meta) {
  const base = `https://${meta.tenant}.${meta.dc}.myworkdayjobs.com/en-US/${meta.site}`;
  return (json.jobPostings || []).map(j => {
    // "2 Locations" carries no country info — treat as unknown (passes
    // location filters) rather than silently dropping multi-location jobs.
    let loc = j.locationsText || '';
    // ➤ Checks whether the location is only "N locations" (a number and the
    // ➤ word "locations"), i.e. with no useful information.
    if (/^\d+\s+locations$/i.test(loc.trim())) loc = '';
    return {
      title: j.title || '',
      url: j.externalPath ? base + j.externalPath : '',
      company: name,
      location: loc,
    };
  });
}
// ➤ Oracle translator. The link format is verified by hand:
// ➤ with the wrong format, DNV's site sent you to the global list
// ➤ and the user ended up seeing India/UK offers. Hence the warning below.
function parseOracle(json, name, meta) {
  const items = json.items?.[0]?.requisitionList || [];
  // URL format VERIFIED against DNV's live site (Google-indexed job pages):
  // it is /requisitions/preview/{Id}. The /job/{Id} route does NOT exist in
  // their Oracle CX version — the SPA silently falls back to the global job
  // list, which made the user land on India/UK listings. HTTP 200 means nothing
  // on an SPA; only the real link format counts.
  const base = `https://${meta.host}/hcmUI/CandidateExperience/en/sites/${meta.site}/requisitions/preview`;
  return items.map(j => ({
    title: j.Title || '',
    url: j.Id ? `${base}/${j.Id}` : '',
    company: name,
    location: j.PrimaryLocation || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch ───────────────────────────────────────────────────────────

// ➤ Pagination caps: how many offers to request per page and how many
// ➤ pages at most, so as not to request endless old offers.
const WORKDAY_PAGE = 20;          // Workday returns 20 per page
const WORKDAY_MAX_PER_TERM = 60;  // cap pages per search term (3 pages)
const ORACLE_PAGE = 50;           // Oracle finder page size
const ORACLE_MAX = 150;           // 3 pages, newest first

// ➤ Requests data from a web address and returns the response. If it takes more
// ➤ than 15 seconds, it cuts the wait so the scan doesn't hang.
async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ➤ Same as the previous one, but with retries: if the failure is transient
// ➤ (the portal's server is overloaded), it waits a bit and tries
// ➤ again up to 3 times. If the failure is "you've made too many requests"
// ➤ (error 429), it does NOT retry: we must stop so as not to make it worse.
async function fetchJsonRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url, opts);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message);
      if (msg.includes('429')) throw e;
      // ➤ Only retries if the error looks temporary (server failure
      // ➤ or network drop); any other error is treated as final.
      if (!/HTTP 5\d\d|aborted|fetch failed|network/i.test(msg)) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ➤ Collects a company's offers on Workday: it searches each configured
// ➤ keyword, pages through the results, and saves each
// ➤ offer only once even if it appears in several searches.
async function collectWorkday(api, name, searchTerms) {
  const terms = searchTerms.length ? searchTerms : [''];
  const byUrl = new Map();
  for (const term of terms) {
    for (let offset = 0; offset < WORKDAY_MAX_PER_TERM; offset += WORKDAY_PAGE) {
      let json;
      try {
        json = await fetchJson(api.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: term }),
        });
      } catch {
        break; // move to next term on error
      }
      const jobs = parseWorkday(json, name, api.meta);
      for (const j of jobs) if (j.url) byUrl.set(j.url, j);
      if (offset + WORKDAY_PAGE >= (json.total || 0)) break; // no more pages
    }
  }
  return [...byUrl.values()];
}

// ➤ Collects a company's offers on Oracle: it requests the most recent ones
// ➤ first, page by page, up to the cap of 150 offers.
async function collectOracle(api, name) {
  const { host, site } = api.meta;
  const byUrl = new Map();
  for (let offset = 0; offset < ORACLE_MAX; offset += ORACLE_PAGE) {
    const url = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
      + `?onlyData=true&expand=requisitionList`
      + `&finder=findReqs;siteNumber=${site},limit=${ORACLE_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    let json;
    try { json = await fetchJson(url); } catch { break; }
    const jobs = parseOracle(json, name, api.meta);
    if (jobs.length === 0) break;
    for (const j of jobs) if (j.url) byUrl.set(j.url, j);
    const total = json.items?.[0]?.TotalJobsCount || 0;
    if (offset + ORACLE_PAGE >= total) break;
  }
  return [...byUrl.values()];
}

// ── Adzuna aggregator (Indeed + EU boards, by country + query) ──────
// Free API: https://developer.adzuna.com/ — credentials in
// server-bot/adzuna-key.json or env ADZUNA_APP_ID / ADZUNA_APP_KEY.
// One request per (enabled country × query). Failures are COUNTED and
// surfaced (they used to be silent — that hid real outages).
// ➤ Adzuna is an aggregator: a search engine that gathers offers from many
// ➤ portals (Indeed and European job boards). It's queried for each
// ➤ combination of enabled country × configured search.

// ➤ Looks for Adzuna's access keys (a kind of username and
// ➤ password for its service): first in the system variables,
// ➤ then in the adzuna-key.json file. Without keys, Adzuna is skipped.
// ➜ Exported so argus-discover can query Adzuna with the SAME credentials
// ➜ instead of growing a second copy of this that could drift.
export function loadAdzunaCreds() {
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    return { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
  }
  const keyPath = join(SCRIPT_DIR, 'adzuna-key.json');
  if (existsSync(keyPath)) {
    try {
      const j = JSON.parse(readFileSync(keyPath, 'utf-8'));
      if (j.app_id && j.app_key) return { id: j.app_id, key: j.app_key };
    } catch {}
  }
  return null;
}

// ➤ Turns the Adzuna salary into a short, honest text ("€35-45k").
// ➤ If Adzuna ESTIMATED it (it didn't come in the posting), a "~" is prepended so
// ➤ you never take an estimate for a real figure. Switzerland goes in CHF. Suspiciously
// ➤ low figures (<10k/year) are omitted (they're usually API garbage).
// ➤ Exported so it can be tested in test-filter.mjs.
export function formatSalary(min, max, predicted, countryCode) {
  let lo = Number(min) || 0, hi = Number(max) || 0;
  if (!lo && !hi) return '';
  if (Math.max(lo, hi) < 10_000) return '';
  // ➤ Audit 2026-07-18: if the API came with min>max, it's reordered (before,
  // ➤ a nonsensical range like "€80-20k" came out).
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  const k = v => Math.round(v / 1000);
  const cur = countryCode === 'ch' ? 'CHF ' : '€';
  const range = lo && hi && k(lo) !== k(hi) ? `${k(lo)}-${k(hi)}k` : `${k(hi || lo)}k`;
  return `${predicted ? '~' : ''}${cur}${range}`;
}

// ➤ Adzuna translator to the common offer format. It also saves the
// ➤ short description snippet, which later serves the years-of-experience
// ➤ filter without having to make another request — and the SALARY
// ➤ (2026-07-18, approved improvement: it came free in the same response and was
// ➤ thrown away; now it's shown on Telegram).
// ➤ Adzuna sometimes gives the "good" link (/details/<id>: ITS page, where the
// ➤ offer is READ) and other times a tracking BOUNCE (/land/ad/<id>) that dumps you
// ➤ on the advertiser's form (in Germany, XING) without letting you read anything
// ➤ (the user's real case, 2026-07-18). Here the page is ALWAYS forced,
// ➤ built with the posting id over the country's domain.
function adzunaDetailsUrl(redirectUrl, id) {
  const m = String(redirectUrl || '').match(/^(https?:\/\/[^/]*adzuna\.[a-z.]+)\//);
  return (m && id) ? `${m[1]}/details/${id}` : (redirectUrl || '');
}

function parseAdzuna(json, countryCode) {
  return (json.results || []).map(r => ({
    title: r.title || '',
    url: adzunaDetailsUrl(r.redirect_url, r.id),
    company: r.company?.display_name || 'Adzuna',
    location: [r.location?.display_name, ...(r.location?.area || [])].filter(Boolean).join(', '),
    // Adzuna carries a ~200-char description snippet in the list response —
    // enough for the years-of-experience screen without a second request.
    description: r.description || '',
    salary: formatSalary(r.salary_min, r.salary_max, r.salary_is_predicted === '1' || r.salary_is_predicted === 1 || r.salary_is_predicted === true, countryCode),
  }));
}

// ➤ Goes through all enabled countries and all configured searches
// ➤ requesting offers from Adzuna. It counts how many requests went well and
// ➤ how many failed (failures are shown, not hidden), and if Adzuna
// ➤ says "too many requests" it stops immediately with whatever it has.
async function collectAdzuna(creds, cfg, countryOffNames) {
  const countries = cfg.countries || [];
  // New format: queries: [{what: "..."} | {what_or: "w1 w2 ..."}].
  // Back-compat: keywords: ["phrase", ...] → treated as {what}.
  const queries = (cfg.queries && cfg.queries.length)
    ? cfg.queries
    : (cfg.keywords || ['offshore']).map(k => ({ what: k }));
  const maxDaysOld = cfg.max_days_old || 21;
  const perPage = Math.min(cfg.results_per_page || 50, 50);
  const sortBy = cfg.sort_by || 'date';

  const byUrl = new Map();
  let calls = 0, failed = 0;
  const failures = [];

  for (const c of countries) {
    // ➤ If the country is turned off in countries.yml, it isn't even queried.
    if (countryOffNames.includes(c.name)) continue;
    for (const q of queries) {
      const params = new URLSearchParams({
        app_id: creds.id, app_key: creds.key,
        results_per_page: String(perPage),
        max_days_old: String(maxDaysOld),
        sort_by: sortBy,
        'content-type': 'application/json',
      });
      if (q.what) params.set('what', q.what);
      if (q.what_or) params.set('what_or', q.what_or);
      const url = `https://api.adzuna.com/v1/api/jobs/${c.code}/search/1?${params}`;
      try {
        const json = await fetchJsonRetry(url);
        calls++;
        for (const o of parseAdzuna(json, c.code)) {
          if (!o.url) continue;
          // Adzuna results always carry a location in practice. If one ever
          // comes empty, fall back to the queried country AND log it loudly —
          // the user wants the city, so an empty location is an anomaly to show,
          // not to paper over silently.
          if (!o.location) {
            o.location = c.name;
            failures.push(`no location in API for ${o.url} — country fallback used`);
          }
          byUrl.set(o.url, o);
        }
      } catch (err) {
        // ➤ If Adzuna warns of "too many requests" (error 429), it
        // ➤ returns what has been collected so far and flags the warning.
        if (String(err.message).includes('429')) {
          return { offers: [...byUrl.values()], calls, failed, failures, rateLimited: true };
        }
        failed++;
        if (failures.length < 3) failures.push(`${c.code}/${q.what || q.what_or}: ${err.message}`);
      }
    }
  }
  return { offers: [...byUrl.values()], calls, failed, failures, rateLimited: false };
}

// ── LinkedIn jobs-guest (public, unauthenticated, country-agnostic) ─
// Mechanism adopted from MadsLorentzen/ai-job-search (MIT). These are the
// endpoints LinkedIn serves to logged-OUT visitors: no account involved,
// no cookies. ToS caveat is real though — LinkedIn disallows automated
// access — so volume is kept MINIMAL by design: a few queries, one page
// each, at most once every `every_hours`, with a 24h self-cooldown on 429.
// Disable anytime: portals.yml → linkedin.enabled: false.
// ➤ LinkedIn is queried as a "visitor without an account" (the same thing anyone
// ➤ sees without logging in). Since LinkedIn doesn't want robots, it's
// ➤ done with a lot of moderation: few searches, one page each,
// ➤ at most every X hours, and if LinkedIn complains a 24-hour rest
// ➤ is saved. It can be turned off entirely from portals.yml.

const LI_STATE_PATH = join(SCRIPT_DIR, 'linkedin-state.json');

// ➤ The LinkedIn page doesn't arrive as ordered data but as HTML
// ➤ (the web page's code). This function "digs through" that code for
// ➤ the title, company and location of each offer card.
export function parseLinkedInCards(html) {
  // ➤ Splits the page using the marker LinkedIn puts at the start of
  // ➤ each offer; each resulting chunk is an offer.
  const cards = String(html || '').split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  const out = [];
  for (const c of cards) {
    // ➤ The number at the start of the chunk is the offer's identifier.
    const id = c.match(/^(\d+)/)?.[1];
    if (!id) continue;
    // ➤ These three lines extract title, company and location by looking for
    // ➤ the tags LinkedIn uses to mark each piece of data on the page.
    const title = c.match(/base-search-card__title[^>]*>\s*([^<]+)/)?.[1]?.trim() || '';
    const company = c.match(/base-search-card__subtitle[^>]*>\s*<a[^>]*>\s*([^<]+)/)?.[1]?.trim()
      || c.match(/base-search-card__subtitle[^>]*>\s*([^<]+)/)?.[1]?.trim() || 'LinkedIn';
    const location = c.match(/job-search-card__location[^>]*>\s*([^<]+)/)?.[1]?.trim() || '';
    out.push({ id, title, company, location, url: `https://www.linkedin.com/jobs/view/${id}` });
  }
  return out;
}

// ➤ Queries LinkedIn respecting its limits: first it checks whether it's time
// ➤ to rest (24h penalty, or the hours between queries haven't
// ➤ passed yet); if so, it does nothing. If it queries, it saves the time in a
// ➤ little state file for next time.
async function collectLinkedIn(cfg) {
  const state = existsSync(LI_STATE_PATH)
    ? (() => { try { return JSON.parse(readFileSync(LI_STATE_PATH, 'utf-8')); } catch { return {}; } })()
    : {};
  const now = Date.now();
  // ➤ Are we in a penalty period for having received a "429"? Wait.
  if (state.cooldown_until && now < state.cooldown_until) {
    return { offers: [], calls: 0, status: `cooldown until ${new Date(state.cooldown_until).toISOString().slice(0, 16)}` };
  }
  const everyMs = (cfg.every_hours || 6) * 3600_000;
  // ➤ Have the minimum hours since the last query not passed yet? Skip.
  if (state.last_run && now - state.last_run < everyMs) {
    return { offers: [], calls: 0, status: 'cadence-skip' };
  }

  const maxAgeSec = (cfg.max_age_days || 7) * 86400;
  const byUrl = new Map();
  let calls = 0;
  let rateLimited = false;

  for (const q of cfg.queries || []) {
    const params = new URLSearchParams({
      keywords: q.keywords || '', location: q.location || '',
      f_TPR: `r${maxAgeSec}`, start: '0',
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      // ➤ The request presents itself as a normal browser (Chrome
      // ➤ User-Agent) because LinkedIn doesn't respond to "anonymous" requests.
      const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      clearTimeout(timer);
      calls++;
      // ➤ If LinkedIn responds "too many requests", it stops dead.
      if (res.status === 429) { rateLimited = true; break; }
      if (!res.ok) continue;
      for (const o of parseLinkedInCards(await res.text())) byUrl.set(o.url, o);
      await new Promise(r => setTimeout(r, 1500)); // gentle pacing between queries
    } catch { /* skip query on network error */ }
  }

  // ➤ Records when it was queried and, if LinkedIn complained, schedules
  // ➤ the 24-hour rest for the next scan.
  const newState = { last_run: now };
  if (rateLimited) newState.cooldown_until = now + 24 * 3600_000;
  // ➤ --dry-run must touch NO file (audit 2026-07-25): this one slipped through
  // ➤ and a dry run silently moved the LinkedIn cursor forward.
  if (!process.argv.includes('--dry-run')) writeFileSync(LI_STATE_PATH, JSON.stringify(newState), 'utf-8');

  return {
    offers: [...byUrl.values()], calls,
    status: rateLimited ? 'RATE-LIMITED (24h cooldown set)' : 'ran',
  };
}

// ── Liveness (HTTP only, conservative) ──────────────────────────────
// Only Adzuna offers are checked: aggregator listings go stale, whereas
// Workday/Oracle/Greenhouse offers came straight from the company ATS
// seconds ago — checking those wastes requests on live postings.
// Dead = HTTP 404/410 or an explicit "expired" text pattern. Never dead
// on thin content (JS-heavy SPAs) or network errors.
// ➤ "Live or dead offer" check. Only Adzuna's are
// ➤ checked (the rest come straight from the company and are fresh).
// ➤ The criterion is cautious: when in doubt, the offer is considered live,
// ➤ so as not to lose good offers to a transient website failure.

// ➤ Does the page have a live APPLY button/link? ("Apply now",
// ➤ "Solliciteer", "Jetzt bewerben", "Postuler"...). Strong signal that the
// ➤ offer is still active. Exported so housekeep uses the same one.
export function hasApplySignal(text) {
  return /apply (?:now|today|here|for this (?:job|position|role))|submit (?:your )?application|start (?:your )?application|solliciteer|postule[rz]\b|jetzt bewerben|bewirb dich|ap[úu]ntate|inscr[íi]bete|env[íi]a tu (?:cv|candidatura)|aplicar? ahora/i.test(String(text || ''));
}

// ➤ Anti-false-dead second opinion (caught 2026-07-18): the system's
// ➤ classifier marks "expired" if ANY chunk of the page contains phrases
// ➤ like "position has been filled" — even if they come from a widget of OTHER
// ➤ offers or from generic text, and even if the page has a
// ➤ perfectly live apply button. The user's rule: losing a good offer is
// ➤ the expensive mistake. So: if the "expired" verdict comes from a PHRASE in the
// ➤ text (not from a 404/410 or a redirect, which are hard proof) and
// ➤ the page still has an apply signal → it's considered LIVE.
export function overrideDeadIfApply(verdict, body) {
  // ➤ Audit 2026-07-18: the second opinion only applies to the GENERIC
  // ➤ patterns ("applications closed", "closed on <date>" — the ones that can
  // ➤ come from a FAQ or a holiday notice). The emphatic ones ("position has
  // ➤ been filled", "no longer available/accepting", "job has expired") are almost
  // ➤ always THIS offer's banner: an "Apply Now" from a widget of
  // ➤ similar offers must not revive them.
  const reason = String(verdict?.reason || '');
  const generic = /^pattern matched/.test(reason) && /applications?|closed on/i.test(reason) && !/no longer|filled|expired/i.test(reason);
  if (verdict?.result === 'expired' && generic && hasApplySignal(body)) {
    return { result: 'active', reason: 'apply signal present despite expired-text pattern (server-bot override)' };
  }
  return verdict;
}

async function isLikelyDead(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    let body = '';
    try { body = (await res.text()).slice(0, 20_000); } catch {}
    clearTimeout(timer);
    // ➤ Classifier verdict + anti-false-dead second opinion.
    const { result, reason } = overrideDeadIfApply(
      classifyLiveness({ status: res.status, finalUrl: res.url, bodyText: body }), body);
    // ➤ Only considered dead if the verdict is "expired" AND it wasn't due to
    // ➤ lack of content (pages that load bit by bit are deceptive).
    return result === 'expired' && !reason.includes('insufficient content');
  } catch {
    return false;
  }
}

// ── Job-description fetch (for the years-of-experience screen) ──────
// Only ADMITTED offers reach here (post title/location/language filter),
// so this is a handful of requests per scan, not thousands. Each source
// exposes the body in a different place; on any failure return '' so the
// offer is KEPT (extractRequiredYears('') → null → not dropped).
// ➤ Downloads the full text of an offer (the job description)
// ➤ so it can read how many years of experience they ask for. Each portal stores
// ➤ that text in a different place, so there's one recipe per portal.
// ➤ If something fails, empty text is returned and the offer is KEPT:
// ➤ better to show one too many than to lose a good one to a technical failure.

const DESC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ➤ "Polite fetch": requests the Adzuna/LinkedIn pages calmly (one every
// ➤ ~1.5s) and, if the portal responds "429 too many requests", waits and
// ➤ retries instead of treating the offer as good without having read it. The same
// ➤ mechanism the cleaner (housekeep) already uses — rule: NEVER draw
// ➤ conclusions from a 429.
const SCAN_HOST_GAP_MS = { adzuna: 1500, linkedin: 1200 };
const scanHostLast = new Map();
async function scanPoliteFetch(hostKey, url, opts = {}) {
  const gap = SCAN_HOST_GAP_MS[hostKey] || 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = (scanHostLast.get(hostKey) || 0) + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    scanHostLast.set(hostKey, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': DESC_UA, ...(opts.headers || {}) } });
      if (res.status === 429) {
        // ➤ 15 s penalty after a 429 (previously 8 s: it fell short and the 3
        // ➤ attempts died within the same rate-limit window).
        scanHostLast.set(hostKey, Date.now() + 15_000); // back off the whole host
        continue;
      }
      return res;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null; // still rate-limited → inconclusive
}

async function fetchOfferDescription(o, targetsByName) {
  try {
    // ➤ Workday recipe: the offer's detail page is requested.
    if (o.source === 'workday-api') {
      const t = targetsByName.get(o.company);
      if (!t?._api?.meta) return '';
      const { tenant, dc, site } = t._api.meta;
      const path = o.url.split(`/en-US/${site}`)[1];
      if (!path) return '';
      const j = await fetchJson(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`);
      return stripHtml(j?.jobPostingInfo?.jobDescription || '');
    }
    // ➤ Oracle recipe: the requirements, responsibilities and description
    // ➤ sections are requested, and joined into a single text.
    if (o.source === 'oracle-api') {
      const meta = targetsByName.get(o.company)?._api?.meta;
      // ➤ Pulls the offer's number from its link to request the detail.
      const idm = o.url.match(/\/requisitions\/preview\/(\d+)/);
      if (!meta || !idm) return '';
      const j = await fetchJson(
        `https://${meta.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
        + `?onlyData=true&finder=ById;Id=%22${idm[1]}%22,siteNumber=%22${meta.site}%22`);
      const it = j?.items?.[0] || {};
      return stripHtml([
        it.ExternalQualificationsStr, it.ExternalResponsibilitiesStr,
        it.ExternalDescriptionStr, it.CorporateDescriptionStr,
      ].filter(Boolean).join(' '));
    }
    // ➤ LinkedIn recipe: the offer's public page is requested,
    // ➤ with the polite fetch (anti-429).
    if (o.source === 'linkedin') {
      const idm = o.url.match(/\/jobs\/view\/(\d+)/);
      if (!idm) return '';
      const liUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${idm[1]}`;
      // ➤ LinkedIn throttles/blocks unauthenticated reads probabilistically
      // ➤ (often a 403/999): one failure is usually transient, so try up to
      // ➤ TWICE before giving up. No account or login — just a second PUBLIC
      // ➤ attempt. scanPoliteFetch already paces calls (1.2s gap) and retries
      // ➤ 429s on its own, so this only adds a retry for the block/empty cases.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await scanPoliteFetch('linkedin', liUrl);
        if (res && res.ok) {
          const text = await res.text().catch(() => '');
          if (text.trim()) return stripHtml(text);
        }
      }
      return '';
    }
    // ➤ Adzuna recipe: the short snippet isn't enough (the years
    // ➤ requirement usually isn't there), so the offer's full page is
    // ➤ downloaded and joined with the snippet. This closed the gap through which
    // ➤ "10 years of experience" offers were slipping in.
    if (o.source === 'adzuna') {
      // The ~200-char list snippet almost never carries the years requirement
      // (it lives in the full JD), so high-year offers slipped through — the
      // main gap the user flagged. Adzuna's details page (o.url) hosts the whole
      // body; fetch it and combine with the snippet. Verified live: this
      // recovers "10 años"/"5 years" the snippet omitted.
      let body = '';
      try {
        const res = await scanPoliteFetch('adzuna', o.url, { redirect: 'follow' });
        if (res && res.ok) {
          const html = await res.text();
          // ➤ If the clean description region is found, that one is used
          // ➤ (without menus or related ads) and it's saved in the offer
          // ➤ so the body's LANGUAGE can also be checked on Adzuna.
          const jd = extractAdzunaJd(html);
          if (jd) o._jd = jd;
          body = jd || stripHtml(html);
        } else if (res === null) {
          // ➤ 429 exhausted or network down: the body could NOT be read. It's flagged
          // ➤ to DEFER the offer (real case #626/#627, 2026-07-18: without
          // ➤ this flag they went to the list half-examined).
          o._bodyUnread = true;
        }
      } catch { o._bodyUnread = true; }
      return `${stripHtml(o.description || '')} ${body}`.trim();
    }
    // greenhouse/ashby/lever: content in list when present.
    return stripHtml(o.description || '');
  } catch {
    return '';
  }
}

// ── Title language detection ────────────────────────────────────────
// The user's rule (modes/_profile.md): a MANDATORY language they do not speak
// is a hard blocker. The scanner can't read JDs, but the title language is
// a strong proxy for the working language: a German-titled posting is a
// German-speaking job. EN/ES/CA titles pass; other languages are dropped.
// Detection rides the same free translate endpoint (it returns the source
// language). On any failure → null → the offer is KEPT (never lose offers
// to an outage).
// ➤ Language filter. The user's rule: if the job requires a language the user
// ➤ doesn't speak, out. The title's language is a good clue: an
// ➤ offer with a German title is usually a German-speaking job.
// ➤ English, Spanish and Catalan pass; the rest are discarded.

// ➤ Titles that state the working language outright: "(German or French
// ➤ speaking)", "Dutch-speaking Support Engineer" (#116, 2026-07-10). It looks
// ➤ for a language name closely followed by "speaking" or similar — no API
// ➤ call, fully deterministic. EN/ES/CA are the languages of the profile; any
// ➤ other named language in the title is a requirement that can't be met.
const TITLE_LANG_DEMAND = /\b(german|deutsch|french|dutch|nederlands|flemish|italian|norwegian|danish|swedish|polish|portuguese)\b[^)]{0,25}?(speak(?:ing|er)?|sprechend|sprachig|parlant)/i;

export function titleDemandsForeignLanguage(title) {
  return TITLE_LANG_DEMAND.test(String(title || ''));
}

// ➤ BODY LANGUAGE RULE (refined by the user on 2026-07-18): the language in
// ➤ which the offer IS WRITTEN no longer matters (a Dutch offer that doesn't
// ➤ ask you to speak Dutch can be good). What DOES discard it is the
// ➤ body REQUIRING a language the user doesn't speak: "fluent in German",
// ➤ "Deutschkenntnisse erforderlich", "talen: Nederlands"... And note: if nearby
// ➤ it says "is a plus" or "valued", it's NOT blocked (it's not mandatory).
// ➤ List of languages the user doesn't speak (German, French, Dutch...),
// ➤ written as a search pattern with its variants in several languages.
// ➤ Built from your profile (config/profile.yml → search.languages_blocked);
// ➤ the marine default below (German/French/Dutch...) is used if it's missing.
const LANGWORD = '(?:' + (Array.isArray(searchProfile.languages_blocked) && searchProfile.languages_blocked.length
  ? searchProfile.languages_blocked.join('|')
  : 'german|deutsch\\w*|alem[áa]n|french|fran[çc]ais\\w*|franc[ée]s|dutch|nederlands|neerland[ée]s|flemish|vlaams') + ')';
// ➤ Words that indicate a requirement: "fluent", "required", "imprescindible",
// ➤ "se requiere", "erforderlich", C1/C2 levels, "native"...
// ➤ 2026-07-27: the German and French ways of saying it were missing, so every
// ➤ German offer walked through. Real sentences that escaped: "Deutsch und
// ➤ Englisch fließend in Wort und Schrift" (#697), "Sehr gute Deutsch- und
// ➤ Englischkenntnisse" (#719), "Verhandlungssichere Deutschkenntnisse" (#699).
// ➤ Note "gut\\w*" is only ever read NEXT TO a language word, so "gute
// ➤ Excel-Kenntnisse" alone cannot fire it.
const REQWORD = '(?:fluent|fluency|proficien\\w+|mandatory|compulsory|require[sd]?|obligatorio|obligatoria|imprescindible|requier\\w*|requerid\\w*|necesari[oa]s?|erforderlich|vorausgesetzt|vereist|requis|exig[ée]\\w*|c1|c2|native|muttersprach\\w*|moedertaal'
  + '|flie[sß]end\\w*|verhandlungssicher\\w*|sehr gut\\w*|gute?n? kenntnisse|kenntnisse|beherrsch\\w*|sicher\\w* umgang'
  + '|vlot\\w*|beheers\\w*|goede kennis|uitstekend\\w*|spreekt|schrift'
  + '|courant\\w*|ma[îi]tris\\w*|bilingue|tr[èe]s bon\\w* niveau|niveau (?:c1|c2|courant))';
// ➤ Combines the two lists: it requires the requirement word and the language
// ➤ to appear together in the same sentence (without crossing periods or semicolons),
// ➤ or that there be a list like "Languages: Dutch".
const BODY_LANG_REQ = new RegExp(
  `${REQWORD}[^.!?;]{0,40}\\b${LANGWORD}|\\b${LANGWORD}[^.!?;]{0,30}${REQWORD}|(?:talen|sprachen|langues|idiomas|languages)\\s*:\\s*[^.!?;]{0,30}\\b${LANGWORD}`,
  'i',
);
// ➤ "Softener" phrases: if they appear nearby, the language is only desirable
// ➤ ("a plus", "von Vorteil", "valued"...) and the offer is NOT blocked.
// ➤ 2026-07-27, the owner's rule: "if it says it's a plus, recommended, or whatever, add
// ➤ them". This list is what keeps those offers, so it is deliberately WIDE in
// ➤ the three languages that now block — DE "ein Plus"/"erwünscht", FR "un
// ➤ plus", NL "strekt tot aanbeveling"/"is meegenomen"/"wenselijk". Being
// ➤ generous here is the safe direction: it can only let an offer THROUGH.
const LANG_SOFTENER = /nice to have|a plus|is a plus|ein plus|un plus|erw[üu]nscht|von vorteil|wünschenswert|valorable|se valorar[áa]|pluspunt|is een plus|strekt tot aanbeveling|aanbeveling|meegenomen|wenselijk|atout|desirable|preferred|not required|not mandatory|no es necesario|een pr[ée]|advantag\w*|an asset|beneficial|bonus|welcome|appreciated|only for senior|solo para (?:perfiles |puestos )?senior|nur f[üu]r senior/i;

// ➤ NEGATED REQUIREMENT (owner's rule, 2026-07-18: "if it requires it, drop it; if it
// ➤ doesn't mention it or says it's NOT required, keep it"): phrases like "No German required",
// ➤ "Kein Deutsch erforderlich", "geen Nederlands vereist", "not compulsory",
// ➤ "no se requiere alemán"... are GOOD news, not a requirement. If the
// ➤ phrase contains a negation attached to the requirement word, it's NOT
// ➤ blocked. (Without this, "No German required" discarded the offer — backwards.)
const LANG_NEGATION = /\b(?:no|not|non|pas|kein\w*|geen|niet|nicht|don'?t|do not|doesn'?t|sin|zonder)\b[^.!?;]{0,40}\b(?:requires?|required|requirements?|mandatory|compulsory|necessary|needed|essential|a must|requier\w*|requerid\w*|requisito\w*|necesari[oa]s?|imprescindible|obligatori[oa]s?|requis\w*|exigence\w*|exig[ée]\w*|n[ée]cessaire|erforderlich|voraussetzung\w*|vorausgesetzt|n[öo]tig|vereiste?\w*|nodig|verplicht)\b|no (?:se requiere|hace falta)|not a requirement|geen vereiste|kein muss/i;

// ➤ KNOWN LIMIT, left alone on purpose (2026-07-27). Some portals write
// ➤ their requirements as "* bullet * bullet * bullet" with no full stop, so the
// ➤ whole block is ONE sentence — 1639 characters in the real case, #699 — and a
// ➤ "wünschenswert" two bullets away softens a genuine demand. About 5-10% of
// ➤ bodies come like that. The obvious fix, splitting on the bullet marker, was
// ➤ already tried for </p> and <br> on 2026-07-18 and REVERTED: it also cuts the
// ➤ "Nice to have:" HEADING away from the list under it, and that heading has to
// ➤ keep protecting its own bullets. Any real fix must tell a softener that
// ➤ INTRODUCES a list from one sitting inside a sibling bullet — and be measured
// ➤ verdict by verdict first, because the cost of getting it wrong is a good
// ➤ offer dropped in silence.
export function bodyLanguageBlock(text) {
  const t = String(text || '');
  BODY_LANG_REQ.lastIndex = 0;
  const m = BODY_LANG_REQ.exec(t);
  if (!m) return false;
  // ➤ Audit 2026-07-16: the mitigator ("a plus"/"advantage") only counts if
  // ➤ it's in the SAME sentence as the requirement. Before, it looked ±60 chars
  // ➤ crudely, so "German required. English is a plus" was softened by the
  // ➤ "plus" of the OTHER language → an offer with mandatory German slipped in.
  let s = m.index, e = m.index + m[0].length;
  while (s > 0 && !/[.!?;]/.test(t[s - 1])) s--;
  while (e < t.length && !/[.!?;]/.test(t[e])) e++;
  const clause = t.slice(s, e);
  if (LANG_SOFTENER.test(clause) || LANG_NEGATION.test(clause)) return false;
  // ➤ Caught 2026-07-18: the negation can come AFTER the sentence break.
  // ➤ Case 1 — question-answer format: "Is Dutch required? No, English
  // ➤ suffices." The answer starting with "No" cancels the requirement.
  if (t[e] === '?' && /^\s*(?:no\b|not\b|nee\b|nein\b|non\b|niet\b|nicht\b|para nada|not at all)/i.test(t.slice(e + 1, e + 30))) return false;
  // ➤ Case 2 — clarification in the NEXT sentence that negates THIS requirement:
  // ➤ "French required only for senior positions; this junior role does not
  // ➤ require it." It only counts if the next sentence negates AND talks about this
  // ➤ role ("it", "this role") or the SAME language — so "German required.
  // ➤ English not necessary" (negation of ANOTHER language) still blocks.
  let e2 = e + 1;
  while (e2 < t.length && !/[.!?;]/.test(t[e2])) e2++;
  const next = t.slice(e + 1, e2);
  // ➤ Audit 2026-07-18: the comparison of the SAME language in the next
  // ➤ sentence must ignore case ("German required. German is not
  // ➤ necessary here." — with normal capitalization — stayed blocked).
  const langIn = (m[0].match(new RegExp(LANGWORD, 'i')) || [])[0];
  if (LANG_NEGATION.test(next) &&
      (/\bit\b|this (?:junior )?(?:role|position|job)|este puesto|esta posici[óo]n/i.test(next) ||
       (langIn && next.toLowerCase().includes(langIn.toLowerCase())))) return false;
  return true;
}

// ➤ Finds out the language of a short text by asking Google's free
// ➤ translator (which, besides translating, says which language the
// ➤ original was in). If the query fails, it returns "don't know" and nothing is discarded.
export async function detectTitleLang(title) {
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q='
      + encodeURIComponent(String(title || '').slice(0, 200));
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const lang = typeof data?.[2] === 'string' ? data[2].toLowerCase() : null;
    return lang || null;
  } catch {
    return null;
  }
}

// ── Title filter ────────────────────────────────────────────────────
// Positives: case-insensitive SUBSTRING for word stems ("Mooring" should
// match "Moorings Analyst", "Oceanograph" → "Oceanography") — EXCEPT short
// acronyms (GIS, PLC, ROV...), which get word boundaries: "GIS" as a
// substring matched inside "Lo·gis·tiek" in production.
// Negatives: word-boundary regex with optional plural, so "Intern" blocks
// "Intern"/"Interns" but NOT "International", and "Lead" blocks "Lead
// Engineer" but NOT "Leadership". Substring negatives caused real false
// positives in production.
// ➤ Filter by the offer's TITLE. It works with two lists from portals.yml:
// ➤ "positive" words (the title must contain at least one to pass)
// ➤ and "negative" words (if one appears, the offer is discarded).
// ➤ The details below avoid real mistakes that already happened: "GIS"
// ➤ matching inside "Logistiek", or "Intern" blocking "International".

// ➤ Builds the search pattern of a "bounded" word: it requires
// ➤ the word to appear whole, not hidden inside another. If the word
// ➤ starts with "*", it counts as the end of a compound word (useful in Dutch
// ➤ and German: "*monteur" catches "Servicemonteur").
function boundaryRegex(term, optionalPlural) {
  // Leading "*" = suffix match (no start boundary). Needed for Dutch/German
  // compound words: "*monteur" catches "Servicemonteur", "*manager" catches
  // "Projektmanager". The optional tail also covers plural and German female
  // forms: Technikerin, Projektmanagerin.
  const suffixMode = term.startsWith('*');
  const raw = suffixMode ? term.slice(1) : term;
  // ➤ Escapes special symbols so they're searched literally.
  const esc = raw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = (!suffixMode && /^\w/.test(raw)) ? '\\b' : '';
  // ➤ Optionally allows the plural and the German female forms
  // ➤ (Technikerin, Projektmanagerinnen) without opening the door to other words.
  // ➤ "-es" added 2026-07-13: the Spanish plural in -ores ("Soldadores")
  // ➤ dodged the negative "Soldador" (#566).
  const trail = /\w$/.test(raw) ? (optionalPlural ? '(?:s|es|in|innen)?\\b' : '\\b') : '';
  return new RegExp(lead + esc + trail, 'i');
}

// ➤ Is it a short acronym (2-6 uppercase/numbers, like GIS, PLC, ROV)?
// ➤ Acronyms are searched as whole words to avoid false positives.
const ACRONYM = /^[A-Z0-9.&-]{2,6}$/; // GIS, PLC, SCADA, FPSO, ROV...

// ➤ COMPANY blocklist (portals.yml → company_filter.blocked): no
// ➤ offer from those companies gets in, whatever its title (the user
// ➤ 2026-07-18: Amazon). Whole word, case-insensitive. Returns
// ➤ true if the company PASSES; .explain() says which term blocked it (--explain).
export function buildCompanyFilter(cf) {
  const vetoes = (cf?.blocked || []).map(t => ({ label: String(t), re: boundaryRegex(String(t), false) }));
  const fn = (company) => !vetoes.some(v => v.re.test(String(company || '')));
  fn.explain = (company) => vetoes.find(v => v.re.test(String(company || '')))?.label || null;
  return fn;
}

// ➤ Builds the function that decides whether a title passes the filter: it must
// ➤ contain some positive word and no negative one.
export function buildTitleFilter(tf) {
  const positives = (tf?.positive || []).map(term => {
    if (ACRONYM.test(term)) {
      const re = boundaryRegex(term, false);
      return (s) => re.test(s);
    }
    const k = term.toLowerCase();
    return (s) => s.includes(k);
  });
  // ➤ Negatives take two shapes in the YAML: a plain "Term" blocks always,
  // ➤ while { term: "T", unless: [...] } blocks ONLY when none of the "unless"
  // ➤ words appear in the title — the rule for "Consultant is blocked unless
  // ➤ it's offshore wind or related".
  // ➤ Each negative keeps its LABEL (the term that defines it) alongside its
  // ➤ check, so --explain mode can say WHICH word blocked
  // ➤ each title.
  const negatives = (tf?.negative || []).map(t => {
    if (t && typeof t === 'object' && t.term) {
      const re = boundaryRegex(t.term, true);
      // ➤ WORD-aware rescue (audit 2026-07-25): the unless words were plain
      // ➤ substrings, so "Windows Automation Consultant" was rescued because
      // ➤ "Windows" contains "wind". Each one is matched with its own boundary.
      const unlessRe = (t.unless || []).map(u => boundaryRegex(String(u), true));
      return { label: t.term, test: (s) => re.test(s) && !unlessRe.some(u => u.test(s)) };
    }
    const re = boundaryRegex(t, true);
    return { label: String(t), test: (s) => re.test(s) };
  });
  const fn = (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPos = positives.length === 0 || positives.some(p => p(lower));
    if (!hasPos) return false;
    return !negatives.some(neg => neg.test(lower));
  };
  // ➤ .explain(title): same verdict as the filter, but RETURNS the reason
  // ➤ for the discard as text (for the "why each offer was discarded" list,
  // ➤ --explain mode). If the offer passes the title, it returns null.
  fn.explain = (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPos = positives.length === 0 || positives.some(p => p(lower));
    if (!hasPos) return 'the title has no keyword from your field';
    const hit = negatives.find(neg => neg.test(lower));
    return hit ? `the title has the blocked word "${hit.label}"` : null;
  };
  return fn;
}

// ── Location filter (portals.yml — fixed hard rules) ────────────────
// Block terms use the acronym rule too: "UK" must not match inside
// "Ukraine". Longer names stay substring ("Saudi" → "Saudi Arabia").
// ➤ Filter by LOCATION according to the fixed rules in portals.yml. Same
// ➤ acronym trick: "UK" must not match inside "Ukraine".

// ➤ Builds the function that detects blocked locations in a text.
function buildBlockMatcher(blockTerms) {
  // ➤ FIXED 2026-07-25 (audit): every term is matched as a WHOLE WORD, not as a
  // ➤ loose substring. Before, only ALL-CAPS acronyms got that treatment, so
  // ➤ "Peru" blocked Perugia (Italy) and "Oman" blocked Romans-sur-Isère
  // ➤ (France). Whole-word still catches what it should: "Saudi" → "Saudi Arabia".
  const matchers = (blockTerms || []).map(term => {
    const re = boundaryRegex(term, false);
    return (s) => re.test(s);
  });
  return (text) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return matchers.some(m => m(lower));
  };
}

// ➤ Builds the complete location filter: first it discards the
// ➤ blocked ones, and if there's an allow list, it requires being in it.
// ➤ An empty location always passes (it'll be resolved later).
export function buildLocationFilter(lf) {
  if (!lf) return Object.assign(() => true, { blockHit: () => false });
  const allow = (lf.allow || []).map(k => k.toLowerCase());
  const blockHit = buildBlockMatcher(lf.block);
  const fn = (loc) => {
    if (!loc) return true;
    if (blockHit(loc)) return false;
    if (allow.length === 0) return true;
    const lower = loc.toLowerCase();
    return allow.some(k => lower.includes(k));
  };
  // ➤ The blocked-country detector is exposed separately so it can also be
  // ➤ applied to the TITLE: multi-location Workday jobs say "2 Locations" and
  // ➤ carry the real country only in the title ("Shell Graduate Programme
  // ➤ 2026 - Qatar").
  fn.blockHit = blockHit;
  return fn;
}

// ── Country toggle (countries.yml — dynamic on/off) ─────────────────

// ➤ Reads countries.yml (the countries the user turns on or off by editing that
// ➤ file by hand) and builds the filter: if an offer mentions a country that's
// ➤ off (or one of its aliases, like "Deutschland" for Germany),
// ➤ it's discarded.
function buildCountryFilter() {
  if (!existsSync(COUNTRIES_PATH)) return { fn: () => true, off: [] };
  const cfg = parseYaml(readFileSync(COUNTRIES_PATH, 'utf-8')) || {};
  const countries = cfg.countries || {};
  const aliases = cfg.aliases || {};
  // ➤ Keeps only the countries marked as off (false).
  const off = Object.entries(countries).filter(([, on]) => on === false).map(([c]) => c);

  // ➤ WHOLE-WORD matching (audit 2026-07-25). This used to be a raw substring
  // ➤ test, so switching Denmark off also killed anything in "Brandenburg" (its
  // ➤ alias "Brande") and Italy off killed "Romainville" ("Roma") — allowed
  // ➤ places, dropped in silence.
  const matchers = new Map(off.map(country => [
    country,
    [country, ...(aliases[country] || [])].map(k => boundaryRegex(k, false)),
  ]));

  return {
    off,
    fn: (loc) => {
      if (!loc) return true;
      for (const country of off) {
        if ((matchers.get(country) || []).some(re => re.test(loc))) return false;
      }
      return true;
    },
  };
}

// ── Dedup ───────────────────────────────────────────────────────────
// ➤ Anti-duplicate system. So as not to show an already-seen offer again,
// ➤ all the already-known web addresses are loaded into memory (from the
// ➤ history, the pending list and the applications record).

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(normUrl(url));
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    // ➤ Looks in pipeline.md for the offer lines ("- [ ] link...") and
    // ➤ records their addresses as already seen.
    for (const m of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) seen.add(normUrl(m[1]));
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // ➤ From the applications record it records any web address.
    for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(normUrl(m[0]));
  }
  return seen;
}

// ➤ Second anti-duplicate barrier: the same role can come back with ANOTHER
// ➤ link (aggregators re-post it). It's compared by the company+title
// ➤ pair, normalizing odd dashes and extra spaces: GE Vernova posted the same
// ➤ role twice as "Power Systems - …" and "Power Systems – …" (en dash).
// ➤ Exported to be tested: this key is what makes your "no" stick when a board
// ➤ re-posts the same job with a different link. A mutation that stopped it
// ➤ normalising the en dash — the exact case that made one employer's role
// ➤ appear twice — passed every test in the project.
export function roleKey(company, title) {
  // ➤ Also (Lonza case #595/#602, 2026-07-18): German portals
  // ➤ re-post the SAME role with gender tags "(m/w/d)"/"(All
  // ➤ Genders)" and schedules "80-100%" that vary between postings. They're removed
  // ➤ before comparing, so the re-post doesn't dodge your decision.
  // ➤ (2026-07-19, Sartorius case "(x w m)") the separator of the gender tag
  // ➤ can also be a simple space, not only / | , .
  const norm = s => String(s).toLowerCase()
    .replace(/\(\s*(?:(?:m|w|f|d|x|h|v)(?:\s*[/|,.]?\s*(?:m|w|f|d|x|h|v))+|all\s*genders?|gn)\s*\)/gi, ' ')
    .replace(/\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%|\b\d{2,3}\s*%/g, ' ')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim();
  return `${norm(company)}::${norm(title)}`;
}

// ➤ Loads the company+title pairs that must BLOCK repeats.
// ➤ Rule (2026-07-18, Engibex case): only the ones YOU decided block:
// ➤   · the ones still VISIBLE in your list (you already have them in front of you),
// ➤   · the ones YOU removed (seen/no — they carry the "| visto" marker at the end),
// ➤   · the ones in your applications record (applications.md),
// ➤   · the ones you rejected with a reason (feedback.jsonl).
// ➤ The ones THE BOT hid (dead link, old cleanups) no longer block:
// ➤ if the company re-posts that offer with a new link, it comes back to your list.
// ➤ (Before, it blocked EVERYTHING hidden, and Engibex's "Junior Project Engineer (Offshore)",
// ➤ hidden by a cleanup, ate its reappearances.)
// ➤ Decides, for ONE line of pipeline.md, whether its company+title pair must
// ➤ block reappearances. Returns the key if it blocks, or "nothing" if not.
// ➤   - [ ] ... (visible)            → blocks (you already have it in front of you)
// ➤   - [x] ... | visto              → blocks (YOU removed it)
// ➤   - [x] ... (no "visto" marker)  → does NOT block (the bot hid it; if they
// ➤                                    re-post it, it comes back to your list)
// ➤ Exported so it can be tested in test-filter.mjs.
export function pipelineRoleKey(line) {
  // - [ ] url | company | title [| location] [| #id] [| visto]
  const m = String(line || '').match(/^- \[([ x])\] \S+\s*\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)(?:\s*\|[^\n]*)?$/);
  if (!m) return null;
  if (m[1] === 'x' && !/\|\s*visto\s*$/i.test(line)) return null;
  return roleKey(m[2], m[3]);
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // ➤ From the applications table it extracts the company column and the role one.
    for (const m of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = m[1].trim();
      const role = m[2].trim();
      if (company && role && company.toLowerCase() !== 'company') seen.add(roleKey(company, role));
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const line of readFileSync(PIPELINE_PATH, 'utf-8').split('\n')) {
      const k = pipelineRoleKey(line);
      if (k) seen.add(k);
    }
  }
  // ➤ Your recorded rejections ("no 412 asks for 5 years") always block: you
  // ➤ decided them with reason, even if their list line is old.
  const FEEDBACK_PATH = join(SCRIPT_DIR, 'feedback.jsonl');
  if (existsSync(FEEDBACK_PATH)) {
    for (const line of readFileSync(FEEDBACK_PATH, 'utf-8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r?.company && r?.title) seen.add(roleKey(r.company, r.title));
      } catch { /* corrupt line: ignored */ }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────
// ➤ Writing results: these functions record the new offers
// ➤ in the pending list (pipeline.md) and the history.

// ➤ Adds the new offers to the "Pending" section of pipeline.md.
// ➤ Each one is assigned a fixed number (#412...) that appears in the Telegram
// ➤ messages; that way, when the user replies "seen 412", there's no possible
// ➤ confusion (numbering by position failed because Telegram groups by country).
function appendToPipeline(offers) {
  if (offers.length === 0) return;
  // ➤ Under lock. The scan runs every two hours and takes minutes, but this
  // ➤ part — read the file, add the offers, write it back — must not overlap
  // ➤ with a "seen" from Telegram or with the cleanup. Whoever wrote second
  // ➤ used to erase the other's work: measured, eight overlapping writers kept
  // ➤ 200 lines out of 1600. Only these milliseconds are held, not the scan.
  return withFileLock(PIPELINE_PATH, () => appendToPipelineLocked(offers));
}

function appendToPipelineLocked(offers) {
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : `# Pipeline\n\n${PENDING_HEADING}\n\n${PROCESSED_HEADING}\n`;
  // Stable per-offer ID (last field, "#412"): shown in every Telegram message
  // and used by visto/no. Positional numbering caused wrong-offer feedback —
  // the Telegram list is country-grouped, so positions never matched.
  let nextId = 0;
  // ➤ Finds the highest number already used in the file to keep counting
  // ➤ from it (a number is never repeated). It counts the # at end of line
  // ➤ AND the # right before the "| visto" marker (audit 2026-07-18: the
  // ➤ loose pattern could swallow a "#123" that came inside a title).
  for (const m of text.matchAll(/\|\s*#(\d+)\s*(?:\|\s*visto\s*)?$/gim)) nextId = Math.max(nextId, parseInt(m[1], 10));
  // ➤ HIGH-WATER MARK (audit 2026-07-25). The count above is the largest id
  // ➤ still PRESENT in the file, and housekeep DELETES lines — so when the
  // ➤ highest-numbered offer died, the next new offer got that same number
  // ➤ again, and two different offers ended up sharing one "#412". We also
  // ➤ remember the highest id EVER handed out, so numbers only move forward.
  nextId = Math.max(nextId, loadIdHighWater());
  // ➤ Where to insert: the pending heading, asked for in one place.
  const idx = pendingIndex(text);
  const marker = idx === -1 ? PENDING_HEADING : text.slice(idx).split('\n')[0];
  const block = offers.map(o => {
    const loc = normalizeLocation(o.location);
    o.id = ++nextId;
    // ➤ 2026-07-18 (approved improvement): if the years asked (y:) or the
    // ➤ salary (s:) are known, they're saved in the line — the "list" command shows them.
    // ➤ The #number is still the last field (the "seen" command requires it).
    // ➤ y: only ever carries a NUMBER (audit 2026-07-25). multiYearScreen returns
    // ➤ the string '3+', and "y:3+" is not a shape the list parser recognises, so
    // ➤ that offer was displayed as if "3+" were its LOCATION.
    const yrs = Number.parseInt(o.years, 10);
    const extras = `${Number.isInteger(yrs) ? ` | y:${yrs}` : ''}${o.salary ? ` | s:${sanitizeField(o.salary)}` : ''}`;
    return `- [ ] ${o.url} | ${sanitizeField(o.company)} | ${sanitizeField(o.title)}${loc ? ` | ${sanitizeField(loc)}` : ''}${extras} | #${o.id}`;
  }).join('\n');
  // ➤ If the file has no "Pending" section, it creates it; if it has one,
  // ➤ it inserts the new offers inside that section.
  if (idx === -1) {
    const procIdx = text.indexOf(PROCESSED_HEADING);
    const at = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, at) + `\n${marker}\n\n${block}\n\n` + text.slice(at);
  } else {
    const after = idx + marker.length;
    const next = text.indexOf('\n## ', after);
    const at = next === -1 ? text.length : next;
    text = text.slice(0, at) + '\n' + block + '\n' + text.slice(at);
  }
  // ➤ TIDY (audit 2026-07-25): every scan used to leave one orphan blank line
  // ➤ behind, and housekeep's deletions leave more — a live file had grown to
  // ➤ 376 blank lines out of 486. Runs of blank lines collapse to one.
  text = text.replace(/\n{3,}/g, '\n\n');
  writeFileAtomic(PIPELINE_PATH, text);
  // ➤ Remember the highest number handed out, so a later cleanup that deletes
  // ➤ that line can never make the counter go backwards and reuse it.
  saveIdHighWater(nextId);
}

// ── The offer-number high-water mark ────────────────────────────────────
// ➤ data/last-id.json simply holds the biggest #id ever assigned. It exists
// ➤ because pipeline.md (where the ids live) has lines DELETED from it.
const LAST_ID_PATH = join(ROOT, 'data', 'last-id.json');
function loadIdHighWater() {
  try {
    const n = JSON.parse(readFileSync(LAST_ID_PATH, 'utf-8'))?.lastId;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }        // no file yet → the pipeline itself decides
}
function saveIdHighWater(n) {
  if (!Number.isInteger(n) || n <= 0) return;
  // ➤ Written atomically: this one small file is the ONLY thing standing
  // ➤ between us and handing the same #number to two different offers. A write
  // ➤ cut in half leaves invalid JSON, the reader falls back to the highest id
  // ➤ still in the pipeline, and housekeep has been deleting from that file —
  // ➤ so the counter would walk backwards. That is the bug this file was added
  // ➤ to fix, and it deserves the same care as the pipeline itself.
  try { writeFileAtomic(LAST_ID_PATH, JSON.stringify({ lastId: n }) + '\n'); }
  catch { /* best-effort: at worst we fall back to the old behaviour */ }
}

// ➤ Adds each new offer to the scan-history.tsv history (a table with
// ➤ date, portal, title...). This history is the memory that avoids
// ➤ repeating offers in future scans.
function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${sanitizeField(o.title)}\t${sanitizeField(o.company)}\tadded\t${sanitizeField(normalizeLocation(o.location))}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Concurrency ─────────────────────────────────────────────────────

// ➤ Small work organizer: runs a list of tasks in
// ➤ parallel but only a few at a time (the limit), so as not to overload
// ➤ either the home server or the portals.
async function parallel(tasks, limit) {
  let i = 0;
  // ➤ ERROR ISOLATION 2026-07-25 (audit): a single throwing task used to abort
  // ➤ its whole worker, so one bad link could cut a sweep short and make the
  // ➤ remaining offers look like they simply were not there.
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      try { await task(); } catch (e) { console.log(`  (task failed, continuing: ${String(e && e.message).slice(0, 100)})`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));
}

// ➤ Writes the COMPLETE list of scan decisions (--explain mode): one
// ➤ line per offer with the exact reason it was discarded (or "NEW" if
// ➤ it passed). Groups by reason so it's readable, with a summary at the top. The
// ➤ result goes to data/scan-explain.txt.
function writeExplainReport(rows, found) {
  // ➤ Order in which the reasons are shown (first the ones that reach you).
  // ➤ COMPANY and DEFERRED were missing (audit 2026-07-25): their offers were
  // ➤ written to the report but never counted in the summary at the top.
  const order = ['✅ NEW', 'TITLE', 'COMPANY', 'LOCATION', 'COUNTRY', 'DUPLICATE', 'LANGUAGE', 'YEARS/DEGREE', 'DEFERRED', 'DEAD', 'NO LINK'];
  const rank = (s) => { const k = order.indexOf(s); return k === -1 ? 99 : k; };
  const byStage = {};
  for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = [];
  out.push(`SCAN DECISION LIST — ${stamp}`);
  out.push(`Total offers found: ${found}   |   logged with reason: ${rows.length}`);
  out.push('');
  out.push('Summary by reason:');
  for (const s of order) if (byStage[s]) out.push(`  ${s}: ${byStage[s]}`);
  out.push('');
  out.push('Format → [REASON] explanation — Title | Company | Location (source)');
  out.push('─'.repeat(78));
  // ➤ Sorts by reason (and, within, by title) to read them grouped.
  const sorted = [...rows].sort((a, b) => rank(a.stage) - rank(b.stage) || a.title.localeCompare(b.title));
  for (const r of sorted) {
    out.push(`[${r.stage}] ${r.reason} — ${r.title} | ${r.company} | ${r.location || '(no location)'} (${r.source})`);
  }
  const path = join(ROOT, 'data', 'scan-explain.txt');
  writeFileSync(path, out.join('\n') + '\n', 'utf-8');
  console.log(`\n📄 Full list (one line per offer) written to: ${path}  —  ${rows.length} offers`);
}

// ── Main ────────────────────────────────────────────────────────────
// ➤ The main function: it directs the complete scan from start to finish.
// ➤ Order: read configuration → scan companies → Adzuna → LinkedIn →
// ➤ fill in locations → filter language → filter years of experience →
// ➤ remove dead links → save and notify via Telegram → summary.

async function main() {
  // ➤ Reads the options the program was launched with: --dry-run
  // ➤ (dry run: writes nothing) and --company (scan only one company).
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cf = args.indexOf('--company');
  const only = cf !== -1 ? args[cf + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found at', PORTALS_PATH);
    process.exit(1);
  }

  // ➤ Loads the configuration and prepares all the filters at once.
  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  // ➤ Title keywords come from your profile (search.positive_titles /
  // ➤ search.negative_titles) when set; otherwise from portals.yml (the marine
  // ➤ default). This lets the onboarding configure the base filter in one file.
  const titleFilter = buildTitleFilter({
    positive: searchProfile.positive_titles || (config.title_filter || {}).positive,
    negative: searchProfile.negative_titles || (config.title_filter || {}).negative,
  });
  // ➤ ── WHERE THE OFFERS COME FROM ──────────────────────────────────────
  // ➤ Until the 2026-07-25 audit these SOURCES were fixed in portals.yml, which
  // ➤ made the engine filter correctly for anybody but always over a marine
  // ➤ stream: a non-marine user got a perfect filter applied to offers that were
  // ➤ never theirs, i.e. an empty list for ever. Now the search itself can come
  // ➤ from config/profile.yml too. Everything below falls back to portals.yml,
  // ➤ so a profile that does not define these keys behaves exactly as before.
  // ➤ search.queries: the phrases to ASK the job boards for (plain words, e.g.
  // ➤   ["financial accountant", "bookkeeping"]). They feed Adzuna, LinkedIn and
  // ➤   the Workday search boxes at once.
  const profileQueries = Array.isArray(searchProfile.queries) ? searchProfile.queries.map(q => String(q).trim()).filter(Boolean) : null;
  // ➤ search.locations: { allow: [...], block: [...] } to replace the example
  // ➤   geography wholesale.
  const profileLocations = searchProfile.locations && typeof searchProfile.locations === 'object' ? searchProfile.locations : null;

  const locationFilter = buildLocationFilter(profileLocations || config.location_filter);
  const companyFilter = buildCompanyFilter(config.company_filter);
  const country = buildCountryFilter();
  // ➤ Workday searches one term at a time, so each query is used as a term.
  const workdayTerms = profileQueries || config.workday_search_terms || [];
  // ➤ Adzuna takes "any of these words" per query.
  const adzunaCfg = profileQueries
    ? { ...(config.adzuna || {}), queries: profileQueries.map(q => ({ what_or: q })) }
    : (config.adzuna || {});

  // ➤ Of all the companies in portals.yml, it keeps the active ones, the
  // ➤ ones that match --company (if used), and the ones that have a
  // ➤ recognizable portal to ask directly.
  // ➤ The tracked-company list in portals.yml is a worked EXAMPLE (marine
  // ➤ employers). A profile that sets `search.track_example_companies: false`
  // ➤ — which the onboarding does for a non-marine user — skips them entirely,
  // ➤ so no API budget is spent on boards that will never match.
  const useExampleCompanies = searchProfile.track_example_companies !== false;
  const targets = (useExampleCompanies ? companies : [])
    .filter(c => c.enabled !== false)
    .filter(c => !only || c.name.toLowerCase().includes(only))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  // ➤ Counted against the SAME set targets was built from (audit 2026-07-25):
  // ➤ with --company it compared against every enabled company, so it reported
  // ➤ "28 skipped — no direct API" when the other 28 were simply not asked for.
  const considered = companies.filter(c => c.enabled !== false && (!only || c.name.toLowerCase().includes(only)));
  const noApi = considered.length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${noApi} skipped — no direct API, need AI/websearch)`);
  if (country.off.length) console.log(`Countries OFF: ${country.off.join(', ')}`);
  if (dryRun) console.log('(dry run — nothing will be written)\n');

  // ➤ Loads the memory of already-seen offers (by link and by company+title).
  // ➜ Every title the filter rejects this run, kept in memory and written once
  // ➜ at the end — no per-offer disk I/O on the hot path.
  const titleDrops = [];
  // ➜ The same filter minus the field list, used only to tell the two kinds of
  // ➜ drop apart. Built once per scan.
  const titleFilterNoFields = buildTitleFilter({ ...(config.title_filter || {}), positive: [] });
  const seenUrls = loadSeenUrls();
  const seenRoles = loadSeenCompanyRoles();
  const date = new Date().toISOString().slice(0, 10);

  // ➤ Counters for the final summary: found, discarded by
  // ➤ title/location/country, and duplicates.
  let found = 0, fTitle = 0, fLoc = 0, fCountry = 0, fCompany = 0, dupes = 0;
  const newOffers = [];
  const errors = [];
  // ➤ Optional sources that were not used because they are not set up. Kept
  // ➤ apart from `errors` so a fresh install does not read as a broken one.
  const skipped = [];

  // ➤ --explain mode (2026-07-18): it records, offer by offer, WHY each
  // ➤ one was discarded, so it can give you the complete "one line per
  // ➤ offer" list (dumped to data/scan-explain.txt). It does NOT change the normal scan:
  // ➤ without --explain, logDrop does nothing.
  const explain = args.includes('--explain');
  const explainRows = [];
  const logDrop = (stage, reason, o, source) => {
    if (!explain) return;
    explainRows.push({
      stage, reason: reason || '',
      source: source || o.source || '?',
      company: o.company || '', title: o.title || '', location: o.location || '',
    });
  };

  // ➤ The "entry gate": every offer found passes through here and must
  // ➤ clear, in order, the title filter, the location one, the off-country
  // ➤ one and the two duplicate checks. Only then is it
  // ➤ accepted as a new offer.
  function admit(job, source) {
    if (!job.url || !isSafeUrl(job.url)) { logDrop('NO LINK', 'the offer had no usable/safe link', job, source); return; }
    // ➤ Company blocked by you (portals.yml blocklist): out, without looking further.
    if (!companyFilter(job.company)) { fCompany++; logDrop('COMPANY', `company blocked by you: ${companyFilter.explain(job.company)}`, job, source); return; }
    if (!titleFilter(job.title)) {
      fTitle++;
      const why = titleFilter.explain(job.title);
      // ➜ Recorded ALWAYS, not only under --explain: the point is that these
      // ➜ drops stop being invisible between manual investigations.
      // ➜ The bucket is decided by RE-TESTING without the field list, never by
      // ➜ reading `why`: explain() reports the FIRST reason and positives are
      // ➜ checked first, so a barman with no field word reads as "not on the
      // ➜ list" though a rule would have killed it anyway. Measured on a real
      // ➜ cycle: reading `why` put 1,234 titles in the blind-spot bucket where
      // ➜ the truth is 345. The reason has the same problem, so for that bucket
      // ➜ ask the no-fields filter, which names the rule that actually fired.
      const blind = titleFilterNoFields(job.title);
      titleDrops.push({
        title: job.title,
        why: blind ? why : titleFilterNoFields.explain(job.title),
        bucket: blind ? 'no-field' : 'rule',
      });
      logDrop('TITLE', why, job, source);
      return;
    }
    if (!locationFilter(job.location)) { fLoc++; logDrop('LOCATION', `location outside your range: ${job.location || '(empty)'}`, job, source); return; }
    // ➤ It's also discarded if the blocked country appears in the title
    // ➤ (happens in multi-location offers, e.g. "... Programme - Qatar").
    if (locationFilter.blockHit(job.title)) { fLoc++; logDrop('LOCATION', 'the title names a country outside your range', job, source); return; } // blocked country in the title
    if (!country.fn(job.location)) { fCountry++; logDrop('COUNTRY', `country turned off by you: ${job.location || ''}`, job, source); return; }
    if (seenUrls.has(normUrl(job.url))) { dupes++; logDrop('DUPLICATE', 'already seen (same link)', job, source); return; }
    const key = roleKey(job.company, job.title);
    if (seenRoles.has(key)) { dupes++; logDrop('DUPLICATE', 'already seen (same company and role)', job, source); return; }
    seenUrls.add(normUrl(job.url));
    seenRoles.add(key);
    newOffers.push({ ...job, source });
  }

  // ➤ Prepares one task per company: each queries its portal with the
  // ➤ right recipe and passes its offers through the entry gate.
  const tasks = targets.map(c => async () => {
    try {
      let jobs;
      if (c._api.type === 'workday') {
        jobs = await collectWorkday(c._api, c.name, workdayTerms);
      } else if (c._api.type === 'oracle') {
        jobs = await collectOracle(c._api, c.name);
      } else {
        const json = await fetchJson(c._api.url);
        jobs = PARSERS[c._api.type](json, c.name);
      }
      found += jobs.length;
      for (const job of jobs) admit(job, `${c._api.type}-api`);
    } catch (err) {
      errors.push({ company: c.name, error: err.message });
    }
  });

  // ➤ Runs all the company tasks, 8 at a time at most.
  await parallel(tasks, CONCURRENCY);

  // ── Adzuna aggregator (skipped when --company targets an ATS) ─────
  // ➤ Adzuna step: only if it's enabled in the configuration and skipping it
  // ➤ wasn't requested. Without access keys, the error is recorded and it continues.
  let adzunaCalls = 0, adzunaFailed = 0, adzunaRateLimited = false;
  const adzunaWanted = adzunaCfg.enabled
    && !args.includes('--no-adzuna')
    && (!only || 'adzuna'.includes(only));
  if (adzunaWanted) {
    const creds = loadAdzunaCreds();
    if (!creds) {
      // ➤ NOT an error: the Adzuna key is optional and the README says so, but
      // ➤ this used to be listed under "Errors" on every scan of a fresh
      // ➤ install — which reads as "your setup is broken" when nothing is.
      skipped.push('Adzuna (no key — see README, it is optional)');
    } else {
      const res = await collectAdzuna(creds, adzunaCfg, country.off);
      adzunaCalls = res.calls;
      adzunaFailed = res.failed;
      adzunaRateLimited = res.rateLimited;
      for (const f of res.failures) errors.push({ company: 'Adzuna', error: f });
      found += res.offers.length;
      for (const job of res.offers) admit(job, 'adzuna');
    }
  }

  // ── LinkedIn jobs-guest (optional, low volume, self-throttled) ─────
  // ➤ LinkedIn step: just as optional, and it also self-throttles
  // ➤ (hourly cadence and rests, as explained above).
  let liCalls = 0, liStatus = 'off';
  // ➤ If the profile carries its own queries, LinkedIn is asked for each of them
  // ➤ in each configured country, instead of the fixed example pairs.
  const liCfg = profileQueries
    ? {
      ...(config.linkedin || {}),
      queries: profileQueries.flatMap(q =>
        ((searchProfile.countries || []).map(c => c && c.name).filter(Boolean).slice(0, 4))
          .map(loc => ({ keywords: q, location: loc }))),
    }
    : (config.linkedin || {});
  if (liCfg.enabled && !args.includes('--no-linkedin') && (!only || 'linkedin'.includes(only))) {
    const res = await collectLinkedIn(liCfg);
    liCalls = res.calls;
    liStatus = res.status;
    found += res.offers.length;
    for (const job of res.offers) admit(job, 'linkedin');
  }

  // ── Workday multi-location enrichment ──────────────────────────────
  // ➤ "Fill in locations" step: the Workday offers that said
  // ➤ "N Locations" came in with no location. Now, just for those few,
  // ➤ the detail is requested to learn the real locations and the country
  // ➤ rules are re-applied.
  {
    const targetsByName = new Map(targets.map(t => [t.name, t]));
    const wdPending = newOffers
      .map((o, i) => ({ o, i }))
      .filter(x => x.o.source === 'workday-api' && !x.o.location);
    if (wdPending.length) {
      const drops = new Set();
      const checks = wdPending.map(({ o, i }) => async () => {
        const t = targetsByName.get(o.company);
        if (!t?._api?.meta) return;
        const { tenant, dc, site } = t._api.meta;
        const path = o.url.split(`/en-US/${site}`)[1];
        if (!path) return;
        try {
          const j = await fetchJson(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`);
          const info = j?.jobPostingInfo || {};
          const locs = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
          if (!locs.length) return; // still unknown — keep as-is
          // ➤ Generous rule: as long as ONE of the locations is allowed,
          // ➤ the offer stays (and that one is shown). It's only discarded if
          // ➤ ALL are blocked.
          const passing = locs.filter(l => locationFilter(l) && country.fn(l));
          if (passing.length === 0) { drops.add(i); o._why = `all its locations are outside your range (${locs.join(', ')})`; return; }
          o.location = passing.join('; ');
        } catch { /* keep on failure */ }
      });
      await parallel(checks, 5);
      // ➤ Removes from the list the ones that turned out to be in blocked countries.
      if (explain) for (const i of drops) logDrop('LOCATION', newOffers[i]._why || 'location outside your range', newOffers[i]);
      if (drops.size) {
        const kept = newOffers.filter((_, i) => !drops.has(i));
        fLoc += newOffers.length - kept.length;
        newOffers.length = 0;
        newOffers.push(...kept);
      }
    }
  }

  // ── Language screen ───────────────────────────────────────────────
  // ➤ TITLE language step: out with the offers whose title is in a
  // ➤ language the user doesn't speak, or that already demand a language in the title.
  let fLang = 0;
  const langCfg = config.title_language_filter || {};
  // ➤ Allowed title languages come from your profile (search.languages); the
  // ➤ portals.yml value or EN/ES/CA are only fallbacks.
  const langAllow = new Set((searchProfile.languages || langCfg.allow || ['en', 'es', 'ca']).map(s => String(s).toLowerCase()));
  const langEnabled = langCfg.enabled !== false && !args.includes('--no-langcheck');
  if (langEnabled && newOffers.length > 0) {
    const drops = new Set();
    const checks = newOffers.map((o, i) => async () => {
      if (titleDemandsForeignLanguage(o.title)) { drops.add(i); o._why = 'the title requires a language you do not speak'; return; }
      const lang = await detectTitleLang(o.title);
      if (lang && !langAllow.has(lang)) { drops.add(i); o._why = `the title is in ${lang}, a language you do not work in`; }
    });
    await parallel(checks, 5);
    if (explain) for (const i of drops) logDrop('LANGUAGE', newOffers[i]._why || 'title language not allowed', newOffers[i]);
    if (drops.size) {
      const kept = newOffers.filter((_, i) => !drops.has(i));
      fLang = newOffers.length - kept.length;
      newOffers.length = 0;
      newOffers.push(...kept);
    }
  }

  // ── Experience and degree screen ──────────────────────────────────
  // ➤ The threshold comes from the profile ("5+ years → skip", "3-5
  // ➤ borderline"), so anything above max_years is dropped and anything
  // ➤ unknown is kept.
  // ➤ Years-of-experience and degree step: the text of each accepted
  // ➤ offer is downloaded and, if it clearly asks for more years than the user can
  // ➤ offer, or requires a degree the user does not have, it's discarded. If it's unknown,
  // ➤ the offer stays. With that same text the refined language rule
  // ➤ is applied (2026-07-18): it doesn't matter which language the
  // ➤ offer is WRITTEN in; it's only discarded if the body REQUIRES a language the user does not speak.
  let fExp = 0, fDeferred = 0;
  const expCfg = config.experience_filter || {};
  if (expCfg.enabled !== false && newOffers.length > 0 && !args.includes('--no-expcheck')) {
    // ➤ Years cap comes from your profile (search.max_years); portals.yml or 4
    // ➤ are only fallbacks.
    const maxYears = Number.isFinite(searchProfile.max_years) ? searchProfile.max_years
      : (Number.isFinite(expCfg.max_years) ? expCfg.max_years : 4);
    const targetsByName = new Map(targets.map(t => [t.name, t]));
    const drops = new Set();
    const langDrops = new Set();
    const deferred = new Set();
    const checks = newOffers.map((o, i) => async () => {
      const desc = await fetchOfferDescription(o, targetsByName);
      // ➤ Experience verdict: it looks at how many years they ask for AND in what field
      // ➤ (2 years "in a similar role" of PLC discard just like 5 — the user
      // ➤ can't prove them; 2 years of mooring they can).
      const verdict = experienceScreen(`${o.title || ''}. ${desc}`, o.title, maxYears);
      if (verdict) o.years = verdict.years;         // surfaced in the scan log
      // ➤ OrcaFlex rule (2026-07-11): if the offer mentions OrcaFlex —
      // ➤ HIS star tool, which barely anyone knows — it stays in the list
      // ➤ even if it asks for more years than the cap. The language is still
      // ➤ checked. The term list lives in the profile (search.priority_terms).
      const priority = PRIORITY_KEEP.test(`${o.title || ''} ${desc}`);
      if (verdict && verdict.drop && !priority) {
        drops.add(i);
        o._why = verdict.why === 'over-threshold' ? `asks for ${verdict.years} years of experience (your cap is ${maxYears})`
          : verdict.why === 'field-mismatch' ? `asks for ${verdict.years} year(s) of experience in a field that isn't yours`
          : `asks for more experience than you have`;
        return;
      }
      // ➤ DEGREE requirement in the body (2026-07-16): if the text requires
      // ➤ a master's/degree in a field the user doesn't have (mechanical/electrical/
      // ➤ electronics...) and mentions none of the user's fields, out. OrcaFlex
      // ➤ exempts just like with the years.
      if (!priority && degreeScreen(desc, o.title)) { drops.add(i); o.degree = true; o._why = 'the body requires a degree you do not have (mechanical/electrical/civil engineering/etc.)'; return; }
      // ➤ Refined language rule (2026-07-18): it does NOT matter which language
      // ➤ the offer is written in — it's only discarded if the body REQUIRES a
      // ➤ language you don't speak (and not as "valued/a plus"). For Adzuna the
      // ➤ clean description region is used (or the API snippet);
      // ➤ never the whole page, which carries menus in the country's language.
      if (langEnabled) {
        const pure = o.source === 'adzuna' ? (o._jd || stripHtml(o.description || '')) : desc;
        if (pure && bodyLanguageBlock(pure)) { langDrops.add(i); o._why = 'the body REQUIRES (mandatory) a language you do not speak'; }
      }
      // ➤ DEFERRAL (the user gave the OK 2026-07-18, case #626/#627): if the
      // ➤ detail page could NOT be read (429 exhausted), the offer isn't shown to you
      // ➤ half-examined. It's left out WITHOUT recording it anywhere, and
      // ➤ the next scan (2 h, fresh quota) re-finds it and examines it
      // ➤ fully. OrcaFlex exception: if the snippet already names your star
      // ➤ tool, it comes in anyway — it's not risked being lost.
      if (o._bodyUnread && !priority) { deferred.add(i); o._why = 'detail page unreadable due to rate-limit — retried on the next scan'; }
    });
    await parallel(checks, 5);
    const allDrops = new Set([...drops, ...langDrops, ...deferred]);
    // ➤ --explain: records the exact reason for each body-based discard.
    if (explain) {
      for (const i of drops) logDrop('YEARS/DEGREE', newOffers[i]._why || 'body requirements you do not meet', newOffers[i]);
      for (const i of langDrops) logDrop('LANGUAGE', newOffers[i]._why || 'the body requires a language you do not speak', newOffers[i]);
      for (const i of deferred) logDrop('DEFERRED', newOffers[i]._why, newOffers[i]);
    }
    if (allDrops.size) {
      const kept = newOffers.filter((_, i) => !allDrops.has(i));
      fExp = drops.size;
      fLang += langDrops.size;
      fDeferred = deferred.size;
      newOffers.length = 0;
      newOffers.push(...kept);
    }
  }

  // ── Liveness: drop clearly-dead Adzuna links before they reach the user ─
  // ➤ Last filter: check that the Adzuna links are still alive,
  // ➤ so the user doesn't get offers already withdrawn.
  let prunedDead = 0;
  if (newOffers.length > 0 && !args.includes('--no-liveness')) {
    const candidates = newOffers.map((o, i) => ({ o, i })).filter(x => x.o.source === 'adzuna');
    const dead = new Set();
    const checks = candidates.map(({ o, i }) => async () => {
      if (await isLikelyDead(o.url)) { dead.add(i); o._why = 'the link no longer works (offer withdrawn or expired)'; }
    });
    await parallel(checks, LIVENESS_CONCURRENCY);
    if (explain) for (const i of dead) logDrop('DEAD', newOffers[i]._why || 'link down', newOffers[i]);
    if (dead.size) {
      const alive = newOffers.filter((_, i) => !dead.has(i));
      prunedDead = newOffers.length - alive.length;
      newOffers.length = 0;
      newOffers.push(...alive);
    }
  }

  // ── --explain: record the survivors and dump the complete list ──
  // ➤ Every offer that reaches here is a NEW one (it'll reach you). With everything
  // ➤ recorded, data/scan-explain.txt is written: one line per offer.
  if (explain) {
    for (const o of newOffers) logDrop('✅ NEW', 'passed all filters — it reaches you', o);
    writeExplainReport(explainRows, found);
  }

  // ── Persist + refresh the single live list ──────────────────────────
  // ➤ Saving: if it's not a dry run and there are new offers, they're recorded
  // ➤ in pipeline.md and the history. There is NO separate "new offers"
  // ➤ message: to stop duplicated messages from piling up, the ONLY Telegram
  // ➤ message is the single live list, which deletes its previous version and
  // ➤ re-posts ALL pending offers (the new ones included). alert:true makes
  // ➤ THIS repost audible — a real ping when new offers arrive.
  // ➤ EXCEPTION: if the listener launched you with "search"
  // ➤ (ARGUS_SKIP_LIST_REFRESH=1), it does NOT refresh here — the listener
  // ➤ refreshes AFTER the "Search finished" message so the list ends at the bottom.
  let telegram = 'off';
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
    if (!process.env.ARGUS_SKIP_LIST_REFRESH) {
      try {
        const { refreshList } = await import(new URL('./live-list.mjs', import.meta.url));
        const n = await refreshList({ alert: true });
        telegram = n == null ? 'not-configured' : 'sent';
      } catch (e) {
        telegram = 'error';
        console.log('Live list refresh failed:', e.message);
      }
    } else {
      telegram = 'skipped-search';
    }
  }

  // ➤ Folds this run's title drops into the standing blind-spot record. One
  // ➤ write, at the end, and never on a dry run. If it ever fails it must not
  // ➤ take the scan down with it: this is a diagnostic, not the job.
  if (!dryRun && titleDrops.length) {
    try {
      saveStore(mergeDrops(loadStore(), titleDrops, { today: date }));
    } catch (e) {
      console.log(`(blind-spot record not updated: ${e.message})`);
    }
  }

  // ➤ Saves a "snapshot" of the scan in last-scan.json (when it ran,
  // ➤ how many offers, how many failures...). It serves to monitor that the
  // ➤ server scanner is working properly.
  if (!dryRun) {
    writeFileSync(STATE_PATH, JSON.stringify({
      last_scan: new Date().toISOString(),
      companies_scanned: targets.length,
      jobs_found: found,
      new_offers: newOffers.length,
      countries_off: country.off,
      adzuna_calls: adzunaCalls,
      adzuna_failed: adzunaFailed,
      rate_limited: adzunaRateLimited,
      lang_filtered: fLang,
      exp_filtered: fExp,
      linkedin_calls: liCalls,
      linkedin_status: liStatus,
      dropped_dead: prunedDead,
      telegram,
      errors: errors.length,
    }, null, 2));
  }

  // ➤ Final summary on screen: how many offers were found, how many
  // ➤ fell at each filter and how many new ones were added.
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan (extended) — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${found}`);
  console.log(`Filtered by title:     ${fTitle}`);
  console.log(`Filtered by company:   ${fCompany} (blocklist)`);
  console.log(`Filtered by location:  ${fLoc}`);
  console.log(`Filtered by country:   ${fCountry} (toggled OFF)`);
  console.log(`Duplicates:            ${dupes}`);
  if (adzunaWanted) {
    console.log(`Adzuna API calls:      ${adzunaCalls} ok, ${adzunaFailed} failed${adzunaRateLimited ? ' (RATE LIMITED)' : ''}`);
  }
  console.log(`Filtered by language:  ${fLang} (title not in EN/ES/CA)`);
  console.log(`Filtered by exp. years:${fExp} (require > threshold)`);
  if (fDeferred) console.log(`Deferred (body unread): ${fDeferred} — retried on the next scan`);
  if (liCfg.enabled) console.log(`LinkedIn:              ${liCalls} calls (${liStatus})`);
  console.log(`Dropped (dead):        ${prunedDead}`);
  console.log(`Telegram:              ${telegram}`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (skipped.length) {
    console.log(`\nNot used (optional, nothing is wrong):`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }
  if (newOffers.length) {
    console.log('\nNew offers:');
    // ➤ Same cleaning as the pipeline line, so the log reads like the offer
    // ➤ does on Telegram ("R&amp;D" was showing up raw here).
    for (const o of newOffers) console.log(`  + ${sanitizeField(o.company)} | ${sanitizeField(o.title)} | ${sanitizeField(normalizeLocation(o.location)) || 'N/A'}${o.years != null ? ` | ${o.years}yr req` : ''}`);
  }
}

// ➤ The scan only runs when this file is launched directly (node
// ➤ server-bot/scan.mjs); importing it from the tests triggers nothing. The
// ➤ path separator is part of the check so a file called "x-scan.mjs" can't
// ➤ fire it. ⚠️ Renaming this file means changing this line too, or the
// ➤ scanner silently stops starting.
if (process.argv[1] && /(^|[\\/])scan\.mjs$/.test(process.argv[1])) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
