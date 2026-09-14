# FFF 搜索基准 - 共享运行器
# 用法：
#   .\run-fff-bench.ps1 -Mode off [-RunIndex 1] [-Tag '']
#   .\run-fff-bench.ps1 -Mode on  [-RunIndex 1] [-Tag '']
# 行为：
#   1. 设置 OPENCODE_DISABLE_FFF（off=1 用 ripgrep；on=0 用 fff）
#   2. 在项目目录下执行 opencode run --command fff-bench --auto（非交互）
#   3. 用 Stopwatch 包住整个 opencode run，测端到端墙钟耗时
#   4. 原始输出存 benchmarks/results/fff-<mode>-run-<n>-<stamp>.log
#      计时元数据存 benchmarks/results/fff-<mode>-run-<n>-<stamp>.json
#   5. 返回元数据 hashtable，供编排器汇总
# 说明：workflow DSL 禁用 Date.now()/new Date()，故计时只能在外层完成。

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('on','off')]
    [string]$Mode,

    [int]$RunIndex = 1,

    [string]$Tag = '',

    # opencode 会话目录（fff 按此目录建索引）。缺省=脚本上级目录(sample-project)；
    # 指向 benchmarks\large-target 可测大树（junction 进 thirdparties/opencode/packages）。
    [string]$ProjectDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..') | Select-Object -ExpandProperty Path)
} else {
    $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir | Select-Object -ExpandProperty Path)
}
$ResultsDir = Join-Path $ProjectDir 'benchmarks\results'
# large-target 没有 benchmarks/results，兜底用自身 results 子目录
if (-not (Test-Path (Join-Path $ProjectDir 'benchmarks')) -and (Test-Path (Join-Path $ProjectDir 'results'))) {
    $ResultsDir = Join-Path $ProjectDir 'results'
}
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

# 唯一变量：搜索后端开关
# off -> OPENCODE_DISABLE_FFF=1 -> Flag 为 true -> ripgrep 后端
# on  -> OPENCODE_DISABLE_FFF=0 -> Flag 为 false -> fff 后端（若 Fff.available()）
if ($Mode -eq 'off') {
    $env:OPENCODE_DISABLE_FFF = '1'
} else {
    $env:OPENCODE_DISABLE_FFF = '0'
}
$fffDisabled = $env:OPENCODE_DISABLE_FFF

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile  = Join-Path $ResultsDir "fff-$Mode-run-$RunIndex-$stamp.log"
$errFile  = Join-Path $ResultsDir "fff-$Mode-run-$RunIndex-$stamp.err"
$metaFile = Join-Path $ResultsDir "fff-$Mode-run-$RunIndex-$stamp.json"

Write-Host ""
Write-Host ("==== FFF {0} | OPENCODE_DISABLE_FFF={1} | Run {2} ====" -f $Mode, $fffDisabled, $RunIndex)

# 用 cmd /c 原生重定向，绕开 PS 5.1 对 native stderr 的 NativeCommandError 拦截：
# opencode 会把日志/ANSI 写到 stderr，EAP=Stop + 2>&1 会把它当终止错误中断整个脚本。
# stdout（含 agent 最终打印的 workflow JSON 结果）直接写 logFile；stderr 写 errFile 留查。
$cmdLine = 'opencode run --command fff-bench --auto'

$sw = [System.Diagnostics.Stopwatch]::StartNew()
Push-Location -LiteralPath $ProjectDir
try {
    cmd /c "$cmdLine > `"$logFile`" 2> `"$errFile`""
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
$sw.Stop()

$meta = [ordered]@{
    mode           = $Mode
    fffDisabled    = $fffDisabled
    runIndex       = $RunIndex
    tag            = $Tag
    durationMs     = $sw.ElapsedMilliseconds
    wallClockSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 3)
    exitCode       = $exitCode
    succeeded      = ($exitCode -eq 0)
    timestamp      = $stamp
    logFile        = $logFile
    errFile        = $errFile
    metaFile       = $metaFile
}

$meta | ConvertTo-Json -Depth 5 | Out-File -FilePath $metaFile -Encoding utf8

Write-Host ("完成：{0} ms ({1}s)  exit={2}" -f $sw.ElapsedMilliseconds, $meta.wallClockSeconds, $exitCode)
Write-Host "  log : $logFile"
Write-Host "  meta: $metaFile"

return $meta
