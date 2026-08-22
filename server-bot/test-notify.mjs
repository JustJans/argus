#!/usr/bin/env node

// ➤ ═══════════════════════════════════════════════════════════════════
// ➤ WHAT THIS FILE IS: the automated tests for the "messenger" (notify.mjs).
// ➤ They check that Telegram messages come out well-formed: clean titles,
// ➤ city only (no province/country), correct grouping by country, etc.
// ➤ Each test compares "what comes out" against "what should come out";
// ➤ if they don't match, it warns in red.
// ➤ WHEN IT'S USED: by hand, after touching notify.mjs:
// ➤    node server-bot/test-notify.mjs
// ➤ ═══════════════════════════════════════════════════════════════════

/**
 * test-notify.mjs — offline tests for the Telegram presentation layer
 * (title cleanup, city extraction, country grouping). Translation is
 * network-dependent and falls back gracefully, so it is not tested here.
 *
 * Run: node server-bot/test-notify.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { cleanTitle, compactTitle, cityOf, classifyLocation, loadCountryMatchers, urlGroupHint, esc, languageOfPlace, translateTitle, MAX_CHUNK, MAX_TITLE_CHARS, TELEGRAM_LIMIT, councilVerdicts, listPageKeyboard } from './notify.mjs';
import { flipListPage } from './telegram-listener.mjs';

const matchers = loadCountryMatchers();
let failures = 0;
// ➤ `total` counts the checks that actually RAN (it used to be a sum written by
// ➤ hand at the end, which stopped being true as soon as a test was added).
let total = 0;
// ➤ "check" is the judge for each test: if the result (got) isn't the
// ➤ expected value (want), it records a failure and shows it on screen.
const check = (got, want, label) => {
  total++;
  if (got !== want) { failures++; console.log(`  FAIL ${label}: got "${got}", want "${want}"`); }
};

// ── cleanTitle: strip gender/grade tags ─────────────────────────────
// ➤ "Clean title" tests: German/French postings carry gender tags like
// ➤ "(m/w/d)" or "(H/F)" that clutter the title. Here we check they're
// ➤ removed without touching the rest.
check(cleanTitle('Systemingenieur für komplexe Marinesysteme (m/w/d)'),
  'Systemingenieur für komplexe Marinesysteme', 'cleanTitle m/w/d');
check(cleanTitle('MSR-Techniker (w/m/div.) Gebäudeautomation'),
  'MSR-Techniker Gebäudeautomation', 'cleanTitle w/m/div.');
check(cleanTitle('Comptable - SECTEUR NAVAL (H/F)'),
  'Comptable - SECTEUR NAVAL', 'cleanTitle (H/F)');
check(cleanTitle('Développeur embarqué -Yocto - Secteur naval F/H'),
  'Développeur embarqué -Yocto - Secteur naval', 'cleanTitle bare F/H');
check(cleanTitle('Trainee EPC Sourcing (all genders)'),
  'Trainee EPC Sourcing', 'cleanTitle all genders');
check(cleanTitle('Offshore Engineer'),
  'Offshore Engineer', 'cleanTitle untouched');

// ── compactTitle: filler and jargon out ("junk out") ────
// ➤ "Shorten title" tests: out with filler like "- NAVAL Sector",
// ➤ trailing technical acronyms and temp-agency tags — while keeping
// ➤ the parts that do inform.
check(compactTitle('Designer Integrator - NAVAL Sector'),
  'Designer Integrator', 'compact sector segment');
check(compactTitle('Intégrateur Projeteur - Secteur NAVAL'),
  'Intégrateur Projeteur', 'compact secteur segment');
check(compactTitle('Project Engineer Communications Technology DWDM / MPLS-TP / TDM / radio link'),
  'Project Engineer Communications Technology', 'compact acronym-slash tail');
check(compactTitle('High Voltage Cable Engineer – Underground and Submarine cable'),
  'High Voltage Cable Engineer - Underground and Submarine cable', 'compact keeps informative segment');
check(compactTitle('Mechanical / Structural Engineer'),
  'Mechanical / Structural Engineer', 'compact keeps early slash');
check(compactTitle('Fuselage S19 Industrial Tooling & Robotics (Temp Agency)'),
  'Fuselage S19 Industrial Tooling & Robotics', 'compact temp-agency tag');
check(compactTitle('Offshore Engineer'),
  'Offshore Engineer', 'compact untouched');

// ➤ A LONG TITLE ARRIVES WHOLE. It used to be cut at 72 characters with an "…",
// ➤ which hit 41 of 1,006 real titles and threw away the very words that said
// ➤ what the job was. Telegram wraps the line itself, so nothing was gained.
const longReal = 'Marine Surveyor (Inspector-a de carga y descarga de producto petroquimico)';
check(compactTitle(longReal), longReal, 'a long title is not cut');
// ➤ The en dash comes back as a plain hyphen: the segment splitter rejoins on
// ➤ " - ". That is the normalising this function has always done, and it is
// ➤ what the expected value has to say.
check(compactTitle('Junior Cloud Security Consultant – DevSecOps & Automation - Consulting, IT-Security, Ingenieur'),
  'Junior Cloud Security Consultant - DevSecOps & Automation - Consulting, IT-Security, Ingenieur',
  'nor is one that reaches 94 characters');
// ➤ The one ceiling left protects the message splitter, not the reading width:
// ➤ a line longer than MAX_CHUNK cannot be split off and would take the whole
// ➤ list past Telegram's limit. It must still be there, and still be finite.
const absurd = compactTitle('Engineer ' + 'x '.repeat(400));
check(absurd.length <= MAX_TITLE_CHARS + 1, true, 'an absurd title is still capped, for the splitter');
check(MAX_TITLE_CHARS < MAX_CHUNK, true, 'and that cap sits below what one message can hold');

// ── cityOf: city only, no region/province/country ───────────────────
// ➤ "Extract the city" tests: the user wants to see only the city, not the
// ➤ region/autonomous community or the country. If the location is just a
// ➤ country ("France"), nothing is shown.
check(cityOf('Marín (Pontevedra) | Lugo, España, Galicia'), 'Marín', 'cityOf parenthetical+pipe');
check(cityOf('Delft, Zuid-Holland, Nederland'), 'Delft', 'cityOf first segment');
check(cityOf('Madrid, Comunidad de Madrid, España'), 'Madrid', 'cityOf Madrid survives (city ≠ country)');
check(cityOf('France'), '', 'cityOf bare country omitted');
check(cityOf('België'), '', 'cityOf bare country alias omitted');
check(cityOf(''), '', 'cityOf empty');
check(cityOf('N/A'), '', 'cityOf N/A');

// ── classifyLocation: the user's country groups ─────────────────────────
// ➤ Grouping tests: each location must fall into its group in the
// ➤ Telegram message (BARCELONA first, then SPAIN, FRANCE...).
const CL = [
  ['Barcelona, España', 'BARCELONA'],
  ['Madrid, Comunidad de Madrid, España', 'SPAIN'],
  // ➤ Real strays of 2026-08-05 (#786/#791): the ISO code and a city outside
  // ➤ the big three used to land in OTHER.
  ['Cádiz, ES', 'SPAIN'],
  ['Greater Sevilla Metropolitan Area', 'SPAIN'],
  ['Paris, France', 'FRANCE'],
  ['Monte Carlo, Monaco', 'MONACO'],
  ['België', 'BELGIUM'],
  ['Delft, Zuid-Holland, Nederland', 'NETHERLANDS'],
  ['Hamburg, Deutschland', 'GERMANY'],
  ['Stavanger, Norway', 'NORWAY'],
  ['Remote', 'REMOTE'],
  ['', 'NO LOCATION'],
];
for (const [loc, want] of CL) check(classifyLocation(loc, matchers), want, `classify ${loc || '(empty)'}`);

// ➤ A country name with regex characters in it ("St. Helena", "Bosnia (BiH)")
// ➤ must be matched LITERALLY. The escaping that makes that work was broken
// ➤ once by a bad edit, so it is pinned here: the dot must not act as "any
// ➤ character", or "Sta Helena" would be filed under the wrong country.
const oddMatchers = [{ group: 'ODD', keys: ['st. helena', 'bosnia (bih)'] }];
check(classifyLocation('St. Helena', oddMatchers), 'ODD', 'classify: literal dot matches');
check(classifyLocation('Bosnia (BiH)', oddMatchers), 'ODD', 'classify: literal parentheses match');
check(classifyLocation('Sta Helena', oddMatchers), 'OTHER', 'classify: the dot is not a wildcard');

// ── urlGroupHint: adzuna domain = country when location is missing ──
// ➤ Country "plan B" tests: if an offer comes without a location but the
// ➤ link is adzuna.nl, we infer it's from the Netherlands.
check(urlGroupHint('https://www.adzuna.nl/details/123?x=1'), 'NETHERLANDS', 'hint adzuna.nl');
check(urlGroupHint('https://www.adzuna.be/land/ad/99'), 'BELGIUM', 'hint adzuna.be');
check(urlGroupHint('https://www.adzuna.es/details/5'), 'SPAIN', 'hint adzuna.es');
check(urlGroupHint('https://ecyq.fa.em2.oraclecloud.com/x'), null, 'hint non-adzuna null');

// ── esc: HTML escaping for Telegram parse_mode HTML ─────────────────
// ➤ Format-safety tests: the symbols < > & break Telegram's HTML
// ➤ messages if they aren't "escaped" (converted to codes).
check(esc('R&D Engineer <Offshore>'), 'R&amp;D Engineer &lt;Offshore&gt;', 'esc html chars');
check(esc('Plain Title'), 'Plain Title', 'esc untouched');

// ➤ ── THE MESSAGE MUST FIT ───────────────────────────────────────────────
// ➤ Telegram refuses anything over 4096 characters, and refusing means you get
// ➤ NO list — the failure is total, not partial. Raising the limit to 100000
// ➤ passed every test in the project, which is how this one came to exist.
// ➤ THE MARGIN WAS THE BUG. This used to say the 500 spare characters left room
// ➤ "for the tags and links added on top" — but that overhead is PROPORTIONAL,
// ➤ not fixed: measured on the real pending list, what goes out is 1.8x the
// ➤ visible text, so a full message reached ~6,300 characters. The chunker now
// ➤ counts the markup itself, and the block further down proves it.
check(MAX_CHUNK < TELEGRAM_LIMIT, true, 'a message is split below what Telegram accepts');
check(MAX_CHUNK > 500, true, 'and not so small that every list arrives in pieces');

// ➤ ── THE LANGUAGE OF A PLACE ────────────────────────────────────────────
// ➤ Only ever a SECOND attempt, after the automatic detection has given up —
// ➤ and it gives up often, because job titles are three words long. Google
// ➤ reported "Charpentier naval H/F" as ENGLISH and handed it straight back,
// ➤ so French postings reached the phone in French for weeks. Told outright
// ➤ that it is French, the same service answers "Shipwright M/F".
check(languageOfPlace('Saint-Nazaire, Loire-Atlantique, France'), 'fr', 'France by name');
check(languageOfPlace('Alfarrasi, Valencian Community, Spain'), 'es', 'Spain by name');
check(languageOfPlace('Bremen, Deutschland'), 'de', 'Germany in its own language');
check(languageOfPlace('Rotterdam, Nederland'), 'nl', 'the Netherlands likewise');
check(languageOfPlace('Antwerpen, België'), 'nl', 'Belgium answers Dutch, where the search is');
check(languageOfPlace('Monaco, MC'), 'fr', 'and Monaco is French');
// ➤ The site it came from says the country as plainly as the words do; plenty
// ➤ of postings carry only a town.
check(languageOfPlace('https://www.adzuna.fr/details/123'), 'fr', 'the board tells you too');
check(languageOfPlace('https://www.adzuna.es/details/123'), 'es', 'whichever one it is');
// ➤ Nothing recognised means no second attempt, which is the safe outcome.
check(languageOfPlace('Aberdeen, United Kingdom'), '', 'an English-speaking country asks for nothing');
check(languageOfPlace(''), '', 'and neither does an empty location');
check(languageOfPlace(null), '', 'nor a missing one');
// ➤ It must not read a country out of the middle of another word.
check(languageOfPlace('Francesca Ltd, Aberdeen'), '', 'a name that merely contains one is not a country');

// ➤ ── THE TWO ATTEMPTS, WIRED UP ─────────────────────────────────────────
// ➤ languageOfPlace was tested; nothing tested that the translator USES it. A
// ➤ mutation run proved the cost — deleting the country hint entirely, the
// ➤ whole reason non-English titles arrive in English, left the suite green.
// ➤ The translator is asked through an injected fetch, so this needs no network.
{
  const reply = text => ({ ok: true, json: async () => [[[text, '', null, null]]] });
  const calls = [];
  // ➤ Google reports a short French title as ENGLISH and hands it straight
  // ➤ back; told outright that it is French it answers properly.
  const fake = async (url) => {
    calls.push(url);
    const sl = (url.match(/[?&]sl=([^&]+)/) || [])[1];
    if (sl === 'auto') return reply('Charpentier naval H/F');
    if (sl === 'fr') return reply('Shipwright M/F');
    return reply('');
  };
  const out = await translateTitle('Charpentier naval H/F', 'Saint-Nazaire, France', { fetchImpl: fake, cache: new Map() });
  check(out, 'Shipwright M/F', 'an unchanged answer triggers a second attempt in the local language');
  check(calls.length, 2, 'which is exactly two requests, never more');
  check(/sl=fr/.test(calls[1]), true, 'and the second one names the country language');

  // ➤ An English title comes back unchanged too, so it MUST not be retried
  // ➤ blindly — that is why the country, not the text, decides.
  const c2 = [];
  const fake2 = async (url) => { c2.push(url); return reply('Offshore Installation Engineer'); };
  const en = await translateTitle('Offshore Installation Engineer', 'Aberdeen, United Kingdom', { fetchImpl: fake2, cache: new Map() });
  check(en, 'Offshore Installation Engineer', 'an English title survives untouched');
  check(c2.length, 1, 'and asks only once, because there is no language to force');

  // ➤ A title already translated on the first attempt must not be asked twice.
  const c3 = [];
  const fake3 = async (url) => { c3.push(url); return reply('Industrial automation engineer'); };
  await translateTitle('Ingeniero de automatización industrial', 'Valencia, Spain', { fetchImpl: fake3, cache: new Map() });
  check(c3.length, 1, 'a successful first attempt is not repeated');

  // ➤ And the whole thing must survive the translator being down: the original
  // ➤ title is worth more than an error.
  const dead = async () => { throw new Error('network is down'); };
  const kept = await translateTitle('Ingeniero naval', 'Spain', { fetchImpl: dead, cache: new Map() });
  check(kept, 'Ingeniero naval', 'if the translator fails the original title is kept');
}

// ➤ Final tally: says whether EVERYTHING passed or how many failed.
// ── A message must never exceed what Telegram will accept ────────────────
// ➤ The chunker used to count the VISIBLE text while sending the markup: every
// ➤ line carries <a href="the whole URL">, so the real message came out 1.8x
// ➤ the size measured — about 6,300 characters against a 4,096 limit. Past
// ➤ roughly thirty offers in one country the list simply stopped being sent.
// ➤ This rebuilds a line exactly as notify.mjs does and holds the ceiling to
// ➤ what actually goes out.
{
  const escAttr = x => String(x || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const TELEGRAM_LIMIT_REAL = 4096;
  check(MAX_CHUNK < TELEGRAM_LIMIT_REAL, true, 'the chunk ceiling sits below what Telegram accepts');

  // ➤ 120 offers in ONE country, with the long URLs Workday produces.
  const offers = Array.from({ length: 120 }, (_, i) => ({
    id: 700 + i,
    company: `Offshore Contractor Group Number ${i}`,
    title: `Marine Survey and Positioning Engineer Offshore Wind Projects ${i}`,
    url: `https://acme.wd3.myworkdayjobs.com/en-US/ACME_Careers/job/Rotterdam-Netherlands/Marine-Survey_R-${100000 + i}?source=Careers_Website&utm=x`,
  }));
  const sent = [];
  const BR = '\n\n';
  let chunk = `<b>Pending offers</b>${BR}<b>NETHERLANDS</b>${BR}`;
  for (const o of offers) {
    const line = `- ${esc('#' + o.id + ' ')}<a href="${escAttr(o.url)}">${esc(`${o.title} - ${o.company}`)}</a>${BR}`;
    if (chunk.length + line.length > MAX_CHUNK) { sent.push(chunk); chunk = `<b>NETHERLANDS</b>${BR}`; }
    chunk += line;
  }
  if (chunk.trim()) sent.push(chunk);

  const longest = Math.max(...sent.map(t => t.length));
  check(longest <= TELEGRAM_LIMIT_REAL, true, `no message exceeds the limit (longest ${longest} of ${TELEGRAM_LIMIT_REAL})`);
  check(sent.join('').split('<a href').length - 1, 120, 'every offer is included, none dropped');
  check(sent.length > 1, true, 'a list this long really is split across messages');
}

// ➤ ── THE BOT SPEAKS ENGLISH ────────────────────────────────────────────
// ➤ The date at the top of every list was formatted es-ES and read "sábado, 1
// ➤ de agosto" on the phone — the only Spanish left in anything the user sees,
// ➤ and in the message read most often. A language difference between the two
// ➤ copies looks like prose, which is how it survived several reviews.
{
  const src = readFileSync(new URL('./notify.mjs', import.meta.url), 'utf-8');
  check(/DateTimeFormat\(.en-GB./.test(src), true, 'the list header date is formatted in English');
  check(/DateTimeFormat\(.es-ES./.test(src), false, 'and never in Spanish');
}

// ➤ ── THE BOT SPEAKS ENGLISH ────────────────────────────────────────────
// ➤ The date at the top of every list was formatted es-ES and read "sábado, 1
// ➤ de agosto" on the phone — the only Spanish left in anything the user sees,
// ➤ and in the message read most often. A language difference between the two
// ➤ copies looks like prose, which is how it survived several reviews.
{
  const src = readFileSync(new URL('./notify.mjs', import.meta.url), 'utf-8');
  check(/DateTimeFormat\(.en-GB./.test(src), true, 'the list header date is formatted in English');
  check(/DateTimeFormat\(.es-ES./.test(src), false, 'and never in Spanish');
}

// ➤ "exit(1)" tells the system that something is wrong.
// ➤ ── THE COUNCIL'S WORD ON THE LIST ───────────────────────────────────
// ➤ show → [YES], tie → [MYB], hide → [NO], straight from the journal — and only
// ➤ while the Council is switched on, so with it off the list never changes.
{
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'tmp-test-council');
  mkdirSync(dir, { recursive: true });
  const pOn = join(dir, 'on.yml'), pOff = join(dir, 'off.yml'), pJ = join(dir, 'j.jsonl');
  writeFileSync(pOn, ['council:', '  enabled: true', ''].join(String.fromCharCode(10)));
  writeFileSync(pOff, ['council:', '  enabled: false', ''].join(String.fromCharCode(10)));
  writeFileSync(pJ, [
    JSON.stringify({ url: 'https://x/a', id: 5, council: 'show' }),
    JSON.stringify({ url: 'https://x/b', id: 6, council: 'tie' }),
    JSON.stringify({ url: 'https://x/c', id: 7, council: 'hide' }),
    '{broken line',
  ].join(String.fromCharCode(10)));
  const v = councilVerdicts({ portalsPath: pOn, journalPath: pJ });
  check(v.get('https://x/a'), 'YES', 'the Council speaks YES for show');
  check(v.get('#6'), 'MYB', 'MYB for tie, reachable by number too');
  check(v.get('https://x/c'), 'NO', 'and NO for hide');
  check(v.get('https://x/never'), undefined, 'an unjudged offer says nothing');
  check(councilVerdicts({ portalsPath: pOff, journalPath: pJ }), null, 'with the Council off the journal is not even read');
  const empty = councilVerdicts({ portalsPath: pOn, journalPath: join(dir, 'missing.jsonl') });
  check(empty instanceof Map && empty.size === 0, true, 'on but nothing judged yet: an empty map, not a crash');
  // ➤ And the word is sewn onto the offer line itself, in both renderings.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'notify.mjs'), 'utf-8');
  check(/verdicts\.get\(o\.url\)/.test(src) && src.includes(' [${word}]'), true, 'the verdict rides the offer line as a [TAG]');
  rmSync(dir, { recursive: true, force: true });
}

// ── The paged live list (2026-08-19): keyboard shape and flip honesty ──────
{
  // ➤ The nav row shows only the arrows that lead somewhere.
  check(JSON.stringify(listPageKeyboard(1, 3)),
    JSON.stringify([[{ label: '1/3', data: 'pg:cur' }, { label: 'Next ▶', data: 'pg:2' }]]),
    'page 1 offers only Next');
  check(JSON.stringify(listPageKeyboard(2, 3)),
    JSON.stringify([[{ label: '◀ Prev', data: 'pg:1' }, { label: '2/3', data: 'pg:cur' }, { label: 'Next ▶', data: 'pg:3' }]]),
    'a middle page offers both arrows');
  check(JSON.stringify(listPageKeyboard(3, 3)),
    JSON.stringify([[{ label: '◀ Prev', data: 'pg:2' }, { label: '3/3', data: 'pg:cur' }]]),
    'the last page offers only Prev');

  // ➤ flipListPage: what it edits, what it refuses, what it ignores.
  const calls = [];
  const deps = (pagesState) => ({
    loadPages: () => pagesState,
    editButtons: (...a) => { calls.push(['edit', ...a]); return true; },
    answer: (...a) => { calls.push(['answer', ...a]); return true; },
    keyboard: listPageKeyboard,
  });
  const st = { message_id: 77, pages: ['P1', 'P2', 'P3'], ts: 'x' };

  check(await flipListPage('o:2', 77, 'cb', deps(st)), false,
    'an onboarding tap is not a page turn: falls through untouched');
  check(calls.length, 0, 'and nothing was sent for it');

  check(await flipListPage('pg:2', 77, 'cb', deps(st)), true, 'a valid flip is handled');
  check(calls[0][0] === 'edit' && calls[0][2] === 'P2', true, 'it redraws the tapped message with page 2');

  calls.length = 0;
  await flipListPage('pg:9', 77, 'cb', deps(st));
  check(calls[0][2], 'P3', 'a page number past the end clamps to the last page');

  calls.length = 0;
  await flipListPage('pg:2', 41, 'cb', deps(st));
  check(calls[0][0] === 'answer' && /outdated/.test(calls[0][2] || ''), true,
    'a tap on an OLDER list message gets the outdated toast, never a redraw');

  calls.length = 0;
  await flipListPage('pg:cur', 77, 'cb', deps(st));
  check(calls.length === 1 && calls[0][0] === 'answer', true,
    'the page counter only stops the spinner');
}

console.log(failures === 0 ? `All ${total} notify tests passed.` : `${failures}/${total} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
