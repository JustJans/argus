# The Council — SHADOW review layer

## What it is

A second opinion on what Argus (the job-search bot) decides. Three AI judges
read the **body** of each offer —not just the title, as the automatic filter
does— and vote on whether it should be shown to the user or not. The Council's
verdict is by **majority, 2 of 3**.

The three judges, each with its own personality:

- **The Good (The Defender)** — lenient. By default it SHOWS; it only hides if
  a hard barrier it can cite is triggered. Its mission: don't let a good offer
  slip away (the user's costly error is the false rejection). Model: haiku.
- **The Bad (The Prosecutor)** — strict. It hunts in the body for the fine
  mismatch the title filter can't see (hidden STCW, a technician disguised as an
  engineer, a sales role, a required language…). It only hides with literal proof. Model: sonnet.
- **The Ugly (The Realist)** — neutral. It reads the real day-to-day and votes
  on balance (does it energize or drain?, real engineering or back-office?). It
  breaks ties with no prior bias. Model: sonnet.

## It runs in SHADOW: it decides nothing

The Council **only observes and takes notes**. It's a layer ON TOP of the
funnel, never inside it. Specifically:

- It does **NOT** touch `data/pipeline.md`, or `scan-history.tsv`, or
  `last-scan.json`, or `data/applications.jsonl`. It does not call the scanner
  or the "seen" command.
- The only things it writes are two logs of ITS OWN:
  - **`data/council-log.txt`** — HUMAN-READABLE by you: for each offer, the vote
    and confidence of the three judges, the Council's ruling and each one's
    reasoning (the same format as the rehearsal). This is the one you look at to "see it".
  - **`data/judge-shadow.jsonl`** — for machines: one JSON line per offer,
    which `reconcile.mjs` uses to measure agreement with your decisions.
- It is controlled by `council.enabled` in `portals.yml`, and it ships **off**:
  the Council is the only part that needs the Claude CLI installed and logged
  in. Set `enabled: true` once you have run `claude setup-token`.

That's why it can live in the repo with no risk to the real flow.

## How to turn it on

In `portals.yml`, the `council:` block (section 10):

```yaml
council:
  enabled: true        # ➤ set this to true to activate it
  model: sonnet        # ➤ model for all the judges (empty = each judge's own)
  sample_dropped: 5    # ➤ how many dropped offers to review (0 = only the presented ones)
```

As long as `enabled` is `false` (or the block is missing), the harness exits without doing anything.

## How you'd run it by hand

From the project root:

```bash
node server-bot/argus-council/judge-shadow.mjs            # ➤ judges presented offers + the sample
node server-bot/argus-council/judge-shadow.mjs --limit 3  # ➤ only the first 3 (test)
```

It needs the Claude token (`server-bot/claude-token.json`), the same one the
cover letter uses. Without it the judges return a null vote and the log says
`null` — it does not break.

Weeks later, to fill in what you actually decided and measure the agreement:

```bash
node server-bot/argus-council/reconcile.mjs
```

It cross-references `judge-shadow.jsonl` with the submitted applications
(`applications.jsonl` → show), the rejections (`feedback.jsonl` → hide) and the
"| visto" marks in the pipeline (→ seen), filling in the `userDecision` field of each line.

## Scheduling

It is meant to be **chained to the scan** on the same cron line: first Argus runs
(`scan.mjs`, which filters and sends the offers to Telegram itself) and, right
after, the Council (`judge-shadow.mjs` with `flock`), which reads the
freshly written `pipeline.md` and judges the queue of unjudged offers. This way
the Council (Argus Plus) is an add-on that starts right after Argus, without
hijacking its sending: if it's turned off (`council.enabled:false`), Argus works the same.

## Give it two weeks before judging it

Let it run in shadow for a couple of weeks, then run `reconcile.mjs` and compare
the Council's verdict with what you actually did. If it would have caught good
offers the filter threw away (or the reverse), you can decide with data whether
it earns its keep. Until you do, nothing in the funnel changes.

## Files

| File | What it does |
|---------|----------|
| `judges.mjs` | The 3 judges (prompt + model) and `parseVerdict` (reads the vote). |
| `engine.mjs` | Calls the AI on the server (cover-letter.mjs pattern). |
| `vote.mjs` | The ballot box: `councilVote` (majority 2 of 3). Pure function. |
| `judge-shadow.mjs` | The harness: gathers offers, runs judges, writes the log. |
| `reconcile.mjs` | Fills in `userDecision` by cross-referencing what the user decided. |
| `test-council.mjs` | Deterministic tests (no network, no AI, no writing). |
