@echo off
chcp 65001 >nul
rem 注意：本文件必须用 CRLF(Windows) 行尾；cmd.exe 解析 UTF-8 批处理时 LF 行尾会出错。
rem ============================================================
rem  制作客户端.bat —— 生成已注入网关地址的 QQ2011 客户端 JAR
rem
rem  作用：调用 tools\patch-jar-interactive.ps1，交互式选择
rem        「1=局域网 / 2=公网」，改 class 常量池里的服务器地址后输出 JAR
rem  用法：双击本文件，按提示选择模式并输入地址
rem  依赖：PowerShell / tools\patch-jar-interactive.ps1 / 原始 QQ2011.jar
rem  注意：带签名的 JAR 无法注入；改了 IP 或端口需重新制作
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\patch-jar-interactive.ps1"
