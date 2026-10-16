# checkpoint 升级 question 工具形态 可行性分析（#35）

> 需求：checkpoint 支持 question 风格的可配置选项对话框（options / multiple / custom），不再用权限对话框
> 结论先行：**可行**。插件无法直接创建官方 Question 对话框（已核实），但主 agent 原生可调 question 工具——用「异步闸门 + journal 回放恢复」桥接，全部依赖已验证

## 一、为什么插件不能直接弹 question（事实核查）

| 通道 | 核查结果 | 证据 |
|------|---------|------|
| HTTP API | 只有 `list / reply / reject`，**无创建端点** | `httpapi/groups/question.ts` |
| SDK | 无任何 question 客户端方法 | `sdk/js/src/gen/sdk.gen.ts` 零匹配 |
| Question 服务 | `ask()` 仅 server 内部调用（内置 question 工具） | `question/index.ts`：publish question.asked 事件后挂 deferred |
| 插件 ToolContext | 只有 `ask`（权限通道，即现方案 A） | `plugin/src/tool.ts:19` |

**但是**：主 agent 的 question 工具是原生能力（build agent 默认 `question: "allow"`），弹的正是官方选项对话框（options/multiple/custom 完整支持）。所以路径是 **agent 中转**。

## 二、方案：异步闸门 + journal 回放恢复

```text
脚本命中 checkpoint(prompt, { options, multiple, custom })
    ↓
workflow 工具不等待，返回 PENDING 结果：
  「run-xxx 在等待人工确认：<prompt/options>。
   请用你的 question 工具向用户提问（参数原样传入），
   作答后调 workflow_control { action: "checkpoint_reply", runId, answers } 续跑」
    ↓（run 已终止，checkpoint 之前的全部 agent 已入 journal）
主 agent 调 question 工具 → 官方选项对话框 → 用户作答
    ↓
主 agent 调 workflow_control { action: "checkpoint_reply", runId, answers }
    ↓（插件把 answers 写入该 checkpoint 的 journal entry.result）
插件内部以 resumeFromRunId 续跑
    ↓
checkpoint 命中 journal 回放 → 返回 answers → 脚本继续执行
```

**关键洞察：不需要新的「暂停原语」**——journal 回放机制天然就是暂停/恢复：run 终止时 checkpoint 之前的调用已全部落 journal；答案写入 checkpoint entry 后续跑，回放返回答案。现有基础设施全部复用。

## 三、DSL 扩展（与官方 Question schema 逐字段对齐）

```javascript
const answer = await checkpoint('发布前确认部署目标', {
  header: '部署目标',                        // 短标签（≤30 字符）
  options: [
    { label: '预发环境', description: '先灰度验证' },
    { label: '生产环境', description: '直接全量' },
  ],
  multiple: false,                           // 多选
  custom: true,                              // 允许自由输入（缺省 true）
})
// answer = ['预发环境']（数组，与官方 Answer 一致）；拒绝 = CHECKPOINT_REJECTED 强停止（现语义不变）
```

## 四、边界与决策

| 场景 | 处理 |
|------|------|
| 无 options 的 checkpoint（现形态） | **保留方案 A 权限弹窗**（allow/deny 二元场景权限对话框更轻）；有 options 才走 question 流程——渐进不破坏 |
| 后台 run 命中 question 型 checkpoint | 无主 agent 在场应答 → 直接取 `default`（现 headless 语义）或 fail，文档写明 |
| Schedule 命中 | 维持现状：无人值守不支持，checkpoint 即败 |
| 用户关闭对话框 | question 工具返回 rejected → checkpoint_reply { rejected: true } → journal 写 false → 续跑回放 → CHECKPOINT_REJECTED 强停止（复用现语义） |
| hash 身份 | options/header/multiple/custom 全部纳入 checkpoint 哈希（改配置 = 重新询问） |
| agent 中转可靠性 | 工具返回的指令即 prompt；PENDING 结果格式固定可解析 + skill 教学；实测主 agent 遵从度足够（历史上它连报错都会自己 grep 源码） |

## 五、影响面与工作量

| 模块 | 改动 |
|------|------|
| runtime checkpoint() | options 扩展入参 + hash + PENDING 返回形态（新 WorkflowError 码或特殊返回） |
| workflow 工具 | PENDING 结果文案（带 question 工具参数模板） |
| workflow_control | 新 action: checkpoint_reply（写 journal + 内部 resume 续跑） |
| journal | checkpoint entry 写入 answers 路径（key 已有） |
| TUI | checkpoint 新状态 pending：「等待人工作答」 |
| skill / 文档 | question 型 checkpoint 教学（双语） |
| 测试 | 单测（DSL/hash/PENDING/reply/拒绝）+ 实机链路 |

**估计 1.5~2 天**（含实机验收）。风险集中在 agent 中转链路的 prompt 遵从度与 checkpoint_reply 的续跑时序，均有测试兜底手段。

## 六、类比理解

官方 question 对话框像酒店客房的电话总机——只有住客（内置工具）能拨通总机。插件（客房服务）想让客人（用户）确认事情，不能直接抢电话，而是留一张字条在门口（PENDING 返回）：「请拨总机 9 号线确认」，客人答完后把结果写在字条背面递回（checkpoint_reply），服务继续。字条就是 journal——不管中间隔多久，续上就能继续。

## 引用说明

- question 工具实现与 Prompt schema：`thirdparties/opencode/packages/opencode/src/tool/question.ts`、`packages/schema/src/v1/question.ts`
- Question 服务 ask/reply/reject 与事件：`packages/opencode/src/question/index.ts`
- HTTP 面仅 list/reply/reject：`packages/opencode/src/server/routes/instance/httpapi/groups/question.ts`
- build agent 默认 question: "allow"：`packages/opencode/src/agent/agent.ts:143`
- 本仓库 journal 回放机制：`src/runtime/workflow-runtime.ts` checkpoint/agentImpl 回放路径（P0-5/P0-10 测试）
