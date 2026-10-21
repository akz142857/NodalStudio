#requires -Version 7.0
[CmdletBinding()]
param([string]$PackageDirectory = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This acceptance check requires Windows.' }
# This test installs, creates a disposable profile and uninstalls. Use a fresh CI runner.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run this destructive lifecycle test only on a fresh GitHub Actions runner.' }
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content "$root/apps/desktop/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version
if (-not $PackageDirectory) { $PackageDirectory = Join-Path $root "dist/releases/windows-$version-test" }
$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory)
$manifest = Get-Content (Join-Path $PackageDirectory manifest.json) -Raw | ConvertFrom-Json
$installer = Join-Path $PackageDirectory $manifest.installer
if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Installer hash mismatch.' }
$dataDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.claycosmos.nodalstudio'
$localDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.claycosmos.nodalstudio'
foreach ($directory in @($dataDirectory, $localDirectory)) {
    if (Test-Path -LiteralPath $directory) { throw "Refusing to touch existing app data: $directory" }
}
$installDirectory = Join-Path $env:LOCALAPPDATA "Nodal Studio 测试 $([guid]::NewGuid().ToString('N'))"
$evidence = Join-Path $PackageDirectory evidence
New-Item $evidence -ItemType Directory -Force | Out-Null
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousUserData = $env:WEBVIEW2_USER_DATA_FOLDER
$application = $null
try {
    $installed = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDirectory" -PassThru -Wait
    if ($installed.ExitCode -ne 0) { throw "Installer failed: $($installed.ExitCode)" }
    $binary = Join-Path $installDirectory 'nodalstudio-desktop.exe'
    if (-not (Test-Path $binary)) { throw 'Installed application not found.' }
    if ((Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.applicationSha256) { throw 'Installed binary differs from build.' }
    if ((Get-AuthenticodeSignature $binary).Status -ne 'NotSigned') { throw 'Unexpected signature status.' }
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $installDirectory 'smoke-webview-data'
    foreach ($phase in @('seed', 'verify')) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = $listener.LocalEndpoint.Port
        $listener.Stop()
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
        $application = Start-Process -FilePath $binary -PassThru
        & node "$PSScriptRoot/windows_webview_smoke.mjs" $port $phase $evidence
        if ($LASTEXITCODE -ne 0) { throw "Installed application acceptance failed: $phase" }
        if ($application.HasExited) { throw 'Application exited unexpectedly.' }
        if (-not $application.CloseMainWindow()) { throw 'Unable to close the application window.' }
        if (-not $application.WaitForExit(15000)) { throw 'Application did not exit after closing its window.' }
        $application = $null
    }
    $uninstaller = Join-Path $installDirectory 'uninstall.exe'
    if (-not (Test-Path $uninstaller)) { throw 'Uninstaller not found.' }
    $uninstalled = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($uninstalled.ExitCode -ne 0) { throw 'Uninstaller failed.' }
    for ($attempt = 0; $attempt -lt 30 -and (Test-Path $binary); $attempt++) { Start-Sleep -Seconds 1 }
    if (Test-Path $binary) { throw 'Application executable remains after uninstall.' }
    [ordered]@{
        status = 'passed'; installerSha256 = $manifest.sha256
        os = [Environment]::OSVersion.VersionString; architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        checks = @('silent current-user installation', 'Unicode and spaces in install path', 'installed binary hash', 'unsigned signature status', 'WebView2 and IPC', 'SQLite and credential persistence after restart', 'silent uninstall')
        notTested = @('physical Windows 10/11 desktop', 'SmartScreen UX', 'missing WebView2 installation', 'live PostgreSQL/MySQL connection', 'signed update')
    } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $evidence lifecycle.json) -Encoding utf8
} finally {
    if ($application -and -not $application.HasExited) { Stop-Process -Id $application.Id -Force }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousUserData
    # Runner is ephemeral. Retain failed installation/data for diagnostics until runner disposal.
}
