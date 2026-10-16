/**
 * P4-B 候选生成器（单一场景：script-extraction）
 *
 * 类头流程图：
 *
 *  OptimizationJob（aggregated，目标 Workflow 已溯源）
 *        |
 *        v
 *  generateOptimizationPlan
 *    1 读原版脚本并校验 sha256 == targetWorkflowHash（基线）
 *    2 定位目标 Agent 调用（确定性：按 suggestedTarget 文件名
 *      在脚本中做括号配对扫描提取 agent(...) 调用文本）
 *    3 歧义检查：同名文件出现在多个调用 -> 拒绝自动 Patch 转人工
 *        |
 *        v
 *  生成两份产物（原文件不动，写入 candidates/<fp>/）
 *    固化工具：occurrence.sourceScript 原样提取
 *    候选 Workflow：目标调用 prompt 收窄（narrow-scope，
 *      不改调用结构，避免 agentCount 破坏）
 *        |
 *        v
 *  候选合法性确定性校验
 *    parseWorkflowScript 语法通过
 *    agent/checkpoint 调用数 >= 1（Runtime 约束，4.0.2）
 *    固化工具引用路径在候选脚本中出现
 *        |
 *        v
 *  写 optimization-plan.json + candidate.js + solidified-tool.<ext>
 *    返回 OptimizationPlan（targetNodes 三方绑定：源码片段 + callIndex + hash）
 *
 * 约束（P4 执行文档 4.2）：
 *  - 原文件不动，候选写隔离目录
 *  - 第一版仅 script-extraction；prompt 收窄为确定性文本变换（无 LLM）
 *  - 防递归由 Runtime 启动参数承担（验证执行不带 development），本模块不管
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, basename, extname } from "node:path"
import { parseWorkflowScript } from "../runtime/vm.js"
import { sha256Text } from "./workflow-source.js"
import type { AggregatedCandidate } from "./aggregator.js"
import type { OptimizationJob } from "./optimization-job.js"

/** 目标 Agent 节点定位（P0 补充契约：三方绑定） */
export interface TargetNode {
  /** Agent 调用在原脚本中的唯一语句片段（锚定，应用前校验） */
  callSnippet: string
  /** 脚本内 agent/checkpoint 调用序（0 起） */
  callIndex: number
  phase: string
  label: string
  /** 该调用赋值的变量名（A/B 结果对比时剔除此键：被替换节点的输出必然变化） */
  resultKey?: string
  changeType: "replace-with-tool" | "narrow-scope" | "add-pre-check"
  description: string
  inputContract: string
  outputContract: string
}

export interface OptimizationPlan {
  /** 触发此计划的聚合候选 */
  fingerprint: string
  optimizationId: string
  /** 原版 Workflow 脚本路径 */
  originalScriptPath: string
  /** 原版脚本 sha256（应用前基线） */
  originalScriptHash: string
  /** 需要修改的 Agent 节点（三方绑定） */
  targetNodes: TargetNode[]
  /** 固化工具信息 */
  solidifiedTool: {
    toolPath: string
    toolContent: string
    /** 部署到原项目的相对路径（tools/<原名>，A/B worktree 部署与应用都用它） */
    deployRelPath: string
    parameterized: boolean
    hasFunctionWrapper: boolean
  }
  /** 候选 Workflow 脚本路径 */
  candidateScriptPath: string
  /** 候选脚本 sha256 */
  candidateScriptHash: string
  /** 预期改进 */
  expectedImprovement: string
  /** 确定性验证命令对（A/B 各自执行，stdout 对比 = 功能等价闸门的确定性对比物） */
  deterministicCheck?: {
    /** A 侧命令（原版：临时脚本路径） */
    originalCommand: string
    /** B 侧命令（候选：固化工具路径） */
    candidateCommand: string
  }
  /** 验证计划（A/B 关键产物清单，P4-C 消费） */
  validationPlan: string
}

export class CandidateGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CandidateGenerationError"
  }
}

/**
 * 从脚本文本提取第 index 个 agent(/checkpoint( 调用的完整实参文本（括号配对扫描）。
 * 返回 null 表示不存在。忽略注释行。
 */
export function extractCallAt(script: string, index: number): { text: string; start: number } | null {
  const callRe = /\b(?:await\s+)?(agent|checkpoint)\s*\(/g
  let seen = -1
  let m: RegExpExecArray | null
  while ((m = callRe.exec(script)) !== null) {
    seen += 1
    if (seen !== index) continue
    // 从 '(' 开始做括号配对（字符串感知：跳过引号内容）
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    let quote: string | null = null
    while (i < script.length) {
      const ch = script[i]
      if (quote) {
        if (ch === "\\") i += 1 // 转义字符跳过
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch
      } else if (ch === "(") depth += 1
      else if (ch === ")") {
        depth -= 1
        if (depth === 0) {
          return { text: script.slice(m.index, i + 1), start: m.index }
        }
      }
      i += 1
    }
    return null // 括号不闭合（语法错误，上层 parse 会拦）
  }
  return null
}

/** 统计脚本中 agent(/checkpoint( 调用次数（与 Runtime 的 agentCount 同口径近似） */
export function countDispatchCalls(script: string): number {
  const matches = script.match(/\b(await\s+)?(agent|checkpoint)\s*\(/g)
  return matches ? matches.length : 0
}

/** 从调用文本提取 label（opts 里的 label 字段） */
function extractLabel(callText: string): string {
  const m = /label:\s*"([^"]*)"/.exec(callText)
  return m ? m[1] : "(未命名)"
}

/** 提取调用的赋值变量名：const X = await agent(...) -> X（无赋值返回 undefined） */
function extractResultKey(script: string, callStart: number): string | undefined {
  const m = /(?:const|let|var)\s+(\w+)\s*=\s*$/.exec(script.slice(0, callStart).split("\n").pop() ?? "")
  return m?.[1]
}

/** 从调用位置向上找最近的 phase("...") 标题 */
function extractPhase(script: string, callStart: number): string {
  const before = script.slice(0, callStart)
  const matches = [...before.matchAll(/phase\(\s*"([^"]+)"\s*\)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : "(根)"
}

/** prompt 是否为"创建/写脚本"指令（含 write 指令 + 目标文件名） */
function isWriteScriptCall(callText: string, fileName: string): boolean {
  const lower = callText.toLowerCase()
  return (
    lower.includes("write") || lower.includes("创建") || lower.includes("写入") || lower.includes("生成文件")
  ) && callText.includes(fileName)
}

/** prompt 是否为"执行脚本"指令（bash 执行目标文件） */
function isExecuteScriptCall(callText: string, fileName: string): boolean {
  const lower = callText.toLowerCase()
  return (lower.includes("bash") || lower.includes("运行") || lower.includes("执行")) && callText.includes(fileName)
}

/**
 * 生成固化工具内容与参数化状态（第一版：原样提取 + 状态记录）
 */
function buildSolidifiedTool(sourceScript: string, suggestedTarget: string): {
  toolContent: string
  parameterized: boolean
  hasFunctionWrapper: boolean
} {
  const usesArgv = sourceScript.includes("sys.argv") || sourceScript.includes("process.argv")
  const hasFunction = /\bdef \w+\(/.test(sourceScript) || /\bfunction \w+\(/.test(sourceScript)
  return {
    toolContent: sourceScript,
    parameterized: usesArgv,
    hasFunctionWrapper: hasFunction,
  }
}

/** 改动描述（4.2.2：基于脚本实际代码，非固定模板） */
function generateChangeDescription(tool: { parameterized: boolean; hasFunctionWrapper: boolean }, fileName: string): string {
  const parts: string[] = [`将 ${fileName} 固化为独立工具`]
  if (tool.parameterized && tool.hasFunctionWrapper) parts.push("已有参数化和函数封装，直接提取为可复用工具")
  else if (tool.parameterized) parts.push("已有参数化，补充函数封装后提取")
  else parts.push("需补充参数化（当前硬编码路径）")
  parts.push("收窄原 Workflow 中写脚本节点的职责，改为校验固化工具")
  return parts.join("，")
}

export interface GenerateInput {
  candidate: AggregatedCandidate
  job: OptimizationJob
  /** <项目>/.opencode-workflows（产物写 candidates/） */
  workflowsDir: string
  /** 固化工具部署到原项目的相对路径（默认 tools/<原文件名>） */
  solidifiedToolRelPath?: string
}

/**
 * 生成 OptimizationPlan 与两份产物。
 * 抛 CandidateGenerationError 表示不可自动生成（歧义/语法/基线不符），Job 应转人工或 failed。
 */
export function generateOptimizationPlan(input: GenerateInput): OptimizationPlan {
  const { candidate, job } = input
  if (candidate.category !== "script-extraction") {
    throw new CandidateGenerationError(`第一版仅支持 script-extraction，收到 ${candidate.category}`)
  }

  // 1. 原版基线校验
  if (!existsSync(job.targetWorkflowPath)) {
    throw new CandidateGenerationError(`原版脚本不存在：${job.targetWorkflowPath}`)
  }
  const originalScript = readFileSync(job.targetWorkflowPath, "utf8")
  const originalHash = sha256Text(originalScript)
  if (originalHash !== job.targetWorkflowHash) {
    throw new CandidateGenerationError("原版脚本哈希与 Job 基线不符（文件已被修改），拒绝生成候选")
  }

  // 2. 目标文件名与固化路径（定位用裸文件名：suggestedTarget 可能是绝对路径，脚本内引用的是文件名）
  const latest = candidate.occurrences[candidate.occurrences.length - 1]
  const fileName = basename(latest.suggestedTarget ?? "tool.py")
  if (!latest.sourceScript) {
    throw new CandidateGenerationError("occurrence 无 sourceScript，无法固化")
  }
  const toolRel = input.solidifiedToolRelPath ?? `tools/${fileName}`
  const toolExt = extname(fileName) || ".py"

  // 3. 定位引用该文件名的全部 agent 调用（含 write/execute 指令特征）
  const total = countDispatchCalls(originalScript)
  const hits: Array<{ callIndex: number; text: string; start: number; kind: "write" | "execute" }> = []
  for (let i = 0; i < total; i++) {
    const call = extractCallAt(originalScript, i)
    if (!call) continue
    if (!call.text.includes(fileName)) continue
    if (isWriteScriptCall(call.text, fileName)) hits.push({ callIndex: i, text: call.text, start: call.start, kind: "write" })
    else if (isExecuteScriptCall(call.text, fileName)) hits.push({ callIndex: i, text: call.text, start: call.start, kind: "execute" })
  }
  const writeHits = hits.filter((h) => h.kind === "write")
  if (writeHits.length === 0) {
    throw new CandidateGenerationError(`未定位到创建 ${fileName} 的 Agent 调用（prompt 特征不匹配），转人工`)
  }
  if (writeHits.length > 1) {
    throw new CandidateGenerationError(`创建 ${fileName} 的 Agent 调用存在 ${writeHits.length} 处歧义，禁止自动 Patch，转人工`)
  }

  // 4. 生成固化工具
  const tool = buildSolidifiedTool(latest.sourceScript, fileName)

  // 从执行节点提取实际命令（含真实输入文件），供收窄 prompt 复用
  const executeHit = hits.find((h) => h.kind === "execute")
  const actualCommand = extractRunCommand(executeHit?.text ?? "", fileName, toolRel)

  // 5. 生成候选脚本（确定性文本变换）
  let candidateScript = originalScript
  const targetNodes: TargetNode[] = []
  for (const hit of hits) {
    const label = extractLabel(hit.text)
    const phase = extractPhase(originalScript, hit.start)
    const resultKey = extractResultKey(originalScript, hit.start)
    if (hit.kind === "write") {
      // 替换为零 token 确定性检查（4.2.1 replace-with-tool）：
      //   const X = await agent(...) -> const X = await check(() => commandSuccess(cmd), ...)
      // 赋值前缀在 hit.text 之外自然保留（await 结构不变，语法完整）；
      // dispatch 数减一但脚本其余 Agent 仍在（替换后 <1 则拒绝，4.0.2）。
      const command = actualCommand ?? runCommand(toolRel, fileName)
      const replacement =
        `await check(() => commandSuccess(${JSON.stringify(command)}), ` +
        `"固化工具可用性检查（原为重复编写脚本）")`
      candidateScript = candidateScript.replace(hit.text, replacement)
      targetNodes.push({
        callSnippet: hit.text.slice(0, 120),
        callIndex: hit.callIndex,
        phase,
        label,
        resultKey,
        changeType: "replace-with-tool",
        description: generateChangeDescription(tool, fileName) + "，原 Agent 调用替换为确定性 check（零 token）",
        inputContract: "无（原为创建临时脚本）",
        outputContract: "commandSuccess 布尔结果（固化工具可运行且退出码 0）",
      })
    } else {
      // 执行节点：路径从临时文件改为固化工具路径
      const replaced = hit.text.split(fileName).join(toolRel)
      candidateScript = candidateScript.replace(hit.text, replaced)
      targetNodes.push({
        callSnippet: hit.text.slice(0, 120),
        callIndex: hit.callIndex,
        phase,
        label,
        resultKey,
        changeType: "narrow-scope",
        description: `执行路径从临时 ${fileName} 改为固化工具 ${toolRel}`,
        inputContract: "业务输入文件路径",
        outputContract: "脚本执行输出",
      })
    }
  }
  if (candidateScript === originalScript) {
    throw new CandidateGenerationError("候选脚本与原版相同（无有效变换），拒绝生成")
  }

  // 6. 候选合法性确定性校验（4.2.3）
  try {
    parseWorkflowScript(candidateScript)
  } catch (e) {
    throw new CandidateGenerationError(`候选脚本语法校验失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const dispatchCount = countDispatchCalls(candidateScript)
  if (dispatchCount < 1) {
    throw new CandidateGenerationError("候选 Workflow 无 Agent/Checkpoint 调用（Runtime 拒绝，4.0.2 约束）")
  }
  if (!candidateScript.includes(toolRel)) {
    throw new CandidateGenerationError("候选脚本未引用固化工具路径，变换不完整")
  }

  // 7. 产物落盘（原文件不动）
  const outDir = join(input.workflowsDir, "candidates", candidate.fingerprint.slice(0, 8))
  mkdirSync(outDir, { recursive: true })
  const toolPath = join(outDir, `solidified-tool${toolExt}`)
  const candidateScriptPath = join(outDir, "candidate.js")
  writeFileSync(toolPath, tool.toolContent, "utf8")
  writeFileSync(candidateScriptPath, candidateScript, "utf8")
  const candidateScriptHash = sha256Text(candidateScript)

  const plan: OptimizationPlan = {
    fingerprint: candidate.fingerprint,
    optimizationId: job.optimizationId,
    originalScriptPath: job.targetWorkflowPath,
    originalScriptHash: originalHash,
    targetNodes,
    solidifiedTool: {
      toolPath,
      toolContent: tool.toolContent,
      deployRelPath: toolRel,
      parameterized: tool.parameterized,
      hasFunctionWrapper: tool.hasFunctionWrapper,
    },
    candidateScriptPath,
    candidateScriptHash,
    expectedImprovement: `消除每次 Run 重复编写 ${fileName} 的 Agent 调用（${candidate.occurrenceCount} 次 occurrence，${candidate.distinctRunCount} 个独立 Run）`,
    deterministicCheck: actualCommand
      ? {
          candidateCommand: actualCommand,
          originalCommand: actualCommand.split(toolRel).join(fileName),
        }
      : undefined,
    validationPlan: `双 worktree A/B：原版与候选各执行一次，对比固化命令 stdout 一致性、token 与耗时`,
  }
  writeFileSync(join(outDir, "optimization-plan.json"), JSON.stringify(plan, null, 2), "utf8")
  return plan
}

/** 固化工具的运行命令（按扩展名选解释器，无法从执行节点提取时的兑底） */
function runCommand(toolRel: string, _fileName: string): string {
  if (toolRel.endsWith(".py")) return `python ${toolRel} <输入文件>`
  if (toolRel.endsWith(".js")) return `node ${toolRel} <输入文件>`
  return toolRel
}

/** 从执行节点 prompt 提取 `python <file> <args>` 形式的实际命令，并把文件名替换为固化路径 */
function extractRunCommand(executeCallText: string, fileName: string, toolRel: string): string | null {
  // 注意：模板字符串里反斜杠需双写（\\s），单写会被转义处理吃掉导致正则失效
  const re = new RegExp(
    `(?:python3|python|node|bash|sh)\\s+\\S*${escapeRegExp(fileName)}\\S*(?:\\s+\\S+)*`,
    "i",
  )
  const m = re.exec(executeCallText)
  if (!m) return null
  // 截断命令后的中文说明（"，报告输出内容"等），只保留命令本体
  const line = m[0]
    .split(/[，。;；\n]/)[0]
    .replace(/["',]/g, "")
    .trim()
  return line.split(fileName).join(toolRel)
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
