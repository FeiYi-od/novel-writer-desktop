param(
    [Parameter(Mandatory = $true)][string]$SourceInstall,
    [Parameter(Mandatory = $true)][string]$UserData,
    [ValidateRange(0, 2147483647)][int]$AllowProcessId = 0
)

# Windows PowerShell 5 compatible. Keep this file encoded as UTF-8 with BOM.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:MaxFileBytes = [long]67108864
$script:MaxTotalBytes = [long]2147483648
$script:MaxFiles = 50000
$script:MaxDirectories = 50000
$script:MaxDepth = 40
$script:Lock = $null

function Fail([string]$Code, [string]$Message) { throw ($Code + ': ' + $Message) }

function Normalize-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\')) {
        Fail 'UPGRADE_PATH' '目录必须是普通绝对路径。'
    }
    $full = [IO.Path]::GetFullPath($Value)
    if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or $full -match '^[A-Za-z]:[^\\]') { Fail 'UPGRADE_PATH' '目录必须是普通绝对路径。' }
    $root = [IO.Path]::GetPathRoot($full)
    foreach ($component in $full.Substring($root.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) { Assert-Component $component }
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char[]]@('\', '/')) }
    return $full
}

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Within-Path([string]$Candidate, [string]$Parent) {
    return (Same-Path $Candidate $Parent) -or $Candidate.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-Component([string]$Name) {
    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 255 -or $Name -eq '.' -or $Name -eq '..' -or $Name -match '[\x00-\x1f<>:"/\\|?*]' -or $Name.EndsWith('.') -or $Name.EndsWith(' ') -or $Name -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
        Fail 'UPGRADE_PATH' '资料中含有不支持的文件名。'
    }
}

function Assert-NoLinks([string]$Target) {
    $current = Normalize-Path $Target
    while (-not [string]::IsNullOrEmpty($current)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail 'UPGRADE_LINK' '目录或资料含有链接，已停止迁移。'
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-Directory([string]$Target) {
    Assert-NoLinks $Target
    if ((Test-Path -LiteralPath $Target) -and -not [IO.Directory]::Exists($Target)) {
        Fail 'UPGRADE_PATH' '需要目录的位置已存在普通文件。'
    }
}

function Ensure-Directory([string]$Target) {
    Assert-Directory $Target
    [void][IO.Directory]::CreateDirectory($Target)
    Assert-Directory $Target
}

function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Hash-File([string]$Target) {
    Assert-NoLinks $Target
    $stream = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ($stream.Length -gt $script:MaxFileBytes) { Fail 'UPGRADE_LIMIT' '单个资料文件超过64MiB，已停止迁移。' }
        $bytes = $stream.Length
        $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        return [pscustomobject]@{ bytes = $bytes; sha256 = $hash }
    }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-Snapshot([string]$Root) {
    Assert-Directory $Root
    $entries = New-Object 'System.Collections.Generic.List[object]'
    $directories = New-Object 'System.Collections.Generic.List[string]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $pending = New-Object 'System.Collections.Generic.Queue[object]'
    $total = [long]0
    if ([IO.Directory]::Exists($Root)) { $pending.Enqueue([pscustomobject]@{ full = $Root; relative = ''; depth = 0 }) }
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        Assert-Directory $directory.full
        $children = @(Get-ChildItem -LiteralPath $directory.full -Force)
        foreach ($child in $children) {
            Assert-Component $child.Name
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'UPGRADE_LINK' '目录或资料含有链接，已停止迁移。' }
            $relative = if ($directory.relative) { $directory.relative + '/' + $child.Name } else { $child.Name }
            $depth = $directory.depth + 1
            if ($depth -gt $script:MaxDepth -or $relative.Length -gt 4096) { Fail 'UPGRADE_LIMIT' '资料目录层级过深。' }
            if (-not $seen.Add($relative)) { Fail 'UPGRADE_PATH' '资料含有大小写重复路径。' }
            $full = Normalize-Path $child.FullName
            if (-not (Within-Path $full $Root)) { Fail 'UPGRADE_PATH' '资料路径越界，已停止迁移。' }
            Assert-NoLinks $full
            if ($child.PSIsContainer) {
                $directories.Add($relative)
                if ($directories.Count -gt $script:MaxDirectories) { Fail 'UPGRADE_LIMIT' '资料目录数量超限。' }
                $pending.Enqueue([pscustomobject]@{ full = $full; relative = $relative; depth = $depth })
            }
            else {
                $hashed = Hash-File $full
                $total += $hashed.bytes
                if ($total -gt $script:MaxTotalBytes -or $entries.Count -ge $script:MaxFiles) { Fail 'UPGRADE_LIMIT' '资料总大小或文件数量超限。' }
                $entries.Add([pscustomobject][ordered]@{ path = $relative; bytes = $hashed.bytes; sha256 = $hashed.sha256 })
            }
        }
    }
    $entries.Sort([Comparison[object]]{ param($left, $right) [StringComparer]::Ordinal.Compare($left.path, $right.path) })
    $directories.Sort([StringComparer]::Ordinal)
    $sortedEntries = @($entries.ToArray())
    $sortedDirectories = @($directories.ToArray())
    $canonical = [ordered]@{ entries = $sortedEntries; directories = $sortedDirectories }
    $fingerprint = Hash-Bytes ($script:Utf8.GetBytes(($canonical | ConvertTo-Json -Depth 8 -Compress)))
    return [pscustomobject]@{ entries = $sortedEntries; directories = $sortedDirectories; fingerprint = $fingerprint; bytes = $total }
}

function Same-Snapshot($Left, $Right) { return $Left.fingerprint -eq $Right.fingerprint }

function Resolve-Entry([string]$Root, [string]$Relative) {
    $target = Normalize-Path (Join-Path $Root $Relative.Replace('/', '\'))
    if (-not (Within-Path $target $Root) -or (Same-Path $target $Root)) { Fail 'UPGRADE_PATH' '资料路径越界，已停止迁移。' }
    Assert-NoLinks $target
    return $target
}

function Copy-Snapshot([string]$Source, [string]$Destination, $Snapshot) {
    Ensure-Directory $Destination
    foreach ($relative in $Snapshot.directories) { Ensure-Directory (Resolve-Entry $Destination $relative) }
    foreach ($entry in $Snapshot.entries) {
        $from = Resolve-Entry $Source $entry.path
        $to = Resolve-Entry $Destination $entry.path
        Ensure-Directory ([IO.Path]::GetDirectoryName($to))
        $inputStream = [IO.File]::Open($from, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $outputStream = $null
        try {
            if ($inputStream.Length -ne $entry.bytes -or $inputStream.Length -gt $script:MaxFileBytes) { Fail 'UPGRADE_CHANGED' '备份过程中源资料发生变化，请保存退出后重试。' }
            $outputStream = [IO.File]::Open($to, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream.CopyTo($outputStream)
            $outputStream.Flush($true)
        }
        finally { if ($null -ne $outputStream) { $outputStream.Dispose() }; $inputStream.Dispose() }
        $copied = Hash-File $to
        if ($copied.bytes -ne $entry.bytes -or $copied.sha256 -ne $entry.sha256) { Fail 'UPGRADE_CHANGED' '备份内容与源资料不一致，已保留现有文件并停止迁移。' }
    }
    if (-not (Same-Snapshot $Snapshot (Get-Snapshot $Destination))) { Fail 'UPGRADE_CHANGED' '备份清单校验失败，已停止迁移。' }
}

function Write-NewJson([string]$Target, $Value) {
    Assert-NoLinks $Target
    $stream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Read-Receipt([string]$Target) {
    Assert-NoLinks $Target
    if (-not (Test-Path -LiteralPath $Target)) { return $null }
    if (-not [IO.File]::Exists($Target) -or (Get-Item -LiteralPath $Target -Force).Length -gt 1048576) { Fail 'UPGRADE_RECEIPT' '资料升级记录无效，已停止迁移。' }
    try { $receipt = ($script:Utf8.GetString([IO.File]::ReadAllBytes($Target)) | ConvertFrom-Json) }
    catch { Fail 'UPGRADE_RECEIPT' '资料升级记录无法读取，已停止迁移。' }
    if ($null -eq $receipt) { Fail 'UPGRADE_RECEIPT' '资料升级记录无效，已停止迁移。' }
    $properties = @($receipt.PSObject.Properties.Name)
    if ($null -eq $receipt -or -not ($properties -contains 'schemaVersion') -or $receipt.schemaVersion -isnot [int] -or $receipt.schemaVersion -ne 1 -or -not ($properties -contains 'sourceInstall') -or -not ($receipt.sourceInstall -is [string]) -or -not ($properties -contains 'sourceFingerprint') -or $receipt.sourceFingerprint -isnot [string] -or $receipt.sourceFingerprint -notmatch '^[a-f0-9]{64}$' -or -not ($properties -contains 'files') -or $receipt.files -isnot [int] -or $receipt.files -lt 0 -or $receipt.files -gt $script:MaxFiles) {
        Fail 'UPGRADE_RECEIPT' '资料升级记录版本或字段不受支持，已停止迁移。'
    }
    try { $normalized = Normalize-Path $receipt.sourceInstall }
    catch { Fail 'UPGRADE_RECEIPT' '资料升级记录的来源路径无效。' }
    if (-not (Same-Path $normalized $receipt.sourceInstall)) { Fail 'UPGRADE_RECEIPT' '资料升级记录的来源路径无效。' }
    if ($properties -contains 'backupDirectory') {
        if ($receipt.backupDirectory -isnot [string]) { Fail 'UPGRADE_RECEIPT' '资料升级备份记录无效。' }
        $backupPath = Normalize-Path $receipt.backupDirectory
        if (-not (Within-Path $backupPath $script:BackupRoot) -or (Same-Path $backupPath $script:BackupRoot)) { Fail 'UPGRADE_RECEIPT' '资料升级备份路径无效。' }
        Assert-NoLinks $backupPath
    }
    return $receipt
}

function Check-SourceProcess([string]$Install) {
    $executables = @((Normalize-Path (Join-Path $Install '小说编写器.exe')), (Normalize-Path (Join-Path $Install 'NovelWriter.exe')))
    function Is-InstalledExecutable([string]$Candidate) {
        if ([string]::IsNullOrEmpty($Candidate)) { return $false }
        try { $normalizedCandidate = Normalize-Path $Candidate }
        catch { return $false } # Unrelated device/extended paths must not block this installation.
        return (Same-Path $normalizedCandidate $executables[0]) -or (Same-Path $normalizedCandidate $executables[1])
    }
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath -ErrorAction Stop)
    $allowed = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($AllowProcessId -gt 0) {
        $rootProcess = @($processes | Where-Object { [int]$_.ProcessId -eq $AllowProcessId -and (Is-InstalledExecutable $_.ExecutablePath) })
        if ($rootProcess.Count -ne 1) { Fail 'UPGRADE_PROCESS' '启动进程身份无法确认，请保存并退出旧版本后重试。' }
        [void]$allowed.Add($AllowProcessId)
        do {
            $added = $false
            foreach ($process in $processes) {
                if ($allowed.Contains([int]$process.ParentProcessId) -and -not $allowed.Contains([int]$process.ProcessId)) { [void]$allowed.Add([int]$process.ProcessId); $added = $true }
            }
        } while ($added)
    }
    foreach ($process in $processes) {
        if ((Is-InstalledExecutable $process.ExecutablePath) -and -not $allowed.Contains([int]$process.ProcessId)) { Fail 'UPGRADE_PROCESS' '检测到旧版本仍在运行，请先保存并退出后重试。' }
    }
}

function Save-Receipt($Receipt) {
    $temporary = Join-Path $script:DataRoot ('material-upgrade-state.' + [guid]::NewGuid().ToString() + '.tmp')
    Write-NewJson $temporary $Receipt
    Assert-NoLinks $script:StatePath
    if ([IO.File]::Exists($script:StatePath)) {
        $currentHash = Hash-File $script:StatePath
        if ($currentHash.sha256 -ne $script:InitialReceiptHash) { Fail 'UPGRADE_CHANGED' '资料升级记录被其他程序修改，已停止迁移。' }
        $history = Join-Path $script:BackupRoot 'receipts'
        Ensure-Directory $history
        [IO.File]::Move($script:StatePath, (Join-Path $history ([guid]::NewGuid().ToString() + '.json')))
    }
    elseif ($null -ne $script:InitialReceiptHash) { Fail 'UPGRADE_CHANGED' '资料升级记录被其他程序移除，已停止迁移。' }
    [IO.File]::Move($temporary, $script:StatePath)
}

function Output-Result([string]$Status, [int]$Files, [string]$BackupDirectory = '') {
    $value = [ordered]@{ schemaVersion = 1; status = $Status; files = $Files }
    if ($BackupDirectory) { $value.backupDirectory = $BackupDirectory }
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 4 -Compress))
}

try {
    $script:InstallRoot = Normalize-Path $SourceInstall
    $script:DataRoot = Normalize-Path $UserData
    if ((Within-Path $script:InstallRoot $script:DataRoot) -or (Within-Path $script:DataRoot $script:InstallRoot)) { Fail 'UPGRADE_PATH' '安装目录与稳定数据目录不可相互包含。' }
    Assert-Directory $script:InstallRoot
    Assert-Directory $script:DataRoot
    $source = Join-Path $script:InstallRoot '创作资料'
    $stable = Join-Path $script:DataRoot '创作资料'
    $script:BackupRoot = Join-Path $script:DataRoot 'material-upgrade-backups'
    $script:StatePath = Join-Path $script:DataRoot 'material-upgrade-state.json'
    $script:InitialReceiptHash = $null
    $receipt = Read-Receipt $script:StatePath
    if ($null -ne $receipt) { $script:InitialReceiptHash = (Hash-File $script:StatePath).sha256 }
    Assert-Directory $source
    Assert-Directory $stable
    Check-SourceProcess $script:InstallRoot
    if (-not [IO.Directory]::Exists($source)) { Output-Result 'skipped' 0; exit 0 }
    $sourceSnapshot = Get-Snapshot $source
    if ($sourceSnapshot.entries.Count -eq 0) { Output-Result 'skipped' 0; exit 0 }
    Ensure-Directory $script:DataRoot
    $lockPath = Join-Path $script:DataRoot 'material-upgrade.lock'
    Assert-NoLinks $lockPath
    try { $script:Lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { Fail 'UPGRADE_BUSY' '另一个资料升级正在进行，请稍后重试。' }
    # Re-read under the exclusive lock so a concurrent startup cannot leave a stale receipt.
    $receipt = Read-Receipt $script:StatePath
    $script:InitialReceiptHash = if ($null -ne $receipt) { (Hash-File $script:StatePath).sha256 } else { $null }
    $stableSnapshot = Get-Snapshot $stable
    $sameSource = $null -ne $receipt -and (Same-Path $receipt.sourceInstall $script:InstallRoot)
    if ($sameSource -and $receipt.sourceFingerprint -eq $sourceSnapshot.fingerprint -and $stableSnapshot.entries.Count -gt 0) {
        if (-not (Same-Snapshot $sourceSnapshot (Get-Snapshot $source))) { Fail 'UPGRADE_CHANGED' '源资料核对期间发生变化，请稍后重试。' }
        Output-Result 'preserved' $sourceSnapshot.entries.Count
        exit 0
    }
    Ensure-Directory $script:BackupRoot
    $backup = Join-Path $script:BackupRoot ([guid]::NewGuid().ToString())
    Ensure-Directory $backup
    $backupFiles = Join-Path $backup 'files'
    Copy-Snapshot $source $backupFiles $sourceSnapshot
    if (-not (Same-Snapshot $sourceSnapshot (Get-Snapshot $source))) { Fail 'UPGRADE_CHANGED' '备份过程中源资料发生增删或修改，已保留备份并停止迁移。' }
    $manifest = [ordered]@{ schemaVersion = 1; sourceInstall = $script:InstallRoot; sourceFingerprint = $sourceSnapshot.fingerprint; createdAt = [DateTime]::UtcNow.ToString('o'); directories = $sourceSnapshot.directories; entries = $sourceSnapshot.entries }
    Write-NewJson (Join-Path $backup 'manifest.json') $manifest
    if ($sameSource -and $receipt.sourceFingerprint -ne $sourceSnapshot.fingerprint) { Fail 'UPGRADE_CONFLICT' '旧安装目录的资料后来发生变化；新备份已保留，请人工合并，稳定资料未覆盖。' }
    $currentStable = Get-Snapshot $stable
    if (-not (Same-Snapshot $currentStable $stableSnapshot)) { Fail 'UPGRADE_CHANGED' '稳定资料被其他程序修改，已停止迁移。' }
    $status = 'preserved'
    if ($stableSnapshot.entries.Count -eq 0) {
        $stage = Join-Path $script:DataRoot ('material-upgrade-stage-' + [guid]::NewGuid().ToString())
        Copy-Snapshot $backupFiles $stage $sourceSnapshot
        if (-not (Same-Snapshot $sourceSnapshot (Get-Snapshot $source)) -or -not (Same-Snapshot $stableSnapshot (Get-Snapshot $stable))) { Fail 'UPGRADE_CHANGED' '迁移前资料发生变化，已保留备份与暂存文件。' }
        Assert-Directory $stable
        if ([IO.Directory]::Exists($stable)) {
            # An empty file tree may still contain directories. Never recursively delete them.
            if (@(Get-ChildItem -LiteralPath $stable -Force).Count -ne 0) { Fail 'UPGRADE_CONFLICT' '稳定资料目录已有子目录，已保留两侧，请人工核对。' }
            [IO.Directory]::Delete($stable, $false)
        }
        [IO.Directory]::Move($stage, $stable)
        if (-not (Same-Snapshot $sourceSnapshot (Get-Snapshot $stable))) { Fail 'UPGRADE_CHANGED' '迁移后资料校验失败，已保留源资料与备份。' }
        $status = 'imported'
    }
    elseif (-not (Same-Snapshot $sourceSnapshot $stableSnapshot)) { Fail 'UPGRADE_CONFLICT' '稳定目录已有不同资料；两侧与新备份均已保留，请人工合并。' }
    if (-not (Same-Snapshot $sourceSnapshot (Get-Snapshot $source))) { Fail 'UPGRADE_CHANGED' '源资料在迁移期间发生变化，已保留全部文件，请人工核对。' }
    $newReceipt = [ordered]@{ schemaVersion = 1; sourceInstall = $script:InstallRoot; sourceFingerprint = $sourceSnapshot.fingerprint; backupDirectory = $backup; files = $sourceSnapshot.entries.Count }
    Save-Receipt $newReceipt
    Output-Result $status $sourceSnapshot.entries.Count $backup
    exit 0
}
catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^UPGRADE_[A-Z_]+: ') { $message = 'UPGRADE_IO: 资料升级保护未完成，源资料和已创建的备份均保留；请检查文件权限与占用后重试。' }
    [Console]::Error.WriteLine($message)
    exit 1
}
finally { if ($null -ne $script:Lock) { $script:Lock.Dispose() } }
