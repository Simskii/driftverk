$ErrorActionPreference = 'Stop'
$controlPlane = if ($env:DRIFTVERK_CONTROL_PLANE_URL) { $env:DRIFTVERK_CONTROL_PLANE_URL.TrimEnd('/') } else { 'https://app.driftverk.com' }
$installDir = if ($env:DRIFTVERK_BIN_DIR) { $env:DRIFTVERK_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Driftverk\bin' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($architecture) {
    'AMD64' { 'amd64' }
    'ARM64' { 'arm64' }
    default { throw 'Supported Windows architectures: Intel/AMD 64-bit and ARM64.' }
}
$filename = "driftverk-windows-$arch.exe"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $download = Join-Path $tempDir $filename
    Invoke-WebRequest -UseBasicParsing -Uri "$controlPlane/install/bin/$filename" -OutFile $download
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri "$controlPlane/install/bin/$filename.sha256").Content
    if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
    $expected = ($checksum.Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid CLI checksum.' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $expected) {
        throw 'CLI checksum mismatch. Existing installation was not changed.'
    }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Copy-Item -LiteralPath $download -Destination (Join-Path $installDir 'driftverk.exe') -Force
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($installDir -notin ($userPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $installDir).TrimStart(';')), 'User')
    }
    if ($installDir -notin ($env:Path -split ';')) { $env:Path += ";$installDir" }
    Write-Host 'Installed Driftverk CLI'
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
