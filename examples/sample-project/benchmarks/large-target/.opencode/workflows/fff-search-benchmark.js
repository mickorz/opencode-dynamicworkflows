// FFF 文件搜索性能基准 workflow（A/B Test：端到端 Agent 体感性能）
//
// 目的：测量在同一项目/同一模型/同一 Agent 下，OPENCODE_DISABLE_FFF=1(ripgrep)
//      与 =0(fff) 两种搜索后端对 Agent 工作流的耗时差异。
//
// 目标树：src/ 是指向 thirdparties/opencode/packages 的 junction（约 6375 个源码文件），
//        足够大让搜索后端耗时差异从 LLM 噪声里显出来。
//
// 设计要点：
//   - 单 agent 连续执行 20 次原生 glob/grep，减少多 agent 各自 LLM 预热的方差，
//     让搜索后端耗时在总时长中累积到可观测量级。
//   - glob 与 grep 都显式传 path="src"：让 cwd 解析进 junction 内部，
//     保证 ripgrep 与 fff 两路都真正遍历 junction（从项目根 glob src/** 时 rg 会跳过 reparse point）。
//   - 每个 pattern 显式，保证 A/B 两路 agent 行为一致，唯一变量是后端开关。
//   - 计时在外层 PowerShell 包装脚本完成（脚本沙箱禁用非确定性时间/随机 API）。
//   - 返回结构化 JSON：每条查询的命中数与前 5 个路径，供 A/B 正确性比对。

export const meta = {
  name: 'fff_search_benchmark',
  description: 'FFF 文件搜索性能基准：单 agent 连续 20 次原生 glob/grep（src/ 大树，path=src），返回每条命中数与前 5 路径',
}

phase('Mass Search')

const result = await agent(
  `这是 OpenCode 文件搜索性能基准测试（FFF A/B Test）。目标树是当前项目的 src/ 子目录（一个 junction，含约 6375 个源码文件）。

【强制规则】
1. 只能使用 OpenCode 原生文件搜索工具：glob 与 grep（以及 read）。
2. 禁止使用 Bash、PowerShell、终端或任何 shell。
3. 禁止直接或间接执行 rg、ripgrep、find、fd、python 等外部命令。
4. 禁止修改、创建、删除任何文件。
5. 不要分析、解释、评论搜索结果。
6. 依次执行下面全部 20 个搜索任务，每个任务都要真正调用一次对应的原生工具。
7. glob 任务用 glob 工具：pattern 按下表，并显式传 path 参数为 "src"（限定在 src 子目录内搜索）。
8. grep 任务用 grep 工具：pattern 按下表，并显式传 path 参数为 "src"。

【搜索任务清单】
文件路径搜索（用 glob 工具，pattern 列即传给 glob 的 pattern，path 参数固定为 "src"）：
  id=1  pattern="**/*agent*"
  id=2  pattern="**/*workflow*"
  id=3  pattern="**/*config*"
  id=4  pattern="**/*permission*"
  id=5  pattern="**/*runtime*"
  id=6  pattern="**/*session*"
  id=7  pattern="**/*plugin*"
  id=8  pattern="**/*tool*"
  id=9  pattern="**/*schema*"
  id=10 pattern="**/*adapter*"

内容搜索（用 grep 工具，pattern 列即传给 grep 的 pattern，path 参数固定为 "src"）：
  id=11 pattern="agent("
  id=12 pattern="phase("
  id=13 pattern="parallel("
  id=14 pattern="permission"
  id=15 pattern="workflow"
  id=16 pattern="schema"
  id=17 pattern="runtime"
  id=18 pattern="session"
  id=19 pattern="plugin"
  id=20 pattern="tool"

【返回格式】严格只输出如下 JSON 对象，不要任何额外文字、代码围栏或解释：
{
  "queries": 20,
  "results": [
    { "id": 1, "kind": "glob", "pattern": "**/*agent*", "hits": <命中数量，整数>, "sample": ["前5个文件路径"] },
    { "id": 2, "kind": "glob", "pattern": "**/*workflow*", "hits": <n>, "sample": ["..."] },
    { "id": 3, "kind": "glob", "pattern": "**/*config*", "hits": <n>, "sample": ["..."] },
    { "id": 4, "kind": "glob", "pattern": "**/*permission*", "hits": <n>, "sample": ["..."] },
    { "id": 5, "kind": "glob", "pattern": "**/*runtime*", "hits": <n>, "sample": ["..."] },
    { "id": 6, "kind": "glob", "pattern": "**/*session*", "hits": <n>, "sample": ["..."] },
    { "id": 7, "kind": "glob", "pattern": "**/*plugin*", "hits": <n>, "sample": ["..."] },
    { "id": 8, "kind": "glob", "pattern": "**/*tool*", "hits": <n>, "sample": ["..."] },
    { "id": 9, "kind": "glob", "pattern": "**/*schema*", "hits": <n>, "sample": ["..."] },
    { "id": 10, "kind": "glob", "pattern": "**/*adapter*", "hits": <n>, "sample": ["..."] },
    { "id": 11, "kind": "grep", "pattern": "agent(", "hits": <n>, "sample": ["..."] },
    { "id": 12, "kind": "grep", "pattern": "phase(", "hits": <n>, "sample": ["..."] },
    { "id": 13, "kind": "grep", "pattern": "parallel(", "hits": <n>, "sample": ["..."] },
    { "id": 14, "kind": "grep", "pattern": "permission", "hits": <n>, "sample": ["..."] },
    { "id": 15, "kind": "grep", "pattern": "workflow", "hits": <n>, "sample": ["..."] },
    { "id": 16, "kind": "grep", "pattern": "schema", "hits": <n>, "sample": ["..."] },
    { "id": 17, "kind": "grep", "pattern": "runtime", "hits": <n>, "sample": ["..."] },
    { "id": 18, "kind": "grep", "pattern": "session", "hits": <n>, "sample": ["..."] },
    { "id": 19, "kind": "grep", "pattern": "plugin", "hits": <n>, "sample": ["..."] },
    { "id": 20, "kind": "grep", "pattern": "tool", "hits": <n>, "sample": ["..."] }
  ]
}`,
  {
    label: 'FFF 搜索基准 20 连测 src 大树',
    schema: {
      type: 'object',
      properties: {
        queries: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              kind: { type: 'string' },
              pattern: { type: 'string' },
              hits: { type: 'number' },
              sample: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'kind', 'pattern', 'hits', 'sample'],
          },
        },
      },
      required: ['queries', 'results'],
    },
  },
)

return JSON.stringify(result, null, 2)
