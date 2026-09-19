#Requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if ($env:GITHUB_ACTIONS -ne "true") { throw "Fixture is restricted to hosted CI" }
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$token = [string]$request.token
if ($token -notmatch '^[0-9a-f-]{36}$') { throw "Invalid fixture token" }

$keyPath = "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoleReviewFixture-$token"
$ownProductCode = "{$token}"
$otherToken = ([Guid]::NewGuid()).ToString()
$otherProductCode = "{$otherToken}"
$key = $null

try {
    switch ([string]$request.action) {
        "register-msi-mismatch" {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
            $key.SetValue("MoleReviewFixture", $token)
            $key.SetValue("DisplayName", "Mole Review MSI Mismatch $token")
            $key.SetValue("Publisher", "Mole review fixture")
            $key.SetValue("DisplayVersion", "1.0.0")
            $key.SetValue("ProductCode", $ownProductCode)
            $key.SetValue("UninstallString", "MsiExec.exe /X$otherProductCode")
        }
        "register-msi-extra" {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
            $key.SetValue("MoleReviewFixture", $token)
            $key.SetValue("DisplayName", "Mole Review MSI Extra Args $token")
            $key.SetValue("Publisher", "Mole review fixture")
            $key.SetValue("DisplayVersion", "1.0.0")
            $key.SetValue("ProductCode", $ownProductCode)
            $key.SetValue("UninstallString", "MsiExec.exe /X$ownProductCode TRANSFORMS=other.mst")
        }
        "register-exe" {
            $executable = [IO.Path]::GetFullPath([string]$request.executable)
            $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
            if (-not $executable.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($executable)) {
                throw "Executable must be an existing generated temp fixture"
            }
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
            $key.SetValue("MoleReviewFixture", $token)
            $key.SetValue("DisplayName", "Mole Review Executable Fixture $token")
            $key.SetValue("Publisher", "Mole review fixture")
            $key.SetValue("DisplayVersion", "1.0.0")
            $key.SetValue("DisplayIcon", ('"' + $executable + '"'))
            $key.SetValue("InstallLocation", [IO.Path]::GetDirectoryName($executable))
            $key.SetValue("UninstallString", ('"' + $executable + '" --mole-review-fixture ' + $token))
        }
        "remove" {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
            if ($null -ne $key) {
                if ([string]$key.GetValue("MoleReviewFixture") -ne $token) { throw "Fixture ownership mismatch" }
                $key.Dispose()
                $key = $null
                [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyPath, $false)
            }
        }
        default { throw "Unsupported fixture action" }
    }
    [Console]::Out.WriteLine('{"ok":true}')
}
finally {
    if ($null -ne $key) { $key.Dispose() }
}
