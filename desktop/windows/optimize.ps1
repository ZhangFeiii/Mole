[CmdletBinding()]
param()

# This script is intentionally a small fixed dispatcher. The Electron main
# process selects this packaged file; stdin contains one JSON request and
# stdout contains one JSON response. Do not add a generic command runner here.
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$scriptUtf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
[Console]::InputEncoding = $scriptUtf8
[Console]::OutputEncoding = $scriptUtf8

function Write-JsonResponse {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Compress -Depth 8
    $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    $stream = [Console]::OpenStandardOutput()
    $writer = New-Object -TypeName System.IO.StreamWriter -ArgumentList $stream, $encoding
    try {
        $writer.WriteLine($json)
        $writer.Flush()
    }
    finally {
        $writer.Dispose()
    }
}

function Get-AdministratorState {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Get-VolumeIdentity {
    param([string]$DeviceId, [string]$Serial)
    # A filesystem serial alone can be cloned. Bind the mount-manager volume
    # GUID as well so another volume at the same letter is not silently used.
    if ($DeviceId.Length -ne 49 -or -not $DeviceId.StartsWith('\\?\Volume{', [StringComparison]::OrdinalIgnoreCase) -or -not $DeviceId.EndsWith('}\') -or $Serial -notmatch '^[0-9A-Fa-f]{8}$') { return $null }
    $guid = [Guid]::Empty
    if (-not [Guid]::TryParse($DeviceId.Substring(11, 36), [ref]$guid) -or $guid -eq [Guid]::Empty) { return $null }
    return 'volume:' + $guid.ToString('D') + ':' + $Serial.ToUpperInvariant()
}

function Get-FixedLocalDrives {
    # DriveType 3 is a fixed local disk. It excludes removable, optical and
    # network drives; no caller-provided path or wildcard reaches this query.
    $volumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType = 3" -ErrorAction Stop)
    $volumeIds = @{}
    try {
        foreach ($nativeVolume in @(Get-CimInstance -ClassName Win32_Volume -Filter "DriveType = 3" -ErrorAction Stop)) {
            $letter = ([string]$nativeVolume.DriveLetter).ToUpperInvariant()
            if ($letter -match '^[A-Z]:$') { $volumeIds[$letter] = [string]$nativeVolume.DeviceID }
        }
    } catch { }
    $drives = @()
    foreach ($volume in $volumes) {
        $deviceId = [string]$volume.DeviceID
        if ($deviceId -notmatch "^[A-Za-z]:$") {
            continue
        }
        $volumeSerial = [string]$volume.VolumeSerialNumber
        $identity = Get-VolumeIdentity -DeviceId ([string]$volumeIds[$deviceId.ToUpperInvariant()]) -Serial $volumeSerial
        $drives += [pscustomobject][ordered]@{
            driveLetter = $deviceId.Substring(0, 1).ToUpperInvariant() + ":"
            identity = $identity
            volumeSerialNumber = if ($identity) { $volumeSerial.ToUpperInvariant() } else { $null }
            volumeName = [string]$volume.VolumeName
            fileSystem = [string]$volume.FileSystem
            sizeBytes = if ($null -eq $volume.Size) { $null } else { [Int64]$volume.Size }
            freeBytes = if ($null -eq $volume.FreeSpace) { $null } else { [Int64]$volume.FreeSpace }
        }
    }
    return @($drives | Sort-Object -Property driveLetter)
}

function Test-AvailableCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Invoke-Probe {
    $drives = @(Get-FixedLocalDrives)
    return [pscustomobject][ordered]@{
        ok = $true
        operation = "probe"
        collectedAt = [DateTime]::UtcNow.ToString("o")
        isAdmin = Get-AdministratorState
        dnsAvailable = Test-AvailableCommand -Name "Clear-DnsClientCache"
        optimizeAvailable = Test-AvailableCommand -Name "Optimize-Volume"
        drives = $drives
    }
}

function Invoke-DnsFlush {
    if (-not (Test-AvailableCommand -Name "Clear-DnsClientCache")) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "flush-dns"
            errorCode = "unsupported"
            message = "Windows DnsClient 模块不可用"
        }
    }

    Clear-DnsClientCache -ErrorAction Stop | Out-Null
    return [pscustomobject][ordered]@{
        ok = $true
        operation = "flush-dns"
        message = "已刷新 Windows DNS 客户端缓存"
    }
}

function Get-RequestedDriveLetters {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    if ($Value -is [string] -or $Value -isnot [System.Collections.IEnumerable]) {
        throw "driveLetters 必须是数组"
    }
    $letters = @()
    foreach ($valueItem in @($Value)) {
        if ($valueItem -is [string] -or $null -eq $valueItem) {
            throw "driveLetters 必须包含卷身份"
        }
        $letter = [string]$valueItem.driveLetter
        $identity = [string]$valueItem.identity
        if ($letter -notmatch "^[A-Za-z]:$") {
            throw "driveLetters 含有无效驱动器"
        }
        if ($identity -notmatch "^volume:[A-Za-z0-9._:-]{1,128}$") {
            throw "driveLetters 含有无效卷身份"
        }
        $letters += [pscustomobject][ordered]@{
            driveLetter = $letter.Substring(0, 1).ToUpperInvariant() + ":"
            identity = $identity.ToUpperInvariant()
        }
    }
    return @($letters | Sort-Object -Property identity -Unique)
}

function Invoke-DiskOptimization {
    param(
        [Parameter(Mandatory = $true)]
        [object]$DriveLetters
    )

    if (-not (Get-AdministratorState)) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "optimize-disks"
            errorCode = "permission-denied"
            message = "优化固定本地磁盘需要管理员权限；应用不会自动提权"
        }
    }
    if (-not (Test-AvailableCommand -Name "Optimize-Volume")) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "optimize-disks"
            errorCode = "unsupported"
            message = "Windows Storage 模块不可用"
        }
    }

    $requested = @(Get-RequestedDriveLetters -Value $DriveLetters)
    $current = @(Get-FixedLocalDrives)
    $allowed = @{}
    foreach ($drive in $current) {
        if ($null -ne $drive.identity) {
            $allowed[[string]$drive.identity] = $drive
        }
    }
    $targets = @($requested | Where-Object { $allowed.ContainsKey(([string]$_.identity).ToUpperInvariant()) -and $allowed[([string]$_.identity).ToUpperInvariant()].driveLetter -eq $_.driveLetter })
    $rejected = @($requested | Where-Object { -not ($allowed.ContainsKey(([string]$_.identity).ToUpperInvariant()) -and $allowed[([string]$_.identity).ToUpperInvariant()].driveLetter -eq $_.driveLetter) })
    if ($targets.Count -eq 0) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "optimize-disks"
            errorCode = "unsupported"
            message = "请求的驱动器不再是固定本地磁盘"
        }
    }

    $results = @()
    foreach ($requestedDrive in $targets) {
        $drive = $allowed[([string]$requestedDrive.identity).ToUpperInvariant()]
        try {
            # With no mode switch Windows chooses its documented default:
            # TRIM for supported SSDs and analysis/defrag for HDDs.
            Optimize-Volume -DriveLetter ([char]([string]$drive.driveLetter).Substring(0, 1)) -ErrorAction Stop | Out-Null
            $results += [pscustomobject][ordered]@{
                driveLetter = [string]$drive.driveLetter
                identity = [string]$drive.identity
                status = "completed"
                message = "Windows 默认磁盘优化已完成"
            }
        }
        catch {
            $results += [pscustomobject][ordered]@{
                driveLetter = [string]$drive.driveLetter
                identity = [string]$drive.identity
                status = "failed"
                message = [string]$_.Exception.Message
            }
        }
    }
    foreach ($drive in $rejected) {
        $results += [pscustomobject][ordered]@{
            driveLetter = [string]$drive.driveLetter
            identity = [string]$drive.identity
            status = "unsupported"
            message = "驱动器不再是固定本地磁盘，已跳过"
        }
    }

    $failed = @($results | Where-Object { $_.status -eq "failed" })
    $completed = @($results | Where-Object { $_.status -eq "completed" })
    if ($failed.Count -gt 0) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "optimize-disks"
            errorCode = "failed"
            message = "一个或多个固定本地磁盘优化失败"
            drives = @($results)
        }
    }
    if ($rejected.Count -gt 0) {
        return [pscustomobject][ordered]@{
            ok = $false
            operation = "optimize-disks"
            errorCode = "unsupported"
            message = "一个或多个驱动器不再是固定本地磁盘，已跳过"
            drives = @($results)
        }
    }
    return [pscustomobject][ordered]@{
        ok = $true
        operation = "optimize-disks"
        message = "已完成 $($completed.Count) 个固定本地磁盘的 Windows 默认优化"
        drives = @($results)
    }
}

$response = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "缺少 JSON 请求"
    }
    # The runner writes one JSON line and may terminate it with CR/LF. Remove
    # only that line terminator; embedded additional lines remain rejected.
    $raw = $raw.TrimEnd([char[]]([char]13, [char]10))
    if ($raw.IndexOf([char]10) -ge 0 -or $raw.IndexOf([char]13) -ge 0) {
        throw "请求必须是单行 JSON"
    }
    $request = $raw | ConvertFrom-Json
    $operation = [string]$request.operation
    switch ($operation) {
        "probe" {
            $response = Invoke-Probe
            break
        }
        "flush-dns" {
            $response = Invoke-DnsFlush
            break
        }
        "optimize-disks" {
            $response = Invoke-DiskOptimization -DriveLetters $request.driveLetters
            break
        }
        default {
            throw "不支持的维护操作"
        }
    }
}
catch {
    $message = [string]$_.Exception.Message
    $errorCode = "failed"
    if ($message -match "管理员|权限|拒绝访问|administrator|access is denied") {
        $errorCode = "permission-denied"
    }
    elseif ($message -match "不支持|不可用|无效驱动器") {
        $errorCode = "unsupported"
    }
    $response = [pscustomobject][ordered]@{
        ok = $false
        errorCode = $errorCode
        message = $message
    }
}

Write-JsonResponse -Value $response
