# Discover — is the SEARCH right?

Every other part of Argus judges an offer. These four tools judge the **search**:
whether you are looking for the right things, in the right words, in the first
place. They read; they never edit a filter.

Run them by hand, occasionally. A cron job that emits suggestions nobody reads
is the predictable way this dies.

| Tool | Network | Answers |
|---|---|---|
| `audit-profile.mjs` | none | Is the search aimed at what your CV can actually defend? |
| `esco-match.mjs` | ESCO API | What else are your skills formally required for, and what are those jobs called in each language you search? |
| `harvest-titles.mjs` | job boards | Is anyone actually advertising it, and under what title? |
| `blind-spots.mjs` | none | What does the title filter keep throwing away? |

Read them in that order: the first says whether the aim is right, the second
proposes where else it could aim, the third says whether that aim has a market,
and the fourth watches what is being lost while you decide.

## The problem they exist for

`config/profile.yml` holds a `positive:` list of the words that make a title
worth looking at — and it is written by hand. It therefore encodes what you
**already know** to look for. Anything outside it is not rejected; it is never
seen at all.

That is a real cost, not a hypothetical one. On one measured cycle 1,308 titles
were dropped: 977 by a rule the owner had written deliberately, and 331 purely
for carrying no word from the field list. "Asset Integrity Engineer" was among
those 331.

The list can also be wrong in the **other** direction: full of terms for a field
your CV cannot back up, while the rare, defensible skills in it go unused in the
search. That direction is invisible too, because those applications look like
normal applications — they just never go anywhere. `audit-profile.mjs` is the
piece that finds it, and it is the one that pays first.

## 1. `audit-profile.mjs` — local, no network, no tokens

Cross-reads `cv.md`, `config/profile.yml` and your rejection history, and reports:

- **Search terms with no backing in the CV** — where you are applying into a
  field with no evidence behind you.
- **CV skills absent from the search** — the rare, defensible ones going unused.
- **Your rejection reasons, split into two families** that mean opposite things:
  *"not my field"* (the title should never have reached you — a gap in the
  filters) versus *"my field, short on the requirements"* (the title was right,
  the ad simply asked for more). Only the second family's neighbourhood is worth
  mining for new search terms.

The reason families are matched with word lists at the top of the file. **They
are meant to be edited**: you write those reasons in your own words and your own
language, so no shipped list can know them. A reason it does not recognise is
filed as `other`, never guessed at.

## 2. `esco-match.mjs` — the EU occupation taxonomy

[ESCO](https://esco.ec.europa.eu/) is the European Commission's classification
of occupations and skills: ~3,000 occupations, ~14,000 skills, 28 languages,
free and without an API key. It is asked the useful question — *which
occupations list these skills as ESSENTIAL?* — which is a published fact rather
than a model's opinion, and it gives back the official title in every language
you search in.

Answers are cached in `.esco-cache/` (gitignored): the classification does not
change between runs.

## 3. `harvest-titles.mjs` — what the market calls it

Queries the boards by **skill**, not by assumed job title, collects the job
titles that come back, ranks them by frequency and subtracts the ones your
filters already cover. What remains is the proposal.

A term that returns **zero** adverts is reported as a finding in its own right:
it means the word is not what employers write, which is as useful as a long list
of hits.

Same HTTP-and-JSON path the scan already uses, so it costs nothing per run.

## 4. `blind-spots.mjs` — what you never get shown

Fed by every scan, read with the `blind` command. It records the titles the
filter discarded, in two separate buckets: those a rule of yours killed, and
those that fell purely for carrying no field keyword.

It does not try to guess which of them mattered — ranking them by similarity to
a CV was tried, and it returns "support" and "management". It counts
**recurrence** instead. A one-off barman appears once and goes; a role you are
systematically blind to comes back every week. Recurrence needs no theory about
what your field is, which is the point: the hard cases are exactly the ones no
tidy definition covers.

## What these are NOT

Not "ask a model what jobs suit someone with this degree". That returns the
obvious titles already in your list — plausible, agreeable and useless. Every
tool here starts from evidence: your own files, a published taxonomy, or live
adverts.

An LLM is worth one narrow job, and only **after** a harvest: naming a cluster
("these 12 titles are all ROV/subsea inspection"). Not inventing suggestions
from nothing.

## Rules they obey

1. **Propose, never apply.** Nothing here edits `profile.yml`. A wrongly added
   positive is noise, and cheap; a wrongly added negative silently loses offers,
   and is expensive.
2. **Measure every proposed term against the historical corpus before adopting
   it** — how many titles start and stop passing, listed by name. Careful: the
   accepted-offer history contains only offers that PASSED, so measuring a new
   positive against it is circular. The discards are in `data/scan-explain.txt`.
3. **Scripts, not daemons.** Run, read, act.
4. **Agree a stop bar up front.** If after two rounds a proposed term has not
   produced an offer you actually applied to, retire it.

## The likely outcome, stated in advance

The honest prior is that the audit finds a real mismatch and the harvest finds
little. "Your list was already right" is a valid and cheap negative result, and
should be reported as one rather than padded.
