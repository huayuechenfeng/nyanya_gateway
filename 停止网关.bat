@echo off
chcp 65001 >nul
rem 注意：本文件必须用 CRLF(Windows) 行尾；cmd.exe 解析 UTF-8 批处理时 LF 行尾会出错。
rem ============================================================
rem  停止网关.bat ——【旧版 Nyanya Gateway（非 Class）】停止入口
rem
rem  作用：结束占用 14000 端口的网关进程
rem  用法：双击本文件
rem  注意：这是早期 v0.1.0 布局的脚本；Class 版请直接 Ctrl+C 或关窗口
rem ============================================================
setlocal

echo 正在查找占用 14000 端口的网关进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":14000 .*LISTENING"') do taskkill /F /PID %%a >nul 2>nul
echo 完成。
pause >nul
