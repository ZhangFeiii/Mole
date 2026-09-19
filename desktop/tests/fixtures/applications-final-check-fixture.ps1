#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$source = [System.IO.File]::ReadAllText($SourcePath)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "applications.ps1 parser errors" }

foreach ($name in @("Get-ObjectPropertyText", "New-Result", "Invoke-Win32Uninstall")) {
    $definition = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if ($null -eq $definition) { throw "Missing function $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$script:ResolveCalls = 0
$script:FingerprintCalls = 0
$script:ResolveNoCache = $false
$script:FingerprintNoCache = $false
$script:Started = $false
$executable = "C:\MoleFinalCheckFixture\uninstall.exe"

function Resolve-TrustedExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )
    if (-not $NoCache) { throw "Final path resolve must bypass the query cache" }
    $script:ResolveCalls++
    $script:ResolveNoCache = [bool]$NoCache
    return $Path
}

function Get-FileFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )
    if (-not $NoCache) { throw "Final fingerprint must bypass the query cache" }
    $script:FingerprintCalls++
    $script:FingerprintNoCache = [bool]$NoCache
    return [PSCustomObject]@{
        Path = $Path
        Hash = "replacement-hash"
        Length = [Int64]123
        LastWriteUtc = "2026-09-19T00:00:00.0000000Z"
    }
}

function Resolve-TrustedDirectoryPath {
    param([string]$Path, [switch]$NoCache)
    if (-not $NoCache) { throw "Working directory check must bypass caches" }
    return $null
}

function Start-Process {
    param([hashtable]$Parameters)
    $script:Started = $true
    throw "Start-Process must not be reached after a fingerprint mismatch"
}

$identity = [PSCustomObject]@{
    uninstallExecutableHash = "preview-hash"
    uninstallExecutableLength = "123"
    uninstallExecutableLastWriteUtc = "2026-09-19T00:00:00.0000000Z"
    installLocation = ""
}
$application = [PSCustomObject]@{
    id = "app-final-check-fixture"
    name = "Final Check Fixture"
    identity = $identity
    uninstall = [PSCustomObject]@{
        executable = $executable
        arguments = ""
    }
}

$result = Invoke-Win32Uninstall -Application $application -ExpectedIdentity $identity
if ($result.status -ne "identity-changed") { throw "Unexpected result status: $($result.status)" }
if ($script:ResolveCalls -ne 1 -or $script:FingerprintCalls -ne 1) { throw "Final executable verification was not called exactly once" }
if (-not $script:ResolveNoCache -or -not $script:FingerprintNoCache) { throw "Final verification did not bypass caches" }
if ($script:Started) { throw "Start-Process was reached after the mismatch" }

[Console]::Out.WriteLine('{"ok":true}')
