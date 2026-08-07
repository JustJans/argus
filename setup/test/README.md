# Replaying the setup, with no Telegram account

The whole first-run — token saved → START tapped → CV sent → every question
answered → profile written — can be replayed locally, so a bug in the flow is
seen here instead of by a real user. No account, no phone, no VM.

How the ecosystem does this: a **mock Telegram server** (this folder's
`mock-telegram.mjs`, modelled on
[telegram-test-api](https://github.com/jehy/telegram-test-api)) that the bot
talks to via the `ARGUS_TG_API` base-URL override — the same `baseApiUrl`
pattern those harnesses use. The alternative, Telegram's official **test DC**,
needs a real phone to register even there, so the mock is the account-free route.

```bash
node setup/test/drive-setup.mjs
```

It copies the bot to a throwaway `.setup-test-work/` (nothing real is touched),
starts the mock, and plays a person through the onboarding while printing the
exact conversation both sides see. It builds its own text-based PDF for the CV
step, so it depends on no downloaded file.

What this covers: the linking handshake, `/start` from the deep link, the
question-by-question flow, the inline-button taps, the PDF upload and text
extraction, and the profile the bot writes at the end.

What it does **not** cover (needs the real OS, verified separately by hand):
Node install via winget, Task Scheduler / cron registration, the hidden-window
launcher, and macOS's privacy fence. Those are OS-level, not Telegram-level.

## The full install, on a machine that owns nothing

`drive-setup.mjs` above rehearses the conversation. To rehearse the **install
itself** — the real one-line installer, fetched from GitHub — use a throwaway
system account, so the schedule it writes lands in that account's crontab and
never yours:

```bash
sudo useradd -m argustest
sudo -u argustest bash setup/test/fresh-install-linux.sh
sudo userdel -r argustest        # afterwards
```

It prints the console and the chat side by side and then the state the machine
ended up in: folder, dependencies, crontab, `telegram.json`, profile.

Its first run earned its keep: `install.sh` died at `exec … < /dev/tty` in a
session with no controlling terminal — code downloaded, no dependencies, no
schedule, no token, a bot mute for ever. Fixed in `802f8ce`.
