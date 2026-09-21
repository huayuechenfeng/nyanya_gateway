[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ClientJar,
    [string]$ServerAddress = '127.0.0.1',
    [int]$Port = 14000,
    [int]$MobilePort = 13981,
    [string]$OutputName = 'patched-client.jar'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
$fullProjectRoot = [System.IO.Path]::GetFullPath($projectRoot) + [System.IO.Path]::DirectorySeparatorChar
$systemNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$node = if ($systemNode) { $systemNode.Source } else { $null }
if ([string]::IsNullOrEmpty($node)) {
    throw 'Node.js was not found. Install Node.js LTS (22.5 or newer) from https://nodejs.org/ and try again.'
}

function Invoke-NodeJsonTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Script,
        [string[]]$Arguments = @()
    )

    # Do not invoke Node with PowerShell's native-command pipeline here. On
    # some Windows PowerShell/code-page combinations, long UTF-8 JSON output
    # from a JAR containing legacy Chinese constants is converted into a
    # malformed string before ConvertFrom-Json sees it.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $argumentListProperty = $startInfo.PSObject.Properties['ArgumentList']
    if ($null -ne $argumentListProperty) {
        [void]$startInfo.ArgumentList.Add($Script)
        foreach ($argument in $Arguments) {
            [void]$startInfo.ArgumentList.Add([string]$argument)
        }
    }
    else {
        $allArguments = @($Script) + @($Arguments)
        $startInfo.Arguments = ($allArguments | ForEach-Object {
            '"' + ([string]$_).Replace('"', '\"') + '"'
        }) -join ' '
    }
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Unable to start Node.js tool: $Script" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            $detail = $stderr.Trim()
            if ([string]::IsNullOrEmpty($detail)) { $detail = "exit code $($process.ExitCode)" }
            throw "Node.js tool failed: $detail"
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            throw 'Node.js tool returned no JSON output.'
        }
        try {
            return ($stdout.Trim() | ConvertFrom-Json)
        }
        catch {
            throw "Node.js tool returned invalid JSON: $($_.Exception.Message)"
        }
    }
    finally {
        $process.Dispose()
    }
}

$toolDependencies = @(
    'client-jar-analyzer.js',
    'class-endpoint-patcher.js',
    'class-methodref-patcher.js',
    'class-direct-http-patcher.js',
    'class-group-web-patcher.js',
    'class-bubble-label-patcher.js',
    'local-network-guard.js'
) | ForEach-Object { Join-Path $PSScriptRoot $_ }
foreach ($required in @($ClientJar, $node) + $toolDependencies) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing patch dependency: $required" }
}
if ($ServerAddress -notmatch '^[A-Za-z0-9.-]+$') {
    throw 'ServerAddress must be an ASCII IPv4 address or hostname.'
}
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
if ($MobilePort -lt 1 -or $MobilePort -gt 65535) { throw 'MobilePort must be between 1 and 65535.' }
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or $OutputName -notmatch '\.jar$') {
    throw 'OutputName must be a plain .jar file name.'
}

$buildRoot = Join-Path $projectRoot 'build\client-patch'
$stagingRoot = Join-Path $buildRoot 'staging'
$distRoot = Join-Path $projectRoot 'dist'
$outputJar = Join-Path $distRoot $OutputName
$outputJad = [System.IO.Path]::ChangeExtension($outputJar, '.jad')
foreach ($path in @($buildRoot, $stagingRoot, $distRoot, $outputJar, $outputJad)) {
    $fullPath = [System.IO.Path]::GetFullPath($path)
    if (-not $fullPath.StartsWith($fullProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the project: $fullPath"
    }
}
if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
foreach ($output in @($outputJar, $outputJad)) {
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ClientJar).Path)
try {
    foreach ($entry in $archive.Entries) {
        if ([string]::IsNullOrEmpty($entry.Name)) { continue }
        $relative = $entry.FullName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $destination = [System.IO.Path]::GetFullPath((Join-Path $stagingRoot $relative))
        $stagingPrefix = [System.IO.Path]::GetFullPath($stagingRoot) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $destination.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe JAR entry: $($entry.FullName)"
        }
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $source = $entry.Open()
        try {
            $target = [System.IO.File]::Create($destination)
            try { $source.CopyTo($target) } finally { $target.Dispose() }
        } finally {
            $source.Dispose()
        }
    }
} finally {
    $archive.Dispose()
}

$replacementUri = "socket://${ServerAddress}:$Port"
$clientAnalysis = Invoke-NodeJsonTool `
    (Join-Path $PSScriptRoot 'client-jar-analyzer.js') @($stagingRoot, $ServerAddress)
if (@($clientAnalysis.signedEntries).Count -gt 0) {
    throw "Signed JAR files are not supported because modification invalidates the signature: $(@($clientAnalysis.signedEntries) -join ', ')"
}
if ([int]$clientAnalysis.socketEndpointCount -lt 1) {
    throw 'No replaceable socket://...:14000 endpoint was found in this JAR.'
}

$patchSummary = Invoke-NodeJsonTool `
    (Join-Path $PSScriptRoot 'class-endpoint-patcher.js') @($stagingRoot, $replacementUri)

$aoClass = Join-Path $stagingRoot 'ao.class'
$httpDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/HttpConnection;'
$httpClass = Join-Path $stagingRoot 'http.class'
$methodPatchSummary = $null
$directHttpSummary = $null
$methodReferenceDescription = 'Not required for this client profile'
$directHttpDescription = 'Not patched; public HTTP endpoints are disabled by the local-network guard'

switch ([string]$clientAnalysis.profile.profileId) {
    'mobileqq-12.0.16-http-helper' {
        if ([bool]$clientAnalysis.profile.patches.methodReference) {
            $methodPatchSummary = Invoke-NodeJsonTool `
                (Join-Path $PSScriptRoot 'class-methodref-patcher.js') `
                @($aoClass, 'http', 'jl', 'open', $httpDescriptor)
            $methodReferenceDescription = "$($methodPatchSummary.from) -> $($methodPatchSummary.to)"
        }
        else {
            $methodReferenceDescription = 'http.open(String) reference already present'
        }
        $directHttpSummary = Invoke-NodeJsonTool `
            (Join-Path $PSScriptRoot 'class-direct-http-patcher.js') `
            @($httpClass, $aoClass)
        $directHttpDescription = "http helper replaced with Connector.open(String); ao proxy flag forced off at bytecode $($directHttpSummary.proxyFlagOffset)"
    }
    'mobileqq-12.0.16-connector-direct' {
        $directHttpSummary = Invoke-NodeJsonTool `
            (Join-Path $PSScriptRoot 'class-direct-http-patcher.js') `
            @('--ao-only', $aoClass)
        $methodReferenceDescription = 'Connector.open(String) is already used directly'
        $directHttpDescription = "existing Connector.open(String); ao proxy flag forced off at bytecode $($directHttpSummary.proxyFlagOffset)"
    }
    default {
        $methodReferenceDescription = 'Skipped in experimental TCP core mode'
    }
}

$mobileBase = if ($MobilePort -eq 80) {
    "http://${ServerAddress}"
}
else {
    "http://${ServerAddress}:$MobilePort"
}
$groupWebSummary = $null
if ([bool]$clientAnalysis.profile.patches.groupWeb) {
    $groupWebSummary = Invoke-NodeJsonTool `
        (Join-Path $PSScriptRoot 'class-group-web-patcher.js') `
        @($stagingRoot, $mobileBase)
}

# The "[img]" caption on a group-image bubble is drawn by the client itself; the
# gateway only sends the binary image block and no text at all, so the only place
# to remove it is the client constant pool. Clients without that literal are
# skipped quietly (--allow-empty) and report replacements=0.
$bubbleLabelSummary = Invoke-NodeJsonTool `
    (Join-Path $PSScriptRoot 'class-bubble-label-patcher.js') `
    @('--allow-empty', $stagingRoot)

$guardSummary = Invoke-NodeJsonTool `
    (Join-Path $PSScriptRoot 'local-network-guard.js') `
    @('--allow-empty', $stagingRoot, $ServerAddress)

$postAnalysis = Invoke-NodeJsonTool `
    (Join-Path $PSScriptRoot 'client-jar-analyzer.js') @($stagingRoot, $ServerAddress)
if ([int]$postAnalysis.externalNetworkLiteralCount -ne 0) {
    throw "Patched client still contains $($postAnalysis.externalNetworkLiteralCount) external network literals."
}

$manifestPath = Join-Path $stagingRoot 'META-INF\MANIFEST.MF'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Patched staging tree has no manifest.' }
$outputStream = [System.IO.File]::Create($outputJar)
try {
    $outputArchive = New-Object System.IO.Compression.ZipArchive(
        $outputStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        $files = @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -File)
        $ordered = @($files | Where-Object { $_.FullName -eq $manifestPath }) +
            @($files | Where-Object { $_.FullName -ne $manifestPath } | Sort-Object FullName)
        foreach ($file in $ordered) {
            $relative = $file.FullName.Substring($stagingRoot.Length).TrimStart('\').Replace('\', '/')
            $entry = $outputArchive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [System.DateTimeOffset]$file.LastWriteTime
            $source = [System.IO.File]::OpenRead($file.FullName)
            try {
                $target = $entry.Open()
                try { $source.CopyTo($target) } finally { $target.Dispose() }
            } finally {
                $source.Dispose()
            }
        }
    } finally {
        $outputArchive.Dispose()
    }
} finally {
    $outputStream.Dispose()
}

$jarSize = (Get-Item -LiteralPath $outputJar).Length
$rawManifestLines = [System.IO.File]::ReadAllLines($manifestPath, [System.Text.Encoding]::UTF8)
$unfoldedManifestLines = New-Object 'System.Collections.Generic.List[string]'
foreach ($line in $rawManifestLines) {
    if ($line.StartsWith(' ') -and $unfoldedManifestLines.Count -gt 0) {
        $lastIndex = $unfoldedManifestLines.Count - 1
        $unfoldedManifestLines[$lastIndex] += $line.Substring(1)
    }
    else {
        $unfoldedManifestLines.Add($line)
    }
}
$manifestLines = $unfoldedManifestLines |
    Where-Object { $_ -and $_ -notmatch '^Manifest-Version:' -and
        $_ -notmatch '^MIDlet-Jar-URL:' -and $_ -notmatch '^MIDlet-Jar-Size:' -and
        $_ -notmatch '^[^:]+:\s*$' }
$jadLines = @($manifestLines) + @(
    "MIDlet-Jar-URL: $([System.IO.Path]::GetFileName($outputJar))",
    "MIDlet-Jar-Size: $jarSize"
)
[System.IO.File]::WriteAllLines($outputJad, $jadLines, (New-Object System.Text.UTF8Encoding($false)))

$sourceHash = (Get-FileHash -LiteralPath $ClientJar -Algorithm SHA256).Hash
$outputHash = (Get-FileHash -LiteralPath $outputJar -Algorithm SHA256).Hash
[PSCustomObject]@{
    SourceSHA256 = $sourceHash
    OutputSHA256 = $outputHash
    ClientName = [string]$clientAnalysis.manifest.'MIDlet-Name'
    ClientVersion = [string]$clientAnalysis.manifest.'MIDlet-Version'
    PatchProfile = [string]$clientAnalysis.profile.displayName
    SupportLevel = [string]$clientAnalysis.profile.supportLevel
    Warnings = if (@($clientAnalysis.profile.warnings).Count) {
        @($clientAnalysis.profile.warnings) -join ' '
    } else { 'None' }
    Replacement = $patchSummary.replacement
    Replacements = $patchSummary.replacements
    MethodReference = $methodReferenceDescription
    DirectHttp = $directHttpDescription
    MobileGroupPage = if ($null -ne $groupWebSummary) {
        $mobileBase + '/forward.jsp?bid=342'
    } else { 'Not patched for this client profile' }
    WapBidsRedirected = if ($null -ne $groupWebSummary) {
        @($groupWebSummary.bids) -join ','
    } else { 'None' }
    BubbleLabelCleared = if ([int]$bubbleLabelSummary.replacements -gt 0) {
        "group image bubble label cleared ($($bubbleLabelSummary.replacements) site(s))"
    } else { 'Not present in this client' }
    NetworkGuardReplacements = [int]$guardSummary.replacements
    ModifiedClasses = (@($patchSummary.modifiedFiles) +
        $(if ($null -ne $methodPatchSummary) { @($methodPatchSummary.file) }) +
        $(if ($null -ne $directHttpSummary) { @($directHttpSummary.file) + @($directHttpSummary.aoFile) }) +
        $(if ($null -ne $groupWebSummary) { @($groupWebSummary.modifiedFiles) }) +
        @($bubbleLabelSummary.modifiedFiles) +
        @($guardSummary.modifiedFiles) |
        Sort-Object -Unique) -join ', '
    Jar = $outputJar
    Jad = $outputJad
    JarSize = $jarSize
} | Format-List
