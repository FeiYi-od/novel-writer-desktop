param(
  # Build the portable copy from electron-builder's win-unpacked folder (that output already contains
  # the production node_modules the main bundle requires at runtime) and keep the runnable copy
  # outside the workspace: the workspace tree carries a DENY(DC) ACE that Chromium dislikes.
  [string]$Output = "$env:LOCALAPPDATA\NovelWriterPortable",
  [string]$Zip = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid package version' }
if ([string]::IsNullOrWhiteSpace($Zip)) { $Zip = "release\NovelWriter-$version-portable.zip" }
$build = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NovelWriterBuild\win-unpacked'))
$target = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output))
$zipPath = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Zip))
function Is-Within([string]$Child, [string]$Parent) {
  return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLinkAncestors([string]$EntryPath) {
  $cursor = $EntryPath
  while (-not [string]::IsNullOrEmpty($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked portable paths are not allowed' }
    }
    $parent = [System.IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
# Packaging must never replace an existing runnable copy: old copies may contain
# an author's fixed materials. Leave incomplete attempts for inspection as well.
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $zipPath)) { throw 'Portable output or ZIP already exists; choose new paths. Existing files were preserved.' }
if ((Is-Within $target $build) -or (Is-Within $build $target) -or (Is-Within $zipPath $build) -or (Is-Within $zipPath $target) -or (Is-Within $root $target)) { throw 'Portable source, output, ZIP and workspace paths must not overlap' }
if ([System.IO.Path]::GetExtension($zipPath) -ne '.zip') { throw 'Portable archive must use .zip' }
Assert-NoLinkAncestors $build
Assert-NoLinkAncestors $target
Assert-NoLinkAncestors $zipPath
if (-not (Test-Path -LiteralPath (Join-Path $build '小说编写器.exe') -PathType Leaf)) { throw "Missing packaged build: $build (run pnpm run pack first)" }
if (-not (Test-Path -LiteralPath (Join-Path $build 'resources\app.asar') -PathType Leaf)) { throw 'Packaged app.asar is missing' }
function Assert-BuildTree([string]$Directory) {
  foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked packaged files are not allowed' }
    if ($entry.PSIsContainer) { Assert-BuildTree $entry.FullName }
  }
}
Assert-BuildTree $build
$buildEntries = @(Get-ChildItem -LiteralPath $build -Force)
foreach ($entry in $buildEntries) {
  if ($entry.PSIsContainer -and $entry.Name -notin @('locales', 'resources')) { throw 'Unexpected packaged directory; runtime data must not enter a portable release' }
  if (-not $entry.PSIsContainer -and $entry.Name -notmatch '^(?:小说编写器\.exe|version|[A-Za-z0-9_.-]+\.(?:dll|pak|dat|bin|json)|LICENSE\.electron\.txt|LICENSES\.chromium\.html)$') { throw 'Unexpected packaged file; review the build before release' }
}
foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $build 'resources') -Force) {
  if ($entry.Name -notin @('app.asar', 'app.asar.unpacked', 'default_app.asar', 'elevate.exe', 'protect-upgrade-materials.ps1')) { throw 'Unexpected packaged resource; review the build before release' }
}
if (Test-Path -LiteralPath (Join-Path $build 'locales')) {
  foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $build 'locales') -Force) {
    if ($entry.PSIsContainer -or $entry.Extension -ne '.pak') { throw 'Unexpected packaged locale file' }
  }
}
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($entry in $buildEntries) { Copy-Item -LiteralPath $entry.FullName -Destination $target -Recurse }
Rename-Item -LiteralPath (Join-Path $target '小说编写器.exe') -NewName 'NovelWriter.exe'
$strings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'portable-strings.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$lines = @(
  'Set shell = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'folder = fso.GetParentFolderName(WScript.ScriptFullName)',
  'shell.CurrentDirectory = folder',
  'shell.Run Chr(34) & folder & "\NovelWriter.exe" & Chr(34), 0, False'
)
[System.IO.File]::WriteAllLines((Join-Path $target $strings.launcherName), $lines, [System.Text.Encoding]::ASCII)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $target $strings.readmeName), [string[]]@(
  '便携版说明',
  '1. 双击「启动小说编写器.vbs」启动，不弹出命令窗口。',
  '2. 模型配置和固定创作资料保存在 %APPDATA%\novel-writer；小说文件夹由你在应用中选择。',
  '3. 本包可解压到新目录运行；不要覆盖或删除旧版本旁的创作资料。升级会先保留旧资料并核对。',
  '4. 复制便携包不会自动携带本机模型密钥；固定资料跨机交接请使用应用的同步或完整备份。'
), $utf8NoBom)

$zipParent = Split-Path -Parent $zipPath
if (-not (Test-Path -LiteralPath $zipParent)) { New-Item -ItemType Directory -Path $zipParent -Force | Out-Null }
Compress-Archive -Path (Join-Path $target '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host ("Portable build ready: " + $target)
Write-Host ("Zip: " + $zipPath)
