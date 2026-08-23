#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — macOS/Linux uninstall. Run: bash setup/uninstall-linux-mac.sh
# It removes THIS copy's cron lines, which is everything Argus put OUTSIDE its
# own folder. The folder itself — code, your profile, your CV, your data —
# stays; delete it by hand if you want everything gone.
# Written for the bash 3.2 macOS ships: no case inside $(…).
# ─────────────────────────────────────────────────────────────────────────────
set -u
# ➤ This file lives in setup/, but every path is spoken from the project root.
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ok()   { printf '  OK  %s\n' "$*"; }

printf '\nArgus uninstall — %s\n' "$ROOT"
echo "  This removes Argus's cron lines (listener, scan, links, cleanup)."
echo "  The folder and everything in it stay; delete the folder yourself after."
printf '  Remove the cron lines? (y/n) '
read -r ANS
if [ "$ANS" != "y" ]; then echo "  Nothing was touched."; exit 0; fi

if ! command -v crontab >/dev/null 2>&1 || ! crontab -l >/dev/null 2>&1; then
  ok "no crontab on this machine — nothing to remove"
else
  CRON_TMP="$(mktemp 2>/dev/null || echo "/tmp/argus-cron.$$")"
  # ➤ Both spellings, like the diagnose script: the setup quotes the path since
  # ➤ 2026-08-08, and this filter only knew the bare one — so modern installs
  # ➤ kept their cron lines through an "uninstall".
  crontab -l | while IFS= read -r line; do
    case "$line" in
      (*"cd '$ROOT' && "*|*"cd $ROOT && "*) continue ;;
    esac
    printf '%s\n' "$line"
  done > "$CRON_TMP"
  if ! crontab -l | cmp -s - "$CRON_TMP"; then
    # ➤ An empty crontab must be REMOVED, not installed: `crontab` with an
    # ➤ empty file errors on some systems and lies on others.
    if [ -s "$CRON_TMP" ]; then crontab "$CRON_TMP"; else crontab -r; fi
    ok "removed this copy's cron lines"
  else
    ok "this copy had no cron lines — nothing to remove"
  fi
  rm -f "$CRON_TMP"
fi

# ➤ The always-on listener (2026-08-22) outlives its cron line: without this
# ➤ it would keep polling Telegram for up to six more hours, from an install
# ➤ that no longer exists. Its pid is in the heartbeat file it maintains.
ALIVE="server-bot/listener-alive.json"
if [ -f "$ALIVE" ]; then
  PID="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$ALIVE" | head -1)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && ok "stopped the running listener (pid $PID)"
  fi
fi

printf '\nDone. To finish, delete this folder: %s\n' "$ROOT"
echo "  (Your Telegram bot keeps existing; remove it with /deletebot at @BotFather.)"
