# -----------------------------------------------------------------------------
# Argus - guided setup for Windows. The one-line installer runs this; by hand,
# double-click setup-windows.bat next to it (a .ps1 opens Notepad if clicked).
# THE CONTRACT: the user types the bot token and taps START in Telegram, and
# nothing else. Running the installer IS the consent, so nothing here asks
# "are you sure" - it installs Node if missing, installs dependencies,
# registers the scheduled tasks (hidden: no flashing console every minute)
# and waits for the one tap that links the chat and starts the questions.
# Runs on Windows PowerShell 5.1, the one every Windows ships.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
# ➤ This file lives in setup\; every path is spoken from the project root.
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root

function Say($msg)  { Write-Host ""; Write-Host $msg }
function Ok($msg)   { Write-Host "  OK  $msg" }
function Warn($msg) { Write-Host "  !   $msg" }

# ➤ The Telegram host, overridable for testing only. Default is the real one.
$tgApi = if ($env:ARGUS_TG_API) { $env:ARGUS_TG_API } else { 'https://api.telegram.org' }

Say "Argus setup"

# -- 1. Node ------------------------------------------------------------------
# ➤ 20, not 18: playwright (which prints the cover letters) requires it.
# ➤ If Node is missing, winget (preinstalled on Windows 10/11) installs it
# ➤ without asking: the user already asked by running the installer.
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
$node = Find-Node
if (-not $node) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Say "Installing Node.js LTS (Argus runs on it) - this takes a minute or two."
        Write-Host "  Windows will ask for permission to install it; accept that prompt."
        # ➤ winget narrates in the machine's language, store legalese and all;
        # ➤ its output only shows when the install FAILS.
        $wout = winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1
        if ($LASTEXITCODE -ne 0) { $wout | ForEach-Object { Write-Host "  $_" } }
        # ➤ The installer edits the PATH of FUTURE consoles, not this one.
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Find-Node
    }
    if (-not $node) {
        Warn "Node.js could not be installed automatically. Get it from https://nodejs.org"
        Warn "(version 20 or newer), install it, then run the installer again."
        Start-Process "https://nodejs.org"
        Read-Host "  Press Enter to close"
        exit 1
    }
}
# ➤ A node that EXISTS is not a node that RUNS. Asking a broken one for its
# ➤ version returns nothing, [int]$null is 0, and 0 is younger than 20 — so the
# ➤ setup used to stop with "your Node is too old" in front of a Node that was
# ➤ not old at all, sending the user to upgrade something already current.
# ➤ Ask it to speak, keep what it says, and check that it is a version.
$nodeSays = (& $node -p "process.versions.node" 2>&1 | Out-String).Trim()
if ($nodeSays -notmatch '^\d+(\.\d+)*$') {
    Warn "Node is installed, but it cannot run."
    if ($nodeSays) { $nodeSays -split "`n" | Select-Object -First 3 | ForEach-Object { "      $_" } }
    else { Warn "It crashed without saying anything." }
    Warn "Reinstall Node 20 or newer from https://nodejs.org and run this again."
    Read-Host "  Press Enter to close"
    exit 1
}
if ([int]($nodeSays -split '\.')[0] -lt 20) {
    Warn "Node v$nodeSays is too old. Argus needs 20 or newer (playwright, which prints the cover letters, requires it)."
    Read-Host "  Press Enter to close"
    exit 1
}
Ok "Node v$nodeSays"

# -- 1b. The app's face -------------------------------------------------------
# ➤ Task Manager shows the process NAME, and "node.exe" tells the user nothing
# ➤ — worse, it reads as something foreign eating their CPU. Node copied under
# ➤ the product's name IS still Node: the Authenticode signature covers the
# ➤ bytes, not the filename, so it stays valid — and every Argus process (the
# ➤ listener and the children it spawns via process.execPath) then appears in
# ➤ Task Manager as argus.exe. Refreshed on every run, so a Node upgrade
# ➤ reaches the copy the next time the installer or the repair runs.
$argusExe = Join-Path $root 'argus.exe'
try { Stop-ScheduledTask -TaskName 'Argus listener' -ErrorAction Stop | Out-Null } catch { }
try {
    Copy-Item $node $argusExe -Force -ErrorAction Stop
    Ok "argus.exe in place (Node wearing the product's name)"
} catch {
    # ➤ A busy listener can hold the file. Yesterday's copy still works; with
    # ➤ none at all, the schedule falls back to node.exe - unbranded, not broken.
    if (Test-Path $argusExe) { Ok "argus.exe kept from the previous run (the file is busy right now)" }
    else { $argusExe = $node; Warn "could not create argus.exe - the tasks will show as node.exe" }
}

# -- 2. Dependencies ----------------------------------------------------------
# ➤ Not only when node_modules is missing (audit 2026-08-08): an UPDATE copies
# ➤ a fresh package-lock.json over the install, and the old gate then skipped
# ➤ npm entirely — the first release to add a dependency would leave every
# ➤ updating user with a bot crashing on import every minute, and re-running
# ➤ the installer (the advertised repair) took the same skip branch. The lock
# ➤ file being newer than node_modules is the tell; a no-op install is seconds.
$nmPath = Join-Path $root 'node_modules'
$lockPath = Join-Path $root 'package-lock.json'
$needInstall = -not (Test-Path $nmPath)
if (-not $needInstall -and (Test-Path $lockPath)) {
    try { $needInstall = (Get-Item $lockPath).LastWriteTime -gt (Get-Item $nmPath).LastWriteTime } catch { }
}
if ($needInstall) {
    Say "Installing dependencies"
    # ➤ error level only: npm's "notice" chatter is noise to someone installing
    # ➤ a bot, and it half-arrives in the OS language.
    & npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Warn "npm install failed"; Read-Host "  Press Enter to close"; exit 1 }
    # ➤ "Touch" so the gate above stays quiet until the NEXT update.
    try { (Get-Item $nmPath).LastWriteTime = Get-Date } catch { }
}
Ok "dependencies installed"

# -- 3. The schedule, registered without asking -------------------------------
# ➤ The listener task is what answers Telegram at all, so it exists BEFORE the
# ➤ token step: the moment the token is saved, the bot is already listening.
# ➤ Re-registering on every run is the repair path - a broken task heals by
# ➤ running the installer again.
# ➤ HIDDEN via setup\run-hidden.vbs: Task Scheduler pops a console window for
# ➤ every run of a console program, and the listener trigger fires EVERY
# ➤ MINUTE - a window flashing at the user (field report 2026-08-06). The
# ➤ listener itself is now always-on (long polling); IgnoreNew makes the
# ➤ minute trigger a watchdog that only restarts it after a death or reboot.
# ➤ Verified live: wscript.exe -> window style 0 -> node, marker written, no
# ➤ window. (S4U, the window-less principal, needs rights a plain user lacks -
# ➤ tested and denied.)
# ➤ Battery switches and the finite 10-year repetition are both field lessons:
# ➤ Task Scheduler refuses tasks on battery by default, and REJECTS
# ➤ [TimeSpan]::MaxValue as a duration.
Say "Scheduling"
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$vbs = Join-Path $root 'setup\run-hidden.vbs'
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$mkAction = { param($script, $extra)
    $arg = "//B //Nologo `"$vbs`" `"$argusExe`" `"$(Join-Path $root $script)`""
    if ($extra) { $arg = "$arg `"$extra`"" }
    New-ScheduledTaskAction -Execute $wscript -Argument $arg -WorkingDirectory $root
}
$forever = New-TimeSpan -Days 3650
$jobs = @(
    @{ Name = 'Argus listener'; Script = 'server-bot\telegram-listener.mjs'; Extra = $null
       Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration $forever },
    # ➤ The first scan waits half an hour, so it cannot talk over the setup.
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
# ➤ TRUST NOTHING: the listener is checked back and kicked once right now.
if (Get-ScheduledTask -TaskName 'Argus listener' -ErrorAction SilentlyContinue) {
    try { Start-ScheduledTask -TaskName 'Argus listener' } catch { }
    Ok "$created scheduled tasks in place; the listener is running (hidden - no windows)"
} else {
    Warn "THE LISTENER TASK DOES NOT EXIST - the bot cannot answer any Telegram"
    Warn "command without it. Send a photo of this window."
}

# -- 3b. A real entry in Settings > Installed apps ----------------------------
# ➤ Uninstalling must not require knowing that setup\uninstall-windows.bat
# ➤ exists: the standard per-user Uninstall key puts Argus in Settings >
# ➤ Installed apps with a working Uninstall button, like any other program.
# ➤ HKCU, so no administrator is involved - the same way every per-user
# ➤ installer (VS Code, Chrome) registers itself. Refreshed on every run.
try {
    $reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Argus'
    $ver = '1.0.0'
    try { $ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version } catch { }
    New-Item -Path $reg -Force | Out-Null
    Set-ItemProperty -Path $reg -Name DisplayName -Value 'Argus'
    Set-ItemProperty -Path $reg -Name DisplayVersion -Value "$ver"
    Set-ItemProperty -Path $reg -Name Publisher -Value 'JustJans (github.com/JustJans/argus)'
    Set-ItemProperty -Path $reg -Name InstallLocation -Value $root
    Set-ItemProperty -Path $reg -Name DisplayIcon -Value $argusExe
    Set-ItemProperty -Path $reg -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'setup\uninstall-windows.ps1')`""
    Set-ItemProperty -Path $reg -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $reg -Name NoRepair -Value 1 -Type DWord
    # ➤ The size Settings shows, in KB. Best effort: a wrong size is cosmetic.
    try {
        $kb = [int]((Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB)
        Set-ItemProperty -Path $reg -Name EstimatedSize -Value $kb -Type DWord
    } catch { }
    Ok "Argus is listed in Settings > Installed apps (the Uninstall button works)"
} catch { Warn "could not register in Installed apps: $($_.Exception.Message)" }

# -- 4. The bot token, the ONE thing typed by hand ----------------------------
$cfg = Join-Path $root 'server-bot\telegram.json'
$linked = $false
$botUser = $null
if (Test-Path $cfg) {
    try {
        $j = Get-Content $cfg -Raw | ConvertFrom-Json
        if ($j.chat_id -match '^[0-9-]+$') { $linked = $true }
    } catch { }
}
if ($linked) {
    Ok "Telegram already linked - nothing to do here"
} else {
    # ➤ A repair run must not make anyone re-type: a token saved by an earlier
    # ➤ attempt is revalidated with getMe and reused, fresh link code included.
    if (Test-Path $cfg) {
        try {
            $j2 = Get-Content $cfg -Raw | ConvertFrom-Json
            if ($j2.bot_token -match '^[0-9]{6,}:') {
                $me = Invoke-RestMethod "$tgApi/bot$($j2.bot_token)/getMe" -TimeoutSec 15
                if ($me.ok) {
                    $botUser = $me.result.username
                    $script:code = -join ((97..122) + (48..57) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
                    [System.IO.File]::WriteAllText($cfg, "{`"bot_token`": `"$($j2.bot_token)`", `"chat_id`": `"`", `"link_code`": `"$($script:code)`"}`n")
                    Ok "found the token from an earlier run - your bot is @$botUser"
                }
            }
        } catch { }
    }
    if (-not $botUser) {
    Say "Your Telegram bot"
    Write-Host "  1. In Telegram, open @BotFather and send it:  /newbot"
    Write-Host "  2. Give it any name, and a username ending in 'bot'."
    Write-Host "  3. Copy the token it answers with (123456789:AAHk8s...)."
    $attempt = 0
    while ($attempt -lt 5 -and -not $botUser) {
        $attempt += 1
        $token = Read-Host "  Paste the token here"
        if ($token -notmatch '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$') {
            Warn "That does not look like a token - copy the whole line @BotFather sent."
            continue
        }
        # ➤ getMe answers instantly whether the token is real, and gives the
        # ➤ bot's username for the one-tap link below. No waiting for messages.
        try {
            $me = Invoke-RestMethod "$tgApi/bot$token/getMe" -TimeoutSec 15
            if ($me.ok) { $botUser = $me.result.username }
        } catch {
            Warn "Telegram rejected that token - check it and paste it again."
            continue
        }
        # ➤ A random code rides the START link, and only the tap carrying it may
        # ➤ bind the chat - a stranger who finds the bot first cannot claim it.
        # ➤ (Start-token idea: Advanced Web Machinery, advancedweb.hu, "The
        # ➤ easiest way to set up a chat with your Telegram bot".)
        $script:code = -join ((97..122) + (48..57) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
        # ➤ Written without a BOM: Windows PowerShell's Out-File would prepend
        # ➤ one and Node's JSON.parse chokes on it.
        [System.IO.File]::WriteAllText($cfg, "{`"bot_token`": `"$token`", `"chat_id`": `"`", `"link_code`": `"$($script:code)`"}`n")
        Ok "token saved - your bot is @$botUser"
    }
    }
    if (-not $botUser) {
        Warn "No valid token. Run the installer again when you have it; everything else is ready."
        Read-Host "  Press Enter to close"
        exit 1
    }

    # -- 5. One tap links everything ------------------------------------------
    # ➤ The hidden listener is already polling. The user opens the link, taps
    # ➤ START, and that single tap links the chat AND begins the profile
    # ➤ questions. This console just watches telegram.json for the link.
    Say "Last step - one tap:"
    Write-Host ""
    # ➤ ${} braces are load-bearing (field test 2026-08-23): "?" is a LEGAL
    # ➤ character in PowerShell variable names, so "$botUser?start=" reads a
    # ➤ variable called botUser?start — empty — and printed t.me/=CODE, a link
    # ➤ with no bot in it. The bash twin survives because bash stops at "?".
    Write-Host "      https://t.me/${botUser}?start=$($script:code)"
    Write-Host ""
    Write-Host "  Open that link (phone or desktop) and press START."
    # ➤ The pasteable twin (field test 2026-08-23): with the bot's chat already
    # ➤ open, the natural move is to PASTE — and a t.me link pasted as a message
    # ➤ is just text the listener ignores. This line is what that tap sends.
    Write-Host "  Already in the bot's chat? Send it this message instead:  /start $($script:code)"
    Write-Host "  Waiting..."
    $deadline = (Get-Date).AddMinutes(3)
    while (-not $linked -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        try {
            $j = Get-Content $cfg -Raw | ConvertFrom-Json
            if ($j.chat_id -match '^[0-9-]+$') { $linked = $true }
        } catch { }
    }
    if ($linked) {
        Ok "linked. The bot is asking your first question in Telegram - answer it there."
    } else {
        Warn "No tap seen yet - no problem: the link completes the moment you press START."
        Warn "This window can be closed."
    }
}

# -- 6. Optional extras, only reported ----------------------------------------
Say "Optional extras (nothing breaks without them)"
if (Test-Path (Join-Path $root 'server-bot\adzuna-key.json')) { Ok "Adzuna key present" }
else { Write-Host "  - Adzuna key (free, https://developer.adzuna.com/) -> one more job board. Save it to server-bot\adzuna-key.json as {`"app_id`":`"...`",`"app_key`":`"...`"}" }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude CLI present" }
elseif (Get-Command codex -ErrorAction SilentlyContinue) { Ok "Codex CLI present" }
else { Write-Host "  - An AI CLI -> cover letters ('cover N') and the Council. Claude: npm i -g @anthropic-ai/claude-code, then: claude setup-token. Or Codex: npm i -g @openai/codex, then: codex login" }
Write-Host "  - Chromium (npx playwright install chromium) -> cover letters as PDF"

Say "Done. Everything else happens in Telegram ('help' lists the commands)."
Read-Host "  Press Enter to close"
