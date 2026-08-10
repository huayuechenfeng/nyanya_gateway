@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 正在启用 Symbian QQ2013 旧节点路由（需要管理员权限）。
echo 脚本会自动检测本机局域网 IP，不限制手机 IP。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\enable-symbian-route.ps1"
pause
