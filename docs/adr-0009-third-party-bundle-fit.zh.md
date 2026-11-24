# ADR 0009：第三方插件在节点上的适用性与外部配置载体

> 状态：已接受（2026-11-24）。用户已确认三点：修法走 **B + C**（插件配置载荷 + 能力声明）、
> 节点记忆库与桌面**同一库 `main`**、犀牛模式那个 bundle 本身**不改**（"我现在只在 Windows 主机用"），
> 要的是**同类问题的通用处理**："如果有真实用户也这样做，程序应该如何处理"。
> 上承 [ADR-0001](adr-0001-node-config-carrier.zh.md)（配置载体是 profile 的 `cordis.patch.yml`）。
> 本文只决定「第三方插件能不能下发、它要的配置谁来送」，不改路由、会话语义与组合本身。

## 一、问题：开关的含义是"它也在那台机器上运行"，但没人核对这句话是否成立

两个真实故障，同一类：

| 现象 | 直接原因 | 结构原因 |
|---|---|---|
| 节点上 `@vectorize-io/hindsight-coding-agents` 装了、组合了，但 `pages/tree`、`memories`、`reflect` **全部 401**，会话从头到尾"没有记忆" | 节点侧没有 `~/.hindsight/coding-agent.json`，插件回退到默认的云端 `apiUrl` 且不带 token | 这个插件的配置在 **bundle 之外**（插件文档原话："configured OUTSIDE dsh, in ~/.hindsight/coding-agent.json"），而 provision 只送模型行与 `DEEPSEEK_API_KEY` |
| 节点上的 `fleet` / `fleet-b` profile 里有 `@local/dsh-rhino-mode`，它的 `mcp-rhino` 行 `command:` 指向 `C:\Users\…\rhinomcp.exe` | 那台节点是 Linux，这个路径不存在 | 开关只看"这台机器装了、开了它"，从不看"那台机器是不是这个平台、这个插件的组合里有没有只在本机成立的路径" |

两件事的共同点不是"哪个包写错了"，而是**声明面与供给面之间少了一次对账**：
开关这一侧声明了"它也运行在节点上"，而节点那一侧从来没有人回答
"它在那里成立吗？它要的东西到了吗？"。这与 office 缺陷同一形状
（见 ARCHITECTURE 六之九）：**一份声明，另一处供给，中间没有比较**。

记忆那一条还多一层：`capabilities.mjs` 是"节点能做什么"的唯一真源，
但它今天**只描述节点自己组合出来的能力**（21 条全部来自 `rnh-brain` 与上游行），
第三方插件一条记录也没有 —— 于是"这个插件在节点上需要一份配置文件"这句话
在全仓没有任何地方能写下来，也就没有任何地方会去核对。

## 二、两类问题，两种处理：一类可推导，一类必须声明

这个区分是本文的核心，因为它决定"真实用户也这么干"时程序的行为。

### 1. 平台不适用 —— **可推导，不需要注册表**

一个插件的组合里如果出现**只在另一个操作系统上才存在的字面量**，它在那台机器上就不是"配置不全"，
而是"不可能工作"。判定不需要用户声明，读插件已经写在盘上的东西就够：

| 检查 | 依据 | 范围 |
|---|---|---|
| `package.json` 的 `os` / `cpu` | npm 标准字段，`npm install` 本来就按它拒绝 | 声明了就用，没声明不猜 |
| 组合文件（`dsh.bundle.patch` 全部文件）里的 **Windows 盘符路径**（`^[A-Za-z]:\\`） | 盘符路径在非 Windows 上不可能存在，且不可能有第二个含义 | 只认盘符；不把 `/foo` 当 POSIX 标记 —— 它在 URL、路由、包内相对路径里到处都是，误报会把正常插件拦掉 |

命中即**不下发**：不 `npm install`、不写进节点的 `dsh.profile.bundles`，
并在 `provision.plugins.skipped` 里留下 `{ bundle, reason }`，
reason 写明**哪个文件哪一行、哪个字面量、节点是什么平台**。

这条**对任何用户的任何插件都成立**，因此不需要为犀牛模式写特例；
用户自己写一个只认 macOS 的插件，接一台 Linux 节点，得到的是同一条拒绝与同一句解释。
反方向（Windows 节点收到的插件带 POSIX 路径）**不做对称判定**：上面已经说明为什么误报代价不对称 ——
拒绝一个能用的插件比放过一个不能用的插件更糟，因为后者只会"工具一调用就报错"，前者是"能力凭空消失"。

### 2. 外部配置文件 —— **不能推导，必须声明**

"这个插件要读 `~/.hindsight/coding-agent.json`"这句话**不在**任何可机读的位置：
不在 `package.json`（它只有 `dsh.bundle.patch`），不在 patch 文件（那里只有一行 `- id: hindsight`），
`plugin.json` 是另一套 harness 生态的清单。没有可靠的推导信号，**硬去猜"home 下哪个文件属于哪个插件"
就是在拿用户的凭据做实验**。

所以这一类走**声明**：`capabilities.mjs` 新增第三方插件注册表，一条记录 = 一个 bundle +
它需要的配置文件（相对节点 `$HOME` 的路径、文件权限、允许下发的键白名单）。
这是"节点能做什么"的一部分：插件被组合上节点，它就成了节点的一项能力，
它的前置条件就该和别的能力一样被声明、被对账。

**键白名单是硬约束，不是优化。** 桌面那份文件里可能还有别的服务器的 token、
别的 bank 的凭据（`banks.<id>.apiToken`）、个人路径；整份复制就是把这些一起送到另一台机器。
只有声明过的键才下发。

### 3. 声明了要，本地没有 —— **不下发，也不组合**

记忆那一条的另一半：如果这台桌面**自己没有** `~/.hindsight/coding-agent.json`，
那么节点拿不到配置，插件在那边就是"起了作用但每次调用都 401"。
`capabilities.mjs` 已有的 verdict 词汇正好管这件事：
`optional` 的含义是"**没有它也行，所以不满足时它必须不出现在组合里，而不是声明了再失败**"。
第三方插件按 `optional` 对待：配置送不到 → 从节点的 `dsh.profile.bundles` 里去掉，
报 `provision.config.unavailable`，而不是让它挂在那里空转。

## 三、决定

| 层 | 位置 | 内容 |
|---|---|---|
| 声明 | `packages/rnh-brain/capabilities.mjs` | `THIRD_PARTY_BUNDLES`：bundle 名、配置文件路径/权限/键白名单、`offReason`；派生函数 `thirdPartyBundle()`、`configFilesOfBundles()` |
| 派生 | `scripts/embed-into-rnh.mjs` | 生成 `BRAIN_THIRD_PARTY_CONFIG`（与 `BRAIN_CREDENTIAL_REFS` 同一条链，一次生成，不手写第二份） |
| 对账 | `scripts/check-capabilities.mjs` | 每条记录形状合法、路径是安全相对路径、键非空、生成物与派生一致 |
| 平台判定 | `src/core/plugin-applicability.js`（新，纯函数） | `manifestPlatforms()` / `hostBoundPaths()` / `nodeApplies()` / `nodeOsOf()` |
| 配置载荷 | `src/host/plugin-config.js`（新） | 按注册表读本机文件 → 只挑白名单键 → 产出待写清单与"送不到"清单 |
| 远端写入 | `src/remote/daemon.js` `writeNodeFile()` | 内容走 **stdin**（不进 argv，`ps` 看不到 token），`umask 077` + 显式 `chmod`，字节相同则不动，原子 `mv` |
| 接线 | `src/host/rnh.js` connect 与 `syncConfig` 两条路径 | 判定 → 过滤 → 安装 → 写配置 → 必要则强制重启常驻 host → 报告 |

### 为什么写配置要强制重启常驻 host

记忆插件的配置在**工作区第一次出现时**解析（`resolveHostMemory` 按 `root` 缓存整棵 client），
之后同一 `root` 复用那个 client；它虽然每次调用都重读 token，但只在 `apiUrl` 未变时才用新 token。
节点上 `/root` 早就在"无配置"状态下被缓存过一次，只写文件不重启的话它永远对着云端 URL 401。
因此：**只要写入了新的配置文件，就 `ensureServing({ force: true })`**。
只改 patch 里的模型行不用重启（HMR 会读到），这条界限沿用 ADR-0001。

### 为什么不是"把所有 home 下的文件都同步过去"

那是"镜像家目录"，本项目在 GOAL 与 ARCHITECTURE 里都明确否定过同类形态
（第九节：不做镜像）。声明式的白名单是它的反面：一个 bundle 要什么，就写下什么，
其它字节不移动。

## 四、失败形态与可见性

| 情形 | 节点组合 | 报告字段 | 日志 |
|---|---|---|---|
| 平台不适用 | 不下发、不组合 | `provision.plugins.skipped[]` | `[name] <bundle> 未下发：<文件>:<行> 的 <字面量> 只存在于 <os>，节点是 <os>` |
| 配置送不到（本机无文件/解析失败/白名单键全缺） | 不下发、不组合 | `provision.config.unavailable[]` | 同上，逐条说缺什么 |
| 配置写入成功 | 组合 | `provision.config.written[]`（只报路径与键名，**永不报值**） | `写入 <path>（<n> 个键）` |
| 写入失败（SSH/权限） | 组合，但报错 | `provision.config.error` | 原文 |

**值不进日志、不进 `describe()`、不进错误消息** —— 与 `rnh-control` 的既有口径一致
（"结果里永远不能带认证材料"）。

## 五、不做的事

- **不改犀牛模式那个 bundle**。它是用户自己的 `@local/*` 包，声明 `win32` 是它的自由；
  本次只保证"程序会拒绝把它送到 Linux 节点并说清原因"。
- **不猜未注册插件的配置**。注册表之外，第三方插件的配置需求是它自己的责任；
  本项目的职责边界是"知道的不许漏，不知道的不许编"。
- **不做页面展示**。报告进 `describe()`（手机与设置页已在读这个字段）与 Host 日志；
  设置页把 `skipped` / `unavailable` 渲染成一行中文提示是**已登记的债务**，
  不放进本轮 —— 本轮要先让事实成立，再谈呈现。
- **不改节点的 composition 层**。平台判定与配置下发都在桌面侧的供给链上，
  节点仍然只有"一份组合 + 一份配置"。

## 六、验证

| 层 | 套件 | 守住什么 |
|---|---|---|
| 纯逻辑 | `offline/applicability`（新） | 带盘符路径的插件在 linux 上被拒、在 win32 上放行；`package.json os` 被尊重；无字面量插件一律放行；reason 指到 `文件:行` |
| 纯逻辑 | `offline/provision`（扩展） | 只挑白名单键（`banks` 与陌生键不出现）；本机无文件 → `unavailable` 且该 bundle 不进组合；写入内容 0600、字节幂等 |
| 纯逻辑 | `offline/capabilities`（扩展） | 注册表每条记录合法、路径安全、键非空；生成物 `BRAIN_THIRD_PARTY_CONFIG` 与派生一致 |
| 端到端 | `e2e/tool-parity` + 真节点 | 写入后节点上 `~/.hindsight/coding-agent.json` 存在且 0600；重启后节点会话的 `diag.jsonl` 不再出现 `401`，`retain_ok`/`pages_ok` 有增量 |