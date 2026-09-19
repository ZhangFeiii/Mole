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

foreach ($name in @(
    "Get-ObjectPropertyText",
    "Test-UntrustedPathAttributes",
    "Test-LocalDrivePath",
    "Get-LocalPathParts",
    "Get-TrustedPathBoundary",
    "Resolve-TrustedExecutablePath",
    "Resolve-TrustedDirectoryPath"
)) {
    $definition = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
    if ($null -eq $definition) { throw "Missing function $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$driveLetter = ([string]$env:SystemRoot).Substring(0, 1).ToUpperInvariant()
$root = "{0}:\" -f $driveLetter
$safeParent = Join-Path $root "MoleReviewPathFixture"
$untrustedParent = Join-Path $safeParent "CloudPlaceholder"
$unsafeChild = Join-Path $untrustedParent "child.exe"
$script:Calls = New-Object 'System.Collections.Generic.List[string]'

function Get-PSDrive {
    param(
        [string]$Name,
        [string]$PSProvider,
        [object]$ErrorAction
    )
    return [PSCustomObject]@{ Name = $Name; Root = $root; DisplayRoot = "" }
}

function Get-Item {
    param(
        [string]$LiteralPath,
        [switch]$Force,
        [object]$ErrorAction
    )
    [void]$script:Calls.Add($LiteralPath)
    if ($LiteralPath -eq $root) {
        return [PSCustomObject]@{
            FullName = $root
            Attributes = [System.IO.FileAttributes]::Directory
            PSIsContainer = $true
        }
    }
    if ($LiteralPath -eq $safeParent) {
        return [PSCustomObject]@{
            FullName = $safeParent
            Attributes = [System.IO.FileAttributes]::Directory
            PSIsContainer = $true
        }
    }
    if ($LiteralPath -eq $untrustedParent) {
        return [PSCustomObject]@{
            FullName = $untrustedParent
            Attributes = [System.IO.FileAttributes]0x1000
            PSIsContainer = $true
        }
    }
    throw "Unexpected access below an untrusted ancestor: $LiteralPath"
}

$null = Resolve-TrustedExecutablePath -Path $unsafeChild
$expected = @($root, $safeParent, $untrustedParent)
if ($script:Calls.Count -ne $expected.Count) {
    throw "Executable lookup order was $($script:Calls -join '|')"
}
for ($index = 0; $index -lt $expected.Count; $index++) {
    if ($script:Calls[$index] -ne $expected[$index]) {
        throw "Executable lookup order was $($script:Calls -join '|')"
    }
}
if ($script:Calls -contains $unsafeChild) { throw "Executable child was accessed" }

$script:Calls.Clear()
$null = Resolve-TrustedDirectoryPath -Path (Join-Path $untrustedParent "child-directory")
$expectedDirectory = @($root, $safeParent, $untrustedParent)
if ($script:Calls.Count -ne $expectedDirectory.Count) {
    throw "Directory lookup order was $($script:Calls -join '|')"
}
for ($index = 0; $index -lt $expectedDirectory.Count; $index++) {
    if ($script:Calls[$index] -ne $expectedDirectory[$index]) {
        throw "Directory lookup order was $($script:Calls -join '|')"
    }
}
if ($script:Calls -contains (Join-Path $untrustedParent "child-directory")) {
    throw "Directory child was accessed"
}

[Console]::Out.WriteLine('{"ok":true}')
