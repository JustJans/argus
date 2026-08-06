# -----------------------------------------------------------------------------
# Argus - Windows uninstall. Double-click uninstall-windows.bat to run this.
# It removes the four scheduled tasks, which is everything Argus put OUTSIDE
# its own folder. The folder itself - code, your profile, your CV, your data -
# stays; delete it by hand if you want everything gone.
# -----------------------------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot
function Say($msg)  { Write-Host ""; Write-Host $msg }
function Ok($msg)   { Write-Host "  OK  $msg" }

Say "Argus uninstall - $root"
Write-Host "  This removes Argus's scheduled tasks (listener, scan, links, cleanup)."
Write-Host "  The folder and everything in it stay; delete the folder yourself after."
$ans = Read-Host "  Remove the scheduled tasks? (y/n)"
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

Say "Done. To finish, delete this folder: $root"
Write-Host "  (Your Telegram bot keeps existing; remove it with /deletebot at @BotFather.)"
Read-Host "  Press Enter to close"
