#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT THIS FILE IS: the main job-offer scanner. Every 2 hours (the server's scheduler
// ➤ launches it) it visits the portals (Workday, Oracle, Greenhouse, Ashby, Lever, Adzuna,
// ➤ LinkedIn), collects the new offers, discards what does not fit (title, country,
// ➤ language, years required), removes duplicates and dead ones, records the good ones in
// ➤ data/pipeline.md and data/scan-history.tsv, and sends them to Telegram grouped by
// ➤ country (notify.mjs). Configuration: portals.yml (companies and filters) and
// ➤ server-bot/countries.yml (countries on/off).
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * scan.mjs (server-bot) — Zero-token portal scanner
 *
 * Sources, all pure HTTP + JSON (zero Claude tokens):
 *   - Greenhouse / Ashby / Lever / Teamtailor / SmartRecruiters (by domain detection)
 *   - SuccessFactors  successfactors: true (or the feed URL)   in portals.yml
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

// ➤ Tools this file needs: files, the YAML configuration, and the requirements reader
// ➤ (years and degree demanded) for the body of the offers.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
// ➤ Atomic full-file overwrite (temp file + rename) so a crash mid-write can't
// ➤ truncate the pending list. Used for the pipeline.md rewrite below.
import { writeFileAtomic, withFileLock, trimLog } from './fs-atomic.mjs';
import { PENDING_HEADING, PROCESSED_HEADING, pendingIndex } from './pipeline-format.mjs';
import { titleKey } from './text.mjs';
import { norm, boundaryRegex, buildCompanyFilter, buildTitleFilter, buildLocationFilter } from './filters.mjs';
// ➤ Re-exported: the filters moved to filters.mjs, and every test that reaches
// ➤ them through scan still can.
export { norm, buildCompanyFilter, buildTitleFilter, buildLocationFilter } from './filters.mjs';
// ➤ EXPERIMENTAL: the standing vetoes the user taught by tapping after a "no". Merged into
// ➤ every filter below so a veto behaves exactly like a hand-written negative.
import { loadVetoes, titleNegativesWith, companyFilterWith, locationFilterWith } from './vetoes.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { experienceScreen, degreeScreen, stripHtml, extractAdzunaJd, searchProfile, PRIORITY_KEEP } from './requirements.mjs';

const parseYaml = yaml.load;

// ── Paths (argus root = parent of server-bot/) ─────────────────
// ➤ Every path the scanner uses — configuration, offer list, history, last-scan state —
// ➤ recorded once, so the rest of the program never repeats a path by hand.
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

// ➤ Loads the "dead offer" detector (liveness-core.mjs); if it were missing, a minimal
// ➤ plan B: dead only when the site answers 404 or 410.
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

// ➤ Cleans a text of the characters that would break the list format (vertical bars, tabs,
// ➤ line breaks). The entity decoding stands on its own because TWO things must agree on
// ➤ it: the text written to pipeline.md and the duplicate key built from a title not yet
// ➤ written (see decodeTitleEntities). REPEATED UNTIL IT SETTLES: LinkedIn sends
// ➤ "&amp;amp;", so one pass leaves "&amp;" behind; bounded at three. decodeEntities
// ➤ further down unwraps the XML a feed arrives in; this is the plain-text rule shared by
// ➤ the two keys.
function decodeFieldEntities(s) {
  let out = String(s || '');
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    out = out
      .replace(/&(?:amp|#38);/gi, '&')
      .replace(/&(?:nbsp|#160);/gi, ' ')
      .replace(/&(?:quot|#34);/gi, '"')
      .replace(/&(?:apos|#39|rsquo|lsquo);/gi, "'")
      .replace(/&(?:lt|#60);/gi, '<').replace(/&(?:gt|#62);/gi, '>')
      .replace(/&(?:ndash|#8211);/gi, '-').replace(/&(?:mdash|#8212);/gi, '—');
    if (out === before) break;
  }
  return out;
}

function sanitizeField(s) {
  return decodeFieldEntities(s)
    .replace(/[|\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ➤ A job link is trusted only if it parses as a normal http(s) URL with no whitespace,
// ➤ control characters or "|": every other field goes through sanitizeField, but the URL
// ➤ is written raw (a key that must stay clickable), so a crafted link with a newline
// ➤ could inject a whole fake line into pipeline.md or scan-history.tsv. A genuine portal
// ➤ link never looks like that.
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

// ➤ Only to stop a hostile feed writing a paragraph into pipeline.md.
export const MAX_LOCATION_CHARS = 300;

// ➤ Fixes the location: removes repeated parts ("España, España" → "España").
// ➤ Exported so a test can hold the ceiling below to what it is for.
export function normalizeLocation(loc) {
  const parts = String(loc || '').split(',').map(p => p.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); unique.push(p); }
  }
  const out = unique.join(', ');
  // ➤ NOT A DISPLAY WIDTH: this goes into pipeline.md, where housekeep re-reads the location
  // ➤ weeks later to apply the country rule — a cut here makes a country named last in the
  // ➤ string vanish.
  return out.length > MAX_LOCATION_CHARS ? out.slice(0, MAX_LOCATION_CHARS) : out;
}

// ➤ Simplifies a web address so it can be compared: the tracking "tail" that changes on
// ➤ every visit goes, or the same Adzuna offer looks new on every scan; Adzuna's
// ➤ /land/ad/<id> bounce and its /details/<id> page are THE SAME offer, so both map to
// ➤ /details/<id>.
export function normUrl(u) {
  const s = (u || '').split('?')[0].replace(/\/$/, '');
  return s.replace(/^(https?:\/\/[^/]*adzuna\.[a-z.]+)\/land\/ad\/(\d+)$/, '$1/details/$2');
}

// ── API detection ───────────────────────────────────────────────────

// ➤ Looks at each company's entry in portals.yml and figures out which portal it uses, to
// ➤ know how to ask for the offer list. None recognised → null, and the company is
// ➤ skipped.
export function detectApi(company) {
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

  // ➤ A careers site with no API, read through its sitemap. The exact sitemap is
  // ➤ named in the config rather than guessed: Boskalis splits its into one file
  // ➤ per kind of page, and following an index would be code guessing which.
  if (company.sitemap?.url && company.sitemap?.match) {
    return { type: 'sitemap', url: company.sitemap.url, meta: { match: company.sitemap.match } };
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

  // ➤ Teamtailor publishes a public JSON feed at /jobs.json, no key. Most customers put
  // ➤ their own domain in front (careers.acme.com says "Teamtailor" nowhere), so besides
  // ➤ the teamtailor.com address `teamtailor: true` declares it when the URL cannot.
  const ttMatch = url.match(/^https?:\/\/([^/?#]+\.teamtailor\.com)/);
  if (ttMatch) return { type: 'teamtailor', url: `https://${ttMatch[1]}/jobs.json` };
  if (company.teamtailor && url) {
    try { return { type: 'teamtailor', url: `${new URL(url).origin}/jobs.json` }; } catch { /* unusable URL */ }
  }

  // ➤ SuccessFactors gives nothing away in the address, so it is declared with
  // ➤ `successfactors: true`; the feed is always <site>/jobs.xml. A STRING value names
  // ➤ the feed directly, for boards that speak the same RSS dialect from another shelf.
  if (company.successfactors && url) {
    try {
      const feed = typeof company.successfactors === 'string'
        ? company.successfactors
        : `${new URL(url).origin}/jobs.xml`;
      return { type: 'successfactors', url: feed };
    } catch { /* unusable URL */ }
  }

  // ➤ SmartRecruiters: one public API for every company, keyed by the company slug —
  // ➤ the first path segment of any of their job links, or `smartrecruiters: SLUG` when
  // ➤ the careers URL is a custom domain.
  const srMatch = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/);
  const srSlug = company.smartrecruiters || (srMatch ? srMatch[1] : null);
  if (srSlug) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(srSlug)}/postings?limit=100`,
      meta: { slug: srSlug },
    };
  }

  return null;
}

// ── Parsers ─────────────────────────────────────────────────────────
// ➤ Each portal answers in its own format; these "translators" turn each response into one
// ➤ common shape: title, link, company, location — and the advert text.

// ➤ THE ADVERT TEXT COMES ACROSS TOO. Without it fetchOfferDescription has nothing to hand
// ➤ back and the years, the degree and the body-language screens run against an empty body
// ➤ — every offer from these boards would walk straight through, unread. All three send
// ➤ the text along with the list, so reading it costs no extra request. Greenhouse only
// ➤ includes it when the URL asks for it, which is done in greenhouseUrlWithContent below.
export function parseGreenhouse(json, name) {
  // ➤ Tolerant like every other parser here: a degraded feed is a quiet board,
  // ➤ not a crash dressed up as one.
  return (Array.isArray(json?.jobs) ? json.jobs : []).filter(Boolean).map(j => ({
    title: j.title || '', url: j.absolute_url || '', company: name,
    location: j.location?.name || '',
    // ➤ Greenhouse sends the advert with its markup ESCAPED ("&lt;p&gt;"), so the tag stripper
    // ➤ would see no tags: the tag names leak in as words and the sentences run together,
    // ➤ exactly where the requirement lines live.
    description: unescapeEntities(j.content || ''),
  }));
}

// ➤ Turns "&lt;p&gt;5+ years&lt;/p&gt;" back into real markup so the tag stripper can do
// ➤ its job. Only the five that matter; the rest is handled once the text is stripped.
export function unescapeEntities(text) {
  return String(text || '')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}
export function parseAshby(json, name) {
  return (Array.isArray(json?.jobs) ? json.jobs : []).filter(Boolean).map(j => ({
    title: j.title || '', url: j.jobUrl || '', company: name,
    location: j.location || '',
    description: j.descriptionHtml || j.descriptionPlain || '',
  }));
}
export function parseLever(json, name) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '', url: j.hostedUrl || '', company: name,
    location: j.categories?.location || '',
    // ➤ Lever splits the advert: `description` is the intro blurb and the requirements live in
    // ➤ `lists` ("What We Require", "Qualifications"). Reading only the intro meant "5+ years
    // ➤ required" never reached the years and degree screens.
    description: leverText(j),
  }));
}

// ➤ The whole Lever advert as one string: intro, every list, the closing section. Exported
// ➤ to be tested — the requirements are what decides whether an offer is realistic for
// ➤ you.
export function leverText(j) {
  const lists = (j?.lists || []).map(l => `${l?.text || ''}. ${l?.content || ''}`);
  return [j?.descriptionPlain || j?.description || '', ...lists, j?.additionalPlain || j?.additional || '']
    .filter(Boolean).join(' ');
}

// ➤ Greenhouse leaves the advert text out unless the URL asks for it. The flag is added
// ➤ here, not in portals.yml, so it cannot be forgotten when a board is added; re-adding
// ➤ it is a no-op.
export function greenhouseUrlWithContent(url) {
  const u = String(url || '');
  if (!u || /[?&]content=true\b/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'content=true';
}
// ➤ Workday translator. When an offer says "2 Locations" (several, without saying which),
// ➤ the location is left empty so as not to discard it by mistake; a later step finds out
// ➤ the real locations.
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
// ➤ Oracle translator. The link format is verified by hand — with the wrong one, DNV's
// ➤ site sent you to the global list (India/UK offers).
function parseOracle(json, name, meta) {
  const items = json.items?.[0]?.requisitionList || [];
  // ➤ URL format VERIFIED against DNV's live site: /requisitions/preview/{Id}. The /job/{Id}
  // ➤ route does not exist in their Oracle CX version — the SPA silently falls back to the
  // ➤ global list. HTTP 200 means nothing on an SPA.
  const base = `https://${meta.host}/hcmUI/CandidateExperience/en/sites/${meta.site}/requisitions/preview`;
  return items.map(j => ({
    title: j.Title || '',
    url: j.Id ? `${base}/${j.Id}` : '',
    company: name,
    location: j.PrimaryLocation || '',
  }));
}

// ➤ Teamtailor hangs a schema.org JobPosting off each feed item, with the town and
// ➤ country separately AND the whole advert text — so this source needs no second visit.
export function parseTeamtailor(json, name) {
  return (json?.items || []).map(j => {
    const p = j._jobposting || {};
    // ➤ A job posted in several towns keeps them all; the location filter decides.
    const places = (Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation]).filter(Boolean);
    const location = places
      .map(l => [l?.address?.addressLocality, l?.address?.addressRegion || l?.address?.addressCountry]
        .filter(Boolean).join(', '))
      .filter(Boolean).join('; ');
    return {
      title: j.title || p.title || '',
      url: j.url || '',
      company: name,
      location,
      _jd: stripHtml(p.description || j.content_html || ''),
    };
  });
}

// ➤ SmartRecruiters gives the title and the place but NOT the advert: that needs one
// ➤ more call per offer, which fetchOfferDescription makes only for the survivors.
export function parseSmartRecruiters(json, name) {
  return (json?.content || []).map(j => {
    const l = j.location || {};
    // ➤ Their "fullLocation" repeats the country ("Poland, REMOTE, Poland"): joined here, no repeats.
    const parts = [l.city, l.region, l.country && String(l.country).toUpperCase()]
      .filter(Boolean).filter((v, i, a) => a.findIndex(x => String(x).toLowerCase() === String(v).toLowerCase()) === i);
    const slug = j.company?.identifier;
    return {
      title: j.name || '',
      url: slug && j.id ? `https://jobs.smartrecruiters.com/${slug}/${j.id}` : '',
      company: name,
      location: l.remote && !l.city ? 'Remote' : parts.join(', '),
      _sr: { slug, id: j.id },
    };
  });
}

// ➤ The XML entities a job feed really contains, numeric ones included: "&#39;" is how
// ➤ most feeds write an apostrophe, and a title full of those matches nothing.
function decodeFeedEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');          // last, or "&amp;lt;" would become "<"
}

// ➤ SuccessFactors career sites (SAP's site builder, still answering to its old name of
// ➤ jobs2web) publish the WHOLE board as RSS at <site>/jobs.xml — no key, advert included.
export function parseSuccessFactors(xml, name) {
  const tag = (block, t) => {
    const m = block.match(new RegExp(`<${t}[^<>]*>([\\s\\S]*?)</${t}>`, 'i'));
    return m ? decodeFeedEntities(m[1]).trim() : '';
  };
  return [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, block]) => {
    const location = tag(block, 'g:location');
    let title = tag(block, 'title');
    // ➤ These titles repeat the location in brackets at the end ("E3D System Administrator
    // ➤ (Kuala Lumpur, MY, 50470)"). Dropped ONLY when it equals the location field —
    // ➤ plenty of real titles end in brackets that mean something ("Automation Engineer (HMI)").
    if (location) {
      const tail = title.match(/\s*\(([^)]+)\)\s*$/);
      if (tail && tail[1].trim().toLowerCase() === location.trim().toLowerCase()) title = title.slice(0, tail.index).trim();
    }
    return {
      title,
      url: tag(block, 'link'),
      company: name,
      location,
      _jd: stripHtml(tag(block, 'description')),
    };
  }).filter(o => o.title && o.url);
}

const PARSERS = {
  greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever,
  teamtailor: parseTeamtailor, smartrecruiters: parseSmartRecruiters,
};

// ── Fetch ───────────────────────────────────────────────────────────

// ➤ Pagination caps: how many offers to request per page and how many
// ➤ pages at most, so as not to request endless old offers.
const WORKDAY_PAGE = 20;          // Workday returns 20 per page
const WORKDAY_MAX_PER_TERM = 60;  // cap pages per search term (3 pages)
// ➤ The most postings one employer may contribute in a run. Well above any real board —
// ➤ Bureau Veritas publishes 1,985 real ones and Indra 663, and a cap of 500 left three
// ➤ quarters of Bureau Veritas unread — while still catching the flood it exists for (a
// ➤ feed that answered 20,000).
export const MAX_JOBS_PER_COMPANY = 3000;
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

// ➤ Like fetchJson, with retries: a transient failure (an overloaded portal) is retried up
// ➤ to 3 times after a pause. A 429 ("too many requests") is NOT retried — stop, not make
// ➤ it worse.
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

// ➤ Collects a company's offers on Workday: each configured keyword, paging through the
// ➤ results, each offer saved once even if it appears in several searches. `onPartial` is
// ➤ how a board that answered and then STOPPED gets reported: against a real tenant, when
// ➤ only the first of 42 pages came back and the other 41 answered 503, the scan printed
// ➤ 20 offers of 840 with no Errors section — a summary identical to a quiet day.
async function collectWorkday(api, name, searchTerms, onPartial = () => {}) {
  const terms = searchTerms.length ? searchTerms : [''];
  const byUrl = new Map();
  // ➤ DID THIS BOARD ANSWER AT ALL? A swallowed request error makes a board that could not
  // ➤ be reached look exactly like one with no matching jobs — with the network cut, nine
  // ➤ boards reported as scanned, five errors, seven failures invisible: an ordinary quiet
  // ➤ run.
  let answered = false, lastError = null, cutShort = false;
  for (const term of terms) {
    for (let offset = 0; offset < WORKDAY_MAX_PER_TERM; offset += WORKDAY_PAGE) {
      let json;
      try {
        json = await fetchJson(api.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: term }),
        });
        answered = true;
      } catch (err) {
        lastError = err;
        // ➤ Failing here, with pages already read, is a TRUNCATED board — not an employer with
        // ➤ nothing to offer. No retries on this path (fetchJson, not fetchJsonRetry), so one 429
        // ➤ ends the term.
        if (answered) cutShort = true;
        break; // move to next term on error
      }
      const jobs = parseWorkday(json, name, api.meta);
      for (const j of jobs) if (j.url) byUrl.set(j.url, j);
      if (offset + WORKDAY_PAGE >= (json.total || 0)) break; // no more pages
    }
  }
  // ➤ One good answer is enough: a board really can have nothing today. Not a
  // ➤ single one is a failure, and the caller records it like any other.
  if (!answered) throw lastError || new Error('no response from the board');
  if (cutShort) onPartial(lastError, byUrl.size);
  return [...byUrl.values()];
}

// ── Career sites with no API at all ─────────────────────────────────
// ➤ Some employers run their careers site entirely in the browser, so a fetch gets an
// ➤ empty shell — Van Oord and Boskalis among them. But their SITEMAP lists every vacancy,
// ➤ and each vacancy page carries a schema.org JobPosting block: the same fields an ATS
// ➤ would hand over, published for search engines.

// ➤ The title lives in the last part of the vacancy URL, minus its id
// ➤ ("…/vacancies/production-automation-system-engineer-rotterdam-2807en"). Good enough
// ➤ for the title filter, all it is used for.
export function slugTitle(url) {
  const raw = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || '';
  // ➤ decodeURIComponent THROWS on malformed percent-encoding, and this runs once per
  // ➤ sitemap URL — one bad link would take the whole board down. The raw slug still carries
  // ➤ the words the title filter needs.
  let last = raw;
  try { last = decodeURIComponent(raw); } catch { /* keep the raw slug */ }
  return last.replace(/-\d+[a-z]*$/i, '').replace(/[-_]+/g, ' ').trim();
}

// ➤ Reads the JobPosting block out of a vacancy page; null when the page has none, so a
// ➤ site that stops publishing it goes quiet rather than filling the list with blanks.
export function parseJobPostingLd(html, url, name) {
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(parsed?.['@graph'] || parsed || [])) {
      if (node?.['@type'] !== 'JobPosting') continue;
      const address = [].concat(node.jobLocation || []).map(l => l?.address).find(Boolean) || {};
      const location = [address.addressLocality, address.addressRegion, address.addressCountry]
        .map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(', ');
      const title = String(node.title || node.name || '').trim();
      if (title) return { title, url, company: name, location, _jd: stripHtml(node.description || '') };
    }
  }
  return null;
}

// ➤ How many vacancy pages one site may be asked for in a run. Two stages keep it tiny:
// ➤ the slug carries the title, so the filter runs on it first and only survivors are
// ➤ downloaded (164 listed, 5 downloaded on the two real boards). The ceiling is for the
// ➤ day a filter is widened and everything matches.
const SITEMAP_MAX_PAGES = 40;

// ➤ `titleFilter` is passed in rather than reached for: it is what makes this cheap, and a
// ➤ version that downloaded everything first would still work — the kind of regression a
// ➤ test cannot see.
async function collectSitemap(api, name, titleFilter, log = console.log) {
  const res = await fetch(api.url, { headers: { 'User-Agent': DESC_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const listed = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  const vacancies = listed.filter(u => u.includes(api.meta.match));
  const wanted = vacancies.filter(u => titleFilter(slugTitle(u)));
  const reading = wanted.slice(0, SITEMAP_MAX_PAGES);
  if (wanted.length > reading.length) {
    log(`  ! ${name}: ${wanted.length} vacancies match the title filter; reading the first ${reading.length}.`);
  }
  const jobs = [];
  await parallel(reading.map(u => async () => {
    const page = await fetch(u, { headers: { 'User-Agent': DESC_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!page.ok) return;
    const job = parseJobPostingLd(await page.text(), u, name);
    if (job) jobs.push(job);
  }), 3);
  return jobs;
}

// ➤ Collects a company's offers on Oracle: most recent first, page by page, up to the cap
// ➤ of 150. onPartial: as for Workday — a board that answered and then stopped is a
// ➤ truncated read, and the run has to say so.
async function collectOracle(api, name, onPartial = () => {}) {
  const { host, site } = api.meta;
  const byUrl = new Map();
  let answered = false, lastError = null, cutShort = false;
  for (let offset = 0; offset < ORACLE_MAX; offset += ORACLE_PAGE) {
    const url = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
      + `?onlyData=true&expand=requisitionList`
      + `&finder=findReqs;siteNumber=${site},limit=${ORACLE_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    let json;
    // ➤ Same as Workday above: a board that never answered is a failure to report, not an
    // ➤ employer with nothing on offer.
    try { json = await fetchJson(url); answered = true; }
    catch (err) { lastError = err; if (answered) cutShort = true; break; }
    const jobs = parseOracle(json, name, api.meta);
    if (jobs.length === 0) break;
    for (const j of jobs) if (j.url) byUrl.set(j.url, j);
    const total = json.items?.[0]?.TotalJobsCount || 0;
    if (offset + ORACLE_PAGE >= total) break;
  }
  if (!answered) throw lastError || new Error('no response from the board');
  if (cutShort) onPartial(lastError, byUrl.size);
  return [...byUrl.values()];
}

// ── Adzuna aggregator (Indeed + EU boards, by country + query) ──────
// ➤ Free API: https://developer.adzuna.com/ — credentials in server-bot/adzuna-key.json or
// ➤ env ADZUNA_APP_ID / ADZUNA_APP_KEY. One request per (enabled country × query).
// ➤ Failures are COUNTED and surfaced; silent ones hide real outages. Adzuna is an
// ➤ aggregator: a search engine that gathers offers from many portals (Indeed and European
// ➤ job boards).

// ➤ Adzuna's access keys (a username and password for its service): first the environment,
// ➤ then adzuna-key.json. Without keys, Adzuna is skipped.
function loadAdzunaCreds() {
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    return { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
  }
  const keyPath = join(SCRIPT_DIR, 'adzuna-key.json');
  if (existsSync(keyPath)) {
    try {
      const j = JSON.parse(readFileSync(keyPath, 'utf-8'));
      if (j.app_id && j.app_key) return { id: j.app_id, key: j.app_key };
    } catch (e) { console.warn(`[adzuna] ${keyPath} is unreadable (${e.message}); Adzuna is off this run.`); }
  }
  return null;
}

// ➤ Turns the Adzuna salary into a short, honest text ("€35-45k"): "~" in front when
// ➤ Adzuna ESTIMATED it, Switzerland in CHF, suspiciously low figures (<10k/year) omitted
// ➤ as API garbage. Exported to be tested.
export function formatSalary(min, max, predicted, countryCode) {
  let lo = Number(min) || 0, hi = Number(max) || 0;
  if (!lo && !hi) return '';
  if (Math.max(lo, hi) < 10_000) return '';
  // ➤ If the API comes with min>max, it's reordered (otherwise a nonsensical range like
  // ➤ "€80-20k" comes out).
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  const k = v => Math.round(v / 1000);
  const cur = countryCode === 'ch' ? 'CHF ' : '€';
  const range = lo && hi && k(lo) !== k(hi) ? `${k(lo)}-${k(hi)}k` : `${k(hi || lo)}k`;
  return `${predicted ? '~' : ''}${cur}${range}`;
}

// ➤ Adzuna translator to the common offer format; it also keeps the short description
// ➤ snippet (it serves the years filter without another request) and the SALARY, shown on
// ➤ Telegram. Adzuna sometimes gives its own /details/<id> page (where the offer is READ)
// ➤ and sometimes a tracking BOUNCE (/land/ad/<id>) onto the advertiser's form with
// ➤ nothing to read (in Germany, XING); here the page is ALWAYS forced, built from the
// ➤ posting id over the country's domain.
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

// ➤ Goes through every enabled country and configured search asking Adzuna for offers.
// ➤ Successes and failures are counted (failures shown, not hidden), and a "too many
// ➤ requests" stops it at once with whatever it has.
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
          // ➤ Adzuna results always carry a location in practice. If one ever comes empty, fall back
          // ➤ to the queried country AND log it loudly — the user wants the city, so an empty
          // ➤ location is an anomaly to show, not paper over.
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

// ➤ Mechanism adopted from MadsLorentzen/ai-job-search (MIT): the endpoints LinkedIn
// ➤ serves to logged-OUT visitors — no account, no cookies. LinkedIn's ToS disallow
// ➤ automated access, so volume is kept MINIMAL by design: a few queries, one page each,
// ➤ at most once every `every_hours`, and a 24 h self-cooldown on a 429. Off entirely with
// ➤ portals.yml → linkedin.enabled: false.

const LI_STATE_PATH = join(SCRIPT_DIR, 'linkedin-state.json');

// ➤ The LinkedIn page arrives as HTML, not ordered data: this digs through it for the
// ➤ title, company and location of each offer card.
export function parseLinkedInCards(html) {
  // ➤ Splits the page using the marker LinkedIn puts at the start of
  // ➤ each offer; each resulting chunk is an offer.
  const cards = String(html || '').split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
  const out = [];
  for (const c of cards) {
    // ➤ The number at the start of the chunk is the offer's identifier.
    const id = c.match(/^(\d+)/)?.[1];
    if (!id) continue;
    // ➤ These three lines extract title, company and location from the tags LinkedIn uses on
    // ➤ the page. THE "REST OF THE TAG" PART IS BOUNDED: "anything that is not a >" runs
    // ➤ across the rest of the document looking for a closing bracket a hostile page never
    // ➤ provides, then backtracks over all of it, once per card — 43 seconds for 500 KB on a
    // ➤ page built to provoke it. Forbidding "<" too keeps the search inside the tag, so a bad
    // ➤ page costs a missed field instead of the run.
    const title = c.match(/base-search-card__title[^<>]*>\s*([^<]+)/)?.[1]?.trim() || '';
    const company = c.match(/base-search-card__subtitle[^<>]*>\s*<a[^<>]*>\s*([^<]+)/)?.[1]?.trim()
      || c.match(/base-search-card__subtitle[^<>]*>\s*([^<]+)/)?.[1]?.trim() || 'LinkedIn';
    const location = c.match(/job-search-card__location[^<>]*>\s*([^<]+)/)?.[1]?.trim() || '';
    out.push({ id, title, company, location, url: `https://www.linkedin.com/jobs/view/${id}` });
  }
  return out;
}

// ➤ How long LinkedIn is left alone after it answers 429. Named, because it is
// ➤ now used twice: once to set the pause and once to sanity-check it.
const LINKEDIN_COOLDOWN_MS = 24 * 3600_000;

// ➤ Queries LinkedIn respecting its limits: first whether it is time to rest (the 24 h
// ➤ penalty, or the hours between queries not yet passed) — then nothing; when it does
// ➤ query, it saves the time in a little state file for next time.
async function collectLinkedIn(cfg) {
  const state = existsSync(LI_STATE_PATH)
    ? (() => { try { return JSON.parse(readFileSync(LI_STATE_PATH, 'utf-8')); } catch { return {}; } })()
    : {};
  const now = Date.now();
  // ➤ Are we in a penalty period after a "429"? Wait. A COOLDOWN CANNOT BE LONGER THAN A
  // ➤ COOLDOWN: the rest is stored as an absolute moment, and one excursion of the machine's
  // ➤ clock (a dead battery, a bad time sync) could write a date months away and leave
  // ➤ LinkedIn off until then in silence. Anything further ahead than the cooldown length is
  // ➤ a wrong clock: ignored, and said out loud.
  if (state.cooldown_until && state.cooldown_until - now > LINKEDIN_COOLDOWN_MS) {
    console.log('  ! LinkedIn cooldown is dated far in the future (a clock problem?) — ignoring it.');
    state.cooldown_until = 0;
  }
  if (state.cooldown_until && now < state.cooldown_until) {
    return { offers: [], calls: 0, status: `cooldown until ${new Date(state.cooldown_until).toISOString().slice(0, 16)}` };
  }
  const everyMs = (cfg.every_hours || 6) * 3600_000;
  // ➤ Have the minimum hours since the last query not passed yet? Skip. Same clock guard as
  // ➤ the cooldown below: last_run is written on every run, so it is the likelier of the two
  // ➤ to catch a clock that jumped, and a run "in the future" would hold LinkedIn off until
  // ➤ the date passes.
  if (state.last_run && state.last_run - now > everyMs) state.last_run = 0;
  if (state.last_run && now - state.last_run < everyMs) {
    return { offers: [], calls: 0, status: 'cadence-skip' };
  }

  const maxAgeSec = (cfg.max_age_days || 7) * 86400;
  const byUrl = new Map();
  let calls = 0;
  let rateLimited = false;
  let refused = 0, lastRefused = 0;

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
      if (!res.ok) { refused++; lastRefused = res.status; continue; }
      for (const o of parseLinkedInCards(await res.text())) byUrl.set(o.url, o);
      await new Promise(r => setTimeout(r, 1500)); // gentle pacing between queries
    } catch { /* skip query on network error */ }
  }

  // ➤ Records when it was queried and, if LinkedIn complained, schedules
  // ➤ the 24-hour rest for the next scan.
  const newState = { last_run: now };
  if (rateLimited) newState.cooldown_until = now + LINKEDIN_COOLDOWN_MS;
  // ➤ --dry-run must touch NO file — a dry run must not move the LinkedIn cursor forward.
  if (!process.argv.includes('--dry-run')) writeFileSync(LI_STATE_PATH, JSON.stringify(newState), 'utf-8');

  return {
    offers: [...byUrl.values()], calls,
    // ➤ "ran" covers only real answers: a LinkedIn that answers 403 to every call — a
    // ➤ permanent block — must not read like a healthy run with no matches. Refusals and total
    // ➤ silence say so.
    status: rateLimited ? 'RATE-LIMITED (24h cooldown set)'
      : calls > 0 && refused === calls ? `BLOCKED (HTTP ${lastRefused} on every call)`
      : calls === 0 && (cfg.queries || []).length ? 'unreachable (every query failed on the network)'
      : 'ran',
  };
}

// ── Liveness (HTTP only, conservative) ──────────────────────────────
// ➤ Only Adzuna offers are checked: aggregator listings go stale, while
// ➤ Workday/Oracle/Greenhouse offers came straight from the company ATS seconds ago. Dead
// ➤ = HTTP 404/410 or an explicit "expired" text pattern; never dead on thin content
// ➤ (JS-heavy SPAs) or network errors — when in doubt the offer is live, so a transient
// ➤ website failure cannot lose a good one.

// ➤ Does the page have a live APPLY button/link ("Apply now", "Solliciteer", "Jetzt
// ➤ bewerben", "Postuler"…)? A strong signal the offer is still active. Exported so
// ➤ housekeep uses the same one.
export function hasApplySignal(text) {
  return /apply (?:now|today|here|for this (?:job|position|role))|submit (?:your )?application|start (?:your )?application|solliciteer|postule[rz]\b|jetzt bewerben|bewirb dich|ap[úu]ntate|inscr[íi]bete|env[íi]a tu (?:cv|candidatura)|aplicar? ahora/i.test(String(text || ''));
}

// ➤ Anti-false-dead second opinion: the classifier marks "expired" if ANY chunk of the
// ➤ page carries a phrase like "position has been filled" — even from a widget of OTHER
// ➤ offers, even with a live apply button on the page. Losing a good offer is the
// ➤ expensive mistake, so an "expired" that comes from a PHRASE (not a 404/410 or a
// ➤ redirect, which are hard proof) with an apply signal still on the page → LIVE.
export function overrideDeadIfApply(verdict, body) {
  // ➤ The second opinion only applies to the GENERIC patterns ("applications closed",
  // ➤ "closed on <date>" — the ones that can come from a FAQ or a holiday notice). The
  // ➤ emphatic ones ("position has been filled", "no longer available/accepting", "job has
  // ➤ expired") are almost always THIS offer's banner: an "Apply Now" from a widget of
  // ➤ similar offers must not revive them.
  const reason = String(verdict?.reason || '');
  const generic = /^pattern matched/.test(reason) && /applications?|closed on/i.test(reason) && !/no longer|filled|expired/i.test(reason);
  if (verdict?.result === 'expired' && generic && hasApplySignal(body)) {
    return { result: 'active', reason: 'apply signal present despite expired-text pattern (server-bot override)' };
  }
  return verdict;
}

// ➤ The verdict on evidence already in hand, split out so the liveness step can judge from
// ➤ the page the experience screen ALREADY downloaded instead of fetching the same URL a
// ➤ second time.
function deadFromEvidence(status, finalUrl, body) {
  // ➤ Classifier verdict + anti-false-dead second opinion.
  const { result, reason } = overrideDeadIfApply(
    classifyLiveness({ status, finalUrl, bodyText: body }), body);
  // ➤ Only considered dead if the verdict is "expired" AND it wasn't due to
  // ➤ lack of content (pages that load bit by bit are deceptive).
  return result === 'expired' && !reason.includes('insufficient content');
}

async function isLikelyDead(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    let body = '';
    try { body = (await res.text()).slice(0, 20_000); } catch { /* body unreadable: the status and final URL still speak */ }
    clearTimeout(timer);
    return deadFromEvidence(res.status, res.url, body);
  } catch {
    return false;
  }
}

// ── Job-description fetch (for the years-of-experience screen) ──────
// ➤ Only ADMITTED offers reach here (past the title/location/language filters): a handful
// ➤ of requests per scan. Each portal keeps the body in a different place, so one recipe
// ➤ per portal; on any failure it returns '' and the offer is KEPT
// ➤ (extractRequiredYears('') → null → not dropped) — better one too many than a good one
// ➤ lost to a technical failure.

const DESC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ➤ "Polite fetch": Adzuna/LinkedIn pages one every ~1.5 s, and on a "429 too many
// ➤ requests" it waits and retries instead of treating the offer as good unread — the same
// ➤ mechanism housekeep uses. Rule: NEVER draw conclusions from a 429.
const SCAN_HOST_GAP_MS = { adzuna: 1500, linkedin: 1200 };
// ➤ Slot allocator per host, not a last-request timestamp: a read-sleep-write lets the
// ➤ five callers of parallel(checks, 5) compute the same wait, wake together and fire in a
// ➤ burst of 5 — earning the 429s that defer offers. Claiming the slot synchronously hands
// ➤ each caller its own moment, one gap apart.
const scanHostNext = new Map();   // per host: when the NEXT request may fire
const scanHostFloor = new Map();  // per host: floor imposed by a 429 penalty
async function scanPoliteFetch(hostKey, url, opts = {}) {
  const gap = SCAN_HOST_GAP_MS[hostKey] || 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    let slot;
    for (;;) {
      slot = Math.max(Date.now(), scanHostNext.get(hostKey) || 0, scanHostFloor.get(hostKey) || 0);
      scanHostNext.set(hostKey, slot + gap);   // claimed before any await
      const wait = slot - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      // ➤ A 429 penalty can land while asleep; if it did, claim a fresh slot.
      if ((scanHostFloor.get(hostKey) || 0) <= slot) break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': DESC_UA, ...(opts.headers || {}) } });
      if (res.status === 429) {
        // ➤ 15 s penalty after a 429: shorter, and the 3 attempts die within the same rate-limit window.
        scanHostFloor.set(hostKey, Date.now() + 15_000); // back off the whole host
        continue;
      }
      return res;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null; // still rate-limited → inconclusive
}

async function fetchOfferDescription(o, targetsByName) {
  try {
    // ➤ A body some earlier step already extracted wins outright: the sitemap parser stores
    // ➤ the whole JD in _jd and the Workday enrichment stashes it too, while o.description is
    // ➤ EMPTY for sitemap offers — falling through to it would skip the years/degree/language
    // ➤ screens for those boards.
    if (o._jd) return o._jd;
    // ➤ SmartRecruiters keeps the advert on a second endpoint, one per offer.
    if (o.source === 'smartrecruiters-api') {
      if (!o._sr?.slug || !o._sr?.id) return '';
      const j = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(o._sr.slug)}/postings/${encodeURIComponent(o._sr.id)}`);
      const s = j?.jobAd?.sections || {};
      return stripHtml([s.companyDescription?.text, s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text]
        .filter(Boolean).join(' '));
    }
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
      // ➤ LinkedIn throttles or blocks unauthenticated reads probabilistically (often a 403/999)
      // ➤ and one failure is usually transient, so try TWICE — a second PUBLIC attempt, no
      // ➤ login. scanPoliteFetch already paces calls and retries 429s; this adds a retry for the
      // ➤ block/empty cases.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await scanPoliteFetch('linkedin', liUrl);
        if (res && res.ok) {
          const text = await res.text().catch(() => '');
          if (text.trim()) return stripHtml(text);
        }
      }
      return '';
    }
    // ➤ Adzuna recipe: the ~200-char snippet almost never carries the years requirement, so
    // ➤ the full details page (o.url) is downloaded and joined with the snippet — verified
    // ➤ live, it recovers the "10 años"/"5 years" the snippet omitted.
    if (o.source === 'adzuna') {
      let body = '';
      try {
        const res = await scanPoliteFetch('adzuna', o.url, { redirect: 'follow' });
        if (res && res.ok) {
          const html = await res.text();
          // ➤ If the clean description region is found, that one is used (no menus or related ads)
          // ➤ and saved in the offer so the body's LANGUAGE can be checked on Adzuna too.
          const jd = extractAdzunaJd(html);
          if (jd) o._jd = jd;
          body = jd || stripHtml(html);
          // ➤ Status + page stashed for the liveness step, so it does not re-download this same URL
          // ➤ minutes later — a second full pass over the host whose 429s defer offers, and without
          // ➤ the 1.5 s pacing.
          o._live = { status: res.status, finalUrl: res.url, body: html.slice(0, 20_000) };
        } else if (res === null) {
          // ➤ 429 exhausted or network down: the body could NOT be read. It's flagged to DEFER the
          // ➤ offer, so it does not reach the list half-examined.
          o._bodyUnread = true;
        } else {
          // ➤ A definitive non-OK answer (404 and friends) IS liveness evidence.
          o._live = { status: res.status, finalUrl: res.url, body: '' };
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
// ➤ The user's rule: a MANDATORY language they do not speak is a hard blocker. The title's
// ➤ language is a strong proxy for the working language — a German-titled posting is a
// ➤ German-speaking job — so EN/ES/CA titles pass and the rest are dropped. Detection
// ➤ rides the same free translate endpoint (it returns the source language); on any
// ➤ failure → null → the offer is KEPT, never lost to an outage.

// ➤ Titles that state the working language outright: "(German or French speaking)",
// ➤ "Dutch-speaking Support Engineer". It looks for a language name closely followed by
// ➤ "speaking" or similar — no API call, fully deterministic. EN/ES/CA are the languages
// ➤ of the profile; any other named language in the title is a requirement that can't be
// ➤ met.
const TITLE_LANG_DEMAND = /\b(german|deutsch|french|dutch|nederlands|flemish|italian|norwegian|danish|swedish|polish|portuguese)\b[^)]{0,25}?(speak(?:ing|er)?|sprechend|sprachig|parlant)/i;

// ➤ ENGLISH AS AN ALTERNATIVE IS NOT A DEMAND: "German or English speaking" and
// ➤ "Dutch/English speaking" both accept English, so the owner qualifies — only "and"
// ➤ chains the two into a real requirement. In doubt, keep: a false drop loses the offer
// ➤ in silence, a false keep costs one tap.
const OTHER_LANG = '(?:german|deutsch|french|dutch|nederlands|flemish|italian|norwegian|danish|swedish|polish|portuguese)';
const ALT_JOIN = String.raw`\s*(?:/|,?\s+(?:or|oder|of|ou|o)\s+)\s*`;
const ENGLISH_ALTERNATIVE = new RegExp(
  String.raw`\b${OTHER_LANG}\b${ALT_JOIN}english\b|\benglish\b${ALT_JOIN}${OTHER_LANG}\b`, 'i');

export function titleDemandsForeignLanguage(title) {
  const t = String(title || '');
  return TITLE_LANG_DEMAND.test(t) && !ENGLISH_ALTERNATIVE.test(t);
}

// ➤ Broken-encoding detector: a board can deliver "Automation Engineer ??????" — the
// ➤ non-Latin half destroyed upstream and replaced by literal question marks — geotagged
// ➤ France, actually a Shanghai job. A run of ??? (or any U+FFFD) can only be a portal
// ➤ mangling text it could not encode, and the mangled half is the half naming the real
// ➤ language or place; no legitimate title carries either.
export function titleEncodingBroken(title) {
  return /\?{3,}|�/.test(String(title || ''));
}

// ➤ BODY LANGUAGE RULE: the language the offer IS WRITTEN in does not matter (a Dutch
// ➤ offer that does not ask you to speak Dutch can be good); what discards it is the body
// ➤ REQUIRING a language the user does not speak — "fluent in German", "Deutschkenntnisse
// ➤ erforderlich", "talen: Nederlands" — unless nearby it says "is a plus" or "valued".
// ➤ The list of blocked languages, with its variants, comes from config/profile.yml
// ➤ (search.languages_blocked); the marine default below is the fallback.
const LANGWORD = '(?:' + (Array.isArray(searchProfile.languages_blocked) && searchProfile.languages_blocked.length
  ? searchProfile.languages_blocked.join('|')
  : 'german|deutsch\\w*|alem[áa]n|french|fran[çc]ais\\w*|franc[ée]s|dutch|nederlands|neerland[ée]s|flemish|vlaams') + ')';
// ➤ Words that indicate a requirement: "fluent", "required", "imprescindible", "se
// ➤ requiere", "erforderlich", C1/C2 levels, "native"... The German and French ways of
// ➤ saying it are here too — "Deutsch und Englisch fließend in Wort und Schrift", "Sehr
// ➤ gute Deutsch- und Englischkenntnisse", "Verhandlungssichere Deutschkenntnisse". Note
// ➤ the "gut…" stem is only ever read NEXT TO a language word, so "gute Excel-Kenntnisse"
// ➤ alone cannot fire it.
const REQWORD = '(?:fluent|fluency|proficien\\w+|mandatory|compulsory|require[sd]?|obligatorio|obligatoria|imprescindible|requier\\w*|requerid\\w*|necesari[oa]s?|erforderlich|vorausgesetzt|vereist|requis|exig[ée]\\w*|c1|c2|native|muttersprach\\w*|moedertaal'
  + '|flie[sß]end\\w*|verhandlungssicher\\w*|sehr gut\\w*|gute?n? kenntnisse|kenntnisse|beherrsch\\w*|sicher\\w* umgang'
  + '|vlot\\w*|beheers\\w*|goede kennis|uitstekend\\w*|spreekt|schrift'
  + '|courant\\w*|ma[îi]tris\\w*|bilingue|tr[èe]s bon\\w* niveau|niveau (?:c1|c2|courant))';
// ➤ Combines the two lists: the requirement word and the language must appear in the same
// ➤ sentence (no periods or semicolons crossed), or in a list like "Languages: Dutch".
const BODY_LANG_REQ = new RegExp(
  `${REQWORD}[^.!?;]{0,40}\\b${LANGWORD}|\\b${LANGWORD}[^.!?;]{0,30}${REQWORD}|(?:talen|sprachen|langues|idiomas|languages)\\s*:\\s*[^.!?;]{0,30}\\b${LANGWORD}`,
  'i',
);
// ➤ "Softener" phrases nearby make the language only desirable ("a plus", "von Vorteil",
// ➤ "valued"...) and the offer is NOT blocked — the owner's rule. Deliberately WIDE in the
// ➤ three languages that block (DE "ein Plus"/"erwünscht", FR "un plus", NL "strekt tot
// ➤ aanbeveling"/"is meegenomen"/"wenselijk"): being generous here can only let an offer
// ➤ THROUGH.
const LANG_SOFTENER = /nice to have|a plus|is a plus|ein plus|un plus|erw[üu]nscht|von vorteil|wünschenswert|valorable|se valorar[áa]|pluspunt|is een plus|strekt tot aanbeveling|aanbeveling|meegenomen|wenselijk|atout|desirable|preferred|not required|not mandatory|no es necesario|een pr[ée]|advantag\w*|an asset|beneficial|bonus|welcome|appreciated|only for senior|solo para (?:perfiles |puestos )?senior|nur f[üu]r senior/i;

// ➤ NEGATED REQUIREMENT (owner's rule: "if it requires it, drop it; if it doesn't mention
// ➤ it or says it's NOT required, keep it"): phrases like "No German required", "Kein
// ➤ Deutsch erforderlich", "geen Nederlands vereist", "not compulsory", "no se requiere
// ➤ alemán"... are GOOD news, not a requirement. If the phrase contains a negation
// ➤ attached to the requirement word, it's NOT blocked.
const LANG_NEGATION = /\b(?:no|not|non|pas|kein\w*|geen|niet|nicht|don'?t|do not|doesn'?t|sin|zonder)\b[^.!?;]{0,40}\b(?:requires?|required|requirements?|mandatory|compulsory|necessary|needed|essential|a must|requier\w*|requerid\w*|requisito\w*|necesari[oa]s?|imprescindible|obligatori[oa]s?|requis\w*|exigence\w*|exig[ée]\w*|n[ée]cessaire|erforderlich|voraussetzung\w*|vorausgesetzt|n[öo]tig|vereiste?\w*|nodig|verplicht)\b|no (?:se requiere|hace falta)|not a requirement|geen vereiste|kein muss/i;

// ➤ KNOWN LIMIT, left alone on purpose. Some portals write requirements as "* bullet *
// ➤ bullet" with no full stop, so the whole block is ONE sentence (1,639 characters in a
// ➤ real case) and a "wünschenswert" two bullets away softens a genuine demand — about
// ➤ 5-10% of bodies. Splitting on the bullet marker was tried for </p> and <br> and
// ➤ REVERTED: it cuts the "Nice to have:" HEADING away from the list it protects. A real
// ➤ fix must tell a softener that INTRODUCES a list from one inside a sibling bullet,
// ➤ measured verdict by verdict, because the cost of error is a good offer dropped in
// ➤ silence.
export function bodyLanguageBlock(text) {
  const t = String(text || '');
  BODY_LANG_REQ.lastIndex = 0;
  const m = BODY_LANG_REQ.exec(t);
  if (!m) return false;
  // ➤ The mitigator ("a plus"/"advantage") only counts in the SAME sentence as the
  // ➤ requirement: with a crude ±60-char window, "German required. English is a plus" is
  // ➤ softened by the OTHER language's "plus" and mandatory German slips in.
  let s = m.index, e = m.index + m[0].length;
  while (s > 0 && !/[.!?;]/.test(t[s - 1])) s--;
  while (e < t.length && !/[.!?;]/.test(t[e])) e++;
  const clause = t.slice(s, e);
  if (LANG_SOFTENER.test(clause) || LANG_NEGATION.test(clause)) return false;
  // ➤ The negation can come AFTER the sentence break. Case 1 — question-answer format: "Is
  // ➤ Dutch required? No, English suffices." The answer starting with "No" cancels the
  // ➤ requirement.
  if (t[e] === '?' && /^\s*(?:no\b|not\b|nee\b|nein\b|non\b|niet\b|nicht\b|para nada|not at all)/i.test(t.slice(e + 1, e + 30))) return false;
  // ➤ Case 2 — clarification in the NEXT sentence that negates THIS requirement:
  // ➤ "French required only for senior positions; this junior role does not
  // ➤ require it." It only counts if the next sentence negates AND talks about this
  // ➤ role ("it", "this role") or the SAME language — so "German required.
  // ➤ English not necessary" (negation of ANOTHER language) still blocks.
  let e2 = e + 1;
  while (e2 < t.length && !/[.!?;]/.test(t[e2])) e2++;
  const next = t.slice(e + 1, e2);
  // ➤ The comparison of the SAME language in the next sentence must ignore case ("German
  // ➤ required. German is not necessary here." — with normal capitalization).
  const langIn = (m[0].match(new RegExp(LANGWORD, 'i')) || [])[0];
  if (LANG_NEGATION.test(next) &&
      (/\bit\b|this (?:junior )?(?:role|position|job)|este puesto|esta posici[óo]n/i.test(next) ||
       (langIn && next.toLowerCase().includes(langIn.toLowerCase())))) return false;
  return true;
}

// ➤ The language of a short text, asked of Google's free translator (which also reports
// ➤ the source language). If the query fails: "don't know", and nothing is discarded.
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


// ── Country toggle (countries.yml — dynamic on/off) ─────────────────

// ➤ Reads countries.yml (the countries the user turns on or off by editing that file by
// ➤ hand) and builds the filter: if an offer mentions a country that's off (or one of its
// ➤ aliases, like "Deutschland" for Germany), it's discarded. EXPORTED so a test can reach
// ➤ it: an accent bug in this very function lived on for as long as it did precisely
// ➤ because nothing could call it.
export function buildCountryFilter(cfg = null) {
  if (!cfg && !existsSync(COUNTRIES_PATH)) return { fn: () => true, off: [] };
  cfg = cfg || parseYaml(readFileSync(COUNTRIES_PATH, 'utf-8')) || {};
  const countries = cfg.countries || {};
  const aliases = cfg.aliases || {};
  // ➤ Keeps only the countries marked off. A hand-typed toggle counts however YAML reads it:
  // ➤ js-yaml follows YAML 1.2, where `no` and `off` are STRINGS, so `Germany: no` would
  // ➤ switch nothing off and say nothing. The written forms of "off" are honoured; anything
  // ➤ else leaves it on.
  const isOff = v => v === false || /^(?:no|off|false)$/i.test(String(v).trim());
  const off = Object.entries(countries).filter(([, on]) => isOff(on)).map(([c]) => c);

  // ➤ WHOLE-WORD matching, not a raw substring test: switching Denmark off must not kill
  // ➤ "Brandenburg" (its alias "Brande"), nor Italy off "Romainville" ("Roma").
  const matchers = new Map(off.map(country => [
    country,
    [country, ...(aliases[country] || [])].map(k => boundaryRegex(k, false)),
  ]));

  return {
    off,
    fn: (loc) => {
      if (!loc) return true;
      for (const country of off) {
        // ➤ FOLD THE TEXT TOO. boundaryRegex folds the TERM ("Zürich" → "zurich"), so tested
        // ➤ against the raw location it could never match the accented spelling and every accented
        // ➤ alias in countries.yml would be dead — "Zurich" dropped while "Zürich" walks through.
        // ➤ Measured on real scan history with one country off: 110 of its 141 locations leaked
        // ➤ through the unfolded rule.
        if ((matchers.get(country) || []).some(re => re.test(norm(loc)))) return false;
      }
      return true;
    },
  };
}

// ── Dedup ───────────────────────────────────────────────────────────
// ➤ Anti-duplicate system: every web address already known is loaded into memory (history,
// ➤ pending list, applications record) so an already-seen offer is never shown again.

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

// ➤ Second anti-duplicate barrier: the same role comes back with ANOTHER link (aggregators
// ➤ re-post it), so it is compared by company+title, normalising odd dashes and spaces (GE
// ➤ Vernova posted "Power Systems - …" and "Power Systems – …"). Exported to be tested:
// ➤ this key is what makes your "no" stick under a new link.
// ➤ Names that are NOT an employer: Adzuna hides the advertiser on plenty of ads, and a
// ➤ parser writing its own name into the field would make every anonymous "Offshore
// ➤ Engineer" in the country share one key. No key means no role barrier; the link barrier
// ➤ still catches a genuine duplicate. Exported because housekeep's weekly dedup keys on
// ➤ company+title too. LinkedIn is here for the same reason — parseLinkedInCards writes it
// ➤ when the ad names nobody.
export const NOT_AN_EMPLOYER = new Set(['', 'adzuna', 'linkedin']);

export function roleKey(company, title) {
  // ➤ German portals re-post the SAME role with gender tags ("(m/w/d)", "(All Genders)", "(x
  // ➤ w m)") and schedules ("80-100%") that vary between postings; they go before comparing,
  // ➤ so the re-post does not dodge your decision. ENTITIES FIRST: this key is built from
  // ➤ the title as the BOARD sent it, while pipeline.md holds it after sanitizeField decoded
  // ➤ it, and "Automation &amp; Controls Engineer" would otherwise yield two keys (nine of
  // ➤ 1,016 real titles carry an entity). The normalisation lives in text.mjs (titleKey),
  // ➤ shared with housekeep's fuzzyKey.
  const norm = s => titleKey(decodeFieldEntities(String(s)));
  const who = norm(company);
  if (NOT_AN_EMPLOYER.has(who)) return '';
  return `${who}::${norm(title)}`;
}

// ➤ Loads the company+title pairs that must BLOCK repeats. Rule: only the ones YOU decided block:
// ➤   · the ones still VISIBLE in your list (you already have them in front of you),
// ➤   · the ones YOU removed (seen/no — they carry the "| visto" marker at the end),
// ➤   · the ones in your applications record (applications.md),
// ➤   · the ones you rejected with a reason (feedback.jsonl).
// ➤ The ones THE BOT hid (dead link, old cleanups) do not block: if the company re-posts
// ➤ that offer with a new link, it comes back to your list.
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
      const k = (company && role && company.toLowerCase() !== 'company') ? roleKey(company, role) : '';
      if (k) seen.add(k);
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
        const k = (r?.company && r?.title) ? roleKey(r.company, r.title) : '';
        if (k) seen.add(k);
      } catch { /* corrupt line: ignored */ }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────
// ➤ These functions record the new offers in the pending list (pipeline.md) and the history.

// ➤ WHO GETS IN, and the reason when they do not. Written once, here, and
// ➤ exported: this same rule is re-applied weeks later by housekeep, and two
// ➤ copies of "who gets in" drifting apart is how an offer ends up admitted
// ➤ and deleted in the same week.
// ➤ Returns { ok: true } or { ok: false, stage, reason }.
export function admissionVerdict(job, gates) {
  const { companyFilter, titleFilter, locationFilter, country, seenUrls, seenRoles } = gates;

  if (!job.url || !isSafeUrl(job.url)) return { ok: false, stage: 'NO LINK', reason: 'the offer had no usable/safe link' };
  if (!companyFilter(job.company)) return { ok: false, stage: 'COMPANY', reason: `company blocked by you: ${companyFilter.explain(job.company)}` };

  // ➤ The location rides along so a field word that is really the region
  // ➤ ("Seine-Maritime") does not admit the offer on its own.
  if (!titleFilter(job.title, job.location)) {
    return { ok: false, stage: 'TITLE', reason: titleFilter.explain(job.title, job.location) };
  }

  // ➤ GEOGRAPHY IS NOT A MATTER OF OPINION. Whatever a title suggests, a job
  // ➤ in a country you ruled out is not one you can take.
  if (!locationFilter(job.location)) return { ok: false, stage: 'LOCATION', reason: `location outside your range: ${job.location || '(empty)'}` };
  // ➤ Also out if the blocked country is named in the TITLE, which is where
  // ➤ multi-location postings hide it ("... Programme - Qatar").
  if (locationFilter.blockHit(job.title)) return { ok: false, stage: 'LOCATION', reason: 'the title names a country outside your range' };
  // ➤ Judged SEAT BY SEAT, like the location gate one line up and the Workday enrichment:
  // ➤ fed the joined string, the toggle would kill "Rotterdam, NL; Esbjerg, DK" whole with
  // ➤ Denmark off, though the Dutch seat passes on its own — one seat you can take is
  // ➤ enough.
  const seats = String(job.location || '').split(';').map(x => x.trim()).filter(Boolean);
  const countryOk = seats.length > 1
    ? seats.some(s => locationFilter(s) && country.fn(s))
    : country.fn(job.location);
  if (!countryOk) return { ok: false, stage: 'COUNTRY', reason: `country turned off by you: ${job.location || ''}` };

  if (seenUrls?.has(normUrl(job.url))) return { ok: false, stage: 'DUPLICATE', reason: 'already seen (same link)' };
  // ➤ An empty key means the advertiser is not named, so there is nothing to
  // ➤ compare: the link barrier above is the only one that applies.
  const role = roleKey(job.company, job.title);
  if (role && seenRoles?.has(role)) return { ok: false, stage: 'DUPLICATE', reason: 'already seen (same company and role)' };

  return { ok: true };
}

// ➤ A CEILING ON WHAT ONE EMPLOYER CAN ADD IN ONE RUN: a feed answering 20,000 postings
// ➤ put all 20,000 into the pending list — a 2.2 MB file and about 450 Telegram messages
// ➤ over nine minutes. The cap sits far above any real board, fires only on a broken or
// ➤ hostile feed, and SAYS SO rather than truncating in silence. Exported so a test can
// ➤ reach it.
export function capJobs(jobs, name, max = MAX_JOBS_PER_COMPANY, log = console.log) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length <= max) return list;
  log(`  ! ${name} returned ${list.length} postings; reading the first ${max}. The rest are NOT looked at this run.`);
  return list.slice(0, max);
}

// ➤ Adds the new offers to the "Pending" section of pipeline.md, each with a fixed number
// ➤ (#412...) shown in the Telegram messages, so "seen 412" can never hit the wrong one.
function appendToPipeline(offers) {
  if (offers.length === 0) return;
  // ➤ Under lock. The scan runs every two hours and takes minutes, but this part — read the
  // ➤ file, add the offers, write it back — must not overlap with a "seen" from Telegram or
  // ➤ with the cleanup: whoever writes second erases the other's work (measured, eight
  // ➤ overlapping writers kept 200 lines out of 1,600). Only these milliseconds are held,
  // ➤ not the scan.
  return withFileLock(PIPELINE_PATH, () => appendToPipelineLocked(offers));
}

function appendToPipelineLocked(offers) {
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : `# Pipeline\n\n${PENDING_HEADING}\n\n${PROCESSED_HEADING}\n`;
  // ➤ Positional numbering caused wrong-offer feedback — the Telegram list is
  // ➤ country-grouped, so positions never matched.
  let nextId = 0;
  // ➤ Finds the highest number already used in the file to keep counting from it (a number
  // ➤ is never repeated). It counts the # at end of line AND the # right before the "|
  // ➤ visto" marker — a looser pattern could swallow a "#123" that came inside a title.
  for (const m of text.matchAll(/\|\s*#(\d+)\s*(?:\|\s*visto\s*)?$/gim)) nextId = Math.max(nextId, parseInt(m[1], 10));
  // ➤ HIGH-WATER MARK. The count above is the largest id still PRESENT in the file, and
  // ➤ housekeep DELETES lines — when the highest-numbered offer dies, the next new offer
  // ➤ would get that number again and two offers would share "#412". So the highest id EVER
  // ➤ handed out is remembered too: numbers only move forward.
  nextId = Math.max(nextId, loadIdHighWater());
  // ➤ Where to insert: the pending heading, asked for in one place.
  const idx = pendingIndex(text);
  const marker = idx === -1 ? PENDING_HEADING : text.slice(idx).split('\n')[0];
  const block = offers.map(o => {
    const loc = normalizeLocation(o.location);
    o.id = ++nextId;
    // ➤ If the years asked (y:) or the salary (s:) are known, they're saved in the line — the
    // ➤ "list" command shows them. The #number is still the last field (the "seen" command
    // ➤ requires it). y: only ever carries a NUMBER: multiYearScreen returns the string '3+',
    // ➤ and "y:3+" is not a shape the list parser recognises — it would display "3+" as the
    // ➤ LOCATION.
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
  // ➤ TIDY: every scan would otherwise leave one orphan blank line behind, and housekeep's
  // ➤ deletions leave more (a live file once grew to 376 blank lines out of 486). Runs of
  // ➤ blank lines collapse to one.
  text = text.replace(/\n{3,}/g, '\n\n');
  writeFileAtomic(PIPELINE_PATH, text);
  // ➤ Remember the highest number handed out, so a later cleanup that deletes
  // ➤ that line can never make the counter go backwards and reuse it.
  saveIdHighWater(nextId);
}

// ── The offer-number high-water mark ────────────────────────────────────
// ➤ data/last-id.json holds the biggest #id ever assigned, because pipeline.md (where the
// ➤ ids live) has lines DELETED from it.
const LAST_ID_PATH = join(ROOT, 'data', 'last-id.json');
// ➤ The highest offer number ever handed out. Reading it is deliberately paranoid: getting
// ➤ it wrong gives two different jobs the same number, so "no 412" from an older message
// ➤ hits the wrong one. IT DOES NOT TRUST ONE FILE — if data/last-id.json is lost or
// ➤ corrupt, the pipeline (a file housekeep DELETES from) would be the only source and the
// ➤ counter would walk backwards (provoked: deleting the counter and the top lines handed
// ➤ #4 to a second job). So it also reads every other place a number was ever written:
// ➤ append-only records, a floor the counter can never fall below. The paths are arguments
// ➤ so a test proves this on files of its own.
export function loadIdHighWater(counterPath = LAST_ID_PATH, recordPaths = [join(ROOT, 'data', 'applications.jsonl'), join(SCRIPT_DIR, 'feedback.jsonl')]) {
  let mark = 0;
  try {
    const n = JSON.parse(readFileSync(counterPath, 'utf-8'))?.lastId;
    if (Number.isInteger(n) && n > 0) mark = n;
  } catch { /* missing or corrupt: the records below still know */ }
  // ➤ The applications you sent, and the offers you rejected with a reason. Both
  // ➤ are only ever appended to, so nothing here can shrink.
  for (const p of recordPaths) {
    try {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { const id = JSON.parse(line)?.id; if (Number.isInteger(id) && id > mark) mark = id; } catch { /* corrupt line */ }
      }
    } catch { /* no such record yet */ }
  }
  return mark;
}
function saveIdHighWater(n) {
  if (!Number.isInteger(n) || n <= 0) return;
  // ➤ Written atomically: this small file is the ONLY thing between us and handing the same
  // ➤ #number to two offers. A write cut in half leaves invalid JSON, the reader falls back
  // ➤ to the highest id still in the pipeline — which housekeep deletes from — and the
  // ➤ counter walks backwards.
  try { writeFileAtomic(LAST_ID_PATH, JSON.stringify({ lastId: n }) + '\n'); }
  catch { /* best-effort: at worst we fall back to the old behaviour */ }
}

// ➤ Adds each new offer to scan-history.tsv (date, portal, title...): the memory that
// ➤ avoids repeating offers in future scans.
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

// ➤ Small work organiser: runs a list of tasks in parallel, only a few at a time (the
// ➤ limit), so neither the home server nor the portals are overloaded.
async function parallel(tasks, limit) {
  let i = 0;
  // ➤ ERROR ISOLATION: a single throwing task must not abort its whole worker, or one bad
  // ➤ link cuts a sweep short and the remaining offers look like they were never there.
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      try { await task(); } catch (e) { console.log(`  (task failed, continuing: ${String(e && e.message).slice(0, 100)})`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));
}

// ➤ Writes the COMPLETE list of scan decisions (--explain mode) to data/scan-explain.txt:
// ➤ one line per offer with the exact reason it was discarded (or "NEW"), grouped by
// ➤ reason, with a summary on top.
function writeExplainReport(rows, found) {
  // ➤ Order in which the reasons are shown (first the ones that reach you). COMPANY and
  // ➤ DEFERRED are counted in the summary too, not only written to the report.
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


// ➤ ── THE RUN'S ACCOUNTING, IN ONE PLACE ────────────────────────────────
// ➤ main() hands these the numbers it kept and nothing here reaches back into the run —
// ➤ what makes the alarm testable: it decides from a summary, not from the scan's own
// ➤ locals.

// ➤ A "snapshot" of the scan in last-scan.json (when it ran, how many offers, how many
// ➤ failures...), to monitor that the server scanner is working.
function writeStateSnapshot(s) {
  writeFileSync(STATE_PATH, JSON.stringify({
    last_scan: new Date().toISOString(),
    companies_scanned: s.targets,
    jobs_found: s.found,
    new_offers: s.newOffers.length,
    countries_off: s.countriesOff,
    adzuna_calls: s.adzunaCalls,
    adzuna_failed: s.adzunaFailed,
    rate_limited: s.adzunaRateLimited,
    lang_filtered: s.fLang,
    exp_filtered: s.fExp,
    degree_filtered: s.fDeg,
    linkedin_calls: s.liCalls,
    linkedin_status: s.liStatus,
    dropped_dead: s.prunedDead,
    no_link: s.fNoLink,
    telegram: s.telegram,
    errors: s.errors.length,
  }, null, 2));
}

// ➤ Final summary on screen: how many offers were found, how many fell at each
// ➤ filter and how many new ones were added.
function printSummary(s) {
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan (extended) — ${s.date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${s.targets}${s.sourcesOk < s.targets ? ` (${s.sourcesOk} answered)` : ''}`);
  if (s.emptyBoards.length) console.log(`  boards that answered with zero postings: ${s.emptyBoards.join(', ')}`);
  console.log(`Total jobs found:      ${s.found}`);
  console.log(`Filtered by title:     ${s.fTitle}`);
  console.log(`Filtered by company:   ${s.fCompany} (blocklist)`);
  console.log(`Filtered by location:  ${s.fLoc}`);
  console.log(`Filtered by country:   ${s.fCountry} (toggled OFF)`);
  // ➤ Printed only when it happens: on a healthy run it is zero, and a line of
  // ➤ zeros every two hours is how a number stops being read.
  if (s.fNoLink) console.log(`Dropped, no usable link: ${s.fNoLink}  <-- a board may have changed its link field`);
  console.log(`Duplicates:            ${s.dupes}`);
  if (s.adzunaWanted) {
    console.log(`Adzuna API calls:      ${s.adzunaCalls} ok, ${s.adzunaFailed} failed${s.adzunaRateLimited ? ' (RATE LIMITED)' : ''}`);
  }
  console.log(`Filtered by language:  ${s.fLang} (title not in EN/ES/CA)`);
  console.log(`Filtered by exp. years:${s.fExp} (require > threshold)`);
  console.log(`Filtered by degree:    ${s.fDeg} (requires one you lack)`);
  if (s.fDeferred) console.log(`Deferred (body unread): ${s.fDeferred} — retried on the next scan`);
  if (s.liEnabled) console.log(`LinkedIn:              ${s.liCalls} calls (${s.liStatus})`);
  console.log(`Dropped (dead):        ${s.prunedDead}`);
  console.log(`Telegram:              ${s.telegram}`);
  console.log(`New offers added:      ${s.newOffers.length}`);

  if (s.skipped.length) {
    console.log(`\nNot used (optional, nothing is wrong):`);
    for (const x of s.skipped) console.log(`  · ${x}`);
  }
  if (s.errors.length) {
    console.log(`\nErrors (${s.errors.length}):`);
    for (const e of s.errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }
}

// ➤ ── SAY WHEN THE RUN DID NOTHING AT ALL ────────────────────────────────
// ➤ Argus's normal failure is to find nothing, which looks exactly like a quiet week: no
// ➤ network, a config that selects no sources, or sources none of which answered all
// ➤ produce a clean exit and silence. NOT "everything errored" — "nothing answered": a
// ➤ source switched on but never reached raises no error (a missing Adzuna key is reported
// ➤ as skipped; LinkedIn's cadence and cooldown paths return in silence), so requiring an
// ➤ error would let the quietest failure pass. A --company run is exempt: the aggregators
// ➤ are off on purpose. Pure and exported so the decision can be tested without a scan.
export function runVerdict(s) {
  const anySourceConfigured = s.targets > 0 || s.adzunaWanted || s.liEnabled;
  if (!anySourceConfigured) return 'nothing-to-scan';
  const everythingFailed = !s.only && s.sourcesOk === 0 && s.adzunaCalls === 0 && s.liCalls === 0 && s.found === 0;
  return everythingFailed ? 'everything-failed' : null;
}

async function alarmIfNothingRan(s) {
  const verdict = runVerdict(s);
  if (verdict === 'nothing-to-scan') {
    console.log('\n! NOTHING WAS SEARCHED. No employer, no aggregator and no LinkedIn are switched on —');
    console.log('  portals.yml and config/profile.yml between them select no sources at all.');
    console.log('  This run did nothing, and so will every run until that is changed.');
  } else if (verdict === 'everything-failed') {
    console.log(`\n! EVERY SOURCE FAILED — not one of them answered (${s.errors.length} error(s)).`);
    console.log('  That is a network or configuration problem, not a quiet week: no offer could');
    console.log('  have been found today whatever was published.');
  }
  // ➤ And say it where you would actually see it, not only in a log file nobody
  // ➤ opens. Once per run, and never on a dry run.
  if (verdict && !s.dryRun && !process.env.ARGUS_SKIP_LIST_REFRESH) {
    try {
      const { sendTelegram } = await import(new URL('./notify.mjs', import.meta.url));
      await sendTelegram(verdict === 'nothing-to-scan'
        ? 'Argus searched nothing this run: no employer, aggregator or LinkedIn is switched on. Nothing will arrive until that is fixed.'
        : `Argus could not reach a single source this run (${s.errors.length} error(s)). That is a network or configuration problem, not a quiet week.`);
    } catch { /* if Telegram is down too, the log above is what is left */ }
  }
}

// ➤ Same cleaning as the pipeline line, so the log reads like the offer does on
// ➤ Telegram ("R&amp;D" was showing up raw here).
function printNewOffers(offers) {
  if (!offers.length) return;
  console.log('\nNew offers:');
  for (const o of offers) console.log(`  + ${sanitizeField(o.company)} | ${sanitizeField(o.title)} | ${sanitizeField(normalizeLocation(o.location)) || 'N/A'}${o.years != null ? ` | ${o.years}yr req` : ''}`);
}

async function main() {
  // ➤ The cron log this run appends to must not grow for ever (Linux/mac; the
  // ➤ file does not exist on Windows, where output is discarded).
  trimLog(join(SCRIPT_DIR, 'scan.log'));
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
  // ➤ search.negative_titles) when set; otherwise from portals.yml (the marine default) — so
  // ➤ the onboarding configures the base filter in one file.
  const vetoes = loadVetoes();
  const titleFilter = buildTitleFilter({
    positive: searchProfile.positive_titles || (config.title_filter || {}).positive,
    negative: titleNegativesWith(searchProfile.negative_titles || (config.title_filter || {}).negative, vetoes),
  });
  // ➤ ── WHERE THE OFFERS COME FROM ──────────────────────────────────────
  // ➤ The SOURCES can come from config/profile.yml: fixed in portals.yml, the engine
  // ➤ filtered correctly for anybody but always over a marine stream — a non-marine user got
  // ➤ an empty list for ever. Everything below falls back to portals.yml, so a profile
  // ➤ without these keys behaves the same. search.queries: the phrases to ASK the boards for
  // ➤ (plain words, e.g. ["financial accountant", "bookkeeping"]); they feed Adzuna,
  // ➤ LinkedIn and the Workday search boxes at once.
  const profileQueries = Array.isArray(searchProfile.queries) ? searchProfile.queries.map(q => String(q).trim()).filter(Boolean) : null;
  // ➤ search.locations: { allow: [...], block: [...] } to replace the example
  // ➤   geography wholesale.
  const profileLocations = searchProfile.locations && typeof searchProfile.locations === 'object' ? searchProfile.locations : null;

  const locationFilter = buildLocationFilter(locationFilterWith(profileLocations || config.location_filter, vetoes));
  const companyFilter = buildCompanyFilter(companyFilterWith(config.company_filter, vetoes));
  const country = buildCountryFilter();
  // ➤ Workday searches one term at a time, so each query is used as a term.
  const workdayTerms = profileQueries || config.workday_search_terms || [];
  // ➤ Adzuna takes "any of these words" per query.
  const adzunaCfg = profileQueries
    ? { ...(config.adzuna || {}), queries: profileQueries.map(q => ({ what_or: q })) }
    : (config.adzuna || {});
  // ➤ The COUNTRIES must follow the profile too, not only the queries: otherwise an
  // ➤ onboarded user's whole Adzuna budget goes to the marine example's seven countries —
  // ➤ whose results their own location filter then kills — while the countries they chose
  // ➤ are never queried.
  const profileAdzunaCountries = Array.isArray(searchProfile.countries)
    ? searchProfile.countries.filter(c => c && c.adzuna && c.name).map(c => ({ name: c.name, code: c.adzuna }))
    : [];
  if (profileAdzunaCountries.length) adzunaCfg.countries = profileAdzunaCountries;

  // ➤ Of all the companies in portals.yml, keeps the active ones, those matching --company
  // ➤ (if used) and those with a portal it can ask directly. The tracked-company list is a
  // ➤ worked EXAMPLE (marine employers): a profile that sets
  // ➤ `search.track_example_companies: false` — as the onboarding does for a non-marine user
  // ➤ — skips them, so no API budget goes to boards that will never match.
  const useExampleCompanies = searchProfile.track_example_companies !== false;
  const targets = (useExampleCompanies ? companies : [])
    .filter(c => c.enabled !== false)
    .filter(c => !only || c.name.toLowerCase().includes(only))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  // ➤ Counted against the SAME set targets was built from: with --company, comparing against
  // ➤ every enabled company would report "28 skipped — no direct API" for boards nobody
  // ➤ asked for.
  const considered = companies.filter(c => c.enabled !== false && (!only || c.name.toLowerCase().includes(only)));
  const noApi = considered.length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${noApi} skipped — no direct API, need AI/websearch)`);
  if (country.off.length) console.log(`Countries OFF: ${country.off.join(', ')}`);
  if (dryRun) console.log('(dry run — nothing will be written)\n');

  // ➤ Loads the memory of already-seen offers (by link and by company+title).
  const seenUrls = loadSeenUrls();
  const seenRoles = loadSeenCompanyRoles();
  const date = new Date().toISOString().slice(0, 10);

  // ➤ Counters for the final summary: found, discarded by
  // ➤ title/location/country, and duplicates.
  let found = 0, fTitle = 0, fLoc = 0, fCountry = 0, fCompany = 0, fNoLink = 0, dupes = 0;
  const newOffers = [];
  const errors = [];
  // ➤ Optional sources that were not used because they are not set up. Kept
  // ➤ apart from `errors` so a fresh install does not read as a broken one.
  const skipped = [];

  // ➤ --explain mode records, offer by offer, WHY each one was discarded, for the complete
  // ➤ "one line per offer" list (data/scan-explain.txt). Without --explain, logDrop does
  // ➤ nothing.
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

  // ➤ The "entry gate": every offer found must clear, in order, the title filter, the
  // ➤ location one, the off-country one and the two duplicate checks before it counts as
  // ➤ new.
  function admit(job, source) {
    const v = admissionVerdict(job, { companyFilter, titleFilter, locationFilter, country, seenUrls, seenRoles });

    if (!v.ok) {
      if (v.stage === 'COMPANY') fCompany++;
      else if (v.stage === 'TITLE') fTitle++;
      else if (v.stage === 'LOCATION') fLoc++;
      else if (v.stage === 'COUNTRY') fCountry++;
      else if (v.stage === 'DUPLICATE') dupes++;
      // ➤ THE FIRST GATE COUNTS TOO: an offer thrown out for a missing or unsafe link must
      // ➤ appear in the summary and in last-scan.json — zero on a healthy run, which is exactly
      // ➤ why it would go unnoticed the day a board renames the field its links come from.
      else if (v.stage === 'NO LINK') fNoLink++;

      logDrop(v.stage, v.reason, job, source);
      return;
    }

    seenUrls.add(normUrl(job.url));
    const key = roleKey(job.company, job.title);
    if (key) seenRoles.add(key);
    newOffers.push({ ...job, source });
  }

  // ➤ ── WHAT THE PHASES SHARE ─────────────────────────────────────────────
  // ➤ Every counter the summary reads is declared here, once, so each phase
  // ➤ below can be read on its own: it fills these in, it never invents them.
  // ➤ How many sources answered at all. Used at the end to tell "a quiet week"
  // ➤ from "nothing could be reached", which look identical otherwise.
  let sourcesOk = 0;
  // ➤ Boards that ANSWER with zero postings, named: an answered zero never trips the
  // ➤ no-answer alarm, and three boards sat wrong for weeks behind that — a stale tenant (5
  // ➤ postings, the real board had 733), an absorbed brand (0), one legitimately quiet
  // ➤ board. One glance tells which you have.
  const emptyBoards = [];
  let adzunaCalls = 0, adzunaFailed = 0, adzunaRateLimited = false;
  const adzunaWanted = adzunaCfg.enabled
    && !args.includes('--no-adzuna')
    && (!only || 'adzuna'.includes(only));
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
  let fLang = 0;
  const langCfg = config.title_language_filter || {};
  const langEnabled = langCfg.enabled !== false && !args.includes('--no-langcheck');
  let fExp = 0, fDeg = 0, fDeferred = 0;
  let prunedDead = 0;
  let telegram = dryRun ? 'dry-run' : 'nothing to send';

  // ➤ ── THE RUN, PHASE BY PHASE ──────────────────────────────────────────
  // ➤ Each phase is a named function further down; this is the whole scan
  // ➤ in the order it happens.
  await collectFromCompanies();
  await collectFromAdzuna();
  await collectFromLinkedIn();
  await enrichWorkdayLocations();
  await screenTitleLanguage();
  await screenRequirements();
  await dropDeadLinks();
  dumpExplainReport();
  await persistAndNotify();

  const summary = {
    date, dryRun, only, targets: targets.length, sourcesOk, emptyBoards, found,
    fTitle, fCompany, fLoc, fCountry, fNoLink, dupes,
    adzunaWanted, adzunaCalls, adzunaFailed, adzunaRateLimited,
    fLang, fExp, fDeg, fDeferred, liEnabled: !!liCfg.enabled, liCalls, liStatus,
    prunedDead, telegram, newOffers, errors, skipped, countriesOff: country.off,
  };
  if (!dryRun) writeStateSnapshot(summary);
  printSummary(summary);
  await alarmIfNothingRan(summary);
  printNewOffers(newOffers);

  // ➤ ── THE PHASES ──────────────────────────────────────────────────────
  async function collectFromCompanies() {
    // ➤ Prepares one task per company: each queries its portal with the
    // ➤ right recipe and passes its offers through the entry gate.
    const tasks = targets.map(c => async () => {
      try {
        let jobs;
        // ➤ A board that stops halfway is recorded like any other failure, so the
        // ➤ summary can never read as a quiet day when 41 of 42 pages went unread.
        const partial = (err, got) => errors.push({
          company: c.name,
          error: `only part of the board was read (${got} offers before it stopped): ${err?.message || 'unknown'}`,
        });
        if (c._api.type === 'workday') {
          jobs = await collectWorkday(c._api, c.name, workdayTerms, partial);
        } else if (c._api.type === 'oracle') {
          jobs = await collectOracle(c._api, c.name, partial);
        } else if (c._api.type === 'sitemap') {
          jobs = await collectSitemap(c._api, c.name, titleFilter);
        } else if (c._api.type === 'successfactors') {
          // ➤ The only source that answers in XML, so it is fetched as text.
          const res = await fetch(c._api.url, {
            headers: { 'User-Agent': DESC_UA, Accept: 'application/rss+xml, text/xml, */*' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),   // whole boards run to megabytes
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          jobs = parseSuccessFactors(await res.text(), c.name);
        } else {
          // ➤ Greenhouse withholds the advert text unless asked; see above.
          const url = c._api.type === 'greenhouse' ? greenhouseUrlWithContent(c._api.url) : c._api.url;
          const json = await fetchJson(url);
          jobs = PARSERS[c._api.type](json, c.name);
        }
        // ➤ The same ceiling for Greenhouse, Lever and Ashby as for Workday and Oracle (see
        // ➤ capJobs): a hostile feed is stopped and SAID, never truncated in silence.
        jobs = capJobs(jobs, c.name);
        sourcesOk++;
        if (jobs.length === 0) emptyBoards.push(c.name);
        found += jobs.length;
        for (const job of jobs) admit(job, `${c._api.type}-api`);
      } catch (err) {
        errors.push({ company: c.name, error: err.message });
      }
    });

    // ➤ Runs all the company tasks, 8 at a time at most.
    await parallel(tasks, CONCURRENCY);
  }

  async function collectFromAdzuna() {
    // ── Adzuna aggregator (skipped when --company targets an ATS) ─────
    // ➤ Only if enabled in the configuration and not skipped by the flag. Without access keys
    // ➤ the note is recorded and it continues.
    if (adzunaWanted) {
      const creds = loadAdzunaCreds();
      if (!creds) {
        // ➤ NOT an error: the Adzuna key is optional and the README says so; listing it under
        // ➤ "Errors" on every scan of a fresh install reads as "your setup is broken".
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
  }

  async function collectFromLinkedIn() {
    // ── LinkedIn jobs-guest (optional, low volume, self-throttled) ─────
    // ➤ Just as optional, and self-throttled (cadence and rests, explained above).
    if (liCfg.enabled && !args.includes('--no-linkedin') && (!only || 'linkedin'.includes(only))) {
      const res = await collectLinkedIn(liCfg);
      liCalls = res.calls;
      liStatus = res.status;
      found += res.offers.length;
      for (const job of res.offers) admit(job, 'linkedin');
    }
  }

  async function enrichWorkdayLocations() {
    // ── Workday multi-location enrichment ──────────────────────────────
    // ➤ "Fill in locations": Workday offers that said "N Locations" came in with no location;
    // ➤ just for those few, the detail is requested and the country rules re-applied.
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
            // ➤ The description travels in this same response; stashing it saves fetchOfferDescription
            // ➤ re-downloading the identical URL minutes later.
            if (info.jobDescription) o._jd = stripHtml(info.jobDescription);
            const locs = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
            if (!locs.length) return; // still unknown — keep as-is
            // ➤ Generous rule: as long as ONE of the locations is allowed the offer stays (and that
            // ➤ one is shown); discarded only if ALL are blocked.
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
  }

  async function screenTitleLanguage() {
    // ── Language screen ───────────────────────────────────────────────
    // ➤ TITLE language step: out with offers whose title is in a language the user does not
    // ➤ speak, or that already demand a language in the title. Allowed languages come from the
    // ➤ profile (search.languages); portals.yml or EN/ES/CA are fallbacks.
    const langAllow = new Set((searchProfile.languages || langCfg.allow || ['en', 'es', 'ca']).map(s => String(s).toLowerCase()));
    if (langEnabled && newOffers.length > 0) {
      const drops = new Set();
      const checks = newOffers.map((o, i) => async () => {
        // ➤ Garbled titles first: deterministic, and saves the network lookup.
        if (titleEncodingBroken(o.title)) { drops.add(i); o._why = 'the title arrived garbled from the portal (broken encoding)'; return; }
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
  }

  async function screenRequirements() {
    // ── Experience and degree screen ──────────────────────────────────
    // ➤ Years-of-experience and degree step: the text of each admitted offer is downloaded
    // ➤ and, if it clearly asks for more years than the profile's max_years or requires a
    // ➤ degree the user lacks, it's discarded; unknown → kept. The same text feeds the refined
    // ➤ language rule: not which language the offer is WRITTEN in, only whether the body
    // ➤ REQUIRES one the user does not speak.
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
        // ➤ Experience verdict: how many years AND in what field — 2 years "in a similar role" of
        // ➤ PLC discard like 5 (the user can't prove them); 2 years of mooring they can.
        const verdict = experienceScreen(`${o.title || ''}. ${desc}`, o.title, maxYears);
        if (verdict) o.years = verdict.years;         // surfaced in the scan log
        // ➤ OrcaFlex rule: an offer that mentions the user's star tool stays even past the years
        // ➤ cap; the language is still checked. The term list lives in the profile
        // ➤ (search.priority_terms).
        const priority = PRIORITY_KEEP.test(`${o.title || ''} ${desc}`);
        if (verdict && verdict.drop && !priority) {
          drops.add(i);
          o._why = verdict.why === 'over-threshold' ? `asks for ${verdict.years} years of experience (your cap is ${maxYears})`
            : verdict.why === 'field-mismatch' ? `asks for ${verdict.years} year(s) of experience in a field that isn't yours`
            : `asks for more experience than you have`;
          return;
        }
        // ➤ DEGREE requirement in the body: a master's/degree in a field the user doesn't have,
        // ➤ with none of their fields mentioned → out. OrcaFlex exempts, as with the years.
        if (!priority && degreeScreen(desc, o.title)) { drops.add(i); o.degree = true; o._why = 'the body requires a degree you do not have (mechanical/electrical/civil engineering/etc.)'; return; }
        // ➤ Refined language rule: not which language the offer is written in — only whether the
        // ➤ body REQUIRES one you don't speak (not as "valued/a plus"). For Adzuna the clean
        // ➤ description region (or the API snippet) is used, never the whole page with its menus
        // ➤ in the country's language.
        if (langEnabled) {
          const pure = o.source === 'adzuna' ? (o._jd || stripHtml(o.description || '')) : desc;
          if (pure && bodyLanguageBlock(pure)) { langDrops.add(i); o._why = 'the body REQUIRES (mandatory) a language you do not speak'; }
        }
        // ➤ DEFERRAL: if the detail page could NOT be read (429 exhausted), the offer isn't shown
        // ➤ half-examined — left out WITHOUT recording it, the next scan (2 h, fresh quota)
        // ➤ re-finds and examines it. OrcaFlex exception: a snippet naming your star tool comes in
        // ➤ anyway.
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
        // ➤ Years and degree are different verdicts and were reported as one:
        // ➤ a drop for a degree the owner lacks was printed under "exp. years".
        fExp = [...drops].filter(i => !newOffers[i].degree).length;
        fDeg = [...drops].filter(i => newOffers[i].degree).length;
        fLang += langDrops.size;
        fDeferred = deferred.size;
        newOffers.length = 0;
        newOffers.push(...kept);
      }
    }
  }

  async function dropDeadLinks() {
    // ➤ Last filter: the Adzuna links are checked to be alive, so no withdrawn offer reaches you.
    if (newOffers.length > 0 && !args.includes('--no-liveness')) {
      const candidates = newOffers.map((o, i) => ({ o, i })).filter(x => x.o.source === 'adzuna');
      const dead = new Set();
      const checks = candidates.map(({ o, i }) => async () => {
        // ➤ The experience screen already downloaded this page and left the evidence on the offer
        // ➤ — judging from it avoids a second download of the batch. Only offers without evidence
        // ➤ (screen skipped or errored) still fetch.
        const isDead = o._live
          ? deadFromEvidence(o._live.status, o._live.finalUrl, o._live.body)
          : await isLikelyDead(o.url);
        if (isDead) { dead.add(i); o._why = 'the link no longer works (offer withdrawn or expired)'; }
        delete o._live;   // evidence served its purpose — keep it off the pipeline file
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
  }

  function dumpExplainReport() {
    // ── --explain: record the survivors and dump the complete list ──
    // ➤ Every offer here is NEW (it'll reach you); with everything recorded,
    // ➤ data/scan-explain.txt is written, one line per offer.
    if (explain) {
      for (const o of newOffers) logDrop('✅ NEW', 'passed all filters — it reaches you', o);
      writeExplainReport(explainRows, found);
    }
  }

  async function persistAndNotify() {
    // ── Persist + refresh the single live list ──────────────────────────
    // ➤ Saving: unless it's a dry run, new offers are recorded in pipeline.md and the history.
    // ➤ There is NO separate "new offers" message: the ONLY Telegram message is the single
    // ➤ live list, which deletes its previous version and re-posts ALL pending offers, and
    // ➤ alert:true makes that repost audible. EXCEPTION: launched by the listener with
    // ➤ "search" (ARGUS_SKIP_LIST_REFRESH=1) it does NOT refresh here — the listener refreshes
    // ➤ AFTER "Search finished" so the list ends at the bottom. It must SAY WHY nothing was
    // ➤ sent: "off" is what an unconfigured bot reports, and a quiet run must not read like a
    // ➤ broken setup.
    if (!dryRun && newOffers.length > 0) {
      appendToPipeline(newOffers);
      appendToScanHistory(newOffers, date);
      if (!process.env.ARGUS_SKIP_LIST_REFRESH) {
        // ➤ THE LIST WAITS FOR THE COUNCIL. An alert sent the moment the offers land shows the
        // ➤ newest offer with no [YES]/[NO] on it, the verdicts arriving by a silent replacement
        // ➤ minutes later. With the Council on, the new offers are judged FIRST and the one
        // ➤ alerted list already carries every verdict. Capped and best-effort: judges failing or
        // ➤ timing out mean an untagged list, never a missing or a late one. (The interactive
        // ➤ "search" path skips this block with the refresh.)
        if (config.council?.enabled === true) {
          const { execFile } = await import('child_process');
          await new Promise(resolve => {
            execFile(process.execPath,
              [join(SCRIPT_DIR, 'argus-council', 'judge-shadow.mjs'), '--pending-only', '--no-refresh'],
              { cwd: ROOT, timeout: 12 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
              (err, stdout) => {
                const tail = String(stdout || '').trim().split('\n').pop() || 'no output';
                console.log(`Council before the list: ${err ? `skipped (${String(err.message).slice(0, 120)})` : tail}`);
                resolve();
              });
          });
        }
        try {
          const { refreshList } = await import(new URL('./live-list.mjs', import.meta.url));
          const n = await refreshList({ alert: true });
          // ➤ THREE DIFFERENT ANSWERS, not two. refreshList returns null when Telegram is not set up
          // ➤ and false when the send FAILED; writing both down as "not-configured" would make the
          // ➤ summary say the bot was not set up when it was, while the new offers had already been
          // ➤ written to the pending list and to the anti-repeat history — so they could never be
          // ➤ offered again, and you were never told about them once.
          telegram = n === null ? 'not-configured' : n === false ? 'SEND FAILED' : 'sent';
        } catch (e) {
          telegram = 'error';
          console.log('Live list refresh failed:', e.message);
        }
      } else {
        telegram = 'skipped-search';
      }
    }
  }

}

// ➤ The scan only runs when this file is launched directly (node server-bot/scan.mjs);
// ➤ importing it triggers nothing. The path separator is part of the check so "x-scan.mjs"
// ➤ cannot fire it. Renaming this file means changing this line too, or the scanner
// ➤ silently stops starting.
if (process.argv[1] && /(^|[\\/])scan\.mjs$/.test(process.argv[1])) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
