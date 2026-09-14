# FFF A/B 对比编排器
# 用法：
#   .\run-fff-ab.ps1 [-Runs 3] [-ProjectDir '']
#   默认在 sample-project 上跑；测大树传 -ProjectDir 'benchmarks\large-target'
# 行为：
#   1. 循环 Runs 次：先跑 off(ripgrep) 再跑 on(fff)，交替收集元数据
#   2. 打印对比表（每轮 + 均值 + delta + 提升百分比）
#   3. 把完整对比结果写入 <ProjectDir>/benchmarks/results 或 <ProjectDir>/results 的 ab-summary-<stamp>.json
# 说明：
#   - 每次 opencode run 是独立进程，fff 索引按会话构建（disableMmapCache:true），
#     故跨进程每次均为 cold；若要看 warm 收益，需在同一会话内连续多次跑（v2）。
#   - 唯一变量是 OPENCODE_DISABLE_FFF；同项目/同模型/同 workflow/同 prompt。

param(
    [int]$Runs = 3,

    # opencode 会话目录。缺省=脚本上级目录(sample-project)；测大树传 'benchmarks\large-target'
    [string]$ProjectDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..') | Select-Object -ExpandProperty Path)
} else {
    $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir | Select-Object -ExpandProperty Path)
}
$ResultsDir = Join-Path $ProjectDir 'benchmarks\results'
if (-not (Test-Path (Join-Path $ProjectDir 'benchmarks')) -and (Test-Path (Join-Path $ProjectDir 'results'))) {
    $ResultsDir = Join-Path $ProjectDir 'results'
}
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

$runner = Join-Path $PSScriptRoot 'run-fff-bench.ps1'

$offRuns = @()
$onRuns  = @()

for ($i = 1; $i -le $Runs; $i++) {
    $offRuns += & $runner -Mode off -RunIndex $i -Tag 'ab' -ProjectDir $ProjectDir
    $onRuns  += & $runner -Mode on  -RunIndex $i -Tag 'ab' -ProjectDir $ProjectDir
}

# 汇总
function Get-Durations($arr) { return ($arr | ForEach-Object { $_.durationMs }) }
function Get-Avg($arr) {
    $vals = Get-Durations $arr
    if ($vals.Count -eq 0) { return 0 }
    $sum = ($vals | Measure-Object -Sum).Sum
    return [math]::Round($sum / $vals.Count, 1)
}
function Get-Str($arr, $key) { return ($arr | ForEach-Object { $_.$key }) }

$offAvg = Get-Avg $offRuns
$onAvg  = Get-Avg $onRuns
$delta  = [math]::Round($offAvg - $onAvg, 1)
$improvement = if ($offAvg -gt 0) { [math]::Round($delta / $offAvg * 100, 1) } else { 0 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 控制台对比表
Write-Host ""
Write-Host "================ FFF A/B Summary ================"
$header = "{0,-12} {1,-8} {2,-10} {3,-10} {4,-8}" -f 'Mode', 'Run', 'ms', 'exit', 'note'
Write-Host $header
Write-Host ('-' * $header.Length)
for ($i = 0; $i -lt $Runs; $i++) {
    $ri = $i + 1
    $o = $offRuns[$i]; $n = $onRuns[$i]
    $offNote = if ($ri -eq 1) { 'cold' } else { '' }
    $onNote  = if ($ri -eq 1) { 'cold' } else { '' }
    Write-Host ("{0,-12} {1,-8} {2,-10} {3,-10} {4,-8}" -f 'OFF(rg)', $ri, $o.durationMs, $o.exitCode, $offNote)
    Write-Host ("{0,-12} {1,-8} {2,-10} {3,-10} {4,-8}" -f 'ON(fff)', $ri, $n.durationMs, $n.exitCode, $onNote)
}
Write-Host ('-' * $header.Length)
Write-Host ("OFF(rg) avg : {0} ms" -f $offAvg)
Write-Host ("ON (fff)avg : {0} ms" -f $onAvg)
Write-Host ("delta       : {0} ms  ({1}% faster with FFF ON)" -f $delta, $improvement)
Write-Host "================================================"

# 写 ab-summary.json
$summary = [ordered]@{
    timestamp     = $stamp
    runs          = $Runs
    off = [ordered]@{
        avgMs     = $offAvg
        durations = Get-Str $offRuns 'durationMs'
        exitCodes = Get-Str $offRuns 'exitCode'
        logFiles  = Get-Str $offRuns 'logFile'
    }
    on = [ordered]@{
        avgMs     = $onAvg
        durations = Get-Str $onRuns 'durationMs'
        exitCodes = Get-Str $onRuns 'exitCode'
        logFiles  = Get-Str $onRuns 'logFile'
    }
    deltaMs       = $delta
    improvementPct = $improvement
}
$summaryFile = Join-Path $ResultsDir "ab-summary-$stamp.json"
$summary | ConvertTo-Json -Depth 6 | Out-File -FilePath $summaryFile -Encoding utf8
Write-Host "summary: $summaryFile"
