@echo off
rem Keep this file in CRLF; cmd.exe can misparse UTF-8 batch files with LF-only endings.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 22.5 或更高版本。
  pause
  exit /b 1
)

set "PORT=14000"
set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":14000 .*LISTENING"') do set "PID=%%a"

if defined PID (
  echo 端口 %PORT% 已被下面的进程占用：
  tasklist /FI "PID eq %PID%"
  echo.
  choice /C YN /M "是否结束该进程并重新启动 Nyanya Gateway"
  if errorlevel 2 (
    echo 已取消。请先手动停止旧网关，再重新运行本脚本。
    pause
    exit /b 1
  )
  taskkill /F /PID %PID% >nul 2>nul
  timeout /t 1 /nobreak >nul
)

title Nyanya Gateway
echo 正在启动 Nyanya Gateway...
echo   NapCat OneBot: 127.0.0.1:3001
echo   Nyanya 客户端端口: 14000
node .\gateway\server.js
echo.
echo Nyanya Gateway 已退出，按任意键关闭窗口。
pause >nul
