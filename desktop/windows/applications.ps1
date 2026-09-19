#Requires -Version 5.1

<##
    The desktop application invokes this file through a fixed allow-list.  It
    accepts only JSON on stdin and emits exactly one compact JSON object on
    stdout.  Query is read-only.  Execute re-reads the registry/Appx object,
    compares the identity captured by query, and starts only the resulting
    vendor executable with Start-Process.  There is deliberately no command
    interpreter, dynamic command evaluation, cleanup pass, or user script.
##>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Warnings = New-Object 'System.Collections.Generic.List[string]'
$script:RunningProcessNames = @{}
$script:RunningProcessSnapshotReady = $false
$script:RunningProcessSnapshotError = $false
$script:FingerprintCache = @{}
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $script:Utf8NoBom
$inputEncoding = $script:Utf8NoBom
[Console]::InputEncoding = $inputEncoding
$OutputEncoding = $script:Utf8NoBom

function Add-Warning {
    param([string]$Message)

    if (-not [string]::IsNullOrWhiteSpace($Message) -and $script:Warnings.Count -lt 32) {
        [void]$script:Warnings.Add($Message.Trim().Substring(0, [Math]::Min(1000, $Message.Trim().Length)))
    }
}

function Get-TextHash {
    param([AllowNull()][string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $script:Utf8NoBom.GetBytes([string]$Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-StringValue {
    param(
        [Parameter(Mandatory = $true)]$Key,
        [Parameter(Mandatory = $true)][string]$Name
    )

    try {
        $value = $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { return "" }
        return ([string]$value).Trim()
    }
    catch {
        return ""
    }
}

function Get-LongValue {
    param(
        [Parameter(Mandatory = $true)]$Key,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = Get-StringValue -Key $Key -Name $Name
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    try {
        return [Int64]$value
    }
    catch {
        return $null
    }
}

function Get-RegistryViewName {
    param([Microsoft.Win32.RegistryView]$View)

    if ($View -eq [Microsoft.Win32.RegistryView]::Registry32) { return "Registry32" }
    if ($View -eq [Microsoft.Win32.RegistryView]::Registry64) { return "Registry64" }
    return "Default"
}

function ConvertTo-RegistryView {
    param([AllowNull()][string]$Name)

    switch -Regex ($Name) {
        "^Registry32$" { return [Microsoft.Win32.RegistryView]::Registry32 }
        "^Registry64$" { return [Microsoft.Win32.RegistryView]::Registry64 }
        default { return [Microsoft.Win32.RegistryView]::Default }
    }
}

function Get-RegistryLocation {
    param(
        [Parameter(Mandatory = $true)][string]$HiveName,
        [Parameter(Mandatory = $true)][string]$SubKey
    )

    return ("{0}:\{1}" -f $HiveName, $SubKey.TrimStart("\"))
}

function Get-RegistryParts {
    param([Parameter(Mandatory = $true)][string]$RegistryPath)

    $match = [regex]::Match($RegistryPath, "^(HKLM|HKCU):\\(.+)$", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return $null }
    $hiveName = $match.Groups[1].Value.ToUpperInvariant()
    $hive = if ($hiveName -eq "HKLM") { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
    return [ordered]@{ Hive = $hive; HiveName = $hiveName; SubKey = $match.Groups[2].Value }
}

function Get-ObjectPropertyText {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) { return "" }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        if ($null -eq $Object[$Name]) { return "" }
        return [string]$Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return "" }
    return [string]$property.Value
}

function Get-ObjectPropertyValue {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-DangerousUninstallCommand {
    param([AllowNull()][string]$Command)

    if ([string]::IsNullOrWhiteSpace($Command) -or $Command.Length -gt 8192) { return "卸载命令为空或过长" }
    if ($Command -match '[\r\n\u0000]') {
        return "卸载命令包含控制字符"
    }
    if ($Command -match '(?i)(^|[\s\\/"])(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|mshta(?:\.exe)?|wscript(?:\.exe)?|cscript(?:\.exe)?|rundll32(?:\.exe)?|regsvr32(?:\.exe)?|bash(?:\.exe)?|sh(?:\.exe)?)(?=$|[\s\\/"])') {
        return "卸载命令包含不允许的命令解释器"
    }
    if ($Command -match '(?i)\.(?:bat|cmd|ps1|psm1|vbs|vbe|js|jse|hta|sh|bash)(?:$|[\s"])') {
        return "卸载命令包含不允许的脚本文件"
    }
    if ($Command -match '[;&|<>`]') {
        return "卸载命令包含 shell 元字符"
    }
    return $null
}

function Resolve-TrustedExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    # Only an absolute local drive path is accepted.  UNC, device namespace,
    # drive-relative, rooted-current-drive, and reparse/cloud paths are all
    # outside the uninstall trust boundary.  Get-TrustedPathBoundary walks
    # ancestors from the drive root before it ever opens the final child; this
    # prevents a static junction/cloud placeholder from redirecting the first
    # lookup into a network or hydration path.
    $item = Get-TrustedExecutableItem -Path $Path -NoCache:$NoCache
    if ($null -eq $item) { return $null }
    return $item.FullName
}

function Get-TrustedExecutableItem {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    $boundary = Get-TrustedPathBoundary -Path $Path -NoCache:$NoCache
    if ($null -eq $boundary) { return $null }
    $item = $null
    try {
        $item = Get-Item -LiteralPath $boundary.Path -Force -ErrorAction Stop
        if ($item.PSIsContainer) { return $null }
        if (Test-UntrustedPathAttributes -Attributes $item.Attributes) {
            return $null
        }
        return $item
    }
    catch {
        return $null
    }
}

function Test-UntrustedPathAttributes {
    param([Parameter(Mandatory = $true)][System.IO.FileAttributes]$Attributes)

    # Reparse points include junctions and cloud placeholders.  The explicit
    # cloud flags cover providers that do not set ReparsePoint consistently.
    $untrustedMask = 0x400 -bor 0x1000 -bor 0x40000 -bor 0x400000
    return (([int]$Attributes -band $untrustedMask) -ne 0)
}

function Test-LocalDrivePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    $driveName = $Path.Substring(0, 1).ToUpperInvariant()
    $trusted = $false
    try {
        $root = "{0}:\" -f $driveName
        $driveInfo = New-Object System.IO.DriveInfo($root)
        if ($driveInfo.DriveType -eq [System.IO.DriveType]::Network -or
            $driveInfo.DriveType -eq [System.IO.DriveType]::NoRootDirectory -or
            $driveInfo.DriveType -eq [System.IO.DriveType]::Unknown) {
            return $false
        }
        $drive = Get-PSDrive -Name $driveName -PSProvider FileSystem -ErrorAction Stop
        $displayRoot = Get-ObjectPropertyText -Object $drive -Name "DisplayRoot"
        if ($drive.Root -match '^(?:\\\\|//)' -or $displayRoot -match '^(?:\\\\|//)') {
            return $false
        }
        $trusted = $true
    }
    catch {
        $trusted = $false
    }
    return $trusted
}

function Get-LocalPathParts {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or
        $Path -notmatch '^(?i:[a-z]):\\' -or
        ($Path.Length -gt 2 -and $Path.Substring(2) -match ':') -or
        $Path -match '^(?:\\\\|//|\\\\\?\\|\\\\\.\\)') {
        return $null
    }

    $segments = New-Object 'System.Collections.Generic.List[string]'
    $tail = $Path.Substring(3)
    if ($tail.Length -gt 0) {
        foreach ($segment in ($tail -split '\\')) {
            if ([string]::IsNullOrEmpty($segment)) { continue }
            # Reject traversal instead of asking the filesystem to normalize it
            # before the ancestor checks have established the trust boundary.
            if ($segment -eq "." -or $segment -eq ".." -or $segment -match ':') {
                return $null
            }
            [void]$segments.Add($segment)
        }
    }
    return [PSCustomObject]@{
        Root = ("{0}:\" -f $Path.Substring(0, 1).ToUpperInvariant())
        Segments = $segments.ToArray()
    }
}

function Get-TrustedPathBoundary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    $parts = Get-LocalPathParts -Path $Path
    if ($null -eq $parts -or -not (Test-LocalDrivePath -Path $Path -NoCache:$NoCache)) { return $null }

    try {
        # The root is the first filesystem object inspected.  Every following
        # ancestor is checked before Join-Path is allowed to name its child.
        if (-not (Test-TrustedDirectoryPath -Path $parts.Root -NoCache:$NoCache)) {
            return $null
        }
        for ($index = 0; $index -lt ($parts.Segments.Count - 1); $index++) {
            $candidatePath = Join-Path -Path $parts.Root -ChildPath (($parts.Segments[0..$index]) -join '\')
            if (-not (Test-TrustedDirectoryPath -Path $candidatePath -NoCache:$NoCache)) {
                return $null
            }
        }
        $finalPath = $parts.Root
        if ($parts.Segments.Count -gt 0) {
            $finalPath = Join-Path -Path $parts.Root -ChildPath ($parts.Segments -join '\')
        }
        return [PSCustomObject]@{ Path = $finalPath }
    }
    catch {
        return $null
    }
}

function Test-TrustedDirectoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        return $item.PSIsContainer -and -not (Test-UntrustedPathAttributes -Attributes $item.Attributes)
    }
    catch {
        return $false
    }
}

function Get-FileFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$NoCache
    )

    $info = Get-TrustedExecutableItem -Path $Path -NoCache:$NoCache
    if ($null -eq $info) { return $null }
    $trustedPath = [string]$info.FullName
    $lastWriteUtc = $info.LastWriteTimeUtc.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    $cacheKey = $trustedPath.ToUpperInvariant()
    if (-not $NoCache -and $script:FingerprintCache.ContainsKey($cacheKey)) {
        $cached = $script:FingerprintCache[$cacheKey]
        if ($cached.Length -eq [Int64]$info.Length -and $cached.LastWriteUtc -eq $lastWriteUtc) {
            return $cached
        }
    }
    $stream = $null
    $sha = $null
    try {
        # Hashing an unexpectedly large file would make a read-only preview
        # unbounded.  Such a vendor entry is not enabled for uninstall.
        if ($info.Length -gt 128MB) { return $null }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($trustedPath)
        $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        $fingerprint = [PSCustomObject]@{
            Path = $trustedPath
            Hash = $hash
            Length = [Int64]$info.Length
            LastWriteUtc = $lastWriteUtc
        }
        if (-not $NoCache) { $script:FingerprintCache[$cacheKey] = $fingerprint }
        return $fingerprint
    }
    catch {
        return $null
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $sha) { $sha.Dispose() }
    }
}

function Resolve-TrustedDirectoryPath {
    param(
        [AllowNull()][string]$Path,
        [switch]$NoCache
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $boundary = Get-TrustedPathBoundary -Path $Path -NoCache:$NoCache
    if ($null -eq $boundary) { return $null }
    $item = $null
    try {
        $item = Get-Item -LiteralPath $boundary.Path -Force -ErrorAction Stop
        if (-not $item.PSIsContainer) { return $null }
        if (Test-UntrustedPathAttributes -Attributes $item.Attributes) { return $null }
        return $item.FullName
    }
    catch {
        return $null
    }
}

function Convert-UninstallCommand {
    param([AllowNull()][string]$Command)

    $raw = if ($null -eq $Command) { "" } else { $Command.Trim() }
    $hash = Get-TextHash -Text $raw
    $danger = Test-DangerousUninstallCommand -Command $raw
    $invalid = [ordered]@{
        Valid = $false
        Reason = if ($danger) { $danger } else { "无法解析官方卸载程序" }
        Executable = ""
        Arguments = ""
        Hash = $hash
        IsMsi = $false
        ProductCode = ""
        ExecutableHash = ""
        ExecutableLength = $null
        ExecutableLastWriteUtc = ""
    }
    if ($danger) { return [PSCustomObject]$invalid }

    $match = [regex]::Match($raw, '^\s*"(?<exe>[^"]+)"(?<args>.*)$')
    if (-not $match.Success) {
        $match = [regex]::Match($raw, '^\s*(?<exe>[^\s"]+)(?<args>.*)$')
    }
    if (-not $match.Success) { return [PSCustomObject]$invalid }

    $executable = $match.Groups["exe"].Value.Trim()
    $argumentTail = $match.Groups["args"].Value
    if ($raw -match '^\s*"' -and $argumentTail -and $argumentTail -notmatch '^\s') {
        $invalid.Reason = "卸载程序路径与参数之间缺少空白"
        return [PSCustomObject]$invalid
    }
    $arguments = $argumentTail.Trim()
    if ([string]::IsNullOrWhiteSpace($executable) -or $executable.Length -gt 4096) { return [PSCustomObject]$invalid }
    $quoteCount = ([regex]::Matches($arguments, '"')).Count
    if (($quoteCount % 2) -ne 0) {
        $invalid.Reason = "卸载参数引号不匹配"
        return [PSCustomObject]$invalid
    }

    $leaf = [System.IO.Path]::GetFileName($executable)
    $isMsiExec = $leaf -match '(?i)^msiexec(?:\.exe)?$'
    if ($isMsiExec) {
        $systemRoot = [Environment]::GetEnvironmentVariable("SystemRoot")
        if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = "C:\Windows" }
        $executable = Join-Path $systemRoot "System32\msiexec.exe"
        $trustedMsiPath = Resolve-TrustedExecutablePath -Path $executable
        if ([string]::IsNullOrWhiteSpace($trustedMsiPath)) {
            $invalid.Reason = "系统 MSI 执行程序不可验证"
            return [PSCustomObject]$invalid
        }
        $executable = $trustedMsiPath
        $tokens = @([regex]::Matches($arguments, '(?:"[^"]*"|[^\s]+)') | ForEach-Object { $_.Value.Trim('"') })
        if ($tokens.Count -eq 0) {
            $invalid.Reason = "MSI 卸载参数为空"
            return [PSCustomObject]$invalid
        }
        # Accept the two common vendor forms /X{GUID} and /I{GUID}.  The
        # latter is the Add/Remove registry convention; it is normalized to a
        # deterministic uninstall command.  All arbitrary MSI properties are
        # rejected and /norestart is always added to avoid a forced reboot.
        $guidPattern = '^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$'
        $operation = ""
        $productCode = ""
        if ($tokens[0] -match "(?i)^/(x|i|uninstall)(\{[0-9a-f-]{36}\})$") {
            $operation = $Matches[1]
            $productCode = $Matches[2]
            $remaining = if ($tokens.Count -gt 1) { @($tokens | Select-Object -Skip 1) } else { @() }
        }
        elseif ($tokens[0] -match "(?i)^/(x|i|uninstall)$") {
            $operation = $Matches[1]
            if ($tokens.Count -lt 2 -or $tokens[1] -notmatch $guidPattern) {
                $invalid.Reason = "MSI 命令缺少产品代码"
                return [PSCustomObject]$invalid
            }
            $productCode = $tokens[1]
            $remaining = if ($tokens.Count -gt 2) { @($tokens | Select-Object -Skip 2) } else { @() }
        }
        else {
            $invalid.Reason = "MSI 命令必须明确指定一个产品卸载代码"
            return [PSCustomObject]$invalid
        }
        if ($productCode -notmatch $guidPattern -or ([regex]::Matches($arguments, '(?i)\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}')).Count -ne 1) {
            $invalid.Reason = "MSI 命令必须只包含一个产品代码"
            return [PSCustomObject]$invalid
        }
        foreach ($token in $remaining) {
            if ($token -notmatch '(?i)^/(?:quiet|qn|passive|norestart)$') {
                $invalid.Reason = "MSI 参数包含未允许的属性"
                return [PSCustomObject]$invalid
            }
        }
        # Do not pass the registry's raw MSI string to Start-Process.
        $arguments = "/X $productCode /norestart"
        $fingerprint = Get-FileFingerprint -Path $executable
        if ($null -eq $fingerprint) {
            $invalid.Reason = "系统 MSI 执行程序指纹不可确认"
            return [PSCustomObject]$invalid
        }
    }
    else {
        if ($executable -notmatch '(?i)\.exe$' -or -not [System.IO.Path]::IsPathRooted($executable)) {
            $invalid.Reason = "卸载程序必须是存在的绝对 EXE 路径"
            return [PSCustomObject]$invalid
        }
        $trustedPath = Resolve-TrustedExecutablePath -Path $executable
        if ([string]::IsNullOrWhiteSpace($trustedPath)) {
            $invalid.Reason = "官方卸载程序不存在"
            return [PSCustomObject]$invalid
        }
        $executable = $trustedPath
        $fingerprint = Get-FileFingerprint -Path $executable
        if ($null -eq $fingerprint) {
            $invalid.Reason = "官方卸载程序指纹不可确认"
            return [PSCustomObject]$invalid
        }
    }

    return [PSCustomObject]@{
        Valid = $true
        Reason = ""
        Executable = $executable
        Arguments = $arguments
        Hash = $hash
        IsMsi = $isMsiExec
        ProductCode = if ($isMsiExec) { $productCode.ToUpperInvariant() } else { "" }
        ExecutableHash = $fingerprint.Hash
        ExecutableLength = $fingerprint.Length
        ExecutableLastWriteUtc = $fingerprint.LastWriteUtc
    }
}

function Get-KnownProcessNames {
    param([AllowNull()][string]$DisplayIcon)

    $names = New-Object 'System.Collections.Generic.List[string]'
    if ([string]::IsNullOrWhiteSpace($DisplayIcon)) { return $names.ToArray() }
    $match = [regex]::Match($DisplayIcon.Trim(), '^\s*"(?<path>[^"]+)"')
    if (-not $match.Success) {
        $match = [regex]::Match($DisplayIcon.Trim(), '^\s*(?<path>[^\s,]+)')
    }
    if (-not $match.Success) { return $names.ToArray() }
    $iconPath = $match.Groups["path"].Value
    if ($iconPath -notmatch '(?i)\.exe$') { return $names.ToArray() }
    $leaf = [System.IO.Path]::GetFileNameWithoutExtension($iconPath)
    if ($leaf -match '^[A-Za-z0-9._-]{1,128}$') { [void]$names.Add($leaf) }
    return $names.ToArray()
}

function Test-RunningProcess {
    param([string[]]$Names)

    if ($null -eq $Names -or $Names.Count -eq 0) { return $false }
    if (-not $script:RunningProcessSnapshotReady) { Initialize-RunningProcessSnapshot }
    if ($script:RunningProcessSnapshotError) { return $null }
    foreach ($name in $Names) {
        if ($script:RunningProcessNames.ContainsKey($name)) { return $true }
    }
    return $false
}

function Initialize-RunningProcessSnapshot {
    if ($script:RunningProcessSnapshotReady) { return }
    try {
        $snapshot = @{}
        foreach ($process in @(Get-Process -ErrorAction Stop)) {
            $name = [string]$process.ProcessName
            if ($name) { $snapshot[$name] = $true }
        }
        $script:RunningProcessNames = $snapshot
        $script:RunningProcessSnapshotReady = $true
    }
    catch {
        # Access-denied/process enumeration failures must not silently enable a
        # possibly running application for an uninstall.
        $script:RunningProcessSnapshotError = $true
        $script:RunningProcessSnapshotReady = $true
    }
}

function Get-ProtectionReason {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Publisher,
        [AllowNull()][string]$AppxName,
        [bool]$IsFramework = $false,
        [bool]$IsResourcePackage = $false,
        [AllowNull()][string]$SignatureKind,
        [bool]$NonRemovable = $false,
        [bool]$IsPartiallyStaged = $false,
        [AllowNull()][string]$PackageStatus,
        [AllowNull()][string]$SystemComponent,
        [AllowNull()][string]$NoRemove,
        [AllowNull()][string]$ReleaseType,
        [AllowNull()][string]$ParentKeyName
    )

    if ($IsFramework -or $IsResourcePackage) { return "Windows 框架或资源包受保护" }
    if ($NonRemovable) { return "Appx 标记为不可移除" }
    if ($IsPartiallyStaged) { return "Appx 包处于暂存状态，已停止卸载" }
    if (-not [string]::IsNullOrWhiteSpace($PackageStatus) -and $PackageStatus -ne "Ok") {
        return "Appx 包状态不是可安全移除状态"
    }
    if ($SignatureKind -eq "System") { return "系统签名的 Windows 应用受保护" }
    if ($SystemComponent -match '^(?i:1|true|yes)$' -or $NoRemove -match '^(?i:1|true|yes)$') {
        return "注册表标记为系统组件或不可移除"
    }
    if ($ReleaseType -match '(?i)^(?:update|security update|hotfix|component update|operating system|system)$') {
        return "注册表标记为 Windows 更新或系统项目"
    }
    if (-not [string]::IsNullOrWhiteSpace($ParentKeyName)) {
        return "注册表项目属于系统父组件"
    }
    if ($Name -match '(?i)^Microsoft Windows(?:$|\s)|^Windows Feature Experience Pack$|^Microsoft Edge(?:$| WebView2)|^Windows Security(?:$|\s)|^Microsoft Visual C\+\+|^Microsoft \.NET|^\.NET(?: Desktop)? Runtime|^Microsoft Update Health Tools$') {
        return "Windows 系统或运行时项目受保护"
    }
    if ($Name -match '(?i)^NVIDIA(?:$|\s).*Driver|^AMD(?:$|\s).*Software|^Intel(?:$|\s).*Driver') {
        return "显卡或硬件驱动项目受保护"
    }
    if ($Name -match '(?i)\bDriver\b') {
        return "驱动项目受保护"
    }
    if ($Name -match '(?i)^(?:PowerShell|Python|Node\.js|Ruby|Perl|PHP)(?:$|\s)|^Windows Terminal(?:$|\s)|^(?:Windows Subsystem for Linux|WSL)(?:$|\s)') {
        return "脚本解释器、终端或运行时项目受保护"
    }
    $isDriverRelease = $ReleaseType -match '(?i)^driver$'
    $isKnownHardware = ($Publisher -match '(?i)(?:NVIDIA|AMD|Intel|Realtek|Qualcomm|Broadcom|Synaptics|Wacom)' -and $Name -match '(?i)driver|graphics|audio|chipset')
    if ($isDriverRelease -or $isKnownHardware) {
        return "硬件驱动项目受保护"
    }
    if (-not [string]::IsNullOrWhiteSpace($AppxName)) {
        if ($AppxName -in @("Microsoft.WindowsStore", "Microsoft.DesktopAppInstaller", "Microsoft.Windows.ShellExperienceHost", "Microsoft.Windows.StartMenuExperienceHost", "MicrosoftWindows.Client.CBS", "MicrosoftWindows.UndockedDevKit", "Microsoft.XboxGameCallableUI")) {
            return "Windows 核心 Appx 项目受保护"
        }
        if ($AppxName -match '(?i)^(?:Microsoft\.Windows|MicrosoftWindows\.)') {
            return "Windows 核心 Appx 项目受保护"
        }
        if ($AppxName -match '(?i)^(?:Microsoft\.(?:PowerShell|VCLibs|NET\.|UI\.Xaml)|PowerShell|Windows\.Terminal|Microsoft\.Windows\.Wsl)|(?:Framework|Runtime|Driver|Interpreter)') {
            return "脚本解释器、运行时或驱动 Appx 项目受保护"
        }
    }
    return $null
}

function Get-ApplicationId {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("win32", "appx")][string]$Kind,
        [Parameter(Mandatory = $true)]$Identity
    )

    if ($Kind -eq "appx") {
        $seed = "appx|$(Get-ObjectPropertyText -Object $Identity -Name packageFullName)"
    }
    else {
        $seed = "win32|$(Get-ObjectPropertyText -Object $Identity -Name registryPath)|$(Get-ObjectPropertyText -Object $Identity -Name registryView)"
    }
    $fullId = "app-$(Get-TextHash -Text $seed)"
    return $fullId.Substring(0, 28)
}

function New-Win32Application {
    param(
        [Parameter(Mandatory = $true)]$Key,
        [Parameter(Mandatory = $true)][string]$HiveName,
        [Parameter(Mandatory = $true)][string]$SubKey,
        [Parameter(Mandatory = $true)][string]$ViewName
    )

    $name = Get-StringValue -Key $Key -Name "DisplayName"
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }
    # The registry's canonical UninstallString is the identity we verify and
    # execute.  QuietUninstallString is intentionally not substituted because
    # it can be a vendor-specific wrapper with a different trust boundary.
    $uninstall = Get-StringValue -Key $Key -Name "UninstallString"
    $publisher = Get-StringValue -Key $Key -Name "Publisher"
    $version = Get-StringValue -Key $Key -Name "DisplayVersion"
    $installLocation = Get-StringValue -Key $Key -Name "InstallLocation"
    $description = Get-StringValue -Key $Key -Name "Comments"
    $installDate = Get-StringValue -Key $Key -Name "InstallDate"
    $estimatedKB = Get-LongValue -Key $Key -Name "EstimatedSize"
    $registeredProductCode = Get-StringValue -Key $Key -Name "ProductCode"
    $subKeyProductCode = ""
    $subKeyLeaf = [System.IO.Path]::GetFileName($SubKey)
    if ($subKeyLeaf -match '(?i)^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$') {
        $subKeyProductCode = $subKeyLeaf.ToUpperInvariant()
    }
    if ([string]::IsNullOrWhiteSpace($registeredProductCode)) {
        $registeredProductCode = $subKeyProductCode
    }
    if (-not [string]::IsNullOrWhiteSpace($registeredProductCode)) {
        $registeredProductCode = $registeredProductCode.ToUpperInvariant()
    }
    $displayIcon = Get-StringValue -Key $Key -Name "DisplayIcon"
    $registryPath = Get-RegistryLocation -HiveName $HiveName -SubKey $SubKey
    $identity = [ordered]@{
        registryPath = $registryPath
        registryView = $ViewName
        scope = if ($HiveName -eq "HKLM") { "machine" } else { "user" }
        displayName = $name
        publisher = $publisher
        version = $version
        productCode = $registeredProductCode
        uninstallHash = Get-TextHash -Text $uninstall
        installLocation = $installLocation
        systemComponent = Get-StringValue -Key $Key -Name "SystemComponent"
        noRemove = Get-StringValue -Key $Key -Name "NoRemove"
        releaseType = Get-StringValue -Key $Key -Name "ReleaseType"
        parentKeyName = Get-StringValue -Key $Key -Name "ParentKeyName"
    }
    $knownProcessNames = @(Get-KnownProcessNames -DisplayIcon $displayIcon)
    $running = Test-RunningProcess -Names $knownProcessNames
    $protectedReason = Get-ProtectionReason -Name $name -Publisher $publisher -SystemComponent $identity.systemComponent -NoRemove $identity.noRemove -ReleaseType $identity.releaseType -ParentKeyName $identity.parentKeyName
    # Protected or currently-running entries cannot be executed, so avoid
    # parsing and hashing their vendor binary during the read-only scan.
    $skipFingerprint = (-not [string]::IsNullOrWhiteSpace($protectedReason)) -or ($running -ne $false)
    $parsed = if ($skipFingerprint) {
        [PSCustomObject]@{
            Valid = $false
            Reason = "此项目不会进入卸载执行队列"
            Executable = ""
            Arguments = ""
            Hash = $identity.uninstallHash
            IsMsi = $false
            ProductCode = ""
            ExecutableHash = ""
            ExecutableLength = $null
            ExecutableLastWriteUtc = ""
        }
    } else {
        Convert-UninstallCommand -Command $uninstall
    }
    $msiIdentityReason = ""
    if ($parsed.IsMsi) {
        if ($identity.productCode -notmatch '(?i)^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$') {
            $msiIdentityReason = "MSI 登记项缺少可验证的 ProductCode"
        } elseif ($subKeyProductCode -and $identity.productCode -ne $subKeyProductCode) {
            $msiIdentityReason = "MSI ProductCode 与注册表键 GUID 不一致"
        } elseif ($identity.productCode -ne $parsed.ProductCode.ToUpperInvariant()) {
            $msiIdentityReason = "MSI 卸载 GUID 与登记项 ProductCode 不一致"
        }
    }
    $identity.msiProductCode = $parsed.ProductCode
    $identity.uninstallExecutableHash = $parsed.ExecutableHash
    $identity.uninstallExecutableLength = $parsed.ExecutableLength
    $identity.uninstallExecutableLastWriteUtc = $parsed.ExecutableLastWriteUtc
    $enabled = $parsed.Valid -and [string]::IsNullOrWhiteSpace($msiIdentityReason) -and [string]::IsNullOrWhiteSpace($protectedReason) -and $running -eq $false
    $reason = if ($protectedReason) { $protectedReason } elseif ($msiIdentityReason) { $msiIdentityReason } elseif ($null -eq $running) { "无法确认软件是否正在运行，已停止卸载" } elseif ($running) { "软件正在运行，请先退出后再卸载" } elseif (-not $parsed.Valid) { $parsed.Reason } else { "" }
    $item = [ordered]@{
        id = Get-ApplicationId -Kind "win32" -Identity ([PSCustomObject]$identity)
        kind = "win32"
        source = "registry"
        name = $name
        description = if ($description) { $description } else { $name }
        publisher = $publisher
        version = $version
        scope = $identity.scope
        installDate = $installDate
        enabled = $enabled
        protected = (-not [string]::IsNullOrWhiteSpace($protectedReason))
        running = $running
        knownProcessNames = $knownProcessNames
        reason = $reason
        identity = $identity
        uninstall = if ($parsed.Valid) {
            [ordered]@{ executable = $parsed.Executable; arguments = $parsed.Arguments }
        } else { $null }
    }
    if ($null -ne $estimatedKB -and $estimatedKB -ge 0) {
        try { $item.sizeBytes = [Int64]$estimatedKB * 1024 } catch { }
    }
    return [PSCustomObject]$item
}

function Get-Win32Applications {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $specs = @(
        [PSCustomObject]@{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; HiveName = "HKLM"; Paths = @("SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall") }
        [PSCustomObject]@{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; HiveName = "HKCU"; Paths = @("SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall") }
    )
    $views = if ([Environment]::Is64BitOperatingSystem) {
        @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
    } else { @([Microsoft.Win32.RegistryView]::Default) }

    foreach ($spec in $specs) {
        foreach ($view in $views) {
            $viewName = Get-RegistryViewName -View $view
            foreach ($subPath in $spec.Paths) {
                $base = $null
                $root = $null
                try {
                    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($spec.Hive, $view)
                    $root = $base.OpenSubKey($subPath)
                    if ($null -eq $root) { continue }
                    foreach ($childName in $root.GetSubKeyNames()) {
                        $child = $null
                        try {
                            $child = $root.OpenSubKey($childName)
                            if ($null -eq $child) { continue }
                            $item = New-Win32Application -Key $child -HiveName $spec.HiveName -SubKey (Join-Path $subPath $childName) -ViewName $viewName
                            if ($null -ne $item) {
                                # HKCU uninstall keys are commonly visible in
                                # both registry views.  Prefer Registry64 and
                                # suppress an exact duplicate while retaining
                                # genuinely different 32/64 registrations.
                                $dedupeKey = "$(Get-ObjectPropertyText -Object $item.identity -Name registryPath)|$(Get-ObjectPropertyText -Object $item.identity -Name uninstallHash)"
                                if ($seen.Add($dedupeKey)) { [void]$items.Add($item) }
                            }
                        }
                        catch {
                            Add-Warning "无法读取注册表项目 $childName"
                        }
                        finally {
                            if ($null -ne $child) { $child.Dispose() }
                        }
                    }
                }
                catch {
                    Add-Warning "无法读取注册表视图 $($spec.HiveName) $viewName"
                }
                finally {
                    if ($null -ne $root) { $root.Dispose() }
                    if ($null -ne $base) { $base.Dispose() }
                }
            }
        }
    }
    return $items.ToArray()
}

function New-AppxApplication {
    param([Parameter(Mandatory = $true)]$Package)

    $name = [string]$Package.Name
    $displayName = $name
    $knownProcessNames = @()
    $isFramework = [bool](Get-ObjectPropertyValue -Object $Package -Name "IsFramework")
    $isResourcePackage = [bool](Get-ObjectPropertyValue -Object $Package -Name "IsResourcePackage")
    $isPartiallyStaged = [bool](Get-ObjectPropertyValue -Object $Package -Name "IsPartiallyStaged")
    $isOptionalPackage = [bool](Get-ObjectPropertyValue -Object $Package -Name "IsOptionalPackage")
    $isBundle = [bool](Get-ObjectPropertyValue -Object $Package -Name "IsBundle")
    $nonRemovable = [bool](Get-ObjectPropertyValue -Object $Package -Name "NonRemovable")
    $packageStatus = [string](Get-ObjectPropertyValue -Object $Package -Name "Status")
    $signatureKind = [string](Get-ObjectPropertyValue -Object $Package -Name "SignatureKind")
    # System/framework/runtime packages are blocked regardless of their
    # localized display name.  Do not load their manifests merely to discover
    # a process name that can never be offered for removal.
    $skipManifest = $isFramework -or $isResourcePackage -or $isPartiallyStaged -or $nonRemovable -or
        $signatureKind -eq "System" -or
        (-not [string]::IsNullOrWhiteSpace($packageStatus) -and $packageStatus -ne "Ok") -or
        $name -match '(?i)^(?:Microsoft\.Windows|MicrosoftWindows\.|Microsoft\.(?:PowerShell|VCLibs|NET\.|UI\.Xaml)|PowerShell|Windows\.Terminal|Microsoft\.Windows\.Wsl)|(?:Framework|Runtime|Driver|Interpreter)'
    if (-not $skipManifest) {
        try {
            $manifest = Get-AppxPackageManifest -Package $Package.PackageFullName -ErrorAction Stop
            $packageNode = Get-ObjectPropertyValue -Object $manifest -Name "Package"
            $propertiesNode = Get-ObjectPropertyValue -Object $packageNode -Name "Properties"
            $candidate = Get-ObjectPropertyText -Object $propertiesNode -Name "DisplayName"
            if ($candidate -and $candidate -notmatch '^ms-resource:') { $displayName = $candidate }
            $applicationsNode = Get-ObjectPropertyValue -Object $packageNode -Name "Applications"
            foreach ($application in @((Get-ObjectPropertyValue -Object $applicationsNode -Name "Application"))) {
                $executable = Get-ObjectPropertyText -Object $application -Name "Executable"
                $leaf = [System.IO.Path]::GetFileNameWithoutExtension($executable)
                if ($leaf -match '^[A-Za-z0-9._-]{1,128}$') { $knownProcessNames += $leaf }
            }
        }
        catch { }
    }
    $knownProcessNames = @($knownProcessNames | Select-Object -Unique | Select-Object -First 16)
    $identity = [ordered]@{
        packageFullName = [string]$Package.PackageFullName
        name = $name
        publisher = [string]$Package.Publisher
        version = ([string]$Package.Version)
        packageFamilyName = [string]$Package.PackageFamilyName
        installLocation = [string]$Package.InstallLocation
        isFramework = $isFramework
        isResourcePackage = $isResourcePackage
        isPartiallyStaged = $isPartiallyStaged
        isOptionalPackage = $isOptionalPackage
        isBundle = $isBundle
        nonRemovable = $nonRemovable
        packageStatus = $packageStatus
        signatureKind = $signatureKind
    }
    $running = Test-RunningProcess -Names $knownProcessNames
    $protectedReason = Get-ProtectionReason -Name $displayName -Publisher $identity.publisher -AppxName $name -IsFramework $identity.isFramework -IsResourcePackage $identity.isResourcePackage -SignatureKind $identity.signatureKind -NonRemovable $identity.nonRemovable -IsPartiallyStaged $identity.isPartiallyStaged -PackageStatus $identity.packageStatus
    $enabled = [string]::IsNullOrWhiteSpace($protectedReason) -and $running -eq $false
    $reason = if ($protectedReason) { $protectedReason } elseif ($null -eq $running) { "无法确认 Appx 是否正在运行，已停止卸载" } elseif ($running) { "软件正在运行，请先退出后再卸载" } else { "" }
    $item = [ordered]@{
        id = Get-ApplicationId -Kind "appx" -Identity ([PSCustomObject]$identity)
        kind = "appx"
        source = "appx"
        name = $displayName
        description = $name
        publisher = $identity.publisher
        version = $identity.version
        scope = "user"
        enabled = $enabled
        protected = (-not [string]::IsNullOrWhiteSpace($protectedReason))
        running = $running
        knownProcessNames = $knownProcessNames
        reason = $reason
        identity = $identity
    }
    return [PSCustomObject]$item
}

function Get-AppxApplications {
    $items = New-Object 'System.Collections.Generic.List[object]'
    try {
        $packages = @(Get-AppxPackage -ErrorAction Stop)
        foreach ($package in $packages) {
            try { [void]$items.Add((New-AppxApplication -Package $package)) }
            catch { Add-Warning "无法读取 Appx 项目 $([string]$package.Name)" }
        }
    }
    catch {
        Add-Warning "当前用户 Appx 清单不可用：$($_.Exception.Message)"
    }
    return $items.ToArray()
}

function Get-RegistryApplicationForIdentity {
    param(
        [Parameter(Mandatory = $true)]$Identity,
        [switch]$Strict
    )

    $registryPath = Get-ObjectPropertyText -Object $Identity -Name registryPath
    if ([string]::IsNullOrWhiteSpace($registryPath)) { return $null }
    $parts = Get-RegistryParts -RegistryPath $registryPath
    if ($null -eq $parts) { return $null }
    $view = ConvertTo-RegistryView -Name (Get-ObjectPropertyText -Object $Identity -Name registryView)
    $base = $null
    $key = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($parts.Hive, $view)
        $key = $base.OpenSubKey($parts.SubKey)
        if ($null -eq $key) { return $null }
        return New-Win32Application -Key $key -HiveName $parts.HiveName -SubKey $parts.SubKey -ViewName (Get-RegistryViewName -View $view)
    }
    catch {
        if ($Strict) { throw }
        return $null
    }
    finally {
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
}

function Get-AppxApplicationForIdentity {
    param(
        [Parameter(Mandatory = $true)]$Identity,
        [switch]$Strict
    )

    $fullName = Get-ObjectPropertyText -Object $Identity -Name packageFullName
    if ([string]::IsNullOrWhiteSpace($fullName)) { return $null }
    try {
        $matches = @(Get-AppxPackage -ErrorAction Stop | Where-Object { [string]$_.PackageFullName -eq $fullName })
        if ($matches.Count -ne 1) { return $null }
        return New-AppxApplication -Package $matches[0]
    }
    catch {
        if ($Strict) { throw }
        return $null
    }
}

function Compare-Identity {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Current,
        [Parameter(Mandatory = $true)][ValidateSet("win32", "appx")][string]$Kind
    )

    $expectedIdentity = $Expected.identity
    $currentIdentity = $Current.identity
    if ($Kind -eq "appx") {
        return ((Get-ObjectPropertyText -Object $expectedIdentity -Name packageFullName) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name packageFullName) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name publisher) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name publisher) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name version) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name version) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name nonRemovable) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name nonRemovable) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name isPartiallyStaged) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name isPartiallyStaged) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name packageStatus) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name packageStatus) -and
            (Get-ObjectPropertyText -Object $expectedIdentity -Name signatureKind) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name signatureKind))
    }
    return ((Get-ObjectPropertyText -Object $expectedIdentity -Name registryPath) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name registryPath) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name registryView) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name registryView) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name displayName) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name displayName) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name publisher) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name publisher) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name version) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name version) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name productCode) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name productCode) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name msiProductCode) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name msiProductCode) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name uninstallHash) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name uninstallHash) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name uninstallExecutableHash) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name uninstallExecutableHash) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name uninstallExecutableLength) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name uninstallExecutableLength) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name uninstallExecutableLastWriteUtc) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name uninstallExecutableLastWriteUtc) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name systemComponent) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name systemComponent) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name noRemove) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name noRemove) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name releaseType) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name releaseType) -and
        (Get-ObjectPropertyText -Object $expectedIdentity -Name parentKeyName) -eq (Get-ObjectPropertyText -Object $currentIdentity -Name parentKeyName))
}

function New-Result {
    param(
        [string]$Id,
        [string]$Name,
        [ValidateSet("success", "reboot-required", "uac-cancelled", "unknown", "failed", "not-found", "identity-changed", "blocked", "rejected")][string]$Status,
        [string]$Message,
        [AllowNull()][int]$ExitCode
    )

    $result = [ordered]@{ id = $Id; name = $Name; status = $Status; message = $Message }
    if ($PSBoundParameters.ContainsKey("ExitCode")) { $result.exitCode = $ExitCode }
    if ($Status -eq "reboot-required") { $result.rebootRequired = $true }
    return [PSCustomObject]$result
}

function Invoke-Win32Uninstall {
    param(
        [Parameter(Mandatory = $true)]$Application,
        [AllowNull()]$ExpectedIdentity
    )

    $uninstall = $Application.uninstall
    if ($null -eq $uninstall -or [string]::IsNullOrWhiteSpace([string]$uninstall.executable)) {
        return New-Result -Id ([string]$Application.id) -Name ([string]$Application.name) -Status "failed" -Message "没有可执行的官方卸载程序"
    }

    # Compare-Identity runs before this function, but the file can still be
    # replaced between that check and process creation.  Resolve the final
    # executable again and compare it with the frozen preview fingerprint;
    # this narrows the race without claiming to eliminate filesystem TOCTOU.
    $workingDirectory = Resolve-TrustedDirectoryPath -Path (Get-ObjectPropertyText -Object $Application.identity -Name installLocation) -NoCache
    $expected = if ($null -ne $ExpectedIdentity) { $ExpectedIdentity } else { $Application.identity }
    $trustedExecutable = Resolve-TrustedExecutablePath -Path ([string]$uninstall.executable) -NoCache
    if ([string]::IsNullOrWhiteSpace($trustedExecutable) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($trustedExecutable, [string]$uninstall.executable)) {
        return New-Result -Id ([string]$Application.id) -Name ([string]$Application.name) -Status "identity-changed" -Message "启动前无法确认官方卸载程序仍位于预览路径，未执行"
    }
    $fingerprint = Get-FileFingerprint -Path $trustedExecutable -NoCache
    $expectedHash = Get-ObjectPropertyText -Object $expected -Name "uninstallExecutableHash"
    $expectedLength = Get-ObjectPropertyText -Object $expected -Name "uninstallExecutableLength"
    $expectedLastWriteUtc = Get-ObjectPropertyText -Object $expected -Name "uninstallExecutableLastWriteUtc"
    $lengthMatches = $false
    $hashMatches = $false
    $lastWriteMatches = $false
    if ($null -ne $fingerprint) {
        try {
            $lengthMatches = [Int64]$expectedLength -eq [Int64]$fingerprint.Length
        }
        catch { $lengthMatches = $false }
        $hashMatches = [StringComparer]::OrdinalIgnoreCase.Equals($expectedHash, [string]$fingerprint.Hash)
        $lastWriteMatches = $expectedLastWriteUtc -eq [string]$fingerprint.LastWriteUtc
    }
    if ($null -eq $fingerprint -or
        [string]::IsNullOrWhiteSpace($expectedHash) -or
        [string]::IsNullOrWhiteSpace($expectedLastWriteUtc) -or
        -not $hashMatches -or
        -not $lengthMatches -or
        -not $lastWriteMatches) {
        return New-Result -Id ([string]$Application.id) -Name ([string]$Application.name) -Status "identity-changed" -Message "启动前卸载程序文件指纹与预览不一致，未执行"
    }
    try {
        $parameters = @{
            FilePath = $trustedExecutable
            Wait = $true
            PassThru = $true
            ErrorAction = "Stop"
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$uninstall.arguments)) {
            $parameters.ArgumentList = [string]$uninstall.arguments
        }
        if ($workingDirectory) { $parameters.WorkingDirectory = $workingDirectory }
        $process = Start-Process @parameters
        $exitCode = [int]$process.ExitCode
        if ($exitCode -eq 0) {
            # Some vendor launchers return immediately after spawning a child,
            # and some use exit 0 when their own confirmation was cancelled.
            # A second registry read is the only safe success signal we have;
            # keep the result unknown if the original identity is still there.
            try {
                $remaining = Get-RegistryApplicationForIdentity -Identity $Application.identity -Strict
            }
            catch {
                return New-Result -Id $Application.id -Name $Application.name -Status "unknown" -Message "官方卸载程序已退出，但无法重新读取注册表确认结果" -ExitCode $exitCode
            }
            if ($null -ne $remaining) {
                return New-Result -Id $Application.id -Name $Application.name -Status "unknown" -Message "官方卸载程序已退出，但软件仍登记在注册表中；请重新扫描并完成卸载向导" -ExitCode $exitCode
            }
            return New-Result -Id $Application.id -Name $Application.name -Status "success" -Message "官方卸载程序已完成且注册表记录已移除" -ExitCode $exitCode
        }
        if ($exitCode -eq 3010 -or $exitCode -eq 1641) { return New-Result -Id $Application.id -Name $Application.name -Status "reboot-required" -Message "卸载完成，需要重启 Windows" -ExitCode $exitCode }
        if ($exitCode -eq 1223) { return New-Result -Id $Application.id -Name $Application.name -Status "uac-cancelled" -Message "UAC 授权被取消" -ExitCode $exitCode }
        return New-Result -Id $Application.id -Name $Application.name -Status "failed" -Message "官方卸载程序返回错误码 $exitCode" -ExitCode $exitCode
    }
    catch {
        $message = [string]$_.Exception.Message
        if ($message -match '(?i)(cancel|取消|1223)') {
            return New-Result -Id $Application.id -Name $Application.name -Status "uac-cancelled" -Message "UAC 授权被取消"
        }
        return New-Result -Id $Application.id -Name $Application.name -Status "failed" -Message ("启动官方卸载程序失败：" + $message)
    }
}

function Invoke-AppxUninstall {
    param([Parameter(Mandatory = $true)]$Application)

    try {
        Remove-AppxPackage -Package ([string]$Application.identity.packageFullName) -Confirm:$false -ErrorAction Stop
        try {
            $remaining = Get-AppxApplicationForIdentity -Identity $Application.identity -Strict
        }
        catch {
            return New-Result -Id $Application.id -Name $Application.name -Status "unknown" -Message "Appx 移除命令已返回，但无法重新读取当前用户清单"
        }
        if ($null -ne $remaining) {
            return New-Result -Id $Application.id -Name $Application.name -Status "unknown" -Message "Appx 移除命令已返回，但软件仍登记在当前用户清单中；请重新扫描"
        }
        return New-Result -Id $Application.id -Name $Application.name -Status "success" -Message "当前用户 Appx 包已移除"
    }
    catch {
        $message = [string]$_.Exception.Message
        if ($message -match '(?i)(cancel|取消|1223)') {
            return New-Result -Id $Application.id -Name $Application.name -Status "uac-cancelled" -Message "Appx 操作授权被取消"
        }
        return New-Result -Id $Application.id -Name $Application.name -Status "failed" -Message ("移除 Appx 包失败：" + $message)
    }
}

function Invoke-Execute {
    param([Parameter(Mandatory = $true)]$Request)

    if ($null -eq $Request.items -or -not ($Request.items -is [System.Collections.IEnumerable])) {
        throw "execute 请求缺少 items 数组"
    }
    $results = New-Object 'System.Collections.Generic.List[object]'
    $count = 0
    foreach ($selected in @($Request.items)) {
        $count++
        if ($count -gt 100) {
            Add-Warning "一次最多处理 100 个软件项目"
            break
        }
        $id = if ($null -ne $selected.id) { [string]$selected.id } else { "" }
        $kind = if ($null -ne $selected.kind) { [string]$selected.kind } else { "" }
        if ($id -notmatch '^app-[0-9a-f]{24}$' -or $kind -notin @("win32", "appx") -or $null -eq $selected.identity) {
            [void]$results.Add((New-Result -Id $id -Name "" -Status "rejected" -Message "软件身份或 ID 无效"))
            continue
        }
        $identity = $selected.identity
        if ((Get-ApplicationId -Kind $kind -Identity $identity) -ne $id) {
            [void]$results.Add((New-Result -Id $id -Name "" -Status "rejected" -Message "软件 ID 与身份不匹配"))
            continue
        }
        $current = if ($kind -eq "appx") { Get-AppxApplicationForIdentity -Identity $identity } else { Get-RegistryApplicationForIdentity -Identity $identity }
        if ($null -eq $current) {
            [void]$results.Add((New-Result -Id $id -Name "" -Status "not-found" -Message "软件已不存在或无法重新验证"))
            continue
        }
        if (-not (Compare-Identity -Expected ([PSCustomObject]@{ identity = $identity }) -Current $current -Kind $kind)) {
            [void]$results.Add((New-Result -Id $id -Name ([string]$current.name) -Status "identity-changed" -Message "软件身份或官方卸载命令已变化，未执行"))
            continue
        }
        if ([bool]$current.protected -or -not [bool]$current.enabled) {
            [void]$results.Add((New-Result -Id $id -Name ([string]$current.name) -Status "blocked" -Message ([string]$current.reason)))
            continue
        }
        $result = if ($kind -eq "appx") {
            Invoke-AppxUninstall -Application $current
        } else {
            Invoke-Win32Uninstall -Application $current -ExpectedIdentity $identity
        }
        [void]$results.Add($result)
        if ($result.status -eq "unknown") {
            Add-Warning "卸载结果未知，已停止执行剩余选中项目；请先检查 Windows 状态"
            break
        }
    }
    return [PSCustomObject]@{ ok = $true; action = "execute"; results = $results.ToArray(); warnings = $script:Warnings.ToArray() }
}

function Invoke-Query {
    $items = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in @(Get-Win32Applications)) { [void]$items.Add($item) }
    foreach ($item in @(Get-AppxApplications)) { [void]$items.Add($item) }
    return [PSCustomObject]@{ ok = $true; action = "query"; items = $items.ToArray(); warnings = $script:Warnings.ToArray() }
}

function Write-Response {
    param([Parameter(Mandatory = $true)]$Value)

    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

try {
    $inputText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($inputText)) { throw "缺少 JSON 请求" }
    $request = ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
    if ($null -eq $request -or [string]::IsNullOrWhiteSpace([string]$request.action)) { throw "缺少 action" }
    switch ([string]$request.action) {
        "query" {
            Write-Response -Value (Invoke-Query)
            exit 0
        }
        "execute" {
            Write-Response -Value (Invoke-Execute -Request $request)
            exit 0
        }
        default { throw "不支持的 action" }
    }
}
catch {
    $errorResponse = [PSCustomObject]@{
        ok = $false
        error = [ordered]@{ code = "APPLICATIONS_ERROR"; message = ([string]$_.Exception.Message) }
    }
    Write-Response -Value $errorResponse
    exit 1
}
