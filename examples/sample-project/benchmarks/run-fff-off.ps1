# FFF 关闭（ripgrep 后端） - 一键包装
# 用法：.\run-fff-off.ps1 [-RunIndex 1]
# 等价：OPENCODE_DISABLE_FFF=1 opencode run --command fff-bench --auto

param([int]$RunIndex = 1, [string]$Tag = '')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'run-fff-bench.ps1') -Mode off -RunIndex $RunIndex -Tag $Tag
