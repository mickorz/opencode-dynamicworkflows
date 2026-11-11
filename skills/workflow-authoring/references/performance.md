# 性能与质量模式手册（速度优先 / 质量优先）

token 消耗不设限时的两条铁律：

1. 墙钟由「串行回合数 × 每回合波次 × 最慢任务」决定——砍串行、压波次就是提速。
2. 质量由并行冗余与验证层决定——多生成几份选优、多 reviewer 评审，并行 fan-out 几乎不加墙钟。

## 一、墙钟模型

一次 run 的墙钟 ≈ Σ 各串行回合墙钟；单回合墙钟 ≈ ceil(任务数 ÷ 并发上限) × 最慢任务耗时。

写脚本前先回答三个问题：

1. **哪些阶段是串行尾？** 去重、汇总、质检、写报告这类只能排队的环节，每砍掉或并行化一个，墙钟少一个回合。
2. **扇出组数是否 ≤ 并发上限？** `setConcurrency` 钳 16；23 组配并发 16 会排成 16+7 两波，压到 16 组以内一波跑完——宁可每组多读点内容。
3. **关键路径是什么？** 找「每个任务都要读的公共大输入」（如需求文档全文），它决定单波最慢任务。公共输入能裁就裁，不能裁就接受并控制组数。

档位与模型、并发的关系（生成前问询的答案落到这里）：

| 档位 | 分析类模型 | 写作类模型 | 并发 | 去重 | 质检 |
|---|---|---|---|---|---|
| 速度优先 | 快模型 | 会话默认 | 16 | 确定性优先 | 跳过或客观 check |
| 质量优先 | 强模型 | 会话默认或用户指定 | 16 | LLM 语义归并 | verify + 有界修正循环 |

## 二、两档清单

### 速度优先 checklist（迭代出稿）

- [ ] 开局 `setConcurrency(16)`；分组数压到 ≤16，避免第二波
- [ ] 大输入 >20KB 按一级章节分片（首尾相接全覆盖），一片一组
- [ ] 分析/对照/枚举类 agent 用快模型；长输出结构化写作保留会话默认模型
- [ ] 统计、编号、排序、格式去重全用 JS 算，不过 LLM；语义归并只在超过阈值（如 15 条）时启用
- [ ] 长报告拆 2~4 片 parallel 写，确定性拼接
- [ ] 写作代理输入瘦身：只给必需字段，P0/P1 全量、长尾抽样
- [ ] 质检默认跳过；必须质检时优先 `check()` 客观校验（行数、ID 连续性）而非 AI 质检
- [ ] 提供 `args.fast` 一键预设全部开关

### 质量优先 checklist（正式交付）

- [ ] 关键产物 best-of-N：N 份 parallel 生成 + `judgePanel` 选优（judges 3~5）
- [ ] 结论过 `verify`（reviewers 3~5，threshold 0.5~0.7，`lens` 分视角反驳）
- [ ] 保留质检回合并加厚：`retry` + `until` 有界修正循环，或「质检失败 -> 修正代理 -> 复检」sequence
- [ ] 不瘦身输入：写作代理拿全量字段，详情全展开
- [ ] 语义去重用 LLM 归并代理（确定性去重只处理精确重复）
- [ ] 关键判断可 `race` 两个模型再评优，或同任务双份交叉验证
- [ ] 分析阶段不降级模型，全强模型贯穿
- [ ] 提供 `args.quality` 一键预设

两档共用同一脚本：`const fast = args.fast === true; const quality = args.quality === true`，分支只影响模型、组数、去重方式、质检开关，流程骨架不变。

## 三、命名模式库（源自 game-prd-check 六次迭代）

### P0 关键路径识别

所有分组代理都要读的公共输入（如 104KB 需求文档）就是瓶颈。先 `log()` 出各阶段输入体量再动刀，不要猜。

### P1 大输入分片

```javascript
phase('扫描')
const groups = await agent(
  `列出规则目录下全部文件的字节数。超过 20KB 的按一级章节拆行号片段
   （sections 含 file/fromLine/toLine/title，片段首尾相接全覆盖），
   小文件按业务主题合并；总组数不超过 16。JSON 返回。`,
  { schema: groupSchema, ...quickOpts },
)
```

片段必须首尾相接覆盖全文——漏一段等于漏检。

### P2 波次控制

```javascript
setConcurrency(A.concurrency || 16)  // 开局就设（问询得到的并发落在这里），别等派发后再调
// 分组阶段硬性约束组数 ≤ 并发；超限就相邻组合并
```

组数控制比单组内容量更重要：第二波意味着整段墙钟翻倍。

### P3 模型分层

```javascript
// quickModel / strongModel 来自生成前问询，用户没指定时写作类用会话默认（不传 model）
const quickOpts = quickModel ? { model: quickModel, timeoutMs: 3600000 } : { timeoutMs: 3600000 }
const strongOpts = strongModel ? { model: strongModel, timeoutMs: 3600000 } : { timeoutMs: 3600000 }
```

判断标准：任务是「对照与枚举」（快模型够）还是「长输出结构完整写作」（保留强模型）。质量档下分析类也可用强模型。

### P4 确定性优先

```javascript
const seen = new Set()
const deduped = issues.filter(i => {
  const key = i.type + '|' + i.location + '|' + i.title.replace(/\s+/g, '').slice(0, 12)
  if (seen.has(key)) return false
  seen.add(key); return true
})
// 少于阈值直接用上面的结果；超过阈值才派 LLM 归并代理处理语义重复
const merged = deduped.length > 15 ? await agent('归并同根因重复项...', quickOpts) : deduped
```

能用 JS 算的统计、编号、排序、精确去重，永远不要过 LLM。LLM 只做「需要理解语义」的判断。

### P5 写作分片并行

```javascript
phase('生成报告')
const [head, detail] = await parallel([
  () => agent(`写报告概览与问题清单分片，数据：${JSON.stringify(listData)}`, { ...strongOpts, agentType: 'general' }),
  () => agent(`写重点详情与总体建议分片，数据：${JSON.stringify(detailData)}`, { ...strongOpts, agentType: 'general' }),
])
```

分片边界要切在数据自然分界处（概览/清单 vs 详情/建议），拼接用确定性命令或 JS。

### P6 输入瘦身（仅速度档）

```javascript
const listData = issues.map(i => ({ id: i.id, theme: i.theme, priority: i.priority, title: i.title, location: i.location }))
const detailData = { p0p1: issues.filter(i => /P0|P1/.test(i.priority)), p2Sample: issues.filter(i => i.priority === 'P2').slice(0, 3) }
```

质量档不做瘦身——全量输入是质量的一部分。

### P7 冗余验证（质量档核心）

```javascript
phase('生成与选优')
const candidates = await parallel([1, 2, 3].map(n => () => agent(`独立生成方案 变体 ${n}`, strongOpts)))
const best = await judgePanel(candidates.filter(Boolean), { judges: 3, rubric: '正确性与完整性' })
const verdict = await verify(best.attempt, { reviewers: 3, threshold: 0.6, lens: ['业务规则', '数据一致性', '可执行性'] })
if (!verdict.real) { /* 走修正循环或明确报告未过 */ }
```

N 份生成 + 选优是并行波，墙钟 ≈ 单份生成时间；质量收益来自「取最好」而非「平均好」。这是 token 不限时最划算的质量投资。

### P8 有界修正循环

```javascript
const report = await retry(
  () => agent('按模板写报告...', { ...strongOpts, agentType: 'general' }),
  { attempts: 3, until: r => r && !/待填写|TODO|占位/.test(r) },
)
```

修正必须有界（attempts ≤ 3），否则失败模式会拖死墙钟。速度档直接跳过这层。

### P9 档位预设开关

```javascript
const fast = A.fast === true
const quality = A.quality === true
const maxGroups = fast ? 16 : 24
const analysisOpts = quality ? strongOpts : quickOpts
const skipReview = fast && A.skipReview !== false
```

一键预设比让调用方记 5 个参数可靠。两档都缺省时落中间档。

### P10 迭代调优用 resume

反复调优时用 `resumeFromRunId`：改了后半段逻辑，前半段未变的 agent 从 journal 回放（零 LLM 调用），只有变更点之后重跑。调优本身也要快。

## 四、什么时候不要优化

- 任务数本来就 ≤ 并发、单任务本来就轻：别上分片，别设档位开关。
- 没实跑过就动刀是猜：先跑一次，看结果里的「子流程耗时」与 journal，找到真正慢的阶段再改。
- 速度档砍掉的质检在正式交付时必须用质量档补回——速度档是迭代反馈用，交付走质量档，不要拿 fast 档产物直接交付。

## 五、引用说明

本手册的模式源自 game-prd-check workflow 的六轮迭代调优，完整设计文档在 PrdGameSkill 仓库：

- 双模式方案设计：`mickorz/PrdGameSkill` 仓库 `dev-docs/design/2026-11-11-workflow-authoring-speed-quality-mode.md`
- 模式来源（game-prd-check 优化全过程）：`mickorz/PrdGameSkill` 仓库 `dev-docs/design/2026-11-10-game-prd-check-workflow-optimization.md`
- workflow 运行时 API：本仓库 [runtime.md](runtime.md)
- workflow 编写规范：本仓库 [SKILL.md](../SKILL.md)
