#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Fixture is restricted to ephemeral CI' }
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$token = [string]$request.token
if ($token -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid fixture token' }
$executable = [IO.Path]::GetFullPath([string]$request.executable)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $executable.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($executable)) { throw 'Executable must be the generated temp fixture' }
$keyPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\MoleIntegrationFixture-' + $token
$existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
if ($null -ne $existing) { $existing.Dispose(); throw 'Fixture key already exists' }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
try {
    $key.SetValue('MoleFixture', $token)
    $key.SetValue('DisplayName', ('Mole Integration Fixture ' + $token))
    $key.SetValue('Publisher', 'Mole integration tests')
    $key.SetValue('DisplayVersion', '1.0.0')
    $key.SetValue('InstallLocation', [IO.Path]::GetDirectoryName($executable))
    $key.SetValue('UninstallString', ('"' + $executable + '" --mole-fixture ' + $token))
} finally { $key.Dispose() }
[Console]::Out.WriteLine('{"ok":true}')
