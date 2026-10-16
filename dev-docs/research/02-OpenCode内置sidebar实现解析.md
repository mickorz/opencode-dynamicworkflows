# 参考实现 02 OpenCode 内置 sidebar 实现解析

> 源码 thirdparties/opencode/packages/tui/src/feature-plugins/sidebar/
> 定位 宿主自己的 sidebar section 与外部插件走同一套 slots.register API
> 需求文档评级 四星 官方写法基准

---

## 1. 文件清单与 order 占位

| 文件 | 行数 | order | 内容 |
|------|------|-------|------|
| context.tsx | 65 | 100 | tokens 与 cost 与 context 百分比 |
| mcp.tsx | 97 | 200 | MCP server 连接状态列表 |
| lsp.tsx | 65 | 300 | LSP 状态（本机显示 LSPs are disabled） |
| todo.tsx | 49 | 400 | 会话 todo 列表 超过 2 条可折叠 |
| files.tsx | 70 | 500 | 会话 diff 文件列表 |
| footer.tsx | 98 | sidebar_footer | getting started 引导条 |

全部 6 个文件合计 444 行 平均 74 行 说明 slot 插件的官方基线就是极小实现。

## 2. context.tsx 逐段解析（官方最小范本）

```tsx
function View(props { api session_id }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session() 与 cost ?? 0)
  const state = createMemo(() => {
    const last = msg() findLast role 是 assistant 且 tokens output 大于 0
    按 provider 模型上下文上限算百分比
  })
  return box 内四行 text
}
const tui TuiPlugin async api => api.slots.register({ order 100 slots { sidebar_content 返回 View } })
```

要点：

- **createMemo 直接包 api.state 读取** 响应式成立 因为内置插件与宿主共享同一个 solid-js 实例
- theme 用函数包裹访问 保证主题切换也触发重渲
- 插件形态与外部完全一致 default export id internal 前缀 与 tui 两个字段

## 3. todo.tsx 的条件渲染与折叠

- list 空或全部 completed 时整个 section 不渲染（Show when show）
- 超过 2 条才显示折叠箭头 onMouseDown 切换模块内 createSignal
- For each 渲染列表项 复用宿主 TodoItem 组件

对比 subagents-view 的折叠信号是模块级 Map 按 session 缓存 内置插件直接每次渲染新建 signal 两者差异的根因 内置插件的 View 挂载在宿主树里 生命周期与宿主一致 外部插件的 View 可能被反复调用必须自己缓存状态。

## 4. footer.tsx 的插槽类型与 kv

- 注册在 sidebar_footer 而非 sidebar_content slot props 带 session_id
- api.kv.get dismissed_getting_started 持久化关闭状态 kv 落在 .local state opencode kv.json
- api.state.path 与 api.state.vcs 读当前目录与分支

## 5. 对本项目的借鉴清单

| 借鉴点 | 应用方式 |
|--------|----------|
| createMemo 包 state 读取的写法 | 仅内置可用 外部插件跨 solid 副本不可依赖 已验证 |
| theme 函数式访问 | 已采用 保持 |
| Show when 条件渲染整 section | 已采用 无数据不渲染 |
| 官方 order 占位 | 已采用 350 |
| todo 的数量阈值折叠 | workflow 树节点多时可参考 |
| kv 持久化用户偏好 | 未来折叠状态记忆可用 api.kv |

## 6. 引用说明

- 源码 thirdparties/opencode/packages/tui/src/feature-plugins/sidebar/ 六个 tsx
- 插槽 API 类型 thirdparties/opencode packages/plugin/src/tui.ts TuiHostSlotMap 与 TuiSlots
- kv 实现 thirdparties/opencode packages/tui/src/context/kv.tsx 落盘 .local/state/opencode/kv.json
