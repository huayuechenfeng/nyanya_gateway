@echo off
chcp 65001 >nul
rem 注意：本文件必须用 CRLF(Windows) 行尾；cmd.exe 解析 UTF-8 批处理时 LF 行尾会出错。
rem ============================================================
rem  启用塞班路由.bat —— 为塞班(Symbian)手机 QQ2013 配置旧节点路由
rem
rem  作用：调用 tools\enable-symbian-route.ps1，自动检测本机局域网 IP，
rem        把手机流量劫持到本机网关（需要管理员权限，会弹 UAC）
rem  用法：双击本文件，并在 UAC 弹窗点「是」
rem  依赖：PowerShell / tools\enable-symbian-route.ps1 / 管理员权限
rem  注意：仅塞班手机路线需要；J2ME 用户不用运行
rem ============================================================
setlocal
cd /d "%~dp0"
echo 正在启用塞班(Symbian) QQ2013 旧节点路由（需要管理员权限）。
echo 脚本会自动检测本机局域网 IP，不限制手机 IP。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\enable-symbian-route.ps1"
pause
