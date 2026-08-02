# Argus

A personal, automated job searcher. It scans job portals (Workday, Oracle,
Adzuna, LinkedIn) at zero token cost, filters offers against **your** profile,
and sends them over Telegram, where it is controlled with typed commands:
`search`, `list`, `seen N`, `no N [reason]`, `applied N`, `cover N`, `mail`,
`blind`, `settings`.

It is sector-agnostic: everything specific to you (target roles, fields, degrees,
languages, countries, deal-breakers, CV, judge prompts) lives in
`config/profile.yml` + `cv.md`, not in the code. The defaults ship as a
marine/offshore example — replace them with your own.

Two subsystems go past filtering and ask whether the filtering itself is right:
**[the Council](#the-council--three-judges-and-why-they-still-do-not-vote)**,
three LLM judges that review offers in shadow and were measured rather than
trusted, and
**[Discover](#discover--auditing-the-search-not-the-offer)**, which
audits the search against your CV, the EU occupation taxonomy, the live market
and its own discards.

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

**Required:** Node.js 20 or newer (the code uses the built-in `fetch`; the
cover-letter printer needs 20) and a Telegram bot token. That is all the job
search itself needs.

**You do not need a server.** The engine is plain Node and runs natively on
Windows, macOS and Linux — a laptop is fine. What it does need is to be awake
when a scan is due: on an always-on machine it works round the clock, and on a
laptop you close at night it simply searches when the laptop is open. Nothing
breaks either way.

**On Windows**, run `setup.sh` from Git Bash (it ships with Git for Windows) or
from WSL, since it is a shell script. Scheduling is the one genuinely Unix-shaped
part: use Task Scheduler for the four jobs below, or run the whole thing inside
WSL and use cron there.

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
`setup.sh` offers to install all four for you. If you skipped it, here they are:

```cron
*    * * * * cd /path/to/argus && /usr/bin/flock -n /tmp/argus-listener.lock /usr/bin/node server-bot/telegram-listener.mjs >> server-bot/listener.log 2>&1
0 */2 * * * cd /path/to/argus && /usr/bin/flock -n /tmp/argus-scan.lock /usr/bin/node server-bot/scan.mjs >> server-bot/scan.log 2>&1
30 7  * * * cd /path/to/argus && /usr/bin/node server-bot/housekeep.mjs --liveness-only >> server-bot/scan.log 2>&1
0 9   * * 0 cd /path/to/argus && /usr/bin/node server-bot/housekeep.mjs >> server-bot/scan.log 2>&1
```

On **Windows**, the same four go into Task Scheduler. `setup.sh` prints them
filled in with your own paths; the shape is:

```powershell
schtasks /create /tn "Argus listener" /sc minute /mo 1 /tr '"C:\Program Files\nodejs\node.exe" "C:\path\to\argus\server-bot\telegram-listener.mjs"'
schtasks /create /tn "Argus scan"     /sc hourly /mo 2 /tr '"C:\Program Files\nodejs\node.exe" "C:\path\to\argus\server-bot\scan.mjs"'
schtasks /create /tn "Argus links"    /sc daily /st 07:30 /tr '"C:\Program Files\nodejs\node.exe" "C:\path\to\argus\server-bot\housekeep.mjs" --liveness-only'
schtasks /create /tn "Argus cleanup"  /sc weekly /d SUN /st 09:00 /tr '"C:\Program Files\nodejs\node.exe" "C:\path\to\argus\server-bot\housekeep.mjs"'
```

No administrator rights needed. Windows only runs them while the machine is
awake, which is fine — a laptop you close simply searches when you open it.

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
| `no N [reason]` | remove an offer **and** record why, in `server-bot/feedback.jsonl` — or, if you already applied to it, close that application |
| `applied N` | remove it and log it to `data/applications.jsonl` |
| `longshot N [reason]` | the same, but flagged: you applied knowing you fall short |
| `cover N` | write a cover letter for it and send it back as a PDF |
| `mail` | where every application you sent stands, read from your inbox |
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

## Beyond the filters

Filtering offers well is not the same problem as knowing whether you are
filtering the *right* things. Two subsystems exist for the second question.
Both are optional, both were measured, and neither is allowed to decide
anything on its own.

### The Council — three judges, and why they still do not vote

`server-bot/argus-council/` · [its README](server-bot/argus-council/README.md)

Three LLM judges read the **body** of an offer, not just its title, and vote on
whether you should see it. **The Good** defaults to showing and can only hide by
quoting the barrier it found. **The Bad** hunts for the mismatch a title cannot
reveal — the seagoing rotation, the technician role dressed as engineering, the
language demand. **The Ugly** reads the actual day-to-day and breaks ties.
Majority of three.

They run in **shadow**: the verdict goes to a journal that nothing reads back.
No offer is ever kept or dropped because of a judge, and the whole thing ships
off.

That is not caution for its own sake. It is what the measurement said. On 63
offers with a real decision behind them the Council agreed 49 times — but it
would have deleted 5 of the 9 offers that were actually wanted, two of which had
already been applied to. Every voting variant tried, including unanimity and
"The Good plus one", still loses at least two of those nine. A layer that agrees
four times in five and still throws away more than half of what mattered is not
ready to decide, so it does not. `reconcile.mjs` keeps filling in what you
really did, so the number stays checkable instead of becoming a claim.

### Mail — reading the replies, so silence counts as an answer

`server-bot/argus-mail/`

Everything else in Argus works on offers. This works on what happened *after*
you applied: it reads your inbox once a night, matches the replies to the
applications you logged with `applied N`, and writes one state per application.
`mail` prints it.

It exists because of a number. On one real mailbox, over 46 replies from
employers: **35 acknowledgements, 5 rejections, 6 interviews**. Almost nobody
tells you no — they stop writing. So "no reply after a while" is not missing
data, it *is* the outcome, and a record that leaves it out flatters itself.

Every application ends up in one of five states:

| | State | Means |
|---|---|---|
| ⚪ | **N/A** | nothing came back at all — the commonest outcome by far |
| ⚪ | **Never arrived** | the mail bounced: nobody read it, so applying again somewhere that works is a real move |
| 🟡 | **Received** | they acknowledged it and that is all, so far |
| 🔴 | **Rejected/Ghosted** | they said no — or two months passed with nothing, which is a no nobody wrote down |
| 🟢 | **Interview** | somebody proposed talking to you |

Two things make this harder than it looks, and both are measured rather than
assumed:

- **The sender's own domain is useless.** Not once in 46 replies did an employer
  write from the domain on the job advert; it is always a third-party
  recruiting system. What identifies the application is the company name in the
  text, or failing that the display name on the "From:" line.
- **Only about a quarter of replies name the company at all.** So matching has
  to be built from weak signals without inventing links: a company name is worth
  enough on its own to identify an application, a job title needs two distinct
  words, and the date is worth something only *alongside* one of those. Timing
  alone never creates a candidate — otherwise every message that arrived on a
  busy day becomes a match. When two applications fit equally well, the message
  is reported as ambiguous instead of being assigned to a guess — with one
  exception, a bounce, which is about the *address* and so belongs to every
  application sent there.

**Some employers never write at all.** They put the verdict on their own portal,
or their address bounces and nobody fixes it, and the application would sit
under "no reply" for ever although you already know how it ended. `no N` closes
it: the same word you use on an offer you do not want, for an application that
is finished. It is kept apart from your offer rejections on purpose — one trains
the filter, and this one must not, because you were right to apply.

Classification is word lists, not a model: on 500 real messages they found 46
outcomes and 2 false alarms, and when one is wrong you add the phrase and it
stays fixed. Two mistakes worth knowing about, because both are in the tests:
"we will be in touch about the next steps" is the closing line of nearly every
automated receipt, not an invitation; and neither is "we will let you know
**whether** we see the right fit to invite you for an interview" — a promise is
not an invitation, and read without the start of the sentence the two are
identical.

**It can only read.** The token is issued for `gmail.readonly`, which Google
enforces on their side, so the guarantee does not depend on this code being
correct. There is one function that talks to the mail API and the verb `GET` is
written into it rather than passed in, and a test reads the file as text and
fails if a second verb ever appears. Nothing from a message is ever written to
disk: the body is read, matched in memory and dropped, and what survives is the
kind of message and its date. Your own sent mail is excluded from the search —
a reply you wrote reads exactly like an invitation to any pattern here, and it
would be your own words handed back to you as news.

Setting it up needs a Google Cloud OAuth client of your own — the README in
`server-bot/argus-mail/` walks through it. Without one, the rest of Argus works
exactly as before and `mail` simply says so.

### Discover — auditing the search, not the offer

`server-bot/argus-discover/` · [its README](server-bot/argus-discover/README.md)

Every filter above judges an offer. These four tools judge the search itself.

- **`audit-profile.mjs`** cross-reads your CV, your profile and your rejection
  history: which search terms have no backing in the CV (you are applying into a
  field with no evidence behind you), which CV skills the search never uses, and
  which rejections mean *wrong role* versus *right role, short on the
  requirements*. Local, no network, no tokens.
- **`esco-match.mjs`** asks the EU's [ESCO](https://esco.ec.europa.eu/)
  taxonomy — ~3,000 occupations, ~14,000 skills, 28 languages, no API key —
  which occupations list your skills as *essential*. A published fact rather
  than a model's opinion, and it answers with the official title in every
  language you search in.
- **`harvest-titles.mjs`** queries the boards by skill instead of by assumed job
  title, and reports what the market actually calls those roles. A term that
  returns zero adverts is a finding in its own right.
- **`blind-spots.mjs`** records what the title filter throws away. Read with the
  `blind` command.

The last one exists because of a number. In one measured cycle the filter
dropped 1,308 titles: 977 by a rule written deliberately, and **331 purely for
carrying no keyword from the field list** — invisible, unappealable, never
counted. "Asset Integrity Engineer" was among those 331.

It does not try to guess which of them mattered; ranking them by similarity to a
CV was tried, and it returns "support" and "management". It counts **recurrence**
instead. A one-off appears once and is gone; a role you are systematically blind
to comes back every week. Recurrence needs no theory about what your field is —
which is the point, because the hard cases are exactly the ones no tidy
definition covers.

Nothing here edits a filter. Every tool proposes; you decide.

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
- `argus-council/` — the three shadow judges. See
  [Beyond the filters](#the-council--three-judges-and-why-they-still-do-not-vote);
  their prompts can be overridden per user via `search.judge_prompts`.
- `argus-discover/` — the four tools that audit the search itself. See
  [Beyond the filters](#discover--auditing-the-search-not-the-offer).
- `gmail.mjs` / `gmail-auth.mjs` — the read-only door to your inbox: one
  `GET`-only reader and the one-time authorisation.
- `argus-mail/` — turns the replies into one state per application. See
  [its README](server-bot/argus-mail/README.md) for the Gmail setup.

## When something doesn't work

Every part can be run by hand, and each one prints why it failed:

```bash
npm test                                    # 1250 tests; run this first
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
- Everything is plain Node with three dependencies (`js-yaml`, `playwright`,
  `html-to-text`), no
  database and no service to sign up for beyond the portals themselves.
- The scan costs zero AI tokens: it is HTTP and JSON. Only `cover N` and the
  optional Council call a model.
