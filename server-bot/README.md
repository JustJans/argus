# The engine — how Argus actually works

> Setup, installation and the command list live in the [main README](../README.md).
> This file is the reference for the engine itself: what each program does, what
> each file holds, and how to change things without breaking them.

**Argus** is the bot's name — the hundred-eyed watchman of Greek myth, who
never sleeps. The variant that adds the Council of judges (The Good, The Bad,
The Ugly) is called **Argus Plus**.

## 1. The funnel

Every two hours the scanner walks the portals and puts each offer through the
same gauntlet. Anything that survives lands on your list and is sent to your
phone. Nothing is deleted quietly: `--explain` writes one line per discarded
offer, with the reason.

```
   PORTALS                       THE FILTER FUNNEL                        YOU
┌─────────────┐   ┌────────────────────────────────────────────────┐   ┌──────────┐
│ Workday (7) │   │ 1 does the title fit? (positive/negative)      │   │ Telegram │
│ Oracle (2)  │──▶│ 2 location/country allowed?                    │──▶│  phone   │
│ Adzuna (7   │   │ 3 is the title in a language you work in?      │   │          │
│  countries) │   │ 4 reads the WHOLE POSTING:                     │   │ search   │
│ LinkedIn    │   │   · asks for more years than your cap? → out   │   │ list     │
└─────────────┘   │   · requires a degree you lack? → out          │   │ cover    │
                  │   · REQUIRES a language you can't speak? → out │   │ seen/no  │
                  │ 5 is the link still alive?                     │   │          │
                  └────────────────────────────────────────────────┘   └──────────┘
                                     │
                              data/pipeline.md
                          (your pending list)
```

> **The language rule, in full.** What language an offer is WRITTEN in does not
> matter: an offer in Dutch that never asks you to speak Dutch can be a good
> one. It is dropped only when the body affirmatively REQUIRES a language you
> do not work in ("Deutschkenntnisse erforderlich", "French C1 required"), and
> not when that language is merely "a plus", mentioned in passing, or
> explicitly *not* required ("no German required").

## 2. The programs

| File | What it does | When it runs |
|---|---|---|
| `scan.mjs` | **The searcher.** Walks every portal, applies the whole funnel, adds what survives to your list and notifies you | Every 2 hours |
| `telegram-listener.mjs` | **The remote control.** Reads what you write to the bot and acts on it | Every minute |
| `notify.mjs` | **The messenger.** Formats the Telegram messages: cleans and translates titles, groups by country, adds the `#numbers` | Used by the others |
| `live-list.mjs` | **The single list.** Deletes the previous list and re-sends the updated one to the bottom of the chat, so there is only ever one | Used by the others |
| `requirements.mjs` | **The offer reader.** Pulls out how many years an offer demands (in 6 languages, without mistaking "a company with 25 years in the market" for a requirement) and whether it needs a degree you lack. Also loads the search profile | Used by scan and housekeep |
| `housekeep.mjs` | **The cleaner.** Re-applies the current filters to the whole list and removes duplicates and dead offers. `--liveness-only` checks links alone | Sundays 09:00 (deep), daily 07:30 (links) |
| `liveness-core.mjs` | Decides whether a posting is still open, from the page itself | Used by scan and housekeep |
| `cover-letter.mjs` | **The letter writer.** Downloads the offer, has Claude write the letter from your CV and your rules, and renders it to PDF | On `cover N` |
| `claude-cli.mjs` | The single shared way of calling the Claude CLI, including telling a real answer from a complaint about limits | Used by the letter and the Council |
| `onboarding.mjs` | The `/start` questionnaire and the `settings` editor. Writes `config/profile.yml` and `cv.md` | On `/start` |
| `list-offers.mjs` | Reads the pending list (and prints it in the console) | By hand |
| `seen.mjs` | Marks offers as seen | Via Telegram |
| `fs-atomic.mjs` | Writes files atomically, so a crash mid-write cannot truncate your list | Used everywhere that writes |
| `argus-council/` | Three LLM judges reviewing offers in **shadow mode** — they vote, they decide nothing. [Its own README](argus-council/README.md) | Optional |
| `argus-discover/` | Asks whether the SEARCH is right, rather than whether an offer is. [Its own README](argus-discover/README.md) | By hand |

### Tests

| File | Covers |
|---|---|
| `test-filter.mjs` | 509 tests — the filters. Run this after touching any rule |
| `test-notify.mjs` | 39 tests — the Telegram message format |
| `test-live-list.mjs` | 9 tests — the single-list bookkeeping |
| `test-robustness.mjs` | 162 tests — the parts that can LOSE DATA or answer wrongly |
| `argus-council/test-council.mjs` | 57 tests — the judges and the vote reader |

`npm test` runs all 776 of them.

## 3. Configuration and data

| File | What it is |
|---|---|
| `../config/profile.yml` | **Who you are.** Target roles, fields, degrees, languages, countries, years cap, deal-breakers. Written by `/start`, editable by hand |
| `../cv.md` | Your CV, in plain Markdown. The letter writer and the judges take every personal fact from here |
| `../modes/_profile.md` | Hard rules that are NOT in your CV: what must never be mentioned, tone |
| `../portals.yml` | **Where offers come from.** Boards queried, search terms, tracked companies, blocked locations, and the title positive/negative lists |
| `countries.yml` | Country name aliases (cities, spellings) used to work out which country an offer is in |
| `../data/pipeline.md` | **Your list.** One line per offer: `- [ ] link \| company \| title \| city \| #number`. Lines you decided on are kept and marked; what the bot removes is deleted from here, with its trace left in the history |
| `../data/scan-history.tsv` | Everything ever accepted, so nothing is offered twice |
| `../data/scan-explain.txt` | One line per DISCARDED offer with its reason (written by `scan.mjs --explain`) |
| `../data/applications.jsonl` | The applications you sent (`applied N`, `longshot N`) |
| `../data/blind-spots.json` | What the title filter keeps throwing away (the `blind` command) |
| `../data/cover-letters.json` | Which offer owns which letter file name |
| `feedback.jsonl` | Your rejections with their reason (`no 412 asks for 5 years`). **This is the calibration record** — the filters should only ever be changed from it |
| `last-scan.json` | Summary of the last scan: found, filtered, whether Telegram worked |
| `telegram-offset.json`, `linkedin-state.json` | Internal memory (last processed message, last LinkedIn hit) |
| `scan.log`, `listener.log` | Activity logs. When something fails, the explanation is here |
| `telegram.json`, `adzuna-key.json`, `claude-token.json` | 🔒 **SECRETS.** Created with mode 600, never committed, never shared |
| `../output/cover-letters/` | The generated letters (PDF + editable text) |

> Everything under `data/` and `output/`, and every secret above, is excluded by
> `.gitignore`. The repository holds the code and the example configuration, and
> nothing you have done with it.

## 4. Changing things

> **Golden rule:** change it locally, run the tests, and only then put it on the
> server. Never edit on the server.

- **Change the years cap** → `config/profile.yml` → `search.max_years`
- **Block a kind of offer** → `portals.yml` → `title_filter.negative`, then
  `node server-bot/test-filter.mjs` (all green, always)
- **Let a kind of offer in** → `title_filter.positive`. Remember the two levels:
  a positive only matters for offers that were FETCHED, so if no query brings
  them in, add the word to `adzuna.queries` too
- **Add a country** → `config/profile.yml` → `search.countries`
- **Add an employer's own board** → `portals.yml` → `tracked_companies`
- **See why offers are dropped** → `node server-bot/scan.mjs --explain --dry-run`
  → `data/scan-explain.txt`
- **See what you never even get shown** → the `blind` command

`--dry-run` is a rehearsal: it does all the work and writes nothing.

## 5. The schedule

| When | What runs |
|---|---|
| Every minute | The listener (your commands) |
| Every 2 hours | The full scan |
| Daily 07:30 | Dead-link check |
| Sundays 09:00 | Deep cleanup of the whole list |

The exact cron lines are in the [main README](../README.md#setup).
