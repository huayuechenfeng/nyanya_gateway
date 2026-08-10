param(
    [string]$ComputerIp = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'network-address.ps1')

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    $quotedScript = '"' + $PSCommandPath + '"'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File $quotedScript"
    if (-not [string]::IsNullOrWhiteSpace($ComputerIp)) {
        $arguments += " -ComputerIp $ComputerIp"
    }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
    exit 0
}

$ComputerIp = Get-NyanyaLanIPv4 -PreferredAddress $ComputerIp
Write-Host ''
Write-Host '============================================================' -ForegroundColor Yellow
Write-Host "电脑局域网 IP：$ComputerIp" -ForegroundColor Green
Write-Host '请打开手机当前 Wi-Fi 的高级/IPv4 设置，并按顺序填写：' -ForegroundColor Yellow
Write-Host '  1. 手机 IP 改为手动，填写同网段且不冲突的固定 IP；' -ForegroundColor Yellow
Write-Host '  2. 子网掩码填写与电脑相同的值（可在电脑运行 ipconfig 查看）；' -ForegroundColor Yellow
Write-Host "  3. 把“网关”地址改为电脑 IP：$ComputerIp" -ForegroundColor Yellow
Write-Host '电脑端不要求输入或限制手机 IP，但手机端不能继续使用自动 IPv4。' -ForegroundColor Yellow
Write-Host '============================================================' -ForegroundColor Yellow
Write-Host ''
$null = Read-Host '确认手机固定 IP、子网掩码和网关均已保存后，按 Enter 继续'

# QQ2013 会在这些内置旧登录节点之间轮换（端口 8080/14000）。
# 手机把 Wi-Fi 网关指向本机后，旧节点数据包会先到达本机；这里再把
# 节点 IP 作为回环别名，并使用弱主机模式让连接落到本机 14000。
$targets = @(
    '120.196.210.13',
    '120.196.210.14',
    '112.90.140.201',
    '112.90.140.202',
    '58.60.10.62',
    '58.60.12.176'
)
$firewallName = 'nyanya Symbian route'

$listening = Get-NetTCPConnection -State Listen -LocalPort 14000 -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Host '警告: 本机 14000 没有监听，请先启动 nyanya 网关（启动网关.bat）。' -ForegroundColor Yellow
}

$computerAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ComputerIp -ErrorAction Stop |
    Where-Object { $_.AddressState -ne 'Duplicate' } | Select-Object -First 1
if (-not $computerAddress) { throw "电脑地址 $ComputerIp 不存在。" }
$physicalIndex = $computerAddress.InterfaceIndex
$loopbackAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress '127.0.0.1' -ErrorAction Stop |
    Select-Object -First 1
if (-not $loopbackAddress) { throw '找不到 IPv4 回环接口。' }
$loopbackIndex = $loopbackAddress.InterfaceIndex

# 恢复上次中断（直接关窗口）留下的临时配置；只处理回环接口上的别名。
$staleConfiguration = $false
foreach ($target in $targets) {
    $existingAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $target -ErrorAction SilentlyContinue)
    $foreignAddresses = @($existingAddresses | Where-Object { $_.InterfaceIndex -ne $loopbackIndex })
    if ($foreignAddresses.Count -gt 0) {
        throw "目标地址 $target 存在于非回环接口，拒绝修改。"
    }
    foreach ($existingAddress in $existingAddresses) {
        Remove-NetIPAddress -InterfaceIndex $loopbackIndex -IPAddress $target `
            -Confirm:$false -ErrorAction Stop
        $staleConfiguration = $true
    }
}
if ($staleConfiguration) {
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'nyanya Symbian route*' } |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $physicalIndex `
        -WeakHostReceive Disabled -WeakHostSend Disabled -PolicyStore ActiveStore -ErrorAction SilentlyContinue
    Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $loopbackIndex `
        -WeakHostReceive Disabled -WeakHostSend Disabled -PolicyStore ActiveStore -ErrorAction SilentlyContinue
    Write-Host '已恢复上次中断运行留下的临时网络设置。' -ForegroundColor Yellow
}

$physicalInterface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $physicalIndex
$loopbackInterface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $loopbackIndex
$physicalWeakReceive = [string]$physicalInterface.WeakHostReceive
$physicalWeakSend = [string]$physicalInterface.WeakHostSend
$loopbackWeakReceive = [string]$loopbackInterface.WeakHostReceive
$loopbackWeakSend = [string]$loopbackInterface.WeakHostSend

Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $physicalIndex `
    -WeakHostReceive Enabled -WeakHostSend Enabled -PolicyStore ActiveStore
Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $loopbackIndex `
    -WeakHostReceive Enabled -WeakHostSend Enabled -PolicyStore ActiveStore

foreach ($target in $targets) {
    $existing = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $target -ErrorAction SilentlyContinue
    if ($existing) { throw "目标地址 $target 已配置，拒绝重复接管。" }
    New-NetIPAddress -InterfaceIndex $loopbackIndex -IPAddress $target -PrefixLength 32 `
        -SkipAsSource $true -PolicyStore ActiveStore | Out-Null
}

Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 8080,14000 -RemoteAddress LocalSubnet -Profile Any | Out-Null

Write-Host ''
Write-Host 'Symbian 旧节点路由已接管，手机连接会落到本机 14000（nyanya 网关）。' -ForegroundColor Green
Write-Host "手机当前 Wi-Fi 的网关应为：$ComputerIp"
Write-Host '允许同一局域网内的手机连接，不绑定单一手机 IP。'
Write-Host '请保持 nyanya 网关运行，在手机 QQ2013 上登录。'
Write-Host '完成后回到本窗口按 Enter 恢复电脑设置，并把手机 IPv4 恢复原设置。'
Write-Host ''
$null = Read-Host '按 Enter 恢复并退出'

Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
foreach ($target in $targets) {
    Remove-NetIPAddress -InterfaceIndex $loopbackIndex -IPAddress $target `
        -Confirm:$false -ErrorAction SilentlyContinue
}
if ($physicalIndex -and $physicalWeakReceive -and $physicalWeakSend) {
    Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $physicalIndex `
        -WeakHostReceive $physicalWeakReceive -WeakHostSend $physicalWeakSend `
        -PolicyStore ActiveStore -ErrorAction SilentlyContinue
}
if ($loopbackIndex -and $loopbackWeakReceive -and $loopbackWeakSend) {
    Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $loopbackIndex `
        -WeakHostReceive $loopbackWeakReceive -WeakHostSend $loopbackWeakSend `
        -PolicyStore ActiveStore -ErrorAction SilentlyContinue
}
Write-Host '已恢复电脑网络设置，路由接管结束。请确认手机 IPv4、网关和 DNS 也已恢复。'
