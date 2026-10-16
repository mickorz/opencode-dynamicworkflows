# 跨平台测试与 CI 发布-注意事项

> 来源：v0.8.0 两次发布失败（2026-09-17），根因是 Windows 本地测试全绿、ubuntu CI 失败的平台差异。
> skill 层完整版见 npx-installer 的 reference/pitfalls.md「CI 平台差异」节。

## 核心坑：文件系统大小写敏感性

Linux（CI runner）区分大小写：`SELF.js` 与 `self.js` 是两个文件名；Windows（本地）不区分，`existsSync`/`realpathSync.native` 会归一到磁盘真实名。

自环检查测试用 `./SELF.js` 大小写变体验证归一——Windows 命中"不能调用自身或祖先"，Linux 上 canonical 不等、自环不命中，先被深度检查拦截，报"嵌套深度超限"，断言失败。

**规则**：涉及路径大小写/分隔符/realpath 的测试必须拆平台：

```ts
// 主场景：全平台确定行为（完全相同路径）
test("自环拒绝：child 用相同路径调用自身", async () => { ... })
// 变体场景：仅 Windows 有意义
test("自环拒绝：大小写变体归一", { skip: process.platform !== "win32" }, async () => { ... })
```

## CI 排查通道优先级

1. **本地先跑 CI 等价序列**（typecheck → test → build → tag-版本一致），能复现就别上线查
2. 匿名 GitHub API 60 次/小时限流，重推 tag 后配额常已耗尽——**直接请用户打开 Actions 页贴红色步骤日志**（本轮 1 轮定位，最高效）
3. `npm view <pkg> dist-tags --registry=https://registry.npmjs.org/` 轮询发布结果（成功秒级可见）

## 修复后重发布的正确姿势

CI 测试失败修复合入 main 后，**必须删旧 tag 重打到修复 commit**（仅删重推不换指向 = 重跑旧 commit 必然再失败）：

```bash
git push origin :refs/tags/vX.Y.Z   # 删远端
git tag -d vX.Y.Z && git tag vX.Y.Z <fix-commit> -m "..."
git push origin vX.Y.Z
```

核验 tag 指向用 `git rev-parse vX.Y.Z^{commit}`（`tag -l --format='%(objectname)'` 显示的是 annotated tag 对象本身，非 commit）。

## 本次时间线（供复盘）

- 13:36 tag v0.8.0 首推 → CI npm test 失败（自环用例平台差异）
- 13:48 未定位根因前盲推一次（同样失败，浪费一轮）——**先拿日志再重推**
- 14:11 修复（拆平台用例）+ tag 重打到修复 commit → 14:17 npm 上 0.8.0 ✅
