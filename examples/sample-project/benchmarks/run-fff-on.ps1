# FFF 开启（fff 后端） - 一键包装
# 用法：.\run-fff-on.ps1 [-RunIndex 1]
# 等价：OPENCODE_DISABLE_FFF=0 opencode run --command fff-bench --auto

param([int]$RunIndex = 1, [string]$Tag = '')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'run-fff-bench.ps1') -Mode on -RunIndex $RunIndex -Tag $Tag
