param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = Join-Path $workspace 'release'
$genericName = "Nyanya-Gateway-v$Version"
$className = "Nyanya-Gateway-Class-v$Version"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-ReleaseTarget([string]$Path, [string]$ExpectedLeaf) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $prefix = [System.IO.Path]::GetFullPath($releaseRoot) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing target outside release root: $full"
  }
  if ((Split-Path -Leaf $full) -ne $ExpectedLeaf) {
    throw "Refusing unexpected release target: $full"
  }
  return $full
}

function Reset-ReleaseDirectory([string]$Path, [string]$ExpectedLeaf) {
  $target = Assert-ReleaseTarget $Path $ExpectedLeaf
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Path $target | Out-Null
  return $target
}

function Copy-ProjectTree([string]$SourceRelative, [string]$DestinationRoot, [string[]]$ExcludedRelative) {
  $source = Join-Path $workspace $SourceRelative
  $destination = Join-Path $DestinationRoot $SourceRelative
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath $source -Recurse -Force -File | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart('\')
    $normalized = $relative.Replace('\', '/')
    $excluded = $false
    foreach ($rule in $ExcludedRelative) {
      if ($normalized -eq $rule -or $normalized.StartsWith($rule.TrimEnd('/') + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
        $excluded = $true
        break
      }
    }
    if (-not $excluded) {
      $target = Join-Path $destination $relative
      $parent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      Copy-Item -LiteralPath $_.FullName -Destination $target
    }
  }
}

function Copy-ReleaseAsset([string]$Asset, [string]$Destination, [string]$ReleaseVersion = '') {
  $source = Join-Path $PSScriptRoot "release-assets\$Asset"
  $text = [System.IO.File]::ReadAllText($source)
  if ($ReleaseVersion) {
    $text = $text.Replace('__VERSION__', $ReleaseVersion)
  }
  [System.IO.File]::WriteAllText($Destination, $text, $utf8NoBom)
}

function Get-LocalSecretCandidates {
  $values = New-Object System.Collections.Generic.List[string]
  @('gateway\config.json', 'nyanya-gateway-class\config.json') | ForEach-Object {
    $path = Join-Path $workspace $_
    if (Test-Path -LiteralPath $path) {
      $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      @('token', 'onebotToken', 'deviceToken', 'adminToken') | ForEach-Object {
        $property = $config.PSObject.Properties[$_]
        if ($null -ne $property -and $null -ne $property.Value) {
          $value = [string]$property.Value
          if ($value.Length -ge 6 -and $value -notin @('j2me-qq-dev-token', 'nyanya-dev-token')) {
            $values.Add($value)
          }
        }
      }
    }
  }
  return @($values | Select-Object -Unique)
}

function Assert-SafeRelease([string]$Root, [string[]]$Secrets) {
  $files = Get-ChildItem -LiteralPath $Root -Recurse -Force -File
  $forbidden = $files | Where-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
    $relative -match '(^|/)(config\.json|\.env|nyanya-data|data)(/|$)' -or
    $_.Name -match '\.(log|pid|db|sqlite|sqlite3|wal|shm|jar|class)$'
  }
  if ($forbidden) {
    $names = ($forbidden | ForEach-Object { $_.FullName.Substring($Root.Length + 1) }) -join ', '
    throw "Forbidden runtime or private files in release: $names"
  }
  foreach ($secret in $Secrets) {
    foreach ($file in $files) {
      $content = [System.IO.File]::ReadAllText($file.FullName)
      if ($content.Contains($secret)) {
        throw "A local secret was copied into release file: $($file.FullName.Substring($Root.Length + 1))"
      }
    }
  }
}

function Write-Checksums([string]$Root) {
  $manifest = Join-Path $Root 'SHA256SUMS.txt'
  $lines = Get-ChildItem -LiteralPath $Root -Recurse -File |
    Where-Object { $_.FullName -ne $manifest } |
    Sort-Object FullName |
    Get-FileHash -Algorithm SHA256 |
    ForEach-Object { "$($_.Hash)  $($_.Path.Substring($Root.Length + 1).Replace('\', '/'))" }
  [System.IO.File]::WriteAllLines($manifest, $lines, $utf8NoBom)
}

function Write-ReleaseZip([string]$Root, [string]$Name) {
  $zip = Assert-ReleaseTarget (Join-Path $releaseRoot "$Name.zip") "$Name.zip"
  if (Test-Path -LiteralPath $zip) {
    Remove-Item -LiteralPath $zip -Force
  }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $fileStream = [System.IO.File]::Create($zip)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive(
      $fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [System.DateTimeOffset]$_.LastWriteTime
        $inputStream = [System.IO.File]::OpenRead($_.FullName)
        try {
          $outputStream = $entry.Open()
          try {
            $inputStream.CopyTo($outputStream)
          } finally {
            $outputStream.Dispose()
          }
        } finally {
          $inputStream.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $fileStream.Dispose()
  }
  return $zip
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$genericRoot = Reset-ReleaseDirectory (Join-Path $releaseRoot $genericName) $genericName
$classRoot = Reset-ReleaseDirectory (Join-Path $releaseRoot $className) $className

Copy-ProjectTree 'gateway' $genericRoot @('config.json')
Copy-ProjectTree 'packages\gateway-core' $genericRoot @()
Copy-ProjectTree 'packages\onebot-adapter' $genericRoot @()
Copy-ProjectTree 'packages\nyanya-protocol' $genericRoot @()
New-Item -ItemType Directory -Path (Join-Path $genericRoot 'docs') | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'docs\PROTOCOL.md') -Destination (Join-Path $genericRoot 'docs\PROTOCOL.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\USAGE.md') -Destination (Join-Path $genericRoot 'docs\USAGE.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\BEGINNER-GUIDE.md') -Destination (Join-Path $genericRoot 'docs\BEGINNER-GUIDE.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\ATTRIBUTION.md') -Destination (Join-Path $genericRoot 'docs\ATTRIBUTION.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\VERSION-MATRIX.md') -Destination (Join-Path $genericRoot 'docs\VERSION-MATRIX.md')
Copy-Item -LiteralPath (Join-Path $workspace 'DESIGN.md') -Destination (Join-Path $genericRoot 'DESIGN.md')
Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination $genericRoot
Copy-Item -LiteralPath (Join-Path $workspace 'THIRD-PARTY-LICENSE.txt') -Destination $genericRoot
$rootLaunchers = @(Get-ChildItem -LiteralPath $workspace -File -Filter '*.bat')
if ($rootLaunchers.Count -ne 2) {
  throw "Expected exactly two root launchers, found $($rootLaunchers.Count)."
}
$rootLaunchers | Copy-Item -Destination $genericRoot
Copy-ReleaseAsset 'generic-package.json' (Join-Path $genericRoot 'package.json') $Version
Copy-ReleaseAsset 'GENERIC-README.md' (Join-Path $genericRoot 'README.md')

Copy-ProjectTree 'nyanya-gateway-class' $classRoot @(
  'config.json', '.gitignore', 'nyanya-data', 'legacy/data', 'build', 'dist', 'docs', 'DESIGN.md')
Copy-ProjectTree 'packages\gateway-core' $classRoot @()
Copy-ProjectTree 'packages\onebot-adapter' $classRoot @()
New-Item -ItemType Directory -Path (Join-Path $classRoot 'docs') | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'docs\USAGE.md') -Destination (Join-Path $classRoot 'docs\USAGE.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\BEGINNER-GUIDE.md') -Destination (Join-Path $classRoot 'docs\BEGINNER-GUIDE.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\ATTRIBUTION.md') -Destination (Join-Path $classRoot 'docs\ATTRIBUTION.md')
Copy-Item -LiteralPath (Join-Path $workspace 'docs\VERSION-MATRIX.md') -Destination (Join-Path $classRoot 'docs\VERSION-MATRIX.md')
Copy-Item -LiteralPath (Join-Path $workspace 'DESIGN.md') -Destination (Join-Path $classRoot 'DESIGN.md')
Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination $classRoot
Copy-Item -LiteralPath (Join-Path $workspace 'THIRD-PARTY-LICENSE.txt') -Destination $classRoot
Copy-ReleaseAsset 'class-package.json' (Join-Path $classRoot 'package.json') $Version
Copy-ReleaseAsset 'CLASS-README.md' (Join-Path $classRoot 'README.md')

$secrets = Get-LocalSecretCandidates
Assert-SafeRelease $genericRoot $secrets
Assert-SafeRelease $classRoot $secrets
Write-Checksums $genericRoot
Write-Checksums $classRoot
$genericZip = Write-ReleaseZip $genericRoot $genericName
$classZip = Write-ReleaseZip $classRoot $className

Write-Host "Created $genericRoot"
Write-Host "Created $genericZip"
Write-Host "Created $classRoot"
Write-Host "Created $classZip"
Write-Host "Local secrets checked: $($secrets.Count); none copied."
