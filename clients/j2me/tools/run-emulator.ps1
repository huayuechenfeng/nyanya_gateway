$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$runtimeJars = @(Get-ChildItem -Path (Join-Path $projectRoot '.tools\microemu\*.jar') | ForEach-Object { $_.FullName })
if ($runtimeJars.Count -eq 0) {
    throw 'MicroEmulator runtime is missing. Run tools\bootstrap.ps1 first.'
}
$classPath = $runtimeJars -join [System.IO.Path]::PathSeparator
$emulatorDrive = $null
foreach ($candidate in @('Q:', 'P:', 'O:', 'N:', 'M:')) {
    if (-not (Test-Path -LiteralPath ($candidate + '\'))) {
        $emulatorDrive = $candidate
        break
    }
}
if ($null -eq $emulatorDrive) {
    throw 'No free temporary drive letter is available for MicroEmulator.'
}
& subst $emulatorDrive $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Failed to create temporary emulator drive.' }
$jarUrl = 'file:///' + $emulatorDrive + '/dist/QQJ2ME.jar'

Push-Location $projectRoot
try {
    & java -cp $classPath org.microemu.app.Main $jarUrl
} finally {
    Pop-Location
    & subst $emulatorDrive /D
}
