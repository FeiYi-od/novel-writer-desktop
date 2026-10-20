param(
  # Build the portable copy from electron-builder's win-unpacked folder (that output already contains
  # the production node_modules the main bundle requires at runtime) and keep the runnable copy
  # outside the workspace: the workspace tree carries a DENY(DC) ACE that Chromium dislikes.
  [string]$Output = "$env:LOCALAPPDATA\NovelWriterPortable",
  [string]$Zip = 'release\NovelWriter-0.1.0-portable.zip'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $env:LOCALAPPDATA 'NovelWriterBuild\win-unpacked'
if (-not (Test-Path (Join-Path $build '小说编写器.exe'))) { throw "Missing packaged build: $build (run pnpm run pack first)" }
$strings = Get-Content (Join-Path $PSScriptRoot 'portable-strings.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $build '*') $target -Recurse -Force
Rename-Item (Join-Path $target '小说编写器.exe') 'NovelWriter.exe' -Force

$lines = @(
  'Set shell = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'folder = fso.GetParentFolderName(WScript.ScriptFullName)',
  'shell.CurrentDirectory = folder',
  'shell.Run Chr(34) & folder & "\NovelWriter.exe" & Chr(34), 0, False'
)
[System.IO.File]::WriteAllLines((Join-Path $target $strings.launcherName), $lines, [System.Text.Encoding]::ASCII)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $target $strings.readmeName), [string[]]$strings.readme, $utf8NoBom)

$zipPath = Join-Path $root $Zip
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $target '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host ("Portable build ready: " + $target)
Write-Host ("Zip: " + $zipPath)
