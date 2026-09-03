// ➤ The walk from an aggregator's "apply" bounce to the page that holds the advert,
// ➤ replayed against canned pages so no network is touched: each rule learned on the real
// ➤ chains of 2026-09-03 has a case here.
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { harness } from './test-harness.mjs';
import { classifyHost, landLinkFrom, stripTracking, nextHop, titleMatches, resolveRoot, viaFor } from './root-link.mjs';

const { ok, eq, done } = harness('root-link');

// ── Who is who ──────────────────────────────────────────────────────────
eq(classifyHost('www.adzuna.es'), 'aggregator', 'Adzuna re-posts');
eq(classifyHost('www.buscojobs.com.es'), 'aggregator', 'and so does BuscoJobs');
eq(classifyHost('click.appcast.io'), 'tracker', 'Appcast counts clicks');
eq(classifyHost('tag.goldenbees.fr'), 'tracker', 'Goldenbees too');
eq(classifyHost('click.jobroute.io'), 'tracker', 'and Jobroute');
eq(classifyHost('myprivacy.dpgmedia.nl'), 'consent', 'DPG Media parks readers on a cookie wall');
eq(classifyHost('www.stepstone.de'), 'page', 'a board hosts the advert');
eq(classifyHost('www.adecco.com'), 'page', 'an agency hosts the advert');
eq(classifyHost('werkenbijdefensie.nl'), 'page', 'an employer hosts the advert');
eq(classifyHost('place-ep-recrute.talent-soft.com'), 'page', 'an ATS hosts the advert');

// ── The bounce hidden in an Adzuna page ─────────────────────────────────
eq(landLinkFrom('<a class="apply" href="/land/ad/5868545078?se=abc&amp;v=1">Apply</a>', 'https://www.adzuna.es/details/5868545078'),
  'https://www.adzuna.es/land/ad/5868545078?se=abc&v=1', 'a relative bounce is made absolute and its entities decoded');
eq(landLinkFrom('href="https://www.adzuna.fr/land/ad/1?x=1"', 'https://www.adzuna.fr/details/1'), 'https://www.adzuna.fr/land/ad/1?x=1', 'an absolute one is kept');
eq(landLinkFrom('<p>no apply button here</p>', 'https://www.adzuna.fr/details/1'), null, 'no bounce, no link');

// ── The campaign tail ───────────────────────────────────────────────────
eq(stripTracking('https://www.meteojob.com/jobs/56485647?utm_source=adzuna&utm_medium=aggregator-paid&utm_campaign=cdi'), 'https://www.meteojob.com/jobs/56485647', 'utm_* goes, and no dangling "?"');
eq(stripTracking('https://www.stepstone.be/offres-d-emploi----2214476-inline.html?cid=partner_adzuna___fr&utm_source=adzuna'), 'https://www.stepstone.be/offres-d-emploi----2214476-inline.html', 'StepStone\'s partner cid goes');
eq(stripTracking('https://jobs.example.com/view?id=42&cid=7#top'), 'https://jobs.example.com/view?id=42&cid=7', 'a meaningful id and a non-partner cid stay; the fragment goes');
eq(stripTracking('not a url'), 'not a url', 'garbage is returned untouched');
eq(stripTracking('https://jobs.hgg.nl/o/commissioning-engineer-5?source=Adzuna'), 'https://jobs.hgg.nl/o/commissioning-engineer-5', 'a "source" that names the aggregator goes (seen on a real Recruitee page)');
eq(stripTracking('https://shop.example.com/jobs/1?source=internal'), 'https://shop.example.com/jobs/1?source=internal', 'a "source" that names something else stays');
eq(stripTracking('https://www.xing.com/jobs/kiel-naval-156962094?sc_cmp=par068cbd0d&ppt=eyJhbGciOiJIUzI1NiJ9.eyJjbGlja19pZCI6Inl.abc'), 'https://www.xing.com/jobs/kiel-naval-156962094', 'XING\'s campaign code and signed click receipt go');
eq(stripTracking('https://ats.example.com/job/7?token=eyJhbGciOiJIUzI1NiJ9.payload.sig&id=7'), 'https://ats.example.com/job/7?id=7', 'any signed-token value is a receipt, whatever its name');

// ── Where a page sends the reader next ──────────────────────────────────
eq(nextHop('<meta http-equiv="refresh" content="0;url=https://www.apec.fr/candidat/offre/123.html">', 'https://www.adzuna.fr/land/ad/1'),
  'https://www.apec.fr/candidat/offre/123.html', 'a meta refresh to another site');
eq(nextHop('<script>window.location.href="https://www.apec.fr/";</script>', 'https://www.apec.fr/candidat/offre/123.html'), null, 'a same-site script jump is ignored (it is a cookie script or a homepage)');
eq(nextHop('<script>location.replace("/fr")</script>', 'https://www.xing.com/jobs/1'), null, 'a relative same-site jump too');
eq(nextHop('<p>plain page</p>', 'https://www.stepstone.de/x'), null, 'a page that stays put');

// ── Does the page speak of the advert ───────────────────────────────────
ok(titleMatches('<h1>Werkvoorbereider Offshore (Hoofddorp)</h1>', 'Werkvoorbereider Offshore'), 'the title\'s long words are on the page');
ok(!titleMatches('<h1>Welcome to our homepage</h1>', 'Werkvoorbereider Offshore'), 'a homepage does not carry them');
ok(titleMatches('<h1>Ingénieur études</h1>', 'Ingenieur Etudes'), 'accents do not get in the way');
ok(titleMatches('anything', 'PLC'), 'a title with no long word cannot be checked, so it passes');

// ── The walk itself, against canned pages ───────────────────────────────
const pages = {
  // ➤ 1. Adzuna → meta refresh → the board's page: the common case.
  'https://www.adzuna.de/land/ad/1': { url: 'https://www.adzuna.de/land/ad/1', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://www.stepstone.de/stellenangebote--Automation-Engineer--1.html?cid=partner_adzuna">' },
  'https://www.stepstone.de/stellenangebote--Automation-Engineer--1.html?cid=partner_adzuna': { url: 'https://www.stepstone.de/stellenangebote--Automation-Engineer--1.html?cid=partner_adzuna', status: 200, html: '<h1>Automation Engineer (m/w/d)</h1><script>location.href="https://www.stepstone.de/"</script>' },
  // ➤ 2. A cookie wall keeps the real address in callbackUrl.
  'https://www.adzuna.nl/land/ad/2': { url: 'https://myprivacy.dpgmedia.nl/consent?siteKey=x&callbackUrl=https%3A%2F%2Fwww.nationalevacaturebank.nl%2Fvacature%2F99%2Fservice-engineer-offshore', status: 200, html: '<p>cookies</p>' },
  'https://www.nationalevacaturebank.nl/vacature/99/service-engineer-offshore': { url: 'https://www.nationalevacaturebank.nl/vacature/99/service-engineer-offshore', status: 200, html: '<h1>Service Engineer Offshore</h1>' },
  // ➤ 3. A tracker guarded by a captcha.
  'https://www.adzuna.fr/land/ad/3': { url: 'https://www.adzuna.fr/land/ad/3', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://click.appcast.io/t/abc">' },
  'https://click.appcast.io/t/abc': { url: 'https://click.appcast.io/t/abc', status: 403, html: '<p>Please enable JS</p>' },
  // ➤ 4. An aggregator that hides its source.
  'https://www.adzuna.es/land/ad/4': { url: 'https://www.adzuna.es/land/ad/4', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://www.buscojobs.com.es/ingeniero-ID-1">' },
  'https://www.buscojobs.com.es/ingeniero-ID-1': { url: 'https://www.buscojobs.com.es/ingeniero-ID-1', status: 200, html: '<h1>Ingeniero</h1><a href="/login">Postularme</a>' },
  // ➤ 5. The board bounced to its homepage (advert gone).
  'https://www.adzuna.fr/land/ad/5': { url: 'https://www.adzuna.fr/land/ad/5', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://emploi.ouest-france.fr/offre/777">' },
  'https://emploi.ouest-france.fr/offre/777': { url: 'https://emploi.ouest-france.fr/', status: 200, html: '<h1>Toutes les offres</h1>' },
  // ➤ 6. The page is there but speaks of another job.
  'https://www.adzuna.de/land/ad/6': { url: 'https://www.adzuna.de/land/ad/6', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://www.kununu.com/de/job/abc">' },
  'https://www.kununu.com/de/job/abc': { url: 'https://www.kununu.com/de/job/abc', status: 200, html: '<h1>Diese Stelle ist nicht mehr verfügbar</h1>' },
  // ➤ 7. Adzuna itself hosts the advert: the bounce comes back to Adzuna.
  'https://www.adzuna.es/land/ad/7': { url: 'https://www.adzuna.es/land/ad/7', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://www.adzuna.es/details/7">' },
  'https://www.adzuna.es/details/7': { url: 'https://www.adzuna.es/details/7', status: 200, html: '<h1>Naval Architect</h1>' },
  // ➤ 8. A tracker that does bounce on, then the ATS page.
  'https://www.adzuna.be/land/ad/8': { url: 'https://www.adzuna.be/land/ad/8', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://tag.goldenbees.fr/c/xyz">' },
  'https://tag.goldenbees.fr/c/xyz': { url: 'https://tag.goldenbees.fr/c/xyz', status: 200, html: '<script>window.location.href="https://recrute.example-ats.com/job/instrumentation-engineer-42?utm_source=goldenbees"</script>' },
  'https://recrute.example-ats.com/job/instrumentation-engineer-42?utm_source=goldenbees': { url: 'https://recrute.example-ats.com/job/instrumentation-engineer-42?utm_source=goldenbees', status: 200, html: '<h1>Instrumentation Engineer</h1>' },
  // ➤ 9. A chain that never ends.
  'https://www.adzuna.fr/land/ad/9': { url: 'https://www.adzuna.fr/land/ad/9', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://click.jobroute.io/c/1">' },
  'https://click.jobroute.io/c/1': { url: 'https://click.jobroute.io/c/1', status: 200, html: '<meta http-equiv="refresh" content="0;url=https://www.adzuna.fr/land/ad/9">' },
};
const get = async u => { if (!(u in pages)) throw new Error(`unexpected fetch of ${u}`); return pages[u]; };
const walk = (n, title) => resolveRoot(`https://www.adzuna.${n}`, { get, title });

{
  const r = await walk('de/land/ad/1', 'Automation Engineer (m/w/d)');
  eq(r.root, 'https://www.stepstone.de/stellenangebote--Automation-Engineer--1.html', 'Adzuna → meta → board: the board page, without the partner tail');
  eq(r.hops, ['www.adzuna.de', 'www.stepstone.de'], 'two hops');
  eq(r.reason, 'page', 'and the same-site script jump on the board was not followed');
}
{
  const r = await walk('nl/land/ad/2', 'Service Engineer Offshore');
  eq(r.root, 'https://www.nationalevacaturebank.nl/vacature/99/service-engineer-offshore', 'a cookie wall is stepped over through callbackUrl');
  eq(r.hops, ['myprivacy.dpgmedia.nl', 'www.nationalevacaturebank.nl'], 'the wall counts as a hop');
}
{
  const r = await walk('fr/land/ad/3', 'Ingénieur');
  eq(r.root, null, 'a tracker that answers 403 resolves nothing');
  eq(r.reason, 'tracker answered 403', 'and says so');
}
{
  const r = await walk('es/land/ad/4', 'Ingeniero junior');
  eq([r.root, r.reason], [null, 'aggregator hides its source'], 'an aggregator with no way on is a dead end');
}
{
  const r = await walk('fr/land/ad/5', 'Technicien maintenance');
  eq([r.root, r.reason], [null, 'landed on a homepage'], 'a bounce to a homepage is not the advert');
}
{
  const r = await walk('de/land/ad/6', 'Projektingenieur Anlagenbau');
  eq([r.root, r.reason], [null, 'page does not mention the title'], 'a page about another job is not the advert');
}
{
  const r = await walk('es/land/ad/7', 'Naval Architect');
  eq([r.root, r.reason], [null, 'aggregator hides its source'], 'when Adzuna hosts the advert itself, the Adzuna link stays');
}
{
  const r = await walk('be/land/ad/8', 'Instrumentation Engineer');
  eq(r.root, 'https://recrute.example-ats.com/job/instrumentation-engineer-42', 'a tracker that bounces on is followed to the ATS page, tail stripped');
  eq(r.hops.length, 3, 'three hops');
}
{
  const r = await walk('fr/land/ad/9', 'x');
  eq([r.root, r.reason], [null, 'too many bounces'], 'a loop gives up');
}
{
  const r = await resolveRoot('https://www.adzuna.fr/land/ad/404', { get: async () => { throw new Error('ECONNRESET'); }, title: 'x' });
  eq(r.root, null, 'a network error resolves nothing');
  ok(/ECONNRESET/.test(r.reason), 'and the reason carries the error');
}

// ── The "via" column of the history ────────────────────────────────────
{
  const dir = join(tmpdir(), `argus-root-link-${process.pid}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const p = join(dir, 'scan-history.tsv');
  writeFileSync(p, [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    'https://www.adzuna.es/details/1\t2026-08-01\tadzuna\tOld offer\tAcme\tadded\tCadiz',
    'https://www.stepstone.de/job/2\t2026-09-03\tadzuna\tRooted offer\tAcme\tadded\tHamburg\thttps://www.adzuna.de/details/2',
    '',
  ].join('\n'));
  eq(viaFor('https://www.stepstone.de/job/2', p), 'https://www.adzuna.de/details/2', 'a rooted row gives back the aggregator link');
  eq(viaFor('https://www.stepstone.de/job/2/?utm_source=x', p), 'https://www.adzuna.de/details/2', 'tail and slash do not matter');
  eq(viaFor('https://www.adzuna.es/details/1', p), null, 'an old seven-column row has no via');
  eq(viaFor('https://nowhere.example/x', p), null, 'unknown link: nothing');
  eq(viaFor('https://www.stepstone.de/job/2', join(dir, 'missing.tsv')), null, 'no history yet: nothing, not a crash');
  rmSync(dir, { recursive: true, force: true });
}

done();
