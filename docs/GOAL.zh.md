# 项目目标（唯一锚点）

> 这份文件是**用户口述目标的正式版本**。以后每一次取舍、每一个"要不要做"的判断，都回到这里对照；
> 对不上的就是偏离，不做的理由必须能指向这里的某一句话。
>
> 真源优先级：本文 > [ARCHITECTURE.md](ARCHITECTURE.md) > 其他 docs。
> 本文只答**做什么、为谁做、做到什么算成**；怎么做在 ARCHITECTURE，历史取舍在 ADR。

## 一、一句话

**把 ZCode 那套「手机上连一台 Linux 机器干活」的体验，搬到 DeepSeek Harness 上。**

ZCode 能做成，根因是**远端有大脑**：本地不发每条指令，只连过去用。这个项目走同一条路 ——
节点上跑一个完整的 Harness（agent、模型调用、工具执行、会话日志都在那台机器上），
桌面端和手机只是**窗口**。不是"本地发指令、远端执行"的代理模型。

## 二、四件事，缺一件就不算做完

### 1. 远程连接 + 远程 Linux 能力，搬进 DSH

参照 ZCode 的远程连接形态，让 DSH 能把一台 LAN 上的 Linux 机器当成工作区用：
工具在**那台机器上**真跑（bash / read / write / edit / grep / glob / git / read_image / PTY），
用它的文件系统、它的二进制、它的 shell。

判据：远端会话里的一次工具调用，执行者必须是节点上的进程，不是本机进程。

### 2. 适配 `ds-harness-remote`（中转插件）

用户装的是 `ds-harness-remote`，手机通过它连桌面 Host。远端会话必须**作为真实的行**
出现在它读的那几个接口里（`session/list` / `session/follow` / `session/prompt` /
`session/page` / `workspace/follow`），**手机端一行都不用改**就能看到远端会话。

判据：DSH Go 的会话列表里出现节点上的会话，点开能看、能继续问、能答审批。

### 3. 在 DSH Go 上，对远程节点**新建工作区**

DSH Go 是**独立项目**（`ccch1mneyyy/dsh-Go`，完整克隆在 `reference/dsh-Go/`，不进版本库），
有完整参考实现。目标是在它上面**在远程节点上新建工作区** —— 不是只能从已有目录里挑，
而是能建出新的。完整链路：

```
DSH Go（安卓） ──中转──> 桌面 DSH Host（装 dsh-remote-node-harness） ──SSH──> 节点大脑（Linux）
```

判据：手机上「添加工作区」，能在节点上落出一个**此前不存在**的目录，成为工作区，并且
能被 DSH Go 正常打开、在其中新建会话。

### 4. 两端同一个侧栏

远端工作区与远端会话与本地混排，不分面板、不分 iframe。桌面端的侧栏、会话视图、
文件查看器、审批、终端、job、goal 全部照常工作 —— 因为它们看的本来就是
`session/list` 与 `workspace/follow` 这两个接口。

## 三、使用者的真实场景（决定了什么算"够用"）

- **桌面端**：Windows 上装 DSH + 本插件，连一台 LAN 内的 Linux 机器（本机已连的节点叫 `probe-93`，
  运行时来源是下载的制品，主机密钥已记录）。日常在这台 Linux 上写代码。
- **手机端**：DSH Go（安卓）通过 `ds-harness-remote` 连回这台 Windows。
- **人不在电脑前**时，用手机继续那台 Linux 上的活：看会话、发指令、看文件改动、答审批。

zcode 方案的既有代价，本项目继承，不打算消除：**桌面那台必须开着且连着节点**。

## 四、已经成立的（有证据的部分）

| 能力 | 证据 |
|---|---|
| 节点上跑完整 Harness（源码级 fork + 自建运行时） | 运行时 build 7 已发布，匿名重下字节校验通过；`RUNTIME_BUILD=7` |
| 插件装进干净 profile 能起来 | `/rnh/api/nodes` 答 200 |
| 三条运行时缝隙仍与上游一致 | 契约层 3/3（读的是真装的 `app.asar`） |
| 网关/流式承载/PTY/双节点/客户端 bundle | 端到端 5/5 在真 Linux 节点上通过 |
| 手机看节点文件系统（`/@rnh` 命名空间） | `picker-flow`（部分通过，见 §五-1） |
| 远端会话混排进本地侧栏 | `host-routing`（未在干净环境验证，见 §五-3） |

## 五、现在挡在目标前面的三处缺口

### 1. 手机上「新建」工作区无路可走（直接影响目标 3）

**链路上两处白名单都只有 `directoryPicker/list`，没有 `directoryPicker/createDirectory`：**

- DSH Go：`packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart:24` 的
  `harnessRemoteAllowlist`（99 条）。
- 中转：`reference/ds-harness-remote/packages/plugin/src/harness-remote-bridge.ts`
  的 `HARNESS_REMOTE_ALLOWLIST`。

于是 DSH Go 侧：

```dart
// packages/dsh_client/lib/src/workspaces_api.dart:115
bool get canCreateDirectories => supportsEndpoint('directoryPicker/createDirectory');
```

在这条链路上恒为 `false`，目录选择页的「新建文件夹」按钮**不渲染**
（`app/lib/ui/workspace/directory_picker.dart:344` 与 `:372`）。

"手输路径"这条路也堵着：`typePath()` 在能浏览时会转成 `browse(path)`
（同文件 `:131-139`），而 `browse` 要调 `directoryPicker/list`；节点上不存在的目录
会直接报错，不会当成"将要新建的路径"接受。

**结论**：手机现在只能挑**已存在**的目录，不能新建。桌面端有路 ——
`POST /rnh/api/workspaces`（`src/index.js` 的 `head === 'workspaces'` 分支，设置页节点行里的输入框）。

### 2. 手机读**远端会话**的文件被中转挡下（直接影响目标 2 的"看文件改动"）

中转在 dispatch 前先 `resolveWorkspaceRootForSession(sessionId)`：让 Host 派发
`session/list`、取该行 `cwd`、再在 **Host 本机** `realpath()`。rnh 合并进来的远端行
`cwd` 是节点路径（`/root/proj`），本机 `realpath` 得 `ENOENT` → 回 `WORKSPACE_UNAVAILABLE`。
受影响端点：`workspaceFiles/{read,readBytes,readAll,stat,search}`。

桌面端点开远端文件不受影响（走 rnh 的 `workspaceFileScope` lookup，不经中转）。

### 3. 「agent 在节点上真干成一件事」还没在干净环境验证过

端到端层最近一次真跑（真 Linux 节点、隔离 home）：**5 passed, 9 failed, 3 skipped**。9 个失败里：

- 5 个是**没有 provider key**（`llm-deepseek: no API key for provider route "deepseek-official"`），
  即"测试自己没配好"，不是产品缺陷；
- 4 个是**测试脚本硬编码 `/root`**，而测试节点的用户 home 是 `/home/rnhprobe`，同样是脚手架缺口。

这 9 个不解决，就只能说"管道通了"，不能说"agent 能在远端干活"。

## 六、判定：什么算达成

**桌面**：连上节点 → 新建或选一个远端工作区 → 在其中建会话 → agent 的 bash/read/write/grep/git
全部在节点上执行 → 侧栏能看到这个会话与这个工作区 → 文件浏览正常 → 审批能答。

**手机**：同一个桌面进程被手机连上 → 会话列表里看到那个远端会话 → 能在**节点上新建一个工作区**
→ 在那个工作区里新建会话并让 agent 干活 → 看得到文件改动 → 能答审批。

两条都跑通、且都有可复现的命令或截图，才叫达到生产力水准。

## 七、以后做决定时的规则

1. **先问它离 §六 更近还是更远。** 不更近就不做，理由写清。
2. **上游源码可以改，但每一处必须进台账**（`packages/dsh-remote-node-harness/docs/node-patches.zh.md`
   + `patches/node/*.patch`）。节点跑的是官方 DSH 源码的 fork，改源码是本项目的主路径。
3. **DSH Go 与 `ds-harness-remote` 两个仓库不改**（2026-11-22 定）。手机链路的能力边界以中转白名单为准；
   白名单之外的能力只能在 rnh 一侧迁就，不能靠改那两个仓库绕过去。
4. **不发 npm、不给 GitHub 留下载源**（运行时由本项目自建并发布到 CNB）。
5. **不做远端目录镜像/挂载**：不给"把远端目录映射到本地再在本机跑工具"的路线留任何接口。
6. 用户明确否定过的概念，从代码、文档、命名里删干净，不许换名保留。

## 八、已定的两个路线分叉（2026-11-22）

| # | 问题 | 用户的选择 | 后果 |
|---|---|---|---|
| 1 | 为了「手机在节点上新建工作区」，改 DSH Go / `ds-harness-remote` 吗？ | **不改，rnh 侧迁就** | 手机端点不到「新建文件夹」按钮（`canCreateDirectories` 恒 false，不改它就是不出现），只能用「输入路径」。所以 rnh 必须让**尚不存在的绝对路径**也能被选择器确认并通过 `workspace/create` 落盘 |
| 2 | 「参照 ZCode」只做「能连上能用」，还是连体验层一起？ | **连体验层一起做** | 连接体验按 `reference/zcode` 的做法落地：错误码 + 主操作、五态展示、阶段进度 + 已用时间、传输百分比/速率/ETA、自动恢复预算、操作日志。调研结论与本项目现状的逐条差距在 `.scratch/research-zcode/FINDINGS.md`（378 行） |

### 第 1 题的实现约束（rnh 侧迁就）

手机现在只能挑**已存在**的目录，因为：

- `directoryPicker/list` 对节点上不存在的路径报错，而 DSH Go 的「输入路径」在能浏览时会转成
  `browse(path)`（`app/lib/ui/workspace/directory_picker.dart:131-139`），报错就停在那里；
- `directoryPicker/createDirectory` 不在中转白名单里，所以「新建文件夹」按钮不渲染。

可用的路只有一条：**让 `directoryPicker/list` 对节点上「路径合法但不存在」的绝对路径返回一个
合法的空层**（路径本身可被确认），而不是报错。于是：

```
输入 /root/newproj → 空层里点确认 → 中转 dispatch 前 mkdir -p 造出本机幽灵目录
  → rnh 的 workspace/create 在节点上 mkdir -p 并登记 → 成功后精确 rmdir 掉本机那条空链
```

这条链上每一步现存都有实现（`pruneShadow`、`ensureRemoteDirectory`、`workspace/create` 装饰器），
唯一挡路的是 `test/picker-flow.mjs` 里我为"不存在的路径必须报错"写的那条断言 ——
它要按目标改成"可建"，并补一条"确实在节点上建出来了"的断言。

### 第 2 题的落地顺序（体验层）

按收益与依赖排，不并行：

1. **错误码 → 文案 → 主操作**：`src/core/errors.js` 已有 `ERROR_CODES`（`retryable` + `action`），
   缺的是客户端的码→中文文案表与"标题 + 原因 + 一个主按钮"的呈现。
2. **阶段进度**：`fleet.js` 式的 `phase` 在 rnh 里已有（连接状态机），缺已用时间、缺"失败时保留阶段"。
3. **传输百分比/速率/ETA**：只有首次连接要下载 58.2 MiB 运行时这一步有可测的进度，从节点日志里解析。
4. **自动恢复预算**：已有 `RECOVERY_LADDER_MS` 与 `RECOVERY_INTERVAL_MS`，缺"第 n/3 次"的展示。
5. **操作日志**：节点自带 `NodeLog` 已有，缺"复制错误详情"。

体验层**不改任何契约**，只在投影层与客户端文案上做，所以它可以和 §五 的三个功能缺口并行推进，
互不阻塞。
