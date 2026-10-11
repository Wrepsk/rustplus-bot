@echo off
setlocal
if not exist "%~dp0app\node.exe" (
  echo Please extract ALL files from the ZIP first, then double-click this file again.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0app\pair.ps1"
if errorlevel 1 (
  echo The helper could not start. Extract the ZIP to a folder you can write to and try again.
  pause
)
