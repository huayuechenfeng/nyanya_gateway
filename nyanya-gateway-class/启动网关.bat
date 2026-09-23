@echo off
chcp 65001 >nul
rem 注意：本文件必须用 CRLF(Windows) 行尾；cmd.exe 解析 UTF-8 批处理时 LF 行尾会出错。
rem ============================================================
rem  启动网关.bat —— 启动 Nyanya 网关（Class 版）
rem
rem  作用：检查 Node.js → 释放被占用的 14000 端口 → 启动 server.js
rem  用法：双击本文件；窗口出现日志即已启动，按 Ctrl+C 可停止
rem  依赖：Node.js 22.5+ / 本目录 server.js / NapCat(OneBot) 127.0.0.1:3001
rem  相关：停止网关用 Ctrl+C；管理页见「打开管理页.bat」
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22.5 或更高版本。
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
  choice /C YN /M "是否结束该进程并重新启动网关"
  if errorlevel 2 (
    echo 已取消。请先手动停止旧网关，再重新运行本脚本。
    pause
    exit /b 1
  )
  taskkill /F /PID %PID% >nul 2>nul
  timeout /t 1 /nobreak >nul
)

title Nyanya Gateway Class
echo 正在启动 Nyanya 网关（Class 版）...
echo   老手机客户端端口: 14000（旧 QQ 协议）
echo   NapCat OneBot 端口: 127.0.0.1:3001
echo   管理页: http://127.0.0.1:13980/
echo 按 Ctrl+C 可停止。
node server.js
echo.
echo 网关已退出，按任意键关闭窗口。
pause >nul
