# DSH RemoteNodeHarness 协作规则（AGENTS.md）

> 由 `AGENTS.template.md`（2026-11-16 第 3 版）填充，全部占位符已替换，用不到的适配块已删除。
> 未替换的 `@@...@@` 视为待决项：先问用户，禁止凭经验填充。任何时候使用中文，除非明确要求英文。
> 每条规则都要能回答"我这次做到了吗"；做不到的条款宁可删掉，不要留成口号。

## 0. 填空项（已填）

| 占位符 | 本项目取值 |
|---|---|
| `@@PROJECT:<name>@@` | **DSH RemoteNodeHarness**（目录与本地工作区仍叫 `DSHpl`）—— DeepSeek Harness 的远程工作区能力。两个包：`packages/dsh-remote-node-harness`（插件，装桌面端）、`packages/rnh-brain`（节点侧 DSH 组合，只当大脑） |
| `@@TRUTH:<path>@@` | **`docs/GOAL.zh.md`（用户口述目标的正式版本，最高真源：做什么、为谁做、什么算成） → `docs/ARCHITECTURE.md`（设计与取舍）**。对外用法在根 `README.md`；升级流程在 `packages/dsh-remote-node-harness/docs/UPGRADE.zh.md` |
| `@@COMMAND:<command>@@` | §12 各适配块的 `verification` 字段 |
| `@@OWNER:<module/layer>@@` | 路由与身份语义归 `packages/dsh-remote-node-harness/src/host/`；节点组合语义归 `packages/rnh-brain/cordis.patch.yml`（生成物，源是 `scripts/sync-from-upstream.mjs`） |
| `@@BOUNDARY:<goal/non-goal>@@` | 见 §4 |
| `@@ADAPTER:<category>/<name>@@` | `framework/deepseek-harness`、`toolchain/node-esm` |

## 1. 固定习惯（跨项目恒定）

| 用户通常这样做 | agent 必须这样做 |
|---|---|
| 指令很短，常见"改一下""继续""这个不行" | 先补全成可执行步骤再动手；只能补细节，不得替换目标；无法补全时先提问，可问多个具体问题，但不得用提问代替执行 |
| 用"不要 / 别 / 不用"表达需求 | 禁止项一旦出现即硬约束，**仅当轮生效**；后续轮次不自动延续，需用户再次提出 |
| 依据截图、界面、看图判断成果 | 先真实打开再下结论；界面类结论必须配截图或可复现步骤 |
| 要求把纠正写进工作流或记忆 | 同一纠正第二次出现即视为规则：写入 AGENTS.md / 工作流 / 记忆文件，并回执"已写入 X，生效范围 Y" |
| 同时推进多个项目 | 一次会话只服务一个项目路径；跨项目只借方法，不改文件、不串约定 |
| 不参与技术选型 | 给一个推荐方案并直接执行；何时停问按 §11 |

## 2. 硬规则（所有任务恒定生效）

1. **只读默认**。没有明确说"改 / 修 / 实现 / 替换 / 删除"就是只读：只读文件、跑只读命令、给判断。用户说"先看 / 先判断 / 审计 / 你觉得"一律只读，直到明确要求执行。出现"只要 / 仅 / 只改 / 你只能改这些文件"时，只动被点名的对象；白名单之外一律只读，发现问题只报告，不顺手重构、不扩散清理。
2. **复用优先**。先找项目已有的脚本、入口、命令、虚拟环境、工具函数；存在就不新建，不够用就最小修改原文件。项目内没有现成实现时，先在 GitHub 等公开来源检索可复用方案，优先复用而不是从零写；选用外部方案时说明来源、许可证与改动点。禁止另起炉灶式的新脚本、新目录、新流程。
3. **环境固定**。解释器、包管理器、构建/部署/测试命令取自项目真源（README、脚本头、lock 文件、CI）；项目有 venv / conda / 容器就用它。禁止用系统默认解释器替代，禁止猜命令。同一命令因环境（shell、镜像路径、缓存）连续失败时，按 §2-6 的失败处理改道，不得重复重试。
4. **参数不漂移**。用户确认过的执行参数（有头/无头、并发数、模型、路径、账号、超时、输出格式）逐字沿用。要改先说明"原参数 X，改为 Y，因为 Z"。
5. **声称纪律**。"已启动 / 已完成 / 已修复 / 已通过"只能配证据出现：进程 PID、命令输出、测试结果、日志行、diff、截图、接口响应。没有证据就说"未开始 / 进行到 X / 未验证"。
6. **不兜底**。异常直接暴露：报错原文 + 复现命令 + 影响面。禁止吞错、默认值掩盖、静默降级、mock 假数据。同一失败重试两次即停止，换方案或报告。
7. **过程文件归位**。临时脚本、调试文件、中间报告、一次性截图用完删除；确需保留的放进项目约定的过程目录（本仓库 `.scratch/`，已 gitignore），并说明保留原因，不得散落在仓库根或工作目录。用户没要的交付物不要塞进仓库。
8. **单真源执行**。设计、合同、文案模板、工作流、话术按 §14 的真源逐条执行，不得自行增删步骤或改写既定表述。
9. **结论在后**。先给过程与证据，最后给结论。不写空话、不重复用户原话、不用 emoji、非必要不空行。
10. **依赖先换源**。GitHub 克隆、raw 文件、Release 资产、Docker 镜像走 §13 的加速地址；pip / uv / npm 安装前切到 §13 的源。同一源连续失败两次才回官方源，并说明换了哪个源；禁止在默认源上反复重试，其余失败按 §2-6 处理。

## 3. 开工前确认三件事

1. **真源在哪**：按 §14 真源优先级确认；没有指定真源时，当前源码、测试、配置、日志、git 状态就是真源。
2. **owner 在哪**：归 `packages/dsh-remote-node-harness/src/host/`（路由与身份）与 `packages/rnh-brain/`（节点组合）管；跨入口语义先进共享合同或核心层，不散落在 UI、脚本、prompt。adapter / controller / UI / CLI / worker 只做映射与接线，不拥有业务语义，不私造状态与结论。
3. **验收怎么算过**：§12 的 `verification`，或哪条证据能证明。

三者拿不到就先审计并说明缺什么，不得边猜边做。

## 4. 项目边界

- **目标**：见 [`docs/GOAL.zh.md`](docs/GOAL.zh.md)（用户口述目标的正式版本，最高真源）。一句话：把 ZCode 那套「手机连一台 Linux 机器干活」搬到 DSH 上 —— 大脑跑在节点上，桌面端与手机只是窗口；远端会话混排进同一个侧栏，手机经 `ds-harness-remote` 能读；并且能在远端节点上**新建**工作区。任何取舍先回答"它让 GOAL §六 更近还是更远"。
- **做法的前提**：节点跑的是**官方 DSH 源码的 fork**，本项目在那棵树上改源码，而不是另写一个节点端。所以「改上游源码」**是允许的、是这个项目的主路径**，唯一的要求是**每一处改动都进台账**（`packages/dsh-remote-node-harness/docs/node-patches.zh.md` + `patches/node/*.patch`）：能单独读、单独测、单独弃用，上游改到同一处时冲突可见而不是被静默丢掉。删包/删文件是打包步骤，不需要进台账。
- **非目标**（用户已明确否定，不许换名保留）：把远端目录镜像/挂载到本地再在本机跑工具；改 Electron 主进程；接管 `/api` 或 `/api/remote.mux`；碰上游 Loader 行；**改上游源码却不留台账**（改了不记，等于下次上游发版时静默丢改动）；**不发 npm**；**不给 GitHub 留下载源**。
- **节点的形态**：只当远程大脑。做法是**源码级定制组合层** —— 节点 profile 组合 `dsh-base` + `@local/rnh-brain`，`dsh-web-app` 那层根本不加载。所有节点共用同一份组合（不做 per-node 定制）。
- 用户明确否定过的概念必须从代码、文档、命名里删干净，不许换名保留。
- 无意义兼容先问：旧字段、旧接口、双路径污染当前合同时，按 §11 确认取舍，不许擅自保留。

## 5. 交付前自检

- 我做的是你说的事吗？有没有把 A 做成 B？
- 用的是项目既有入口吗？还是又建了一个平行实现？
- 我的"完成"有证据吗？还是只是我自己说完成了？
- 你确认过的参数我改了吗？
- 我留下临时文件了吗？工作区干净吗？
- 我是不是在等一个根本没在跑的东西？
- 我这次动的东西，`docs/ARCHITECTURE.md` 里有没有对应章节？没有就得先补。

## 6. 执行流程

| 级别 | 判定 | 流程 |
|---|---|---|
| 微任务 | 单文件、文案、样式、常量、明显 bug、已指到具体位置 | 直接改 → 验证 → 一句话说明 |
| 中任务 | 单模块、2-4 文件、不改跨模块契约 | 确认契约 → 改代码 → 补测试 → 改文档，可同次提交 |
| 大任务 | 跨模块、改公共契约 / schema / 状态机、新增子系统 | 先改设计并单独提交 `docs:` → 拆任务 → 分派实现 → 删拆分文档 |

- 只改实现、让它符合现有设计，属微/中任务，不必先改设计；暴露设计缺口时走提案回流，不许实现先行、设计后补。
- 设计一次写完整：无法确定的事项显式列为待决项，写明阻塞范围、可选方向、推荐方向；禁止隐式 TBD 与 MVP 式裁剪。
- 从合同、schema、模型、核心服务开始，不从 UI、HTTP handler、临时脚本倒推核心。
- **生成物只读不手改**：`packages/rnh-brain/cordis.patch.yml` 与 `presets/*.yml` 由 `scripts/sync-from-upstream.mjs` 生成；`packages/dsh-remote-node-harness/src/host/brain-bundle.generated.js` 由 `scripts/embed-into-rnh.mjs` 生成。改源再重新生成。
- 抽象只在减少真实复杂度时引入。
- 提案回流：停下来给问题与证据、影响范围、与设计的冲突、可选方案、推荐方案、待确认问题；确认后先改设计并提交 `docs:`，再继续实现。禁止边写代码边暗改设计。

## 7. 验收

- 验收强度匹配风险：核心合同用单元/契约测试，跨入口用集成测试，UI 用真实浏览器截图与交互，部署用构建 + 端到端。
- 证据按 §2-5 提供，不重复列举证据类型。
- 退出码 0 不等于功能生效，构建通过不等于界面正确，单测通过不等于端到端可用；三者只能证明各自那一层。
- **本项目分层验收**（缺一层就不能说"能用"）：
  1. 纯逻辑：`routing-unit` / `multipart-unit` / `provision-unit` / `check-composition`
  2. 契约缝隙：`dispatch-seam` / `upstream-smoke`（必须用 Electron 的 Node 跑，读 `app.asar`）
  3. 端到端：`host-routing` / `workspace-flow` / `tool-parity` / `tool-git-image` / `client-bundle`（要运行中的 Host + 连上的节点）
- 跑不了的关键验收说明原因与替代证据，不许隐瞒。
- 失败先复现、留证据、提可证伪假设，再改；禁止无复现地猜原因。
- warning、lint、类型告警、生成物漂移、文档索引缺失、本轮 TODO 都算缺陷，除非明确记为债务。
- 报错优先联网检索，禁止瞎猜；改一次不成就转检索。
- 问题分级：阻断（当轮收掉）/ 设计风险（说明取舍与验收入口）/ 可记录债务（说明原因）/ 无关优化（不进本轮）。

## 8. 子代理与批量任务

- 同构批量任务（同模板不同参数）一次派发完，禁止逐条等用户点名。
- 并发数按效率最大化自主决定，并说明选择理由；遇到账号、接口或平台限流时，降到不触发限制的最小值。
- 每个子代理必须带：范围、输入、禁止事项、输出格式。
- 主代理不空等：派发后做不重叠的工作，或明确说明只能等哪一步。
- 子代理结论不是真源，主代理对照代码、测试、日志复核后再采信。
- 子代理返回通道失败（ID 解析不到、消息不可用）时改在正文交付，并说明通道异常，禁止静默丢弃结果。

## 9. 输出与交付物

- 生成的文案、说明、话术：简洁直给，不堆形容词，不带动画式 emoji，非必要不空行；用户已有模板时严格套模板。
- 对外文档只写使用、配置、部署、排障；内部架构与治理写进 `docs/ARCHITECTURE.md`。

## 10. Git 与安全

- 原子提交，一次一件事；前缀 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `breakdown`。
- 写代码前先看 `git status --short`；不干净先处理，不混入用户未授权的改动。
- 禁止 `git add .`，只 stage 本任务文件；禁止 force-add ignored 文件。
- 公开仓库禁止提交密钥、令牌、私钥、真实用户数据、含凭据的 URL；私有仓库可提交，但必须先确认远程仓库确为私有且不会被公开。日志与报告同样不许泄露。**本仓库已公开（github.com/zzyyyds88/dsh-remote-node-harness），测试只从 `RNH_TEST_*` 环境变量读节点地址与凭据，源码里不许出现默认 IP 或默认密码。**
- 主分支禁止 `reset --hard`、`push --force`、`clean -f`；功能分支允许 force push，但先确认没有他人在用该分支。其余破坏性命令仍需用户明确要求并确认风险。
- 嵌套仓库统一在根仓库提交，不单独提交子仓库；`reference/` 与 `.scratch/` 不进版本管理，`packages/*` 下不得有独立 `.git`。
- 对外提 PR / issue 前先读贡献规则与已有讨论，一次只解决一个问题，说明 diff 范围与验证证据后再提交。

## 11. 必须停下来问

- 需求、代码、规则、真源互相冲突。
- 要改或删公开接口、schema、权限模型、部署流程、产品命名、agent 规则本身。
- 要做不可逆或大范围操作（批量删除、覆盖远端数据、真实发布、付费调用）。
- 需要无意义兼容或多路线并行。
- 上下文不足以判断 owner，且猜错代价不可逆。

停下来时给：冲突证据、可选方向、推荐方向、需要确认的问题。可问多个问题，其余按推荐方案继续。

## 12. 适配块

### framework/deepseek-harness

applies_when: "项目实际作为 DSH 插件 / bundle 运行"
verification: "`node packages/dsh-remote-node-harness/test/routing-unit.mjs && node packages/dsh-remote-node-harness/test/multipart-unit.mjs`；读上游契约的测试必须用 Electron 的 Node：`ELECTRON_RUN_AS_NODE=1 \"DeepSeek Harness.exe\" test/dispatch-seam.mjs`"

- 插件的三条运行时缝隙是**实现细节，不是公开契约**：`@Remote` 描述符写在类原型、Gateway 用 `Reflect.get` dispatch、参数名靠 `Function.prototype.toString` 解析。任何一条被上游改掉，路由整体失效 —— 每次 DSH 升级都要重跑 `dispatch-seam.mjs`。
- 插件不 import 任何 `@deepseek-ai/*`，也不从 `app.asar` 里 import。唯一运行时依赖是 `ssh2`。破坏这条就等于把插件绑死在某个版本的内部结构上。
- **Cordis 的 `inject` 必须声明插件读取的每一个服务**。漏了会在插件体里抛 `cannot get property "X" without inject`，若抛出点在 promise 链里则没有任何可见症状 —— 宿主启动、端口在听、一行不打印。
- 节点组合（`rnh-brain`）必须从**已安装的那个 release** 派生，不能从 master 派生。master 领先于发布版，会让节点组合出该版本不存在的行（实测踩过：`authentication-token` 行在 `0.2.2-rc.3` 里不存在，节点报 "1 entry did not activate"）。
- 生成物链：`sync-from-upstream.mjs` → `cordis.patch.yml` + `presets/` → `embed-into-rnh.mjs` → `dsh-remote-node-harness/src/host/brain-bundle.generated.js`。改组合只能改脚本或 `src/runtime.js`。
- 节点上的 DSH 是**独立安装**（版本与桌面完全相等），有自己的 `~/.dsh`。它没有 provider、没有 API key，所以 provisioning 是连接流程的一部分，不是可选优化。
- 节点运行时有**一条路**：下载本项目从 fork 编译的制品（`scripts/build-fork-runtime.mjs` →
  `scripts/publish-runtime.mjs`）。npm 兜底路线**已删除**，不是关掉开关 —— 它装的是上游发布版、
  写的是同一枚构建戳，一次网络抖动就会把节点永久钉在上游版本上而界面显示「已就绪」。判据仍然只有
  一条：**拿不到 ≠ 拿到了是坏的**，后者回滚后抛错，永远不重试。构建戳（`stampJson`）必须写，
  否则 `inspectRuntime` 判无戳 → 每次连接重装。见 `docs/adr-0007-fork-node-runtime.zh.md`。
- 上游 `@deepseek-ai/dsh` 声明 `engines.node: ">=24.9.0"`，本项目 `MINIMUM_NODE_MAJOR = 22`。
  制品路线解包一棵树、从不读这个字段，所以这个下限就是节点真实的门槛。
  **2026-11-19 已核实：保持 22，不升 24。** 依据（305 个依赖包里真正的 Node 24 API 是 0 处、
  唯一的 `await using` 命中是 acorn 里的字符串字面量、`workflow-ptc` 在节点组合里
  `disabled: true`）写在 `docs/adr-0006-node-runtime-supply.zh.md` §四-2。什么时候该重开：
  依赖闭包里出现真正的 Node 24 语法或 API，或上游开始用 `engines` 之外的机制强制版本。
- **制品的源是对象数组，只有一条**（`DEFAULT_SOURCES`）：`{kind:'template', template}` 填
  `{version}/{platform}/{tag}/{file}`（CNB 那种自有路径布局）。`{kind:'prefix', prefix}` 这种源
  仍然支持，但**默认一个都没有**：国内节点连不上 GitHub，加速站（0.2–9.6 MB/s，抖动 40 倍）
  已退役成 `RETIRED_MIRRORS`，只作记录。GitHub Release 仍收到同一份字节作灾备，节点不从那里取。
  **发布侧有个坑：CNB 的 `PUT` 返回 200 不等于附件已关联，必须再 `POST` 一次 `verify_url`。**
- **fork 的裁剪规则与两条载重规则**在 `scripts/trim-fork-runtime.mjs` / `build-fork-runtime.mjs`：
  ①`@deepseek-ai/dsh-web-app` 的 **manifest 必须留着**（上游按安装树的 manifest 求 profile bundle
  的依赖闭包，删掉它大脑保留的 15 行全部 `MODULE_NOT_FOUND`）；②staging 清单只把
  `@deepseek-ai/dsh` 列为依赖、其余 fork 产物全进 `overrides`（否则装上「发布出来的一切」，
  实测 1789.2 MiB vs 957.3 MiB）。`test/fork-runtime-unit.mjs` 守着这两条。

### toolchain/node-esm

applies_when: "项目用 Node.js ESM（`\"type\": \"module\"`），无构建步骤"
verification: "`node --check <file>`；`node -e \"import('./src/index.js')\"`"

- 源码直接就是运行物：不引入打包器、不引入 TS 编译。`src/**/*.js` 里写 JSDoc 类型注释，不写 `.ts`。
- 不新增运行时依赖以换取方便。现有依赖只有 `ssh2`；YAML 解析、JSON、HTTP、WS 都用手写或 Node 内置模块，测试需要 YAML 解析器时借用 DSH 安装里的那一份。
- 测试是 `test/*.mjs`，`node test/xxx.mjs` 直接跑，不引入测试框架。断言失败用 `process.exitCode = 1`。
- 连远端的长连接必须清理：测试结尾 `await sleep(250); process.exit(0)`，否则 Node 24 下 undici 连接池未回收会触发 libuv assertion。

## 13. 网络加速与依赖源

以下地址于 2026-11-16 在本机实测可用。安装、克隆、下载前先用这里的源；换源与失败处理按 §2-10、§2-6。

### GitHub 资源加速（不止用于 clone）

**加速入口**（按优先级）

| 地址 | 用途 |
|---|---|
| `https://git.yylx.win/` | 主力。支持 `github.com`、`raw.githubusercontent.com`、`gist.githubusercontent.com`，可代理 clone、raw、archive、Release 资产、Gist |
| `https://gh.inkchills.cn/` | 备用加速 |
| `https://github.akams.cn/` | 加速站汇总目录，前两个不可用时来这里找替代 |

**统一拼接规则**

- 首选拼接式：在完整原始 URL 前加 `https://git.yylx.win/`；也可以把原域名替换成该域名，两种都可用，优先拼接。
- 下载失败时**不要直接放弃、也不要转人工另找站点**，先按上表顺序换入口、按规定写法重试，用不走官方直连，实在不行你就自己去网上找。

**常用写法**

```bash
# 克隆
git clone https://git.yylx.win/https://github.com/<owner>/<repo>.git

# 私有仓库（HTTPS）
git clone https://<user>:<token>@git.yylx.win/https://github.com/<owner>/<repo>.git

# raw 文件
curl -LO https://git.yylx.win/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>

# 分支归档
https://git.yylx.win/https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip

# Release 资产
https://git.yylx.win/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>

# Gist
https://git.yylx.win/https://gist.githubusercontent.com/<user>/<gist_id>/raw/<file>
```

**限制与排障**

- 只支持 HTTPS，不支持 SSH 克隆。
- 只代理具体文件：`/releases/latest` 这类页面 URL 会返回 400，要换成具体资产地址。
- 本机配置了 `127.0.0.1` 代理但代理未启动时，git 会报连接失败——这不是加速站失效。先绕过本地代理再试：

```bash
git -c http.proxy= -c https.proxy= clone https://git.yylx.win/https://github.com/<owner>/<repo>.git
```
### Docker / OCI 镜像

- 前缀拉取：`docker pull git.yylx.win/<registry>/<image>:<tag>`，省略 registry 时按 `docker.io` 处理。
- 支持 `docker.io`、`ghcr.io`、`gcr.io`、`registry.k8s.io`、`quay.io`、`mcr.microsoft.com`、`docker.elastic.co`、`nvcr.io`。
- 也可在 Docker 守护进程配置 `registry-mirrors` 与 `insecure-registries` 指向该域名。
- 实测 `/v2/` 与 `docker.io/library/alpine` manifest 均返回 200。

### Python（pip / uv）

按顺序使用，括号内为实测响应时间：

1. `https://mirrors.aliyun.com/pypi/simple/`（0.20s）
2. `https://mirrors.cloud.tencent.com/pypi/simple/`（0.27s）
3. `https://repo.huaweicloud.com/repository/pypi/simple/`（0.34s）
4. `https://pypi.tuna.tsinghua.edu.cn/simple/`（2.87s）

- pip：`pip install -i <源> <pkg>`
- uv：`uv pip install --index-url <源> <pkg>`，或设置 `UV_DEFAULT_INDEX=<源>`
- 换源只作为命令参数或用户级配置，不写进项目依赖文件。

### JavaScript（npm / pnpm / yarn）

按顺序使用：

1. `https://registry.npmmirror.com`
2. `https://mirrors.cloud.tencent.com/npm/`
3. `https://repo.huaweicloud.com/npm/`

- npm：`npm install --registry=<源>`
- pnpm：`pnpm install --registry <源>`
- yarn：`yarn install --registry <源>`
- 注意：**运行时不再从 registry 装**。节点运行时是下载的归档（CNB 一个源）。
  但节点**仍然需要 npm**：第三方插件开关是 `npm install` 到节点 profile 里的
  （`installPlugins`），用节点自己的 registry 配置，不由本机决定。装不上时先去节点上查
  `npm config get registry`。registry 也影响本机与打包机；打包时
  `build-fork-runtime.mjs --registry` 默认 `npmmirror`。

## 14. 真源优先级

1. **`docs/GOAL.zh.md`（用户口述的目标本身）** > 当前设计文档 / `docs/ARCHITECTURE.md`。
   目标与设计冲突时，设计错，改设计。
2. 当前源码、测试、配置、日志、git 状态、用户侧证据。
3. 本文件（AGENTS.md）与同层 agent 规则。
4. 仍有效的 docs、README、issue、review 评论。
5. 归档文档与旧会话只作模式参考，不能覆盖当前事实。

冲突时先报冲突、证据与推荐处理方式，等确认。
