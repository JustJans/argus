@rem Argus diagnosis for Windows. Double-click me when the bot does not answer;
@rem it prints which piece is broken and what to do. Details in server-bot\diagnose-windows.ps1.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-bot\diagnose-windows.ps1"
