// ➤ ═══════════════════════════════════════════════════════════════════════
// ➤ WHAT IT IS: the bridge to ESCO — the European Commission's taxonomy of 3,007
// ➤ occupations and 13,896 skills, in 28 languages, free and without an API key. The terms
// ➤ read from a CV become the person's actual occupation(s), each with its ISCO code (the
// ➤ professional area) and its advert-usable job titles. IT NEVER THROWS at the caller: a
// ➤ term ESCO does not know, or no network at all, just yields fewer occupations and the
// ➤ setup falls back to what the CV alone said.
// ➤ ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fold } from './text.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, '.esco-cache');
// ➤ Overridable for tests, like notify's ARGUS_TG_API: the e2e points it at a mock's 404
// ➤ wall so the ESCO stage fails fast and falls back deterministically.
const API = process.env.ARGUS_ESCO_API || 'https://ec.europa.eu/esco/api';


// ➤ ESCO is a fixed classification: the same URI returns the same answer
// ➤ forever. Caching on disk means re-running the setup costs no requests.
async function esco(path, key) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${key.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.json`);
  if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { /* unreadable cache: fetched again below */ } }
  // ➤ With a timeout, like every other request in the project. Without one a
  // ➤ stalled connection hangs the setup with nothing on screen.
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  writeFileSync(file, JSON.stringify(json), 'utf-8');
  return json;
}

// ➤ A label is only useful if a human would put it in a job advert. ESCO's
// ➤ translations are administrative: the Spanish for "aquaculture mooring
// ➤ manager" is "reparador de estructuras de cultivo en instalaciones
// ➤ acuícolas", which no advert has ever said. Long ones and the gendered
// ➤ "masculino/femenino" pairs are dropped, and the shortest survivor wins.
export function usableLabels(labels, { maxWords = 4 } = {}) {
  const out = [];
  for (const raw of labels || []) {
    for (const half of String(raw).split('/')) {
      const s = half.trim();
      if (!s || s.split(/\s+/).length > maxWords) continue;
      if (!out.some(x => fold(x) === fold(s))) out.push(s);
    }
  }
  return out.sort((a, b) => a.length - b.length);
}

// ➤ From a bag of terms to the occupations ESCO says they name. Occupations are searched
// ➤ by NAME, per term — deliberately not ESCO's skill→occupation graph, which exists for
// ➤ surprising jumps and on a mixed CV crowned branch managers and headmasters. A name
// ➤ search speaks the CV's own vocabulary: "accounting" finds accountants, "sales
// ➤ negotiation" finds sales people — so an accountant-and-salesman CV surfaces both.
// ➤ `deps.esco` is injectable so tests run without the network.
export async function occupationsForTerms(terms, { top = 8, perTerm = 2, langs = ['en'], deps = {} } = {}) {
  const d = { esco, ...deps };
  const picked = new Map();
  for (const term of (terms || []).map(t => String(t).trim()).filter(Boolean).slice(0, 12)) {
    try {
      const s = await d.esco(`/search?text=${encodeURIComponent(term)}&language=en&type=occupation&limit=${perTerm}`, `search_occ_${term}`);
      for (const r of (s?._embedded?.results || []).slice(0, perTerm)) {
        const cur = picked.get(r.uri) || { uri: r.uri, title: r.title, terms: [] };
        if (!cur.terms.includes(term)) cur.terms.push(term);
        picked.set(r.uri, cur);
      }
    } catch { /* unknown term or no network: the caller falls back */ }
  }
  const out = [];
  for (const occ of [...picked.values()].slice(0, top)) {
    let detail = null;
    try { detail = await d.esco(`/resource/occupation?uri=${encodeURIComponent(occ.uri)}&language=en`, `occ_${occ.uri}`); } catch { /* label-less is still an occupation */ }
    const pref = detail?.preferredLabel || {};
    const alt = detail?.alternativeLabel || {};
    const labels = {};
    for (const L of langs) labels[L] = usableLabels([pref[L], ...(alt[L] || [])].filter(Boolean));
    out.push({ uri: occ.uri, title: occ.title, terms: occ.terms, code: String(detail?.code || ''), labels });
  }
  return out;
}
