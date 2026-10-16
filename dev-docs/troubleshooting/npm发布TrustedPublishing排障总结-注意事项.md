# npm 发布问题总结

> 结论（2026-09）：v0.4.0 已成功发布，全链路 GitHub Actions + OIDC + Trusted Publishing。
> 本文档为排障全程记录；沉淀到 npx-installer skill 的条目见其 reference/pitfalls.md「Trusted Publishing」节。

项目：

```text
@mickorz/opencode-dynamic-workflows
```

发布方式最终采用：

```text
GitHub Actions
→ GitHub OIDC
→ npm Trusted Publishing
→ npm publish
```

最终已成功发布。

---

## 1. `--access` 参数写错

最开始使用：

```bash
npm publish --access publish
```

出现：

```text
npm warn invalid config access="publish"
Must be one of: null, restricted, public, private
```

原因是 `publish` 不是合法的 access 类型。

公开 scoped npm package 应使用：

```bash
npm publish --access public
```

正确：

```text
--access public
```

错误：

```text
--access publish
```

---

## 2. GitHub Actions 发布时报 E404

之后执行：

```bash
npm publish --access public
```

虽然构建和打包都成功，但发布时报：

```text
npm error 404 Not Found

The requested resource
'@mickorz/opencode-dynamic-workflows@0.3.0'
could not be found or you do not have permission to access it.
```

最开始容易误认为：

- npm 包不存在
- 版本号冲突
- package.json 有问题

实际上都不是。

因为 npm 包：

```text
@mickorz/opencode-dynamic-workflows
```

原本已经存在，并且 `0.2.2` 已经成功发布过。

真正的问题是：

```text
GitHub Actions
        ↓
npm Registry
        ↓
没有通过发布身份认证
```

npm 的 E404 在这种情况下不一定真的表示“资源不存在”，也可能表示：

```text
当前发布身份没有这个 package 的 publish 权限
```

---

## 3. 从 NPM_TOKEN 切换到 npm Trusted Publishing

之前成功的 `0.2.2` 使用的是：

```text
GitHub Secret
NPM_TOKEN
```

流程：

```text
GitHub Actions
→ NPM_TOKEN
→ npm publish
```

后来决定改成 npm 推荐的 Trusted Publishing：

```text
GitHub Actions
→ OIDC
→ npm Trusted Publisher
→ npm publish
```

这样不再需要长期保存一个具有 npm 写权限的 Token。

GitHub Actions 中需要：

```yaml
permissions:
  contents: read
  id-token: write
```

其中最重要的是：

```yaml
id-token: write
```

否则 GitHub Actions 无法生成 OIDC 身份。

---

## 4. npm Trusted Publisher 配置必须完全匹配

npm package 名：

```text
@mickorz/opencode-dynamic-workflows
```

但 GitHub 仓库实际是：

```text
mickorz/opencode-dynamicworkflows
```

特别需要注意：

```text
npm package:
opencode-dynamic-workflows

GitHub repository:
opencode-dynamicworkflows
```

两者名字不同。

Trusted Publisher 必须填写真实 GitHub Repository：

```text
User / Organization:
mickorz

Repository:
opencode-dynamicworkflows

Workflow:
publish.yml
```

不能错误写成：

```text
opencode-dynamic-workflows
```

否则 GitHub 生成的 OIDC Identity 无法和 npm Trusted Publisher 配置匹配。

---

## 5. Trusted Publisher 必须允许 `npm publish`

当前 npm Trusted Publishing 还存在：

```text
Allowed actions
```

因为 workflow 使用的是：

```bash
npm publish --access public
```

所以 Trusted Publisher 必须允许：

```text
npm publish
```

否则即使：

```text
Repository
Workflow
OIDC
```

全部正确，发布仍然会被拒绝。

---

## 6. GitHub Actions 最终认证成功的标志

修正 Trusted Publisher 之后，日志从：

```text
E404
could not be found or you do not have permission
```

变成：

```text
npm notice publish Signed provenance statement
with source and build information from GitHub Actions
```

这句话非常关键。

一旦看到：

```text
Signed provenance statement
```

基本可以确认：

```text
GitHub OIDC           ✅
Trusted Publisher     ✅
npm 身份认证          ✅
```

说明 E404 权限问题已经解决。

---

## 7. OIDC 成功后又遇到 E422

认证解决以后，发布进一步执行，但出现：

```text
npm error 422 Unprocessable Entity
```

具体错误：

```text
Error verifying sigstore provenance bundle:

Failed to validate repository information:

package.json: "repository.url" is ""

expected to match

https://github.com/mickorz/opencode-dynamicworkflows
```

这说明 npm 已经开始进行 Sigstore Provenance 校验。

问题是 `package.json` 中：

```json
"repository": {
  "url": ""
}
```

repository URL 是空的。

而 GitHub OIDC / provenance 中明确记录了来源仓库：

```text
https://github.com/mickorz/opencode-dynamicworkflows
```

二者必须匹配。

最终修改：

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/mickorz/opencode-dynamicworkflows"
  }
}
```

也可以使用：

```bash
npm pkg set repository.type=git
npm pkg set repository.url=https://github.com/mickorz/opencode-dynamicworkflows
```

修改之后重新运行 workflow，发布成功。

---

# 8. 中间还遇到了 `bin` 配置问题

早期日志还有：

```text
npm warn publish npm auto-corrected some errors in your package.json

npm warn publish
"bin[opencode-dynamic-workflows]"
script name dist/cli/index.js was invalid and removed
```

这个问题虽然不会导致 E404，但非常重要。

因为这个项目希望支持：

```bash
npx @mickorz/opencode-dynamic-workflows
```

如果 npm 发布的时候把 `bin` 删除，那么 package 即使发布成功，CLI 也可能无法执行。

最终需要保证：

```json
{
  "bin": {
    "opencode-dynamic-workflows": "dist/cli/index.js"
  }
}
```

并确保：

```text
dist/cli/index.js
```

真实存在。

CLI 文件开头建议有：

```javascript
#!/usr/bin/env node
```

后续日志不再出现：

```text
bin[...] invalid and removed
```

说明该问题已经修复。

---

# 9. `always-auth` Warning 不是发布失败原因

整个过程中一直出现：

```text
npm warn Unknown user config "always-auth".
This will stop working in the next major version of npm.
```

这个只是 npm 新版本对旧配置的 warning。

它不是：

```text
E404
```

也不是：

```text
E422
```

的原因。

所以排障过程中不应该优先处理它。

可以后续单独清理 `.npmrc` / GitHub Actions 生成的相关配置。

---

# 10. 不要因为 publish 失败一直升级版本

排障过程中从：

```text
0.2.2
→ 0.3.0
→ 0.4.0
```

实际上：

```text
0.3.0
0.4.0
```

发布失败时并没有真正进入 npm Registry。

因此这种情况下没有必要继续：

```text
0.5.0
0.6.0
...
```

正确做法应该是：

```text
publish 失败
    ↓
修配置
    ↓
重新运行相同版本的 workflow
```

只要 npm registry 中不存在这个版本，就可以继续发布当前版本。

---

# 最终正确发布链路

最终工作流程：

```text
GitHub Repository
mickorz/opencode-dynamicworkflows
        │
        ▼
GitHub Actions
publish.yml
        │
        │ id-token: write
        ▼
GitHub OIDC
        │
        ▼
npm Trusted Publisher
        │
        │ 验证
        │ user = mickorz
        │ repo = opencode-dynamicworkflows
        │ workflow = publish.yml
        ▼
Sigstore Provenance
        │
        │ repository.url 校验
        ▼
npm Registry
        │
        ▼
@mickorz/opencode-dynamic-workflows
发布成功
```

---

# 这次排障最值得记住的判断方法

以后 npm publish 出问题，可以按照错误阶段快速判断。

### `npm run build` 失败

说明是：

```text
代码 / TypeScript / build
```

问题。

### `npm pack` 阶段 warning

例如：

```text
bin invalid
```

说明主要检查：

```text
package.json
files
bin
dist
```

### `npm publish` 报 E404

而 package 明明已经存在：

优先检查：

```text
npm 身份
Token
OIDC
Trusted Publisher
Repository
Workflow
权限
```

不要首先怀疑包不存在。

### 出现：

```text
Signed provenance statement
```

说明：

```text
OIDC / Trusted Publishing 已经成功
```

这时候不要再排认证。

### 出现 E422 + provenance

例如：

```text
repository.url expected to match...
```

说明已经进入：

```text
Package metadata
vs
GitHub provenance
```

一致性校验阶段。

按照具体字段修 `package.json` 即可。

---

# 最终检查清单

以后发布前可以固定检查：

```text
[ ] package.json version 正确

[ ] package.json repository.url 正确

[ ] bin 指向真实 dist CLI 文件

[ ] npm run build 成功

[ ] npm pack --dry-run 正常

[ ] GitHub workflow 有：
    permissions:
      contents: read
      id-token: write

[ ] Node / npm 版本满足 Trusted Publishing

[ ] npm Trusted Publisher：
    user = mickorz
    repo = opencode-dynamicworkflows
    workflow = publish.yml

[ ] Allowed actions 包含 npm publish

[ ] Publish workflow 不依赖长期 NPM_TOKEN

[ ] npm publish --access public
```

## 最终结论

这次实际上经历了三层问题：

```text
第一层
package 配置
→ bin 配置错误

第二层
发布认证
→ GitHub Actions 无 npm publish 权限
→ 改为 OIDC + Trusted Publishing

第三层
Provenance
→ package.json repository.url 为空
→ 与 GitHub repository 不匹配
```

最终全部解决后：

```text
Build          ✅
Package        ✅
CLI bin        ✅
OIDC           ✅
Trusted Publish✅
Provenance     ✅
npm Publish    ✅
```

## 本项目补充（原文未覆盖的两个实操坑）

**标签触发型 workflow 不会读到标签之后的修复提交**：E422 修好 repository.url 并 push 后，
在 Actions UI 点 Re-run failed jobs 依然失败——checkout 的是标签指向的旧提交，package.json
里 repository 仍为空。正确做法是把标签强制挪到修复提交并重推：

```bash
git tag -f v0.4.0
git push --force origin v0.4.0   # 会自动重新触发流水线
```

**本地 ~/.npmrc 的 granular token 与 CI 无关**：本地 whoami 401 / publish 404 只说明本地 token
没权限，不影响 Trusted Publishing 路径；不要在本地 token 上继续排障，直接看 Actions 日志。