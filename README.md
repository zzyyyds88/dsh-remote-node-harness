# DSH RemoteNodeHarness

把远程 Linux 机器接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，当成本地工作区用。

```
手机 (DSH Go)  ──P2P──▶  家里的 Windows (DSH + 本插件)  ──SSH──▶  Linux 开发机 (完整 DSH)
```

这是我原本在 ZCode 上的用法，想原样搬到 DSH：手机上通过 `ds-harness-remote` 连到桌面端，桌面端远程连接开发机，人在外面也能写代码。DSH 官方没有这条路，所以有了这个仓库。

![侧栏里本地工作区与远程节点的工作区并列，右边是节点上真实跑出来的会话记录](docs/screenshots/sidebar.jpg)

这台 Windows 上开着 DSH，左边 `Start Menu`、`DSHpl` 是本机工作区，`验收项目`、`rnh-second`、`SCIdream` 这些是节点上的。右边那个会话跑在节点上：`git log`、`read_image`、`grep` 都是节点自己的工具在 `/root/accept-project-1/git-image` 里执行的，路径是 Linux 路径，输出是那台机器的真实输出。

## 远程的工作区，本地的用法

远程工作区出现在侧栏里，和本地工作区并排。点进去新建会话、发 prompt、看输出、开终端，都和本地一样。

差别在工具跑在哪。节点上跑着一个完整的 DSH Host，`bash`、`grep`、`glob`、`git`、`read_image`、PTY、MCP 服务器、skills 全部在那台机器的进程里执行，用的是它的文件系统、它的二进制、它的 shell。桌面端只做三件事：给跨界的身份编码、转发请求、还原结果。

这也是手机端能读到它们的原因：远程会话在 `session/list` 里就是普通行，`ds-harness-remote` 不用知道这个插件存在。

先前试过 `@artenx/dshb` 那条路（把远程目录镜像到本地），五种坏法：

| 你想做的事 | 实际发生 |
|---|---|
| `bash` 里敲 `ls /root/project` | 拿到的是本机的 `/root/project`，或者根本没有这个目录 |
| agent 改远端文件 | 编辑器能读到远端内容，但 `edit`/`write` 落在本地，远端文件一动没动 |
| 看远端截图 | `read_image` 在本机找那个路径，报 "bytes do not decode" |
| `git log` | `fatal: not a git repository`，或者更糟：关于错仓库的正确回答 |
| `grep` / `glob` | 搜的是本地那份副本，远端后来新增的文件永远搜不到 |

原因只有一个：工具进程在本机，它读的就是本机的文件系统。路径翻译、argv 改写、"把远端文件同步到本地再跑"都是在和这个事实对抗。让大脑长在节点上，这些问题不存在，而不是被绕开。

参考了 [ZCode](https://github.com/zai-org/ZCode)：它的远控好用，根本原因是远端有大脑，本地不发每条指令、只连过去用。这个观察定下了整个方案。

## 接线方式

插件不 import 任何 `@deepseek-ai/*`，唯一运行时依赖是 `ssh2`。它站在 DSH 的几处实现细节上，每一处都有测试守着，细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §三。

| 接入点 | 做什么 |
|---|---|
| 实例上的 own property | Gateway 从类原型读 `@Remote` 描述符，dispatch 用 `Reflect.get`。在实例上覆写方法，端点表不变、实现换掉。 |
| `workspaceFileScope` lookup | `rnh_…` 不是本地 Session，覆写后本地 id 原样委派，包装 id 合成 scope。 |
| `lookupStore.resolvers` 的 `agent` 项 | 公开的 `configure` 已被上游占用，直接换 resolver 表那一项。 |
| Gateway 的待处理事件表 | 自己造一条同形 pending 塞进 `pendingRemoteEvents`，投递与结算交给上游。 |
| SSH `direct-tcpip` 上的 HTTP 与 RFC 6455 | 节点不开端口，`/api` 调用和 `$events` 流都跑在 SSH channel 上。 |
| `/rnh/api` 与三个 `*.directoryFlow` 插槽 | 插件的管理面，以及"先选机器、再选目录"的选择器。 |

上游的 `/api`、`/api/remote.mux`、sidebar 槽位一行没改。

### 不改的东西

| 不改 | 说明 |
|---|---|
| DSH 上游 | 不改 Loader 行、不 import `app.asar` 里的东西、不接管 `/api`。升级 DSH 时这套东西跟着走，靠的是上面那几处实现细节的测试。 |
| `ds-harness-remote`（中转插件） | 手机端那侧一行不动。它读到的远程会话就是普通 `session/list` 行，不知道这个插件存在。 |
| DSH Go（手机客户端） | 不动。它连的是桌面 Host，剩下的事都是桌面端做的。 |
| `@artenx/dshb` | 已移除，功能重复。 |

手机端唯一做不到的事是装插件：中转插件的 allowlist 里有 `pluginManager/updateBundle`，没有 install。它负责装好之后连节点。

### 身份是一个字符串

远程的东西跨界时变成 `rnh_<nodeId>_<remoteId>`，比如 `rnh_n0123456789ab_session-1dc98667-…`。一个字符串同时回答"是本地的还是远端的""哪台机器""远端是谁"，不需要第二张路由表。

只改写完整 Session 身份的字符串。用 `startsWith('session-')` 这种宽松判断会命中 `session-log-deepseek/delivery-accepted` 这类事件类型，把客户端渲染的每个事件都改坏。

### 侧栏要活，不只是快照

列表是快照，侧栏靠的是活流。上游客户端订阅两路，本地会话天然在流里，远程会话不在——只合并列表的话，行会"在，但死着"：标题停在 New Session、运行中转圈不转、在节点上新建的会话要等下一次整表拉取才出现。

所以插件还并流两件事：每个节点一条 `$events`（把 `api-session/*` 重发到本机事件总线）和一条 `session/control`（每会话的标题、模型选择、待处理审批标记）。两路都是 Host 级、每连接一条，浏览器侧同样一行没改。

### 节点只当大脑

节点上装的是独立的 DSH，默认加载 Web 组合，服务器上于是多出一整套浏览器插件：56 个 `dsh-client-ui-*` 包、SPA dist 服务、HMR 链、桌面遥测。没有窗口的机器要么空转，要么因为找不到 dist 直接报错。

上游的 6 个 bundle 里没有"大脑"这个形态。我没有 fork 包，而是定制**组合**：节点 profile 组合 `@deepseek-ai/dsh-base` + `@local/rnh-brain`，`dsh-web-app` 那层根本不在组合里，那些包连 import 都不会发生。

`@local/rnh-brain` 的 patch 从**已安装的那个 release** 派生，不是从 master：

```bash
node packages/rnh-brain/scripts/sync-from-upstream.mjs   # 重新派生
git diff packages/rnh-brain/cordis.patch.yml             # 有 diff 就读它
```

第一版从 master 派生，多出一行 `authentication-token`，而 `0.2.2-rc.3` 没发布那个包，节点启动报 `1 entry did not activate`。组合必须描述它要启动进去的那个运行时。

### 模型和密钥由本机下发

组合决定加载哪些插件，不决定用什么模型、用谁的 key。每次连接同步两样：

1. 本机活的 provider 路由、默认模型、权限预设写进节点的 `~/.dsh/profiles/rnh/cordis.patch.yml`。这是节点自有 profile 的配置层，节点宿主会热重载它，所以改完立刻生效，不重启、不断会话。
2. 那些行点名的 key 在本机取值，通过节点自己的 `credentials/set` 推进节点凭据库。

本机订阅自己的 `app-boot/config-reload` 与 `credentials/reference-updated`，本地改配置或换 key 就给所有已连接节点重新下发。

早期版本用 `--patch` 传 overlay，实测它不在 HMR 的监视列表里，改配置必须重启节点宿主。换成节点自有 profile 的 patch 后问题消失，记录见 [`docs/adr-0001`](docs/adr-0001-node-config-carrier.zh.md)。

## 跑过什么

**工具真的在节点上执行**（`e2e/tool-parity`）：agent 自己调用 `read`×2 / `write` / `edit` / `grep` / `glob` / `bash`，全部打 `/root/rnh-second/…` 真实路径，无路径类失败，整份 transcript 里没有 Windows 路径。当初必坏的三个工具（`e2e/tool-git-image`）：

```
git log     → 2de1061 initial commit
read_image  → image/png image, 4x4 px, 75 bytes
grep        → 命中 module.exports
```

**节点确实是个大脑**。下面每个数都能从 `packages/rnh-brain/cordis.patch.yml` 数出来，`check-composition.mjs` 每次重新数：

```
profile bundles    : @deepseek-ai/dsh-base + @local/rnh-brain
本层贡献的行       : 59   (24 条 config 覆写 + 35 条 insert)
派生自官方 web-app : 98 行 → keep 33、丢 9 条浏览器专属、丢 56 条 client-ui
dsh-client-ui-*    : 0
web-runtime        : 0
```

**测试**：47 个套件分三层（offline 27 / contract 3 / e2e 17），`test/run-all.mjs` 一次调度。
最近一次三层全量：纯逻辑 **27 passed, 0 failed**；契约 **3 passed**；端到端在 `rnhtest` Host +
真实 Linux 节点上 **15 passed, 0 failed, 2 skipped in 732.4s**（两个 skip 都带原因：这台桌面没有
第三方插件可切换、没有开 `--remote-debugging-port` 的 Chrome）。跑不了的套件带原因记 SKIP，
不记成通过；`--layer e2e` 一个都没跑成时非零退出。

```bash
node packages/dsh-remote-node-harness/test/run-all.mjs                            # 全部
node packages/dsh-remote-node-harness/test/run-all.mjs --layer offline,contract   # 不需要节点
```


## 安装

在桌面端会话里对 agent 说一句「装远程节点插件」，它自己完成：

```
plugin_manager(action='install_bundle',
  target='https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/v<版本>/greatbaby-dsh-remote-node-harness-<版本>.tgz')
```

也可以自己敲：

```bash
dsh plugin --profile desktop add -w <上面那条 URL>    # 推荐
dsh plugin --profile desktop add -w <仓库绝对路径>/packages/dsh-remote-node-harness   # 开发用
```

**没有 npm 这条路。** 包名 `@greatbaby/dsh-remote-node-harness` 只是清单里的标识，registry 上没有它，也不要发上去 —— 安装只有上面两条：CNB 的 tarball，或本地目录。

旧包 `@greatbaby/dsh-fleet`（0.5.0 / 0.5.1）仍然留在 registry 上，但三个版本都已标弃用，`npm install` 会打出弃用提示指向这里。别装它：里面是 build 2/3 的旧代码，还带已经删掉的 npm 兜底路线。

手机端装不了插件：中转插件的 `HARNESS_REMOTE_ALLOWLIST` 里有 `pluginManager/updateBundle`，没有 install。它负责的是装好之后连节点。

装完要重启一次 DSH，新装 bundle 的客户端半边才会被加载。`engines.dsh` 是 `>=0.2.2-rc.3 <0.3.0`，版本不匹配时安装被拒绝，而不是只组合一半。

从 0.5.x 或更早升级要换的不只是包名 —— 0.6.0 把 `dsh-fleet` 整个改名为 `dsh-remote-node-harness`，`~/.dsh-fleet` → `~/.dsh-remote-node-harness`、`/@fleet` → `/@rnh`、`fleet_` 会话前缀 → `rnh_`。完整对照表与迁移步骤见 [CHANGELOG 0.6.0](CHANGELOG.md)。节点不用手工清，旧目录留着不影响。

## 加节点

**设置 → Remote nodes → 添加**：host、端口、用户、密码或私钥，点连接。首次连接会自动在节点上装同版本 DSH、装大脑组合、下发模型与密钥、启动，然后验证 `session/list` 真的能答。只有它成功才报 connected。

![远程节点设置页：本机是 conductor，下面是已连接的节点与其工作区数量](docs/screenshots/nodes.jpg)

节点要求 Node ≥ 22，以及 `curl`（或 `wget`）。打开第三方插件开关时还需要 `npm`（插件从节点自己的 registry 装进节点的 profile）；运行时本身从不经过 registry。

节点的 DSH 只有一条来路：**下载本项目自己构建的归档**（`dsh-<version>-<platform>.tar.gz`，build 7 实测 58.2 MiB / 25 167 文件 / 61 071 397 字节），只有 CNB 一个源（匿名下载实测 11.7 s，抖动 <1%）。GitHub 不作为下载源——国内节点连不上它，同一份字节仍会传到 GitHub Release 作灾备。

那棵树不是上游发布版，而是本项目从**上游源码的 fork** 编译出来的：删掉浏览器面、Office 引擎与实验性 bundle，再删掉包内没人读的字节（解包 2014.6 MiB → 267.4 MiB）。为什么 fork、代价是什么，见 [`docs/adr-0007-fork-node-runtime.zh.md`](docs/adr-0007-fork-node-runtime.zh.md)。

拿不到制品（CNB 不通、没有 `curl`/`wget`、平台打不出标签）就报错并逐条列出试过的 URL。**没有 `npm install` 兜底这条路了**：它装的是上游树却写同一枚构建戳，一次网络抖动就会把节点永久钉在上游版本上，界面还显示「已就绪」。字节坏了（校验和不符、归档里没有 CLI）同样报错并回滚到上一棵树——「拿不到」和「拿到的是坏的」是两件事。

### 连接会自己恢复

SSH 断开之后状态不再是绿色的 `connected`：卡片落 `idle` 并记时间，写「已断线，正在重连」。重连是阶梯：`2s → 4s → 8s`，之后每 2 分钟一次，直到成功或你点断开。阶梯期间不报错。实测 `systemctl restart ssh` 两秒回来，整机重启 21 s 回来。

失败会分类成 `{code, message, action, retryable, detail}`，界面把 `action` 翻成按钮。密码错不配重试按钮，因为按了只会得到同一次失败。

每个节点自带最近 100 行日志（`/rnh/api/nodes/<id>/log`），写入时脱敏。桌面端总日志混着所有节点和插件，出了问题的人找不到它。

## 加工作区：先选机器，再选目录

侧栏工作区旁的加号，或者新建会话时的「添加工作区」。对话框第一页是设备：

![选择设备：此设备、节点，以及就地添加远程设备的入口](docs/screenshots/picker.jpg)

- **此设备** → 下一页是这台电脑的盘符
- **节点** → 下一页是该节点的根目录 `/`
- **添加远程设备…** → 就地加节点，不用先去设置页

选过的目录记在设备下面，下次直接点「上次使用」。浏览时能新建文件夹、能直接输完整路径；工作区名称可以自己填，留空则用文件夹名。

给两类机器看不同的入口是有意的：这台电脑有盘符，节点的树从 `/` 开始。给节点看盘符、给 Windows 看 POSIX 路径，就是设备这一步要挡住的错。

## 节点上有什么、没有什么

节点是独立安装，所以它有自己的配置。连接时同步的只有三样：**provider 路由、默认模型、权限预设**，加上这些行点名的 key。

不同步的：

| 不同步 | 为什么 | 想要的话 |
|---|---|---|
| **MCP 服务器** | `mcpManager` 的服务器表是每个 Host 自己的 volatile 配置（在设置页里配），没有跨机器下发接口 | 在节点上打开设置页配一次 |
| **你自己装的 skills** | skill 目录由各 Host 用 `node:fs` 扫自己的 `~/.dsh/skills` | 复制到节点的 `~/.dsh/skills` |

节点自带的是运行时装的那些：`dsh-doc`、office 系列 skills、`tool-web`、subagent、workflow、jobs、schedule。预设里的工具集和桌面端一样（`standard` 预设 33 行），差的只是上表这两类个人配置。

## 插件同步

节点是另一台机器，只组合你发给它的东西。**设置 → Remote nodes → 插件同步** 列出你在这个桌面端装的第三方插件，一行一个 bundle，带版本和它贡献了什么。

![插件同步：每个第三方 bundle 一行，默认全部下发，关掉就只在本机运行](docs/screenshots/plugin-sync.jpg)

默认全部下发：装在这里、连了节点，就是同一个工作环境。关掉一个，它只在这台机器上运行。

四个名字永远不下发，不管在哪个列表里：这个插件自身（它的预设带节点管理工具，一个能管理其他节点的节点是不该存在的形态）、大脑 bundle、中转插件的两个包名（一个自己开了第二个入口的节点是没人要的界面）。

开关会真的在节点上装或复制包，然后重写节点的 bundle 列表并重启常驻宿主。回复里逐个节点报结果。测试验的是开关之后节点仍然答得上话，不只是开关返回成功。

## 节点控制模式

新会话可以选「节点管理」预设。那个会话只能查看、添加、修改、连接、断开节点，别的都不行。

这不是提示词让模型自觉：预设的 `config.plugins` 就是那个会话的工具集，而它只列了 `rnh_nodes` 一个工具。没有 shell、没有文件、没有搜索、没有网络、没有子代理、没有 workflow。让它读文件，它会说这个会话只管理节点，并建议你到对应节点的工作区里新建会话。

密钥只接受引用，拒绝内联粘贴：

```json
{"kind":"key","path":"~/.ssh/id_ed25519"}
{"kind":"password","env":"RNH_NODE_PW"}
```

工具参数会写进会话日志，粘一个密码进去就是明文持久化。想直接粘贴就走设置页。

被控节点拿不到这个能力：`NODE_NEVER_SYNC` 把本插件挡在节点之外，所以节点不会变成第二个能管理节点的入口。

## 手机上用

装 `ds-harness-remote`，手机连到这台桌面 Host。远程会话是普通的 `session/list` 行，所以出现在同一个侧栏里。节点的文件系统挤进同一套路径语法：

```
/@rnh                       → 节点列表
/@rnh/<nodeId>/             → 那台机器的文件系统根
/@rnh/<nodeId>/root/proj    → 那台机器上的 /root/proj
```

`directoryPicker/list` 对两类机器都答，用这种路径调 `workspace/create` 会在节点上建工作区。这个前缀是节点的保留命名空间，直接拿它建工作区会被拒绝。

手机端的 `harnessRemoteAllowlist` 是客户端常量，能发哪些端点由它决定，Host 侧放宽没用。已知缺口：它放行 `subagents/interruptByParent`，而 0.2.2 的真实端点是 `subagents/interruptByUser`（rc.5 实测仍是这个名字），所以手机暂时无法中断子代理。

## 升级

DSH 升级之后**第一件事是重建节点运行时**，不是跑测试：桌面端换了版本，节点就没有可下载的制品了，连不上。

```bash
# fork 切到同一个 tag（版本必须完全相等）
cd D:/ProjectHub/dsh-fork/deepseek-harness && git checkout dsh-v<新版本>

# 编译 → 裁剪 → 打包 → 上传（一条命令；只发 linux-x64，见下）
cd D:/ProjectHub/DSHpl
CNB_TOKEN=… node packages/dsh-remote-node-harness/scripts/build-fork-runtime.mjs --platform linux-x64 --publish --cnb
```

**只发 `linux-x64`。** 上传前会查 `src/remote/artefact.js` 的 `PUBLISHED_PLATFORMS`，不在名单里的平台带 `--publish`/`--cnb` 会直接抛错。`win32-x64` 曾经发过，现在撤了：它能构建也能启动，但没有任何节点能向它要 —— 探针读 `uname -s`，Windows 上没有对应拼写，节点侧 21 处 `sh -c` 加 `setsid`、传输只有 SSH。不加 `--publish` 仍可 `--platform win32-x64` 构建（冒烟测试用）。理由见 [ADR-0007](docs/adr-0007-fork-node-runtime.zh.md) §三第 4 条。

然后是组合层和契约层的五条命令：

```bash
node packages/rnh-brain/scripts/sync-from-upstream.mjs          # 从已安装的 release 重新派生组合
git diff packages/rnh-brain/cordis.patch.yml                    # 有 diff 就是上游组合变了，读它
node packages/rnh-brain/scripts/check-composition.mjs           # 断言结果仍然是个大脑
node packages/rnh-brain/scripts/embed-into-rnh.mjs            # 嵌进插件
node packages/dsh-remote-node-harness/test/run-all.mjs --layer offline,contract     # 契约层先炸
```

实测 rc.3 → rc.5：重新生成的组合逐字节无变化，上游只删了 `authentication-token` 与 `ui-session-status` 两行，都在被丢掉的那一侧；契约层 3 个套件全过。

**跟着上游从自动变成了手动**：上游发版、桌面升级之后，节点在新制品发出来之前连不上。这是 fork 路线的代价，不是缺陷。完整步骤（切 tag、重放构建侧修复、什么时候要加 `RUNTIME_BUILD`、裁剪规则的两个坑）见 [`packages/dsh-remote-node-harness/docs/UPGRADE.zh.md`](packages/dsh-remote-node-harness/docs/UPGRADE.zh.md) 第五、六节。三条升级链（DSH / 中转插件 / DSH Go）各自要重跑什么，同一份文档。

## 跑测试

测试要自己给节点，源码里没有默认 IP 和密码：

```bash
export RNH_TEST_HOST=192.0.2.10
export RNH_TEST_USER=root
export RNH_TEST_PASSWORD=...
node packages/dsh-remote-node-harness/test/run-all.mjs --layer e2e
```

## 仓库结构

```
packages/
  dsh-remote-node-harness/        插件：装在桌面端，Host 侧 + 浏览器侧
  rnh-brain/                    节点侧 bundle：只当远程大脑的 DSH 组合
docs/
  GOAL.zh.md        目标本身：做什么、为谁做、什么算达成
  ARCHITECTURE.md   设计与取舍：每个决定否决了什么
reference/          上游源码（只读，不进版本库）
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/GOAL.zh.md`](docs/GOAL.zh.md) | **目标本身**：用户口述的四个目标、使用场景、什么算达成、以后做决定的规则（最高真源） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 路线取舍、五条缝隙、身份编码、连接状态机、SSH 包上限、为什么"不做镜像"是功能 |
| [`docs/adr-0001-node-config-carrier.zh.md`](docs/adr-0001-node-config-carrier.zh.md) | 节点配置走 profile patch 而不是 `--patch` overlay |
| [`docs/adr-0002-approval-terminal-version-plugins.zh.md`](docs/adr-0002-approval-terminal-version-plugins.zh.md) | 审批、终端、版本闸门与插件开关 |
| [`docs/adr-0003-phone-control.zh.md`](docs/adr-0003-phone-control.zh.md) | 手机 → 中转 → 桌面 → 节点这条链路与它的硬边界 |
| [`docs/adr-0004-node-control-and-picker.zh.md`](docs/adr-0004-node-control-and-picker.zh.md) | `/@rnh` 命名空间、选择器接管、节点控制、安装形态 |
| [`docs/adr-0005-release-and-maintenance.zh.md`](docs/adr-0005-release-and-maintenance.zh.md) | 包名依据、发布形态、三条升级链 |
| [`docs/adr-0006-node-runtime-supply.zh.md`](docs/adr-0006-node-runtime-supply.zh.md) | 节点运行时从哪来：制品优先、节点自建兜底 |
| [`docs/adr-0008-relay-artifact-patch.zh.md`](docs/adr-0008-relay-artifact-patch.zh.md) | 手机读远端会话文件：给已装的 `ds-harness-remote` 产物打授权补丁，上游仓库不改 |
| [`reference/README.md`](reference/README.md) | 四份上游源码各是什么、为什么要它、钉住的版本（含手机端 `dsh-Go` 与中转 `ds-harness-remote`） |
| [`docs/agent-install.zh.md`](docs/agent-install.zh.md) | 只靠 agent 装一遍：说什么、走哪条路、断点在哪 |
| [`packages/dsh-remote-node-harness/README.md`](packages/dsh-remote-node-harness/README.md) | 插件安装、接线、测试矩阵、已知限制 |
| [`packages/dsh-remote-node-harness/docs/ACCEPTANCE.zh.md`](packages/dsh-remote-node-harness/docs/ACCEPTANCE.zh.md) | 验收步骤与逐轮实测记录 |
| [`packages/rnh-brain/README.md`](packages/rnh-brain/README.md) | 节点组合：怎么从官方 web-app 减出"只当大脑"的一层 |
| [`packages/dsh-remote-node-harness/docs/UPGRADE.zh.md`](packages/dsh-remote-node-harness/docs/UPGRADE.zh.md) | 三条升级链各自要重跑什么 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么、谁受影响 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 怎么跑测试、怎么构建节点运行时、改代码时的硬约束 |
| [`SECURITY.md`](SECURITY.md) | 威胁模型、主机密钥、凭据与日志的处置 |
| [`AGENTS.md`](AGENTS.md) | 本仓库的协作规则 |

## 许可

[MIT](LICENSE)，Copyright (c) 2026 zzyyyds88。`reference/` 下的上游源码各归其原作者（DSH 是 MIT，ZCode 见其仓库）。
