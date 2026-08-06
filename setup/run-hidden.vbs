' Argus - hidden launcher. Task Scheduler pops a console window for every run
' of a console program, and the listener runs EVERY MINUTE: a window flashing
' at the user sixty times an hour. Running the command through WScript.Shell
' with window style 0 is the ancient, boring cure (a folk pattern older than
' any repo - no single author to credit). Arguments: the program, then its own.
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
sh.Run Trim(cmd), 0, False
