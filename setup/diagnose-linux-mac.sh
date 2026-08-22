#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — macOS/Linux diagnosis. Run it when the bot answers nothing:
#   bash setup/diagnose-linux-mac.sh
# Read-only except for one thing: it runs the listener once in the foreground,
# so any crash that cron swallows is printed HERE, on screen. Twin of
# diagnose-windows.bat, born from the same mute field installs (2026-08-05).
# ─────────────────────────────────────────────────────────────────────────────
set -u
# ➤ This file lives in setup/, but every path is spoken from the project root.
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ok()   { printf '  OK  %s\n' "$*"; }
bad()  { printf '  !!  %s\n' "$*"; }
say()  { printf '\n%s\n' "$*"; }

say "Argus diagnosis — $ROOT"

# ── 1. Node ──────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then ok "Node $(node -v) at $(command -v node)"
else bad "Node is not installed. Run: bash setup/setup-linux-mac.sh"; exit 1; fi

# ── 2. The macOS privacy fence ───────────────────────────────────────────
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  case "$ROOT" in
    "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      bad "This folder is inside Desktop/Documents/Downloads: macOS blocks cron"
      bad "from reading here, so the schedule silently never runs. Fix:"
      echo "      mv \"$ROOT\" \"\$HOME/argus\" && cd \"\$HOME/argus\" && bash setup/setup-linux-mac.sh" ;;
    *) ok "the folder is somewhere cron can read" ;;
  esac
fi

# ── 3. The cron lines ────────────────────────────────────────────────────
# ➤ The listener line is what answers Telegram at all; every mute-bot report
# ➤ so far came down to it missing, failing, or belonging to another copy.
if ! command -v crontab >/dev/null 2>&1; then
  bad "no crontab on this machine — nothing is scheduled"
# ➤ Both spellings: the setup quotes the path since 2026-08-08, but installs
# ➤ made before that carry it bare.
elif crontab -l 2>/dev/null | grep -qF -e "cd '$ROOT' && " -e "cd $ROOT && "; then
  ok "this copy is in the crontab:"
  crontab -l | grep -F -e "cd '$ROOT' && " -e "cd $ROOT && " | sed 's/^/      /'
else
  bad "THIS copy is not in the crontab: the bot cannot answer anything."
  bad "Fix: run the installer (or bash setup/setup-linux-mac.sh) again - it repairs the schedule."
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
  else bad "chat_id is EMPTY: the link step never finished. With the listener running, send the bot any message and it links itself within seconds (a minute at worst)."; fi
fi

# ── 5. Has the listener ever ticked? ─────────────────────────────────────
# ➤ The offset file is written on the first successful tick, so its absence
# ➤ separates "never ran" from "runs but something else fails".
if [ -f server-bot/telegram-offset.json ]; then
  # ➤ Three fallbacks because the first two are GNU-only (audit 2026-08-08):
  # ➤ BSD `date -r` takes seconds-since-epoch, not a filename, and BSD stat
  # ➤ spells -c as -f — so on macOS, the OS this script is FOR, the timestamp
  # ➤ printed empty. `stat -f %Sm` is the Darwin spelling.
  TICKED="$(date -r server-bot/telegram-offset.json 2>/dev/null || stat -c %y server-bot/telegram-offset.json 2>/dev/null || stat -f %Sm server-bot/telegram-offset.json 2>/dev/null)"
  ok "the listener has ticked before (server-bot/telegram-offset.json, last: $TICKED)"
else
  bad "server-bot/telegram-offset.json does not exist: the listener has NEVER completed a tick."
fi

# ── 5b. Is the always-on listener alive RIGHT NOW? ───────────────────────
# ➤ The listener long-polls Telegram and stamps listener-alive.json every 30s;
# ➤ a stamp under ~2 minutes old means the bot is answering live. Epoch mtime
# ➤ needs both spellings: GNU stat -c %Y, BSD/macOS stat -f %m (audit 2026-08-08).
ALIVE="server-bot/listener-alive.json"
if [ -f "$ALIVE" ]; then
  MT="$(stat -c %Y "$ALIVE" 2>/dev/null || stat -f %m "$ALIVE" 2>/dev/null)"
  NOW="$(date +%s)"
  if [ -n "$MT" ] && [ $((NOW - MT)) -lt 120 ]; then
    ok "the always-on listener is alive (heartbeat $((NOW - MT))s ago) — commands should answer in about a second"
  else
    bad "the listener's heartbeat is old ($ALIVE). The minute schedule should revive it; if this line persists, the cron section above holds the reason."
  fi
else
  echo "  --  no listener heartbeat yet (first start pending, or an older Argus version)"
fi

# ── 6. What cron saw (the log) ───────────────────────────────────────────
if [ -s server-bot/listener.log ]; then
  say "Last lines of server-bot/listener.log (what the scheduled runs printed):"
  tail -8 server-bot/listener.log | sed 's/^/      /'
fi

# ── 6b. The cover-letter browser ─────────────────────────────────────────
# ➤ Playwright downloads its browser separately from `npm install`, and an npm
# ➤ update can leave the library newer than the browser on disk — which breaks
# ➤ `cover N` only, silently, until you ask for a letter. The generator repairs
# ➤ this by itself now; this only reports it.
# ➤ Per-OS registry path (audit 2026-08-08): Playwright keeps browsers under
# ➤ ~/Library/Caches on macOS, ~/.cache on Linux. Checking only the Linux path
# ➤ made every Mac report the browser missing even when it was installed.
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then PW_DIR="$HOME/Library/Caches/ms-playwright"
else PW_DIR="$HOME/.cache/ms-playwright"; fi
if [ -d "$PW_DIR" ]; then
  ok "Playwright browsers present ($(ls "$PW_DIR" | wc -l | tr -d ' ') builds)"
else
  echo "  --  no Playwright browser yet: the first 'cover N' downloads it (~115 MB)"
fi

# ── 7. One live run, on screen ───────────────────────────────────────────
# ➤ cron swallows all output; this run swallows nothing. If the listener
# ➤ crashes on this machine, the reason prints right here.
# ➤ --once: a single pass that terminates. Without it this window would BECOME
# ➤ the always-on listener and the diagnosis would never finish.
say "Running the listener ONCE in this window (its errors, if any, print below):"
node server-bot/telegram-listener.mjs --once
RC=$?
echo "  listener exit code: $RC"
if [ "$RC" -eq 0 ]; then
  ok "the listener ran cleanly. If everything above is OK too, send /start to the bot NOW — it should answer within seconds (a minute at worst, while the schedule revives the listener)."
else
  bad "THAT exit code and the lines above are the reason the bot is mute. Send a photo of this window."
fi
