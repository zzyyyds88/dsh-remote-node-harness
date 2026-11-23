# 节点侧重写设计（2026-11-23）

> 状态：**已实施（批 0–批 5 全部落地）**。本文是 `docs/adr` 级的设计文档，按 AGENTS §6
> 「大任务先改设计并单独提交 `docs:`」写成；实现逐批落在本文的 §九 顺序上。
>
> 三层验收结果与遗留项见 `packages/dsh-remote-node-harness/docs/ACCEPTANCE.zh.md`
> 的 2026-11-23 一节；实现后的形状摘要见 `docs/ARCHITECTURE.md` §六之九。
>
> 真源优先级不变：`docs/GOAL.zh.md` > 本文 > `docs/ARCHITECTURE.md` > 其他。
> 本文只回答「为什么必须重写、重写成什么形状、按什么顺序」；具体取舍的历史理由仍归 ADR。

## 〇、实施结果（2026-11-23 收尾）

批 0–批 5 全部落地，共 16 个提交。**批 0 的 12 条阻断缺陷**全部先复现再修，
每条都有会在修复前变红的测试。三层验收（真节点 `probe-93`）：

| 层 | 结果 |
|---|---|
| offline | **27 passed, 0 failed, 0 skipped** |
| contract | **3 passed, 0 failed** |
| e2e | **15 passed, 0 failed, 2 skipped**（两个 skip 带原因） |

批 2 之后又补了一批，因为「office 那类缺陷不再复发」这个目标在批 2 时只覆盖了 office 一个实例：
**凭据本身也是能力的一部分**，而「某个能力需要某把 key」这件事原来没有任何地方可以声明。
补上后，`web_search`（`tool-web` 挂在三个预设里、需要 `DEEPSEEK_API_KEY`、而非 DeepSeek
桌面推送 `[]` 个 ref）成为这个结构的第二个实例，且现在会在三处被检查：离线对账、
生成物派生一致性、连接期报告。

**没有做完的**（都写进了 ACCEPTANCE 的「没有验证到」）：手机端渲染、真机跨版本升级、
真实浏览器失败态、`dropPackages()` 的键空间不对称、macOS 无 procfs 的降级路径。

## 一、问题的真实形状

用户的判断是「节点端做得太烂，修了几百遍」。这个判断在**现象**上成立，在**归因**上需要修正一次：
反复修的**不是同一个 bug**，而是同一类结构缺陷不断长出新 bug。

2026-11-16 至 11-22 的 141 次提交里，真正落在节点生命周期（`src/remote/` + `packages/rnh-brain`）的只有 6 次，
其中 3 次是 fix。也就是说：**节点侧被改得很少，却被反复报告出问题**。原因不是没人修，是
「节点有什么能力」被拆成了 26 处互相不校验的声明（§三），每一处都能独立漂移，
而漂移只在真机第一次调用时才暴露。

本轮（11-23）对全部自有代码做了逐行审计：`src/` 35 个文件 14 857 行、`test/` 42 个套件 10 089 行、
`scripts/` 6 个 1 834 行、`packages/rnh-brain` 9 个文件 1 336 行。审计结论在 §二 与 §三。

## 二、本轮实证的缺陷

只列**已复现**或**有确定代码路径**的。复现方式写在「证据」列，不写「疑似」「可能需要验证」。

### 2.1 会毁数据 / 让节点不可用

| # | 缺陷 | 证据 | 严重度 |
|---|---|---|---|
| A1 | 安装失败的回滚会把**好的现役树**换成**更旧的备份**：`installScript` 在换目录前就 `rm -rf .previous` 再 `mv runtime .previous`（`artefact.js:639-641`），而 `rollbackScript`（`:741-754`）无条件 `rm -rf runtime && mv previous runtime`。校验和/解包/形状/可执行位四类失败都发生在换目录**之前**，此时 `runtime` 完好、`.previous` 是上一版 → 一次下载失败把节点降级。 | 真节点复现：造 `runtime=v2-good`、`runtime.previous=v1-old`，跑 rollback 脚本 → `runtime=v1-old` | 阻断 |
| A2 | 传输层超时/断链**根本不进回滚**：`await connection.exec(installScript)` 一旦 reject，`daemon.js:434` 的 code 判断与 `:441` 的回滚都不执行。而换目录窗口（三条语句）若恰好被杀，节点会**没有 runtime**、旧树孤零零在 `.previous`。安装超时预算给解包只留 60 s（`:422-426`），而解包要对 268 MiB / 1.7 万文件逐个 fork `chmod`。 | 代码路径确定；`exec` 的 `finally` 只清进度 | 阻断 |
| A3 | `POST …/reinstall` 把运行中 host 的 runtime 整体换掉，但**不重启 host、不更新 status**（`index.js:292-319`）：磁盘上是新树、内存里是旧树，`serving` 仍指向旧进程。 | 代码路径确定 | 阻断 |
| B5 | 首次连接必然装插件失败：`pluginInstallScript` 用 `printf '…{}}\\\\n'` 写 `package.json`，双重转义使文件尾是**字面 `\n`** 而非换行 → 不是 JSON → `npm install` 报 `EJSONPARSE`。第二次 connect 因 manifest 被 `writeProfileBundles` 重写而「自己好了」，所以只在第一次出现、只表现为「插件没生效」。 | 真节点复现：`cat -A` 显示 `{}}\n`，`npm error EJSONPARSE … position 65` | 阻断 |

### 2.2 静默失败 / 伪成功

这一类是「显示已就绪，实际不可用」的机制来源，也是用户体感最差的一类。

| # | 缺陷 | 证据 |
|---|---|---|
| B1 | 凭据推送失败仍置 `CONNECTED`（`rnh.js:535-540`）：卡片是绿的、`session/list` 通，第一条 prompt 才失败。而 `provision.js` 的模块注释明写这正是它要消除的故障。 | 代码路径确定 |
| B2 | `ensureServing` 只看日志里有没有 `dsh web:` 子串，**不看退出码**（`daemon.js:904-909`）：`setsid` 缺失、`cd` 失败都可「成功」，只要日志恰好含旧 URL。而 `probe` 明明探过 `setsid`（`:192,250`），没人用。 | 代码路径确定 |
| B7 | `status.json` 里 `profile` 写死常量 `NODE_PROFILE`（`daemon.js:923`），比较却用 `layout.profileName`（`:880`）。**非默认 root**（`~/.dsh-fleet` → profile `rnh-dsh-fleet`）永远判「形状不对」→ 每次 connect 都停/起一次 host。 | 真节点实测：`status.json` = `"profile":"rnh"`，而宿主 cmdline 是 `--profile rnh-dsh-fleet` |
| B8 | `pkill` 兜底模式把 `dsh-remote-node-harness/runtime/...` 写死（`daemon.js:945`），不随 `remoteRoot` 变；非默认 root 的 host 永远杀不到，而 status 照样被删。 | 代码路径确定 |
| D1 | **重连阶梯被自己清零**：`#scheduleRecovery` 先 `#cancelRecovery`（`rnh.js:637`），后者把 `recoveryAttempts = 0`（`:676`），随后才读 `attempt`（`:638`）→ 延迟恒为 2 s；4 s / 8 s / 120 s 全是死代码；对一台关机的机器**每 2 秒**重连一次，且每次失败都重写整个 `nodes.json`。 | 离线复现：连续 6 次排程得到 `2000,2000,2000,2000,2000,2000`，期望 `2000,4000,8000,120000,…` |
| D2 | 恢复失败后状态停在 `failed`（`rnh.js:552` 的 catch），与注释（`:604-609`「阶梯期间 state 恒为 idle、不报红」）矛盾：第一次重连失败后卡片就变红并弹最后一次失败。 | 代码路径确定 |
| D3 | **agent 认证的节点永远连不上**：`put()` 只在 password/privateKey/passphrase 存在时写记录（`rnh.js:346`）；即便显式 `secrets.write({kind:'agent'})`，`hasValue` 判定（`secrets.js:77`）也把它当空值**删掉** → `credentialsReady()` 恒 false → 抛 `credential-missing`。而 `rnh-control.js:183` 向用户承诺「将走 SSH agent」。 | 离线复现：kind=agent → `put()` 不写、`write()` 删记录 |
| D12 | **brain 版本闸门是死的**：`decideGate` 的 `nodeBrain` 读 `runtime.provision?.brainVersion`（`rnh.js:432`），而 `provision` 对象（`:526-534`）**从不写这个字段**；全仓只有读、没有写 → 恒 `undefined` → 恒返回 `GATE.REFRESH`。`GATE.CURRENT` 与「节点被别的桌面装新了要拒绝」这条保护**不存在**；每次 connect 都多一次无谓的 bundle 全量重写。 | 全仓 grep 确认；`provision` 构造点只有三个字段 |
| E1 | **错误帧被降级成正常结束**：`#onCarrierText` 对 `type:'error'` 先 `stream.finish()`（内部调 `onEnd()`）再 `handlers.onEnd(frame.error)`（`remote-gateway.js:373-377`）。`AsyncQueue.fail` 因已 `closed` 直接 return（`routing.js:118-119`）→ 消费者看到的是 EOF，不是错误。 | 代码路径确定 |
| E2 | `remote-waterfall` 直接改上游实例内部字段（`gateway.pendingRemoteEvents.set` / `deliverRemoteEvent` / `cancelRemoteEvent`），**无能力探测**；上游一改名就是未捕获的 rejection，远程回合静默挂到节点自己的超时。 | 代码路径确定 |
| E3 | `lookups.js` 的两个 lookup 覆盖**失败时静默 return**（`failed` 被 `void` 丢掉，`overrideAgentLookup` 连记都不记）：provider 晚注册 → 所有 `workspaceFiles/*` 与 `terminal/*` 的远端调用答 `lookup-not-found`，**没有一行日志**。 | 代码路径确定 |
| E4 | `rnh-control.js` 的 `shapeNode` 把 `failure`（机器可读 code + 可执行动作）、`phase`、`transfer`、`serving`、`droppedAt` 全部砍掉：agent 调 `status` 只能拿到一句英文 `error`，「卡在哪一步、还能不能重试」在代理层被削平。 | 代码路径确定 |
| E5 | 客户端把 `failed + phase` 这一格**不渲染**（`client.js:1546` 要求 `connecting`）：后端特意在失败时保留 `phase` 与 `phaseStartedAt`（`rnh.js:552-562` 有长注释说明为什么），前端一个条件把它作废。 | 代码路径确定 |
| E6 | 安装进度恒为 0：`archiveFor` 把 `~` 拼进单引号字符串（`transfer-progress.js:105-109`），而单引号里的 `~` **不展开**；安装脚本那侧用的是 `$HOME` 展开后的路径。 | 代码路径确定（shell 语义） |

### 2.3 节点能力声明：office 只是第一个可观测量

| # | 事实 | 证据 |
|---|---|---|
| C1 | `trim-fork-runtime.mjs:173` **保留** `@deepseek-ai/dsh-office-kit`，同一文件 `:188` 的 `DROP_RULES` **删除** `^libreoffice-kit`；而 `office-kit` 的 `dependencies` 里就写着 `@deepseek-ai/libreoffice-kit`，`lib/index.js` 用 `import.meta.resolve` 去解析它。 | 真节点调用必然抛 `LibreOffice Kit is not installed.`；`import.meta.resolve` 实测 `ERR_MODULE_NOT_FOUND` |
| C2 | 组合层同时宣告 `office_render` / `office_convert` / `office_recalculate`（`dsh-tool-office/lib/index.js:402/455/474`），且 `tool-office` 行在 `presets/standard.patch.yml:133` 与 `presets/ptc.patch.yml:134` 里**未被 disabled**。 | 节点 `--dump-config` 确认行在、未禁用 |
| C3 | **`RETAINED` 今天一次都没起作用**：4 条中 0 条命中任何 `DROP_RULES`。这些包活着是因为「没有规则匹配它们」，不是因为「被保留」。所以「保留机制」从未被验证过，坏掉也没人发现。 | 离线复现：0/4 命中 |
| C4 | 守住 C1 的那条断言查错了关系：`fork-runtime-unit.mjs:62` 检查「被保留的名字是否命中删除规则」（同名集合交叉），而真实失效是「被保留的包**依赖**的包是否被删」（依赖闭包交叉）。且它的夹具 `packageIn()` 只写 `{name,version}`，**不写 dependencies**，所以即使改对关系也抓不住。 | 代码路径确定 |
| C5 | 键空间有 4 种：组合用**行 id**（`office-kit`）、打包用**包目录名**（`dsh-office-kit`，无 scope）、`RETAINED` 用**包全名**（`@deepseek-ai/dsh-office-kit`）、报告用**包全名**。`dropPackages` 用裸名匹配规则、用全名查 RETAINED（`trim-fork-runtime.mjs:228-229`），测试却用 `name.slice('@deepseek-ai/'.length)`——**测试与运行时喂给同一份规则的不是同一种输入**。 | 代码路径确定 |
| C6 | 生成链无门禁：`BRAIN_FILES['cordis.patch.yml']` 与源文件已漂移 1 行注释（源 `MCP server fleet` / 嵌入副本 `MCP server rnh`），`check-composition` 只读源文件、`embed` 不校验、CI 全绿。 | 子代理实测 7 个条目中 1 个 STALE |
| C7 | 节点固定组合有**三份**互不引用的答案：`rnh.js:30 BRAIN_BUNDLES`、`sync-switches.js:26 NODE_BASE_BUNDLES`（硬编码字符串）、`daemon.js:62 WEB_PROFILE_BUNDLES`。且 `plugin-sync.js:23-26 UPSTREAM_BUNDLES` 含 `dsh-web-app`，与 `BRAIN_BUNDLES`（节点绝不含它）**直接冲突**。 | 代码路径确定 |
| C8 | 有 4 个包因为 `dsh.bundle.patch` 是**数组**而恒被读成 0 行：`rowsOfBundle()` 要求字符串（`sync-switches.js:47-48`），而 `rnh-brain/package.json` 与上游 `web-app` 都是数组。结果插件页对这些 bundle 显示 0 行、「开关带来哪些行」的校验对它们无效。 | 代码路径确定 |
| C9 | 6 处**能力在行层被减法删掉、在包层仍留在盘上**（合计 4.8 MiB）：`dsh-client-hmr`、`dsh-client-modules`、`dsh-host-directory-picker*`、`dsh-harness-dev-context`、`dsh-host-open-in-app`、`dsh-session-log-export`、`dsh-client-product-analytics`、`dsh-host-product-telemetry-otel`。`DROPPED` 按行管、`DROP_RULES` 按包管，两者没有同一把尺子。 | 子代理 staging 树实测 |
| C10 | `@deepseek-ai/dsh`（metapackage，默认保留）的 91 条依赖里有 **16 条**命中 `DROP_RULES`（`dsh-experimental-*` / `dsh-cua-bundle`）。今天不炸，只因为上游闭包走查对「声明了但没装」是跳过而不是报错。 | 子代理实测 |

### 2.4 边界与协议

| # | 缺陷 | 证据 |
|---|---|---|
| F1 | `browse.js` 的哨兵协议是「stdout + stderr 拼起来做无锚点正则」：目录名里含 `RNH_BROWSE_HOME=` 就能伪造；文件名含换行会造幻影条目；非 UTF-8 名字被解码成 U+FFFD；`find` 缺失时 stderr 被 `2>/dev/null` 吞掉、管道退出码是 `head` 的 0 → **返回「存在但为空」的目录**。 | 代码路径确定 |
| F2 | 路径穿越检查只在一处（`browse.js:260` MISSING 分支），且有 `//` 漏洞（`'//' !== '/'` 成立 → 归一化成 `/` 返回「根可确认」）；`makeRemoteDirectory`/`ensureRemoteDirectory` 完全**不查 parent 里的 `..`**，而 `ensureRemoteDirectory` 的注释声称「`..` 无法逃逸」。`decodePickerPath` 也不折叠 `.`/`..`。同一语义散在三处、各管一段。 | 代码路径确定 |
| F3 | 传输层四个上限全缺：`httpOverSsh` 无超时（且 `asSocket` 把 `setTimeout` 变成 no-op）、响应体无上限（一个 500 MB 的 `readBytes` 会打满桌面内存）、`ws.js` 无累计缓冲上限、`multipart` 无 part 大小上限。 | 代码路径确定 |
| F4 | `ws.js` 只处理未分片消息，`encodeControl` 在长度 ≥126 时位模式冲突会发出**损坏帧**（PONG 回显不截断到 125 字节即触发）。 | 代码路径确定 |
| F5 | `remoteRoot` 只校验「非空字符串」，随后**不加引号**插入 `sh -c`（`daemon.js` 十余处 `mkdir -p ${run}` / `cd ${runtime}` / `rm -f ${status}`）。带空格就崩，带 `;`/`$( )` 就是远端命令注入，入口是设置页。`artefact.js:547` 的 `quote()` 也不转义内部单引号，而同一仓库 `transfer-progress.js:39` 有正确实现却没被复用。 | 代码路径确定 |

### 2.4b 核心与接线层（最后一批审计补上的，含一条实测）

| # | 缺陷 | 证据 |
|---|---|---|
| G1 | **换过主机密钥的节点，唯一有用的按钮永不出现**：ssh2 拒绝 host key 时的错误文本是字面量 `Host denied (verification failed)`（`node_modules/ssh2/lib/protocol/kex.js:1210`），而 `connection.js:93` 的正则只认 `/host key\|hostkey\|man-in-the-middle\|fingerprint/` → `classifySshError` 归 `unknown` → `classifyFailure` 按阶段（`probe`）归成 `ssh-network`，`retryable: true`。界面显示「连不上那台机器 / 检查网络 / 重试」，点重试无限循环。 | 本地实测 `classifySshError` → `unknown`、`sshCategory=unknown`、`classifyFailure(phase=probe)` → `ssh-network/check-network/retryable:true` |
| G2 | **`nodes.json` 只坏一个字段，整张节点表静默清零**：`#load` 在读取失败、解析失败、任一 `normalizeNode` 校验失败时都置 `[]`（`registry.js:188-203`），而下一次任何 `put/remove/recordOutcome` 都会把这张空表写回（`:205-217`）。无 `.corrupt` 备份、无告警。 | 代码路径确定 |
| G3 | **校验错误返回 500 而不是 400**：`normalizeNode` 的 8 处裸 `Error`（`registry.js:58-72`）没有 `code`，`describeFailure` 兜底 500/`rnh-failed`。同类还有 `rnh.js:443`（把 `node-ahead` 语义丢成裸 `Error`，最后显示成「运行时装不上」；而 `index.js:309` 的 reinstall 分支是对的——两条路径不一致）、`rnh.js:519/522`。 | 实测：`normalizeNode({name:''})` → `{"status":500,"code":"rnh-failed"}` |
| G4 | **「某个命名空间没被路由」的唯一证据走 `console.log`**（`index.js:601/606/613`、`decorators.js:264/266`）：不进 Host 日志、不参与脱敏。而 `index.js:580-584` 的注释正好在警告这种静默，紧接着 559-572 就有 4 处用同一模式。 | 代码路径确定 |
| G5 | `daemon.js:790/802/736/927` 把 `layout.profile` / `manifestPath` / 包名直接插进 `sh -c`；同仓 `connection.js:612-623` 有正确的 `quotePosixArgument`、`browse.js:390-404` 用位置参数 `sh -c '… "$1"' _ <path>` —— 说明不是做不到，是没复用。 | 代码路径确定（与 F5 同源） |
| G6 | 两套 teardown 所有权：`disposers` 数组与 `ctx.effect` 同时持有同一批回调（`index.js:744-762`），卸载时双重 dispose，靠 `catch {}` 掩盖。 | 代码路径确定 |
| G7 | 死路由：`POST /workspaces/:id/rename`（`index.js:464`）与 `PATCH /nodes/:id`（`:239`）全仓无调用方；`provideRnhControl`（`rnh-control.js:287`）、`secrets.describe`（`secrets.js:91`）、`requiresProvisioning`、`jumpHost`、`auth.secretRef` 同理。 | 全仓 grep 确认 |
| G8 | `node-control` 的 schema 说 `auth` 用于 add **和 update**（`node-control/index.js:157`），但 `update` 分支（`:206-221`）根本不往下传 `auth` —— 模型按描述改凭据会「成功」却没改动任何东西。 | 代码路径确定 |

### 2.5 死代码与重复实现（重写时要一并收掉）

- `ChangeSignal`（`routing.js:194`）、`sessionStream` / `workspaceEndpoint` / `encode` / `toFailure` / `SESSION_REQUEST_KEYS`（`router.js`）、`installedVersionScript` / `installedBuildScript`（`artefact.js:669,683`）、`uninstallPlugins`（`daemon.js:733`）、`SecretStore.describe`（`secrets.js:91`）、`PROVISION_FAILURES`（`daemon.js:993`）——全部无消费者。
- 两套读版本的实现（`artefact.js` 读 `package.json` vs `daemon.js` 读 CLI `--version`）。
- 两套错误词汇：`errors.js` 的 `ERROR_CODES` 与 `daemon.js` 的 `PROVISION_FAILURES`。
- 四份「跳过非纯对象」的遍历判定：`routing.js:80`、`router.js:237/282/307`。
- `mergeControlStream`（`remote-control.js:275`）与 `mergeWorkspaceStream`（`decorators.js:335`）逐行同构，约 150 行重复。
- 四个 `Remote*` 模块各自重写同一套骨架（`Map<nodeId,X>` + 单飞打开 + 断流重开 + 吞监听器异常），其中 `remote-workspaces` 的单飞**是坏的**（两次并发 `sync()` 会开两条 follow 流并互相踩）。

## 三、根因：三条，不是三十条

### 3.1 「节点有什么能力」没有单一真源

同一件事被声明在 6 组 26 处：组合行、预设行、`RETAINED`、`DROP_RULES`、`provision` 复制白名单、`package.json` 的 `dsh.bundle.patch`；外加 3 份节点固定组合、4 份 bundle 名、2 套错误词汇、4 种键空间。
**没有任何一处做交叉校验**，而唯一试图校验的那条断言（C4）查错了关系，且夹具把关系删掉了。

office 是这个结构的直接产物：保留 driver、删除 engine、宣告工具，三件事分别由三个不同文件决定，各自都「有理」。

### 3.2 「一次安装」不是一个事务

失败处理被切成两半：shell 知道字节与目录的真相，JS 知道版本与状态；两半各自补齐了「自己那半」的回滚，而中间那个窗口（换目录、传输被杀、status 与进程不一致）**没有任何一方负责**。
后果就是 A1/A2/A3/B2/B7/B8：回滚降级、孤儿进程、磁盘与内存两棵树、status 撒谎。

### 3.3 失败默认不出声

一个连接尝试有 5 个阶段、二十来个可失败点，其中至少 11 处把失败翻译成「看起来正常」：
凭据推送失败仍 CONNECTED、`stop()` 丢弃结果、`ensureServing` 不看退出码、回滚失败被 `.catch(()=>undefined)` 吞、`syncConfig` 失败不改状态、错误帧降级成 EOF、`find` 缺失当空目录、lookup 覆盖失败静默、`decorators` 的方法名不存在静默跳过、`remote-workspaces` 的 `open()` 失败静默、客户端的 `.catch(() => undefined)`。

各文件头注释反复写「静默本地作答是必须消灭的失败模式」——**文档与实现相反**。

## 四、重写的形状（一）：能力单一真源

新增 `packages/rnh-brain/capabilities.mjs`，**无依赖、纯数据 + 少量纯函数**，是全仓唯一允许出现 `@deepseek-ai/` 字面量的地方。

```js
/**
 * 一个能力 = 节点上「存在」的一整条链：要哪些行、要哪些包、宿主有何前提、怎么判定可用。
 * 缺任何一项就整项关掉，而不是关一半。
 */
export const CAPABILITIES = Object.freeze([
  {
    id: 'remote-host',
    verdict: 'required',          // 缺了拒绝连接，不许半活
    rows: ['web-startup', 'webserver', 'connection', 'api-remotes',
           'session-controller', 'workspace-controller', 'workspace-files',
           'job-controller', 'terminal-controller', 'settings-controller',
           'plugin-inventory', 'agent-preset-registry'],
    replaces: { 'web-runtime': 'brain-runtime' },
    packages: ['@deepseek-ai/dsh-web-app'],
    manifestOnly: ['@deepseek-ai/dsh-web-app'],   // 只留 manifest 的例外要写出来
    host: { node: '>=22' },
    probe: () => true,
  },
  {
    id: 'office',
    verdict: 'optional',          // 缺了就不宣告，不是宣告了再失败
    rows: ['office-kit', 'skill-office'],
    presetRows: { standard: ['tool-office'], ptc: ['tool-office'] },
    packages: ['@deepseek-ai/dsh-office-kit', '@deepseek-ai/dsh-tool-office',
               '@deepseek-ai/dsh-skill-office', '@deepseek-ai/libreoffice-kit',
               '@deepseek-ai/libreoffice-kit-{platform}'],
    host: { executable: ['dsoffice'] },
    probe: tree => resolvableIn(tree, '@deepseek-ai/libreoffice-kit'),
    offReason: '节点不带 Office 引擎（wasm 载荷 145 MiB）；工具不宣告，而不是宣告了再失败',
  },
  {
    id: 'browser-surface',
    verdict: 'never',
    rows: ['web-runtime', 'modules', 'client-hmr', 'directory-picker', 'open-in-app',
           'session-log-download', 'product-analytics', 'desktop-product-telemetry',
           'harness-dev-context'],
    packages: [],
    offReason: '节点不渲染任何窗口',
  },
])
```

关键新增：**`verdict` 是今天完全缺失的一类字段**。所有现存声明只回答「在不在」，没有一处回答「在但能不能用」。
`required` 未满足 → 拒绝启动（与 `decideGate` 同级）；`optional` 未满足 → 组合与预设里都不出现，`check` 打出 `office: off (reason)`，桌面显示「该节点无 Office」，**模型目录里根本没有这些工具**。

派生方向（下游一律不许手写名单）：

| 派生物 | 从哪派生 | 替代掉 |
|---|---|---|
| `cordis.patch.yml` 行集 | `⋃ rows(required + 满足的 optional) − ⋃ rows(never)`；`replaces` 生成 `brain-runtime` | `sync-from-upstream.mjs:95-105,158-161` |
| `presets/*.yml` | 照抄上游后**减去**未满足能力的 `presetRows`，并断言「预设里每个 name 的包都在 `⋃ packages` 里」 | `:267-279` 整文件照抄 |
| trim 的 keep 集 | **计算**：`⋃ packages(启用)` + 从这些包 manifest 走出的**运行时闭包**（`dependencies`，不含 `devDependencies`；`peerDependencies` 只进显式白名单） | `:169-176` 手写 4 条 |
| trim 的删除集 | **集合差**：staging 全集 − keep 集；理由来自 `capability.offReason` | `:185-197` 11 条前缀规则 |
| `provision` 复制白名单 | `⋃ rows(启用) ∩ copyableRows()` | `provision.js:34,39` |
| 节点固定组合（三处） | 由 `remote-host.rows` + `BRAIN_PACKAGE` 导出**一份** | `rnh.js:30` / `sync-switches.js:26` / `daemon.js:62` |
| 报告 | `capabilities.lock.json`（`id → {state, rows, packages, build}`）随 embed 下发 | 无 |

门禁（这次必须让 office 变红，而不是靠人眼）：

1. **闭包回验**：`dropPackages` 之后、`archive()` 之前，对每个启用能力执行 `probe`，并对每个组合行的 `name` 在树内 `import.meta.resolve` 一次；任一失败 → 抛错并点名 `capability + specifier`。
2. **禁手写派生物**：CI 跑 `sync && derive && embed` 后 `git diff --exit-code` 必须为空；lint 禁止 `capabilities.mjs` 之外出现 `@deepseek-ai/` 字面量。
3. **对称性**：每个 `verdict:'never'` 断言「行不在**且**包不在盘上」（今天只做到前半，所以有 4.8 MiB 死包）。
4. **双向闭包测试**：`fork-runtime-unit` 改成「keep 集里每个包的 runtime dependencies 都在 keep 集里（除 `manifestOnly` 白名单）」，且夹具必须写真实 `dependencies`——否则测试又会被夹具骗过。
5. **可执行性先于宣告**：`tool-office` 这类行只在 `probe` 为真时才进 `presetRows`。

## 五、重写的形状（二）：安装是一次事务

### 5.1 从「两次 mv + 第二份回滚脚本」到「符号链接 + 一代目录」

```
~/.dsh-remote-node-harness/
  runtime            -> runtime.7          （符号链接，唯一的「现役」答案）
  runtime.7/         （解包完成、已打戳）
  runtime.6/         （上一代，保留 1 代用于回滚）
  run/{pid,status.json,host.log}
```

一个脚本 = 一个事务：

1. 解包到 `runtime.<n+1>.incoming`；
2. 校验、修可执行位、形状检查**全部在 incoming 里完成**；
3. 打戳到 incoming；
4. 最后一步只有一条语句：`ln -sfn runtime.<n+1> runtime`（原子）。

于是：

- 任何失败**根本不触碰 `runtime`** → **不需要 JS 回滚**，A1/A2 整类消失；
- 「回滚」= `ln -sfn runtime.<n> runtime`，是同一种操作，不是第二份脚本；
- 清理有上限：保留 1 代，其余 `rm -rf`（今天 `.previous` 无界占 268–408 MiB）；
- 「传输被杀在换目录窗口」不再可能：窗口只剩一条 `ln`。

`RUNTIME_BUILD` 与「树是谁打的」之间要有机器可验证的绑定：**archive 的 sha256 进发布清单**（JS 常量，随插件版本走）。今天的戳只能证明「谁写了戳」，不能证明「树是谁打的」。

### 5.2 shell 与 JS 的边界

- **脚本是静态模板文件**，打包进包，通过 `stdin` 发送，`sh -s -- <arg…>` 传参。所有路径/版本/URL 都是 argv 或环境变量，**JS 端不再拼 shell 文本**——这一条同时消灭 F5 整类（引号、`remoteRoot` 注入）。
- **返回值是最后一行 JSON**：`{"ok":false,"code":"CHECKSUM_MISMATCH","want":"…","got":"…","stage":"verify"}`；脚本用 `trap` 保证任何退出都打印它。JS `JSON.parse(lastLine)`，失败归 `UNKNOWN` 并带尾部 600 字节原文。退出码只做兜底，**不再承载语义**（替掉今天的「退出码 + stderr 哨兵子串」，那套靠命名规避子串碰撞）。
- **JS 只做决定，shell 只做执行**：版本/戳/gate 判定全在 JS；下载/解包/chmod/`ln`/`kill`/`npm install` 全在 shell；中间的翻译层就是那条 JSON。
- **进程身份**：`/proc/<pid>/cmdline` 含 `--profile <name>` 且 starttime 与 status 记的一致，才算「是我们的」。替掉今天的「`kill -0` 活着就算活着」+ pid 复用风险（B7/B8）。

### 5.3 重试与超时是一张表

今天 `daemon.js` 有 19 处写死的 exec 超时（15/20/30/60/120/180/300/600/1860 s），`artefact.js` 有下载的 `15/2/4096/60/1800`，`connection.js` 有 `3/400ms`，`rnh.js` 有 `2/4/8/120s`，客户端有 `2000/1500/1000ms`。
重写后：按 step 查一张表，plan 阶段就把「这次要做什么、每一步的预算、失败后做什么」算出来。

## 六、重写的形状（三）：状态是一个判别联合

今天是 `state`（4 值）+ `phase`（5 值）+ `error` + `failure` + `serving` + `droppedAt` + `recoveries` + `recoveryAttempts` + `transfer` + `gate` + `provision` 等 15+ 个可变字段，靠「有值才展开」拼成一个隐式联合类型，跨字段不变量由客户端各自补救。

```js
status =
  | { kind: 'idle' }
  | { kind: 'connecting', phase: { name, startedAt }, transfer? }
  | { kind: 'connected', service: { port, token, pid, version }, via, socketGeneration }
  | { kind: 'recovering', droppedAt, attempt: 0|1|2|'steady', nextAt, lastError? }
  | { kind: 'failed', phase?, error, failure }
  | { kind: 'stopping' }
  | { kind: 'terminated' }
```

可断言的不变量（每条都能单测）：

1. `phase !== undefined ⇔ kind === 'connecting'`（消除「connecting 期间 serving 仍非空」与 reinstall 越权写 phase）；
2. `serving !== undefined ⇔ kind === 'connected'`；
3. `error !== undefined ⇔ kind === 'failed'`（drop/recovering 不带 `error`，原因放 `recovering.lastError`）→ 消除「idle + 残留 error 渲染红色失败块」；
4. `droppedAt !== undefined ⇔ kind === 'recovering'`（disabled 时显式转 `idle` 或 `failed(disabled)`，消除永久「正在重连」）；
5. `attempt` 是 `recovering` 的载荷，**取消/重排 timer 时绝不重置它**（D1 的根修）；
6. 状态变更只经一个入口 `dispatch(event)`；`put` / `reinstall` / `#onDrop` / HTTP API 只能投递事件。

`reduce(status, event, ctx)` 返回 `{ status, effects[] }`，`effects` 是显式列表（`publish` / `armTimer` / `cancelTimer` / `invalidateSocket` / `resetGateway` / `stopResidentHost` / `persistOutcome` / `scheduleNextAttempt`），由一层 interpreter 执行；测试里换成 spy 即可断言「第 3 次尝试排程 8000 ms」这类今天测不到的语义。

`describe()` 从 `status` **纯函数投影**，输出带判别字段 `kind`；agent 工具面复用同一个投影（不复用就必然再次被削平，见 E4）。

## 七、重写的形状（四）：失败只有一个出口

一条规则：**每条远端能力都必须暴露 `state`，`catch(() => undefined)` 禁止出现在能力路径上**。
`sync()` 只允许吞「节点已不在集合里」这一种；其余一律 `state = offline` + log + 计入 `capabilities.lock.json`。

具体到今天的 11 处静默：全部改成显式失败或显式状态，不允许第三种。

错误模型只用一张表（删掉 `PROVISION_FAILURES`）：`code → { userAction, retryable, escalateAfter }`。
`retryable` 的语义从「原因分类」改成「下一次尝试会做什么不同的事」：
`ARTEFACT_UNAVAILABLE` 可重试（会重下）、`CHECKSUM_MISMATCH` 不可重试（同一字节，动作是换源/重发）。
`userAction` 必须是界面里**真实存在**的按钮，否则删掉（今天 `upgrade-node` / `upgrade-desktop` / `inspect-log` 三个动作既无按钮也不展示文字）。

## 八、模块边界

```
src/
  capability/        capabilities.mjs 的加载与 lock 生成（新）
  gateway/           envelope.js（纯编解码）+ carrier.js（生命周期）+ policy.js（重试/超时）
  transport/         http-over-duplex.js、ws/frame.js（纯编解码）+ ws/client.js、multipart.js
  browse/            script.js（静态脚本 + argv）+ parse.js（结构化结果）+ policy.js（路径合法性，list 与 mkdir 共用）
  identity/          encode/decode + mapIdentities（一份遍历器）
  streams/           AsyncQueue + remoteIterable + mergeGenerations（一份合并实现）
  patch/             decorateMethods（还原 original descriptor 全量；未命中必须返回清单）
  remote/
    state.js         status 类型 + reduce + 不变量（纯）
    gate.js          纯判定
    plan.js          Decision → steps[]
    steps/           probe / fetch / unpack / install / provision / start / stop / verify（每步可单测）
    progress.js      纯算术 + 路径解析（用远端展开后的绝对路径）
  client/
    store.js         单一轮询/订阅 + inflight 去重
    node-view.js     kind/phase/failure/transfer → 视图模型（纯，可单测，覆盖全部组合）
    components/*     按职责拆，单文件 ≤ 300 行
```

删除（**已全部执行**，每一项都先用 `git grep -w` 确认过零消费者）：`ChangeSignal`、`sessionStream`、`workspaceEndpoint`、`toFailure`、`SESSION_REQUEST_KEYS`、`workspaceIdOf`、`installedVersionScript`、`installedBuildScript`、`uninstallPlugins`、`PROVISION_FAILURES`、两份重复的合并流实现（收敛成 `host/merge-stream.js`）。
`encode` 保留：`toRemote` 的递归遍历在用它（第 282 行），设计里把它列成死代码是**误判**，以代码为准。
`SecretStore.describe` 也保留：`recovery-ladder-unit` 用它断言「agent 凭据写进去之后读得到」，
设计里同样列错了。

`decorators.js`（1083 行）拆成 `session / workspace / workspace-files / terminal / job / misc` 六个声明表 + 少量真逻辑；`directoryPicker` 的视图模型（约 170 行）搬去 `picker-listing.js`；`terminal/attach` 的双向泵抽成通用 `pipeUplink`。
`decorators-extra.js` 的 8 个命名空间收敛成 `wire.js` 里的一张声明表（约 140 行样板归零）。
`client.js`（2346 行）拆成约 12 个文件，`node-view.js` 单独可测。

## 九、执行顺序（每批独立可验收，不许跳批）

**批 0：止血（不改变架构，1 天内可完成）**

1. 修 G1（host-key 判定不再依赖 ssh2 文本：在 mismatch 分支给 error 打标，或按 `level==='handshake'` + `/host denied/i` 补规则 + 单测）——这条是**唯一让用户卡死在无限重试里**的界面缺陷；
2. 修 G2（`nodes.json` 解析失败先改名 `.corrupt-<ts>` 再置空，别让下一次写把证据抹掉）；
3. 修 G3（`normalizeNode` 的校验错误带 `code:'node-invalid'` → 400；`rnh.js:443` 给 `node-ahead` 打标）；
4. 修 D1（阶梯 attempts 移入 `recovering` 载荷，`cancelTimer` 只清 timer）；
5. 修 D3（agent kind 可写入、`credentialsReady` 对 agent 返回 true）；
6. 修 B5（`printf` 的转义）；
7. 修 A1（rollback 加「当前 runtime 是否可用」判据，或先改成不动 runtime）；
8. 修 C1 的对外表现（节点不宣告跑不了的 office 工具）。

批 0 的验收：`fork-runtime-unit` + 新增 `recovery-ladder-unit`（假时钟断言 2/4/8/120 s）+ `errors-unit` 补 host-key 文本一条 + 真节点一次首连。

**批 1：闸门（让同类 bug 以后自己变红）**

9. `fork-runtime-unit` 改成依赖闭包检查，夹具写真实 `dependencies`；
10. 加 `check-capabilities.mjs` 做「26 处声明 vs 注册表」对账（先只打印不失败，拿到真实差异表）；
11. 加「CI 跑 `sync && embed` 后 `git diff --exit-code`」；
12. 加一条测试把 `client.js` 的 `T.failures`/`T.actions` 键集合与 `ERROR_CODES`/`ERROR_ACTIONS` 绑起来（现在靠人肉同步）。

**批 2：能力单一真源（§四）**

13. 落 `capabilities.mjs` 数据（先把今天 26 处抄进去当现状快照）；
14. 切 trim 的 keep 集到派生 + 闭包回验；
15. 切 presets 到「照抄 + 减」；
16. 收敛三份 `BRAIN_BUNDLES` 与四份 bundle 名；
17. 删 `RETAINED`（它今天 0 命中，保留机制事实上从未生效，改成派生的 keep 集合差）。

**批 3：安装事务化（§五）**

18. 脚本走 stdin + JSON 结果通道（先只改 `installScript`，顺手消灭 F5/G5 的引号类）；
19. 符号链接 + 一代目录，删 `rollbackScript` 与 `daemon.js:438-444` 的分支；
20. 进程身份校验（B7/B8）；
21. 进度路径（E6）与 npm bootstrap（B5 的正式解）。

**批 4：状态机（§六）**

17. `state.js` + `gate.js` 纯函数，`rnh.connect` 改成 reducer + effects（不改 shell，先消除 B6/D12/A3 这类不一致）；
18. `describe()` 从 status 投影 + agent 工具面复用；
19. 客户端 `node-view.js` 覆盖全部组合（含 `failed + phase` 这一格）。

**批 5：边界与协议（§七 + §八）**

20. `http-over-duplex` 的超时/上限；`ws/frame` 纯编解码 + 控制帧长度修复 —— **已做**；
21. `browse` 结构化协议 + 路径策略下沉 —— **已做**（`posix-path.js` 是唯一折叠处，
    `browse.js` 换成 `type\0value\0` 记录 + NUL/base64 名字块，`browse-protocol-unit`
    在真实 shell 上跑真实脚本，含 marker 形状的目录名、换行、非 UTF-8、缺 `find`）；
22. 错误唯一出口 + 一张错误表 —— **已做**：错误帧不再退化成 EOF（`error-frame-unit`），
    词汇只剩 `src/core/errors.js` 一张表（`PROVISION_FAILURES` 已删）；
23. 合并流与四个 `Remote*` 骨架收敛 —— **合并流已做**（`host/merge-stream.js`，生命周期归一处，
    `detach()` 幂等，`merge-stream-unit` 20 条断言）；**`decorators.js` 的按命名空间拆分未做**
    （仍约 1010 行、18 个 `decorate*` 函数），记在 ARCHITECTURE 的「仍然开着的口子」里。

## 十、验收判据

- **分层**（沿用项目现有分层，不新增层级）：offline（现 27 个）、contract（3 个）、e2e 真节点（17 个）。
- **每条缺陷一个回归测试**，且测试必须在**修复前红**（否则测的不是那条缺陷）。
- **真节点验收**：一台机器从「刚 SSH 连上」到「大脑在答话」，全程走新通道；首连（含插件安装）、升级（含故意制造的校验失败，断言**不降级**）、断线重连（断言 2/4/8/120 s 阶梯与 `attempt` 递增）、reinstall（断言 host 真的重启了）。
- **能力可判定**：能力清单在 `capabilities.mjs` 里带 `verdict`/`host`/`credentials`，
  离线对账断言每一处声明与它一致；**`GET /rnh/api/nodes` 的 `capabilities.lock`
  没有实现** —— 能力状态目前通过 `provision.unmet`（连接期报告）与离线对账可见，
  没有暴露成 HTTP 字段。这是本节唯一没做到的判据，记在 ACCEPTANCE 里。
- **不许用旧的验收结果顶替**：本次重写涉及 `describe()` 字段集与 `state` 值域（新增 `recovering`/`stopping`/`terminated`），属公开 UI/API 契约变更，客户端必须同步改并重新截图。

## 十一、明确不做的

- **不把节点改成「本地发指令、远端执行」的代理**（GOAL §一 已定：大脑必须在节点上）。
- **不镜像/挂载远端目录**（GOAL §七-5）。
- **不改 DSH Go 与 `ds-harness-remote` 两个仓库**（GOAL §七-3；唯一例外仍是 ADR-0008 的产物补丁）。
- **不为了整齐而抽基类**：`rnh-control` 是 agent 工具面，与路由/事件无关，不塞进同一个抽象；`remote-waterfall` 与 `remote-events` 共享的是流不是逻辑。
- **不顺手重构没有缺陷的模块**：`multipart.js` 已接近纯模块模板，只补大小上限；`transfer-progress` 的算术是对的（`transfer-unit` 25 条断言覆盖），只修路径解析。
- **不删除一代备份**：`runtime.<n-1>` 是回滚能力，不是可以省的磁盘。改了符号链接模型之后它只在切换时被读，删了就没有退路。

## 十二、当时的待确认项与最终决定

1. **office 的取舍** —— **用户决定：保留能力、补齐引擎**。已实施：`RETAINED` 加
   `@deepseek-ai/libreoffice-kit`（driver 3.9 MiB）与 `@deepseek-ai/libreoffice-kit-wasm`
   （Linux 引擎 145.3 MiB），删除规则收窄成 `/^libreoffice-kit-(?:win32|darwin)-/`。
   代价是制品变大；收益是三个 office 工具真的能用，而不是被宣告后每次都失败。
   这条改变了 `ADR-0007` 的体积结论与 `ADR-0008` 的裁剪结论（待重述）。
2. **`state` 值域新增三个值** —— 已按兼容优先处理：`recovering` 对外仍报 `idle` + `droppedAt`
   （设置页本来就靠这个组合渲染「已断线，正在重连」），`stopping`/`terminated` 靠客户端的
   未知值兜底。**手机侧仍未验证**，写在 ACCEPTANCE 的「没有验证到」里。
3. **archive sha256 是否进发布清单** —— **未做**。这是发布流程变更（发布时多生成一个清单
   文件），需要单独决定；今天的戳仍只能证明「谁写了戳」，不能证明「树是谁打的」。
   留在 ACCEPTANCE 的遗留项里。
