**You:**

https://www.npmjs.com/package/@mickorz/opencode-dynamic-workflows 看一下我这个项目的月下载量怎么样

* * *

**ChatGPT:**

你说得对，**现在最新版本是 0.9.0**。刚才我说 `0.2.2` 是我查错了。

原因是我拿到的是 **搜索引擎缓存的 npm 页面**。这个缓存页面显示的是：

* Version：`0.2.2`
* Last publish：21 hours ago
* 6 Versions

但你截图里的 npm 实时页面已经是：

* **Version：0.9.0**
* **21 Versions**
* **Weekly Downloads：1,301**
* Last publish：**7 minutes ago**

也就是说，你最近版本迭代很快，而搜索索引明显还停留在旧版本。 [npm](https://www.npmjs.com/package/%40mickorz/opencode-dynamic-workflows?utm_source=chatgpt.com)

所以后面分析你的下载量时，**应该以你截图里的 npm 实时数据为准，而不是刚才那个搜索缓存**。

顺便说一下，**周下载 1,301 对你这个目前仍然比较垂直的 OpenCode workflow 插件来说，我觉得已经值得认真分析了**。粗略按这个速度换算：

> **1,301 × 4.3 ≈ 5,600 次/月**

当然不能直接把它理解成 5,600 个独立用户，因为 npm 下载量会包含：

* 重复安装 / 更新
* CI 安装
* `npx` 调用
* OpenCode 自动拉取插件
* 同一个用户多台机器
* 你自己发布后的测试安装

但对于一个你 **9 月初才开始公开推广、目前 0.9.0** 的项目，`1,301/week` 已经说明它不只是“自己在用的小项目”了。

如果你愿意，我可以继续帮你把这个项目的 **真实月下载趋势拉出来**，比如看：

**最近 7 天 → 30 天 → 每日下载曲线 → 哪次版本发布后开始明显增长 → 按现在速度多久能到月下载 1 万。**

* * *

**You:**

![3538ba16-b9c3-4bb5-8268-c78d4a664528.png](https://chatgpt.com/backend-api/estuary/content?id=file_000000002f3481fd8408e2f3db1f6b28&ts=497238&p=fs&cid=1&sig=43244a0fc37eea391069b2bae7ef234a1867756301875f8b5091e9915ae1e38a&v=0)

你怎么看到版本是0.2.2的明明是0.9.0

* * *

**You:**

可以

* * *

**ChatGPT:**

看下来，我对这个项目的判断比刚才更积极一些。

你截图里 npm **实时数据显示 1,301 Weekly Downloads，版本 0.9.0**。搜索引擎现在仍缓存着旧的 `0.2.2` 页面，所以你的包我以截图里的实时数据为准；搜索缓存确实明显滞后。 [npm](https://www.npmjs.com/package/%40mickorz/opencode-dynamic-workflows?utm_source=chatgpt.com)

### 先看最重要的数字

按当前 **1,301 次 / 7 天** 的速度折算：

| 指标 | 当前水平 |
| --- | --- |
| 最近 7 天 | **1,301** |
| 日均跑速 | ≈ **186 / 天** |
| 30 天跑速 | ≈ **5,600 / 月** |
| 年化跑速 | ≈ **67,800 / 年** |

这里的 **5,600/月是 run rate（当前速度）**，不是说你过去 30 天已经有 5,600 下载。你的包发布时间还很短，因此真正的“过去 30 天累计”会明显低于这个数字。

### 放到同类项目里看，就比较有意思了

我找了几个比较接近的 OpenCode / Dynamic Workflow 包：

| 项目 | Weekly Downloads | 备注 |
| --- | --- | --- |
| **你的 `@mickorz/opencode-dynamic-workflows`** | **1,301** | OpenCode Dynamic Workflow |
| `@maplezzk/pi-dynamic-workflows` | 504 | Pi Dynamic Workflow [npm](https://www.npmjs.com/package/%40maplezzk/pi-dynamic-workflows?utm_source=chatgpt.com) |
| `opencode-usage-stats-plugin` | 304 | OpenCode 插件 [Socket](https://socket.dev/npm/package/opencode-usage-stats-plugin?utm_source=chatgpt.com) |
| `@autofab/opencode` | 109 | Agent Team + Dynamic Workflow [Socket](https://socket.dev/npm/package/%40autofab/opencode/overview/1.18.29-swarm.0?utm_source=chatgpt.com) |
| `@fnnm/opencode-dynamic-workflows` | 18 | **几乎同题材的 OpenCode Dynamic Workflow** [npm](https://www.npmjs.com/package/%40fnnm/opencode-dynamic-workflows?utm_source=chatgpt.com) |

尤其最后一个值得注意。

`@fnnm/opencode-dynamic-workflows` 名字、定位和你的非常接近，而且已经发布 **3 个月**，目前 npm 显示只有 **18 weekly downloads**。 [npm](https://www.npmjs.com/package/%40fnnm/opencode-dynamic-workflows?utm_source=chatgpt.com)

而你现在：

> **1,301 / week vs 18 / week**

不是一个量级了。

即使考虑 npm 下载统计存在 CI、重复安装、更新、自动安装等噪音，这个差距仍然很大。

### 所以我现在会怎么评价这个项目

如果只看一个刚发布不久的垂直开发者工具，我会把目前阶段理解成：

**已经不是“自己做着玩、偶尔有人装”的项目了，而是出现了比较明显的早期外部使用信号。**

我个人做开源工具时，会粗略这样观察，而不是当成行业标准：

* `<100/week`：主要是作者自己、朋友、零散用户
* `100–500/week`：开始出现真实外部用户
* `500–1,000/week`：细分工具已经有一定传播
* **`1,000+/week`：值得认真运营**
* `5,000+/week`：在细分生态里已经比较明显
* `10,000+/week`：可以开始当成一个有规模的开发者产品来看

你目前已经越过了我认为比较关键的 **1,000/week**。

而且你不是一个 `lodash`、React 组件库这种“被依赖后自动下载”的基础库。

你的安装方式是：

```Bash
npx @mickorz/opencode-dynamic-workflows install
```

或者作为 OpenCode 插件安装。

这类工具的下载行为通常比底层依赖包更接近“有人主动尝试使用”，虽然仍然**绝对不能把 1,301 下载等价为 1,301 个用户**。

* * *

## 我反而建议你现在开始记录这 4 个指标

不要以后只盯 npm Weekly Downloads。

### ① Weekly Downloads

这是目前最直观的增长指标：

```
Week 1    ?
Week 2    1301
Week 3    ?
Week 4    ?
```

真正重要的是：

> **1301 → 1600 → 2200**

还是：

> **1301 → 700 → 400**

前者说明传播正在形成，后者可能只是一次发布/推广峰值。

* * *

### ② GitHub Stars

npm 下载代表：

> 有人安装。

GitHub Star 更偏：

> 有人觉得这个项目值得记住。

你最终应该观察：

```
npm downloads ↑
GitHub stars ↑
Issues ↑
PR ↑
```

如果四个同时增长，价值会远高于单纯 npm 下载增长。

* * *

### ③ Active Users

这个其实比 npm 下载量重要得多。

未来你可以考虑做一个**完全匿名、默认关闭或者明确 opt-in** 的 telemetry：

```
install
    ↓
首次运行 workflow
    ↓
7 日仍在使用
    ↓
30 日仍在使用
```

你真正想知道的是：

```
1000 installs

↓

多少人真正运行 workflow？

↓

多少人第二周还在运行？
```

例如：

```
1301 downloads
300 activated
120 weekly active
```

这个数字比 1301 下载有价值得多。

* * *

### ④ Workflow Runs

你的产品非常适合记录一个指标：

```
Workflow Runs
```

例如：

```
Weekly Downloads     1,301

Weekly Active Users    250

Workflow Runs        4,800

Avg Runs/User         19.2
```

一旦有这种数据，你就可以真正判断：

> 用户到底是在“试一下”，还是已经把 Dynamic Workflow 放进日常开发流程。

* * *

## 还有一个我觉得比较重要的信号

你的包现在已经和很多 OpenCode 插件一起出现在生态依赖/索引页面里。比如 `solid-js` 的 npm dependents 页面已经能看到：

> `@mickorz/opencode-dynamic-workflows`

和 `opencode-token-min`、`opencode-dictate`、`orchestrator-autopilot` 等 OpenCode 相关项目一起出现。 [npm](https://www.npmjs.com/package/solid-js?activeTab=dependents&utm_source=chatgpt.com)

这说明 npm / 生态索引已经开始正常识别你的项目。

* * *

# 我现在最关注的不是“月下载 5600”

而是接下来 **2～4 周这条线怎么走**。

目前：

```
                    1301/week
                       ▲
                       │
                ╭──────╯
                │
        ╭───────╯
────────╯
```

如果未来变成：

```
1301
   ↓
1800
   ↓
2500
   ↓
3500
```

那就非常值得你继续投入。

因为这意味着你的项目可能正在从：

> **个人开源项目**

变成：

> **OpenCode 生态里一个有认知度的 Workflow 基础设施项目**

这对于你后面做 **FDE 简历、AI 工作台、OpenCode 插件体系、Workflow Engine** 都非常有价值。

我建议我们下一步直接给这个项目建立一个简单的 **增长 Dashboard**，每周记录 `npm Weekly Downloads / GitHub Stars / Fork / Issues / Release`，这样一两个月后就能非常清楚地看到 **哪一次版本发布真正带来了用户增长**。

如果你愿意，我也可以**每周自动帮你检查一次这个 npm 包的下载量变化，并在明显上涨或下跌时告诉你**。

* * *

**You:**

Active Users  这个怎么看

* * *

**ChatGPT:**

npm **看不到真正的 Active Users（活跃用户数）**。

它公开给你的主要是 **Downloads**：某天、某周、某月下载了多少次，而不是有多少“独立用户”。npm 的下载统计本质上是下载次数，例如相关统计工具返回的是 `{day, downloads}`，并不会给你 unique user / active user。 [npm+1](https://www.npmjs.com/package/download-stats?activeTab=readme&utm_source=chatgpt.com)

所以你现在截图里的：

> Weekly Downloads = 1301

不能理解成：

> 1301 个活跃用户

可能一个人贡献了很多次下载，例如升级版本、删除重装、CI、不同项目安装等。

对你这个 `opencode-dynamic-workflows`，我建议定义自己的 **WAU（Weekly Active Users）**：

> **最近 7 天内，至少真正执行过一次 workflow 的独立安装实例数。**

例如用户执行：

```JavaScript
await agent(...)
await parallel(...)
await pipeline(...)
```

只要本周执行过至少一次，就算一个 WAU。

最简单的实现是在插件里生成一个匿名随机 ID：

```
第一次安装
↓
生成 installation_id
例如：
8df2b0a7-xxxx-xxxx
↓
只保存在本地
```

然后真正执行 workflow 时，发送：

```JSON
{
  "installation_id": "8df2b0a7-...",
  "event": "workflow_run",
  "version": "0.9.0",
  "timestamp": "2026-09-22T..."
}
```

后台就能算：

```
Weekly Active Users
= 最近 7 天出现过 workflow_run 的
  distinct installation_id
```

这样你以后就能看到非常有价值的一组数据：

```
Weekly Downloads       1301
Weekly Active Users     237
Workflow Runs          4280

Runs / Active User     18.1
```

这比单看 npm 下载量有意义很多。

不过我会再加两个指标：

```
Activation
安装后第一次成功运行 workflow

Retention
第一次使用之后，
7 天 / 30 天以后是否还在运行
```

最终你的漏斗应该是：

```
npm Download
    ↓
Install
    ↓
Activated
    ↓
WAU
    ↓
7-day Retention
    ↓
30-day Retention
```

比如：

```
1301 Downloads

600 installations
        ↓
420 Activated
        ↓
260 WAU
        ↓
130 7-day retained
        ↓
80 30-day retained
```

这里的 **80 个 30-day retained users**，实际上可能比 `1301 Weekly Downloads` 更值得关注。

对你这个开源插件，我不建议收集 IP、项目路径、prompt、代码内容之类的数据。最好只记录匿名 ID + 版本 + workflow 是否执行成功 + workflow run 次数，并做 **opt-in telemetry**，这样对开源用户更友好。

你现阶段其实可以先不做复杂平台。用 **PostHog / Umami / Plausible** 这类事件统计就够了，例如：

```
plugin_installed
workflow_started
workflow_completed
workflow_failed
agent_called
parallel_called
pipeline_called
```

然后直接 Dashboard 看：

```
DAU
WAU
MAU
Retention
Workflow Runs
Success Rate
```

**我最建议你现在重点增加的是：**

> **WAU + Workflow Runs + 7-day Retention**

因为这三个数字基本就能回答：

> “1301 个 npm 下载，到底有多少是真正在用我的 Dynamic Workflow？”

如果你愿意，我下一步可以直接按你现在 `@mickorz/opencode-dynamic-workflows` 的架构，给你设计一套**非常轻量的匿名 Telemetry + PostHog Active Users 统计方案**，包括具体埋点位置、事件 Schema 和 Dashboard 怎么配。

* * *

**You:**

可以

* * *

**ChatGPT:**

可以。我看过你现在 `0.9.0` 的代码后，建议第一版 Telemetry **尽量轻，不碰用户业务内容**，专门解决“真实活跃用户到底有多少”这个问题。

你当前同步 workflow 的完整生命周期就在 `src/tools/workflow.ts`；后台 workflow 则集中在 `src/tools/background-runs.ts`，这两个位置已经足够覆盖手动、后台、定时等主要执行路径。 [GitHub+1](https://raw.githubusercontent.com/mickorz/opencode-dynamicworkflows/main/src/tools/workflow.ts)

### 第一版只记录 4 个事件

我建议事件直接叫：

```
workflow started
workflow completed
workflow failed
workflow aborted
```

PostHog 本身也推荐 `[object] [verb]` 这种事件命名方式。 [PostHog](https://posthog.com/docs/libraries/node)

其中：

```
WAU
=
最近 7 天执行过 workflow started
的 distinct installation_id 数
```

而真正的“核心活跃用户”，我还会再看：

```
最近 7 天执行过 workflow completed
的 distinct installation_id 数
```

这样可以区分：

```
调用过插件的人
        ↓
真正成功完成工作流的人
```

* * *

## 你的 anonymous ID 怎么设计

不要使用：

```
GitHub ID
OpenCode 用户 ID
MAC 地址
机器 GUID
IP 地址
项目路径
用户名
```

第一次同意 telemetry 时，本地生成：

```TypeScript
crypto.randomUUID()
```

例如：

```JSON
{
  "enabled": true,
  "installationId": "1ba21f91-2d75-45cf-92d4-a00f0e287532"
}
```

存在用户级目录：

```
~/.opencode-dynamic-workflows/telemetry.json
```

不要存在：

```
项目/.opencode-workflows/
```

否则同一个用户开 10 个项目，会被统计成 10 个用户。

* * *

## 我建议你的事件数据长这样

`workflow started`：

```JSON
{
  "distinct_id": "anonymous-installation-id",

  "event": "workflow started",

  "properties": {
    "plugin_version": "0.9.0",
    "background": true,
    "trigger": "manual",
    "resume": false,

    "$process_person_profile": false
  }
}
```

完成：

```JSON
{
  "event": "workflow completed",

  "properties": {
    "run_id": "anonymous-run-id",
    "duration_ms": 18342,
    "agent_count": 8,
    "background": true,
    "trigger": "manual"
  }
}
```

失败：

```JSON
{
  "event": "workflow failed",

  "properties": {
    "failure_type": "runtime",
    "background": true
  }
}
```

中断：

```JSON
{
  "event": "workflow aborted",

  "properties": {
    "background": true
  }
}
```

PostHog 支持在事件中设置：

```TypeScript
$process_person_profile: false
```

这样可以保留匿名 `distinctId` 用于统计，同时不创建完整 Person Profile。 [PostHog](https://posthog.com/docs/libraries/node)

* * *

# 强烈不要上传这些数据

这一点对你的项目尤其重要。

不要上传：

```
❌ workflow script
❌ agent prompt
❌ LLM 输出
❌ 用户代码
❌ 文件名
❌ 项目路径
❌ context.directory
❌ workflow description
❌ meta.name
❌ error.message 原文
❌ API Key
```

例如你现在这里：

```TypeScript
parseWorkflowScript(script).meta.name
```

虽然技术上很好拿到，但我也建议**不要上传 `workflowName`**。

用户可能写：

```
xxx公司支付系统重构
```

它就变成业务信息了。

所以 Telemetry 只记录：

```
做了什么类型的动作
成功还是失败
用了多少 agent
用了多久
用了哪个版本
```

这就足够做产品分析。

* * *

# 放到你当前代码哪里

你的同步执行现在大概是：

```
createWorkflowTool()
    ↓
验证 script
    ↓
runWorkflow()
    ↓
completed
    ↓
catch
```

对应可以改成：

```TypeScript
track("workflow started", {
  background: false,
  trigger: "manual"
})

const startedAt = Date.now()

try {

    const result = await runWorkflow(...)

    track("workflow completed", {
        duration_ms: Date.now() - startedAt,
        agent_count: result.agents.length,
        background: false
    })

} catch (error) {

    if (aborted) {

        track("workflow aborted", {
            background: false
        })

    } else {

        track("workflow failed", {
            background: false,
            failure_type: classifyError(error)
        })

    }

}
```

你当前 `workflow.ts` 里的 `runWorkflow()` 正好位于这一生命周期中心，因此很好加。 [GitHub](https://raw.githubusercontent.com/mickorz/opencode-dynamicworkflows/main/src/tools/workflow.ts)

* * *

## 后台 workflow 不能漏掉

这个特别重要。

你现在默认：

```TypeScript
background ?? true
```

也就是说实际上**大部分用户可能走 BackgroundRunManager**。 [GitHub](https://raw.githubusercontent.com/mickorz/opencode-dynamicworkflows/main/src/tools/workflow.ts)

后台真正执行的位置是：

```
BackgroundRunManager.start()
          ↓
execute()
          ↓
runWorkflow()
          ↓
completed / failed / aborted
```

你代码现在已经明确维护：

```TypeScript
"running"
"completed"
"failed"
"aborted"
```

四种状态。 [GitHub](https://raw.githubusercontent.com/mickorz/opencode-dynamicworkflows/main/src/tools/background-runs.ts)

所以直接对应：

```
running
    ↓
workflow started

completed
    ↓
workflow completed

failed
    ↓
workflow failed

aborted
    ↓
workflow aborted
```

非常干净。

* * *

# 我建议单独建 telemetry 模块

不要把 PostHog 逻辑散落在 workflow 代码里。

建议：

```
src/
├─ telemetry/
│  ├─ index.ts
│  ├─ identity.ts
│  ├─ events.ts
│  └─ config.ts
│
├─ tools/
│  ├─ workflow.ts
│  └─ background-runs.ts
```

业务代码只允许：

```TypeScript
telemetry.track("workflow completed", {
    agent_count: result.agents.length
})
```

而不知道：

```
PostHog
API Key
HTTP
UUID
配置文件
网络重试
```

以后你如果从 PostHog 换到：

```
Umami
自建 ClickHouse
自己的 API
```

workflow 一行都不用改。

* * *

# Telemetry 有一个非常重要的原则

### 永远不能影响 Workflow

也就是说：

```TypeScript
telemetry.track(...)
```

即使：

```
PostHog 挂了
网络断了
DNS 超时
API Key 错了
Telemetry 文件坏了
```

都必须：

```
workflow 正常执行
```

实现上：

```TypeScript
void telemetry.track(...).catch(() => {})
```

并且网络设置非常短的 timeout。

绝对不要：

```TypeScript
await telemetry.track(...)
```

把用户 workflow 卡住。

* * *

# PostHog SDK这里我建议做一层隔离

PostHog 当前官方 Node SDK 是：

```Bash
npm install posthog-node
```

官方文档当前说明 Node SDK 面向 Node 20+，并支持异步队列发送。 [PostHog](https://posthog.com/docs/libraries/node)

而你目前包的说明仍然有 Node 18+ 相关兼容要求，而且插件本身跑在 OpenCode 自带运行环境中。你的 `package.json` 当前也只有 6 个运行依赖，没有 PostHog。 [GitHub](https://raw.githubusercontent.com/mickorz/opencode-dynamicworkflows/main/package.json)

所以我不会直接让：

```
整个项目强绑定 posthog-node
```

而是：

```
Workflow
   ↓
Telemetry interface
   ↓
PostHog adapter
```

先验证 OpenCode Runtime 对当前 `posthog-node` 的兼容性。

如果有问题就直接换轻量 HTTP Capture 实现，业务层不动。

* * *

# 安装的时候增加一个选择

你本身已经有：

```Bash
npx @mickorz/opencode-dynamic-workflows install
```

[GitHub](https://github.com/mickorz/opencode-dynamicworkflows)

所以安装器可以多问一句：

```
◇ 是否允许发送匿名使用统计？

  仅发送：
  • 插件版本
  • workflow 执行次数
  • 成功 / 失败 / 中断
  • agent 数量
  • 执行耗时

  不发送：
  • Prompt
  • 代码
  • 文件路径
  • Workflow 内容
  • API Key
  • 任何项目内容

> Yes
  No
```

我比较推荐这种 **明确 opt-in**。

对于开源开发工具，用户会更容易接受。

* * *

# PostHog Dashboard 最终这样配

第一屏我建议只放 6 张卡：

| 指标 | 定义 |
| --- | --- |
| **WAU** | 7 天内 `workflow started` 的 Unique Users |
| **Successful WAU** | 7 天内 `workflow completed` Unique Users |
| **Workflow Runs** | `workflow started` 总次数 |
| **Runs / WAU** | Runs ÷ WAU |
| **Success Rate** | completed ÷ started |
| **7-day Retention** | 完成 workflow 后，下周再次完成 |

最后你看到的就不再是：

```
npm downloads
1301
```

而会变成：

```
Weekly Downloads
1,301

Telemetry Opt-in
312

WAU
218

Successful WAU
187

Workflow Runs
2,946

Runs / WAU
13.5

Success Rate
91.4%

7-day Retention
42%
```

这时项目到底有没有人在**真正使用**，一眼就知道了。

PostHog 自己也建议优先跟踪真正体现产品价值的 high-value events，而不是仅仅“注册/打开”这类浅层行为；对你来说，`workflow completed` 就很适合作为这个核心事件。 [PostHog Newslettter+1](https://newsletter.posthog.com/p/measuring-product-market-fit-is-more?utm_source=chatgpt.com)

### 我建议你的 North Star Metric

暂时不要用：

> npm Downloads

而用：

> **Weekly Successful Workflow Users**

即：

```
最近 7 天
至少成功完成一次 Workflow
的匿名 installation 数
```

再辅以：

```
Workflow Runs / WAU
+
7-day Retention
```

这三个数字，基本就能判断 `opencode-dynamic-workflows` 是“很多人下载试一下”，还是“已经真正进入开发者日常工作流”。

而且按照你现在的代码结构，这个改造其实很适合独立做成一个 **Telemetry 模块**，不需要侵入 Runtime 核心。

* * *

**You:**

![ca2c4a31-866f-4531-82a8-e4fec1c9d516.png](https://chatgpt.com/backend-api/estuary/content?id=file_00000000417081f6a79909a3c831489c&ts=497238&p=fs&cid=1&sig=91fe1fb67a05d2fb9d196163b935f974ae6c7de14ec16bedf0f4b54bdf0fad4f&v=0)

我在github后台，看没有任何人拉取，但是npm有这么多下载是怎么回事

* * *

**ChatGPT:**

这个现象完全正常，而且你这个截图其实**没有显示“拉取次数”**。

你现在打开的是 **Insights → Pulse**。这里的 `0 Active pull requests / 0 Merged pull requests` 指的是 **PR（Pull Request，代码合并请求）**，不是别人执行 `git pull` 或 `git clone` 的次数。GitHub 官方也明确说明，Pulse 展示的是 PR、Issue、Commit 等仓库协作活动。 [GitHub Docs](https://docs.github.com/zh/repositories/viewing-activity-and-data-for-your-repository?utm_source=chatgpt.com)

你真正应该点左边这个：

**Insights → Traffic**

进去以后看两个指标：

```
Views
Unique visitors

Clones
Unique cloners
```

GitHub 的 `Traffic → Clones` 才是完整 `git clone` 的次数和独立克隆者数量，而且 GitHub 这里只保留/展示最近 **14 天**的数据。 [GitHub Docs+1](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository?utm_source=chatgpt.com)

更关键的是：**npm 下载根本不需要访问你的 GitHub。**

比如别人执行：

```Bash
npm install @mickorz/opencode-dynamic-workflows
```

或者：

```Bash
npx @mickorz/opencode-dynamic-workflows install
```

实际路径大致是：

```
用户
 ↓
npm registry
 ↓
读取 package metadata
 ↓
下载 .tgz 包
 ↓
安装到本地
```

不是：

```
用户
 ↓
GitHub
 ↓
git clone
```

npm 发布后的每个版本都有自己的 tarball 地址，例如：

```
registry.npmjs.org
    ↓
@mickorz/opencode-dynamic-workflows
    ↓
xxx-0.9.0.tgz
```

npm 官方 Registry 文档中，package metadata 的 `dist.tarball` 就是用于下载安装包的地址。 [GitHub+1](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md?utm_source=chatgpt.com)

所以你完全可能出现这种情况：

| 行为 | npm Downloads | GitHub Clone |
| --- | --- | --- |
| `npm install @mickorz/...` | +1 | 0 |
| `npx @mickorz/...` | 可能 +1 | 0 |
| OpenCode 自动下载安装插件 | +1 | 0 |
| CI 每次重新安装依赖 | +1 | 0 |
| 同一个用户反复安装/升级 | 多次 | 0 |
| `git clone github.com/mickorz/...` | 0 | +1 |
| 用户打开 GitHub README | 0 | 0 Clone，+View |

所以：

> **npm 1301 Weekly Downloads + GitHub 很少有人 Clone**

本身一点都不矛盾。

而且对你的项目来说，这种情况反而非常容易发生，因为你 README 的主要安装方式本来就是 npm/npx，而不是让用户：

```Bash
git clone ...
npm install
npm run build
```

用户根本没有必要 clone 你的源码。

### 你现在最值得看的数据

你截图左边已经有 **Traffic**。

你点进去之后，把那个页面截图给我。

我主要想看：

```
Git clones
Total clones
Unique cloners

Visitors
Total views
Unique visitors

Referring sites
```

例如如果你看到：

```
npm Weekly Downloads     1301

GitHub Unique visitors    180
GitHub Unique cloners      35
GitHub Stars               20
```

这是**很正常甚至比较健康的结构**。

因为可能只有 180 个人真正来看 README，但大量用户直接：

```Bash
npx @mickorz/opencode-dynamic-workflows install
```

甚至是从别人教程、OpenCode 配置、AI 给出的命令直接安装。

### 但这里也解释了为什么我刚才建议你做 Active Users

现在你只有：

```
npm
1301 downloads
```

你其实不知道里面是：

```
方案 A

800 个人
每人约下载 1～2 次
```

还是：

```
方案 B

100 个人
因为更新/CI/npx
产生了 1301 次下载
```

甚至可能：

```
方案 C

真实用户     200
CI / Bot     500
重复更新     601
----------------
Downloads   1301
```

**npm 本身无法回答这个问题。**

因此你的数据体系以后应该是：

```
          发现
           ↓
GitHub Unique Visitors
           ↓
          安装
           ↓
npm Downloads
           ↓
        真正执行
           ↓
Telemetry Activated Users
           ↓
           WAU
           ↓
Successful Workflow Users
           ↓
      7-day Retention
```

其中真正对 `opencode-dynamic-workflows` 有商业/产品价值的数字是最下面几个，而不是 npm Downloads。

所以你现在先点：

> **Insights → Traffic**

就是你截图左侧 **Traffic** 那一项。

把里面的 **Clones + Visitors + Referring sites** 截图给我，我可以直接结合你现在的 **npm 1301/week**，帮你判断这 1301 下载目前更像是**真实用户增长、重复安装，还是 CI/机器人带来的统计膨胀**。

* * *

**You:**

![11c006e7-8885-4b75-a416-6b18f1bdf2a8.png](https://chatgpt.com/backend-api/estuary/content?id=file_00000000027481fd872a6e807705fbb3&ts=497238&p=fs&cid=1&sig=e01fd7a9e28828a9d08cb1f6d4cdf8fdde93c3e2b13e282184b19f6282a2738c&v=0)

* * *

**ChatGPT:**

这张图就很有意思了，而且能把前面的疑问基本解释清楚。

你最近 **14 天其实有：386 次完整 Clone，150 个 Unique cloners**。GitHub 官方说明这里统计的是 **full clone，不包含 fetch/pull**，并且只保留最近 14 天的数据。 [GitHub Docs+1](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository?utm_source=chatgpt.com)

也就是说，你的项目并不是“没人拉取”，而是：

> **至少有 150 个不同的克隆来源，在 14 天内完整 clone 过你的仓库。**

平均下来：

```
386 clones / 150 unique cloners
≈ 2.57 次 clone / unique cloner
```

这已经是一个挺明确的外部使用信号。

更有意思的是下面：

```
GitHub 页面 Views：103
GitHub Unique Visitors：2

GitHub Clones：386
GitHub Unique Cloners：150
```

这说明大量人/程序**根本没有先打开 GitHub 页面**，而是直接通过命令、工具、脚本或自动化流程访问仓库。GitHub 的网页访问和 Git clone 本来就是两套独立统计，命令行 clone 不需要产生网页访问。 [GitHub Docs](https://docs.github.com/zh/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository?utm_source=chatgpt.com)

所以很可能存在这种路径：

```
看到教程 / README 镜像 / AI 推荐 / npm
        ↓
复制命令
        ↓
npm / npx / OpenCode 安装
        ↓
必要时工具直接访问 GitHub
```

而不是：

```
Google
 ↓
打开 GitHub
 ↓
仔细看 README
 ↓
点击 Code
 ↓
git clone
```

### 再和你的 npm 数据放一起看

你现在 npm：

```
Weekly Downloads
≈ 1301 / 7 天
```

如果非常粗略按当前速度换成 14 天：

```
npm downloads ≈ 2600
GitHub clones   = 386
Unique cloners  = 150
```

大致会呈现：

```
npm 下载
██████████████████████████  ~2600

GitHub clone
████                          386

Unique clone sources
██                             150
```

这其实非常合理。

因为：

```Bash
npm install @mickorz/opencode-dynamic-workflows
```

并不会执行：

```Bash
git clone github.com/mickorz/...
```

npm 直接从 npm Registry 下载发布后的 tarball。

所以：

**npm 1301/week 并不是 GitHub 150 cloners 的矛盾数据。**

它们测的是不同东西。

* * *

我反而觉得现在 **150 Unique Cloners** 这个数字挺值得关注。

因为 npm Download 特别容易受这些东西影响：

```
重复安装
CI
升级
npx 缓存失效
自动安装
机器人扫描
```

但是：

```
150 Unique Cloners / 14 days
```

至少告诉我们：

> 有相当数量的独立来源主动取得了完整源码。

当然它仍然**不能等价成 150 个真人用户**，因为里面仍然可能有 CI、机器人、安全扫描、自动化环境等。

### 还有一个容易忽略的重要点

GitHub Clone 数据**不统计 fetch**。 [GitHub Docs](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository?utm_source=chatgpt.com)

比如一个真实用户：

```Bash
git clone xxx     ← 第一次算 Clone

git pull
git pull
git pull
git fetch
```

后面这些都不会继续增加你的 Clone 数。

所以它跟 npm Downloads 又不一样：

```
npm 用户升级 5 次
→ 可能贡献多次 download

Git 用户 clone 一次，然后长期 pull
→ 可能只贡献 1 次 clone
```

* * *

### 从你这张图，我目前会这样判断

相比单看 `1301 npm downloads/week`，现在可信度明显更高了。

你已经至少有三层信号：

| 指标 | 当前数据 | 它说明什么 |
| --- | --- | --- |
| npm Weekly Downloads | **1301** | 包被频繁下载安装 |
| GitHub Clones / 14d | **386** | 源码被完整拉取 |
| GitHub Unique Cloners / 14d | **150** | 存在大量不同克隆来源 |

所以已经不能简单解释成：

> “1301 全是 npm 自己的统计噪音。”

因为 GitHub 这一套完全独立的数据，也出现了 **150 个 Unique Cloners**。

尤其你的图还有一个现象：

```
09/09   高峰
09/11   高峰
09/14   高峰
09/18   最大高峰
```

说明 Clone 不是某一天突然被某个机器人刷了 386 次，而是**多天反复出现波峰**。

这比“某天突然 300 次、然后归零”健康得多。

* * *

不过现在还缺最后一块拼图：

> **这些人到底有没有真正执行 Workflow？**

所以我前面建议加 Telemetry 的价值现在更明显。

未来你可能会得到：

```
npm Weekly Downloads          1301

GitHub Unique Cloners          ~75 / week

Telemetry Opt-in               120

Weekly Active Users             85

Successful Workflow Users       71

Workflow Runs                  960
```

到这个时候，我们就能非常准确地说：

> 下载很多 → 有人拿源码 → 有人真正启动 → 有人持续使用。

现在你已经能确认前两层了：

```
下载安装      ✅
获取源码      ✅

真正使用      ❓
持续使用      ❓
```

**所以我现在比刚看到 1301 npm Downloads 时，更相信你的项目已经存在一批真实外部用户。**

另外，你截图最下面的 **Referring sites 和 Popular content 被截掉了**。这两个如果有数据其实也很有价值：尤其 Referring sites 可以帮助判断这些人是从哪里知道你的项目的，比如搜索、某个博客、社区或者其他项目。GitHub 的 Referring sites 同样是 Traffic 官方指标。 [GitHub Docs](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository?utm_source=chatgpt.com)

* * *

**You:**

首先要有一个问题，就是加这个Telemetry   是传统做法吗，有没有会引起社区下架，或者用户反感

* * *

**ChatGPT:**

是传统做法，而且在开发者工具里很常见，但**社区对“遥测”非常敏感**。关键不是有没有 Telemetry，而是它是不是“偷偷做、默认做、采集过多”。

Next.js、Homebrew、VS Code 都有使用数据/Telemetry。Next.js 会收集匿名使用信息并提供关闭方式；Homebrew 会在启用 analytics 前展示通知，让用户有机会先退出；VS Code 也明确公开采集类型并允许关闭。 [Next.js+2Homebrew Documentation+2](https://nextjs.org/telemetry?utm_source=chatgpt.com)

### 会不会被 npm 下架？

**单纯加入 Telemetry 不会导致 npm 下架。**我没有看到 npm 有“禁止软件遥测”的规则。

npm 真正禁止的是恶意代码、spyware，以及侵犯用户隐私或其他权利的内容；npm 也明确会删除确认的恶意包。 [npm 文档+1](https://docs.npmjs.com/policies/open-source-terms/?utm_source=chatgpt.com)

所以风险更接近这样：

| 做法 | 风险 |
| --- | --- |
| 明确说明 + 用户主动开启 | 🟢 很低 |
| 匿名统计 + 可随时关闭 | 🟢 很低 |
| 默认开启但 README 写清楚 | 🟡 有人会介意 |
| 默认开启且不明显说明 | 🟠 容易被 Issue / Reddit / HN 吐槽 |
| 上传项目路径、Prompt、代码 | 🔴 高风险 |
| 偷偷上传机器信息/凭据/文件 | 🔴 可能被认为 spyware / malware |

对你这个项目，我反而**不推荐完全照搬 Next.js/VS Code 的默认开启模式**。

它们已经有品牌和成熟的隐私体系。你现在是一个正在增长的开源 OpenCode 插件，目标用户又都是程序员。

程序员看到：

```
npm package
    ↓
安装后
    ↓
偷偷访问 analytics.xxx.com
```

第一反应很可能是：

> “这个插件为什么在联网？”

尤其你这个插件运行在 Agent / Coding 环境里，本身就可能接触：

```
源码
Prompt
文件路径
API Key
项目名称
LLM 输出
```

所以用户会比普通 App 更敏感。

* * *

## 我建议你做，但做成“Privacy-first Telemetry”

第一版我会把原则定成：

**默认关闭，明确 Opt-in。**

安装时这样：

```
Anonymous Usage Statistics

Would you like to help improve Dynamic Workflows
by sending anonymous usage statistics?

Collected:
✓ Plugin version
✓ Workflow started/completed/failed
✓ Execution duration
✓ Number of agent calls

Never collected:
✗ Prompts
✗ Source code
✗ File contents
✗ File paths
✗ Project names
✗ API keys
✗ LLM responses

Telemetry is OFF by default.

Enable anonymous telemetry? [y/N]
```

默认是：

```
N
```

用户不操作：

> **一条网络请求都不能发。**

这点我认为很重要。

* * *

然后提供三个命令：

```Bash
opencode-dynamic-workflows telemetry status

opencode-dynamic-workflows telemetry enable

opencode-dynamic-workflows telemetry disable
```

再支持：

```Bash
OPENCODE_DYNAMIC_WORKFLOWS_TELEMETRY=0
```

企业用户、CI 用户可以直接彻底关闭。

* * *

## 我甚至建议第一版不要存永久 installation_id

这是我对前面方案的一个调整。

之前我们说：

```
installation_id
↓
永久 UUID
```

确实可以计算：

```
WAU
MAU
7-day retention
30-day retention
```

但它意味着你可以跨几个月识别：

> “同一个匿名安装实例又回来了。”

它虽然不是姓名，但已经属于一种**稳定的伪匿名标识符**。隐私层面会比单纯聚合数据敏感。

你现在最想知道的是：

> **npm 1301 下载到底有多少人在真正用。**

其实没必要马上做到用户级长期追踪。

可以用一个更漂亮的方案：

```
本地随机 secret
       ↓
secret + 当前周
       ↓
生成 weekly anonymous id
```

比如：

```
Week 39

installation secret:
xxxx

↓ HMAC

weekly_id:
a7f3c92...
```

同一个用户本周：

```
workflow run 1 → a7f3c92
workflow run 2 → a7f3c92
workflow run 3 → a7f3c92
```

所以你能得到：

```
Weekly Active Installations
= distinct weekly_id
```

到了下周：

```
Week 40
↓
weekly_id:
81bd04...
```

ID 自动变化。

后台无法轻易把：

```
Week 39 用户 A
```

和：

```
Week 40 用户 A
```

关联起来。

这样你仍然能得到：

```
WAU                    ✅
Workflow Runs          ✅
Runs / WAU             ✅
Success Rate           ✅
Version distribution   ✅

跨周用户追踪            ❌
7-day retention        ❌
30-day retention       ❌
```

但第一阶段我觉得**完全够了**。

* * *

### 还有一个非常值得做的功能：Telemetry Debug

Next.js 就提供了类似机制，可以把将要发送的数据输出出来而不真正发送，方便用户审计。 [Next.js](https://nextjs.org/telemetry?utm_source=chatgpt.com)

你的可以做：

```Bash
opencode-dynamic-workflows telemetry debug
```

输出：

```JSON
{
  "event": "workflow_completed",
  "weekly_id": "a7f3c92...",
  "plugin_version": "0.9.0",
  "duration_bucket": "10-30s",
  "agent_count_bucket": "5-10",
  "background": true
}
```

README 再直接写：

> **You can inspect every telemetry event we send.**

对程序员用户来说，这句话很有价值。

* * *

### 更进一步：不要发送精确值

例如不要：

```JSON
{
  "duration_ms": 18342,
  "agent_count": 7
}
```

可以发送：

```JSON
{
  "duration": "10-30s",
  "agent_count": "5-10"
}
```

也就是 bucket 化。

够你做产品分析：

```
<10s
10-30s
30-60s
1-5min
>5min
```

却进一步减少数据指纹。

* * *

### README 顶部直接放一段 Telemetry

不要藏在几十页下面。

比如：

```
## Anonymous Telemetry

Dynamic Workflows includes optional anonymous usage telemetry.

Telemetry is disabled by default and requires explicit opt-in.

We collect only aggregate product usage such as:
- workflow started/completed/failed
- plugin version
- execution duration bucket
- agent count bucket

We never collect prompts, source code, file paths,
project names, API keys, or LLM outputs.

Run:
opencode-dynamic-workflows telemetry status
opencode-dynamic-workflows telemetry disable
```

甚至把 telemetry 源码集中放：

```
src/telemetry/
```

让别人：

```
点进去就能审计
```

这就是开源项目最大的优势。

* * *

## 社区真正讨厌的通常不是 Telemetry

而是：

> **Surprise Telemetry**

也就是：

```
我安装一个插件
↓
没人告诉我
↓
它突然往第三方服务器发东西
↓
我去读源码才发现
```

这很容易直接摧毁信任。

反过来：

```
Telemetry: OFF

是否愿意帮助作者改进项目？
[y/N]
```

用户选：

```
y
```

然后还能随时：

```Bash
telemetry disable
```

这种做法通常不会成为社区问题。

* * *

### npm 本身其实也在收集安装相关数据

有意思的是，npm 官方自己的隐私文档也明确写着，在执行诸如 `npm install` 时会处理 session 标识、Node/npm/OS 版本、CI 标记、User-Agent、IP 和请求 URL 等信息，用于运行 Registry、反滥用以及统计 package 使用/流行度。 [npm 文档](https://docs.npmjs.com/policies/privacy/?utm_source=chatgpt.com)

所以：

> **开发工具做匿名 usage analytics 本身并不反常。**

区别只是：

> 你必须把边界讲清楚。

* * *

## 对你这个项目，我建议最终定成这一套

只有一个列表：

1. **Telemetry 默认 OFF**
2. 首次安装明确询问，默认 `[y/N]`
3. 没同意之前 **0 网络请求**
4. 不收 Prompt / Code / File / Path / Project Name / LLM Output
5. 第一阶段用 **weekly rotating anonymous ID**
6. 只统计 `started / completed / failed / aborted`
7. duration、agent count 尽量 bucket 化
8. 提供 `status / enable / disable / debug`
9. README 明确写 Telemetry
10. Telemetry 失败永远不能影响 Workflow

这样你依然可以得到最关键的数据：

```
npm Weekly Downloads
        1301
          ↓

Weekly Active Installations
         ？？？

Workflow Runs
         ？？？

Success Rate
         ？？？
```

而不需要一开始就冒着“在追踪开发者”的观感风险。

**我会优先做这个版本，而不是之前那个永久 `installation_id + PostHog 用户追踪` 版本。**

等以后项目真的做到几千 WAU，需要研究 retention 时，再单独考虑是否增加“可选的增强分析”。这样更符合你现在这个开源项目所处的阶段。

* * *

**You:**

整理一下刚刚的风险评估问题为一份完整的报告

* * *

**ChatGPT:**

我把刚才的讨论整理成了一份可以直接用于项目内部评审、README 设计依据或后续开发任务拆分的完整报告。

# OpenCode Dynamic Workflows Telemetry 风险评估报告

**项目：** `@mickorz/opencode-dynamic-workflows`  
**评估主题：** 是否引入匿名使用数据 Telemetry，以及社区、隐私、npm 平台和技术风险  
**评估结论：** 可以引入，但建议采用 **Privacy-first、默认关闭、明确 Opt-in、最小数据采集** 的设计。

* * *

# 1. 背景

目前 `opencode-dynamic-workflows` 已经可以通过 npm 下载量和 GitHub Traffic 观察到一定程度的外部使用。

但目前能看到的主要指标，例如：

* npm Weekly Downloads
* GitHub Clones
* GitHub Unique Cloners
* GitHub Visitors

都不能准确回答一个最关键的问题：

> 有多少开发者真正运行并持续使用 Dynamic Workflow？

例如 npm Weekly Downloads 即使达到 1,000+，其中仍可能包含：

* 同一个用户重复安装
* 插件升级
* CI/CD 安装
* npx 调用
* 自动部署
* 缓存失效重新下载
* Bot / 安全扫描

因此，如果希望进一步判断产品真实使用情况，需要引入产品级 Telemetry。

希望得到的核心指标包括：

* Weekly Active Users / Installations
* Workflow Runs
* Successful Workflow Users
* Workflow Success Rate
* Runs / Active User

但因为 `opencode-dynamic-workflows` 属于：

> AI Coding / Agent / Workflow / 开源开发者工具

它天然可能运行在包含源码、Prompt、API Key、项目文件等敏感内容的环境中。

因此 Telemetry 必须进行专门的隐私和社区风险设计。

* * *

# 2. Telemetry 是不是传统做法？

## 结论

**是。**

Telemetry / Anonymous Analytics 在现代开发者工具、CLI、IDE、Framework 中属于非常常见的产品分析方法。

例如：

* Next.js 提供匿名 Telemetry，并提供退出机制。
* Homebrew 使用匿名 Analytics，并明确说明采集范围、退出方式、调试方式以及数据传输行为。
* Visual Studio Code 使用 Telemetry 分析使用情况、性能问题和功能采用情况，并提供关闭机制。

因此：

> **“开源开发者工具存在 Telemetry”本身并不是异常行为。**

真正决定社区接受程度的是：

> Telemetry 如何开启、采什么、发什么、用户是否知道、用户是否能够控制。

* * *

# 3. 最大风险不是 Telemetry，而是 Surprise Telemetry

社区通常真正反感的是：

> **Surprise Telemetry —— 用户不知道软件在上传数据。**

典型高风险路径：

```
用户 npm install
        ↓
正常使用插件
        ↓
插件偷偷连接第三方 Analytics
        ↓
用户通过网络抓包 / 阅读源码发现
        ↓
产生“不可信任”感
```

对于普通消费类 App，这可能只是隐私问题。

但对于：

```
AI Coding Tool
Agent
OpenCode Plugin
Developer Tool
```

问题会更加严重。

因为用户会自然产生疑问：

> 它是不是上传了我的代码？

> 它是不是上传了 Prompt？

> 它是不是读取了项目路径？

> 它会不会拿到 API Key？

> 它有没有发送 Agent 输出？

即使实际上没有采集这些内容，**如果没有提前透明说明，也容易产生负面社区反馈。**

* * *

# 4. npm 下架风险评估

## 4.1 单纯加入 Telemetry

风险等级：

**低风险 🟢**

npm 并没有规定：

> npm Package 不允许进行 Telemetry。

Telemetry 本身不是恶意行为。

大量正常开发工具都有类似能力。

* * *

# 4.2 npm 真正关注的问题

npm Open Source Terms 明确禁止包括恶意代码、spyware 以及侵犯他人隐私或权利的内容。

npm 对恶意软件报告也有专门处理流程，经确认的恶意包可能被移除。

因此问题的边界在于：

```
正常匿名产品分析
        ↓
通常没有问题

偷偷收集个人/项目数据
        ↓
风险明显增加

上传源码 / Token / Prompt / 凭据
        ↓
极高风险
```

* * *

# 5. npm 平台风险矩阵

| Telemetry 行为 | npm 风险 | 社区风险 |
| --- | --- | --- |
| 明确 Opt-in + 匿名统计 | 🟢 低 | 🟢 低 |
| 匿名统计 + 可以关闭 | 🟢 低 | 🟡 低~中 |
| 默认开启但 README 明确写明 | 🟢 低 | 🟡 中 |
| 默认开启且提示不明显 | 🟡 | 🟠 高 |
| 隐藏 Telemetry | 🟡~🔴 | 🔴 高 |
| 上传文件路径/项目名称 | 🟡~🔴 | 🔴 高 |
| 上传 Prompt / Code / LLM Output | 🔴 | 🔴 极高 |
| 上传 API Key / Token / Credential | 🔴 极高 | 🔴 极高 |
| 将 Telemetry 伪装成其他网络行为 | 🔴 | 🔴 极高 |

因此项目应该追求：

> **最低 npm 风险 + 最低社区风险**

而不是追求最大数据量。

* * *

# 6. 社区风险评估

## 风险一：用户认为插件在“监控开发行为”

这是最主要风险。

尤其你的插件会涉及：

```
Workflow
Agent
Prompt
文件
源码
LLM
项目上下文
```

Telemetry 如果设计不好，很容易让用户误认为：

> 作者可以看到我的 Workflow。

因此 Telemetry 文档必须明确使用：

**Never Collected**

而不是只写：

**Anonymous Telemetry**

因为“匿名”并不能解决用户对内容泄露的担心。

* * *

# 7. 建议明确声明绝不采集的数据

建议明确列出：

```
Never Collected

✗ Prompt
✗ Source Code
✗ File Content
✗ File Path
✗ Directory
✗ Project Name
✗ Workflow Script
✗ Workflow Name
✗ Agent Prompt
✗ Agent Response
✗ LLM Output
✗ API Key
✗ Access Token
✗ Environment Variable Value
✗ Git Remote
✗ Username
✗ Email
```

尤其：

```
workflowName
projectName
directory
```

虽然看起来没有那么敏感，但实际上很容易出现：

```
company-payment-system-rewrite
TencentInternalAgent
Project-X-Confidential
```

因此第一版建议一律不采集。

* * *

# 8. 推荐第一版 Telemetry 原则

建议确定以下十条不可突破的规则。

## 规则 1：默认关闭

默认：

```
Telemetry = OFF
```

而不是：

```
Telemetry = ON
```

* * *

# 9. 明确 Opt-in

安装时询问：

```
Anonymous Usage Statistics

Would you like to help improve Dynamic Workflows
by sending anonymous usage statistics?

Collected:

✓ Plugin version
✓ Workflow started/completed/failed
✓ Execution duration bucket
✓ Agent count bucket

Never collected:

✗ Prompts
✗ Source code
✗ File contents
✗ File paths
✗ Project names
✗ API keys
✗ LLM responses

Telemetry is OFF by default.

Enable anonymous telemetry? [y/N]
```

默认选择：

```
N
```

用户直接回车：

```
Telemetry OFF
```

* * *

# 10. 未授权前保持零网络请求

这是一个非常重要的设计要求。

用户没有明确选择：

```
Yes
```

之前：

> Telemetry 系统不得发送任何网络请求。

包括：

```
不能发送 anonymous ping
不能发送 install event
不能发送 disabled event
不能发送机器信息
```

即：

```
Opt-in
   ↓
之后才允许联网
```

* * *

# 11. 第一版应该采集什么？

建议只保留四个核心事件：

```
workflow_started

workflow_completed

workflow_failed

workflow_aborted
```

已经足够计算：

```
Workflow Runs

Weekly Active Installations

Successful Active Installations

Success Rate

Runs / Active Installation
```

* * *

# 12. 建议事件 Schema

例如：

```
{
  "event": "workflow_completed",
  "weekly_id": "a7f3c92...",
  "plugin_version": "0.9.0",
  "execution_type": "background",
  "duration_bucket": "10-30s",
  "agent_count_bucket": "5-10"
}
```

不要发送：

```
{
  "workflow_name": "...",
  "project_path": "...",
  "script": "...",
  "prompt": "...",
  "agent_response": "...",
  "error_message": "..."
}
```

* * *

# 13. 尽量使用 Bucket，而不是精确数字

例如不发送：

```
duration_ms = 18342
```

而发送：

```
duration_bucket = "10-30s"
```

建议：

```
<10s

10-30s

30-60s

1-5min

>5min
```

Agent Count 同理：

```
1
2-5
5-10
10-20
20+
```

这样：

> 产品分析价值基本没有下降，但用户指纹特征进一步降低。

* * *

# 14. 不推荐永久 Installation ID

原始方案可以生成：

```
installation_id = UUID
```

并长期保存。

这样可以计算：

```
7 Day Retention
30 Day Retention
MAU
Cohort
```

但它存在一个问题。

即使 UUID 没有姓名：

> 后端仍然可以长期识别“这是同一个安装实例”。

对于一个刚开始建立社区信任的开源 Coding Tool，这没有必要。

* * *

# 15. 推荐 Weekly Rotating Anonymous ID

更加稳妥的方案：

```
Local Random Secret
        +
Current Week
        ↓
      HMAC
        ↓
   Weekly ID
```

例如：

```
Week 39

local secret
+
2026-W39

↓

a7f3c92...
```

同一周：

```
Run 1 → a7f3c92
Run 2 → a7f3c92
Run 3 → a7f3c92
```

因此可以计算：

```
Weekly Active Installations
```

下周：

```
2026-W40
↓
81bd04...
```

ID 自动变化。

服务器无法简单将两周的数据关联起来。

* * *

# 16. Weekly ID 方案的数据能力

可以获得：

```
WAU                         ✅

Workflow Runs               ✅

Runs / WAU                  ✅

Successful WAU              ✅

Success Rate                ✅

Version Distribution        ✅
```

暂时放弃：

```
7-Day Retention             ❌

30-Day Retention            ❌

MAU                         ❌

Long-term User Journey      ❌
```

当前阶段这是一个合理交换：

> 少一点数据能力，换取更好的隐私与社区信任。

* * *

# 17. Telemetry 必须可以完全关闭

建议提供：

```
opencode-dynamic-workflows telemetry status

opencode-dynamic-workflows telemetry enable

opencode-dynamic-workflows telemetry disable
```

同时支持环境变量：

```
OPENCODE_DYNAMIC_WORKFLOWS_TELEMETRY=0
```

这样对于：

```
企业环境
CI
离线环境
安全敏感环境
```

可以强制关闭。

Homebrew 也提供明确的 analytics 状态检查、关闭命令和环境变量控制，这是成熟 CLI 工具中值得借鉴的模式。

* * *

# 18. 推荐增加 Telemetry Debug

增加：

```
opencode-dynamic-workflows telemetry debug
```

允许用户查看：

> 插件到底准备发送什么。

例如：

```
{
  "event": "workflow_completed",
  "weekly_id": "a7f3c92...",
  "plugin_version": "0.9.0",
  "duration_bucket": "10-30s",
  "agent_count_bucket": "5-10",
  "background": true
}
```

这样用户可以自己验证：

```
没有 Prompt
没有源码
没有路径
没有项目名
```

Homebrew 同样提供 Analytics Debug 能力，用于查看 analytics 请求。

对于开发者社区，这会明显提升可信度。

* * *

# 19. Telemetry 永远不能影响 Workflow

这是技术层面的硬要求。

错误实现：

```
await telemetry.track(...)
```

如果 Analytics 服务出现：

```
网络断开
DNS Failure
API Timeout
PostHog Down
Server Error
```

用户 Workflow 可能受到影响。

这是不能接受的。

正确原则：

```
Workflow > Telemetry
```

即：

> Telemetry 永远是辅助能力。

* * *

# 20. 推荐行为

Telemetry 应该：

```
Async
Fire-and-forget
Short Timeout
Silent Failure
No Retry Storm
```

例如：

```
void telemetry.track(event).catch(() => {})
```

即使 Analytics 服务完全挂掉：

```
Workflow
Agent
Parallel
Pipeline
Background Run
```

必须正常执行。

Homebrew 的 Analytics 同样采取后台发送、短超时以及分析失败不阻塞正常命令的设计。

* * *

# 21. Telemetry 代码应该集中管理

推荐：

```
src/

  telemetry/
    index.ts
    config.ts
    identity.ts
    events.ts
    transport.ts

  tools/
    workflow.ts
    background-runs.ts
```

业务代码只允许：

```
telemetry.track("workflow_completed", ...)
```

而不能直接知道：

```
PostHog
HTTP Endpoint
API Key
Identity Strategy
```

优点：

```
容易审计
容易关闭
容易删除
容易换 Analytics Provider
容易测试
```

同时也让开源用户可以直接：

```
打开 src/telemetry/
```

检查全部 Telemetry 行为。

* * *

# 22. README 必须明确披露

建议在 README 比较靠前的位置增加：

## Anonymous Telemetry

```
Dynamic Workflows includes optional anonymous
usage telemetry.

Telemetry is disabled by default and requires
explicit opt-in.

We collect only aggregate product usage such as:

- workflow started/completed/failed
- plugin version
- execution duration bucket
- agent count bucket

We never collect:

- prompts
- source code
- file contents
- file paths
- project names
- API keys
- LLM responses

Check status:

opencode-dynamic-workflows telemetry status

Disable:

opencode-dynamic-workflows telemetry disable
```

不要把这一部分藏在：

```
README 最后一屏
Privacy Policy 第 20 条
```

透明本身就是社区信任的一部分。

* * *

# 23. 第三方 Analytics 风险

如果使用：

```
PostHog
Amplitude
Mixpanel
Google Analytics
```

那么还增加一个新的风险：

> 用户数据会发送给第三方。

即使内容是匿名的，一些企业开发者也可能对此敏感。

因此推荐架构：

```
Workflow
   ↓
Telemetry Interface
   ↓
Transport Adapter
   ↓
Analytics Backend
```

业务代码不能依赖：

```
PostHog SDK
```

这样未来可以：

```
PostHog
↓
Self Hosted
↓
Own API
```

而不影响 Workflow Runtime。

* * *

# 24. 为什么不建议第一版追求 Retention

如果为了算：

```
7-Day Retention
30-Day Retention
```

需要长期识别：

```
User A
```

这必然引入：

```
Persistent Identifier
```

对于当前项目阶段，收益暂时小于风险。

当前真正需要回答的其实只是：

> 1301 npm Downloads 中，有多少真正运行了 Workflow？

所以第一阶段只需要：

```
Weekly Active Installation
```

即可。

* * *

# 25. 第一阶段 North Star Metric

建议项目当前最重要指标从：

```
npm Downloads
```

逐渐转向：

> **Weekly Successful Workflow Users / Installations**

定义：

```
最近 7 天内
至少成功完成一次 Workflow
的匿名 Weekly ID 数量
```

辅指标：

```
Workflow Runs

Runs / WAU

Success Rate

Plugin Version Distribution
```

这样就可以得到：

```
npm Weekly Downloads
        1301
          ↓

Weekly Active Installations
         210
          ↓

Successful Active Installations
         185
          ↓

Workflow Runs
        2100
```

比单纯 npm Downloads 更接近真实产品使用。

* * *

# 26. 社区风险评级

综合判断：

### 不做 Telemetry

```
隐私风险        ★
社区风险        ★
产品数据能力    ★
```

最安全，但无法知道真实活跃用户。

* * *

### 永久 ID + 默认开启

```
隐私风险        ★★★★
社区风险        ★★★★
产品数据能力    ★★★★★
```

数据能力最强，但不适合项目当前阶段。

* * *

### Opt-in + Permanent Anonymous ID

```
隐私风险        ★★
社区风险        ★★
产品数据能力    ★★★★
```

已经比较合理。

* * *

### Opt-in + Weekly Rotating ID

```
隐私风险        ★
社区风险        ★
产品数据能力    ★★★
```

这是当前最推荐的平衡点。

* * *

# 27. 推荐最终方案

第一阶段采用：

```
Privacy-first Anonymous Telemetry
```

具体要求：

1. Telemetry 默认 OFF。
2. 首次安装明确 Opt-in。
3. 默认选项 `[y/N]`。
4. 未授权前零 Telemetry 网络请求。
5. 不采集 Prompt。
6. 不采集代码。
7. 不采集文件内容和路径。
8. 不采集项目名称。
9. 不采集 Workflow Script。
10. 不采集 LLM Output。
11. 不采集 API Key / Token。
12. 不保存永久用户 ID。
13. 使用 Weekly Rotating Anonymous ID。
14. duration 和 agent_count 使用 Bucket。
15. 提供 telemetry status。
16. 提供 telemetry enable。
17. 提供 telemetry disable。
18. 提供 telemetry debug。
19. 支持环境变量彻底关闭。
20. Telemetry 网络失败永远不能影响 Workflow。
21. Telemetry 源码集中在独立目录方便审计。
22. README 公开说明全部采集字段。
23. 如果未来扩大采集范围，需要重新明确说明。

* * *

# 28. npm 下架最终风险判断

按照上述方案：

> **因 Telemetry 本身被 npm 下架的风险很低。**

npm 的核心红线在于恶意代码、spyware、隐私侵犯等行为，而不是正常、透明、获得用户选择的产品分析。

反过来，如果未来出现：

```
秘密收集数据
上传源码
上传 Prompt
上传凭据
绕过用户关闭设置
刻意隐藏网络请求
```

不仅会造成社区信任问题，也可能进入 npm 对恶意/spyware 行为关注的范围。

* * *

# 29. 最终风险结论

对于 `opencode-dynamic-workflows`：

**建议加入 Telemetry。**

但目的应该限定为：

> 判断有多少用户真正使用 Workflow，以及 Workflow 的基础运行情况。

而不是：

> 尽可能收集用户行为。

当前最合适的路线是：

```
npm Downloads
        ↓
GitHub Traffic
        ↓
Privacy-first Telemetry
        ↓
Weekly Active Installations
        ↓
Successful Workflow Users
```

暂时不追踪：

```
用户是谁
用户使用什么项目
用户写了什么 Prompt
用户执行什么 Workflow
用户跨月行为
```

等项目未来达到明显规模，并且确实出现：

```
Retention
Cohort
长期用户生命周期
```

等产品分析需求时，再单独设计第二阶段 Telemetry。

* * *

# 30. 最终建议

当前 Telemetry 第一版应该坚持一个核心原则：

> **Collect the minimum data necessary to answer a specific product question.**

对应到本项目：

> 我们只想知道“有多少人在真正使用 Dynamic Workflows、运行多少次、成功率如何”。

因此只收集回答这些问题所必需的数据。

这既能够解决目前 npm Download 无法代表真实用户的问题，也能尽量避免给项目带来隐私、社区信任和平台合规风险。

**推荐风险等级：低风险，可实施。**

前提是严格遵循：

> **Default OFF + Explicit Opt-in + Minimum Data + Transparent + Auditable + Easy Opt-out**

这份可以直接作为后续 Telemetry 功能的**设计前置评审文档**。下一步开发时，最好让实现方案逐条对应报告第 27 节的 23 条要求，这样开发完成后还能直接拿它做验收 checklist。