# -----------------------------------------------------------------------------
# Argus - one-line installer for Windows. From PowerShell:
#   irm https://raw.githubusercontent.com/JustJans/argus/master/install.ps1 | iex
# Downloads the latest code into ~\argus and hands over to the guided setup.
# Re-running it UPDATES the code and never touches your profile, CV or data.
# (Why this shape: a ZIP dragged through the browser arrives with the internet
# mark and a warning on every double-click; files written here do not. And the
# install folder stays fixed, so the scheduled tasks never point at a dead copy.)
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$dest = if ($env:ARGUS_DEST) { $env:ARGUS_DEST } else { Join-Path $HOME 'argus' }
Write-Host ""
Write-Host "Installing Argus into $dest"
$ProgressPreference = 'SilentlyContinue'
$tmp = Join-Path $env:TEMP ('argus-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'argus.zip'
    Invoke-WebRequest 'https://github.com/JustJans/argus/archive/refs/heads/master.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp
    $src = Join-Path $tmp 'argus-master'
    # ➤ An UPDATE must never clobber what the user built: the profile, the CV
    # ➤ and the letter example are theirs once they exist (telegram.json and
    # ➤ data/ are not in the download at all, so they survive on their own).
    # ➤ countries.yml and portals.yml joined the list 2026-08-08: both are
    # ➤ documented as hand-editable — the country toggles and any boards the
    # ➤ user added — and the update was silently reverting those edits while
    # ➤ the README promised it touched nothing of theirs.
    foreach ($rel in 'config\profile.yml', 'cv.md', 'config\cover-example.md', 'server-bot\countries.yml', 'portals.yml') {
        if ((Test-Path (Join-Path $dest $rel)) -and (Test-Path (Join-Path $src $rel))) {
            Remove-Item (Join-Path $src $rel)
        }
    }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
    Write-Host "  OK  latest code in place (your profile, CV and data untouched)"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if ($env:ARGUS_NO_SETUP) {
    Write-Host "ARGUS_NO_SETUP is set - skipping the setup."
} else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'setup\setup-windows.ps1')
}
