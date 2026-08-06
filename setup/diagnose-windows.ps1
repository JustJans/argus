# -----------------------------------------------------------------------------
# Argus - Windows diagnosis. Double-click diagnose-windows.bat to run this.
# Read-only except for one thing: it runs the listener once in the foreground,
# so any crash that Task Scheduler swallows is printed HERE, on screen.
# Born from a field install where the bot stayed mute after a clean-looking
# setup and nobody could see why (2026-08-05).
# -----------------------------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root
function Say($msg)  { Write-Host ""; Write-Host $msg }
function Ok($msg)   { Write-Host "  OK  $msg" }
function Bad($msg)  { Write-Host "  !!  $msg" }

Say "Argus diagnosis - $root"

# -- 1. Node ------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Ok "Node $(& $node.Source -v) at $($node.Source)" }
else { Bad "Node is not on the PATH. Run setup\setup-windows.bat first."; Read-Host "  Press Enter to close"; exit 1 }

# -- 2. The listener task -----------------------------------------------------
# ➤ The listener is what answers Telegram at all; every silent-bot report so
# ➤ far came down to this task not existing, not running, or pointing at a
# ➤ different unzipped copy than the one the user is looking at.
$t = Get-ScheduledTask -TaskName 'Argus listener' -ErrorAction SilentlyContinue
if (-not $t) {
    Bad "The 'Argus listener' task DOES NOT EXIST. The bot cannot answer anything."
    Bad "Fix: run setup\setup-windows.bat and answer y to the scheduled-tasks question."
} else {
    Ok "task exists - state: $($t.State)"
    $act = $t.Actions[0]
    Write-Host "      runs: $($act.Execute) $($act.Arguments)"
    Write-Host "      from: $($act.WorkingDirectory)"
    if ($act.WorkingDirectory -ne $root) {
        Bad "The task points at ANOTHER copy of Argus, not this folder."
        Bad "Fix: run setup\setup-windows.bat from THIS folder (it replaces the task)."
    }
    $info = Get-ScheduledTaskInfo -TaskName 'Argus listener' -ErrorAction SilentlyContinue
    if ($info) {
        Write-Host "      last run: $($info.LastRunTime)  result: $($info.LastTaskResult)"
        if ($info.LastTaskResult -eq 267011) { Bad "Result 267011 = the task has NEVER run yet." }
        elseif ($info.LastTaskResult -ne 0) { Bad "Nonzero result = the last run FAILED. The live run below should show why." }
        else { Ok "the last scheduled run finished cleanly" }
    }
}

# -- 3. Telegram config -------------------------------------------------------
$cfgPath = Join-Path $root 'server-bot\telegram.json'
if (-not (Test-Path $cfgPath)) {
    Bad "server-bot\telegram.json does not exist - the Telegram link never happened."
    Bad "Fix: run setup\setup-windows.bat (the token step)."
} else {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        if ($cfg.bot_token -match '^[0-9]{6,}:') { Ok "bot token present (starts $($cfg.bot_token.Substring(0, 6))...)" }
        else { Bad "the bot token does not look like a token - re-run the setup token step" }
        if ($cfg.chat_id -match '^[0-9-]+$') { Ok "chat linked (id $($cfg.chat_id))" }
        else { Bad "chat_id is EMPTY: the link step never finished. Run: node server-bot\notify.mjs --setup" }
    } catch { Bad "telegram.json exists but does not parse: $($_.Exception.Message)" }
}

# -- 4. Has the listener ever ticked? -----------------------------------------
# ➤ The offset file is written on the listener's very first successful tick,
# ➤ so its absence separates "never ran" from "runs but something else fails".
$off = Join-Path $root 'data\telegram-offset.json'
if (Test-Path $off) { Ok "the listener has ticked before (data\telegram-offset.json, last $((Get-Item $off).LastWriteTime))" }
else { Bad "data\telegram-offset.json does not exist: the listener has NEVER completed a tick." }

# -- 5. One live run, on screen -----------------------------------------------
# ➤ Task Scheduler swallows all output; this run swallows nothing. If the
# ➤ listener crashes on this machine, the reason prints right here.
Say "Running the listener ONCE in this window (its errors, if any, print below):"
& $node.Source (Join-Path $root 'server-bot\telegram-listener.mjs')
Write-Host "  listener exit code: $LASTEXITCODE"
if ($LASTEXITCODE -eq 0) { Ok "the listener ran cleanly. If everything above is OK too, send /start to the bot NOW - it should answer within a minute." }
else { Bad "THAT exit code and the lines above are the reason the bot is mute. Send a photo of this window." }

Read-Host "  Finished - press Enter to close"
