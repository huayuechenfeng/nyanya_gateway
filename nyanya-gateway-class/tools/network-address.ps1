function Test-NyanyaPrivateIPv4([string]$Address) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    $bytes = $parsed.GetAddressBytes()
    if ($bytes.Length -ne 4) { return $false }
    return $bytes[0] -eq 10 -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
        ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)
}

function Get-NyanyaLanIPv4 {
    [CmdletBinding()]
    param([string]$PreferredAddress = '')

    if (-not [string]::IsNullOrWhiteSpace($PreferredAddress)) {
        $preferred = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $PreferredAddress `
            -ErrorAction SilentlyContinue | Where-Object {
                $_.AddressState -ne 'Duplicate' -and $_.IPAddress -notlike '127.*' -and
                $_.IPAddress -notlike '169.254.*'
            })
        if ($preferred.Count -eq 0) {
            throw "指定的电脑地址 $PreferredAddress 不存在于活动 IPv4 接口。"
        }
        return $PreferredAddress
    }

    $physicalAdapters = @{}
    Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Up' } |
        ForEach-Object { $physicalAdapters[[int]$_.InterfaceIndex] = $true }

    $candidates = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' `
        -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' })
    foreach ($route in $routes) {
        $index = [int]$route.InterfaceIndex
        if (-not $physicalAdapters.ContainsKey($index)) { continue }
        $ipInterface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $index `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        $interfaceMetric = if ($ipInterface) { [int]$ipInterface.InterfaceMetric } else { 0 }
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $index `
            -ErrorAction SilentlyContinue | Where-Object {
                $_.AddressState -ne 'Duplicate' -and -not $_.SkipAsSource -and
                $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
            })
        foreach ($address in $addresses) {
            if ($seen.ContainsKey($address.IPAddress)) { continue }
            $seen[$address.IPAddress] = $true
            $privateBonus = if (Test-NyanyaPrivateIPv4 $address.IPAddress) { -10000 } else { 0 }
            $candidates.Add([PSCustomObject]@{
                Address = $address.IPAddress
                InterfaceIndex = $index
                InterfaceAlias = $address.InterfaceAlias
                Score = $privateBonus + [int]$route.RouteMetric + $interfaceMetric
            })
        }
    }

    if ($candidates.Count -eq 0) {
        foreach ($index in $physicalAdapters.Keys) {
            Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $index -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.AddressState -ne 'Duplicate' -and -not $_.SkipAsSource -and
                    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
                } | ForEach-Object {
                    $privateBonus = if (Test-NyanyaPrivateIPv4 $_.IPAddress) { -10000 } else { 0 }
                    $candidates.Add([PSCustomObject]@{
                        Address = $_.IPAddress
                        InterfaceIndex = [int]$_.InterfaceIndex
                        InterfaceAlias = $_.InterfaceAlias
                        Score = $privateBonus + 50000
                    })
                }
        }
    }

    # 非管理员或受限 PowerShell 可能看不到 NetAdapter/NetRoute。UDP Connect
    # 不发送业务数据，只让 Windows 选择默认 IPv4 路由对应的本机地址。
    if ($candidates.Count -eq 0) {
        $socket = $null
        try {
            $socket = New-Object System.Net.Sockets.Socket(
                [System.Net.Sockets.AddressFamily]::InterNetwork,
                [System.Net.Sockets.SocketType]::Dgram,
                [System.Net.Sockets.ProtocolType]::Udp)
            $socket.Connect('8.8.8.8', 53)
            $routeAddress = $socket.LocalEndPoint.Address.IPAddressToString
            if ($routeAddress -and $routeAddress -notlike '127.*' -and
                $routeAddress -notlike '169.254.*') {
                $candidates.Add([PSCustomObject]@{
                    Address = $routeAddress
                    InterfaceIndex = [int]::MaxValue
                    InterfaceAlias = '默认 IPv4 路由'
                    Score = -20000
                })
            }
        }
        catch {
            # 继续使用不需要路由访问的主机地址回退。
        }
        finally {
            if ($socket) { $socket.Dispose() }
        }
    }

    if ($candidates.Count -eq 0) {
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object {
                $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                $_.IPAddressToString -notlike '127.*' -and
                $_.IPAddressToString -notlike '169.254.*'
            } | ForEach-Object {
                $address = $_.IPAddressToString
                $score = if ($address -like '192.168.*') { 100 } `
                    elseif ($address -like '10.*') { 200 } `
                    elseif (Test-NyanyaPrivateIPv4 $address) { 300 } else { 1000 }
                $candidates.Add([PSCustomObject]@{
                    Address = $address
                    InterfaceIndex = [int]::MaxValue
                    InterfaceAlias = '主机 IPv4'
                    Score = $score
                })
            }
    }

    $selected = $candidates | Sort-Object Score, InterfaceIndex | Select-Object -First 1
    if (-not $selected) {
        throw '无法自动检测电脑的活动局域网 IPv4。请确认 Wi-Fi 或以太网已连接。'
    }
    Write-Host "自动选择网卡: $($selected.InterfaceAlias) ($($selected.Address))" -ForegroundColor Cyan
    return [string]$selected.Address
}
