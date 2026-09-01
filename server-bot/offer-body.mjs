// ➤ The text of an offer, fetched from wherever the board keeps it. Workday,
// ➤ Oracle, LinkedIn and Adzuna each have an API or a page section that holds
// ➤ the description alone; any other board hands over its whole page. Two
// ➤ readers drink from this — the letter writer and the Council — so it lives
// ➤ in a module of its own instead of inside the letter writer.
import { stripHtml, extractAdzunaJd } from './requirements.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
// ➤ Depending on the link's portal, it requests the offer text via the right route
// ➤ (Workday and Oracle have their own "data gateway"; LinkedIn has a public version;
// ➤ Adzuna is read from its details page). If nothing matches, it downloads the page as-is
// ➤ and strips the HTML. Returns { text, status }: the text, and the HTTP status of the
// ➤ request that decided it — 0 when no answer came at all (timeout, DNS, refused). The
// ➤ status matters to the Council: Adzuna answers a burst with 429 and CloudFront with
// ➤ 403, and an empty text that means "come back later" must not be judged like a page
// ➤ that has nothing to say.
export async function fetchOfferPage(url) {
  const get = (u, opts = {}) => fetch(u, { headers: { 'User-Agent': UA, ...(opts.json ? { Accept: 'application/json' } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  const page = (r, text) => ({ text: text || '', status: r.status });
  try {
    let m = url.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/en-US\/([^/]+)(\/.+)$/);
    if (m) {
      const r = await get(`https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}${m[4]}`, { json: true });
      const j = r.ok ? await r.json().catch(() => null) : null;
      return page(r, stripHtml(j?.jobPostingInfo?.jobDescription || ''));
    }
    m = url.match(/^https:\/\/([^/]+oraclecloud\.com)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/requisitions\/preview\/(\d+)/);
    if (m) {
      const r = await get(`https://${m[1]}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&finder=ById;Id=%22${m[3]}%22,siteNumber=%22${m[2]}%22`, { json: true });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const it = j?.items?.[0] || {};
      return page(r, stripHtml([it.ExternalQualificationsStr, it.ExternalResponsibilitiesStr, it.ExternalDescriptionStr, it.CorporateDescriptionStr].filter(Boolean).join(' ')));
    }
    m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
    if (m) {
      const r = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`);
      return page(r, r.ok ? stripHtml(await r.text()) : '');
    }
    if (/(^|\.)adzuna\.[a-z.]+\//.test(url)) {
      // ➤ If a /land/ad/ redirect arrives (old format), we read its
      // ➤ /details/ page — the one that has the offer text.
      const r = await get(url.replace(/\/land\/ad\/(\d+)\S*$/, '/details/$1'));
      if (!r.ok) return page(r, '');
      const html = await r.text();
      return page(r, extractAdzunaJd(html) || stripHtml(html));
    }
    // ➤ Any other portal (Greenhouse, Ashby, Lever...): the whole page.
    const r = await get(url);
    return page(r, r.ok ? stripHtml(await r.text()) : '');
  } catch { return { text: '', status: 0 }; }
}

// ➤ Just the text, for readers that do not care why it may be empty.
export async function fetchOfferBody(url) {
  return (await fetchOfferPage(url)).text;
}
