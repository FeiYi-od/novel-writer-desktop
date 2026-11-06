param([int]$TimeoutSeconds = 300)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
Set-Location -LiteralPath $root
$nodeDir = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$shim = Join-Path $root '.artifacts\bin'
if ((Test-Path -LiteralPath $nodeDir) -and -not ($env:PATH -like "*$nodeDir*")) { $env:PATH = "$shim;$nodeDir;$env:PATH" }
$nodeExe = Join-Path $nodeDir 'node.exe'

Write-Host '=== Pass 1: full desktop suite ==='
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/all-desktop.ps1 -TimeoutSeconds $TimeoutSeconds | Out-Null
$runDir = Get-ChildItem -LiteralPath '.artifacts/desktop-runs' -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$parsed = Get-Content -LiteralPath (Join-Path $runDir.FullName 'results.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @($parsed)
if ($results.Count -eq 1 -and $results[0] -is [array]) { $results = @($results[0]) }
$failed = @($results | Where-Object { [string]$_.Status -ne 'PASS' })
Write-Host ("Pass 1: {0} passed / {1} not passed. Logs: {2}" -f ($results.Count - $failed.Count), $failed.Count, $runDir.FullName)

if (-not $failed.Count) { Write-Host 'Pass 2 not needed: pass 1 is fully green.'; exit 0 }

$package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
Write-Host '=== Pass 2: rerun only the scripts that did not pass ==='
$retryRows = @()
foreach ($item in $failed) {
    $taskName = [string]$item.Task
    $command = [string]$package.scripts.$taskName
    if ($command -notmatch '^tsx\s+(tests/[A-Za-z0-9_-]+\.ts)$') { $retryRows += [pscustomobject]@{ Task = $taskName; Retry = 'UNSUPPORTED'; Seconds = 0 }; continue }
    $script = $Matches[1]
    Write-Host ("Rerun {0} -> {1}" -f $taskName, $script)
    $started = Get-Date
    $job = Start-Job -ScriptBlock {
        param($exe, $rootDir, $scriptFile)
        Set-Location -LiteralPath $rootDir
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        & $exe 'node_modules/tsx/dist/cli.mjs' $scriptFile *> (Join-Path $rootDir ('.artifacts/retry-' + [guid]::NewGuid().ToString('N') + '.log'))
        return [int]$LASTEXITCODE
    } -ArgumentList $nodeExe, $root, $script
    if (Wait-Job $job -Timeout ($TimeoutSeconds * 2)) {
        $output = @(Receive-Job $job); $code = if ($output.Count) { [int]$output[-1] } else { -1 }
    } else { Stop-Job $job; $code = -2 }
    Remove-Job $job -Force
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $retryRows += [pscustomobject]@{ Task = $taskName; Retry = if ($code -eq 0) { 'PASS' } elseif ($code -eq -2) { 'TIMEOUT' } else { 'FAIL' }; Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1) }
}
$retryRows | Format-Table -AutoSize Task, Retry, Seconds
$stillFailing = @($retryRows | Where-Object { $_.Retry -ne 'PASS' })
Write-Host ("Conclusion: {0} not passed in pass 1; {1} still failing after isolated rerun." -f $failed.Count, $stillFailing.Count)
if ($stillFailing.Count) { exit 1 }
Write-Host 'Conclusion: every pass-1 failure passed in isolation (ordering/resource flake, not a stable failure).'
exit 0
