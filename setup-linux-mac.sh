#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — guided setup for macOS and Linux (on Windows, double-click setup-windows.bat).
# Run it once after downloading:   bash setup-linux-mac.sh
# It only asks for what is REQUIRED (a Telegram bot token) and offers to write
# the cron lines for you. Everything else is optional and can wait.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
ROOT="$(pwd)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

say "Argus setup"

# ── 0. Where the folder lives (macOS privacy) ────────────────────────────
# ➤ macOS fences Desktop, Documents and Downloads behind per-app privacy
# ➤ consent (TCC), and cron never gets that consent: everything here would
# ➤ work when run BY HAND and silently never run from its schedule — the
# ➤ exact "bot answers nothing" a field tester hit. Stop before any of that.
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  case "$ROOT" in
    "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      warn "This folder is inside Desktop/Documents/Downloads, which macOS keeps"
      warn "off-limits to scheduled jobs (cron). Argus would work by hand but its"
      warn "schedule would silently never run. Move it somewhere plain and rerun:"
      echo
      echo "  mv \"$ROOT\" \"\$HOME/argus\" && cd \"\$HOME/argus\" && bash setup-linux-mac.sh"
      echo
      exit 1 ;;
  esac
fi

# ── 1. Node ──────────────────────────────────────────────────────────────
# ➤ 20, not 18: playwright (which prints the cover letters) requires it. On 18
# ➤ this setup used to finish happily and the first "cover N" was the thing that
# ➤ failed — long after anyone would connect the two.
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer) and run this again."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $(node -v) is too old. Argus needs 20 or newer (playwright, which prints the cover letters, requires it)."
  exit 1
fi
ok "Node $(node -v)"

# ── 2. Dependencies ──────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  say "Installing dependencies (npm install)"
  npm install --no-audit --no-fund || { warn "npm install failed"; exit 1; }
fi
ok "dependencies installed"

# ── 3 + 4. Telegram bot: the token, then the chat ────────────────────────
# ➤ These two are one step, not two, because they fail into each other. The
# ➤ token is the only thing you type by hand in this whole setup, so a typo in
# ➤ it is the likeliest way an install goes wrong — and Telegram reports it as
# ➤ "Unauthorized", which reads like a problem with your chat. Asking again is
# ➤ the fix; the earlier version saved the bad token and could never be talked
# ➤ out of it, because on the next run it saw a token in the file and skipped
# ➤ straight past the question.
CFG="server-bot/telegram.json"

ask_token() {
  say "Telegram bot"
  echo "  Open Telegram, talk to @BotFather, send /newbot and copy the token it gives you."
  echo "  It looks like: 123456789:AAHk8s...  (numbers, a colon, then letters)"
  printf '  Paste the token here: '
  read -r TOKEN
  if [ -z "${TOKEN:-}" ]; then return 1; fi
  # ➤ Checked here, before spending a network round-trip and before asking you
  # ➤ to go and message the bot: every BotFather token is digits, a colon, then
  # ➤ a long tail. If that shape is missing, something else got pasted.
  if ! printf '%s' "$TOKEN" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$'; then
    warn "That does not look like a bot token (expected 123456789:AAHk8s...)."
    warn "Copy the whole line @BotFather sent, with nothing before or after it."
    return 2
  fi
  printf '{"bot_token": "%s", "chat_id": ""}\n' "$TOKEN" > "$CFG"
  chmod 600 "$CFG" 2>/dev/null || true
  ok "saved to $CFG"
  return 0
}

TELEGRAM_READY=no
if grep -q '"chat_id"[[:space:]]*:[[:space:]]*"[0-9-]\+"' "$CFG" 2>/dev/null; then
  ok "Telegram already linked (token and chat id are in $CFG)"
  TELEGRAM_READY=yes
else
  # ➤ Up to three goes at the token, then carry on regardless: the rest of the
  # ➤ install is still worth finishing, and this step can be redone alone.
  ATTEMPT=0
  while [ "$TELEGRAM_READY" = no ] && [ "$ATTEMPT" -lt 3 ]; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ ! -f "$CFG" ] || ! grep -q '"bot_token"[[:space:]]*:[[:space:]]*"[^"]\+"' "$CFG"; then
      ask_token; RC=$?
      # ➤ 2 = wrong shape, nothing was saved → go round and ask again.
      # ➤ 1 = nothing typed at all → they do not have it to hand; stop asking.
      [ "$RC" -eq 2 ] && continue
      [ "$RC" -ne 0 ] && { warn "No token given."; break; }
    else
      ok "telegram.json already has a token"
    fi

    say "Linking your chat"
    echo "  Send ANY message to your bot in Telegram now (say 'hi')."
    printf '  Done? press Enter to continue '
    read -r _

    node server-bot/notify.mjs --setup
    case $? in
      0) TELEGRAM_READY=yes ;;
      # ➤ 2 = Telegram rejected the token itself. Offer to type it again.
      2) if [ "$ATTEMPT" -lt 3 ]; then
           printf '  Paste the token again? [Y/n] '
           read -r RETRY
           case "${RETRY:-y}" in
             [nN]*) break ;;
             *) rm -f "$CFG" ;;
           esac
         fi ;;
      # ➤ Anything else: the token is fine — the message simply has not arrived
      # ➤ (or the network blinked). This used to be a dead end that forced
      # ➤ restarting the whole setup (field test 2026-08-03); now it loops back
      # ➤ and asks again, up to the attempt cap.
      *) warn "No message found. Make sure you sent one to the bot; let's try again." ;;
    esac
  done
fi

if [ "$TELEGRAM_READY" = no ]; then
  warn "Telegram is not linked yet. Everything else below still applies;"
  warn "when you have it sorted, finish with:  node server-bot/notify.mjs --setup"
fi

# ── 5. Cron ──────────────────────────────────────────────────────────────
say "Scheduling"
# ➤ Sweep DEAD copies first: reinstalls leave crontab lines cd'ing into
# ➤ folders that no longer exist. Those lines can only fail — and a surviving
# ➤ listener from an old folder is worse, it EATS the new install's Telegram
# ➤ messages. Only Argus-shaped lines whose folder is gone are dropped.
if command -v crontab >/dev/null 2>&1 && crontab -l >/dev/null 2>&1; then
  KEPT="$(crontab -l | while IFS= read -r line; do
    case "$line" in
      *"server-bot/telegram-listener.mjs"*|*"server-bot/scan.mjs"*|*"server-bot/housekeep.mjs"*)
        DIR="${line#*cd }"; DIR="${DIR%% && *}"
        if [ -n "$DIR" ] && [ ! -d "$DIR" ]; then continue; fi ;;
    esac
    printf '%s\n' "$line"
  done)"
  if [ "$KEPT" != "$(crontab -l)" ]; then
    printf '%s\n' "$KEPT" | crontab - && ok "removed cron lines pointing at deleted Argus copies"
  fi
fi
# ➤ macOS SHIPS NO flock (field review 2026-08-05): hardcoding /usr/bin/flock
# ➤ made the listener and scan lines fail silently every single run, and the
# ➤ bot never answered a thing. With flock absent the lines run bare — the
# ➤ listener finishes in under a second, so overlap is a non-issue there, and
# ➤ a scan outliving its 2 h slot is rare enough to accept on a laptop.
FLOCK_L=""
FLOCK_S=""
if command -v flock >/dev/null 2>&1; then
  FLOCK_L="$(command -v flock) -n /tmp/argus-listener.lock "
  FLOCK_S="$(command -v flock) -n /tmp/argus-scan.lock "
fi
CRON_LINES="\
* * * * * cd $ROOT && ${FLOCK_L}$(command -v node) server-bot/telegram-listener.mjs >> $ROOT/server-bot/listener.log 2>&1
0 */2 * * * cd $ROOT && ${FLOCK_S}$(command -v node) server-bot/scan.mjs >> $ROOT/server-bot/scan.log 2>&1
30 7 * * * cd $ROOT && $(command -v node) server-bot/housekeep.mjs --liveness-only >> $ROOT/server-bot/scan.log 2>&1
0 9 * * 0 cd $ROOT && $(command -v node) server-bot/housekeep.mjs >> $ROOT/server-bot/scan.log 2>&1"

# ➤ Matched on THIS folder, not just on "scan.mjs": a second checkout would
# ➤ otherwise see the first one's cron lines and skip scheduling itself.
if crontab -l 2>/dev/null | grep -qF "cd $ROOT &&"; then
  ok "This copy of Argus is already in your crontab — leaving it alone"
elif ! command -v crontab >/dev/null 2>&1; then
  # ➤ Windows has no cron, and printing the lines above would be worse than
  # ➤ printing nothing: they carry /c/... paths and flock, neither of which
  # ➤ exists here. Task Scheduler is the equivalent, so give the four commands
  # ➤ that actually work, with Windows paths.
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      WROOT="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
      WNODE="$(cygpath -w "$(command -v node)" 2>/dev/null || command -v node)"
      warn "Windows has no cron. Paste these four into PowerShell (no admin needed):"
      echo
      echo "  schtasks /create /tn \"Argus listener\" /sc minute /mo 1 /tr '\"$WNODE\" \"$WROOT\\server-bot\\telegram-listener.mjs\"'"
      echo "  schtasks /create /tn \"Argus scan\"     /sc hourly /mo 2 /tr '\"$WNODE\" \"$WROOT\\server-bot\\scan.mjs\"'"
      echo "  schtasks /create /tn \"Argus links\"    /sc daily /st 07:30 /tr '\"$WNODE\" \"$WROOT\\server-bot\\housekeep.mjs\" --liveness-only'"
      echo "  schtasks /create /tn \"Argus cleanup\"  /sc weekly /d SUN /st 09:00 /tr '\"$WNODE\" \"$WROOT\\server-bot\\housekeep.mjs\"'"
      echo
      echo "  The machine only runs them while it is awake, which is fine: a laptop"
      echo "  you close simply searches when you open it again."
      ;;
    *)
      warn "No crontab on this machine. Schedule these yourself:"
      echo "$CRON_LINES"
      ;;
  esac
else
  echo "  Argus needs to run on a schedule. The listener (every minute) is what"
  echo "  receives your Telegram commands — without it the bot cannot answer, not"
  echo "  even /start. The other three: a scan every 2h, and two cleanups."
  printf '  Add these 4 lines to your crontab? [y/N] '
  read -r ANS
  case "${ANS:-n}" in
    [yY]*) { crontab -l 2>/dev/null; echo "$CRON_LINES"; } | crontab - && ok "cron installed" ;;
    *) warn "Skipped. Add them yourself when you are ready:"; echo "$CRON_LINES" ;;
  esac
fi

# ── 6. The profile — do this NOW, before the first scan fires ────────────
# ➤ Deliberately after cron and before the optional extras: the scan runs every
# ➤ 2h from this moment on, and until the profile exists it uses the shipped
# ➤ marine/offshore example. Saying so here is what stops the first list from
# ➤ looking like the bot is broken.
say "Your profile — do this next"
echo "  Open Telegram and send /start to your bot. It asks a few questions and"
echo "  writes config/profile.yml and cv.md for you ('settings' edits them later)."
echo "  Until you do, Argus searches with the marine/offshore EXAMPLE profile, so"
echo "  the first list it sends will not be yours. That is expected, not a fault."

# ── 7. Optional extras, only reported ────────────────────────────────────
say "Optional extras (nothing breaks without them)"
[ -f server-bot/adzuna-key.json ] && ok "Adzuna key present" \
  || echo "  - Adzuna key (free, https://developer.adzuna.com/) → one more job board. Save it to server-bot/adzuna-key.json as {\"app_id\":\"...\",\"app_key\":\"...\"}"
command -v claude >/dev/null 2>&1 && ok "Claude CLI present" \
  || echo "  - Claude CLI → AI cover letters ('cover N') and the Council. Install: npm i -g @anthropic-ai/claude-code, then: claude setup-token"
echo "  - Chromium (npx playwright install chromium) → cover letters as PDF"

say "Done"
if [ "$TELEGRAM_READY" = yes ]; then
  echo "  1. Send /start to your bot (see above) — this is the step that makes it yours."
  echo "  2. Then send 'search' to look right away instead of waiting for the schedule."
  echo "  3. 'help' lists every command."
else
  echo "  1. Link Telegram:  node server-bot/notify.mjs --setup"
  echo "     (it tells you exactly what is missing: the token, or a first message)"
  echo "  2. Then send /start to your bot — the step that makes it yours."
  echo "  3. Then 'search', and 'help' for every command."
fi
echo
echo "  Check the install at any time:  npm test"
