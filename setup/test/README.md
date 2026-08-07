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
