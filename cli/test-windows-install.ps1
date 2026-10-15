# Runs only on Windows because the installer persists the per-user PATH.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this installer regression test on Windows.'
}

$installer = Join-Path $PSScriptRoot '..\control-plane\installer\cli.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('driftverk-install-test-' + [Guid]::NewGuid())
$names = @('DRIFTVERK_CONTROL_PLANE_URL', 'DRIFTVERK_BIN_DIR', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'LOCALAPPDATA', 'Path')
$savedEnvironment = @{}
foreach ($name in $names) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$savedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$savedSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
$downloadMode = 'valid'
$checksumAsBytes = $false
$requests = [Collections.Generic.List[string]]::new()

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

# Shadows network access in the installer with deterministic local fixtures.
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    $requests.Add($Uri)
    if (($downloadMode -eq 'missing-binary' -and $OutFile) -or
        ($downloadMode -eq 'missing-checksum' -and -not $OutFile)) {
        throw 'Mock HTTP 404'
    }
    if ($OutFile) {
        Copy-Item -LiteralPath $fixture -Destination $OutFile
        return
    }
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash
    if ($downloadMode -eq 'mismatch') { $digest = '0' * 64 }
    if ($downloadMode -eq 'malformed') { $digest = 'not-a-checksum' }
    $content = "$digest  fixture.exe`n"
    if ($checksumAsBytes) { $content = [Text.Encoding]::UTF8.GetBytes($content) }
    return [pscustomobject]@{ Content = $content }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $fixture = Join-Path $testRoot 'fixture.exe'
    [IO.File]::WriteAllText($fixture, 'first-native-binary')
    $env:DRIFTVERK_CONTROL_PLANE_URL = 'https://installer.invalid/'
    $env:LOCALAPPDATA = Join-Path $testRoot 'local app data'
    $env:DRIFTVERK_BIN_DIR = $null
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $baselineUserPath = Join-Path $testRoot 'existing-user-bin'
    [Environment]::SetEnvironmentVariable('Path', $baselineUserPath, 'User')
    $baselineProcessPath = $env:Path
    $expectedDir = Join-Path $env:LOCALAPPDATA 'Driftverk\bin'
    $installed = Join-Path $expectedDir 'driftverk.exe'

    & $installer
    Assert-True ([IO.File]::ReadAllText($installed) -eq 'first-native-binary') 'successful default per-user installation'
    Assert-True ($requests[0] -eq 'https://installer.invalid/install/bin/driftverk-windows-amd64.exe') 'AMD64 download URL and trailing origin slash'
    Assert-True ($requests[1] -eq 'https://installer.invalid/install/bin/driftverk-windows-amd64.exe.sha256') 'matching checksum URL'
    Assert-True ($env:Path -eq "$baselineProcessPath;$expectedDir") 'current PATH preserves its original entries'
    Assert-True ([Environment]::GetEnvironmentVariable('Path', 'User') -eq "$baselineUserPath;$expectedDir") 'user PATH preserves its original entries'

    # Reinstallation replaces the binary without duplicating either PATH entry.
    [IO.File]::WriteAllText($fixture, 'updated-native-binary')
    $checksumAsBytes = $true
    & $installer
    Assert-True ([IO.File]::ReadAllText($installed) -eq 'updated-native-binary') 'verified update'
    Assert-True (@($env:Path -split ';' | Where-Object { $_ -eq $expectedDir }).Count -eq 1) 'current PATH is idempotent'
    Assert-True (@([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -eq $expectedDir }).Count -eq 1) 'user PATH is idempotent'

    foreach ($mode in @('mismatch', 'malformed', 'missing-binary', 'missing-checksum')) {
        $downloadMode = $mode
        $beforeUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $beforeProcessPath = $env:Path
        $failed = $false
        try { & $installer } catch { $failed = $true }
        Assert-True $failed "$mode must fail"
        Assert-True ([IO.File]::ReadAllText($installed) -eq 'updated-native-binary') "$mode preserves existing binary"
        Assert-True ($env:Path -eq $beforeProcessPath) "$mode preserves current PATH"
        Assert-True ([Environment]::GetEnvironmentVariable('Path', 'User') -eq $beforeUserPath) "$mode preserves user PATH"
    }

    $downloadMode = 'valid'
    $env:DRIFTVERK_BIN_DIR = Join-Path $testRoot 'custom bin'
    foreach ($case in @(
        @{ Process = 'ARM64'; Native = $null; Expected = 'arm64' },
        @{ Process = 'x86'; Native = 'AMD64'; Expected = 'amd64' },
        @{ Process = 'AMD64'; Native = 'ARM64'; Expected = 'arm64' }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $case.Process
        $env:PROCESSOR_ARCHITEW6432 = $case.Native
        $requests.Clear()
        & $installer
        Assert-True ($requests[0] -eq "https://installer.invalid/install/bin/driftverk-windows-$($case.Expected).exe") 'native architecture selection'
        Assert-True (Test-Path -LiteralPath (Join-Path $env:DRIFTVERK_BIN_DIR 'driftverk.exe')) 'custom install directory'
    }
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $requests.Clear()
    $failed = $false
    try { & $installer } catch { $failed = $true }
    Assert-True $failed 'unsupported architecture must fail'
    Assert-True ($requests.Count -eq 0) 'unsupported architecture never downloads'
    Write-Host 'Windows installer regression checks passed.'
} finally {
    [Environment]::SetEnvironmentVariable('Path', $savedUserPath, 'User')
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    [Net.ServicePointManager]::SecurityProtocol = $savedSecurityProtocol
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
