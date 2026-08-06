# -----------------------------------------------------------------------------
# Argus - guided setup for Windows.
# Double-click setup-windows.bat, right next to this file; the .bat
# exists because double-clicking a .ps1 opens Notepad instead of running it.
# No Git Bash, no WSL, no admin rights. It mirrors setup-linux-mac.sh step by
# step: only the Telegram token is required, it can install Node.js by itself,
# and it offers to create the scheduled tasks.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
# ➤ This file lives in setup\, but every path in the setup is spoken from
# ➤ the project root, one level up.
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root

# ➤ Plain monochrome on purpose; the field tester called the colored version
# ➤ tacky, and OK/! carry the meaning on their own.
function Say($msg)  { Write-Host ""; Write-Host $msg }
function Ok($msg)   { Write-Host "  OK  $msg" }
function Warn($msg) { Write-Host "  !   $msg" }
# ➤ Strict y/n: 'y' is yes, 'n' is no, anything else is not an answer and the
# ➤ question is asked again. No silent defaults.
function Ask-YesNo($prompt) {
    while ($true) {
        $ans = Read-Host $prompt
        if ($ans -eq 'y') { return $true }
        if ($ans -eq 'n') { return $false }
        Write-Host "  Please answer y or n."
    }
}

Say "Argus setup"

# -- 1. Node ------------------------------------------------------------------
# ➤ 20, not 18: playwright (which prints the cover letters) requires it. On 18
# ➤ the setup used to finish happily and the first "cover N" was the thing that
# ➤ failed - long after anyone would connect the two.
# ➤ If Node is missing, winget (preinstalled on Windows 10/11) can install it
# ➤ right here, so "install Node yourself" stops being the user's problem.
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
$node = Find-Node
if (-not $node) {
    Warn "Node.js is not installed. Argus runs on it, so it is the one real requirement."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        if (Ask-YesNo "  Install Node.js LTS now? (y/n)") {
            Write-Host "  Downloading and installing Node.js LTS - this takes a minute or two."
            Write-Host "  Windows will ask for permission to install it; accept that prompt."
            # ➤ winget narrates in the machine's language, store legalese and
            # ➤ all; none of it helps, so its output only shows when it FAILS.
            $wout = winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1
            if ($LASTEXITCODE -ne 0) { $wout | ForEach-Object { Write-Host "  $_" } }
            # ➤ The installer edits the PATH of FUTURE consoles, not this one.
            # ➤ Reloading it here saves the user a mystifying "close everything
            # ➤ and start again" instruction on their very first step.
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                        [Environment]::GetEnvironmentVariable('Path', 'User')
            $node = Find-Node
        }
    }
    if (-not $node) {
        Warn "Get Node.js from https://nodejs.org (version 20 or newer), install it,"
        Warn "then double-click setup\setup-windows.bat again."
        Start-Process "https://nodejs.org"
        Read-Host "  Press Enter to close"
        exit 1
    }
}
$nodeMajor = [int](& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    Warn "Node $(& $node -v) is too old. Argus needs 20 or newer (playwright, which prints the cover letters, requires it)."
    Read-Host "  Press Enter to close"
    exit 1
}
Ok "Node $(& $node -v)"

# -- 2. Dependencies ----------------------------------------------------------
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Say "Installing dependencies (npm install)"
    # ➤ error level only: npm's "notice" chatter (new-version adverts included)
    # ➤ is noise to someone installing a bot, and it half-arrives in Spanish.
    & npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Warn "npm install failed"; Read-Host "  Press Enter to close"; exit 1 }
}
Ok "dependencies installed"

# -- 3 + 4. Telegram bot: the token, then the chat ----------------------------
# ➤ One step, not two, because they fail into each other (see setup-linux-mac.sh). The
# ➤ token is the only thing typed by hand in this whole setup, so a typo in it
# ➤ is the likeliest failure - and it must be re-askable, never saved and
# ➤ silently trusted forever.
$cfg = Join-Path $root 'server-bot\telegram.json'

function Ask-Token {
    Say "Telegram bot"
    Write-Host "  Open Telegram, talk to @BotFather, send /newbot and copy the token it gives you."
    Write-Host "  It looks like: 123456789:AAHk8s...  (numbers, a colon, then letters)"
    $token = Read-Host "  Paste the token here"
    if (-not $token) { return 1 }
    if ($token -notmatch '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$') {
        Warn "That does not look like a bot token (expected 123456789:AAHk8s...)."
        Warn "Copy the whole line @BotFather sent, with nothing before or after it."
        return 2
    }
    # ➤ Written without a BOM on purpose: Out-File would prepend one on Windows
    # ➤ PowerShell and JSON.parse chokes on it - the bot would then report its
    # ➤ own config file as broken.
    [System.IO.File]::WriteAllText($cfg, "{`"bot_token`": `"$token`", `"chat_id`": `"`"}`n")
    Ok "saved to server-bot\telegram.json"
    return 0
}

$telegramReady = $false
$linked = $false
if (Test-Path $cfg) {
    try { $linked = ((Get-Content $cfg -Raw | ConvertFrom-Json).chat_id -match '^[0-9-]+$') } catch { }
}
if ($linked) {
    Ok "Telegram already linked (token and chat id are in server-bot\telegram.json)"
    $telegramReady = $true
} else {
    # ➤ Up to three goes at the token, then carry on regardless: the rest of
    # ➤ the install is still worth finishing, and this step can be redone alone.
    $attempt = 0
    while (-not $telegramReady -and $attempt -lt 3) {
        $attempt += 1
        $hasToken = $false
        if (Test-Path $cfg) {
            try { $hasToken = [bool](Get-Content $cfg -Raw | ConvertFrom-Json).bot_token } catch { }
        }
        if (-not $hasToken) {
            $rc = Ask-Token
            if ($rc -eq 2) { continue }
            if ($rc -ne 0) { Warn "No token given."; break }
        } else {
            Ok "telegram.json already has a token"
        }

        Say "Linking your chat"
        Write-Host "  Send ANY message to your bot in Telegram now (say 'hi')."
        Read-Host "  Done? press Enter to continue"

        & $node server-bot/notify.mjs --setup
        if ($LASTEXITCODE -eq 0) {
            $telegramReady = $true
        } elseif ($LASTEXITCODE -eq 2) {
            # ➤ 2 = Telegram rejected the token itself. Offer to type it again.
            if ($attempt -lt 3) {
                if (-not (Ask-YesNo "  Paste the token again? (y/n)")) { break }
                Remove-Item $cfg -ErrorAction SilentlyContinue
            }
        } else {
            # ➤ Anything else: the token is fine — the message simply has not
            # ➤ arrived (or the network blinked). This used to be a dead end
            # ➤ that forced restarting the whole setup (field test 2026-08-03);
            # ➤ now it loops back and asks again, up to the attempt cap.
            Warn "No message found. Make sure you sent one to the bot; let's try again."
        }
    }
}

if (-not $telegramReady) {
    Warn "Telegram is not linked yet. Everything else below still applies;"
    Warn "when you have it sorted, finish with:  node server-bot\notify.mjs --setup"
}

# -- 5. Scheduling ------------------------------------------------------------
# ➤ Task Scheduler is Windows's cron. Registered per-user (no admin needed) via
# ➤ the ScheduledTasks module: Execute and Argument travel separately, so none
# ➤ of the schtasks.exe nested-quoting misery applies. IgnoreNew = flock -n:
# ➤ a long-poll listener already running must not be started twice.
Say "Scheduling"
$existing = Get-ScheduledTask -TaskName 'Argus listener' -ErrorAction SilentlyContinue
if ($existing -and $existing.Actions[0].WorkingDirectory -eq $root) {
    Ok "This copy of Argus is already in Task Scheduler - leaving it alone"
} else {
    Write-Host "  Argus needs to run on a schedule. The listener (every minute) is what"
    Write-Host "  receives your Telegram commands - without it the bot cannot answer, not"
    Write-Host "  even /start. The other three: a scan every 2h, and two cleanups."
    Write-Host "  The machine only runs them while it is awake, which is fine: a laptop"
    Write-Host "  you close simply searches when you open it again."
    if (Ask-YesNo "  Create these 4 scheduled tasks? (y/n)") {
        # ➤ Battery switches VERIFIED on a real machine (field test 2026-08-05):
        # ➤ by default Task Scheduler refuses to start tasks on battery power,
        # ➤ which silences the whole bot on any laptop that is not plugged in.
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $mkAction = { param($script, $extra)
            $arg = "`"$(Join-Path $root $script)`""
            if ($extra) { $arg = "$arg $extra" }
            New-ScheduledTaskAction -Execute $node -Argument $arg -WorkingDirectory $root
        }
        # ➤ TEN YEARS, NOT [TimeSpan]::MaxValue. MaxValue looks like the obvious
        # ➤ "for ever" and Register-ScheduledTask REJECTS it: "The task XML
        # ➤ contains a value which is incorrectly formatted or out of range
        # ➤ (Duration:P99999999DT23H59M59S)" — verified on a real machine. That
        # ➤ single value silently cost the field tester BOTH repeating tasks,
        # ➤ and without the listener the bot cannot even answer /start.
        $forever = New-TimeSpan -Days 3650
        $jobs = @(
            @{ Name = 'Argus listener'; Script = 'server-bot\telegram-listener.mjs'; Extra = $null
               Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration $forever },
            # ➤ The first scan waits half an hour: firing at once, it talked over
            # ➤ the setup ("No pending offers") before the user even reached the
            # ➤ /start questions. The listener DOES start now — it is what
            # ➤ answers /start at all.
            @{ Name = 'Argus scan'; Script = 'server-bot\scan.mjs'; Extra = $null
               Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration $forever },
            @{ Name = 'Argus links'; Script = 'server-bot\housekeep.mjs'; Extra = '--liveness-only'
               Trigger = New-ScheduledTaskTrigger -Daily -At '07:30' },
            @{ Name = 'Argus cleanup'; Script = 'server-bot\housekeep.mjs'; Extra = $null
               Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '09:00' }
        )
        $created = 0
        foreach ($j in $jobs) {
            try {
                Register-ScheduledTask -TaskName $j.Name -Action (& $mkAction $j.Script $j.Extra) `
                    -Trigger $j.Trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
                $created += 1
            } catch {
                Warn "could not create '$($j.Name)': $($_.Exception.Message)"
            }
        }
        if ($created -eq 4) { Ok "4 scheduled tasks created (see them in Task Scheduler)" }
        elseif ($created -gt 0) { Warn "only $created of 4 tasks were created - see the messages above" }
        # ➤ TRUST NOTHING: the listener is what answers Telegram at all, so its
        # ➤ task is checked back and kicked once right now — the bot should say
        # ➤ hello within seconds, while the user is still looking at this window.
        if (Get-ScheduledTask -TaskName 'Argus listener' -ErrorAction SilentlyContinue) {
            try { Start-ScheduledTask -TaskName 'Argus listener' } catch { }
            Ok "the listener is registered and has been started once right now"
        } else {
            Warn "THE LISTENER TASK DOES NOT EXIST - the bot cannot answer any Telegram"
            Warn "command without it. Re-run this setup, or create it by hand:"
            Write-Host "  schtasks /create /f /tn `"Argus listener`" /sc minute /mo 1 /tr '`"$node`" `"$(Join-Path $root 'server-bot\telegram-listener.mjs')`"'"
        }
    } else {
        Warn "Skipped. Run setup\setup-windows.bat again when you are ready, or create them in Task Scheduler yourself (the four commands are in the README)."
    }
}

# -- 6. The profile - do this NOW, before the first scan fires ----------------
Say "Your profile - do this next"
Write-Host "  Open Telegram and send /start to your bot. It asks a few questions and"
Write-Host "  writes config\profile.yml and cv.md for you ('settings' edits them later)."
Write-Host "  Until you do, Argus searches with the marine/offshore EXAMPLE profile, so"
Write-Host "  the first list it sends will not be yours. That is expected, not a fault."

# -- 7. Optional extras, only reported ----------------------------------------
Say "Optional extras (nothing breaks without them)"
if (Test-Path (Join-Path $root 'server-bot\adzuna-key.json')) { Ok "Adzuna key present" }
else { Write-Host "  - Adzuna key (free, https://developer.adzuna.com/) -> one more job board. Save it to server-bot\adzuna-key.json as {`"app_id`":`"...`",`"app_key`":`"...`"}" }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude CLI present" }
else { Write-Host "  - Claude CLI -> AI cover letters ('cover N') and the Council. Install: npm i -g @anthropic-ai/claude-code, then: claude setup-token" }
Write-Host "  - Chromium (npx playwright install chromium) -> cover letters as PDF"

Say "Done"
if ($telegramReady) {
    Write-Host "  1. Send /start to your bot (see above) - this is the step that makes it yours."
    Write-Host "  2. Then send 'search' to look right away instead of waiting for the schedule."
    Write-Host "  3. 'help' lists every command."
} else {
    Write-Host "  1. Link Telegram:  node server-bot\notify.mjs --setup"
    Write-Host "     (it tells you exactly what is missing: the token, or a first message)"
    Write-Host "  2. Then send /start to your bot - the step that makes it yours."
    Write-Host "  3. Then 'search', and 'help' for every command."
}
Write-Host ""
Write-Host "  Check the install at any time:  npm test"
Read-Host "  Finished - press Enter to close"
