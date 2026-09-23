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
Write-Host '它会把旧网络地址改成你指定的服务器地址，并在 dist 目录下生成新客户端（jar + jad）。'
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
    Write-Host '请确认路径输入正确，再重新双击 制作客户端.bat。'
    Read-Host '按回车键关闭'
    exit 1
}

Write-Host ''
Write-Host '请选择客户端要连接的服务器地址模式：'
Write-Host '  [1] 局域网模式 —— 自动探测本机 IP（手机/模拟器与电脑同一局域网时用）'
Write-Host '  [2] 公网模式   —— 手动输入服务器 IP 或域名（网关已上云时用）'
$mode = Read-Host '请输入 1 或 2（默认 1）'
$mode = $mode.Trim()
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = '1' }

$targetAddress = $null
if ($mode -eq '2') {
    Write-Host ''
    $addr = Read-Host '请输入服务器公网 IP 或域名（例如 ServerAddress 或 gateway.example.com）'
    $addr = $addr.Trim()
    if ($addr -notmatch '^[A-Za-z0-9.-]+$') {
        Write-Host ''
        Write-Host "地址格式无效：$addr（只允许字母、数字、点和连字符）"
        Read-Host '按回车键关闭'
        exit 1
    }
    $targetAddress = $addr
    Write-Host "客户端将连接到公网服务器：$targetAddress" -ForegroundColor Green
}
else {
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
    $targetAddress = $ip
    Write-Host "客户端将连接到本机局域网地址：$targetAddress" -ForegroundColor Green
}

Write-Host ''
$defaultName = if ($mode -eq '2') { 'QQ2011.jar' } else { 'patched-client.jar' }
$outputName = Read-Host "请输入输出文件名（默认 $defaultName）"
$outputName = $outputName.Trim()
if ([string]::IsNullOrWhiteSpace($outputName)) { $outputName = $defaultName }
if ($outputName -notmatch '\.jar$') { $outputName = $outputName + '.jar' }
$outputJad = [System.IO.Path]::ChangeExtension($outputName, '.jad')

Write-Host ''
try {
    & (Join-Path $PSScriptRoot 'patch-client.ps1') -ClientJar $jar -ServerAddress $targetAddress -Port 14000 -MobilePort 13981 -OutputName $outputName
    Write-Host ''
    Write-Host "制作完成。请把 dist\$outputName 和 dist\$outputJad"
    Write-Host '两个文件一起传到手机，并在手机上安装 JAR 文件。'
}
catch {
    Write-Host ''
    Write-Host "制作失败：$($_.Exception.Message)"
    Write-Host '请查看上方的错误信息，或阅读 README 的常见问题部分。'
}
Read-Host '按回车键关闭'
