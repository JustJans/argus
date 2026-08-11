# -----------------------------------------------------------------------------
# Argus - Windows uninstall. Runs from the Uninstall button in Settings >
# Installed apps, or by double-clicking uninstall-windows.bat.
# It removes the four scheduled tasks and the Installed-apps entry - everything
# Argus put OUTSIDE its own folder. The folder itself - code, your profile,
# your CV, your applications history - stays; those are YOURS and the only
# copy, so deleting them is a decision this script refuses to make for you.
# -----------------------------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot
function Say($msg)  { Write-Host ""; Write-Host $msg }
function Ok($msg)   { Write-Host "  OK  $msg" }

Say "Argus uninstall - $root"
Write-Host "  This removes Argus's scheduled tasks (listener, scan, links, cleanup)"
Write-Host "  and its entry in Settings > Installed apps."
Write-Host "  The folder and everything in it stay; delete the folder yourself after."
$ans = Read-Host "  Uninstall Argus? (y/n)"
if ($ans -ne 'y') { Write-Host "  Nothing was touched."; Read-Host "  Press Enter to close"; exit 0 }

$removed = 0
foreach ($name in 'Argus listener', 'Argus scan', 'Argus links', 'Argus cleanup') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        try {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
            Ok "removed '$name'"
            $removed += 1
        } catch { Write-Host "  !   could not remove '$name': $($_.Exception.Message)" }
    }
}
if ($removed -eq 0) { Ok "no Argus tasks were scheduled - nothing to remove" }

# ➤ The Settings entry goes with the tasks; without it, an uninstalled Argus
# ➤ would keep offering an Uninstall button that has nothing left to do.
try {
    Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Argus' -Recurse -ErrorAction Stop
    Ok "removed the Installed-apps entry"
} catch { }

Say "Done. Argus will not run again. To finish, delete this folder: $root"
Write-Host "  (Your Telegram bot keeps existing; remove it with /deletebot at @BotFather.)"
Read-Host "  Press Enter to close"
