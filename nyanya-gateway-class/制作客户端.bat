@echo off
rem Keep this file in CRLF; cmd.exe can misparse UTF-8 batch files with LF-only endings.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\patch-jar-interactive.ps1"
