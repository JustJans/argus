#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Argus — one-line installer for macOS and Linux. From a terminal:
#   curl -fsSL https://raw.githubusercontent.com/JustJans/argus/master/install.sh | bash
# Downloads the latest code into ~/argus and hands over to the guided setup.
# Re-running it UPDATES the code and never touches your profile, CV or data.
# (Why ~/argus: macOS keeps cron out of Desktop/Documents/Downloads, so an
# unzip there works by hand and silently never runs on schedule. A fixed plain
# folder kills that whole class, and the cron lines never point at a dead copy.)
# ─────────────────────────────────────────────────────────────────────────────
set -eu
DEST="${ARGUS_DEST:-$HOME/argus}"
printf '\nInstalling Argus into %s\n' "$DEST"
TMP="$(mktemp -d 2>/dev/null || echo "/tmp/argus-install.$$")"
mkdir -p "$TMP"
curl -fsSL https://github.com/JustJans/argus/archive/refs/heads/master.tar.gz | tar -xz -C "$TMP"
SRC="$TMP/argus-master"
# ➤ An UPDATE must never clobber what the user built: the profile, the CV and
# ➤ the letter example are theirs once they exist (telegram.json and data/ are
# ➤ not in the download at all, so they survive on their own).
# ➤ countries.yml and portals.yml joined the list 2026-08-08: both are
# ➤ documented as hand-editable — the country toggles and any boards the user
# ➤ added — and the update was silently reverting those edits while the README
# ➤ promised it touched nothing of theirs.
for rel in config/profile.yml cv.md config/cover-example.md server-bot/countries.yml portals.yml; do
  if [ -f "$DEST/$rel" ] && [ -f "$SRC/$rel" ]; then rm -f "$SRC/$rel"; fi
done
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
rm -rf "$TMP"
echo "  OK  latest code in place (your profile, CV and data untouched)"
if [ "${ARGUS_NO_SETUP:-}" = "1" ]; then
  echo "ARGUS_NO_SETUP is set - skipping the setup."
  exit 0
fi
cd "$DEST"
# ➤ Under `curl … | bash` stdin IS the script, so the setup's questions must
# ➤ read from the terminal itself or they swallow the script as answers.
# ➤ THE TEST HAS TO BE AN ACTUAL OPEN, not `[ -r /dev/tty ]` (found by the
# ➤ replay harness, 2026-08-07): with no controlling terminal — a detached
# ➤ session, a runner, some SSH shapes — /dev/tty passes the readable test and
# ➤ then fails to open, and because this line is an `exec` the installer DIED
# ➤ right there: code downloaded, no dependencies, no schedule, no token. That
# ➤ is precisely the "it stopped halfway" a field tester reported.
if ( : < /dev/tty ) 2>/dev/null; then
  exec bash setup/setup-linux-mac.sh < /dev/tty
else
  exec bash setup/setup-linux-mac.sh
fi
