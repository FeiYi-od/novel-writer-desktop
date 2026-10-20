$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$electronExecutable = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw 'Electron runtime is missing.' }
$shortcutName = [string]::Concat([char]0x5c0f, [char]0x8bf4, [char]0x7f16, [char]0x5199, [char]0x5668, '.lnk')
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut((Join-Path $projectDirectory $shortcutName))
$shortcut.TargetPath = $electronExecutable
$shortcut.Arguments = '"' + $projectDirectory + '"'
$shortcut.WorkingDirectory = $projectDirectory
$shortcut.WindowStyle = 1
$shortcut.IconLocation = $electronExecutable + ',0'
$shortcut.Description = 'Novel Writer'
$shortcut.Save()
Write-Output (Join-Path $projectDirectory $shortcutName)
