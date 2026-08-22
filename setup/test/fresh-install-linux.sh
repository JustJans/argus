#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# A FULL, REAL install on a throwaway machine account, against the mock
# Telegram — the one-line installer exactly as a new user runs it: download,
# npm install, schedule into THIS account's crontab, token, and the START tap.
#
# Run it as a user that owns nothing (its crontab gets rewritten):
#   sudo useradd -m argustest
#   sudo -u argustest bash setup/test/fresh-install-linux.sh
#
# It caught a real one on its first run: install.sh died at `exec … < /dev/tty`
# in a session with no controlling terminal, leaving the folder downloaded and
# nothing else — the "it stopped halfway" shape a field tester reported.
# ─────────────────────────────────────────────────────────────────────────────
set -u
MOCK_PORT="${MOCK_PORT:-8099}"
MOCK_JS="${MOCK_JS:-$(cd "$(dirname "$0")" && pwd)/mock-telegram.mjs}"
BRANCH="${ARGUS_BRANCH:-master}"
export ARGUS_TG_API="http://127.0.0.1:${MOCK_PORT}"
export ARGUS_DEST="$HOME/argus"

echo "################ 1. THE MOCK TELEGRAM ################"
MOCK_PORT=$MOCK_PORT node "$MOCK_JS" &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1
curl -s "$ARGUS_TG_API/bot123/getMe" && echo "  (mock answers getMe)"

echo
echo "################ 2. THE ONE-LINE INSTALLER ################"
echo "\$ curl -fsSL .../install.sh | bash"
echo
# ➤ The token is the only thing a human types. Fetch-then-run so the answer can
# ➤ reach the SETUP's prompt: `| bash < file` hands the file to bash instead.
printf '111222333:AAHtestTOKENtestTOKENtestTOKENtest01\n' > "$HOME/answers.txt"
curl -fsSL "https://raw.githubusercontent.com/JustJans/argus/$BRANCH/install.sh" -o "$HOME/install.sh"
setsid bash "$HOME/install.sh" < "$HOME/answers.txt" > "$HOME/install.log" 2>&1 &
INSTALL_PID=$!

# ➤ Meanwhile the "user" opens the t.me link and taps START, with whatever code
# ➤ the setup wrote into telegram.json.
TAPPED=no
for _ in $(seq 1 90); do
  sleep 2
  CODE="$(sed -n 's/.*"link_code": *"\([^"]*\)".*/\1/p' "$ARGUS_DEST/server-bot/telegram.json" 2>/dev/null | head -1)"
  if [ -n "$CODE" ] && [ "$TAPPED" = no ]; then
    TAPPED=yes
    echo "   >>> [the user taps START on the t.me link, code $CODE] <<<"
    curl -s "$ARGUS_TG_API/_test/start?code=$CODE" >/dev/null
    sleep 2
    (cd "$ARGUS_DEST" && node server-bot/telegram-listener.mjs --once >/dev/null 2>&1)
  fi
  kill -0 $INSTALL_PID 2>/dev/null || break
done
wait $INSTALL_PID 2>/dev/null

echo "----- what the installer printed on screen -----"
sed 's/^/   /' "$HOME/install.log"

echo
echo "################ 3. WHAT THE MACHINE ENDED UP WITH ################"
echo "-- folder:"; ls "$ARGUS_DEST" 2>/dev/null | tr '\n' ' '; echo
echo "-- crontab of this user:"; crontab -l 2>/dev/null | sed 's/^/   /'
echo "-- telegram.json:"; sed 's/\(bot_token": "[0-9]*:\)[^"]*/\1REDACTED/' "$ARGUS_DEST/server-bot/telegram.json" 2>/dev/null | sed 's/^/   /'
echo "-- node_modules:"; [ -d "$ARGUS_DEST/node_modules" ] && echo "   present" || echo "   MISSING"

echo
echo "################ 4. THE CHAT, AS THE USER SEES IT ################"
curl -s "$ARGUS_TG_API/_test/messages" | node -e '
let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  for (const m of JSON.parse(d)) {
    if (m.kind === "message") console.log("   BOT >", JSON.stringify(m.text).slice(0,300));
    else if (m.kind === "delete") console.log("   BOT x (deleted a message)");
  }
});'
echo
echo "################ DONE ################"
