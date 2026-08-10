[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'network-address.ps1')

Write-Host ''
Write-Host '============================================'
Write-Host '  制作你自己的客户端（JAR 注入器）'
Write-Host '============================================'
Write-Host ''
Write-Host '本工具只处理你自己合法持有的 JAR 文件。'
Write-Host '它会把旧网络地址改成你的电脑网关，并生成：'
Write-Host '  dist\patched-client.jar'
Write-Host '  dist\patched-client.jad'
Write-Host ''

$jar = Read-Host '请粘贴你合法持有的 MobileQQ JAR 完整路径（也可以把文件拖入窗口）'
$jar = $jar.Trim().Trim('"')
if ([string]::IsNullOrWhiteSpace($jar)) {
    Write-Host ''
    Write-Host '没有输入路径，程序退出。'
    Read-Host '按回车键关闭'
    exit 1
}
if (-not (Test-Path -LiteralPath $jar)) {
    Write-Host ''
    Write-Host "找不到这个文件：$jar"
    Write-Host '请确认路径输入正确，再重新双击 patch-jar.bat。'
    Read-Host '按回车键关闭'
    exit 1
}

$ip = $null
try {
    $ip = Get-NyanyaLanIPv4
}
catch {
    Write-Host ''
    Write-Host "无法自动检测电脑局域网地址：$($_.Exception.Message)"
    Read-Host '按回车键关闭'
    exit 1
}
Write-Host "客户端将连接到本机局域网地址：$ip" -ForegroundColor Green

Write-Host ''
try {
    & (Join-Path $PSScriptRoot 'patch-client.ps1') -ClientJar $jar -ServerAddress $ip -Port 14000 -MobilePort 13981
    Write-Host ''
    Write-Host '制作完成。请把 dist\patched-client.jar 和 dist\patched-client.jad'
    Write-Host '两个文件一起传到手机，并在手机上安装 JAR 文件。'
}
catch {
    Write-Host ''
    Write-Host "制作失败：$($_.Exception.Message)"
    Write-Host '请查看上方的错误信息，或阅读 README 的常见问题部分。'
}
Read-Host '按回车键关闭'
