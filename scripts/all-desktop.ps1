param([int]$TimeoutSeconds = 240, [string[]]$Tasks = @())
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
Set-Location -LiteralPath $taskRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskPackage = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$taskScripts = @($taskPackage.scripts.PSObject.Properties | Where-Object { $_.Name -like 'test:*desktop' })
if ($Tasks.Count) {
    $taskUnknown = @($Tasks | Where-Object { $_ -notin $taskScripts.Name })
    if ($taskUnknown.Count) { throw "Unknown desktop tasks: $($taskUnknown -join ', ')" }
    $taskScripts = @($taskScripts | Where-Object { $_.Name -in $Tasks })
}
$taskRun = Join-Path $taskRoot ('.artifacts/desktop-runs/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRun -Force | Out-Null
$taskResults = @()
foreach ($taskScript in $taskScripts) {
    if ($taskScript.Value -notmatch '^tsx\s+(tests/[A-Za-z0-9_-]+\.ts)$') { throw "Unsupported desktop command: $($taskScript.Name)" }
    $taskFile = $Matches[1]
    $taskStarted = Get-Date
    $taskLog = Join-Path $taskRun (($taskScript.Name -replace '[:\\/]', '-') + '.log')
    $taskPidFile = $taskLog + '.pid'
    $taskJob = Start-Job -ScriptBlock {
        param($nodeExe, $root, $script, $logFile, $pidFile)
        Set-Location -LiteralPath $root
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($pidFile, [string]$PID)
        & $nodeExe 'node_modules/tsx/dist/cli.mjs' $script *> $logFile
        return [int]$LASTEXITCODE
    } -ArgumentList $taskNode, $taskRoot, $taskFile, $taskLog, $taskPidFile
    if (Wait-Job $taskJob -Timeout $TimeoutSeconds) {
        $taskOutput = @(Receive-Job $taskJob)
        $taskCode = if ($taskOutput.Count) { $taskOutput[-1] } else { -1 }
        $taskStatus = if ($taskCode -eq 0) { 'PASS' } else { 'FAIL' }
    } else {
        # Terminate descendants of this owned test job only; preserve other apps and artifacts.
        if (Test-Path -LiteralPath $taskPidFile) {
            $taskOwnedPid = [int](Get-Content -LiteralPath $taskPidFile -Raw)
            $taskProcesses = @(Get-CimInstance Win32_Process)
            $taskQueue = [Collections.Generic.List[int]]::new(); $taskQueue.Add($taskOwnedPid)
            for ($taskIndex = 0; $taskIndex -lt $taskQueue.Count; $taskIndex++) {
                foreach ($taskChild in @($taskProcesses | Where-Object { $_.ParentProcessId -eq $taskQueue[$taskIndex] })) { $taskQueue.Add([int]$taskChild.ProcessId) }
            }
            for ($taskIndex = $taskQueue.Count - 1; $taskIndex -ge 1; $taskIndex--) { Stop-Process -Id $taskQueue[$taskIndex] -Force -ErrorAction SilentlyContinue }
        }
        Stop-Job $taskJob
        $taskStatus = 'TIMEOUT'; $taskCode = -2
    }
    Remove-Job $taskJob -Force
    $taskTail = if (Test-Path -LiteralPath $taskLog) { ((Get-Content -LiteralPath $taskLog -Tail 4) -join ' ').Trim() } else { '' }
    $taskResults += [pscustomobject]@{ Task = $taskScript.Name; Status = $taskStatus; Code = $taskCode; Seconds = [math]::Round(((Get-Date) - $taskStarted).TotalSeconds, 1); Log = $taskLog; Tail = $taskTail }
    $taskResults[-1] | Select-Object Task, Status, Seconds | Format-Table -HideTableHeaders
    $taskResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRun 'results.json') -Encoding UTF8
}
$taskFailed = @($taskResults | Where-Object { $_.Status -ne 'PASS' })
Write-Host ("Desktop scripts: {0} passed / {1} failed. Logs: {2}" -f ($taskResults.Count - $taskFailed.Count), $taskFailed.Count, $taskRun)
if ($taskFailed.Count) { $taskFailed | Format-Table -AutoSize Task, Status, Code, Tail; exit 1 }
exit 0
