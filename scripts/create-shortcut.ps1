$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$electronExecutable = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw 'Electron runtime is missing.' }
$shortcutName = [string]::Concat([char]0x661f, [char]0x5e8f, ' starwriting.lnk')
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut((Join-Path $projectDirectory $shortcutName))
$shortcut.TargetPath = $electronExecutable
$shortcut.Arguments = '"' + $projectDirectory + '"'
$shortcut.WorkingDirectory = $projectDirectory
$shortcut.WindowStyle = 1
$shortcut.IconLocation = (Join-Path $projectDirectory 'assets\app-icon.ico') + ',0'
$shortcut.Description = 'starwriting (development)'
$shortcut.Save()
Write-Output (Join-Path $projectDirectory $shortcutName)
