# ADR-0007 节点运行时改由本项目自建：fork 上游源码，自己编译，自己发版

> 状态：已定（2026-11-20）。用户已确认三件事：完整 fork 上游 monorepo、只保留必要部分、
> 构建戳升到 4 并**删掉 npm 兜底路线**；发行版覆盖 `v0.2.2-rc.5` 现有资产；
> 节点只从 CNB 拉取（国内连不上 GitHub）。
> 上承 [ADR-0006](adr-0006-node-runtime-supply.zh.md)（本文推翻其第二、三节与第九节）。
> 本文只决定「节点的运行时从哪来、由谁构建、怎么发」，不改路由、组合、会话语义。
> 现在怎么用：构建与发版命令见 `packages/dsh-remote-node-harness/docs/UPGRADE.zh.md` 第四节。

## 一、问题：制品路线把「跟着上游走」变成了「等上游发版」

ADR-0006 让节点在拿不到制品时自己 `npm install` 上游发布版。这条兜底解决的是**等待**，
没有解决**控制**：节点上跑的那棵树，内容由上游决定，本项目一个字节都改不了。

三件想做的事被这条限制挡住：

| 想做的事 | 上游树能做到吗 |
|---|---|
| 节点不要浏览器面那 62 个包、Office 引擎那 340 MiB、实验性 bundle | 不能，只能装完再不用 |
| 节点上改一处运行时行为 | 不能，改了下次重装就没了 |
| 换台机器、换次连接，字节完全一样 | 不能，`npm install` 每次在线解析 |

也就是说，只要「节点跑的是上游发布版本身」，这个项目对节点运行时的所有主张都只能停留在
**组合层**（`@local/rnh-brain`）。组合层能决定加载哪些行，决定不了那些行里面的代码。

## 二、决定：fork 上游源码，在本地构建节点运行时

| | ADR-0006（上游发布版 + 两条路线） | 本文（自建发行版） |
|---|---|---|
| 节点跑什么 | 上游 npm 发布版本身 | **本项目从 fork 编译出的树** |
| 谁来构建 | 维护者跑 `publish-runtime.mjs`，或节点自己 | 本项目，`build-fork-runtime.mjs` |
| 能不能改运行时行为 | 不能 | 能，改 fork 源码 |
| 树里有什么 | 上游装出来的一切 | 只留大脑需要的（实测 2014.6 → 408.6 MiB） |
| 上游发新版之后 | 节点自己 `npm install` 就跟上了 | **本项目要重新编译并发版** |
| 拿不到制品时 | 落 npm，慢一点但能连 | **报错**，逐条列出试过的 URL |

代价写在明面上：**跟着上游走从「自动」变成「手动」**。上游发新版、桌面端升级之后，
节点在新制品发出来之前连不上。这是用户明确选择的取舍 —— 换来的是节点运行时由本项目完全控制。

### 1. fork 放在哪、钉在哪个版本

- 位置：`D:\ProjectHub\dsh-fork\deepseek-harness`（仓库外，`DSH_FORK_DIR` 可改）。
  不进本仓库：它是别人代码的完整副本，和 `reference/` 同一性质，只是**可写**。
- 版本：`dsh-v0.2.2-rc.5`（上游 commit `9c2670d3`），与本机桌面端**完全相等**。
  节点跑的就是桌面的版本，`decideGate` 只认完全相等（见 ADR-0002 与 ARCHITECTURE 六之四）。
- 分支：`dshpl-node-runtime`，相对 tag 只有**一个提交**（`057ce8f3`，
  `git diff dsh-v0.2.2-rc.5 --stat` = 1 file changed, 14 insertions, 2 deletions）。
  这个提交就是下面说的构建侧修复；升级时照它重放即可。
- fork 上允许有的改动：**只允许构建侧的修复**。第一处是 `verify-packed-install.ts` 在
  Windows 上用 `npm.cmd` 起子进程必然失败（`ENOENT`/`EINVAL`），改成用 Node 起 npm 的
  JS 入口。语义改动不放在这里 —— 见下面第 3 条。

### 2. 裁什么：节点是大脑，不渲染

裁剪规则是 `packages/dsh-remote-node-harness/scripts/trim-fork-runtime.mjs` 里的 `DROP_RULES`，
每条都带理由，因为「删掉一个包」和「猜一个包没用」是两件事：

| 去掉 | 为什么节点不需要 | 实测 |
|---|---|---|
| `dsh-client-ui-*`（62 个） | 节点没有窗口 | 78.8 MiB |
| `dsh-web-frontend` | 大脑不 serve SPA dist | 20.1 MiB |
| `libreoffice-kit*` | 节点不跑文档转换 | 339.5 MiB |
| `dsh-experimental-*`（41 个） | 无产品承诺的评估能力，组合里一行都没有 | 111.3 MiB |
| `dsh-cua-*` / `dsh-browser-use` | 需要节点上的屏幕和浏览器 | 13.1 MiB |

**`@deepseek-ai/dsh-web-app` 的 manifest 必须留着，这一条看着像漏删，不是。**
上游按**安装树里的 manifest** 求 profile bundle 的依赖闭包
（`dsh-app-boot` 的 `collectInstallationScopePackages`）。大脑的 patch 保留了 Web 的
host-plane 行，那些行声明的包只有 `web-app` 的 manifest 里有名字。删掉这个 manifest 之后，
加载器对着 15 行报 `ERR_MODULE_NOT_FOUND` —— 而那 15 行本身一个字节都不 import 那些包。
实测过：留 manifest 启动成功，删掉立刻起不来。一个 0.2 MiB 的 manifest 换来能启动。

### 3. 装什么：按**导入闭包**装，不按「发布出来的都装」

第一版把 fork 发布出来的 384 个 tarball 全列成直接依赖（照抄 `verify-packed-install` 的做法），
结果是 1789.2 MiB / 673 包：里面有一批没有任何 `dependencies` 边指向的包
（testkit、mock、on-demand 子代理 bundle），节点永远不会加载。

改法：staging 清单只把 `@deepseek-ai/dsh` 列为依赖，其余 fork 构建出来的包全部放进
`overrides`。图还是说 `0.2.2-rc.5`，但每条指向这些包的边都解析到 fork 的 tarball 而不是
registry 的同版本副本；fork 没构建的包照常从 registry 来。实测 957.3 MiB / 496 包，
裁剪后 408.6 MiB。**同一套裁剪规则，两种装法的差是 736 MiB 的无用字节。**

### 4. 构建戳升到 4，npm 兜底路线删除

`RUNTIME_BUILD` 从 3 升到 4：树的内容变了（少了 500 MiB 包、多了 fork 的字节），
版本号表达不了这件事，只有戳能。

**npm 兜底整条删掉**，不是关掉开关。理由：兜底装的是**上游发布版**，写同一枚
`{"build":4,"via":"npm"}` 的戳。于是一个走了兜底的节点会被判成「可用」，此后再也不会
被换回 fork 树 —— 一次网络抖动就把节点永久钉在上游版本上，而界面显示「已就绪」。
留着它比删掉它更危险。

于是 `RUNTIME_ROUTES` 这个常量也一起没了：只有一条路时，「路线」不是一个概念。
拿不到制品就是**报错**，逐条列出试过的 URL 与节点原文，由人换源或等制品发出来。

### 5. 只从 CNB 拉，GitHub 不作为源

用户明确：国内连不上 GitHub。`DEFAULT_SOURCES` 从「CNB + 四个加速站前缀」缩成
**只有 CNB 一条**。`DEFAULT_MIRRORS` 与 `mirrors` 配置一起删掉：既然没有第二个源，
「换加速站」这个旋钮就是空的。

`--publish` 仍会把同一份字节传一份到 GitHub Release（灾备、留档），但**节点不从这里取**。
`build-fork-runtime.mjs` 的注释与 README 都写清楚这一点，免得下一个人以为改 `DEFAULT_SOURCES`
是漏了 GitHub。

### 6. 发到哪：覆盖 `v0.2.2-rc.5`

同一个 tag 下覆盖资产，而不是新开一个 tag。理由：节点按 `v<version>` 找制品，
新开 tag 就得让 `artefactUrls()` 认识「fork 的 tag 形状」，多一处只有本项目知道的规则。
覆盖的代价是旧字节不可恢复 —— 旧资产是上游原版，`npm install @deepseek-ai/dsh@0.2.2-rc.5`
随时能重建，所以这个代价可以接受。

CNB 的发布侧有个坑（ADR-0006 八节已记）：`PUT` 返回 200 **不等于附件已关联**，
必须再 `POST` 一次 `verify_url`，否则 assets 一直为空、匿名下载 404。

## 三、验收证据（本轮实测）

| 项 | 证据 |
|---|---|
| fork 能构建 | `pnpm run build:official`：10 个 gate 全过，183 s |
| fork 能打包 | `release:pack --family dsh`：375 个 tarball；`verify-packed-install` 报 `installed @deepseek-ai/dsh reports 0.2.2-rc.5` |
| 裁剪后的树能当大脑启动 | 打印 `dsh web: http://127.0.0.1:<port>/?token=…`；`/?token=…` 换 cookie 得 303 + `Set-Cookie`；`POST /api/session/list` 得 200 |
| 两个平台的产物 | `dsh-0.2.2-rc.5-linux-x64.tar.gz` 87.6 MiB / 41 846 文件 / 91 839 618 字节，sha256 `7ba9124f…`；`dsh-0.2.2-rc.5-win32-x64.tar.gz` 85.2 MiB / 41 839 文件，sha256 `809223fb…`。**win32 这份已从两个 release 上撤掉，见下面第 4 条** |
| 发到了两个地方 | CNB 与 GitHub Release `v0.2.2-rc.5` 各一份；CNB 匿名 `GET` 回 200（`Content-Length: 91839618`），下载 17.6 s，本地重算 sha256 与 sidecar 一致 |
| 归档里没有 staging 清单 | 顶层只有 `node_modules/`；`./package.json`、`./package-lock.json`、`./node_modules/.package-lock.json` 计数为 0（第一版带了，见下面「没验的」） |
| 裁剪规则有断言 | `test/fork-runtime-unit.mjs`（34 条） |
| 离线验收全绿 | `run-all.mjs --layer offline`：15 个套件全过 |

**没验的，写在明面上**：

1. **没有真节点**（本轮没有 `RNH_TEST_*`），所以「桌面端连上节点、下载这份制品、启动、
   跑通会话」这条端到端链**未验证**。它是下一轮的第一步，验收命令见 UPGRADE 第四节。
2. **只有 `linux-x64` 一个平台在发。** `linux-arm64` / `darwin-arm64` / `linux-x64-musl`
   没有发布，也没有机器验证过。`platformTag()` 现在会为 musl 节点请求 `linux-x64-musl`，
   所以 Alpine 节点会得到明确的「没有这个平台的制品」而不是一棵用不了的树 —— 那是正确行为，
   不是缺口。名单是 `src/remote/artefact.js` 的 `PUBLISHED_PLATFORMS`，上传前会查。
3. **第一次发布出去的归档带着 staging 清单**（`package.json` 里是打包机的绝对路径，
   `package-lock.json` 里是同样的路径），几分钟后修掉并重发。没有 bump `RUNTIME_BUILD`：
   带 4 的插件版本从未发布，不可能有节点读到过第一版。理由与断言都在
   `build-fork-runtime.mjs` 与 `test/fork-runtime-unit.mjs` 里。
4. **`win32-x64` 曾经发过，现已撤掉，而且它从来取不到。** 第一版发版按「两个平台各跑一次」
   发了两份，其中 win32 那份能构建、也能启动（实测：解包后打印 `dsh web: <url>`、换 cookie、
   `POST /api/session/list` 200），但**没有任何节点能向它要**：
   - `platformTag()` 的别名表里没有 Windows 的任何拼写，因为探针读的是 `uname -s`，而 Windows
     回 `MINGW64_NT-10.0-19045`（Git Bash）或干脆没有 `uname`。实测：
     `platformTag({os:'Windows_NT'})` 与 `platformTag({os:'MINGW64_NT-10.0-19045'})` 都是
     `undefined`，节点侧会报「这台机器报的 os/arch 没有平台标签」。
   - 节点侧是纯 POSIX：`src/remote/daemon.js` 里 21 处 `argv: ['sh','-c',…]`（探针、安装、
     启停、写 profile、读状态），启动用 `setsid nohup`，libc 探测读 `/lib/ld-musl-*`；
     `src/remote/*.js` 里没有一处 Windows 分支。
   - 传输只有 SSH：`core/registry.js` 把 `transport` 类型写成 `'ssh'`，`ssh/connection.js` 只有
     `ssh2`。

   所以那 85.2 MiB 是一份没人取的资产，release 说明里还多一行让人以为 Windows 能当节点。
   处置：从 CNB 与 GitHub 的 `v0.2.2-rc.5` 上删掉该资产与它的 `.sha256`，`PUBLISHED_PLATFORMS`
   只留 `linux-x64`，`publish-runtime.mjs` 在上传前拒绝未发布的平台。**本地仍可构建**
   （`--platform win32-x64` 不带 `--publish`/`--cnb`），那是这棵树做冒烟测试的路，也是它当初
   证明「能启动」的方式 —— 被否掉的是「发出去」，不是「构建」。

## 四、代价与什么时候该重开

- **上游发新版，节点会连不上，直到本项目重新编译并发版。** 这是这个决定的全部代价，
  不是缺陷。发布流程因此要短：`build-fork-runtime.mjs` 一条命令覆盖构建、裁剪、打包、上传。
- **fork 与上游的差异要能被看见。** fork 是独立 git 仓库，钉在 release tag 上；
  升级就是切到新 tag、重放构建侧修复、重跑一次构建。差异只有构建侧修复与裁剪规则，
  后者在本仓库里，不在 fork 里。
- 什么时候该重开「要不要 fork」：如果本项目不再需要改节点运行时行为，只想要官方字节，
  回到 ADR-0006 的两条路线成本更低。

## 五、非目标

> **2026-11-21 部分被推翻**：第 1 条「不改上游语义、裁剪只是打包步骤」不再成立。
> 源码级裁剪与它的重放机制见 [ADR-0008](adr-0008-node-source-trim.zh.md)。其余各条仍然有效。

- ~~**不改上游语义。**~~ fork 的源码改动只有构建侧修复；裁剪是**打包步骤**，不是改源码。
  任何要改运行时行为的改动，先在 fork 上单独一个提交，写清理由与验证方式。
  —— **改为**：源码改动允许，而且是这个项目的主路径（节点的内核就是官方源码，不另写）。
  要求按「节点会不会读到那段代码」分成两类，两类都必须入账，只是入在不同的表：
  - **节点会读到** → 必须是一个 `patches/node/NNNN-*.patch`，并在
    `docs/node-patches.zh.md` 有一行说明改了什么、为什么节点不需要、怎么验证、上游改到
    同一处怎么办。
  - **节点读不到**（构建/发布工具链，例如 `scripts/`) → 记为 fork 上的一个提交，并在
    `node-patches.mjs` 的 `BUILD_SIDE_COMMITS` 里加一行说明为什么它当不了补丁。
  「fork 上多出来的提交」不再是禁止项，而是**必须能被列举出来**：
  `build-fork-runtime.mjs` 的 `checkForkBase()` 会把未入账的提交与手工改过的文件拦在构建之前。
- **不发 npm。** 节点不经过 registry：拿的是归档。往 npm 发 375 个包只会多一条版本线。
- **不做 per-node 的树。** 所有节点共用同一份构建产物，和组合层的规则一致。
- **不给 GitHub 留源。** 见第二节第 5 条。
