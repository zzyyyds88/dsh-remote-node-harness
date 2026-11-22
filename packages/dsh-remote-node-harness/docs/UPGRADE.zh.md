# 升级流程

这份文档写给以后维护这套东西的人（很可能就是未来的你）。两个包要分头升级：

| 包 | 什么时候动它 |
|---|---|
| `packages/dsh-remote-node-harness` | 插件逻辑改动；DSH 升级后**重跑测试**即可，通常不用改 |
| `packages/rnh-brain` | **每次 DSH 升级都要重新生成** —— 它描述的是"哪个 release 组合了哪些行" |

核心原则两条：

> **插件不 fork 任何上游代码，也不从 `app.asar` 里 import 任何东西。**
> 所以 DSH 升级时，插件不会"跟着坏"，但可能"悄悄失配"。下面这些检查就是发现失配的办法。

> **节点的组合必须从"已安装的那个 release"派生，不能从 master 派生。**
> 见第五节。

---

## 一、DSH 升级后必须重跑的三件事

桌面端升级 DSH（`0.2.2-rc.3` → `0.2.3` 之类）之后，按顺序做。**第 0 步不是测试，是重建节点
运行时** —— 桌面端升了版本，节点就没有可下载的制品了，连不上（见第四节）。

### 0. 从 fork 重新编译并发版

```bash
cd D:/ProjectHub/dsh-fork/deepseek-harness && git checkout dsh-v<新版本>
cd D:/ProjectHub/DSHpl
CNB_TOKEN=… node packages/dsh-remote-node-harness/scripts/build-fork-runtime.mjs --platform linux-x64 --publish --cnb
```

完整步骤（含切 tag、重放构建侧修复、什么时候要加 `RUNTIME_BUILD`）见第五节。

### 1. 重跑不依赖网络的测试

```bash
cd packages/dsh-remote-node-harness
node test/routing-unit.mjs        # 身份编解码、流扇出、工作区合并
node test/multipart-unit.mjs      # Gateway 二进制应答解码
node test/picker-paths-unit.mjs   # /@rnh 命名空间编解码、影子目录清理
node test/install-unit.mjs        # 安装清单自洽（patch 文件、files、engines.dsh、详情页）
node test/rnh-control-unit.mjs  # 节点控制面：密钥只能引用不能粘贴
node test/fork-runtime-unit.mjs   # fork 裁剪规则：留什么、删什么、为什么
```

或者一条命令跑完这三层（它自己起隔离 profile 的 Host）：

```bash
node test/run-all.mjs --layer offline,contract
```

`gateway-smoke.mjs` **不在这里** —— 它要一台真节点（见第 3 步）。

### 1b. 安装形态变了之后：真的装一次

清单正确不等于装得上。改过 `package.json` 的 `dsh.bundle.patch` / `files` / `exports` /
`engines.dsh` 之后，**两种 target 各装一遍**，并确认第二个 patch 文件也组合成功：

```powershell
# 1. 打 tarball 并从它装
npm pack --pack-destination dist
& $exe $bin plugin --profile <干净profile> add -w .\dist\greatbaby-dsh-remote-node-harness-<version>.tgz

# 2. 从本地目录装（link: 形态，开发时用）
& $exe $bin plugin --profile <干净profile> add -w D:\ProjectHub\DSHpl\packages\dsh-remote-node-harness
```

装完起一次那个 profile 的 Host，检查三件事：`/rnh/api/nodes` 答得出、
`agentPresets/list` 里有 `node-control`、`directoryPicker/list` 收到 `/@rnh` 会回节点列表。
少任何一件都说明某个 patch 文件或 `files` 条目没进包 —— 而**只装不查是看不出来的**。

两个坑：`file:<绝对路径>` 会被 pnpm 解析成相对 profile 的路径（报 `ENOENT`），
给绝对路径时不要带 `file:`；一个 profile 的 `node_modules` 若是从别的 profile 拷来的，
pnpm 会以 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF` 拒绝接管，用干净 profile 验证。

### 2. 重跑两条"缝隙"测试（必须用 DSH 自带的 Node，不是系统 Node）

这两个测试读的是 `app.asar` 内部结构，**只有 Electron 打过补丁的 `node:fs` 能读**：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/dispatch-seam.mjs"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/upstream-smoke.mjs"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/provision-unit.mjs"
```

`dispatch-seam` 挂了 = **最关键的那条缝隙没了**（Gateway 的 view 不再读取实例 own property）。
真到这一步，插件的主路线就断了，需要回到本文第三节重新找缝，而不是"修一修"。

### 2.5 重新生成节点组合，并读 diff

```powershell
$env:DSH_INSTALL_DIR = "D:\Program Files\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh"
$env:ELECTRON_RUN_AS_NODE = "1"
cd packages/rnh-brain
& "D:\Program Files\DSH\DeepSeek Harness.exe" "scripts/sync-from-upstream.mjs"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "scripts/check-composition.mjs"
node scripts/embed-into-rnh.mjs
cd ..
git diff packages/rnh-brain/cordis.patch.yml
```

diff 里的每一种变化都要判一次：

| diff 出现什么 | 怎么办 |
|---|---|
| 多了一行 host 服务 | 大脑大概也该保留 —— 默认已保留，确认它不是浏览器专属 |
| 多了一行浏览器专属组件 | 加进 `scripts/sync-from-upstream.mjs` 的 `DROPPED`，并写清为什么 |
| 某行 **id 被重命名** | 本包的 patch 会指向不存在的 id，而**上游对此是静默的**（`applyPatches` 只发一条 `ctx.logger.warn`，正常输出看不到）→ `check-composition.mjs` 会失败，按新 id 改脚本 |
| 行数或 preset 文件变化 | 确认 `package.json` 的 `dsh.bundle.patch` 仍然列全 |

`sync-from-upstream.mjs` 是幂等的：没变化时重新生成后 `git status` 应当干净 —— 不干净就说明有人手改过生成物，那是违规的（改脚本，不改生成物）。

### 3. 端到端验收（需要一个连上的节点）

```bash
export RNH_TEST_HOST=<节点地址>   # 见根 AGENTS.md §10：只从环境变量读，源码里没有默认值
export RNH_TEST_USER=root
export RNH_TEST_PASSWORD=...

node test/gateway-smoke.mjs                              # SSH 上的 cookie / unary / 流载体
node test/host-routing.mjs    <base> <token>
node test/workspace-flow.mjs  <base> <token>
node test/tool-parity.mjs     <base> <token>
node test/tool-git-image.mjs  <base> <token>
node test/client-bundle.mjs   <base> <token>
node test/event-relay.mjs     <base> <token>
```

`gateway-smoke` 只用环境变量（它不经过本地 Host）；其余六个要一个跑着的 Host
（`dsh --profile <非 desktop> --host 127.0.0.1 --port 0 --no-open`）和一个已连接节点。

四个断言最值钱：

| 断言 | 说明它守住了什么 |
|---|---|
| `event types are not corrupted by identity translation` | 身份重写没有波及事件**类型**（`session-log-…/delivery-accepted`） |
| `workspaceFiles/readBytes returns real bytes` | Gateway 的 multipart 应答解码还活着（远端图片/PDF 预览靠它） |
| `the agent used its own read/write/edit tool` | 工具没有被静默退化成"全部走 bash" |
| `no tool call mentions a real Windows path` | 没有东西偷偷镜像回了本机 |

---

## 二、每次升级要对照的上游契约

升级时最容易悄悄改变的是下面这些。每一条都有对应的测试，改了就重跑它。

| 上游契约 | 在哪 | 变了会怎样 | 谁守 |
|---|---|---|---|
| `@Remote` 描述符写在**类原型**上，Gateway dispatch 用 `Reflect.get(view, name)` | `dsh-typert-protocol`、`dsh-api-gateway` | 实例覆写不再生效，所有路由失效 | `dispatch-seam.mjs` |
| Gateway 用 `Function.prototype.toString` 解析**形参名** | `dsh-api-gateway` | overrider 的形参名对不上 → `missing "xxx"` | `host-routing.mjs` |
| 流方法的第一个位置参数**就是** request 对象（不是 `{request}` 包装） | `dsh-api-session-controller` | 流端点全部 not-found | `workspace-flow.mjs` |
| 带字节的结果走 `multipart/form-data`，`Uint8Array` 在 JSON 里是 `null` | `dsh-api-gateway` + `dsh-client-connection` | `readBytes` 报"非 JSON 应答" | `multipart-unit.mjs` + `host-routing.mjs` |
| Gateway 每 2 秒 ping 一次，不应答就断 | `dsh-api-gateway` (`websocketHeartbeatIntervalMs`) | 流两秒后静默消失 | `gateway-smoke.mjs` |
| `typert.lookups.configure(key, …)` 每 key 一次，且**优先于** provider | `dsh-typert-registry` | `workspaceFileScope` 无法解析远端会话 | `host-routing.mjs` |
| `SessionId` 无格式校验（只是 brand） | `dsh-session` | 不能再塞 `rnh_…` 身份 | `routing-unit.mjs` |
| 模型行的 id/包名 + `configEditor.configuration()` 的返回形状 | `dsh-config-editor`、`dsh-llm-*` | 下发到节点的配置缺字段 | `provision-unit.mjs` |
| profile 的 `cordis.patch.yml` 会被 `dsh-hmr` 热重载 | `dsh-hmr`（只 watch profile patch 与 home patch） | 改配置要重启节点宿主 | 实测（见 adr-0001） |
| 客户端插件槽位名（`settings.section` / `sidebar.panellist` / `main`） | `dsh-client-ui-*` | 设置页或侧栏面板不出现 | `client-bundle.mjs` |
| 目录选择器的三个插槽（`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` / `workspace.picker.directoryFlow`）与它的 `{open, onPicked, onCancel}` 约定 | `dsh-client-ui-workspace` + `dsh-client-ui-directory-picker-*` | 加工作区弹回原生选择框，或对话框弹不出来 | `client-bundle.mjs`（槽位注册）+ 手工验收 §7b |
| 单实例插槽（`kind: single`）取 `entriesOfSlot(key)[0]`，按 `priority` 升序 | `dsh-client-ui-renderer` / `dsh-web-frontend` | 自家占用者排在壳自带的那一个后面，永远不生效 | 手工验收 §7b（对话框标题必须是「选择工作区文件夹」） |
| profile 的 `dsh.profile.bundles` 顺序即组合顺序，`npm install` 会剪掉 `dependencies` 里没有的包 | `dsh-app-boot` / `dsh-client-modules` | 插件开关把大脑 bundle 剪掉，节点起不来 | `plugin-switch.mjs` |
| 第三方 bundle 的 `peerDependencies` 写 `@deepseek-ai/dsh-*` 区间，npm 会把那个版本装进 profile，压过运行时树 | `dsh-app-boot` 的包解析顺序 + 各插件的 peer 声明 | 节点报 `N required plugins did not activate`、不打 URL，`connect` 只报日志尾巴 | `plugin-switch.mjs`；`installPlugins` 固定带 `--legacy-peer-deps` |
| 子代理自己的 Session id 是**裸 uuid**（父 Session 才是 `session-<uuid>`） | `dsh-session` / `dsh-subagent` | 只按值匹配 `session-<uuid>` 的包装会漏掉子会话，历史打不开（`subagent/not-found`） | `routing-unit.mjs` |
| 带 `Agent` 形参的端点（`agentTeams/setEnabled`）要求 `agents.get(caller.id) === caller` | `dsh-team`（`TeamService` → `ctx.subagents.rootOf`） | 用一个占位 Agent 调它 → `subagent tree access requires the exact live caller`，开关点了没反应 | 手工验收 §7c |
| `sessionQuery.readEvent` 是 Host 内部方法（无 wire 端点），`/api/present.open` 靠它定位副产物文件 | `dsh-session-query` + `dsh-client-ui-deliverables` | 远程会话的那条路由 404，卡片说「无法在文件管理器中显示，请重试」——一句永远不可能成功的话 | 手工验收 §7c + `verify-reveal` |
| `/api/present.open` 对没有本机映射的路径答 **422**，客户端把它记成 `nativeUnavailable`（不是报错） | `dsh-client-ui-deliverables/src/present-open.ts` | 以为远程文件的「在文件管理器中显示」应该成功，于是去改 rnh 侧 | 手工验收 §7c |

**查上游契约的办法**（不用读 TypeScript 源码）：

```bash
# 一个服务的完整 Remote 签名
dsh --profile <p> --dump-config           # 行与包名
cordis_inspect listService                # 服务方法签名（含 @Remote 标注）
# 某个 Remote 端点的精确 wire 形状
node -e "..."  # 读该包 lib/typert.remote-client.js 里的 <endpoint>_parameter_<n>$schema
```

---

## 三、如果主路线真的断了（`dispatch-seam` 失败）

先确认是不是这五条缝隙之一变了，**不要**马上想到 fork：

1. 实例 own property 还能不能覆盖 dispatch？读 `dsh-api-gateway/lib/index.js` 里
   `invokePrepared` / `prepareInvocation`，看它取方法用的是 `Reflect.get(view, name)` 还是
   读原型上的描述符。如果改成读原型，覆写就失效了 —— 这时才有必要考虑换方案
   （例如注册一个自己的 provider，或者 fork，但 fork 的维护成本要高得多）。
2. lookup 还能不能 override？读 `dsh-typert-registry` 的 `lookups.configure`，以及
   `lookupStore.resolvers` 是不是仍然是个 `Map`（`agent` 那一项走的是后者）。
3. Gateway 的 `pendingRemoteEvents` / `deliverRemoteEvent` / `cancelRemoteEvent` 还是不是实例上的
   普通状态？改成私有字段或加上 `startRemoteEvent` 的完整校验，审批卡就发不出去。
4. SSH 上的 HTTP/WS 还通不通？这跟 DSH 版本无关，基本不会坏。

---

## 四、给节点装什么版本

**节点永远安装与本机 desktop profile 完全相同的版本**（`localDshVersion()` 从
`$DSH_INSTALL_DIR/package.json` 读）。理由：Session 日志格式、事件类型、投影结构都随版本走，
两边版本不一致会以"能连上但会话显示错乱"这种最难查的方式失败。

版本不符时 `connect` 会换掉节点 `runtime/`。**只有一条路线：下载本项目自己构建的制品。**
它来自本仓库对上游源码的 fork，裁剪掉节点用不到的部分，由本项目编译并发版（见
[`docs/adr-0007-fork-node-runtime.zh.md`](../../../docs/adr-0007-fork-node-runtime.zh.md)）。

- 归档 `dsh-<version>-<platform>.tar.gz` 只有 CNB 一个源
  （`https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/<tag>/<file>`）。
  节点匿名 GET，不需要任何凭据。**GitHub 不作为下载源**：国内节点连不上。
- 实测 build 7：58.2 MiB / 25 167 文件 / 61 071 397 字节，CNB 匿名下载约 12 s
  （旧的上游制品 165 MiB）。
- 拿不到制品就是**报错**，逐条列出试过的 URL 与节点原文。不会再退到
  `npm install @deepseek-ai/dsh`：那条路装的是**上游发布版**，写同一枚构建戳，
  于是一次网络抖动就会把节点永久钉在上游版本上，而界面显示"已就绪"。

**上游发新版之后，节点会连不上，直到本项目重新编译并发版。** 这是 fork 路线的全部代价，
不是缺陷。发版流程见下面第五节，一条命令。

如果字节到了但坏了（校验和不符、归档里没有 CLI），仍然报错并回滚到 `runtime.previous` ——
「拿不到」和「拿到的是坏的」是两件事，后者永远不重试。

上游 `@deepseek-ai/dsh` 的每个 0.2.2 版本都声明 `engines.node: ">=24.9.0"`，而本插件的最低要求是
Node 22：低于它仍然装得上、跑得起来（解包一棵树，从来不读这个字段）。**2026-11-19 核实保持 22**，
依据见 `docs/adr-0006-node-runtime-supply.zh.md` §四-2。

---

## 五、跟上游：怎么把新版编译出来并发出去

fork 在仓库外（`DSH_FORK_DIR`，默认 `D:\ProjectHub\dsh-fork\deepseek-harness`），
钉在一个 release tag 上，**工作树不带本项目自己的提交**。升级 = 切 tag、跑一次构建。

```bash
# 1. 桌面端升级之后，先在 fork 里切到同一个 tag（版本必须完全相等，否则节点会拒绝）
cd D:/ProjectHub/dsh-fork/deepseek-harness
git fetch origin --tags
git checkout dsh-v<新版本>
git checkout -b dshpl-node-runtime-<新版本>
#    源码改动不再直接提交在这里 —— 它们在 patches/node/*.patch 里，构建时自动叠加。
#    构建会先 git apply --3way 一遍；补不上就报错停下，那才是要看的地方。

# 2. 编译、裁剪、打包、上传（一条命令；不带 --publish 时只落本地 dist/fork）
cd D:/ProjectHub/DSHpl
CNB_TOKEN=… node packages/dsh-remote-node-harness/scripts/build-fork-runtime.mjs \
  --platform linux-x64 --publish --cnb

# 3. 只改裁剪规则时不用重编上游（几十秒而不是十几分钟）
node packages/dsh-remote-node-harness/scripts/build-fork-runtime.mjs --platform linux-x64 --reuse

**源码改动怎么写进来。** 如果要把某段上游代码在节点上改成别的行为（不是删包、不是删文件），
不要直接改 fork 的工作树 —— 升级切 tag 时会丢，而且届时分不清哪些提交是本项目的。
放进补丁链：

```bash
# 在 fork 里改好，生成一个补丁（0001 是序号，决定应用顺序）
cd D:/ProjectHub/dsh-fork/deepseek-harness
git diff -- packages/<group>/<pkg>/src/<file>.ts > \
  D:/ProjectHub/DSHpl/packages/dsh-remote-node-harness/patches/node/0001-<slug>.patch
git checkout -- .          # 工作树回到 tag 状态，改动只活在补丁里

# 台账必须同一提交补上，否则 test/node-patches-unit.mjs 会红
# 文件：packages/dsh-remote-node-harness/docs/node-patches.zh.md
```

六列写全：改了什么、移除了什么、为什么节点不需要、怎么验证的、上游改到同一处怎么办。
构建时 `git apply --3way` 逐个应用；**已应用**会被识别成 `already`（不会报错），
**真冲突**会抛错并打印 git 的原文 —— 那时把补丁针对新 tag 重新生成，不要 `--reject`，
也不要删掉它当作没发生。
```

**只发 `linux-x64`，而且上传器会替你守着。** 名单是 `src/remote/artefact.js` 的
`PUBLISHED_PLATFORMS`；带 `--publish`/`--cnb` 而平台不在名单里，`publish-runtime.mjs`
直接抛错。`win32-x64` 就在名单外 —— 它曾经发过，后来撤掉了，因为**没有任何节点能向它要**
（探针读 `uname -s`，Windows 上没有对应拼写；节点侧 21 处 `sh -c` 加 `setsid`、只有 SSH 传输）。
不加 `--publish` 时仍能 `--platform win32-x64` 构建，那是冒烟测试的路。理由与实测见
[ADR-0007](../../../docs/adr-0007-fork-node-runtime.zh.md) §三第 4 条。

**顺序不能反**：`RUNTIME_BUILD`（`src/remote/artefact.js`）必须在制品内容变化时加一。
裁剪规则、`ARTEFACT_RESIDUE`、归档布局任一改动都要加，否则老节点读到的戳是"当前"，
它会一直跑旧字节 —— 实测过这条链（`doc/` 被当文档删掉，`yaml/dist/doc/directives.js`
跟着没了，节点启动即 `MODULE_NOT_FOUND`，而闸门说"已就绪"）。

**内容没变也要加的情况：改动的是安装脚本。** build 6 就是这样：归档字节与 build 5 完全
相同，但 `installScript` 补可执行位的范围从「只有 `spawn-helper`」改成按形状匹配
（`isArtefactExecutable`）。戳是唯一能触达「已经装好、版本相同」节点的杠杆 ——
`inspectRuntime` 见戳相同就复用，不 bump 就等于只在全新节点上修好，而真正坏着的那些
节点一个都不会被修。判据：**这次改动要生效，是否必须让节点重装一次？** 是就 bump。

**加一条节点补丁必须同时做三件事**（ADR-0008，build 7 是第一次）：

1. `patches/node/NNNN-slug.patch` —— `git -C <fork> apply --3way` 能过的标准 diff；
2. `docs/node-patches.zh.md` 补一行六列，缺一列 `test/node-patches-unit.mjs` 就红；
3. `RUNTIME_BUILD` +1。补丁改的是 `lib/` 里真正跑的字节，所以归档字节会变，
   不 bump 会让已经装好的节点继续跑旧逻辑而界面显示「已就绪」。

**两个实测撞过的坑，改脚本时别踩回去：**

1. `@deepseek-ai/dsh-web-app` 的 **manifest 必须留着**，哪怕它一个字节都不加载。上游按
   安装树里的 manifest 求 profile bundle 的依赖闭包（`dsh-app-boot` 的
   `collectInstallationScopePackages`），删掉它之后大脑保留的 15 行全部
   `ERR_MODULE_NOT_FOUND`。一个 0.2 MiB 的 manifest 换来能启动。
2. staging 清单只能把 `@deepseek-ai/dsh` 列为依赖，其余 fork 产物放进 `overrides`。
   把 384 个 tarball 全列成直接依赖会装上"发布出来的一切"（1789.2 MiB / 673 包，
   含 `@openai/codex-linux-x64` 319.4 MiB、`@anthropic-ai/claude-agent-sdk-linux-x64`
   205.7 MiB），而不是"运行时真正 import 的闭包"（957.3 MiB / 496 包）。

---

## 六、节点侧的改造：只当远程大脑

节点的常驻宿主是一个**独立的 DSH 安装**，有自己的 `~/.dsh`。改造分两层，职责不重叠：

### 层一：组合（决定节点跑哪些插件）

由 `packages/rnh-brain` 负责。节点 profile 的 `dsh.profile.bundles` 变成：

```
@deepseek-ai/dsh-base + @local/rnh-brain
```

`@deepseek-ai/dsh-web-app` **不在这个列表里**，所以浏览器面那 56 个 `dsh-client-ui-*`
包连 `import` 都不会发生 —— 不是加载后 disable。为什么这样做、怎么从官方 patch 减出
这一层、升级后怎么重新生成，见
[`packages/rnh-brain/README.md`](../../rnh-brain/README.md)。

### 层二：配置与凭据（自有 profile 的 patch + Remote API）

组合决定"有哪些插件"，不决定"用哪个模型、用谁的 key"。这两件事每次连接同步，
写入节点自有 profile 的 `~/.dsh/profiles/rnh/cordis.patch.yml` 与节点凭据库：

1. **模型行**：从本机 `configEditor.configuration()` 复制 provider 路由、默认模型、权限预设。
   账号登录型的 provider 不复制（那是本机的登录态）。
2. **凭据**：把那些行点名的 `apiKeyEnv` 对应的键从本机取出来，通过节点自己的
   `credentials/set` 推进节点的凭据库。

**配置里没有 `disabled: true`。** 早期版本在这里写 56 条禁用浏览器行的 patch，
但组合层已经去掉了那些行，所以那 56 条指向不存在的 id 是空转 —— 而 `applyPatches`
对不存在的 id 只发一条走 `ctx.logger.warn` 的 `patch: entry … not found`，正常启动输出
里看不到，是纯静默噪音。真正需要 disable 的 22 条 agent-plane 行属于组合层（它们在
`dsh-base` 里确实存在）。

**配置是幂等的**：内容没变就不写盘（`writePatch` 返回 `changed: false`）。变了也只靠节点宿主的
热重载，**不重启** —— 那个 profile patch 正是 HMR 监视的两个文件之一。

**本地一改就跟随**：本机订阅 `app-boot/config-reload` 与 `credentials/reference-updated`，
所以改模型或换 key 不需要重连节点。详见 [`docs/adr-0001`](../../../docs/adr-0001-node-config-carrier.zh.md)。

**凭据同样跟随**：每次下发都覆盖写一遍；而且换 key 会触发同一条同步路径。

---

## 七、小改动怎么发

插件通常以两种形态之一装进 profile：npm 包（`@greatbaby/dsh-remote-node-harness`），或开发时的本地目录
（`@greatbaby/dsh-remote-node-harness: link:D:/ProjectHub/DSHpl/packages/dsh-remote-node-harness`）。两种都改代码后：

| 改的是 | 怎么生效 |
|---|---|
| `src/client/client.js`（浏览器半） | 桌面端**刷新页面**即可；若同时跑着 `pnpm run dev:web` 则热更 |
| `src/index.js`、`src/host/**`、`src/node-control/**`、`src/ssh/**`、`src/remote/**`（Host 半） | 必须**重启桌面端** |
| `cordis.patch.yml`、`presets/*.patch.yml`（插件自己的 patch 层） | 重启桌面端 |
| `locale/*.json`、`icon.svg`、`docs/DETAIL*.md` | 刷新页面 |

改完一个 Host 半的改动后，最小的验证是：

```bash
node test/routing-unit.mjs && node test/routing-extra-unit.mjs && node test/multipart-unit.mjs \
  && node test/picker-paths-unit.mjs && node test/install-unit.mjs
```

然后再跑一个端到端（`host-routing.mjs` 或 `picker-flow.mjs`）。动过 `presets/` 或
`package.json` 的清单字段，还要按 §1b 真的装一遍。

### 发布一次

包名是 `@greatbaby/dsh-remote-node-harness`，发布形态与理由见
[ADR-0005](../../../docs/adr-0005-release-and-maintenance.zh.md)。

**不发 npm。** 这一点与 ADR-0005 当时的结论相反，是本项目自己的决定：registry 上有过
`@greatbaby/dsh-fleet` 的 0.5.0 / 0.5.1 两个版本，而它装的是**旧代码**（build 2/3、还带 npm
兜底），与仓库里的树不是一个东西。同号不能重发，旧名又已经作废，所以 npm 这条路整体放弃，
安装只有 CNB 的 tarball 与本地目录两条（见根 `README.md` §安装）。

**旧包已经标弃用，但删不掉。** `npm deprecate '@greatbaby/dsh-fleet@*' …` 成功（三个版本都带
上了指向新仓库的文案，`npm install` 会打出来）；`npm unpublish --force` 被拒：
`403 Granular access tokens that bypass two-factor authentication may not perform this action`。
本机那枚 token 是绕过 2FA 的 granular token，npm 已不许它执行删除。要真删只能在 npm 网页上
用带 2FA 的会话操作。**别为了"删干净"去 `npm adduser` 重新登录** —— 那会换掉现有凭据，
而删包本身对节点与用户都没有影响。

```bash
# 1. 版本与日志：改运行时行为 → minor，只改文档/元数据 → patch
#    （同时改 package.json 的 version 与 CHANGELOG.md）
# 2. 最低限度的验证（不需要节点）
node test/run-all.mjs --layer offline
# 3. 真装一次（§1b）
# 4. 打包
cd packages/dsh-remote-node-harness
npm pack --pack-destination ../../dist/plugin
# 5. 打 tag 与 Release，附上 tarball
cd ../..
git tag v<version> && git push origin main --tags
gh release create v<version> dist/plugin/*.tgz --notes "见 CHANGELOG.md"
```

**CNB 上还要单独传一份**，因为节点与手机都从那里取，GitHub 只是发行渠道：

```bash
CNB_TOKEN=… node packages/dsh-remote-node-harness/scripts/upload-plugin.mjs \
  --version <version> --file dist/plugin/greatbaby-dsh-remote-node-harness-<version>.tgz
```

**节点运行时制品与插件版本不是一回事。** 节点装的是 DSH 本身
（`dsh-<dsh-version>-<platform>.tar.gz`），由 `scripts/publish-runtime.mjs` 产出，
挂在以 **DSH 版本**命名的 release 下（已有一个 `v0.2.2-rc.3`）。插件升级不需要重发它；
DSH 升级才需要。

---

## 八、中转插件（`ds-harness-remote`）升级后要看什么

这条链此前是空白，而它**无声失效**：中转改一处行为，手机端某个功能就不响应，
不报错、不打日志，现有端到端又全部走本机 `/api`，一条都测不到。

### 8.0 先看补丁还在不在（0.6.7 起新增）

0.6.7 起，本插件会在**每次 Host 启动**时给已安装的 `ds-harness-remote` 产物打一处补丁：
让 `rnh_` 开头的会话 id 跳过中转的「本机 realpath 授权」。原因与三个被否掉的方案见
[ADR-0008](../../../docs/adr-0008-relay-artifact-patch.zh.md)。

**中转一升级，补丁就失效**，因为 `dist/index.js` 是整份替换的。这时不会静默降级：
`applyRelayPatch` 找不到锚点就整份放弃，并把原因写进 `GET /rnh/api/nodes` 的
`local.relay`：

```json
"relay": { "installed": "0.6.8", "patched": false, "reason": "… search-branch matched 0 times …" }
```

**所以升级中转后的第一件事是读这个字段。** 三种情况：

| `local.relay` | 含义 | 要做什么 |
|---|---|---|
| `patched: true` | 已打上，锚点都命中 | 什么都不用做 |
| `patched: false` + `installed: null` | 这台机器没装中转 | 正常 |
| `patched: false` + 有 reason | 中转版本变了，锚点对不上 | 看下一段 |

锚点对不上时只有两条路：改 `src/host/relay-patch.js` 的 `RELAY_EDITS`（如果上游只是
重排了代码），或者承认上游已经不需要这个补丁了。**不要**手工去改 `dist/index.js`：
sidecar 记着哈希，下次启动会按锚点重打，手改的部分会丢。

回滚：`revertRelayPatch()`，或把 `dist/index.js.rnh-orig` 复制回 `dist/index.js`。

### 8.1 三处围着中转写的行为

rnh 有三处行为是**围着中转写的**，升级后逐一确认：

| rnh 依赖的中转行为 | 在哪 | 变了会怎样 | 怎么确认 |
|---|---|---|---|
| dispatch 之前会 `mkdir -p` 传入的 workspace 路径 | `ensureHostWorkspaceDirectory` | `/@rnh` 命名空间存在的**唯一理由**就是把这个 `mkdir` 的落点关进 `<盘>:\@rnh\`。若中转改成不建目录或改建设在别处，影子清理要么多余、要么漏 | `picker-flow.mjs`：建完工作区后桌面 `\@rnh` 下没有残留；同时人工确认中转源码里那次 `mkdir` 还在 |
| `directoryPicker/list` 被中转接管（原生后端 `requireCapability("browse")` 抛错后改用自己的实现） | 中转的 directory browser | rnh 是**整体替换**这两个方法而不是装饰。若中转改成直接调原生后端，替换仍然生效但中转那层会多绕一圈；若中转不再接管，视觉上无变化 | `workspace-browse.mjs` + `picker-flow.mjs`；人工确认中转仍在提供 `directoryPicker/list` |
| `terminal-carrier-compat` 把 `follow`/`write`/`resize` 合成为 `terminal/attach` | 中转的 `TerminalCarrierCompat` | 手机开终端走的就是这条四跳接力。中转若改成直连别的端点，rnh 的 `attach` 代理就不再是必经之路 | `terminal.mjs`（本机 attach 全链路）+ 手机端实测；人工确认该兼容层仍在 |

**判断依据不是「版本号变了」，而是这三处行为还在不在。** 中转没有声明 `engines.dsh`，
只声明了一批 `@deepseek-ai/dsh-*` 的 peer range，所以 DSH 升级时它自己不会拒装 ——
这也是为什么 `dispatch-seam` 那两条缝隙测试必须在**装了中转的同一个 profile** 里跑。

**还有一条不是行为、是部署**：中转服务端目前跑的是镜像 tag `latest`（容器内 `@dsh-remote/server`
0.5.21，构建于 2026-11-15）。`latest` 会在上游发版时静默变化，而 DSH Go 是安装版、不可能跟着升。
钉版本的做法：`docker inspect` 确认 tag 不再是 `latest`，升级前先看上游 `docs/compatibility.zh.md`
的 peer range；重启后 DSH Go 仍能连上才算通过。

## 九、DSH Go（安卓客户端）升级后要看什么

手机能调什么，由客户端的 `harnessRemoteAllowlist` 决定，那是一份 `const Set`。
不在表里的端点**手机连发都不发**，Host 侧放宽白名单没有任何用。所以 DSH Go 升级的风险
不是「Host 坏了」，而是「Host 上的某个能力手机再也够不到」。

**每次升级 DSH Go（或中转）之后跑一次：**

```bash
node packages/dsh-remote-node-harness/scripts/check-phone-allowlist.mjs --profile desktop
```

它把「中转放行集合」与「本机真实 wire 端点集」做双向差集。`--asar` 可指定别的安装，
`--profile` 指定别的 profile（默认读 `DSH_PROFILE` 或 `desktop`）。

**它是报告，不是断言，这是故意的。** 两个集合本来就会双向不同：放行集合里有本插件
运行时才补上的端点、有本 profile 没组合的包；本机端点里绝大多数手机本来就不该调。
0.2.2-rc.3 上的实测基线：

```
relay allowlist : 100
served here     : 224  (221 from descriptors + 3 this plugin decorates)
in allowlist, not served here : 11
served here, phone may not call : 135
```

**0.6.6 上的重跑（2026-11-20）**：放行集合 100 → **105**，只增不减，新增
`cotTranslation/limits`、`cotTranslation/translate`、`speech/catalog`、`speech/transcribe`、
`workspaceFiles/search`。被守卫的四个端点（`workspaceFiles/{read,readBytes,readAll,stat}`）、
`resolveWorkspaceRootForSession`、`assertNativeWorkspaceFileCall`、`filterSessionListProjections`、
`cordis.patch.yml`、peer/依赖区间两版**逐字节相同**，所以这次升级对本项目零影响。差分结果：

```
relay allowlist : 105
served here     : 224
in allowlist, not served here : 11   （与 0.6.5 完全同一份名单）
served here, phone may not call : 130
```

新增的 5 个里，`speech/*` 与 `cotTranslation/*` 属 `dsh-experimental-*`，节点组合里被裁掉
（`trim-fork-runtime.mjs` 的 `/^dsh-experimental-/u`），但手机从不直连节点，调到的是桌面自己的
答案，与本项目无交集。

**已知的真实漂移（第一条记录，2026-11-18）：**

| 端点 | 情况 |
|---|---|
| `subagents/interruptByParent` | 在中转放行集合里，本安装（0.2.2-rc.3）**不存在**。真实端点是 `subagents/interruptByUser`。**结果是手机完全无法中断子代理。** 硬边界：客户端 `const Set` 决定，Host 侧修不了 |
| `subagents/list` | 同上，本安装不存在 —— 手机也读不到子代理列表 |
| `schedule/update`、`schedule/delete` | 本安装不存在。手机在 0.2.2 上也不走它们（`usesTargetProtocol => target != null`），属无害遗留 |
| `workspaceFiles/readAll`、`readRelated`、`officeToPdf/*`、`claudeCodeMods/*` | 本 profile 未组合对应包，非缺陷 |
| `$events/result` | Gateway 内部端点，不对应任何 descriptor，应从此清单排除（脚本目前会列出它，读时忽略） |

**第二条漂移（2026-11-20 记，不是升级带来的）：手机读不了节点上的文件。** 放行集合与端点集
对得上，卡的是中转自己的闸门：`workspaceFiles/{read,readBytes,readAll,stat}` 与 0.6.6 新增的
`search` 在 dispatch 前都要先过 `assertNativeWorkspaceFileCall` → `resolveWorkspaceRootForSession`，
而后者是让 Host 派发 `session/list`、取那一行的 `cwd`、再在 **Host 本机** `realpath()`。
rnh 合并进来的远端行 `cwd` 是节点上的路径（`/root/proj`），本机 `realpath` 得 `ENOENT`，
于是回 `WORKSPACE_UNAVAILABLE` / `authority-unavailable`。0.6.5 与 0.6.6 的这道闸门逐字节相同，
所以它**不是这次升级引入的**，`search` 只是又一个撞同一堵墙的端点。

- 影响面：只有**手机 + 远端会话 + 文件读**这一格。桌面端读节点文件走 rnh 的
  `workspaceFileScope` lookup（`src/host/lookups.js`），不经过中转，不受影响。
- 不是 rnh 能修的：`cwd` 必须保持节点路径（`host-routing.mjs:46` 的断言就是「远端行保留它
  自己的 `cwd`」），而中转只接受能在本机 `realpath` 通过的根。
- **未真机验证**：本轮没有 `RNH_TEST_*`，结论来自代码路径分析加本机
  `realpath('/root/project') → ENOENT`。下次有节点时第一步就验它：手机打开一个远程会话、
  点一个文件，看是不是 `WORKSPACE_UNAVAILABLE`。

**发现新的漂移时**：先判断它是「上游改了名」还是「本 profile 没组合」，前者要评估
是否能换用手机的另一个端点承载，后者在表里加一行即可。两条都写进上面这张表。与手机相关的
硬边界另见 [ADR-0003](../../../docs/adr-0003-phone-control.zh.md) §六 A。
