#!/usr/bin/env node
// ➤ ═══════════════════════════════════════════════════════════════════
// ➤ WHAT THIS FILE IS: the test suite for the job-search filters. It does
// ➤ not search offers: it checks that the filters (title, location,
// ➤ language and years of experience) still decide correctly after every
// ➤ change. Each example is a REAL case: an offer that slipped through or
// ➤ was lost in production, and whose fix is now guarded forever.
// ➤ WHEN IT RUNS: by hand, with "node server-bot/test-filter.mjs",
// ➤ after touching portals.yml or the filtering logic.
// ➤ WHAT IT USES: it reads portals.yml (the search configuration) and
// ➤ tests the functions in scan.mjs and requirements.mjs. It writes nothing.
// ➤ ═══════════════════════════════════════════════════════════════════

/**
 * test-filter.mjs — regression tests for the title/location filters.
 *
 * Every case here is a REAL false positive/negative observed in production
 * (or a fix for one). Run after any change to portals.yml or the filter
 * logic:   node server-bot/test-filter.mjs
 */

// ➤ Loads the tools: reading files, understanding YAML (the format of the
// ➤ configuration) and the filtering functions that will be put to the test.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { buildTitleFilter, buildLocationFilter, buildCompanyFilter, buildCountryFilter, admissionVerdict, roleKey, slugTitle, parseJobPostingLd, parseLinkedInCards, titleDemandsForeignLanguage, bodyLanguageBlock, pipelineRoleKey, hasApplySignal, overrideDeadIfApply, formatSalary, normUrl } from './scan.mjs';
import { offerAffinity } from './notify.mjs';
import { extractRequiredYears, stripHtml, experienceScreen, extractAdzunaJd, degreeScreen } from './requirements.mjs';

// ➤ Locates the project folder, reads the real configuration (portals.yml)
// ➤ and builds the two filters exactly as the real scanner uses them:
// ➤ "title" decides by the offer title and "location" by the place.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const config = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf-8'));
const title = buildTitleFilter(config.title_filter);
const location = buildLocationFilter(config.location_filter);

// ➤ List of offer titles the filter MUST accept: jobs that fit the user's
// ➤ profile (offshore, automation, survey, data...).
const PASS = [
  // ➤ 2026-07-28: "Service Engineer" is now a POSITIVE, not a veto. These are
  // ➤ the real titles that were being blocked. "Service Technician" is NOT
  // ➤ affected — that veto stays.
  'Junior Marine Service Engineer',
  'Service Engineer Marine & Ports Drives',
  'Offshore Service Engineer',
  'EMEA Field Service Engineer - Marine & Offshore',
  // ➤ The training veto of 2026-07-27 must stay NARROW. "Graduate Programme" is
  // ➤ wanted, and "Academy" is only a veto when it IS the product — an engineer
  // ➤ role at an academy still counts as a job.
  // ➜ 2026-07-28 TRIAL: land surveying reaches the list. Fetching is not
  // ➜ enough — without these positives the new query's offers would all die
  // ➜ at the title gate for carrying no word of the field.
  'Landmeter',
  'Junior Landmeter',
  'Landmeetkundige',
  'Business Transformation & Strategy Graduate Programme',
  'Graduate Program Operations (m/w/d) - 12 Monate',
  'Automation Engineer - Naval Academy',
  'Ingeniero de instrumentación, Academy of Sciences',
  // ➤ The "AI" veto is a whole word: it must not fire INSIDE another word
  // ➤ (Maintenance has "ai" in it) — the maintenance mariner stays.
  'Marine Maintenance Engineer',
  // ➤ "Chef" only vetoes cooking: the French project manager stays.
  'Chef de projet Offshore Wind',
  // boundary fix: "Intern" must not block "International"
  'International Project Engineer',
  // regression fix: junior offshore-wind consultancy scored 4.2/5 once
  'Junior Consultant - Offshore Wind Advisory',
  // broadened spectrum
  'Automation Engineer',
  'Instrumentation Engineer Offshore',
  'GIS Data Analyst',
  'Graduate Metocean Engineer',
  'Hydrographic Surveyor',
  // ops-center roles are now welcome (Controller no longer blanket-blocked)
  'Remote Controller - Offshore Remote Center (ORC)',
  // core roles still pass
  'Offshore Engineer',
  'Mooring Analyst',
  // ➤ 2026-07-18: "Structural" only with an offshore/naval angle — the
  // ➤ generic building-structural one no longer passes (see BLOCK)
  'Structural Engineer Offshore Wind',
  'Subsea Control Systems Engineer',
  // graduate phrases survive the bare-"Graduate" removal
  'Equinor Graduate Programme 2026',
  'Junior Engineer',
  // round 2: legit catches from the broadened net (production 2026-06-11)
  'Engineer Energy Systems Ministry of Defence',
  'PLC Engineer',
  'SCADA Programmeur',
  'Ocean Modeller',
  'Geo-data Advisor Geotechnics (Land & Marine)',
  // FR/DE engineering roles must survive the round-4 noise purge
  'Ingénieur instrumentation/Ingénieure instrumentation',
  'Systemingenieur für komplexe Marinesysteme (m/w/d)',
  // "Export Agent" is blocked but offshore-wind export cables stay valid
  'Export Cable Engineer',
  // 2026-07-08 (Gate 1): controls/automation IS the user's field, so an
  // unfamiliar SECTOR (e.g. data-center controls) still passes the title filter
  // — the years filter / evaluation decide, not a domain block
  'Controls Design Engineer (EPMS), CDE',
  'Junior Automation Engineer',
  // 2026-07-11: explicit cases the owner asked to see guarded
  'Mooring Engineer',                       // covered by the "Mooring" positive
  'OrcaFlex Package Engineer',              // OrcaFlex mention = always in
  // ➤ ('Junior AI Engineer' and 'AI Engineer - Marine Analytics' were here as
  // ➤ PASS from 07-11 to 07-18 — the user revoked AI; now in BLOCK.)
  // ➤ 2026-07-18 (approved exploration): survey = the user's literal degree
  'Survey Engineer',
  'Geomatics Engineer',
  'Bathymetric Survey Engineer',
  // ➤ ── MULTILINGUAL SWEEP 2026-07-24: the "unless" guards must SAVE these ──
  // ➤ These are titles IN the user's field written in the other languages of their
  // ➤ search. The new negatives (Maschinenbau, Elektrotechnik, Werktuigbouwkunde,
  // ➤ Mécatronique...) would kill them without their guard, which is exactly the
  // ➤ false drop we must never allow. The generic word for "engineer" in any
  // ➤ language is never a negative.
  'Projektingenieur (m/w/d) Maschinenbau - Offshore-Windenergie',   // DE: mech. discipline BUT offshore wind
  'Ingenieur Elektrotechnik / Automatisierungstechnik (m/w/d)',     // DE: electrical BUT automation
  'SPS-Programmierer (m/w/d)',                                      // DE: programmer BUT PLC
  'Bauingenieur Offshore-Windpark',                                 // DE: civil BUT offshore wind
  'Ingénieur Mécatronique - Drones Sous-Marins',                    // FR: mechatronics BUT subsea
  'Ingénieur Électrotechnique - Éolien Offshore',                   // FR: electrical BUT offshore wind
  'Engineer Werktuigbouwkunde - Offshore Wind',                     // NL: mechanical BUT offshore wind
  'PLC Programmeur',                                                // NL: programmer BUT PLC
  'Geo-informatie Analist',                                         // NL: analyst BUT GIS/geo
  'Ingegnere Elettrico e Strumentale Offshore',                     // IT: electrical BUT instrumentation/offshore
  'Ingeniero Mecatrónico de Automatización',                        // ES: mechatronics BUT automation
  'Ingeniero de Telecomunicaciones - Cables Submarinos',            // ES: telecom BUT submarine cables
  'Enginyer Mecànic - Energia Eòlica Marina',                       // CA: mechanical BUT offshore wind
  'Oceanógrafo Químico',                                            // ES: chemistry BUT oceanography
  // ➤ 2026-07-27: the veto on French naval trades must NOT take the ENGINEER
  // ➤ with it. The guard is "unless: ingénieur", with and without the accent.
  'Ingénieur mécanicien offshore',                                  // FR: an engineer, not a mechanic
  'Ingenieur mecanicien offshore',                                  // the same, as the portals spell it
];

// ➤ List of titles the filter MUST reject: internships, senior roles,
// ➤ manual trades, pure software, degrees the user doesn't have, etc.
// ➤ Each one was real noise that once slipped through.
const BLOCK = [
  // ➤ ── TRAINING SOLD AS A VACANCY (audit 2026-07-27) ──
  // ➤ Three offers the user rejected by hand for the same reason: they are a
  // ➤ course, not a job. Same family as the Trainee/Praktikant block, which
  // ➤ already covered internships but not teaching posts or academies.
  'Industrial Maintenance Automation Associate Instructor',   // REAL
  'Hilti Academy Offshore',                                   // REAL
  'Pega Accelerator Programme - Automation & Orchestration (m/w/d)', // REAL
  'Pega Accelerator Program - Automation',                    // US spelling
  // ➤ Spanish pipe-fitting trade. Same lesson as the French trades: veto the
  // ➤ TRADE, never the "naval" sector, which is one of the positives.
  // ➜ 2026-07-28 (argus-discover trial): land surveying is admitted, but the
  // ➜ ordinary vetoes still decide. "Verkoop" is the Dutch NOUN for sales, the
  // ➜ gap left when Sales/Vertrieb/Ventas/Commercieel were blocked.
  'Landmeter Verkoop',
  'Landmeter Monteur',
  'Senior Landmeter',
  'Stagiair Landmeter',
  'Tubero naval (m / f / nb)',                                // REAL
  'Tuberos navales',
  // ➤ 2026-07-28: third wave of the same family, caught the day after the fix.
  'Calorifugeur Naval H/F',                                   // REAL: insulation fitter
  'Agent polyvalent base navale H/F',                         // REAL: general labourer
  // ➤ ── MULTILINGUAL SWEEP 2026-07-24 ("anota conscientemente todo eso") ──
  // ➤ The lesson of "Praktikant" (#680): the CONCEPT was blocked in English but
  // ➤ the German WORD was not, so it slipped through. These are the same
  // ➤ concepts in the other languages of the search. The two marked REAL are
  // ➤ offers the user had to reject BY HAND on 2026-07-23/24 — now caught alone.
  'Technicien conception structure offshore H/F',        // REAL #682: FR technician (was slipping)
  'O&M Site Coördinator - Offshore Wind',                // REAL #691: NL "Coördinator" with ö dodged "Coordinator"
  'Ausbildung zum Industriemechaniker',                  // DE apprenticeship
  'Werkstudent Elektrotechnik',                          // DE working student + electrical
  'Schweißer für Stahlbau',                              // DE welder
  'Vertriebsingenieur Automatisierung',                  // DE sales engineer
  'Stagiaire Ingénieur Bureau d\'Études',                // FR intern
  'Soudeur offshore',                                    // FR welder (trade, not engineering)
  'Alternance - Chargé de projet',                       // FR work-study
  'Leerling Elektromonteur',                             // NL apprentice
  'Stagiair Werktuigbouwkunde',                          // NL intern
  'Tirocinante Ingegneria',                              // IT trainee
  'Saldatore navale',                                    // IT welder
  'Becari en pràctiques',                                // CA intern
  'Ingeniero de Caminos, Canales y Puertos',             // ES civil-engineering degree the user lacks
  // ➤ Review batch 2026-07-18 (nightly review): AI vetoed (revokes the 07-11
  // ➤ positive), Officer, Lab, HVAC and German -leiter management roles.
  // ➤ Review batch 2026-07-19: Tekla (#628) and cruise-ship cooking (#631).
  'Nos super offres Designer Structure Offshore (TEKLA)',
  'OCEAN - Sous Chef',
  'Applied AI Engineer',
  'Junior AI Engineer',
  'AI Engineer - Marine Analytics',
  'AI AUTOMATION JUNIOR',
  'Microsoft 365 Copilot & AI Engineer (m/f/d)',
  'Agentic AI Engineer',
  'Intelligent Automation & Transformation Officer (m/w/d)',
  'Lab Engineer Automation (TwinCAT / PLC)',
  'Junior Project Engineer HVAC',
  'Segmentleiter/in Building Automation (m/w/d), 80-100%',
  // student / academia
  'Intern - Mooring System Engineer',
  'Internship Program - Engineering',
  'Trainee EPC Sourcing (all genders)',
  'Postdoc Offshore Wind Farm Impacts on Ichthyoplankton Transport',
  'PhD Candidate Marine Energy',
  // technicians (EN/NL)
  'Wind Turbine Technician',
  'Offshore Service Technicus Wind',
  'Service Monteur Offshore',
  // seniority
  'Senior Marine Engineer',
  'Marine Lead Engineer',
  'Offshore Wind Project Manager',
  'Marine Superintendent',
  // software-flavoured automation stays out
  'Test Automation Engineer (Java)',
  'QA Automation Engineer',
  // wrong function
  'Crane Coordinator Offshore',
  'Project Controller Offshore Energy',
  // acronym fix: "GIS" must NOT match inside "Logistiek"
  'Logistiek Engineer',
  // round 2: real noise that slipped through the broadened net (2026-06-11)
  'Junior Business Analyst',
  'Junior Accountant',
  'Junior Software Developer',
  'Automation Test Engineer (Python)',
  'Automation & RPA Engineer',
  'Infrastructure Automation Engineer (Ansible AWX) - Freelance',
  'Elektromonteur Offshore',                  // Dutch compound: *monteur
  'Junior Internationaal Servicemonteur',     // Dutch compound: *monteur
  'Técnico/A De Electrónica Naval Y Satcom (Nivel 2)',
  'Energy Strategy Consultant',
  'Intelligence Analyst - EU Energy Policy, POLITICO Research and Analysis',
  'Marine zoekt babysit in Uccle',
  'Carpinteros y laminadores navales',
  // round 3 (2026-06-12): manual trades + software hiding behind robotics
  'Mecánico naval, mecánico industrial, cerrajero',
  'Software Robotics Engineer',
  // round 6 (2026-07-06): the user's Telegram feedback — cybersecurity/TPM/aero noise
  'SOC Analyst Tier 2 & Security Automation',
  'Threat Intelligence Engineer — Intrusion Analysis & Automation',
  'Full-Stack Security Automation Engineer',
  'Strategic TPM, Robotics Deployment & Packaging Innovation',
  'Turbomachinery Mechanical Design Engineer',
  'Process Optimization & Automation Specialist',
  // round 5 (2026-06-12): freight forwarding caught by "Ocean"
  'Ocean Export Agent (MAD)',
  // round 4 (2026-06-12): FR/DE noise after unblocking those countries
  'Comptable - SECTEUR NAVAL (H/F)',
  'Directeur Automation & data engineering H/F',
  'Responsable Industrialisation Détaillée - SECTEUR NAVAL - (H/F)',
  'Développeur embarqué -Yocto - Secteur naval F/H',
  'Projektmanager (m/w/d) Technische Dokumentation für Automation',
  'MSR-Techniker (w/m/div.) Gebäudeautomation',
  'Elektrotechnikerin / Elektromeisterin Umspannwerke Offshore (m/w/d)',
  "Chargé(e) d'affaires Energies Instrumentation F/H",
  'Pricing Analyst (ALLEX Graduate Program) H/F',
  // round 7 (2026-07-08): qualification-gated / non-engineer / pure-software
  'Legal Counsel - Renewable Energy',                              // needs a law degree
  'Investigador/a - Docente en Automatización, Robótica y Visión', // teaching titulación
  'Quality Automation Engineer',                                   // QA/TypeScript
  'Content Automation Engineer (d/f/m)',                           // content software
  'Caldereros navales',                                            // welding trade
  // round 8 (2026-07-08, Gate 1): degree-gated professions the user can't hold the
  // title for — discarded EVEN as junior/no-experience (the NASA/plumber rule)
  'Junior Electrical Engineer - Offshore Wind',                    // needs EE degree
  'High Voltage Cable Engineer – Underground and Submarine cable', // electrical (#7)
  'Mechanical Design Engineer',                                    // mechanical (#96)
  'Junior Aerospace Engineer, Offshore Wind Turbines',             // aerospace degree
  'Chemical Engineer',
  // unrelated industry / field (2026-07-08)
  'Project Engineer – Animal Nutrition / Pet Food Industry',       // agrifood (#447)
  'Ingeniero/a ILS Naval (Mantenimiento)',                         // defence logistics (#73)
  // round 10 (2026-07-11): IT/solution architects riding "Automation" (#528)
  'Hybrid Solution Architect - Warehouse Automation & Growth',
  'Solution Architect – AutoStore & Warehouse Automation',
  // round 11 (2026-07-13): the user's Telegram rejections
  'Service Desk Specialist / IT Operations / Automation & AI',     // IT support (#523)
  'Deployment Dentist for Naval Program - International Travel',   // a DENTIST via "Naval" (#532)
  'Coordinador electricidad naval',                                // electrical trade (#533)
  // round 12 (2026-07-13, 26-rejection batch)
  'Soldadores navales para Holanda',                               // -es plural dodged "Soldador" (#566)
  'Tôlier Naval H/F',                                              // FR sheet-metal trade (#283)
  'Couturier Naval H/F',                                           // FR sailmaker trade (#289)
  'Caréneur - NAVAL (H/F)',                                        // FR hull-cleaning trade (#488)
  'Superintendant MCO Naval F/H',                                  // FR spelling of Superintendent (#219)
  'Tech & Product Leader for AdTech Platform & AI Automation',     // leadership (#573)
  'Predictive Maintenance Coordinator - Wind Energy (H/F)',        // leadership/coordination (#222)
  'Automation & OT Engineer',                                      // OT = industrial cybersecurity (#574)
  'Electrical Design Engineer (FR/NL EN)',                         // electrical degree (#14)
  'Energy Engineer (FR/NL EN)',                                    // specific degree the user lacks (#49)
  // round 14 (2026-07-16): the STRUCTURAL fix — discipline blocked as a word,
  // so the whole "X Design/Project Engineer" family falls at once, plus the
  // sector/role blocks. These are the 40-rejection batch the user flagged.
  'Electrical & Automation Project Engineer',                      // flipped: electrical (#62)
  'Grid Code Compliance Electrical Project Engineer',              // flipped: electrical
  'Engineer Electrical and Instrumentation',                       // electrical discipline, not the profile
  'Electronics Design Engineer N3XT Interceptor C-UAS (m/f/d)',    // electronics (#123)
  'Mechanical/Mechanism Design Engineer (m/f/d)',                  // mechanical (#134)
  'Mechatronics engineer HBO / prototype designer',                // mechatronic (#43)
  'R&D Mechatronics Engineer – Level 2',                           // mechatronic (#253)
  'Product Engineer - Renewable Energy Hardware (f/m/x)',          // product (#525)
  'Project Engineer - Substations',                                // substation (#169)
  'Design Engineer Data Center Development',                       // data center (#551)
  'Scientist Laboratory Automation QC (80-100%)',                  // scientist/lab (#565/#568)
  'Lab Automation Engineer Specialist',                            // lab automation (#570)
  'Project Engineer Telecommunications',                           // telecom (#552)
  'Automation Specialist HR Services (f/m/d)',                     // HR (#125)
  'Risk Management, Cost-Schedule Risk Analysis & AI-Driven Automation', // risk mgmt (#384)
  'Marine Carpenter',                                              // trade (#356)
  'Marine Technical Quotation Specialist',                         // sales/quoting (#554)
  'Programador de PLC',                                            // pure PLC programmer (#558)
  // round 16 (2026-07-16): customer-facing service + procurement (#489/#575/#582/#585)
  // ➤ 2026-07-28: the two "Service Engineer" entries MOVED to PASS. The veto was
  // ➤ lifted and the phrase made a positive, to judge these case by case instead
  // ➤ of never seeing them. The procurement ones below stay blocked.
  'Procurement Specialist Renewable Energy',
  // round 9 (2026-07-10): the user's verified rejections — fields removed
  'Robotics Architect (with Clouds)',                              // robotics out (×11)
  'Machines, Robotics & Automation (Illescas) - Illescas, Castilla-La Mancha, Spain',
  'Business Data Analyst',                                         // generic data analyst out
  'Energy Data Analyst (f/m/x)',
  'Naval Architect',                                               // naval-architecture degree
  'Junior Naval Architect',                                        // junior doesn't open it
  'Consultant Scada',                                              // consultant w/o marine angle
  'IT Consultant - Agentic Automation',
  'CRM & MarTech Automation Consultant - Song (Madrid)',
  // round 9: degree/trade/title gaps from today's list
  'Project Engineer - Electrical Engineering (m/w/d)',             // -ing dodged the block (#398)
  'Civil Project Engineer',                                        // (#511)
  'Mechanical, Electrical or Civil Design Engineering for Datacentres', // (#510)
  'Electrician (m/f/d) Offshore',                                  // (#471)
  'Offshore Elektriker (m/w/d)',                                   // (#480)
  'Electronicien Naval (H/F)',                                     // (#56)
  'Stratifieur Naval (H/F)',                                       // (#100)
  'Ayudante De Marinero/A',                                        // (#497)
  'Marine Gas Turbine Inspector',                                  // (#399)
  'Offshore Storekeeper (m/w/d)',                                  // (#314)
  // round 9: wrong role / academia / IT
  'Global COO for Renewable Energy & Growth',                      // (#429-434)
  'Beca Dpto. GIS',                                                // (#262)
  'Comercial internacional - Sector Naval',                        // (#437)
  'Administrativo/a - Sector Naval',                               // (#442)
  'Accountant (Process Improvement & Automation)',                 // (#494)
  'Customer Care Automation Engineer',                             // (#459)
  'IT Administrator - Workflow Automation (m/w/d)',                // (#413)
  'Azure Cloud Platform Engineer - Terraform & Automation (Comunidad Valenciana)', // (#474)
  'Windows Cloud Engineer / Windows Automation Engineer (W/M/D)',  // (#176)
  'Telco Cloud Field Engineer',                                    // (#377)
  'Postdoctoral Scientist, Amazon Robotics R&D',                   // (#419) "Postdoc" missed it
  'Post doctorat CRUSOE : Scenarios for marine submersion and Ecological conservation H/F', // (#92)
  // ➤ 2026-07-18: sentinels for the "Survey Engineer" positive — non-marine/
  // ➤ non-technical survey and the senior variants stay out (verified noise-free)
  'Quantity Surveyor',
  'Land Surveyor - Residential Development',
  'Employee Survey Specialist',
  'Senior Survey Engineer',
  // ➤ 2026-07-18 evening (the user's feedback on the real list): analyst NO
  // ➤ (except GIS/marine), specialist NO (except marine), generic structural
  // ➤ NO, and the village nanny "Marines" (#593) should never have got in
  'Planning & Operations Analyst – Process Automation & Digital Transformation (Temporary Position)',   // #615
  'Industrial Automation Specialist',                              // #592 Capitole
  'Structural Design Engineer',
  'Se busca canguro para cuidado de niños en Marines',             // #593 Sitly
  // ➤ 2026-07-27: FRENCH naval trades. The veto was already written down, but
  // ➤ with its accents ("Mécanicien"), and the portals title these in capitals
  // ➤ WITHOUT accents — so it caught nothing. Real cases #715 and #717, plus
  // ➤ the one sitting in the pending list that same day.
  'MECANICIEN NAVAL',                                              // #717 CRIT Dieppe
  'ELECTROMECANICIEN NAVAL (F/H)',                                 // #722, pending that day
  'DETOUREUR NAVAL H/F',                                           // #715, composites trimmer
  'Tolier Naval F/H',
  // ➤ 2026-07-27 (#710): customs / freight forwarding, riding in on "maritime".
  'Agent de transit maritime F/H',
  'Transitaire maritime',                                              // naval sheet-metal worker, from the history
];

// ➤ Places that MUST be accepted (countries where the user searches; empty text
// ➤ also passes, because many offers don't state a location).
const LOC_PASS = [
  'Delft, Zuid-Holland, Nederland', 'Barcelona, España', 'Oslo, Norway', 'Remote', '',
  // 2026-06-12: FR/DE/Monaco were silently blocked — the allow list lacked them
  'Paris, France', 'Hamburg, Deutschland', 'Monaco', 'Copenhagen, Denmark',
  // 2026-07-11: Switzerland + Austria added to the search
  'Zurich, Switzerland', 'Genève, Suisse', 'Vienna, Austria', 'Wien, Österreich',
  // ➤ Over-block catch (2026-07-18): a CITY without a country must pass — before
  // ➤ it was silently dropped (real case: Shell Graduate Germany as "Hamburg,
  // ➤ Cologne"; and the watched companies' HQs: Van Oord=Rotterdam...)
  'Rotterdam', 'Bilbao', 'Antwerpen', 'Hamburg', 'Gent', 'Marseille',
  'Stavanger', 'Leidschendam', 'Hamburg, Cologne - Godorf',
];
// ➤ Places that MUST be rejected (countries outside the search radius).
const LOC_BLOCK = ['Aberdeen, Scotland', 'Houston, TX', 'Lagos, Nigeria', 'Kuala Lumpur, Malaysia', 'London, Great Britain'];

// ➤ Titles that hide a vetoed country inside the title itself: the location
// ➤ filter must catch it there too (some portals put it that way).
const TITLE_BLOCKHIT = [
  'Shell Graduate Programme 2026 - Qatar',
  'Shell Graduate Program 2026 – Malaysia',
  'Shell Graduate Programme 2026 - China',
];
// ➤ And in these it must NOT fire: a country name can't trigger inside
// ➤ another word (for example, "UK" is not the same as "Ukraine").
const TITLE_NO_BLOCKHIT = [
  'Equinor Graduate Programme 2026',
  'Subsea Control Systems Engineer',     // "UK" must not fire inside words
  'Offshore Engineer Ukraine Support',   // boundary: UK ≠ Ukraine
];

// ➤ Mini-checker: if a case doesn't give the expected result, it adds a failure
// ➤ and prints it on screen. At the end the total failures are counted.
let failures = 0;
// ➤ `total` counts the checks that actually RAN. It used to be a sum written by
// ➤ hand at the end of the file, so adding a test left the reported number
// ➤ untouched and the tally quietly lied.
let total = 0;
const check = (ok, kind, value) => {
  total++;
  if (!ok) { failures++; console.log(`  FAIL [${kind}] ${value}`); }
};

// ➤ Runs each list through its filter and checks the decision is as expected.
for (const t of PASS) check(title(t) === true, 'title should PASS', t);
for (const t of BLOCK) check(title(t) === false, 'title should BLOCK', t);
for (const l of LOC_PASS) check(location(l) === true, 'location should PASS', l || '(empty)');
for (const l of LOC_BLOCK) check(location(l) === false, 'location should BLOCK', l);
for (const t of TITLE_BLOCKHIT) check(location.blockHit(t) === true, 'title blockHit should FIRE', t);
for (const t of TITLE_NO_BLOCKHIT) check(location.blockHit(t) === false, 'title blockHit should NOT fire', t);

// ── LinkedIn jobs-guest card parser (fixture mirrors real 2026-07 markup) ──
// ➤ A "fake" LinkedIn page snippet (copied from the real format) to test that
// ➤ the card reader correctly pulls out title, company, location and link.
const LI_FIXTURE = `
<li><div class="base-card" data-entity-urn="urn:li:jobPosting:4436766326">
<h3 class="base-search-card__title"> Offshore Methods Engineer </h3>
<h4 class="base-search-card__subtitle"><a href="x"> Multi.engineering </a></h4>
<span class="job-search-card__location"> The Randstad, Netherlands </span></div></li>
<li><div class="base-card" data-entity-urn="urn:li:jobPosting:99">
<h3 class="base-search-card__title"> Junior Naval Architect </h3>
<h4 class="base-search-card__subtitle"> Damen </h4>
<span class="job-search-card__location"> Gorinchem, Netherlands </span></div></li>`;
// ➤ Checks that the 2 offers were read and that each field came out right.
const liCards = parseLinkedInCards(LI_FIXTURE);
check(liCards.length === 2, 'LI parser card count', String(liCards.length));
check(liCards[0]?.title === 'Offshore Methods Engineer', 'LI parser title', liCards[0]?.title);
check(liCards[0]?.company === 'Multi.engineering', 'LI parser company (linked)', liCards[0]?.company);
check(liCards[1]?.company === 'Damen', 'LI parser company (plain)', liCards[1]?.company);
check(liCards[0]?.url === 'https://www.linkedin.com/jobs/view/4436766326', 'LI parser url', liCards[0]?.url);
check(liCards[1]?.location === 'Gorinchem, Netherlands', 'LI parser location', liCards[1]?.location);

// ── Years-of-experience extraction (requirements.mjs) ──────────────────
// ➤ Each row is [text of an offer, years the extractor must read].
// ➤ "null" means "asks for no years" → the offer is kept just in case.
const YEARS = [
  // the six real rejections (EN)
  ['We are looking for a candidate with 10 years of experience in oil & gas', 10],
  ['Requires 2 years of experience in process automation', 2],
  ["5+ years of full-stack development experience required", 5],
  ['At least 5 years of experience in turbomachinery design', 5],
  ['6 years of experience with utility-scale PV projects', 6],
  // ranges take the low end
  ['3-5 years of relevant experience', 3],
  ['3 to 5 years experience in offshore engineering', 3],
  ['We ask for 3 a 5 años de experiencia en el sector', 3],
  // multilingual minimum phrasings
  ['Se requieren 5 años de experiencia demostrable', 5],
  ['Mínimo 8 años de experiencia en gestión de proyectos', 8],
  ["5 anys d'experiència en enginyeria", 5],
  ["Minimum 3 ans d'expérience exigés", 3],
  ['Mindestens 5 Jahre Berufserfahrung', 5],
  ['Minimaal 5 jaar ervaring in de sector', 5],
  // several requirements → the minimum wins (bias to keep)
  ['2 years of experience with Python; 8 years in leadership', 2],
  // junior bands and unknowns → null (kept)
  ['0-2 years experience, graduates welcome', null],
  ['Graduate role, no prior experience required', null],
  ['', null],
  // hard negatives: a number + "year(s)" that is NOT a requirement
  ['Over the past 3 years the company has grown fast', null],
  ['This is a 5 year strategic plan for the region', null],
  ['I moved here 3 years ago and love it', null],
  ['Join our team of 12 engineers on a 2 year project', null],
  // precision (2026-07-06): a number must be tied to an EXPERIENCE word,
  // and company boasts must NOT be read as a candidate requirement
  ['Minimum 3 years as a project engineer', null],           // no "experience" word
  ['Minimum 3 years warranty on all our products', null],    // "years" ≠ experience
  ['Our team has over 20 years of combined experience', null], // NEG: combined
  ['With more than 15 years in the market, we deliver', null], // NEG: in the market
  ['Empresa con más de 10 años en el mercado del sector', null], // NEG: en el mercado
  ['Founded 12 years ago, we design offshore systems', null], // NEG: founded
  // round 2 boasts (real Adzuna false positives, 2026-07-08): company/team tenure
  ['For over 25 years, our experience in wind energy has grown', null], // for over / our experi
  ["With over 20 years' experience, we deliver offshore wind", null],   // with over
  ['ervaren projectingenieurs, sommige met 25 jaar ervaring in bouw', null], // NL: sommige
  ['We have 18 years serving the maritime industry', null],            // we have / years serving
  // …but a real candidate requirement right next to "you" still fires
  ['You have 5 years of experience in offshore engineering', 5],
  // 3+ digit numbers are company history, never a requirement (GE, live 2026-07-08)
  ['building on over 130 years of experience tackling the world', null],
  ['A legacy of 130 years of experience in engineering', null],
  ['based on over 40 years of experience serving industry', null], // NEG: on over / years serving
  // "more than X" means X+1 (#372: "más de 3 años" slipped under max 3)
  ['Requires more than 3 years of experience in industrial robotics', 4],
  ['Más de 3 años de experiencia en programación PLC', 4],
  // requirement VERBS count even without the word "experience" (#528:
  // "the role requires 5+ years in WMS projects" slipped through)
  ['The role requires 5+ years in WMS projects, strong logistics know-how', 5],
  ['Se requieren 5 años en proyectos industriales similares', 5],
  ['You bring 4 years in offshore commissioning', 4],
  // …but product warranties must NOT count as a requirement
  ['This product requires a 2 year warranty registration', null],
  ['Garantía de 5 años en todos nuestros productos', null],
  // ➤ Over-block catch (2026-07-18): NEGATED years = good news → null.
  // ➤ "If it demands it, drop it; if it doesn't say so or says it's NOT required, keep it."
  ["You don't need 5 years of experience to apply", null],
  ['5 years of experience is not required.', null],
  ['No necesitas 3 años de experiencia para aplicar', null],
  ['Sie brauchen keine 5 Jahre Erfahrung', null],
  ["Vous n'avez pas besoin de 5 ans d'expérience", null],
  ['no importa si tienes 5 años de experiencia o ninguno', null],
  ['Whether you have 2 or 10 years of experience, apply', null],
  // ➤ SOFTENED years ("ideally", "preferred", "se valoran", "a plus") → null
  ['Ideally 4 years of experience', null],
  ['5+ years of experience preferred, but not required', null],
  ['Se valoran 5 años de experiencia', null],
  ['5 years of experience would be a plus', null],
  ['5 years of experience would be an asset', null],
  // ➤ CEILING, not minimum ("up to", "máximo") → null
  ['Up to 5 years of experience welcome', null],
  ['Máximo 5 años de experiencia', null],
  // ➤ a range with "or"/"o" takes the LOW end (before it read the high one)
  ['We welcome candidates with 2 or 5 years of experience', 2],
  ['Buscamos perfiles con 2 o 5 años de experiencia', 2],
  // ➤ audit 2026-07-18: the contract DURATION is not experience — it must not
  // ➤ eat (via the minimum rule) a real nearby requirement
  ['Contrato de 1 o 2 años. Se requieren 5 años de experiencia', 5],
  ['Wij bieden een contract van 1 of 2 jaar. Minimaal 5 jaar ervaring vereist', 5],
  // ➤ ...but a "contract" in ANOTHER sentence does not cancel a real requirement
  ['Permanent contract. 5 years of experience required', 5],
  // ➤ ...but the guards are PER SENTENCE: a "plus" or a ";" about something else
  // ➤ does not cancel a REAL years requirement (the opposite direction still holds)
  ['Minimum 5 years of experience required. German is a plus', 5],
  ['At least 4 years of experience; a company car is a bonus', 4],
  // ➤ Audit 2026-07-18 — "not mandatory"/"optional" are also negation/
  // ➤ softening (they were missing from the lists):
  ['5 years of experience is not mandatory for this role.', null],
  ['5 years of experience is optional but appreciated', null],
  ['Having 5 years of experience is not compulsory to apply', null],
  ['No es obligatorio tener 8 años de experiencia previa', null],
  // ➤ Audit — "X or more years" wasn't matching at all:
  ['The ideal candidate has 3 or more years of experience', 3],
  ['Se requiere 3 o más años de experiencia demostrable', 3],
  // ➤ Audit — guards by COMMA-segment: a softening/negation about ANOTHER
  // ➤ topic at the start of the sentence no longer cancels the real requirement...
  ['Preferred candidates are flexible on start date, and must have 5 years of experience in mechanical design.', 5],
  ['There is no dress code required in the office, and candidates must have 6 years of experience in engineering.', 6],
  // ➤ ...but the short softening stuck right on ("Ideally,") and the negation in
  // ➤ the following segment ("aunque no imprescindibles") still protect:
  ['Ideally, 4 years of experience in the field', null],
  ['5 years of experience, though not required, would be great', null],
];
// ➤ Goes through the cases and verifies the extractor reads the correct years.
for (const [text, expected] of YEARS) {
  check(extractRequiredYears(text) === expected, `years=${expected}`, JSON.stringify(text).slice(0, 55));
}
// ➤ stripHtml cleans the page code (HTML) and leaves only the plain text.
check(stripHtml('<p>5 years&nbsp;of&nbsp;experience</p>') === '5 years of experience', 'stripHtml', 'entities');
check(extractRequiredYears(stripHtml('<li>Requires 7+ years&#39; experience</li>')) === 7, 'years via stripHtml', '7+');
// Inline formatting tags and HTML comments appear MID-WORD in real postings
// ("<strong>de 3 a</strong>ños" — offer #526, 2026-07-13): they must vanish
// WITHOUT leaving a space, or "años" breaks and the years screen goes blind.
check(stripHtml('experiencia de 3 a<!---->ños en automatización') === 'experiencia de 3 años en automatización', 'stripHtml', 'mid-word comment');
check(stripHtml('Experiencia orientativa <strong>de 3 a</strong>ños en automatización') === 'Experiencia orientativa de 3 años en automatización', 'stripHtml', 'mid-word strong');
check(extractRequiredYears(stripHtml('<li>Experiencia orientativa <strong>de 3 a</strong>ños en automatización industrial, maquinaria</li>')) === 3, 'years via stripHtml', 'strong-split años (#526)');
// …but BLOCK tags still separate words ("<p>foo</p><p>bar</p>" ≠ "foobar")
check(stripHtml('<p>5 years</p><p>experience</p>') === '5 years experience', 'stripHtml', 'block tags separate');
// ➤ Improvement 2026-07-18 (approved): each BULLET (</li>) closes as a PERIOD, so
// ➤ that an "is a plus" from a neighboring bullet doesn't cancel the real one
// ➤ next to it (real WtbE case: "Minimaal 5 jaar" slipped in via "is een pre").
check(stripHtml('<ul><li>Minimum 5 years of experience</li><li>German is a plus</li></ul>') === 'Minimum 5 years of experience. German is a plus.', 'stripHtml', 'li → period');
check(extractRequiredYears(stripHtml('<ul><li>Minimum 5 years of experience</li><li>German is a plus</li></ul>')) === 5, 'years via li-period', 'neighboring plus no longer cancels');
check(experienceScreen(stripHtml('<li>Minimaal 5 jaar relevante ervaring in de zware machinebouw</li><li>Ervaring met Autodesk Inventor, RSTAD is een pre</li>'), 'Design Engineer', 2)?.drop === true, 'screen via li-period', 'real WtbE case → drop');
check(stripHtml('<li>Done.</li><li>Next</li>') === 'Done. Next.', 'stripHtml', 'double period merged');
// extractAdzunaJd: pull the clean JD region out of an Adzuna details page
// (real container verified live 2026-07-13: <section class="adp-body ...">)
check(extractAdzunaJd('<nav>Menú français</nav><section class="adp-body mx-4 text-sm">Contexte : <strong>Riser Engineer</strong>, 2 ans requis</section><footer>Emplois</footer>')
  === 'Contexte : Riser Engineer, 2 ans requis', 'extractAdzunaJd', 'region');
check(extractAdzunaJd('<div>no marker here</div>') === '', 'extractAdzunaJd', 'no region → empty');

// ── experienceScreen: years AND field (#527, 2026-07-13) ─────────
// "2 años en un puesto similar" on a PLC job disqualifies the user (0 PLC years)
// even though 2 ≤ threshold; the same 2 years in HIS fields (mooring) is OK.
// Cases: [description, title, expected {drop, why} or null]
const SCREEN = [
  // the real #527 phrasing → drop by field-mismatch
  ['Se requieren 2 años de experiencia en un puesto similar', 'Programador/a PLC (M/F/D)', true, 'field-mismatch'],
  ['You have 2 years of experience in a similar role', 'Junior Automation Engineer', true, 'field-mismatch'],
  ['Requires 2 years of PLC programming experience', 'Automation & Controls Engineer', true, 'field-mismatch'],
  ['Requires 1 year of experience with SCADA systems', 'Control Systems Engineer', true, 'field-mismatch'],
  // small years in the user's real fields → keep
  ['2 years of mooring experience required', 'Mooring Engineer', false, 'within-threshold'],
  ['You have 2 years of experience in a similar role', 'Offshore Mooring Engineer', false, 'within-threshold'],
  ['Requires 1 year of hydrographic survey experience', 'Junior Surveyor', false, 'within-threshold'],
  // maritime stems across languages must count as HIS sector (Alphatron case:
  // "maritieme" (NL) didn't match the old "maritim" stem and false-dropped)
  ['Minimaal 2 jaar ervaring in installatie van maritieme systemen', 'Installation & Commissioning Engineer', false, 'within-threshold'],
  ['2 años de experiencia en el sector marítimo requeridos', 'Project Engineer', false, 'within-threshold'],
  // small GENERIC years → keep (no specific field demanded)
  ['2 years of relevant professional experience required', 'Junior Automation Engineer', false, 'within-threshold'],
  // over threshold → drop regardless of field
  ['The role requires 5+ years in WMS projects', 'Solution Architect', true, 'over-threshold'],
  ['Requires 4 years of mooring experience', 'Mooring Engineer', true, 'over-threshold'],
  // ➤ "SEVERAL years" without a number (2026-07-19, #632 Sartorius): mehrjährige/
  // ➤ several/varios counts as at least 3 → above the cap of 2.
  ['Du bringst mehrjährige Berufserfahrung in der Programmierung von Automatisierungslösungen mit', 'Process Automation Engineer (x w m)', true, 'over-threshold'],
  ['Several years of professional experience in automation required', 'Process Engineer', true, 'over-threshold'],
  ['Se requieren varios años de experiencia en automatización', 'Ingeniero de Automatización', true, 'over-threshold'],
];
for (const [text, ttl, drop, why] of SCREEN) {
  const v = experienceScreen(text, ttl, 2);
  const ok = v && v.drop === drop && v.why === why;
  check(ok, `screen ${why} drop=${drop}`, `${ttl}: ${text.slice(0, 45)}`);
}
check(experienceScreen('Graduates welcome, no experience needed', 'Junior Engineer', 2) === null, 'screen null', 'no years stated');

// ── degreeScreen: body demands a degree the user lacks (2026-07-16) ──
// The bot sent a Project Engineer whose BODY required a master in
// mechanical/electrical engineering — title clean, body impossible.
const DEG_DROP = [
  // ➤ MASTER'S DEMANDED = out ALWAYS (2026-07-19, P&G case #627/#630):
  // ➤ the field doesn't matter and it doesn't matter if the title is automation.
  "Master's degree in Electrical Engineering, Automation & Controls, Robotics, Computer Engineering, Mechanical Engineering, or a related engineering discipline",
  'MSc in Offshore, Mechanical or related Engineering',
  "Master's degree in Electrical, Electromechanical or Energy Engineering",   // #169 Vulcain
  'Se requiere máster en electrónica o parecido',                            // #13 ALTEN
  "Bachelor's or Master's degree in Mechanical / Industrial Engineering",    // #96
  'You hold a degree in Mechanical Engineering',
  'Diplôme en génie civil exigé',
  'Degree in electrical engineering required',
  'Grado en ingeniería eléctrica',                     // audit Fix B: accented eléctrica now caught
  // ➤ catch 2026-07-18: a negation of ANOTHER thing in the following sentence does
  // ➤ NOT soften a genuinely demanded degree (the guards are per sentence)
  'A degree in mechanical engineering is required. German is not required',
  // ➤ audit: a "nice to have" about ANOTHER topic at the start of the sentence, or an
  // ➤ "or equivalent" from an UNRELATED following sentence, no longer soften
  'We offer flexible remote work as a nice to have for the team, and a Master degree in Mechanical Engineering is required for this role.',
  'A Bachelor degree in Mechanical Engineering is required for this position. Relocation assistance or equivalent support may be provided if needed.',
];
for (const d of DEG_DROP) check(degreeScreen(d) === true, 'degree should DROP', d.slice(0, 55));
// sector escape: a title in the user's field is NEVER degree-dropped, even if the
// body demands electromechanical/civil (real: We ARE Renewables "Project
// Engineer (Offshore Wind)" wanting "BSc in electromechanics, civil or related")
check(degreeScreen("bachelor's degree in electromechanics, civil engineering or related", 'Project Engineer (Offshore Wind)') === false, 'degree sector-escape', 'offshore title');
check(degreeScreen("master's degree in mechanical engineering", 'Riser Engineer') === false, 'degree sector-escape', 'riser title');
check(degreeScreen("master's degree in mechanical engineering", 'Project Engineer') === true, 'degree no-escape generic title', 'bare project engineer');
// ➤ 2026-07-27 (#708 RWE): business degrees. The excluded list was all
// ➤ engineering, so a graduate programme wanting Business Administration or
// ➤ Economics was read as "a generic degree" and let through.
check(degreeScreen("a bachelor's, master's or PhD degree in Business Administration, Business Management, Economics or Finance", 'Business Transformation Graduate Programme') === true, 'degree business', '#708 RWE');
check(degreeScreen('Abgeschlossenes Studium der Betriebswirtschaft', 'Graduate Program') === true, 'degree business DE', 'Betriebswirtschaft');
// ➤ ...but a marine degree in the same sentence still saves it.
check(degreeScreen("degree in Economics, Marine Science or a related field", 'Offshore Analyst') === false, 'degree business + su campo', 'marine listed too');
// skills escape: automation/instrumentation/control titles are the user's interest
// — don't degree-drop them (entry-level automation is fine, 2026-07-16)
check(degreeScreen("degree in electrical or mechanical engineering", 'Automation Engineer') === false, 'degree skills-escape', 'automation title');
check(degreeScreen("degree in mechanical engineering required", 'Controls Project Engineer') === false, 'degree skills-escape', 'controls title');
check(degreeScreen("degree in mechanical engineering required", 'Instrumentation Engineer') === false, 'degree skills-escape', 'instrumentation title');
const DEG_KEEP = [
  'Degree in Marine Science, Engineering or a related field',                 // the user's field
  // ➤ ('MSc in Offshore...' was here as KEEP thanks to the marine escape until
  // ➤ 2026-07-19: the user has no master's IN ANYTHING → now it's in DEG_DROP.)
  'A relevant engineering degree is required',                               // generic → keep
  'Bachelor in Automation, Instrumentation or Control',                       // the user's fields
  "Degree in Naval Architecture, Mechanical or Marine Engineering",          // naval/marine present
  'We build mechanical systems; a technical degree helps',                   // no gated-in-degree
  '5 años de experiencia en ingeniería mecánica',                            // audit Fix A: EXPERIENCE phrase, not a degree — no false drop (years filter handles it)
  '',
  // ➤ Over-block catch (2026-07-18): a NEGATED/SOFTENED/ALTERNATIVE degree
  // ➤ or one about ANOTHER PERSON = not a closed door → it stays.
  'A degree in mechanical engineering is not required for this role, we value hands-on experience',
  'No se requiere titulación en ingeniería eléctrica para este puesto',
  'Degree in mechanical engineering or equivalent experience is required',
  "Bachelor's degree in Mechanical or Electrical Engineering is required; however, equivalent experience will be considered in lieu of a degree",
  'A degree in electrical engineering is preferred but not essential',
  'Titulación en ingeniería mecánica valorable pero no excluyente',
  'Ideally a degree in mechanical engineering',
  'Our founder has a degree in mechanical engineering and started the company in his garage',
  // ➤ 2026-07-18 (approved): the degree window no longer crosses periods — a
  // ➤ "mechanical" from the FOLLOWING sentence doesn't turn a generic degree into a veto
  'Bachelor degree required. Experience maintaining mechanical and electrical systems on site.',
  // ➤ Audit: "not mandatory"/"optional" also apply to the degree
  'A Bachelor degree in Mechanical Engineering is not mandatory for this role',
  'A Master degree in Electrical Engineering is optional for this position',
];
for (const d of DEG_KEEP) check(degreeScreen(d) === false, 'degree should KEEP', d.slice(0, 55) || '(empty)');
// ➤ Master's demanded (2026-07-19): pierces the exemption for automation
// ➤ titles (real P&G case #630) — but with the escapes intact: if the sentence
// ➤ also accepts a degree/bachelor (which the user DOES have) or is softened
// ➤ ("preferred"), it stays. And a softened "several years" doesn't drop it either.
check(degreeScreen("Required qualifications: Master's degree in electrical engineering or a related discipline", 'PC&IS/Automation Engineer (F/M/X)') === true, 'master pierce title-safe', 'P&G #630');
check(degreeScreen("Bachelor's or Master's degree in engineering required", 'Project Engineer') === false, 'bachelor alt saves', 'degree or master');
check(degreeScreen("Master's degree preferred but not essential", 'Project Engineer') === false, 'master soft keeps', 'preferred');
check(experienceScreen('Mehrjährige Berufserfahrung wünschenswert', 'Automation Engineer', 2) === null, 'multiyear soft null', 'wünschenswert');

// ── Language rules (2026-07-10) ─────────────────────────────────
// ➤ Titles that demand a language the user does NOT speak (German, French,
// ➤ Dutch): the detector must fire and discard the offer. Rules from
// ➤ 2026-07-10, after the title-stated language of #116 (Celonis) got through. Rules from
// ➤ 2026-07-10, after the title-stated language of #116 (Celonis) got through. Rules from
// ➤ 2026-07-10, after the title-stated language of #116 (Celonis) got through.
const LANG_TITLE_FIRE = [
  'Associate Technology Consultant - Galaxy Graduate Program (German or French speaking)',
  'German speaking Support Engineer',
  'Dutch-speaking Project Coordinator',
];
// ➤ And in these it must not fire: Spanish and English the user does speak.
const LANG_TITLE_NO_FIRE = [
  'Spanish speaking Customer Advisor',   // the user speaks Spanish
  'Offshore Engineer',
  'English speaking Automation Engineer',
];
for (const t of LANG_TITLE_FIRE) check(titleDemandsForeignLanguage(t) === true, 'title lang should FIRE', t);
for (const t of LANG_TITLE_NO_FIRE) check(titleDemandsForeignLanguage(t) === false, 'title lang should NOT fire', t);

// ➤ Body language rule, nuanced (2026-07-18): the language the offer is
// ➤ WRITTEN in no longer discards it (that's why there are no body-language
// ➤ detection tests). What DOES discard it is the body DEMANDING a language
// ➤ the user doesn't speak — and "valorable/plus" does NOT count as a demand.
// ➤ Each row is [offer body text, true if it should be blocked].
const BODY_LANG = [
  ['You are fluent in German, both written and spoken', true],       // #294-type
  ['Deutschkenntnisse erforderlich', true],
  ['Talen: Nederlands', true],                                       // #483 Actemium
  // ➤ 2026-07-27: Dutch blocks like the rest. It was briefly exempted because the
  // ➤ owner had applied to #705 with "Je communiceert vlot in het Nederlands",
  // ➤ until they confirmed that application was their own slip. So the ordinary
  // ➤ rule holds for every language: a real demand drops it, "a plus" keeps it.
  ['Je communiceert vlot in het Nederlands en Engels', true],        // #705
  ['Je spreekt vlot Nederlands en Engels', true],                    // #713
  ['Je beheerst het Nederlands en Engels goed', true],               // #698
  ['Je beheerst de Nederlandse en Engelse taal', true],              // #696
  // ➤ ...and the Dutch ways of saying "it would be nice", which must NOT block.
  ['Kennis van het Nederlands strekt tot aanbeveling', false],
  ['Nederlands is meegenomen', false],
  ['Kennis van het Frans is wenselijk', false],
  // ➤ The German and French phrasings that used to walk straight through. Every
  // ➤ one of these is a literal sentence from an offer the owner rejected by hand.
  ['Deutsch und Englisch fließend in Wort und Schrift', true],        // #697 1Komma5
  ['Sehr gute Deutsch- und Englischkenntnisse in Wort und Schrift', true],  // #719 MTG
  ['Verhandlungssichere Deutsch- und Englischkenntnisse', true],      // #699 Job-Room
  ['Stilsichere Deutschkenntnisse', true],                           // #700 ROCKEN
  ['Deutsch und Englisch beherrschst Du im geschäftlichen Umfeld sicher', true],  // #690 Arcplace
  ['Vous maîtrisez le français et l\'anglais', true],
  ['Français courant exigé', true],
  // ➤ And the guards that keep it from over-firing:
  ['Wir sind ein Unternehmen aus Deutschland mit sehr guten Aussichten', false],  // el PAÍS, no el idioma
  ['Sehr gute Excel-Kenntnisse und Erfahrung mit CAD', false],       // "gute Kenntnisse" sin idioma
  ['Gute Deutschkenntnisse sind ein Plus', false],                   // "ein Plus" ablanda
  ['Deutschkenntnisse sind von Vorteil', false],
  ['Inglés avanzado (C1) y Alemán obligatorios', true],              // #171-type
  ['French: C1 required for daily client contact', true],
  ['French (B2) - compulsory', true],                                 // real MSF phrasing (2026-07-16)
  ['German is a plus', false],                                       // plus → valid (the user's rule)
  ['Fluent German is nice to have but not required', false],
  ['Dutch would be desirable, English is our working language', false],
  ['Nederlands is een pluspunt', false],
  ['We work in English; no other languages needed', false],
  // real DNV JD that false-flagged in production (2026-07-10): the "fluent"
  // belongs to English, and German is only an advantage
  ['Fluent in English; knowledge of German or other local languages is an advantage', false],
  ['Fluent English required. German would be an asset', false],
  // audit Fix C: a "plus" for a DIFFERENT language must not soften a REQUIRED one
  ['German required. English is a plus', true],
  ['Fluent German, which is a plus for the team', false],   // same clause → softened
  ['', false],
  // ➤ The user's rule (2026-07-18): a NEGATED requirement = good news → IT STAYS.
  // ➤ "If it demands it, drop it; if it doesn't say so or says it's NOT required, keep it."
  ['No German required', false],
  ['German is not compulsory for this role', false],
  ['Kein Deutsch erforderlich', false],                      // DE: "no German needed"
  ['Geen Nederlands vereist, Engels volstaat', false],       // NL: "no Dutch required"
  ['No se requiere alemán para este puesto', false],
  ['French is not necessary; English suffices', false],
  // ➤ ...but the AFFIRMATIVE demand still discards, in Spanish too, and a
  // ➤ negation in ANOTHER sentence doesn't soften a real requirement.
  ['Se requiere alemán fluido para el trato diario', true],
  ['German required. English not necessary', true],
  // ➤ Over-block catch (2026-07-18): negation with the noun "requirement",
  // ➤ question-answer format, a clarification in the following sentence about THIS
  // ➤ role, and "only for senior" → all of them STAY.
  ['Fluent German is not a hard requirement', false],
  ['Is Dutch required? No, English suffices for this role.', false],
  ['Is German mandatory? No.', false],
  ['Note: French is required only for senior positions; this junior role does not require it.', false],
  ['French required only for senior roles.', false],
  // ➤ audit 2026-07-18: the bare English verb "require(s)" was missing from
  // ➤ both lists — the negation with it didn't soften, and the demand with it
  // ➤ wasn't detected
  ['German required; however, this position does not require German.', false],
  ['This position requires German for daily client communication', true],
  // ➤ audit: the SAME language negated in the following sentence, with a normal
  // ➤ prose capital, must also stay (the comparison ignores case)
  ['German required. German is not necessary here.', false],
];
for (const [text, expected] of BODY_LANG) {
  check(bodyLanguageBlock(text) === expected, `bodyLang=${expected}`, JSON.stringify(text).slice(0, 50));
}

// ➤ Anti-Engibex dedup (2026-07-18): a company+title pair only blocks
// ➤ reappearances if the decision was the user's. pipelineRoleKey returns the
// ➤ key if the line blocks, or null if not.
const RK = [
  // visible → blocks (it's already on the user's list)
  ['- [ ] https://x/1 | Engibex | Junior Project Engineer (Offshore) | Brussel | #597', true],
  // hidden by the user (marked "| visto") → blocks forever
  ['- [x] https://x/2 | Engibex | Junior Project Engineer (Offshore) | Brussel | #597 | visto', true],
  // hidden by the BOT (no mark) → does NOT block (the real Engibex case)
  ['- [x] https://x/3 | Engibex | Junior Project Engineer (Offshore) | Brussel', false],
  // a line that isn't an offer → doesn't block
  ['## Pending', false],
  ['', false],
];
for (const [line, blocks] of RK) {
  check((pipelineRoleKey(line) !== null) === blocks, `roleKey blocks=${blocks}`, JSON.stringify(line).slice(0, 60));
}
// ➤ And the key it returns is the same for the visible and the seen one (same offer).
check(pipelineRoleKey(RK[0][0]) === pipelineRoleKey(RK[1][0]), 'roleKey equal', 'visible vs visto');
// ➤ German relistings (Lonza case #595/#602, 2026-07-18): the same role with
// ➤ an extra "(m/f/d)" and/or "80-100%" must give THE SAME key — so the user's "no"
// ➤ to the first blocks the second.
check(pipelineRoleKey('- [x] https://x/4 | Lonza Group AG | DeltaV Automation Engineer 80-100% | #595 | visto')
  === pipelineRoleKey('- [ ] https://x/5 | Lonza Group AG | DeltaV Automation Engineer 80-100% (m/f/d) | Visp | #602'), 'roleKey relisting', 'Lonza (m/f/d)');
check(pipelineRoleKey('- [ ] https://x/6 | zooplus SE | Engineer, Warehouse Automation (All Genders) | #1')
  === pipelineRoleKey('- [ ] https://x/7 | zooplus SE | Engineer, Warehouse Automation | #2'), 'roleKey genders', '(All Genders)');
// ➤ (2026-07-19, Sartorius) the gender tag also with SPACES: "(x w m)".
check(pipelineRoleKey('- [ ] https://x/8 | Sartorius | Process Automation Engineer (x w m) | #3')
  === pipelineRoleKey('- [ ] https://x/9 | Sartorius | Process Automation Engineer | #4'), 'roleKey genders spaces', '(x w m)');

// ── Anti-false-dead (catch 2026-07-18) ──────────────────────────────
// ➤ A LIVE page with an apply button must not be marked "expired" just
// ➤ because some chunk of the HTML (a widget of other offers, some stray text)
// ➤ contains "position has been filled". The second opinion only applies to
// ➤ verdicts from a text PHRASE — a real 404 is still dead.
check(hasApplySignal('Ready to join? Apply now and send your CV') === true, 'applySignal fires', 'apply now');
check(hasApplySignal('This position has been filled. See similar jobs.') === false, 'applySignal quiet', 'no button');
// ➤ Audit 2026-07-18: the second opinion only revives the GENERIC patterns
// ➤ (FAQ/holidays). "position has been filled" is THIS offer's banner — an
// ➤ "Apply Now" from a similar-jobs widget must not revive it.
check(overrideDeadIfApply({ result: 'expired', reason: 'pattern matched: position has been filled' }, 'Other role was filled. Apply now for this job!').result === 'expired', 'override respects filled', 'strong banner → stays dead');
check(overrideDeadIfApply({ result: 'expired', reason: 'pattern matched: applications? closed' }, 'FAQ: applications closed for old roles. Apply now!').result === 'active', 'override revives generic', 'generic pattern + apply → alive');
check(overrideDeadIfApply({ result: 'expired', reason: 'pattern matched: applications closed' }, 'nothing to click here').result === 'expired', 'override respects dead', 'pattern without apply → dead');
check(overrideDeadIfApply({ result: 'expired', reason: 'HTTP 404' }, 'Apply now').result === 'expired', 'override respects 404', '404 = hard proof');
// ➤ Audit: the inverted salary from the API is reordered; "| VISTO" in uppercase
// ➤ (manual edit) also counts as your decision.
check(formatSalary(80000, 20000, false, 'es') === '€20-80k', 'inverted salary', 'min>max reordered');
check(pipelineRoleKey('- [x] https://x/9 | Acme | Engineer | #416 | VISTO') !== null, 'visto uppercase', 'VISTO blocks the same');

// ── Salary and affinity (improvements 2026-07-18) ──────────────────────
// ➤ formatSalary turns Adzuna's numbers into short, honest text:
// ➤ a leading "~" = Adzuna ESTIMATE, not the ad's own figure.
check(formatSalary(35000, 45000, false, 'es') === '€35-45k', 'salary range', '€35-45k');
check(formatSalary(35000, 45000, true, 'es') === '~€35-45k', 'estimated salary', 'has ~');
check(formatSalary(90000, 90000, false, 'ch') === 'CHF 90k', 'Swiss salary', 'CHF');
check(formatSalary(0, 0, false, 'es') === '', 'salary absent', 'empty');
check(formatSalary(500, 900, false, 'es') === '', 'junk salary (<10k)', 'omitted');
// ➤ offerAffinity only ORDERS the display (it never filters): the user's field
// ➤ +2, junior/graduate +1.
check(offerAffinity('Junior Mooring Engineer') === 3, 'max affinity', 'mooring+junior');
check(offerAffinity('Automation Specialist') === 0, 'neutral affinity', 'no signals');
check(offerAffinity('Offshore Wind Analyst') === 2, 'field affinity', 'offshore');

// ── Adzuna links: bounce vs details page (user-flagged, 2026-07-18) ────────
// ➤ The /land/ad/<id> bounce (which dumps you on the XING form without letting
// ➤ you read the offer) and the /details/<id> page are THE SAME offer: normUrl
// ➤ must equalize them so the switch to details pages doesn't "re-discover" what's seen.
const NORM = [
  ['https://www.adzuna.de/land/ad/5795764633?se=abc&v=DEF', 'https://www.adzuna.de/details/5795764633'],
  ['https://www.adzuna.de/details/5795764633?utm_medium=api', 'https://www.adzuna.de/details/5795764633'],
  ['https://www.adzuna.nl/land/ad/123', 'https://www.adzuna.nl/details/123'],
  // ➤ Anything that isn't Adzuna stays as it was (just without query or trailing slash).
  ['https://www.linkedin.com/jobs/view/999?ref=x', 'https://www.linkedin.com/jobs/view/999'],
];
for (const [input, want] of NORM) {
  check(normUrl(input) === want, 'normUrl adzuna', `${input} → ${want}`);
}

// ── Company blacklist (2026-07-18: Amazon) ────────────────
// ➤ With the REAL portals.yml config: it vetoes the whole company (including its
// ➤ compound-named subsidiaries), as a whole word — "Amazonia" passes.
const companyOk = buildCompanyFilter(config.company_filter);
const COMPANY = [
  ['Amazon', false],
  ['Amazon Web Services EMEA SARL', false],
  ['Van Oord', true],
  ['Amazonia Marine Services', true],
];
for (const [name, ok] of COMPANY) {
  check(companyOk(name) === ok, `company ${ok ? 'passes' : 'blocked'}`, name);
}

// ➤ ── THE DUPLICATE KEY (roleKey) ────────────────────────────────────────
// ➤ What makes your "no" stick when a board re-posts the same job under a new
// ➤ link. A mutation that stopped it normalising the en dash — the exact case
// ➤ that made one employer's role appear twice — passed every test there was.
{
  const same = (a, b, why) => check(roleKey(...a) === roleKey(...b), `roleKey: ${why}`, `${a[1]} = ${b[1]}`);
  same(['GE Vernova', 'Power Systems – Lead'], ['GE Vernova', 'Power Systems - Lead'], 'an en dash is not a new job');
  same(['GE Vernova', 'Power Systems — Lead'], ['GE Vernova', 'Power Systems - Lead'], 'nor an em dash');
  same(['Lonza', 'Engineer (m/w/d)'], ['Lonza', 'Engineer'], 'nor a gender tag');
  same(['Lonza', 'Engineer (All Genders)'], ['Lonza', 'Engineer'], 'however it is written');
  same(['Sartorius', 'Engineer (x w m)'], ['Sartorius', 'Engineer'], 'even separated by spaces');
  same(['Lonza', 'Engineer 80-100%'], ['Lonza', 'Engineer'], 'nor a workload percentage');
  same(['Acme', 'Engineer  '], ['Acme', 'Engineer'], 'nor trailing space');
  check(roleKey('Acme', 'Engineer') !== roleKey('Acme', 'Surveyor'), 'roleKey: a different role IS a different job', 'Engineer vs Surveyor');
  check(roleKey('Acme', 'Engineer') !== roleKey('Beta', 'Engineer'), 'roleKey: and a different company', 'Acme vs Beta');
}

// ➤ ── AN ACRONYM POSITIVE IS A WHOLE WORD ────────────────────────────────
// ➤ "GIS" must not match inside "Logistiek". The rule exists because it once
// ➤ did; nothing tested it, and switching it off passed the whole suite.
{
  const t = buildTitleFilter({ positive: ['GIS', 'PLC', 'Engineer'], negative: [] });
  check(t('GIS Specialist'), 'an acronym matches as a word', 'GIS Specialist');
  check(t('PLC Programmer'), 'and so does the other one', 'PLC Programmer');
  check(!t('Medewerker Logistiek'), 'but never inside another word', 'Logistiek contains gis');
  check(!t('Bagisto Developer'), 'nor in the middle of one', 'Bagisto contains gis');
  // ➤ A non-acronym positive stays a plain substring, which is what makes
  // ➤ "engineer" match "engineering".
  check(t('Engineering Manager'), 'a normal keyword still matches inside a longer word', 'Engineering');
}

// ➤ ── ONE SEAT YOU CAN TAKE IS ENOUGH ────────────────────────────────────
// ➤ A posting open in several places arrives as ONE string — Teamtailor joins
// ➤ them with "; " — and read whole it was vetoed outright, because the block
// ➤ list saw the foreign half. The job in the allowed city was real.
{
  const loc = buildLocationFilter({ allow: ['España', 'Netherlands'], block: ['Dubai', 'Qatar'] });
  check(loc('Barcelona, España; Dubai, AE'), 'a job with one seat in your range survives the other', 'BCN; Dubai');
  check(loc('Dubai, AE; Barcelona, España'), 'and the order does not matter', 'Dubai; BCN');
  check(!loc('Dubai, AE; Doha, Qatar'), 'while one with no seat in your range still goes', 'Dubai; Doha');
  check(!loc('Dubai, AE'), 'a single blocked place is unaffected', 'Dubai');
  check(loc('Rotterdam, Netherlands'), 'and so is a single allowed one', 'Rotterdam');
}

// ➤ ── AN AGGREGATOR IS NOT AN EMPLOYER ───────────────────────────────────
// ➤ Adzuna hides the advertiser on plenty of ads and the parser wrote its own
// ➤ name into the field, so every anonymous "Offshore Engineer" in the country
// ➤ shared one company+role key and the second was discarded as a repost.
{
  check(roleKey('Adzuna', 'Offshore Engineer') === '', 'an unnamed advertiser yields no role key', 'Adzuna');
  check(roleKey('', 'Offshore Engineer') === '', 'and neither does an empty company', '(empty)');
  check(roleKey('LinkedIn', 'Offshore Engineer') === '', 'nor does the LinkedIn placeholder name', 'LinkedIn');
  check(roleKey('Van Oord', 'Offshore Engineer') === roleKey('Van Oord', 'Offshore Engineer'),
    'a real employer still keys the same both times', 'Van Oord');
  check(roleKey('Van Oord', 'Offshore Engineer') !== roleKey('Boskalis', 'Offshore Engineer'),
    'and two employers with one title are two roles', 'two employers');

  // ➤ THE KEY MUST MATCH THE ONE REBUILT FROM DISK. It is made from the title as
  // ➤ the BOARD sent it, while pipeline.md holds the title after the entities
  // ➤ were decoded — so the two never met and the barrier was dead for the 9 of
  // ➤ 1,016 real titles that carry one. LinkedIn double-escapes, hence the third.
  const limpio = roleKey('ACME', 'Automation & Controls Engineer');
  check(roleKey('ACME', 'Automation &amp; Controls Engineer') === limpio,
    'an entity in the title keys the same as the decoded form on disk', '&amp;');
  check(roleKey('ACME', 'Automation &amp;amp; Controls Engineer') === limpio,
    'and so does a double-escaped one, which is what LinkedIn sends', '&amp;amp;');
  check(roleKey('ACME', 'Instrumentaci&oacute;n y Control') === roleKey('ACME', 'Instrumentaci&oacute;n y Control'),
    'an entity this project does not decode is at least stable', '&oacute;');
}

// ➤ ── AN EMPTY KEY MUST NOT BECOME A KEY ─────────────────────────────────
// ➤ roleKey answers '' for an unnamed advertiser, and a set that has been fed
// ➤ '' — one 'Adzuna' line in pipeline.md is enough — would then match EVERY
// ➤ anonymous offer at the door, whatever its title. Both sides must skip an
// ➤ empty key: nothing writes it, and the gate never compares against it.
// ➤ Functional on purpose: a text check on the fix let a broken port pass.
{
  const pass = Object.assign(() => true, { explain: () => '' });
  const locPass = Object.assign(() => true, { blockHit: () => false });
  const gates = { companyFilter: pass, titleFilter: pass, locationFilter: locPass,
    country: { fn: () => true }, seenUrls: new Set(), seenRoles: new Set(['']) };
  check(admissionVerdict({ url: 'https://x.example/a', company: 'Adzuna', title: 'Role A' }, gates).ok === true,
    'a poisoned empty key blocks no anonymous offer', "set con ''");
  check(admissionVerdict({ company: 'X', title: 'T' }, gates).stage === 'NO LINK',
    'and the first gate still refuses a missing link', 'sin url');
}

// ➤ ── ENGLISH AS AN ALTERNATIVE IS NOT A DEMAND ───────────────────────
// ➤ "German or English speaking" accepts English, so he qualifies — it was
// ➤ dropped as if German were mandatory. Only "and" chains both into a real
// ➤ requirement, and a bare country name is not a language at all.
{
  check(!titleDemandsForeignLanguage('German or English speaking Engineer'), 'an English alternative keeps the offer', 'or');
  check(!titleDemandsForeignLanguage('Dutch/English speaking Consultant'), 'a slash reads as an alternative too', '/');
  check(!titleDemandsForeignLanguage('Sales Engineer - Germany'), 'a country name is not a language demand', 'Germany');
  check(titleDemandsForeignLanguage('German speaking Support Engineer'), 'a real demand still drops', 'German only');
  check(titleDemandsForeignLanguage('Engineer (English and German speaking)'), '"and" demands both; English does not save it', 'and');
}

// ➤ ── A HAND-TYPED TOGGLE COUNTS ───────────────────────────────────────
// ➤ countries.yml is edited by hand, and js-yaml follows YAML 1.2: `no` and
// ➤ `off` arrive as STRINGS, so `Germany: no` switched nothing off and said
// ➤ nothing. Every written form of "off" must work.
{
  for (const v of [false, 'no', 'off', 'false', 'NO']) {
    const f = buildCountryFilter({ countries: { Germany: v }, aliases: {} });
    check(f.off.length === 1 && !f.fn('Berlin, Germany'), 'a written form of off switches the country off', JSON.stringify(v));
  }
  const on = buildCountryFilter({ countries: { Germany: true }, aliases: {} });
  check(on.off.length === 0 && on.fn('Berlin, Germany'), 'and true leaves it on', 'true');
}

// ➤ ── A STUDENT ROLE IN GERMAN IS STILL A STUDENT ROLE ───────────────
// ➤ "Bacheloranden (m/w/d) – Digitales Netzmonitoring & GIS" reached the
// ➤ phone (#753): the free language detector read that title as English and
// ➤ no negative knew the German word for a thesis student. The -en plural
// ➤ lives in the negative tail, where it also covers Senioren or Professoren.
{
  check(!title('Bacheloranden (m/w/d) – Digitales Netzmonitoring & GIS'),
    'a German thesis-student title is blocked', 'Bacheloranden #753');
  check(!title('GIS Student Assistant'), 'a plain student title is blocked', 'Student');
  check(!title('GIS-Doktoranden gesucht'), 'the German -en plural does not dodge the rule', 'Doktoranden');
  check(title('GIS Engineer (m/w/d)'), 'while a real engineering title still passes', 'control');
}

// ➤ ── A CURLY APOSTROPHE IS STILL AN APOSTROPHE ─────────────────────
// ➤ A real posting wrote "A Master’s degree" with U+2019 and the master's rule
// ➤ never matched — the one rule that pierces the automation-title exemption,
// ➤ so the offer reached the phone and the Council said yes to it.
{
  const cuerpo = 'Education: A Master’s degree in Engineering or Computer Science with a heart for engineering;. Coding Mastery: deep expertise in Python.';
  check(degreeScreen(cuerpo, 'Automation Engineer Digital Enablement Team') === true,
    'a curly-apostrophe Master’s still pierces an automation title', 'U+2019');
  check(degreeScreen(cuerpo.replace('A Master’s degree', 'A Master’s or Bachelor’s degree'), 'Automation Engineer') === false,
    'while a Bachelor alternative still saves it', 'bachelor alt');
}

// ➤ ── A WAY OF WORKING IS NOT A PLACE ────────────────────────────────────
// ➤ "Hybrid" sat in the list of allowed PLACES, so "Nationwide, Hybrid, US"
// ➤ cleared the geography gate on the strength of that one word — and hybrid
// ➤ means the opposite: you have to be near that office, so the country matters
// ➤ more, not less. Run against the live config, because the hole was in the
// ➤ config and a fixture of my own would not have found it.
{
  check(!location('Nationwide, Hybrid, US'), 'a US hybrid job does not pass as a place', 'US hybrid');
  check(!location('Remote, United States'), 'nor does a US remote one', 'US remote');
  check(location('Rotterdam (Hybrid)'), 'while a hybrid job in an allowed city still does', 'Rotterdam hybrid');
  check(location('Madrid, Hybrid'), 'and so does one in Madrid', 'Madrid hybrid');
  // ➤ "Remote" on its own stays allowed: a remote role may genuinely be doable
  // ➤ from here, and a false drop costs an offer while a false keep costs a tap.
  check(location('Remote'), 'a plain remote job is still worth showing', 'Remote');
}

// ➤ ── CAREERS SITES WITH NO API AT ALL ───────────────────────────────────
// ➤ Van Oord and Boskalis run theirs in the browser, so a fetch gets an empty
// ➤ shell — and both are on the tracked list. Their sitemaps name every vacancy
// ➤ and each vacancy page carries a schema.org JobPosting block.
{
  // ➤ The slug is what the title filter reads, so that only the handful of
  // ➤ relevant pages are ever downloaded. It has to survive the id on the end.
  check(slugTitle('https://careers.vanoord.com/vacancies/production-automation-system-engineer-rotterdam-2807en')
    === 'production automation system engineer rotterdam', 'sitemap: the slug gives up the title', 'van oord');
  check(slugTitle('https://careers.boskalis.com/vacancy/2361/projectleider-wegenbouw')
    === 'projectleider wegenbouw', 'sitemap: and does so with the id in front too', 'boskalis');
  check(slugTitle('https://x.com/vacancies/mooring-engineer/?utm=1') === 'mooring engineer',
    'sitemap: a trailing slash and a tracking tail are not part of the title', 'tail');
  check(slugTitle('') === '' && slugTitle(null) === '', 'sitemap: no url, no title, no crash', 'empty');
  // ➤ decodeURIComponent throws on malformed percent-encoding, and this runs
  // ➤ once per sitemap URL: one bad link used to take the whole board down.
  check(slugTitle('https://x/vacancies/%ZZ%%%-engineer') === '%ZZ%%% engineer',
    'sitemap: a malformed encoding falls back to the raw slug instead of throwing', '%ZZ');

  const page = `<html><head>
    <script type="application/ld+json">{"@type":"Organization","name":"Van Oord"}</script>
    <script type="application/ld+json">{"@type":"JobPosting","title":"Lifting Supervisor Offshore Wind",
      "description":"<p>Rigging &amp; <b>lifting</b> plans.</p>",
      "jobLocation":[{"@type":"Place","address":{"addressLocality":"Rotterdam","addressCountry":"NL"}}]}</script>
    </head></html>`;
  const job = parseJobPostingLd(page, 'https://careers.vanoord.com/vacancies/x-1', 'Van Oord');
  check(job.title === 'Lifting Supervisor Offshore Wind', 'sitemap: the vacancy block is the one read, not the company one', job.title);
  check(job.location === 'Rotterdam, NL', 'sitemap: where', job.location);
  check(/lifting plans/.test(job._jd) && !/<b>|&amp;/.test(job._jd),
    'sitemap: the advert comes through as plain text', job._jd);
  check(job.company === 'Van Oord', 'sitemap: the employer is the one being scanned, never one the page names', job.company);

  // ➤ A page that stops publishing the block must go quiet, not fill the list
  // ➤ with blank offers.
  check(parseJobPostingLd('<html>nothing here</html>', 'u', 'X') === null, 'sitemap: no block, no offer', 'null');
  check(parseJobPostingLd('<script type="application/ld+json">{oops</script>', 'u', 'X') === null,
    'sitemap: broken JSON is skipped, not thrown', 'null');
  check(parseJobPostingLd('<script type="application/ld+json">{"@type":"JobPosting"}</script>', 'u', 'X') === null,
    'sitemap: a block with no title is not an offer', 'null');
}

// ➤ Final tally: reports the result and returns an exit code (0 = all good)
// ➤ so other scripts can detect it.
console.log(failures === 0
  ? `All ${total} filter tests passed.`
  : `${failures}/${total} tests FAILED.`);
process.exit(failures === 0 ? 0 : 1);
