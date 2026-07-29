# Argus

A personal, automated job searcher. It scans job portals (Workday, Oracle,
Adzuna, LinkedIn) at zero token cost, filters offers against **your** profile,
and sends them over Telegram, where it is controlled with typed commands:
`search`, `list`, `seen N`, `no N [reason]`, `applied N`, `cover N`, `blind`,
`settings`.

It is sector-agnostic: everything specific to you (target roles, fields, degrees,
languages, countries, deal-breakers, CV, judge prompts) lives in
`config/profile.yml` + `cv.md`, not in the code. The defaults ship as a
marine/offshore example — replace them with your own.

## What arrives on Telegram

One single message, grouped by country, replaced in place whenever something
changes — so the bottom of your chat is always the current list. Each line is a
link, and the `#number` is what you type back at it:

```
25/07/2026 — 3 pending offers

BARCELONA
- [NEW] #712 Mooring Engineer - SBM Offshore - 2y exp - €42-54k

NETHERLANDS
- #705 Graduate Offshore Engineer - Van Oord - Rotterdam
- #698 Survey Engineer - Fugro - Nootdorp - €36-48k
```

The years and the salary appear only when the posting actually gives them, so
most lines are just title, employer and city. The salary in particular comes
from Adzuna alone — the other boards do not publish one — and even there only a
minority of postings state it. A `~` in front (`~€36-48k`) would mark a figure
the board estimated rather than one the posting stated; in practice Adzuna has
not returned an estimated one, so you are unlikely to ever see it.

## Setup

**Required:** Node.js 18 or newer (the code uses the built-in `fetch`) and a
Telegram bot token. That is all the job search itself needs.

**On Windows, do all of this inside WSL.** The bot is plain Node and runs
anywhere Node does, but `setup.sh` and the scheduling are Unix-shaped.

**Optional extras**, each one only unlocks its own feature and nothing breaks
without it:

| Extra | Unlocks | Without it |
|---|---|---|
| An [Adzuna API key](https://developer.adzuna.com/) (free) | the Adzuna job board | the other portals still work |
| The Claude CLI, installed and logged in (`npm i -g @anthropic-ai/claude-code`, then `claude setup-token` → `server-bot/claude-token.json`) | `cover N` (AI cover letters) and the Council | searching, filtering and Telegram work exactly the same; the Council ships **off** |
| Chromium (`npx playwright install chromium`) | the cover letter as a PDF | — |

**Quickest way:** `bash setup.sh` walks you through all of it (dependencies,
bot token, chat linking and the cron lines). Or do it by hand:

```bash
npm install
# 1. Create server-bot/telegram.json with the token from @BotFather:
#    {"bot_token": "123456:ABC...", "chat_id": ""}
# 2. Send any message to your bot, then let it learn your chat id:
node server-bot/notify.mjs --setup
# 3. Optional but recommended: an Adzuna API key in server-bot/adzuna-key.json
#    {"app_id": "...", "app_key": "..."}
```

Next, run it on a schedule (the bot does not schedule itself). Do this **before**
the step below: the listener line is the one that receives your Telegram
commands, so until it is running the bot cannot answer, not even `/start`.
`setup.sh` offers to install all four for you; if you skipped it, or you are on
Windows outside WSL (four Task Scheduler entries, same commands and intervals),
here they are:

```cron
*    * * * * cd /path/to/argus && /usr/bin/flock -n /tmp/argus-listener.lock /usr/bin/node server-bot/telegram-listener.mjs >> server-bot/listener.log 2>&1
0 */2 * * * cd /path/to/argus && /usr/bin/flock -n /tmp/argus-scan.lock /usr/bin/node server-bot/scan.mjs >> server-bot/scan.log 2>&1
30 7  * * * cd /path/to/argus && /usr/bin/node server-bot/housekeep.mjs --liveness-only >> server-bot/scan.log 2>&1
0 9   * * 0 cd /path/to/argus && /usr/bin/node server-bot/housekeep.mjs >> server-bot/scan.log 2>&1
```

Finally, build your profile: **send `/start` to the bot.** It walks you through a
short questionnaire (CV + a few questions, some with buttons) and writes
`config/profile.yml` + `cv.md` for you; `settings` re-opens any question to edit
it later. This is the step that makes Argus yours — until you do it, it searches
with the marine/offshore example, so the first list it sends will not be yours.
That is expected, not a fault.

If you would rather not answer questions in a chat, `config/profile.yml` and
`cv.md` can be edited directly instead — every key is commented in place.

## Commands

Typed into the Telegram chat. `N` is the `#number` shown on the offer.

| Command | What it does |
|---|---|
| `search` | run a scan right now instead of waiting for the schedule |
| `list` | re-send the current list of pending offers |
| `seen N [N...]` | remove one or more offers from the list |
| `no N [reason]` | remove an offer **and** record why, in `server-bot/feedback.jsonl` |
| `applied N` | remove it and log it to `data/applications.jsonl` |
| `longshot N [reason]` | the same, but flagged: you applied knowing you fall short |
| `cover N` | write a cover letter for it and send it back as a PDF |
| `blind` | the titles the filter keeps discarding, ranked by how often they come back |
| `settings` | re-open any profile question to change your answer |
| `/start` | first-time setup: builds your profile from a short questionnaire |
| `help` | the same list, inside Telegram |

`longshot` exists because the two facts are different. `applied` tells everything
downstream "this offer suited me"; a hopeful application says the opposite, and
without the distinction your own record argues against you.

The rejections you write with `no N reason` are the point of the whole thing:
they are your calibration record, and the filters should only ever be tightened
or loosened from them.

### Where the search itself is configured

`config/profile.yml` decides **who you are and what is filtered out**.
`portals.yml` decides **where the offers come from**: the job boards queried, the
search terms sent to them, the tracked companies and the blocked locations. The
version shipped here is a **worked marine/offshore example** — a real, running
configuration rather than a stub, so you can see what a finished one looks like.
You do not have to edit it by hand: the `/start` onboarding writes its own `search.queries`,
`search.locations` and `track_example_companies: false` into `config/profile.yml`,
and those take precedence over this file. Edit `portals.yml` only if you want to
add a specific employer board or tune the example itself.

## Structure

The engine lives in `server-bot/`:

- `scan.mjs` — portal scanning and title filters.
- `requirements.mjs` — reads the years of experience and the degree an offer
  demands (in 6 languages) from its body, to drop impossible ones. Also loads
  and exposes the search profile.
- `notify.mjs` / `live-list.mjs` — Telegram messaging. The "live list" is a
  single message that is deleted and re-sent, updated, on every change, leaving
  the commands and confirmations as history.
- `telegram-listener.mjs` — the Telegram remote control (cron every minute).
- `onboarding.mjs` — the `/start` setup + `settings` editor (writes the profile).
- `cover-letter.mjs` — generates cover letters as PDFs (Claude + Chromium).
- `argus-council/` — "The Council": three LLM judges (The Good / The Bad / The Ugly)
  that review the offers in shadow mode, with no decision power. Their prompts
  can be overridden per user via `search.judge_prompts`.
- `argus-discover/` — the tools that ask whether the search itself is right, as
  opposed to whether a given offer is. It audits your profile against your own
  decisions, harvests the job titles a field actually uses, matches you against
  the EU's [ESCO](https://esco.ec.europa.eu/) occupation taxonomy, and records
  what the title filter throws away so a gap in it stops being invisible
  (the `blind` command). Nothing here changes a filter: it only reports.

## When something doesn't work

Every part can be run by hand, and each one prints why it failed:

```bash
npm test                                    # 776 tests; run this first
node server-bot/scan.mjs --dry-run          # scan without writing or notifying
node server-bot/scan.mjs --explain          # why each offer was dropped → data/scan-explain.txt
node server-bot/telegram-listener.mjs       # process pending commands once
node server-bot/housekeep.mjs --dry-run     # what the weekly cleanup would delete
```

- **The bot says nothing.** The listener runs from cron, once a minute — check
  it is actually in `crontab -l`, and read `server-bot/listener.log`.
- **No offers ever arrive.** Run `--explain` and read the file: it has one line
  per discarded offer with the exact reason. If your own field is being
  dropped, the fix is in `config/profile.yml`, not in the code.
- **`cover N` replies with an error.** That command is the one part that needs
  the Claude CLI. The message tells you which of the two is missing (installed,
  or authenticated).
- **Nothing writes anything.** Secrets live in `server-bot/*.json` and are
  created with mode 600; if you copied the folder as another user, check you
  can still read them.

Some behaviour that looks wrong is deliberate, and some of what the bot gets
wrong is knowingly left alone. Both are written down, with the reasoning, in
[KNOWN-LIMITS.md](KNOWN-LIMITS.md) — read it before "fixing" a filter.

## Notes

- **Secrets** (Telegram/Claude tokens, API keys) and **activity data** (offers,
  applications, feedback) are NOT in the repository.
- Everything is plain Node with two dependencies (`js-yaml`, `playwright`), no
  database and no service to sign up for beyond the portals themselves.
- The scan costs zero AI tokens: it is HTTP and JSON. Only `cover N` and the
  optional Council call a model.
