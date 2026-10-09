Option Explicit

' WScript is a windowless host; propagate the runner exit code for Task Scheduler.
If WScript.Arguments.Count <> 1 Then WScript.Quit 2

Dim shell, runner, powershell, command, exitCode
Set shell = CreateObject("WScript.Shell")
runner = WScript.Arguments(0)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & runner & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
