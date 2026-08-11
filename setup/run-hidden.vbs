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
' WAIT for node (True), do not fire-and-forget (audit 2026-08-08). With False,
' wscript exited in milliseconds while node ran on detached - so the task's
' -MultipleInstances IgnoreNew had no running instance to ignore and listener
' runs could overlap, answering the same message twice (the duplicate-reply
' bug Linux solves with flock). Waiting makes wscript live exactly as long as
' node: IgnoreNew becomes a real per-task lock, still with no window, and the
' task's LastTaskResult now carries node's real exit code instead of always 0.
rc = sh.Run(Trim(cmd), 0, True)
WScript.Quit rc
