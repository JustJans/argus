@rem Argus uninstall for Windows. Double-click me: it removes the scheduled tasks
@rem (all Argus keeps outside its folder), then tells you what to delete by hand.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1"
