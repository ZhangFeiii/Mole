#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../../windows/optimize.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid source syntax' }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-VolumeIdentity' }, $true)
. ([ScriptBlock]::Create($function.Extent.Text))
$a = Get-VolumeIdentity '\\?\Volume{11111111-1111-4111-8111-111111111111}\' 'AABBCCDD'
$b = Get-VolumeIdentity '\\?\Volume{22222222-2222-4222-8222-222222222222}\' 'AABBCCDD'
if (-not $a -or -not $b -or $a -eq $b) { throw 'Cloned serials must not alias different volumes' }
if (Get-VolumeIdentity '\\server\share' 'AABBCCDD') { throw 'Network identity must be rejected' }
if (Get-VolumeIdentity '\\?\Volume{11111111-1111-4111-8111-111111111111}\' '') { throw 'Missing serial must be rejected' }
[Console]::Out.WriteLine('volume identity fixture passed')

foreach ($name in @('Get-RequestedDriveLetters', 'Invoke-DiskOptimization')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
function Get-AdministratorState { return $true }
function Test-AvailableCommand { param([string]$Name) return $true }
$script:current = @([pscustomobject]@{ driveLetter = 'C:'; identity = $a })
function Get-FixedLocalDrives { return $script:current }
$script:called = @()
function Optimize-Volume { [CmdletBinding()] param([char]$DriveLetter) $script:called += [string]$DriveLetter }
$request = @([pscustomobject]@{ driveLetter = 'C:'; identity = $a })
$result = Invoke-DiskOptimization -DriveLetters $request
if (-not $result.ok -or $script:called.Count -ne 1 -or $script:called[0] -ne 'C') { throw 'Native optimization must receive a drive letter, not a volume object' }
$script:called = @()
$script:current = @([pscustomobject]@{ driveLetter = 'E:'; identity = $a })
$result = Invoke-DiskOptimization -DriveLetters $request
if ($result.ok -or $script:called.Count -ne 0) { throw 'A changed mount letter must not receive optimization' }
[Console]::Out.WriteLine('native volume invocation fixture passed')
