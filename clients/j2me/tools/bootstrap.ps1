$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot '.tools'
$downloadRoot = Join-Path $toolRoot 'downloads'
$microemuRoot = Join-Path $toolRoot 'microemu'
$proguardVersion = '7.9.1'
$proguardRoot = Join-Path $toolRoot ("proguard-" + $proguardVersion)
$proguardZip = Join-Path $downloadRoot ("proguard-" + $proguardVersion + ".zip")

foreach ($directory in @($toolRoot, $downloadRoot, $microemuRoot)) {
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
}

function Get-Dependency([string]$Url, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { return }
    Write-Output ("Downloading " + [System.IO.Path]::GetFileName($Destination))
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'Java is required on PATH.' }
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { throw 'A JDK with javac is required on PATH.' }
if (-not (Get-Command jar -ErrorAction SilentlyContinue)) { throw 'A JDK with jar is required on PATH.' }

Get-Dependency 'https://repo.maven.apache.org/maven2/org/eclipse/jdt/core/compiler/ecj/4.6.1/ecj-4.6.1.jar' `
    (Join-Path $downloadRoot 'ecj-4.6.1.jar')
Get-Dependency 'https://repo.maven.apache.org/maven2/org/microemu/cldcapi11/2.0.4/cldcapi11-2.0.4.jar' `
    (Join-Path $downloadRoot 'cldcapi11-2.0.4.jar')
Get-Dependency 'https://repo.maven.apache.org/maven2/org/microemu/midpapi20/2.0.4/midpapi20-2.0.4.jar' `
    (Join-Path $downloadRoot 'midpapi20-2.0.4.jar')
Get-Dependency ("https://github.com/Guardsquare/proguard/releases/download/v" + $proguardVersion +
    "/proguard-" + $proguardVersion + ".zip") $proguardZip

if (-not (Test-Path -LiteralPath $proguardRoot)) {
    Expand-Archive -LiteralPath $proguardZip -DestinationPath $toolRoot
}

$required = @(
    (Join-Path $downloadRoot 'ecj-4.6.1.jar'),
    (Join-Path $downloadRoot 'cldcapi11-2.0.4.jar'),
    (Join-Path $downloadRoot 'midpapi20-2.0.4.jar'),
    (Join-Path $proguardRoot 'lib\proguard.jar'),
    (Join-Path $microemuRoot 'microemu-javase-swing-2.0.4.jar')
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file)) { throw ("Bootstrap output is missing: " + $file) }
}
Write-Output 'J2ME toolchain is ready.'
