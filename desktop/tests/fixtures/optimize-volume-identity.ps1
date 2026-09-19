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
