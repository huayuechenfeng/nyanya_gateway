@echo off
chcp 65001 >nul
setlocal

echo 正在查找占用 14000 端口的网关进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":14000 .*LISTENING"') do taskkill /F /PID %%a >nul 2>nul
echo 完成。
pause >nul
