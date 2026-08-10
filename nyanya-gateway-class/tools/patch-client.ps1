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
$toolDependencies = @(
    'class-endpoint-patcher.js',
    'class-methodref-patcher.js',
    'class-direct-http-patcher.js',
    'class-group-web-patcher.js',
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
$patchOutput = & $node (Join-Path $PSScriptRoot 'class-endpoint-patcher.js') $stagingRoot $replacementUri
if ($LASTEXITCODE -ne 0) { throw 'Class endpoint patching failed.' }
$patchSummary = $patchOutput | ConvertFrom-Json

$aoClass = Join-Path $stagingRoot 'ao.class'
$httpDescriptor = '(Ljava/lang/String;)Ljavax/microedition/io/HttpConnection;'
$methodPatchOutput = & $node (Join-Path $PSScriptRoot 'class-methodref-patcher.js') `
    $aoClass 'http' 'jl' 'open' $httpDescriptor
if ($LASTEXITCODE -ne 0) { throw 'Class method-reference patching failed.' }
$methodPatchSummary = $methodPatchOutput | ConvertFrom-Json

$httpClass = Join-Path $stagingRoot 'http.class'
$directHttpOutput = & $node (Join-Path $PSScriptRoot 'class-direct-http-patcher.js') $httpClass $aoClass
if ($LASTEXITCODE -ne 0) { throw 'Direct J2ME HTTP patching failed.' }
$directHttpSummary = $directHttpOutput | ConvertFrom-Json

$mobileBase = if ($MobilePort -eq 80) {
    "http://${ServerAddress}"
}
else {
    "http://${ServerAddress}:$MobilePort"
}
$groupWebOutput = & $node (Join-Path $PSScriptRoot 'class-group-web-patcher.js') `
    $stagingRoot $mobileBase
if ($LASTEXITCODE -ne 0) { throw 'J2ME group web-entry patching failed.' }
$groupWebSummary = $groupWebOutput | ConvertFrom-Json

$guardOutput = & $node (Join-Path $PSScriptRoot 'local-network-guard.js') $stagingRoot $ServerAddress
if ($LASTEXITCODE -ne 0) { throw 'Private-network guard patching failed.' }
$guardSummary = $guardOutput | ConvertFrom-Json

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
    Replacement = $patchSummary.replacement
    Replacements = $patchSummary.replacements
    MethodReference = "$($methodPatchSummary.from) -> $($methodPatchSummary.to)"
    DirectHttp = "Connector.open(String); ao proxy flag forced off at bytecode $($directHttpSummary.proxyFlagOffset), direct target $($directHttpSummary.directBlockOffset)"
    MobileGroupPage = $mobileBase + '/forward.jsp?bid=342'
    ModifiedClasses = (@($patchSummary.modifiedFiles) + @($methodPatchSummary.file) + @($directHttpSummary.file) +
        @($directHttpSummary.aoFile) +
        @($groupWebSummary.modifiedFiles) + @($guardSummary.modifiedFiles) |
        Sort-Object -Unique) -join ', '
    Jar = $outputJar
    Jad = $outputJad
    JarSize = $jarSize
} | Format-List
