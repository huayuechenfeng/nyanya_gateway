@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22.5 or newer first.
  pause
  exit /b 1
)

set "PORT=14000"
set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":14000 .*LISTENING"') do set "PID=%%a"

if defined PID (
  echo Port %PORT% is already in use by:
  tasklist /FI "PID eq %PID%"
  echo.
  choice /C YN /M "Kill this process and restart the gateway?"
  if errorlevel 2 (
    echo Cancelled. Stop the old gateway first.
    pause
    exit /b 1
  )
  taskkill /F /PID %PID% >nul 2>nul
  timeout /t 1 /nobreak >nul
)

title nyanya-gateway-class
echo Starting nyanya-gateway-class ...
echo   Old phones connect to port 14000 (legacy QQ protocol)
echo   NapCat on port 3001 (OneBot v11)
echo   Admin page: http://127.0.0.1:13980/
echo Press Ctrl+C to stop.
node server.js
echo.
echo Gateway exited. Press any key to close.
pause >nul
