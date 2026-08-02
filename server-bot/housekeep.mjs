#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the "cleanup service" of the automated job searcher.
// ➤ WHAT IT DOES: reviews the pending offers in data/pipeline.md and hides the
// ➤ ones that no longer count: dead links (offer filled or withdrawn), duplicates,
// ➤ or the ones that no longer pass your title, language and experience filters.
// ➤ WHEN IT RUNS: two scheduled jobs on the server — daily at 07:30 it only
// ➤ checks links (--liveness-only) and on Sunday a full cleanup.
// ➤ USES: data/pipeline.md (reads and rewrites it), portals.yml (your rules) and
// ➤ shared pieces from scan.mjs, requirements.mjs and liveness-core.mjs.
// ➤ ═══════════════════════════════════════════════════════════════════════

/**
 * housekeep.mjs — pipeline hygiene for argus (run weekly via cron).
 *
 * Over time the Pending list accumulates:
 *   - dead links (offers filled or withdrawn since they were scanned)
 *   - duplicates that predate the cross-scan dedup fix (same role,
 *     different aggregator ID, or company-name variants)
 *
 * These lines are DELETED from the pipeline (their URLs go to scan-history
 * for dedup). Until 2026-07-18 they were flipped to [x] instead — the user: noise.
 * Liveness is conservative: only HTTP 404/410 or explicit "expired" text
 * counts as dead — JS-heavy pages and network errors are kept.
 *
 * Usage:
 *   node server-bot/housekeep.mjs            # clean
 *   node server-bot/housekeep.mjs --dry-run  # report only
 */

// ➤ Tools it needs: read/write files and the same filters the scanner uses.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
// ➤ Atomic overwrite so a crash mid-write can't truncate the pending list.
import { writeFileAtomic, withFileLock } from './fs-atomic.mjs';
import { isPendingHeading } from './pipeline-format.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { buildTitleFilter, buildLocationFilter, buildCompanyFilter, detectTitleLang, titleDemandsForeignLanguage, bodyLanguageBlock, overrideDeadIfApply } from './scan.mjs';
import { experienceScreen, degreeScreen, stripHtml, extractAdzunaJd, PRIORITY_KEEP, searchProfile } from './requirements.mjs';
// ➤ To refresh the Telegram list after deleting: otherwise you keep seeing on
// ➤ your phone offers that no longer exist (audit 2026-07-25).
import { refreshList } from './live-list.mjs';

// ➤ Locates the paths of the files it uses: the offer list and your config.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const PORTALS_PATH = join(ROOT, 'portals.yml');

// ➤ Loads Argus's "dead offer" detector (server-bot/liveness-core.mjs);
// ➤ if it's missing, it uses a minimal version (only 404/410 errors).
let classifyLiveness;
try {
  ({ classifyLiveness } = await import('file://' + join(SCRIPT_DIR, 'liveness-core.mjs').replace(/\\/g, '/')));
} catch {
  classifyLiveness = ({ status }) =>
    (status === 404 || status === 410)
      ? { result: 'expired', reason: `HTTP ${status}` }
      : { result: 'active', reason: 'fallback' };
}

// ➤ How many links are checked at once (5, so as not to overload the sites).
const LIVENESS_CONCURRENCY = 5;

// ➤ Cleans a URL for comparing duplicates: strips what comes after "?" and the
// ➤ trailing slash; and the Adzuna redirect /land/ad/<id> is matched to its
// ➤ /details/<id> page (same offer, two link forms).
// ➤ Two links to the SAME posting written differently. Exported to be tested:
// ➤ it decides whether an offer already lives in the history, and getting it
// ➤ wrong either deletes something twice or lets a deleted one come back.
export function normUrl(u) {
  return (u || '').split('?')[0].replace(/\/$/, '')
    .replace(/^(https?:\/\/[^/]*adzuna\.[a-z.]+)\/land\/ad\/(\d+)$/, '$1/details/$2');
}

// ➤ (2026-07-18: "the [x]s are noise") Housekeep NO LONGER hides lines with
// ➤ [x]: it DELETES them from the pipeline. So the same offer doesn't sneak back
// ➤ in as "new" on the next scan, before deleting it makes sure its
// ➤ URL is in data/scan-history.tsv (the scanner's anti-repeat memory).
// ➤ The "| visto" lines (the user's decisions) don't pass through here: they're kept.
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
function ensureInHistory(offers, why) {
  const known = new Set();
  try {
    for (const l of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const u = l.split('\t')[0];
      if (u) known.add(normUrl(u));
    }
  } catch {}
  const sane = s => String(s || '').replace(/[\t|]/g, ' ').replace(/\s+/g, ' ').trim();
  const today = new Date().toISOString().slice(0, 10);
  const rows = offers.filter(o => o.url && !known.has(normUrl(o.url)))
    .map(o => `${o.url}\t${today}\thousekeep\t${sane(o.title)}\t${sane(o.company)}\t${why}\t${sane(o.location)}`);
  if (rows.length) appendFileSync(SCAN_HISTORY_PATH, rows.join('\n') + '\n', 'utf-8');
}

// ➤ Builds a "fingerprint" of each offer (company + title) to catch duplicates
// ➤ even when the company name varies: "Connetix" and "Connetix Nederland"
// ➤ reposting the same title are one offer, not two.
// ➤ (2026-07-18, Lonza case #595/#602) Same as the scanner's roleKey:
// ➤ the gender tags "(m/w/d)"/"(All Genders)" and the schedules
// ➤ "80-100%" are stripped before comparing — the same role reposted with
// ➤ another tag no longer dodges the user's decision.
// ➤ SAFE REWRITE (audit 2026-07-25). housekeep reads pipeline.md, then spends
// ➤ minutes doing HTTP checks, then rewrites the file from that OLD snapshot —
// ➤ so anything you did meanwhile from Telegram (a "seen", a "no", a new scan)
// ➤ was silently undone. Instead of writing back our stale copy, we re-read the
// ➤ file at the last moment and delete only the LINES WE DECIDED ON, matched by
// ➤ their exact text. Whatever else changed in between is preserved.
// ➤ THE ONLY PERMANENT DELETE IN THE PROJECT: it rewrites your pending list
// ➤ without the lines given. Exported, and with the file to work on as an
// ➤ argument, so a test can prove what it removes without going anywhere near
// ➤ your real list — an audit found it had no test at all, which for the one
// ➤ function that destroys data is the wrong place to be short of them.
// ➤ Matching is EXACT on the trimmed line: a line that changed in the meantime
// ➤ no longer matches and survives, which is the safe way round.
export function rewritePipelineWithout(linesToDrop, path = PIPELINE_PATH) {
  const drop = new Set(linesToDrop.map(l => l.trim()).filter(Boolean));
  // ➤ Read and write INSIDE the lock. Re-reading late already meant this could
  // ➤ not overwrite a change made while the HTTP checks ran, but it did not
  // ➤ stop the reverse: a "seen" arriving between this read and this write was
  // ➤ erased. Measured: eight concurrent read-modify-writes kept 200 lines of
  // ➤ 1600. The lock is held for these two lines, not for the minutes before.
  return withFileLock(path, () => {
    const fresh = readFileSync(path, 'utf-8').split('\n');
    const kept = fresh.filter(l => !drop.has(l.trim()));
    writeFileAtomic(path, kept.join('\n'));
    // ➤ How many of our decisions no longer applied (the line had already been
    // ➤ marked or removed by you in the meantime).
    return (fresh.length - kept.length);
  });
}

// ➤ ── THE BRAKE ON A MASS DELETE ──────────────────────────────────────────
// ➤ Deleting here is PERMANENT: the link goes to the anti-repeat history and
// ➤ the scanner will never propose that job again. "Dead" is decided from a
// ➤ single HTTP answer, and some of those answers (a 403 while a portal blocks
// ➤ us, a 404 from a site that is down, our own rate-limiting) mean "not right
// ➤ now", not "withdrawn". When MOST of the list dies at once, that is a portal
// ➤ or network problem, not a dozen companies closing their vacancies in the
// ➤ same minute — so nothing is deleted and the next run re-checks.
// ➤ EXPORTED, and used by BOTH delete paths (audit 2026-07-31). It used to be a
// ➤ local inside the daily check only: the Sunday full clean-up deletes strictly
// ➤ more and had no brake at all. Measured against a portal answering 404 to
// ➤ everything, the daily run stopped with 14 offers intact and the weekly run,
// ➤ seconds later, left 0.
// ➤ NO FLOOR ON THE LIST SIZE. The old version only protected lists of 5 or
// ➤ more, which had it exactly backwards: a short list is where losing
// ➤ everything hurts most, and "3 of 3 died in the same second" is just as
// ➤ TWO WAYS TO TRIGGER, because a ratio alone gets it wrong at both ends.
// ➤ A ratio with no floor made an ordinary short list impossible to clean: one
// ➤ genuinely withdrawn offer out of two is half of them, so the brake fired
// ➤ every single run and the dead link stayed for ever. A count alone would
// ➤ miss "everything died at once" on a small list.
// ➤ So: five or more dead AND at least half — many at once is an outage
// ➤ whatever the list size — OR every single one dead, from three up, which
// ➤ cannot be a coincidence either. One or two dead links get deleted, which
// ➤ is what they are for.
export function looksLikeAnOutage(pendingCount, deadCount) {
  if (pendingCount <= 0 || deadCount <= 0) return false;
  const half = deadCount >= Math.ceil(pendingCount * 0.5);
  return (deadCount >= 5 && half) || (deadCount === pendingCount && deadCount >= 3);
}


// ➤ The key that decides two postings are THE SAME job — and therefore that
// ➤ one of them gets deleted. Exported so the rule can be tested: it already
// ➤ went wrong once (see below) and nothing stopped it coming back.
export function fuzzyKey(company, title) {
  // ➤ (2026-07-19) the gender-tag separator can be a space: "(x w m)".
  const norm = s => String(s).toLowerCase()
    .replace(/\(\s*(?:(?:m|w|f|d|x|h|v)(?:\s*[/|,.]?\s*(?:m|w|f|d|x|h|v))+|all\s*genders?|gn)\s*\)/gi, ' ')
    .replace(/\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%|\b\d{2,3}\s*%/g, ' ')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[\s,.;:-]+$/, '').trim();
  // ➤ FIXED 2026-07-25 (audit): it used to keep only the FIRST word of the
  // ➤ company, so "Royal IHC" and "Royal Niestern Sander" shared one key and a
  // ➤ genuine second vacancy was deleted as a duplicate.
  const c = norm(company)
    .replace(/\s+(?:group|holding|nederland|netherlands|belgium|belgi[eë]|espa[ñn]a|france|deutschland|bv|b\.v\.|nv|n\.v\.|sa|s\.a\.|sl|s\.l\.|gmbh|ag|ltd|limited|inc|srl|spa)\b.*$/i, '')
    .trim() || '';
  return `${c}::${norm(title)}`;
}

// Oracle/Workday job pages are SPAs that answer 200 even for withdrawn
// postings ("the link doesn't work" — the user, 2026-07-06, on a filled DNV role).
// Their APIs do tell the truth, so ask them directly.

// ➤ Requests data from a site in JSON format (structured data) with a cap of
// ➤ 12 seconds so it doesn't hang waiting.
async function fetchJsonQuick(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

// ➤ Is an Oracle-portal offer dead? Instead of looking at the page
// ➤ (which always answers "all good"), it asks its data service directly:
// ➤ if the offer no longer appears there, it's dead.
async function isDeadOracle(url) {
  // ➤ Checks the URL is from Oracle and extracts the portal and the offer number.
  const m = url.match(/^https:\/\/([^/]+oraclecloud\.com)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/requisitions\/preview\/(\d+)/);
  if (!m) return null; // not oracle
  try {
    const { json } = await fetchJsonQuick(
      `https://${m[1]}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&finder=ById;Id=%22${m[3]}%22,siteNumber=%22${m[2]}%22`);
    if (!json) return false;           // API hiccup → keep the offer
    return (json.items || []).length === 0; // gone from the ATS = dead
  } catch { return false; }
}

// ➤ Same for Workday: it asks its data service; if it answers "doesn't
// ➤ exist" (404 or 403) or brings no offer detail, then it's closed.
// ➤ VERIFIED LIVE 2026-07-18: Workday answers 403 "permission denied"
// ➤ for WITHDRAWN offers (even a real browser gets 403 and shows
// ➤ "the page you are looking for doesn't exist"), and plain 200 for the
// ➤ live ones. Before, the 403 was read as "live" → the dead Fugro ones stayed
// ➤ in the list forever (the user's 4 "the link doesn't work", jul 16-17).
async function isDeadWorkday(url) {
  // ➤ Checks the URL is from Workday and extracts company, data center and path.
  const m = url.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/en-US\/([^/]+)(\/.+)$/);
  if (!m) return null; // not workday
  try {
    const { status, json } = await fetchJsonQuick(
      `https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}${m[4]}`);
    if (status === 404 || status === 403) return true;
    if (!json) return false;
    return !json.jobPostingInfo;       // detail without posting info = closed
  } catch { return false; }
}

// ➤ Is an Adzuna offer dead? Pipeline URLs come as /details/{id} OR as
// ➤ /land/ad/{id}, and that second form is a redirect to an external board
// ➤ that answers 200 forever — 15 dead offers slipped past the daily check
// ➤ that way (2026-07-10). So it always checks /details/{id}, which is the
// ➤ truth: verified live, a dead ad gives 404 and a live one 200.
async function isDeadAdzuna(url) {
  // ➤ Checks the URL is from Adzuna (in either of its two formats) and pulls out country and identifier.
  const m = url.match(/^https:\/\/www\.adzuna\.([a-z.]+)\/(?:details|land\/ad)\/(\d+)/);
  if (!m) return null; // not adzuna
  const res = await politeFetch('adzuna', `https://www.adzuna.${m[1]}/details/${m[2]}`, { redirect: 'follow' });
  if (!res) return false; // inconclusive (rate-limited/network) → keep
  return res.status === 404 || res.status === 410;
}

// ➤ Is it dead on LinkedIn? Closed offers keep answering "all
// ➤ good", so it looks for the text "No longer accepting applications" in the public version.
async function isDeadLinkedIn(url) {
  const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
  if (!m) return null; // not linkedin
  const res = await politeFetch('linkedin', `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`);
  if (!res) return false; // inconclusive → keep
  if (res.status === 404) return true;
  if (!res.ok) return false; // never kill on non-OK
  try {
    return (await res.text()).includes('No longer accepting applications');
  } catch { return false; }
}

// ➤ The final judge: decides whether an offer is dead. It first tries each
// ➤ portal's specific method and, if the URL is from none of them, it downloads
// ➤ the page and analyzes it generically. It's conservative: when in doubt, kept.
async function isLikelyDead(url) {
  const oracle = await isDeadOracle(url);
  if (oracle !== null) return oracle;
  const workday = await isDeadWorkday(url);
  if (workday !== null) return workday;
  const adzuna = await isDeadAdzuna(url);
  if (adzuna !== null) return adzuna;
  const linkedin = await isDeadLinkedIn(url);
  if (linkedin !== null) return linkedin;
  // ➤ No known portal: download the page as-is and analyze its content.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    let body = '';
    try { body = (await res.text()).slice(0, 20_000); } catch {}
    clearTimeout(timer);
    // ➤ Classifier verdict + anti-false-dead second opinion (caught
    // ➤ 2026-07-18): if the "expired" comes only from a phrase in the text and the
    // ➤ page still has an apply button, it's considered live (see scan.mjs).
    const { result, reason } = overrideDeadIfApply(
      classifyLiveness({ status: res.status, finalUrl: res.url, bodyText: body }), body);
    // ➤ Only marks it dead if the analysis says "expired" and there was enough content to trust it.
    return result === 'expired' && !reason.includes('insufficient content');
  } catch {
    return false;
  }
}

// ➤ ── Re-fetching the offers' text ─────────────────────────────────────────
// ➤ The years-of-experience filter needs the full text of each offer, and the
// ➤ list only stores the URL: these functions recover it.
// ➤ Browser identification: the bot presents itself as a normal Chrome so sites don't reject it.
const DESC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ➤ Polite download: leaves a gap between requests to the same portal and, if
// ➤ the portal answers "too many requests" (429), waits and retries. Still
// ➤ limited → returns "I don't know", never "dead". THE RULE: never conclude
// ➤ anything from a 429. Adzuna throttled us after a day's sweeps, the check
// ➤ read that as "alive", and a dead offer (#61) reached the phone. Tomorrow's
// ➤ cron retries with fresh quota.
const HOST_GAP_MS = { 'adzuna': 1500, 'linkedin': 1200 };
const hostLast = new Map();
async function politeFetch(hostKey, url, opts = {}) {
  const gap = HOST_GAP_MS[hostKey] || 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    // ➤ If the minimum gap since the last request to this portal hasn't passed yet, wait.
    const wait = (hostLast.get(hostKey) || 0) + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    hostLast.set(hostKey, Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': DESC_UA, ...(opts.headers || {}) } });
      // ➤ "Too many requests": penalizes the whole portal with an 8-second wait and retries.
      if (res.status === 429) {
        // ➤ 15 s penalty after a 429, same as scan.mjs (audit 2026-07-25): the
        // ➤ fix was applied there in July but this copy kept the old 8 s, so the
        // ➤ retries here still died inside the same rate-limit window.
        hostLast.set(hostKey, Date.now() + 15_000); // back off the whole host
        continue;
      }
      return res;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null; // still rate-limited → inconclusive
}

// ➤ Downloads a page's text with a 12-second cap; if it fails, returns empty.
async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res.ok ? await res.text() : '';
  } catch { return ''; } finally { clearTimeout(timer); }
}

// ➤ Recovers an offer's full text from its URL alone, depending on the
// ➤ portal (Workday, Oracle, LinkedIn or Adzuna). If it can't, it returns empty
// ➤ and the offer is kept unfiltered.
// ➤ Adzuna URLs where the CLEAN description (without menus) was obtained:
// ➤ only on those is it safe to check the body language.
const adzunaJdClean = new Set();

async function fetchDescriptionByUrl(url) {
  try {
    // ➤ Is it a Workday URL? Request the detail from its data service.
    let m = url.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/en-US\/([^/]+)(\/.+)$/);
    if (m) {
      const { json } = await fetchJsonQuick(`https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}${m[4]}`);
      return stripHtml(json?.jobPostingInfo?.jobDescription || '');
    }
    // ➤ Is it from Oracle? Request the detail and join its sections (requirements, responsibilities, description).
    m = url.match(/^https:\/\/([^/]+oraclecloud\.com)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/requisitions\/preview\/(\d+)/);
    if (m) {
      const { json } = await fetchJsonQuick(
        `https://${m[1]}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
        + `?onlyData=true&finder=ById;Id=%22${m[3]}%22,siteNumber=%22${m[2]}%22`);
      const it = json?.items?.[0] || {};
      return stripHtml([
        it.ExternalQualificationsStr, it.ExternalResponsibilitiesStr,
        it.ExternalDescriptionStr, it.CorporateDescriptionStr,
      ].filter(Boolean).join(' '));
    }
    // ➤ Is it from LinkedIn? Download the public version of the offer.
    m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
    if (m) {
      const res = await politeFetch('linkedin', `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`);
      return res && res.ok ? stripHtml(await res.text()) : '';
    }
    // ➤ Is it from Adzuna? Download the details page itself and try to extract
    // ➤ the CLEAN region of the description (adp-body). If obtained, the
    // ➤ URL is noted in adzunaJdClean: with clean text the body LANGUAGE can
    // ➤ also be checked (before, Adzuna was blind and French offers
    // ➤ piled up — 10 rejections from the user, 2026-07-13).
    if (/(^|\.)adzuna\.[a-z.]+\//.test(url)) {
      const res = await politeFetch('adzuna', url, { redirect: 'follow' });
      if (!res || !res.ok) return '';
      const html = await res.text();
      const jd = extractAdzunaJd(html);
      if (jd) { adzunaJdClean.add(url); return jd; }
      return stripHtml(html);
    }
    return '';
  } catch { return ''; }
}

// ➤ Small helper: runs a list of tasks concurrently but with a cap on how many
// ➤ run at once, so as not to overload the sites or the server.
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

// ➤ ─────────────────── MAIN PROCESS, top to bottom ──────────────────────────
async function main() {
  // ➤ With --dry-run it only reports what it would do, without touching the file.
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(PIPELINE_PATH)) { console.log('pipeline.md not found'); return; }

  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');

  // ➤ Goes through pipeline.md and notes each pending offer (lines "- [ ]") from
  // ➤ the pending section, with its URL, company and title.
  let inPending = false;
  const pending = []; // {lineIdx, url, company, title, location}
  for (let i = 0; i < lines.length; i++) {
    if (isPendingHeading(lines[i])) { inPending = true; continue; }
    if (lines[i].startsWith('## ') && inPending) inPending = false;
    if (!inPending) continue;
    // ➤ Splits the offer line: link | company | title | [location] | [y:N] |
    // ➤ [s:salary] | #id.
    // ➤ THE LOCATION IS READ TOO (audit 2026-07-31). It used to be thrown away
    // ➤ with everything after the title, so the weekly re-check could not apply
    // ➤ the geography rule at all: a country you had since switched off stayed
    // ➤ in your list for ever. It is the first trailing field that is not one of
    // ➤ the tagged ones, which is exactly how the scanner writes it.
    const m = lines[i].match(/^- \[ \] (\S+)\s*\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)(\s*\|[^\n]*)?$/);
    if (!m) continue;
    const trailing = (m[4] || '').split('|').map(s => s.trim()).filter(Boolean);
    const location = trailing.find(f => !/^y:/i.test(f) && !/^s:/i.test(f) && !/^#\d+$/.test(f) && !/^visto$/i.test(f)) || '';
    pending.push({ lineIdx: i, url: m[1], company: m[2].trim(), title: m[3].trim(), location });
  }

  if (pending.length === 0) { console.log('Nothing pending — pipeline clean.'); return; }

  // ➤ DAILY MODE (--liveness-only), asked for on 2026-07-08: "the bot will
  // ➤ have to verify DAILY that the links work and that the offer hasn't been
  // ➤ removed". It runs ONLY the dead/withdrawn check — Oracle API count=0,
  // ➤ Workday with no jobPostingInfo, HTTP 404/410, or "expired" text — over
  // ➤ every pending offer, and deletes the dead ones. No re-filtering and no
  // ➤ dedup: that stays in the weekly full run. Cheap enough for a daily cron.
  // ── Daily link check (--liveness-only) ─────────────────────────────
  if (process.argv.includes('--liveness-only')) {
    const deadIdx = new Set();
    const checks = pending.map(p => async () => {
      if (await isLikelyDead(p.url)) deadIdx.add(p.lineIdx);
    });
    await parallel(checks, LIVENESS_CONCURRENCY);
    // ➤ The brake on a mass delete — see looksLikeAnOutage above.
    if (looksLikeAnOutage(pending.length, deadIdx.size)) {
      console.log(`Link check ABORTED: ${deadIdx.size} of ${pending.length} pending offers came back "dead" in one run.`);
      console.log('That looks like a portal or network problem, not real withdrawals. Nothing was deleted; it will be re-checked next run.');
      return;
    }
    if (!dryRun && deadIdx.size) {
      // ➤ DELETES the line of each dead offer (before it was hidden with [x];
      // ➤ 2026-07-18: that's noise), first leaving its URL in scan-history.
      ensureInHistory(pending.filter(p => deadIdx.has(p.lineIdx)), 'dead');
      rewritePipelineWithout(lines.filter((_, i) => deadIdx.has(i)));
    }
    console.log(`Link check — ${new Date().toISOString().slice(0, 10)}${dryRun ? ' (dry run)' : ''}`);
    console.log(`Pending checked:       ${pending.length}`);
    console.log(`Dead/withdrawn removed: ${deadIdx.size}`);
    for (const p of pending) if (deadIdx.has(p.lineIdx)) console.log(`  dead ${p.company} — ${p.title}`);
    // ➤ The pending list changed on disk, so the list on your phone is stale:
    // ➤ redraw it (silently — this is housekeeping, not a new offer).
    if (!dryRun && deadIdx.size) { try { await refreshList({ alert: false }); } catch {} }
    return;
  }

  // ➤ From here on, the full WEEKLY CLEANUP, in 4 steps.
  // ➤ Step 0: re-applies the CURRENT title and location filters to what's already
  // ➤ saved, in case the rules have changed since the offer came in.
  const filteredIdx = new Set();
  let config = {};
  if (existsSync(PORTALS_PATH)) {
    config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    // ➤ SAME RULES AS THE SCANNER (audit 2026-07-25): housekeep used to read only
    // ➤ portals.yml while scan.mjs prefers config/profile.yml, so after editing
    // ➤ your profile the scan admitted offers under the new rule and the Sunday
    // ➤ cleanup deleted them under the old one.
    const titleOk = buildTitleFilter({
      positive: searchProfile.positive_titles || (config.title_filter || {}).positive,
      negative: searchProfile.negative_titles || (config.title_filter || {}).negative,
    });
    const locFilter = buildLocationFilter(searchProfile.locations || config.location_filter);
    // ➤ The company blacklist is also re-applied here: if you veto a
    // ➤ company, its already-saved offers fall in the next cleanup.
    const companyOk = buildCompanyFilter(config.company_filter);
    // ➤ GEOGRAPHY IS CHECKED ON BOTH HALVES, like the scanner (audit
    // ➤ 2026-07-31). Only the TITLE was being tested here, so the offer's actual
    // ➤ LOCATION was never re-checked and a country you switched off after the
    // ➤ offer arrived kept it in your list for ever. The title check stays as
    // ➤ well, because multi-location postings hide the country there
    // ➤ ("Graduate Programme - Qatar").
    for (const p of pending) {
      if (!companyOk(p.company) || !titleOk(p.title)
          || (p.location && !locFilter(p.location)) || locFilter.blockHit(p.title)
          || titleDemandsForeignLanguage(p.title)) {
        filteredIdx.add(p.lineIdx);
      }
    }
  }

  // ➤ Step 0b: TITLE language filter — hides offers whose title is in a
  // ➤ language the user can't work in (allows English/Spanish/Catalan).
  const langCfg = config.title_language_filter || {};
  if (langCfg.enabled !== false) {
    const allow = new Set((langCfg.allow || ['en', 'es', 'ca']).map(s => String(s).toLowerCase()));
    const candidates = pending.filter(p => !filteredIdx.has(p.lineIdx));
    const checks = candidates.map(p => async () => {
      const lang = await detectTitleLang(p.title);
      if (lang && !allow.has(lang)) filteredIdx.add(p.lineIdx);
    });
    await parallel(checks, 5);
  }

  // ➤ Step 0c: EXPERIENCE and DEGREE filter — re-downloads the text of each
  // ➤ offer and hides the ones asking for more years than configured or requiring
  // ➤ a degree the user doesn't have. With the same text, the nuanced language
  // ➤ rule (2026-07-18): it doesn't matter which language the offer is
  // ➤ WRITTEN in; it's only hidden if the body REQUIRES a language the user does not speak.
  const expIdx = new Set();
  const degIdx = new Set();
  const langIdx = new Set();
  const expCfg = config.experience_filter || {};
  // ➤ The years threshold comes from the profile first, like the scanner.
  const expMax = Number.isFinite(searchProfile.max_years) ? searchProfile.max_years
    : (Number.isFinite(expCfg.max_years) ? expCfg.max_years : 4);
  const hkLangCfg = config.title_language_filter || {};
  if (expCfg.enabled !== false) {
    const candidates = pending.filter(p => !filteredIdx.has(p.lineIdx));
    const checks = candidates.map(p => async () => {
      const desc = await fetchDescriptionByUrl(p.url);
      // ➤ Experience verdict: how many years they ask for AND in what field — same
      // ➤ as in the scanner (2 years "in a similar role" of PLC are discarded).
      const verdict = experienceScreen(`${p.title || ''}. ${desc}`, p.title, expMax);
      // ➤ OrcaFlex exception (2026-07-11): if it mentions OrcaFlex, it's kept
      // ➤ even if it asks for more years — it's the user's star tool.
      const priority = PRIORITY_KEEP.test(`${p.title || ''} ${desc}`);
      if (verdict && verdict.drop && !priority) { filteredIdx.add(p.lineIdx); expIdx.add(p.lineIdx); p._years = verdict.years; return; }
      // ➤ DEGREE requirement in the body (2026-07-16): master's/degree in
      // ➤ a field the user doesn't have → out (same as in the scanner).
      if (!priority && desc && degreeScreen(desc, p.title)) { filteredIdx.add(p.lineIdx); degIdx.add(p.lineIdx); return; }
      // ➤ Does the body REQUIRE a language the user doesn't speak? → hidden. (On
      // ➤ Adzuna only with the clean description: the whole page carries menus
      // ➤ in the country's language and would give false positives.)
      if (hkLangCfg.enabled !== false && desc && (!/adzuna\./.test(p.url) || adzunaJdClean.has(p.url))) {
        if (bodyLanguageBlock(desc)) { filteredIdx.add(p.lineIdx); langIdx.add(p.lineIdx); }
      }
    });
    await parallel(checks, 5);
  }

  // ➤ Step 1: DUPLICATES — if two offers have the same clean link or the
  // ➤ same company+title fingerprint, the first is kept and the rest hidden.
  const seenUrl = new Set();
  const seenRole = new Set();
  const dupIdx = new Set();
  // ➤ KEEP THE NEWEST (audit 2026-07-25). It used to keep the FIRST occurrence,
  // ➤ i.e. the oldest line — and when a company re-posts a vacancy under a new
  // ➤ link, the old one is precisely the one about to be deleted as dead in
  // ➤ step 2, so the role vanished completely. We walk backwards instead.
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (filteredIdx.has(p.lineIdx)) continue;
    const u = normUrl(p.url);
    const k = fuzzyKey(p.company, p.title);
    if (seenUrl.has(u) || seenRole.has(k)) { dupIdx.add(p.lineIdx); continue; }
    seenUrl.add(u);
    seenRole.add(k);
  }

  // ➤ Step 2: DEAD LINKS — checks only the offers that survived the
  // ➤ previous steps (so as not to spend requests on the already-discarded ones).
  const survivors = pending.filter(p => !dupIdx.has(p.lineIdx) && !filteredIdx.has(p.lineIdx));
  const deadIdx = new Set();
  const checks = survivors.map(p => async () => {
    if (await isLikelyDead(p.url)) deadIdx.add(p.lineIdx);
  });
  await parallel(checks, LIVENESS_CONCURRENCY);
  // ➤ THE SAME BRAKE AS THE DAILY CHECK (audit 2026-07-31). This path deletes
  // ➤ strictly more than the daily one and had no brake at all: with a portal
  // ➤ answering 404 to everything, the daily run stopped with the list intact
  // ➤ and this one, seconds later, emptied it. Only the DEAD verdicts are
  // ➤ dropped — the filtered and duplicate ones are decided from text we
  // ➤ already hold, so a network problem cannot make them wrong.
  let deadAborted = 0;
  if (looksLikeAnOutage(survivors.length, deadIdx.size)) {
    deadAborted = deadIdx.size;
    deadIdx.clear();
    console.log(`Link check ABORTED: ${deadAborted} of ${survivors.length} offers came back "dead" in one run.`);
    console.log('That looks like a portal or network problem, not real withdrawals. No link was deleted for being dead; the rest of the clean-up continues.');
  }

  // ➤ Final step: prepares the summary and, unless it's a dry run, DELETES from
  // ➤ the file all the filtered/duplicate/dead ones (before they were hidden with
  // ➤ [x]; 2026-07-18: that's noise). Their URLs remain in scan-history.
  let report = [];
  for (const p of pending) {
    if (expIdx.has(p.lineIdx)) report.push(`  exp  ${p.company} — ${p.title} (${p._years}yr req)`);
    else if (degIdx.has(p.lineIdx)) report.push(`  degr ${p.company} — ${p.title} (degree the candidate doesn't have)`);
    else if (langIdx.has(p.lineIdx)) report.push(`  lang ${p.company} — ${p.title} (body REQUIRES a language the user does not speak)`);
    else if (filteredIdx.has(p.lineIdx)) report.push(`  filt ${p.company} — ${p.title}`);
    else if (dupIdx.has(p.lineIdx)) report.push(`  dup  ${p.company} — ${p.title}`);
    else if (deadIdx.has(p.lineIdx)) report.push(`  dead ${p.company} — ${p.title}`);
  }
  if (!dryRun) {
    const gone = new Set([...filteredIdx, ...dupIdx, ...deadIdx]);
    if (gone.size) {
      ensureInHistory(pending.filter(p => filteredIdx.has(p.lineIdx)), 'filtered');
      ensureInHistory(pending.filter(p => dupIdx.has(p.lineIdx)), 'dup');
      ensureInHistory(pending.filter(p => deadIdx.has(p.lineIdx)), 'dead');
      rewritePipelineWithout(lines.filter((_, i) => gone.has(i)));
      // ➤ The pending list changed, so redraw it on Telegram (silently).
      try { await refreshList({ alert: false }); } catch {}
    }
  }

  // ➤ On-screen summary: how many were checked, how many were hidden and for what reason.
  const hidden = filteredIdx.size + dupIdx.size + deadIdx.size;
  console.log(`Housekeep — ${new Date().toISOString().slice(0, 10)}${dryRun ? ' (dry run)' : ''}`);
  console.log(`Pending checked: ${pending.length}`);
  console.log(`Filtered out (current rules): ${filteredIdx.size - expIdx.size - degIdx.size - langIdx.size}`);
  console.log(`Experience-filtered (>${expMax}yr): ${expIdx.size}`);
  console.log(`Degree-filtered (body): ${degIdx.size}`);
  console.log(`Language-required (body): ${langIdx.size}`);
  console.log(`Duplicates removed: ${dupIdx.size}`);
  // ➤ If the brake fired, say so here too — a plain "0 removed" would read as
  // ➤ "every link is alive", which is the opposite of what happened.
  console.log(`Dead links removed: ${deadIdx.size}${deadAborted ? ` (${deadAborted} looked dead but the check was aborted as an outage)` : ''}`);
  console.log(`Still pending: ${pending.length - hidden}`);
  if (report.length) console.log(report.join('\n'));
}

// ➤ Starts the process; if something fails completely, it prints the error and signals the system (exit code 1).
// ➤ GUARD 2026-07-25 (audit): main() DELETES pending offers, and it used to run
// ➤ just by importing this file — so any tool that imported it would silently
// ➤ start deleting. It now only runs when launched directly, like scan.mjs.
if (process.argv[1] && /(^|[\\/])housekeep\.mjs$/.test(process.argv[1])) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
