# 参考实现 04 oc-usage-limits-plugin 实现解析

> 仓库 thirdparties/oc-usage-limits-plugin v1.6.1 MIT 作者 mynameistito
> 定位 纯 TUI 插件 sidebar 展示多家 provider 用量限额 输入框右侧 footer 同步展示
> 需求文档评级 三星 sidebar 加 footer 双插槽参考

---

## 1. 结构与形态

```
src/
  index.ts          入口 default export { id mynameistito.usage-limits tui } satisfies 带 id
  plugin.tsx        插件主体 createUsageLimitsTui 工厂 依赖注入
  components.tsx    BottomUsage 与 UsageLimitsPanel 组件
  coordinator.ts    Effect 轮询协调器 加载配置 拉取 汇总 发布
  providers/        各 provider 的用量拉取实现
  config schema     配置解析
package.json exports 点斜杠 tui 指向 dist 预编译路线
```

入口写法值得注意 satisfies TuiPluginModule 与 { id string } 交集显式声明 id 必填 与本项目 AGENTS.md 第 8 条事实一致 文件源必须带 id。

## 2. 双插槽注册（本插件的核心价值）

```
api.slots.register({
  order 101
  slots {
    session_prompt_right(ctx props) {
      从 api.state.session.messages(props.session_id) 找当前 provider
      返回 BottomUsage footer 小组件
    }
    sidebar_content(ctx) {
      返回 UsageLimitsPanel 完整面板
    }
  }
})
```

- 同一次注册挂两个插槽 sidebar 用 order 101（紧贴 Context 之后）
- session_prompt_right 插槽 props 带 session_id 可定位当前会话
- renderer 内直接读 api.state 取 provider 非响应式 每次宿主重渲插槽时求值

这正对应本项目需求文档 8.4 的畅想 在输入框下方加一行 workflow 状态条。

## 3. 轮询协调器（coordinator 模式）

数据不来自宿主事件 而来自外部 HTTP 用量接口：

- Effect runFork 启动 scoped 协调器循环 加载配置 拉全部 provider 汇总 snapshot
- publish 回调把 snapshot 写进四个 signal states 与 showErrors 与 display 与 lastRefreshAt
- sleep 可注入 测试用假时钟
- api.lifecycle.onDispose 里 Fiber.interrupt 干净停掉

对本项目的启示 若 workflow 状态走文件镜像或 HTTP 轮询通道 这个协调器模式（可注入时钟 加 单飞fiber 加 dispose 中断）是现成范式。

## 4. 渲染组件要点

- UsageLimitsPanel 接收纯数据 props（display showErrors states theme lastRefreshAt）不含 signal 组件保持哑
- 主题色经 resolveTheme 预解析传入 避免组件里访问 api
- 配额条与表格按 warning 阈值变色

组件哑化 与 signal 只活在 plugin.tsx 是与 subagents 单文件约束等价的另一种解法 把响应式边界压到最窄。

## 5. 对本项目的借鉴清单

| 借鉴点 | 应用方式 |
|--------|----------|
| session_prompt_right footer 插槽 | 需求文档 8.4 的 workflow 一行状态条 可低成本加 |
| 协调器 + signal 发布模式 | 文件镜像轮询通道的实现范式 |
| 组件哑化 signal 边界最窄 | plugin.tsx 内聚响应式的另一种风格 与单文件约束互补 |
| satisfies 显式 id | 可借鉴到 src/tui/plugin.tsx 出口写法 |

## 6. 引用说明

- 源码 thirdparties/oc-usage-limits-plugin/src/plugin.tsx 与 index.ts 与 components.tsx
- 插槽类型 thirdparties/opencode packages/plugin/src/tui.ts TuiHostSlotMap 的 session_prompt_right
- 需求文档 8.4 节
