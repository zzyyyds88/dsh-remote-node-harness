# ADR-0008：给已安装的 `ds-harness-remote` 产物打文件授权补丁

> 状态：已采纳（2026-11-22）
> 关联：[GOAL.zh.md](GOAL.zh.md) §五-2、§七-3、§八 第 3 行；[ARCHITECTURE.md](ARCHITECTURE.md) 中转产物补丁章

## 一、问题

手机读「远端会话」里的文件，在链路上被中转挡下：

```
DSH Go ──加密通道──> 桌面 DSH Host（ds-harness-remote）──Typert gateway──> rnh 装饰器 ──SSH──> 节点
```

`ds-harness-remote` 的 `HarnessRemoteBridge.call()` 在 dispatch 前对**读类端点**先做一次本机授权：

- `packages/plugin/src/harness-remote-bridge.ts:377` —— `workspaceFiles/search`
- `packages/plugin/src/harness-remote-bridge.ts:384` —— `WORKSPACE_FILE_READ_ENDPOINTS`（`read` / `readBytes` / `readAll` / `stat`）

两者都先调 `resolveWorkspaceRootForSession(sessionId)`。该函数（`:969-989`）：

1. 用 `resolveWorkspaceRoot` 回调（实现是 `workspace-upload-authority.ts:22` 派发 `session/list`）取该行的 `cwd`；
2. 在 **桌面本机** 上 `realpath(cwd)` 并对结果 `stat`。

rnh 合并进来的远端行 `cwd` 是**节点路径**（`/root/proj`）。本机没有这个目录，`realpath` 抛 `ENOENT`
→ `WORKSPACE_UNAVAILABLE`。即便 `realpath` 侥幸过了，后面 `assertNativeWorkspaceFileCall`
还会对目标文件本身再做 `lstat(candidate)` + `realpath`（`:1024-1067`），同样 `ENOENT`。

**影响面**：手机端点开远端会话的「文件」页、看单个文件、看二进制的图片/PDF，全部失败。
桌面端不受影响 —— 它走 rnh 自己的 `workspaceFileScope` lookup，不经中转。

## 二、被否掉的三个方案

### 方案 1：改中转仓库（`ccch1mneyyy`/`liguobao` 的 `ds-harness-remote`）

- 需要在 `assertNativeWorkspaceFileCall` 加一条「远程会话不做本机授权」的分支。
- 否掉的理由：与上游发版直接冲突（每次上游发布都要重打）；且 GOAL §七-3 已经明确两个仓库不改。
- 补充证据：即使愿意改，用户装的 0.6.6 与上游 0.6.7 也在同一个文件里，双份维护。

### 方案 2：运行时从外部把补丁「包住」

- 理论上最干净：换掉 `HarnessRemoteBridge.prototype` 上的方法。
- 已核实不可行（三条独立证据）：
  1. `dist/index.js` 的尾部 `export { … }` **不含** `HarnessRemoteBridge` —— 类没有导出，拿不到原型；
  2. `ctx.dshRemote` 只暴露 runtime（`syncOptionalService` 里 `ctx.provide("dshRemote", value)`），runtime 上没有 bridge 引用（检索 `this.bridge` 的 4 处命中全在 ACP 的 `AcpWorkspaceTools` 里，与它无关）；
  3. `assertNativeWorkspaceFileCall` 是类私有方法、`resolveWorkspaceRoot` 是构造参数，两者都不可从外部注入。

### 方案 3：在桌面本机放一份远端目录的副本（幽灵目录的加强版）

- 让 `realpath(cwd)` 与 `lstat(文件)` 都能通过。
- 否掉的唯一理由就够：这是 GOAL §七-5 明令禁止的**远端目录镜像**。而且它会引入双向同步问题 ——
  正是本项目从第一天起就否定的代理模型。

## 三、采纳的方案：给已安装的产物打文本补丁

用户 2026-11-22 的选择：**「允许通过本插件对 remote 插件打补丁，如果这个插件自带这个补丁，
如果被安装的机器上有这个 remote，就自动识别就行了，每次在重新启动这个 DeepSeek harness 的时候
都要重新检测」**。

### 3.1 补丁做什么

只做一件事：**`rnh_<nodeId>_<remoteId>` 形式的会话 id 跳过本机授权检查，原样放行给 rnh 装饰器。**

路径安全由节点自己负责 —— 节点按自己的会话头重算 `workspaceFileScope`，`workspaceFiles/{read,
readAll,stat,readBytes}` 的边界检查仍在节点上生效。这与已经路由的 `session/page`、
`terminal/*`、`window/*` 是同一个信任模型：**这个 Host 已经通过 SSH 信任那台节点**，
中转不该再用「本机文件系统」给它出一次证明。

补丁在产物里注入一行判定，并在两处调用点前加一个排除条件：

```js
const __rnhRemoteScope = id => typeof id === "string" && /^rnh_[a-z0-9]+_/.test(id)
```

```js
// 锚点 1（约 4245xxx 处，文件里唯一）
} else if (this.resolveWorkspaceRoot !== void 0 && WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint)) {
+  && !__rnhRemoteScope(requestArgs(nativePayload).workspaceFileScopeId)) {

// 锚点 2（约 4273xxx 处，search 分支）
if (!await this.resolveWorkspaceRootForSession(search.args.workspaceFileScopeId, signal)) {
+ if (!__rnhRemoteScope(search.args.workspaceFileScopeId) && !await this.resolveWorkspaceRootForSession(...)) {
```

锚点键在**源码里同样存在**的标识符上（`WORKSPACE_FILE_READ_ENDPOINTS`、`resolveWorkspaceRootForSession`、
`workspaceFiles/search`），不绑行号、不绑压缩后的变量名。

### 3.2 三条硬约束

1. **锚点必须恰好命中 1 次**。0 次或 >1 次 → 放弃，把「期望几处、实际几处、版本号」写进
   `/rnh/api/nodes` 的 `local.relay` 与日志。部分打补丁比不打更糟：一半会话读不到文件，症状还随端点跳。
2. **写盘只能「新文件 + rename」**。已实测：`profiles/desktop` 与 `profiles/fleettest` 下的
   `dist/index.js` **同 inode、`nlink: 2`**（pnpm 硬链接）。就地写会同时改掉另一个 profile 的副本。
   `rename` 只替换目录项，另一个硬链接仍指向旧 inode。
3. **必须能退**。第一次打之前把原文件复制成 `index.js.rnh-orig`（只在不存在时写），
   sidecar `index.js.rnh-patch.json` 记 `{ version, originalSha256, patchedSha256, anchors }`。
   `revertRelayPatch()` 用它覆盖回去。`.rnh-orig` 永不自动删。

### 3.3 检测与幂等

Host 每次启动（`apply()` 里）执行一次：

| 现场 | 动作 |
|---|---|
| 没有安装 `ds-harness-remote` | 什么都不做，`local.relay = { installed: null, patched: false }` |
| 有 sidecar，且 `patchedSha256` 等于当前文件 sha256 | 已完成，跳过 |
| 有 sidecar，但 sha256 不符 | 中转被升级/重装 → 重新对锚点，命中就重打（先更新 `.rnh-orig` 的 `originalSha256`） |
| 没有 sidecar | 备份 → 打补丁 → 校验 `node --check` → rename |
| 锚点缺失 | 放弃，写 reason，原文件一字不动 |
| 校验失败 | 删临时文件，原文件一字不动，写 reason |

配置 `relayPatch: false` 可整体关闭。

### 3.4 结果可见

`GET /rnh/api/nodes` 的 `local` 块增加：

```json
"relay": { "installed": "0.6.6", "patched": true, "anchors": 2 }
```

或失败时 `{ "installed": "0.6.7", "patched": false, "reason": "expected 2 anchors, found 0" }`。
不只写日志 —— 设置页与验收脚本都要能读到，否则「补丁是否生效」只能靠翻文件。

## 四、代价

- **上游升级会让锚点消失。** 这是设计的一部分：那时补丁自动失效并报出原因，不会静默产生
  「一半端点能读」。上游若自己修了这条，锚点也会消失，正好等于补丁退役。
- **产物文件的字节被改。** `sha512`/完整性校验类工具会看到不一致。sidecar 与 `.rnh-orig`
  的作用就是让这件事**可发现、可回滚**，而不是隐藏。
- **每个 profile 各一份。** pnpm 硬链接被 rename 断开后，两个 profile 各自持有一份
  （一个打过、一个没打），这是刻意的：只有正在跑的那个 profile 需要补丁。

## 五、回滚

```js
import { revertRelayPatch } from '@greatbaby/dsh-remote-node-harness/src/host/relay-patch.js'
await revertRelayPatch({ file: '<profile>/node_modules/ds-harness-remote/dist/index.js' })
```

或用文件系统：`index.js.rnh-orig` 覆盖回 `index.js`。两者等价，前者会顺手清 sidecar。
