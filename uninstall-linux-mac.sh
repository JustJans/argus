#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — macOS/Linux uninstall. Run: bash uninstall-linux-mac.sh
# It removes THIS copy's cron lines, which is everything Argus put OUTSIDE its
# own folder. The folder itself — code, your profile, your CV, your data —
# stays; delete it by hand if you want everything gone.
# Written for the bash 3.2 macOS ships: no case inside $(…).
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
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
  crontab -l | while IFS= read -r line; do
    case "$line" in
      (*"cd $ROOT && "*) continue ;;
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

printf '\nDone. To finish, delete this folder: %s\n' "$ROOT"
echo "  (Your Telegram bot keeps existing; remove it with /deletebot at @BotFather.)"
