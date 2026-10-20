param([string]$Task = 'dev')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
# 桌面用例需要真正的 Electron 进程：这个变量一旦存在会把 Electron 当纯 Node 跑。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 允许的任务名直接从 package.json 读，避免 ValidateSet 与脚本清单漂移（新增的桌面用例曾因白名单没更新而跑不到）。
$package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$tasks = @($package.scripts.PSObject.Properties.Name)
if ($tasks -notcontains $Task) {
    Write-Host "未知任务：$Task"
    Write-Host ("可用任务：" + ($tasks -join ', '))
    exit 2
}
$pnpmCommand = Get-Command pnpm.cmd,pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pnpmCommand) {
    & $pnpmCommand.Source run $Task
    exit $LASTEXITCODE
}
# 没有全局 pnpm 时按顺序尝试已知运行时（DSH 运行时优先，其次 codex 运行时）。
$candidates = @(
    @{ Node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'; Pnpm = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' },
    @{ Node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'; Pnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.cjs' }
)
foreach ($candidate in $candidates) {
    if ((Test-Path -LiteralPath $candidate.Node) -and (Test-Path -LiteralPath $candidate.Pnpm)) {
        $env:PATH = (Split-Path -Parent $candidate.Node) + ';' + $env:PATH
        & $candidate.Node $candidate.Pnpm run $Task
        exit $LASTEXITCODE
    }
}
throw 'Please install Node.js and pnpm, then run pnpm install and pnpm dev.'
