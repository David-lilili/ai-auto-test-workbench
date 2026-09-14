' Launches the workbench watchdog hidden at Windows login.
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""D:\PycharmProjects\ai-auto-test-workbench\scripts\workbench-watchdog.ps1""", 0, False
