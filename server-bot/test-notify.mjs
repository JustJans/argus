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

import { cleanTitle, compactTitle, cityOf, classifyLocation, loadCountryMatchers, urlGroupHint, esc } from './notify.mjs';

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

// ➤ Final tally: says whether EVERYTHING passed or how many failed.
// ➤ "exit(1)" tells the system that something is wrong.
console.log(failures === 0 ? `All ${total} notify tests passed.` : `${failures}/${total} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
