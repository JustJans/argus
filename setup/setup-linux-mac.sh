#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Argus — guided setup for macOS and Linux. The one-line installer runs this;
# by hand: bash setup/setup-linux-mac.sh
# THE CONTRACT: the user types the bot token and taps START in Telegram, and
# nothing else. Running the installer IS the consent, so nothing here asks
# "are you sure" — it installs the cron schedule and waits for the one tap
# that links the chat and starts the profile questions.
# Written for the bash 3.2 macOS ships (2007): no case inside $(…), patterns
# with their opening parenthesis.
# ─────────────────────────────────────────────────────────────────────────────
set -u
# ➤ This file lives in setup/, but every path is spoken from the project root.
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  OK  %s\n' "$*"; }
warn() { printf '  !   %s\n' "$*"; }

# ➤ The Telegram host, overridable for testing only (setup/test replays the
# ➤ whole install against a local mock). Default is the real one.
TG_API="${ARGUS_TG_API:-https://api.telegram.org}"

say "Argus setup"

# ── 0. Where the folder lives (macOS privacy) ────────────────────────────
# ➤ macOS fences Desktop, Documents and Downloads behind per-app privacy
# ➤ consent (TCC), and cron never gets that consent: everything would work
# ➤ when run BY HAND and silently never run from its schedule.
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  case "$ROOT" in
    ("$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
      warn "This folder is inside Desktop/Documents/Downloads, which macOS keeps"
      warn "off-limits to scheduled jobs. Move it somewhere plain and rerun:"
      echo
      echo "  mv \"$ROOT\" \"\$HOME/argus\" && cd \"\$HOME/argus\" && bash setup/setup-linux-mac.sh"
      echo
      exit 1 ;;
  esac
fi

# ➤ Characters cron cannot survive (audit 2026-08-08). The schedule below
# ➤ single-quotes every path, which a quote in the path would break out of —
# ➤ and cron reads a bare % as a newline mid-command. A path like "my argus"
# ➤ used to produce a crontab whose lines failed every minute for ever while
# ➤ this setup still printed "schedule installed".
case "$ROOT" in
  (*"'"*|*"%"*)
    warn "This folder's path contains a quote (') or a percent sign (%), which the"
    warn "cron schedule cannot carry. Move the folder to a plainer path and rerun:"
    echo
    echo "  mv \"$ROOT\" \"\$HOME/argus\" && cd \"\$HOME/argus\" && bash setup/setup-linux-mac.sh"
    echo
    exit 1 ;;
esac

# ── 1. Node ──────────────────────────────────────────────────────────────
# ➤ 20, not 18: playwright (which prints the cover letters) requires it.
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed. Get it from https://nodejs.org (version 20 or"
  warn "newer), install it, and run the installer again."
  exit 1
fi
# ➤ A node that EXISTS is not a node that RUNS (field case 2026-08-26, macOS).
# ➤ Homebrew replaced the icu4c its own node was built against, so every node
# ➤ call died with "Library not loaded … not in dyld cache". This gate asked
# ➤ the broken binary for its version, got nothing back, and compared "" with
# ➤ 20 — which bash reports as an ERROR, not as a false, so the `if` did not
# ➤ fire and the setup walked on to npm. There the user met a wall of linker
# ➤ noise and three words of ours: "npm install failed". Ask node to speak,
# ➤ and check that what came back is a version.
# ➤ stderr is captured ON PURPOSE and the exit code is NOT used to blank it:
# ➤ what a broken node prints IS the diagnosis, and clearing it on failure
# ➤ threw away the one line that tells the user which library went missing.
NODE_SAYS="$(node -p 'process.versions.node' 2>&1)"
case "$NODE_SAYS" in
  (""|*[!0-9.]*)
    warn "Node is installed, but it cannot run."
    if [ -n "$NODE_SAYS" ]; then
      printf '%s\n' "$NODE_SAYS" | head -3 | sed 's/^/      /'
    else
      warn "It crashed without saying anything."
    fi
    case "$NODE_SAYS" in
      (*dyld*|*"Library not loaded"*|*"image not found"*)
        warn "This is a broken Node, not an Argus problem: a library it was built"
        warn "against was replaced underneath it, which Homebrew does on upgrade."
        warn "Reinstall Node and run this again:"
        echo
        echo "  brew reinstall node"
        echo ;;
      (*)
        warn "Reinstall Node 20 or newer from https://nodejs.org and run this again." ;;
    esac
    exit 1 ;;
esac
NODE_MAJOR="${NODE_SAYS%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node v$NODE_SAYS is too old. Argus needs 20 or newer (playwright, which prints the cover letters, requires it)."
  exit 1
fi
ok "Node v$NODE_SAYS"

# ── 2. Dependencies ──────────────────────────────────────────────────────
# ➤ Not only when node_modules is missing (audit 2026-08-08): an UPDATE copies
# ➤ a fresh package-lock.json over the install, and the old gate then skipped
# ➤ npm entirely — the first release to add a dependency would leave every
# ➤ updating user crashing on import, and re-running the installer (the
# ➤ advertised repair) took the same skip branch. The lock file being newer
# ➤ than node_modules is the tell; a no-op npm install costs seconds.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "Installing dependencies"
  # ➤ error level only: npm's "notice" chatter is noise to someone installing
  # ➤ a bot, and it half-arrives in the OS language.
  npm install --no-audit --no-fund --loglevel=error || { warn "npm install failed"; exit 1; }
  touch node_modules 2>/dev/null || true
fi
ok "dependencies installed"

# ── 3. The schedule, installed without asking ────────────────────────────
# ➤ The listener line is what answers Telegram at all, so it exists BEFORE the
# ➤ token step: the moment the token is saved, the bot is already listening.
# ➤ THIS INSTALLER OWNS THE SCHEDULE (field case 2026-08-06): every Argus line
# ➤ is removed first, whichever folder it points at — reinstalls used to leave
# ➤ several listeners alive, and each one answered, so the user saw the same
# ➤ questions arrive in duplicate and triplicate.
# ➤ The listener is ALWAYS-ON (long polling) and the minute line is its
# ➤ watchdog. With flock, the running listener holds the lock and later ticks
# ➤ cost nothing; macOS ships no flock, so there the ticks run bare and yield
# ➤ to the live listener via its listener-alive.json heartbeat.
say "Scheduling"
if command -v crontab >/dev/null 2>&1; then
  CRON_TMP="$(mktemp 2>/dev/null || echo "/tmp/argus-cron.$$")"
  crontab -l 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      (*"server-bot/telegram-listener.mjs"*|*"server-bot/scan.mjs"*|*"server-bot/housekeep.mjs"*) continue ;;
    esac
    printf '%s\n' "$line"
  done > "$CRON_TMP"
  FLOCK_L=""
  FLOCK_S=""
  if command -v flock >/dev/null 2>&1; then
    FLOCK_L="$(command -v flock) -n /tmp/argus-listener.lock "
    FLOCK_S="$(command -v flock) -n /tmp/argus-scan.lock "
  fi
  # ➤ Paths SINGLE-QUOTED (audit 2026-08-08): unquoted, a folder with a space
  # ➤ produced "cd /home/u/my && argus/..." — four cron lines failing every
  # ➤ run for ever, with the diagnosis greping for the broken line and
  # ➤ reporting OK. Quotes and % in the path are refused at the top.
  NODE_BIN="$(command -v node)"
  {
    cat "$CRON_TMP"
    echo "* * * * * cd '$ROOT' && ${FLOCK_L}'$NODE_BIN' server-bot/telegram-listener.mjs >> '$ROOT/server-bot/listener.log' 2>&1"
    echo "0 */2 * * * cd '$ROOT' && ${FLOCK_S}'$NODE_BIN' server-bot/scan.mjs >> '$ROOT/server-bot/scan.log' 2>&1"
    echo "30 7 * * * cd '$ROOT' && '$NODE_BIN' server-bot/housekeep.mjs --liveness-only >> '$ROOT/server-bot/scan.log' 2>&1"
    echo "0 9 * * 0 cd '$ROOT' && '$NODE_BIN' server-bot/housekeep.mjs >> '$ROOT/server-bot/scan.log' 2>&1"
  } | crontab - && ok "schedule installed (this copy is now the only Argus scheduled)"
  rm -f "$CRON_TMP"
  # ➤ TRUST NOTHING: the listener starts right now, so the bot answers within
  # ➤ seconds instead of within a minute. This IS the always-on listener; the
  # ➤ cron line above only revives it if it ever dies.
  node server-bot/telegram-listener.mjs >/dev/null 2>&1 &
else
  warn "No crontab on this machine — nothing can be scheduled. On Windows, use"
  warn "the native installer instead; elsewhere, schedule server-bot/telegram-listener.mjs"
  warn "(every minute, as a watchdog) and server-bot/scan.mjs (every 2h) with what you have."
fi

# ── 4. The bot token, the ONE thing typed by hand ────────────────────────
CFG="server-bot/telegram.json"
LINKED=no
if grep -q '"chat_id"[[:space:]]*:[[:space:]]*"[0-9-]\{1,\}"' "$CFG" 2>/dev/null; then
  LINKED=yes
  ok "Telegram already linked — nothing to do here"
else
  BOTUSER=""
  # ➤ A repair run must not make anyone re-type: a token saved by an earlier
  # ➤ attempt is revalidated with getMe and reused, fresh link code included.
  OLDTOKEN="$(sed -n 's/.*"bot_token": *"\([^"]*\)".*/\1/p' "$CFG" 2>/dev/null | head -1)"
  if [ -n "$OLDTOKEN" ]; then
    ME="$(curl -fsS --max-time 15 "$TG_API/bot$OLDTOKEN/getMe" 2>/dev/null || true)"
    BOTUSER="$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
    if [ -n "$BOTUSER" ]; then
      CODE="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 8)"
      [ -n "$CODE" ] || CODE="argus$$"
      printf '{"bot_token": "%s", "chat_id": "", "link_code": "%s"}\n' "$OLDTOKEN" "$CODE" > "$CFG"
      ok "found the token from an earlier run — your bot is @$BOTUSER"
    fi
  fi
  if [ -z "$BOTUSER" ]; then
  say "Your Telegram bot"
  echo "  1. In Telegram, open @BotFather and send it:  /newbot"
  echo "  2. Give it any name, and a username ending in 'bot'."
  echo "  3. Copy the token it answers with (123456789:AAHk8s...)."
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 5 ] && [ -z "$BOTUSER" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    printf '  Paste the token here: '
    read -r TOKEN
    if ! printf '%s' "$TOKEN" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$'; then
      warn "That does not look like a token — copy the whole line @BotFather sent."
      continue
    fi
    # ➤ getMe answers instantly whether the token is real, and gives the bot's
    # ➤ username for the one-tap link below. No waiting for messages.
    ME="$(curl -fsS --max-time 15 "$TG_API/bot$TOKEN/getMe" 2>/dev/null || true)"
    BOTUSER="$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
    if [ -z "$BOTUSER" ]; then
      warn "Telegram rejected that token — check it and paste it again."
      continue
    fi
    # ➤ A random code rides the START link, and only the tap carrying it may
    # ➤ bind the chat — a stranger who finds the bot first cannot claim it.
    # ➤ (Start-token idea: Advanced Web Machinery, advancedweb.hu, "The easiest
    # ➤ way to set up a chat with your Telegram bot".)
    CODE="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 8)"
    [ -n "$CODE" ] || CODE="argus$$"
    printf '{"bot_token": "%s", "chat_id": "", "link_code": "%s"}\n' "$TOKEN" "$CODE" > "$CFG"
    chmod 600 "$CFG" 2>/dev/null || true
    ok "token saved — your bot is @$BOTUSER"
  done
  fi
  if [ -z "$BOTUSER" ]; then
    warn "No valid token. Run the installer again when you have it; everything else is ready."
    exit 1
  fi

  # ── 5. One tap links everything ────────────────────────────────────────
  # ➤ The scheduled listener is already polling. The user opens the link, taps
  # ➤ START, and that single tap links the chat AND begins the profile
  # ➤ questions. This console just watches telegram.json for the link.
  say "Last step — one tap:"
  echo
  echo "      https://t.me/$BOTUSER?start=$CODE"
  echo
  echo "  Open that link (phone or desktop) and press START."
  # ➤ The pasteable twin (field test 2026-08-23): with the bot's chat already
  # ➤ open, the natural move is to PASTE — and a t.me link pasted as a message
  # ➤ is just text the listener ignores. This line is what that tap sends.
  echo "  Already in the bot's chat? Send it this message instead:  /start $CODE"
  echo "  Waiting..."
  WAITED=0
  while [ "$LINKED" = no ] && [ "$WAITED" -lt 180 ]; do
    sleep 5
    WAITED=$((WAITED + 5))
    if grep -q '"chat_id"[[:space:]]*:[[:space:]]*"[0-9-]\{1,\}"' "$CFG" 2>/dev/null; then LINKED=yes; fi
  done
  if [ "$LINKED" = yes ]; then
    ok "linked. The bot is asking your first question in Telegram — answer it there."
  else
    warn "No tap seen yet — no problem: the link completes the moment you press START."
    warn "This window can be closed."
  fi
fi

# ── 6. Optional extras, only reported ────────────────────────────────────
say "Optional extras (nothing breaks without them)"
[ -f server-bot/adzuna-key.json ] && ok "Adzuna key present" \
  || echo "  - Adzuna key (free, https://developer.adzuna.com/) → one more job board. Save it to server-bot/adzuna-key.json as {\"app_id\":\"...\",\"app_key\":\"...\"}"
if command -v claude >/dev/null 2>&1; then ok "Claude CLI present"
elif command -v codex >/dev/null 2>&1; then ok "Codex CLI present"
else echo "  - An AI CLI → cover letters ('cover N') and the Council. Claude: npm i -g @anthropic-ai/claude-code, then: claude setup-token. Or Codex: npm i -g @openai/codex, then: codex login"
fi
echo "  - Chromium (npx playwright install chromium) → cover letters as PDF"

say "Done. Everything else happens in Telegram ('help' lists the commands)."
