param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $projectRoot)
$protocolVectors = Join-Path $workspaceRoot 'packages\nyanya-protocol\vectors\v1.tsv'
$toolRoot = Join-Path $projectRoot '.tools'
$downloadRoot = Join-Path $toolRoot 'downloads'
$ecj = Join-Path $downloadRoot 'ecj-4.6.1.jar'
$cldc = Join-Path $downloadRoot 'cldcapi11-2.0.4.jar'
$midp = Join-Path $downloadRoot 'midpapi20-2.0.4.jar'
$proguard = Join-Path $toolRoot 'proguard-7.9.1\lib\proguard.jar'
$buildRoot = Join-Path $projectRoot 'build'
$classRoot = Join-Path $buildRoot 'classes'
$testRoot = Join-Path $buildRoot 'tests'
$rawRoot = Join-Path $buildRoot 'raw'
$distRoot = Join-Path $projectRoot 'dist'
$rawJar = Join-Path $rawRoot 'QQJ2ME-raw.jar'
$finalJar = Join-Path $distRoot 'QQJ2ME.jar'
$finalJad = Join-Path $distRoot 'QQJ2ME.jad'
$manifest = Join-Path $projectRoot 'config\manifest.mf'

foreach ($required in @($ecj, $cldc, $midp, $proguard, $manifest)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing build dependency: $required`nRun tools\bootstrap.ps1 first."
    }
}
if (-not $SkipTests -and -not (Test-Path -LiteralPath $protocolVectors)) {
    throw "Missing shared protocol vectors: $protocolVectors"
}

foreach ($target in @($classRoot, $testRoot, $rawRoot)) {
    $fullTarget = [System.IO.Path]::GetFullPath($target)
    $fullRoot = [System.IO.Path]::GetFullPath($projectRoot) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullTarget.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the workspace: $fullTarget"
    }
    if (Test-Path -LiteralPath $fullTarget) { Remove-Item -LiteralPath $fullTarget -Recurse -Force }
    New-Item -ItemType Directory -Path $fullTarget | Out-Null
}
if (-not (Test-Path -LiteralPath $distRoot)) {
    New-Item -ItemType Directory -Path $distRoot | Out-Null
}
foreach ($output in @($finalJar, $finalJad)) {
    if (Test-Path -LiteralPath $output) {
        Remove-Item -LiteralPath $output -Force
    }
}

Push-Location $projectRoot
try {
    if (-not $SkipTests) {
        $testSources = @(
            'src\com\nyanya\qqj2me\util\Json.java',
            'src\com\nyanya\qqj2me\util\Utf8.java',
            'src\com\nyanya\qqj2me\util\JsonStreamWriter.java',
            'src\com\nyanya\qqj2me\net\FrameCodec.java'
        ) + @(Get-ChildItem -Path 'tests' -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
        & javac -encoding UTF-8 -d $testRoot @testSources
        if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
        $runtimeClassPath = $testRoot
        $testClasses = @(
            'com.nyanya.qqj2me.util.JsonSelfTest',
            'com.nyanya.qqj2me.util.Utf8SelfTest',
            'com.nyanya.qqj2me.net.FrameCodecSelfTest'
        )
        foreach ($testClass in $testClasses) {
            if ($testClass -eq 'com.nyanya.qqj2me.net.FrameCodecSelfTest') {
                & java -cp $runtimeClassPath $testClass $protocolVectors
            } else {
                & java -cp $runtimeClassPath $testClass
            }
            if ($LASTEXITCODE -ne 0) { throw "$testClass failed." }
        }
    }

    $sources = @(Get-ChildItem -Path 'src' -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
    & java -jar $ecj -encoding UTF-8 -source 1.3 -target 1.1 -bootclasspath $cldc `
        -classpath $midp -d $classRoot @sources
    if ($LASTEXITCODE -ne 0) { throw 'MIDP source compilation failed.' }

    & jar cfm $rawJar $manifest -C $classRoot .
    if ($LASTEXITCODE -ne 0) { throw 'Raw JAR packaging failed.' }

    $proguardArguments = @(
        '-jar', $proguard,
        '-injars', $rawJar,
        '-outjars', $finalJar,
        '-libraryjars', $cldc,
        '-libraryjars', $midp,
        '-target', '1.1',
        '-microedition',
        '-dontshrink',
        '-dontoptimize',
        '-dontobfuscate',
        '-dontnote',
        '-dontwarn',
        '-keepattributes', 'Exceptions,InnerClasses',
        '-keep', 'public class com.nyanya.qqj2me.QqMidlet extends javax.microedition.midlet.MIDlet { public protected *; }'
    )
    & java @proguardArguments
    if ($LASTEXITCODE -ne 0) { throw 'Java ME preverification failed.' }

    $jarSize = (Get-Item -LiteralPath $finalJar).Length
    $jadLines = @(
        'MIDlet-Name: J2ME QQ',
        'MIDlet-Version: 0.1.0',
        'MIDlet-Vendor: Nyanya Gateway',
        'MIDlet-1: J2ME QQ,,com.nyanya.qqj2me.QqMidlet',
        'Nokia-MIDlet-On-Screen-Keypad: no',
        'MicroEdition-Configuration: CLDC-1.1',
        'MicroEdition-Profile: MIDP-2.0',
        'MIDlet-Permissions: javax.microedition.io.Connector.socket, javax.microedition.io.Connector.http',
        'MIDlet-Permissions-Opt: javax.microedition.io.Connector.https',
        'MIDlet-Jar-URL: QQJ2ME.jar',
        "MIDlet-Jar-Size: $jarSize"
    )
    [System.IO.File]::WriteAllLines($finalJad, $jadLines, (New-Object System.Text.UTF8Encoding($false)))

    $entries = & jar tf $finalJar
    if ($LASTEXITCODE -ne 0 -or -not ($entries -contains 'com/nyanya/qqj2me/QqMidlet.class')) {
        throw 'The final JAR is missing the MIDlet main class.'
    }
    Write-Output "Build complete: $finalJar ($jarSize bytes)"
    Write-Output "Descriptor: $finalJad"
} finally {
    Pop-Location
}
