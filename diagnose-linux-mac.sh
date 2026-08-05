#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — macOS/Linux diagnosis. Run it when the bot answers nothing:
#   bash diagnose-linux-mac.sh
# Read-only except for one thing: it runs the listener once in the foreground,
# so any crash that cron swallows is printed HERE, on screen. Twin of
# diagnose-windows.bat, born from the same mute field installs (2026-08-05).
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
ROOT="$(pwd)"
ok()   { printf '  OK  %s\n' "$*"; }
bad()  { printf '  !!  %s\n' "$*"; }
say()  { printf '\n%s\n' "$*"; }

say "Argus diagnosis — $ROOT"

# ── 1. Node ──────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then ok "Node $(node -v) at $(command -v node)"
else bad "Node is not installed. Run: bash setup-linux-mac.sh"; exit 1; fi

# ── 2. The macOS privacy fence ───────────────────────────────────────────
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  case "$ROOT" in
    "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      bad "This folder is inside Desktop/Documents/Downloads: macOS blocks cron"
      bad "from reading here, so the schedule silently never runs. Fix:"
      echo "      mv \"$ROOT\" \"\$HOME/argus\" && cd \"\$HOME/argus\" && bash setup-linux-mac.sh" ;;
    *) ok "the folder is somewhere cron can read" ;;
  esac
fi

# ── 3. The cron lines ────────────────────────────────────────────────────
# ➤ The listener line is what answers Telegram at all; every mute-bot report
# ➤ so far came down to it missing, failing, or belonging to another copy.
if ! command -v crontab >/dev/null 2>&1; then
  bad "no crontab on this machine — nothing is scheduled"
elif crontab -l 2>/dev/null | grep -qF "cd $ROOT && "; then
  ok "this copy is in the crontab:"
  crontab -l | grep -F "cd $ROOT && " | sed 's/^/      /'
else
  bad "THIS copy is not in the crontab: the bot cannot answer anything."
  bad "Fix: run setup-linux-mac.sh and answer y to the cron question."
  OTHER="$(crontab -l 2>/dev/null | grep -F 'server-bot/telegram-listener.mjs' || true)"
  [ -n "$OTHER" ] && bad "a DIFFERENT copy is scheduled instead:" && printf '%s\n' "$OTHER" | sed 's/^/      /'
fi

# ── 4. Telegram config ───────────────────────────────────────────────────
CFG="server-bot/telegram.json"
if [ ! -f "$CFG" ]; then
  bad "$CFG does not exist — the Telegram link never happened (token step of the setup)."
else
  if grep -q '"bot_token"[[:space:]]*:[[:space:]]*"[0-9]\{6,\}:' "$CFG"; then ok "bot token present"
  else bad "the bot token does not look like a token — re-run the setup token step"; fi
  if grep -q '"chat_id"[[:space:]]*:[[:space:]]*"[0-9-]\{1,\}"' "$CFG"; then ok "chat linked"
  else bad "chat_id is EMPTY: the link step never finished. With the cron running, send the bot any message and it links itself within a minute."; fi
fi

# ── 5. Has the listener ever ticked? ─────────────────────────────────────
# ➤ The offset file is written on the first successful tick, so its absence
# ➤ separates "never ran" from "runs but something else fails".
if [ -f data/telegram-offset.json ]; then
  ok "the listener has ticked before (data/telegram-offset.json, last: $(date -r data/telegram-offset.json 2>/dev/null || stat -c %y data/telegram-offset.json 2>/dev/null))"
else
  bad "data/telegram-offset.json does not exist: the listener has NEVER completed a tick."
fi

# ── 6. What cron saw (the log) ───────────────────────────────────────────
if [ -s server-bot/listener.log ]; then
  say "Last lines of server-bot/listener.log (what the scheduled runs printed):"
  tail -8 server-bot/listener.log | sed 's/^/      /'
fi

# ── 7. One live run, on screen ───────────────────────────────────────────
# ➤ cron swallows all output; this run swallows nothing. If the listener
# ➤ crashes on this machine, the reason prints right here.
say "Running the listener ONCE in this window (its errors, if any, print below):"
node server-bot/telegram-listener.mjs
RC=$?
echo "  listener exit code: $RC"
if [ "$RC" -eq 0 ]; then
  ok "the listener ran cleanly. If everything above is OK too, send /start to the bot NOW — it should answer within a minute."
else
  bad "THAT exit code and the lines above are the reason the bot is mute. Send a photo of this window."
fi
