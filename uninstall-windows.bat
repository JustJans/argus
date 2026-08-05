@rem Argus uninstall for Windows. Double-click me: it removes the scheduled tasks
@rem (all Argus keeps outside this folder), then tells you what to delete by hand.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-bot\uninstall-windows.ps1"
