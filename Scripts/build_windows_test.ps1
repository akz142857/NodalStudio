#requires -Version 7.0
[CmdletBinding()]
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Build this package on Windows with the MSVC toolchain.' }
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    foreach ($tool in @('node', 'pnpm', 'cargo', 'rustup', 'git')) {
        Get-Command $tool -ErrorAction Stop | Out-Null
    }
    $config = Get-Content apps/desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
    $version = $config.version
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root "dist/releases/windows-$version-test" }
    $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    New-Item $OutputDirectory -ItemType Directory -Force | Out-Null
    $target = 'x86_64-pc-windows-msvc'
    & rustup target add $target
    if ($LASTEXITCODE -ne 0) { throw 'Unable to install the Windows x64 Rust target.' }
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & pnpm --filter '@nodalstudio/desktop' tauri build --config src-tauri/tauri.release.conf.json --target $target --bundles nsis -- --locked
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }

    $binary = Join-Path $root "target/$target/release/nodalstudio-desktop.exe"
    $source = Join-Path $root "target/$target/release/bundle/nsis/Nodal Studio_${version}_x64-setup.exe"
    foreach ($file in @($binary, $source)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing artifact: $file" }
        if ((Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'NotSigned') {
            throw "Expected an unsigned test artifact: $file"
        }
    }
    # Check the application PE header, not the NSIS bootstrapper (which may be x86).
    $bytes = [IO.File]::ReadAllBytes($binary)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550 -or
        [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) { throw 'Application is not a Windows x64 PE.' }
    if ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -ne 2) { throw 'Application must use the Windows GUI subsystem.' }
    $name = "Nodal-Studio_${version}_windows-x64-unsigned-setup.exe"
    $destination = Join-Path $OutputDirectory $name
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$destination.sha256", "$hash  $name`n", [Text.UTF8Encoding]::new($false))
    $commit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Unable to record source commit.' }
    $dirty = [bool](& git status --porcelain --untracked-files=normal)
    $manifest = [ordered]@{
        version = $version; target = $target; sourceCommit = $commit; sourceDirty = $dirty
        builtAt = [DateTime]::UtcNow.ToString('o'); installer = $name; sha256 = $hash
        applicationSha256 = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        signature = 'NotSigned'; distribution = 'test'; automaticUpdates = $false
        webview2 = 'Evergreen; installer downloads runtime if missing (network required)'
    }
    $manifest | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory manifest.json) -Encoding utf8
    Write-Host "Unsigned Windows x64 package: $destination"
} finally { Pop-Location }
