# 验收流程（真实使用级）

这份文档不是「跑一遍脚本看有没有报错」。它要求像用户一样**真的打开界面、真的在远程会话里
下指令**，然后**读回远程大脑自己的记录**逐条核对。每一步都写明：怎么触发、期望看到什么、
凭什么判断通过、失败了先看哪里。

脚本只是把下面的人工步骤固定下来；判断标准以本文档为准，不以脚本退出码为准。
**为什么这样设计**（而不是"顺手把理由也写在这里"）：设计取舍只有一个真源
`docs/ARCHITECTURE.md`，本文只负责「怎么验、看到什么算过」。

## 一条命令跑完

```powershell
node packages/dsh-remote-node-harness/test/run-all.mjs
```

它会自己启动一个 `--profile rnhtest` 的 Host、连上已记录的节点，按三层跑完全部 35 个套件，
每个套件一行结论，失败的附最后几行输出与完整日志路径。**任何一层失败都以非零退出**。

```powershell
node packages/dsh-remote-node-harness/test/run-all.mjs --list              # 打印矩阵，不跑
node packages/dsh-remote-node-harness/test/run-all.mjs --layer offline     # 秒级：纯逻辑 + 组合检查
node packages/dsh-remote-node-harness/test/run-all.mjs --layer contract    # 契约缝隙（用 Electron 的 Node 读 app.asar）
node packages/dsh-remote-node-harness/test/run-all.mjs --layer e2e         # 端到端：Host + 节点
node packages/dsh-remote-node-harness/test/run-all.mjs --skip artefact,browser --keep-host
node packages/dsh-remote-node-harness/test/run-all.mjs --host <base> --token <t>   # 复用已在跑的 Host
```

跑它需要两个外部条件，缺了就**报告 SKIP 并说明原因**，绝不写成通过：

| 条件 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| 节点凭据 | `RNH_TEST_HOST/USER/PASSWORD\|KEY_FILE` | 端到端全部 SKIP；若整层一个都没跑，命令以**退出码 1** 结束，因为"证明用户能干活"的那一层没有被检验 |
| Chrome 调试端口 | `DSH_BROWSER_DEBUG_PORT`（默认 9222，需以 `--remote-debugging-port` 启动） | 只有 `browser` 一个套件 SKIP |
| 节点上的 Release 制品 | 已发布的 `v<版本>` | 只有 `artefact` 一个套件 SKIP（可 `--skip artefact`） |

套件可以自己声明"这台部署跑不了"并退出码 3，runner 会把它记成 SKIP 而不是 PASS —— 目前用在三处：
`approval` 在节点被设成 `danger-full-access` 时根本不会发审批请求，硬跑只会是一串空断言；
`browser` 在没有 Chrome 调试端口时连不上页面，只会在抓取处抛 `ECONNREFUSED`；
`plugin-switch` 在本机没装任何第三方插件时没有可切换的对象。

## 0. 前置

| 项 | 要求 |
|---|---|
| 桌面端 | 用 `--profile rnhtest` 启动的 Host，不是你正在用的那个 profile |
| rnhtest 的 bundle 清单 | 必须同时有 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与本插件。用 `dsh plugin add` 建的 profile 只有前两者之外的插件，**缺 `dsh-web-app` 时 Host 启动后不打印 `dsh web:` 那一行**，runner 会在 90 秒后报「the Host exited」或读不到 URL —— 这个坑已经踩过两次 |
| rnhtest 里装的是这一轮的代码 | 打包后装进去，而不是软链：`npm pack --pack-destination ../../dist/plugin`，再把 `profiles/rnhtest/package.json` 的依赖指到新 tgz 并 `pnpm install`。跑之前确认 `profiles/rnhtest/node_modules/@greatbaby/dsh-remote-node-harness/package.json` 的 `version` 就是本轮版本。**改完代码忘了重打，套件跑的还是旧字节**，而失败信息会指向一个早已修好的地方 |
| rnhtest 的 profile patch | 至少要有三行：`llm-deepseek.baseURL`（指向这台机器能用的 provider）、`agent-default-model`（`provider` + `model` 都必须写）、`permission`（`defaultPreset: danger-full-access`）。缺第一条 → 401；缺第二条 → 默认模型被代理拒（503 重试到超时，一个工具都不会跑）；缺第三条 → 节点没有沙箱后端时每个 `bash` 都 `SANDBOX_ESCALATION_UNAVAILABLE` |
| 节点 | 一台 Linux 机器，Node ≥ 22，SSH 可达，能匿名下载 CNB 上的归档（源与理由见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之四） |
| 凭据 | 只从环境变量读：`RNH_TEST_HOST/USER/PASSWORD/KEY_FILE/PORT`。profile 里没有节点时 runner 会用这三个变量建一条，名字取 `RNH_TEST_NAME`（默认 `acceptance-node`） |
| 节点 `remoteRoot` | 可以不是默认值。套件从 `/rnh/api/nodes` 的 `remoteRoot` 派生 profile 名与状态文件路径（`test/layout.mjs`），所以 `~/.dsh-fleet` 这种根也能跑；**不要再往套件里写 `~/.dsh/profiles/rnh`** |
| provider key | LLM 相关套件需要。runner 从真实 home 的 `.credentials.yaml` 按名读出 `DEEPSEEK_API_KEY`，**只塞进测试 Host 的子进程环境**，不落盘、不打印、不进 `.scratch`。取不到时那 5 个套件会失败（不是 SKIP），因为「测试自己没配好」不该被记成通过 |
| 加速 | 节点侧确认 `curl -fLsS -o /dev/null -w '%{http_code}' https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/v<版本>/dsh-<版本>-<平台>.tar.gz` 返回 200 或 302；CNB 是唯一的下载源（ADR-0007） |

启动测试 Host（PowerShell，`DSH_HOME` 是你的真实 home，profile 是隔离的）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"; $env:DSH_HOME = "C:\Users\<你>\.dsh"
$cli = "D:\Program Files\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
Start-Process "D:\Program Files\DSH\DeepSeek Harness.exe" `
  -ArgumentList @("--expose-internals", "`"$cli`"", "--profile", "rnhtest",
                  "--host", "127.0.0.1", "--port", "0", "--no-open") `
  -RedirectStandardOutput .scratch\host-test.log -RedirectStandardError .scratch\host-test.log.err
```

从 `.scratch\host-test.log` 里读 `dsh web: http://…` 那一行，`?token=` 后面是本次的启动令牌。
**每次重启 Host 令牌都会变，脚本必须重新读。**

## 1. 侧栏：远程工作区就在普通列表里

人工：打开上面的 URL，看左侧栏。

- 期望：远程节点的工作区（目录名 + 真实远端路径）和本地工作区**排在同一个列表里**，没有单独
  「远程」入口，没有嵌套菜单。
- 判据：侧栏文本能读到远程工作区的标题；点进去能新建会话。
- 失败先看：`/rnh/api/nodes` 的 `state` 是不是 `connected`；`workspace/follow` 的 baseline
  里 `rnh_<nodeId>_` 前缀的行数。

```powershell
node packages\dsh-remote-node-harness\test\workspace-flow.mjs <base> <token>
```

## 2. 真实会话：下一条真指令，让节点自己动手

人工：在**远程**工作区里新建会话，输入：

```
在 <远端路径> 下做三件事，每件都用工具真做，不要只用文字回答：
1. 用 write 工具创建 acceptance-<随机>.txt，内容只有一行：ACCEPTANCE_<随机>
2. 用 bash 或 pwsh 工具运行 wc -c < 那个文件，并原样贴出输出
3. 用 grep 工具在文件里搜 ACCEPTANCE_<随机>
最后一行只回复 DONE。
```

期望与判据（缺一条不算过）：

1. 会话头 `cwd` 是**节点的路径**（`/root/...`），不是本地镜像路径；
2. `session/follow` 里出现三条 `tool/call`，名字分别命中 write / bash|pwsh / grep；
3. 三条都产生 `tool/result`，且没有 `isError`；
4. `turn/end` 的 reason 是 `{kind:'completed'}`；
5. 助手最后一条文本包含 `DONE`；
6. **独立证据**：另开一条 SSH 连接 `cat` 那个文件，字节内容等于 prompt 里给的那一行；
7. 会话出现在 `/rnh/api/nodes` 对应节点的 `session/list` 里，`updatedAt` 晚于下指令的时刻。

```powershell
node packages\dsh-remote-node-harness\test\session-acceptance.mjs <base> <token>
```

> 第 6 条是这套验收的关键：插件自己报告「我调用了 write」不算证据，节点文件系统上有那个字节
> 才算。脚本用 `test/node.mjs` 另建 SSH 连接读文件，不复用插件连接。

### 2b. 同一件事，从界面做一遍（不碰 API）

脚本走的是协议；用户走的是界面。两者都要过，因为协议对了界面也可能没接上。这一步的
判据是**页面上看得见**，不是接口返回：

1. 侧栏里点远程工作区的「新建会话」→ 页面出现一个新的空会话，模型选择器旁显示的是
   **那个工作区**的名字（`rnh-relay-mwkiidoo`），不是本地某个工区；
2. 在输入框里真敲一条指令（不是脚本注入 `textContent`：编辑器的内部模型要收到真实的
   `insertText`，否则发送按钮不会亮）：
   `在 /root/<dir> 下用 write 工具创建 gui-<随机>.txt，内容只有一行 <随机>；然后用 bash
   工具运行 wc -c 那个文件并原样贴出输出；最后一行只回复 DONE。`
3. 发送 → 页面上依次出现「正在分析请求 / 深度求索中」→「已完成，用时 …秒」，正文里有
   代码块 `13 gui-<随机>.txt` 和 `DONE`；
4. **独立证据**：另开 SSH `cat` 那个文件，内容与 prompt 一致（实测 13 字节 = 12 字符 +
   换行）。
5. 会话标题是模型起的（实测「创建验收文件并统计字节」），说明标题那条 LLM 调用也发生在
   节点上，不是本地补的。

实测记录（2026-11-17 22:04，本地 Chrome 9222 驱动真实页面）：新建会话 → 输入 → 发送 →
18 秒完成 → `cat` 得到 `ACCEPT_956968`（13 字节）→ 节点日志
`--root-rnh-relay-mwkiidoo--/session-83de59a8-…` 里 `seq 20` 是 `tool/call` name=`write`、
`seq 26` 是 `tool/call` name=`bash`、`seq 36` 是 `turn/end {kind:completed}`。

## 3. 终端：在远程会话里真开一个 PTY

人工：打开远程会话的终端面板，新建终端，输入 `echo MARKER_<随机>`。

期望与判据：

1. `terminal/environment` 返回节点的 `cwd`（`/` 开头）与 `maxInputBytes`；
2. `terminal/shells` 列出节点自己的 shell（实测 `bash,pwsh`）；
3. `terminal/create` 建出的终端 `state=running`，`cwd` 是节点目录；
4. attach 首帧是 `snapshot` 且 `writable=true`；
5. 写入 `echo …\r` 后能读到输出，且节点回了 `ack`（说明序号连续）；
6. `terminal/close` 之后它从节点花名册里消失。

```powershell
node packages\dsh-remote-node-harness\test\terminal-acceptance.mjs <base> <token>
```

## 4. 审批与提问：卡片必须真的弹在本地

人工：在远程会话里触发一次需要审批的工具调用（例如让 agent 写工作区外的文件），再触发一次
`ask_user_question`。

期望与判据：

1. 本地浏览器弹出**上游原生**的审批卡片（不是插件自绘的）；
2. 卡片的会话标题是那个远程会话，不是空白、不是本地同名会话；
3. 点「允许」后远程回合继续并最终完成；点「拒绝」后远程回合收到拒绝并继续收尾；
4. 提问卡片同样能弹出、能选、回答能回到节点（节点侧 `userQuestions.settled` 出现该条）。

```powershell
node packages\dsh-remote-node-harness\test\event-relay.mjs <base> <token>
node packages\dsh-remote-node-harness\test\waterfall-unit.mjs
```

## 5. 多节点：同时连两台，互不串号

人工：再添加一台节点（可以是同一台机器的另一个 `remoteRoot`），两台同时连接。

期望与判据：

1. 两台同时 `connected`；
2. 侧栏里两台的工作区都出现，workspaceId 全部唯一；
3. 各自新建的会话 id 前缀是各自的 nodeId，读回时落到正确的节点；
4. 两台会话在合并列表里是两行，不互相覆盖；
5. 移除其中一台，另一台的会话仍然在。

```powershell
node packages\dsh-remote-node-harness\test\multi-node-acceptance.mjs <base> <token>
```

## 6. 版本闸门与节点运行时

人工：把节点上的 `~/.dsh-remote-node-harness/runtime` 删掉（或换成别的版本），然后点「连接」。

期望与判据：

1. 节点自动下载 `dsh-<version>-<platform>.tar.gz`（CNB，唯一的源；**拿不到就报错**，
   报出试过的 URL，不回退直连也不回退 npm），校验 sha256，解压后替换 `runtime`，旧树留成
   `runtime.previous`；
2. 装完 `node …/lib/bin.js --version` 等于桌面版本；
3. **原生包必须是节点的平台**：`sherpa-onnx-linux-x64`、`@img/sharp-linux-x64`，不能出现
   `win-x64`；
4. 节点比桌面**新**时拒绝连接，并说明原因（不是静默降级）；
5. 同一个版本但打包规则不同（`.rnh-artefact.json` 的 build 号不一致）时**重装**，不只比版本。

```powershell
node packages\dsh-remote-node-harness\test\artefact-acceptance.mjs
node packages\dsh-remote-node-harness\test\version-unit.mjs
```

发布新制品（会写 CNB 与 GitHub Release，需要用户确认；制品必须来自 fork 构建，不是上游发布版）：

```powershell
$env:CNB_TOKEN = "…"
node packages\dsh-remote-node-harness\scripts\build-fork-runtime.mjs --platform linux-x64 --publish --cnb
```

## 7. 插件同步开关

人工：打开 设置 → 远程节点 → 插件同步。

期望与判据：

1. 列表的单位是**你自己装的插件**，不是内部行：`@local/dsh-rhino-mode`、`dsh-pet`、
   `dsh-whale-widget` 之类，一行一个，行里带版本/范围、它贡献多少行、以及「本机已加载」
   还是「本机已安装但不在组合里」；
2. `@deepseek-ai/*` 与大脑 bundle 不出现 —— 它们是产品本身，不是选项；
   `NODE_NEVER_SYNC` 里的五个名字（含 `ds-harness-remote`）也不出现；
3. 默认**全部开启**：这台机器装了、起了作用，节点就是同一个工作面的延伸（为什么默认全开、
   为什么有硬排除清单，见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之五）。关掉一个就只在这台
   机器上运行；
4. 打开一个开关后，那一行必须真的落地，四条都要成立：
   - 节点 profile 的 `package.json` 的 `dependencies` 多出这个包，
     `node_modules/<包>` 真的存在；
   - `dsh.profile.bundles` 变成 **base → 你打开的插件 → `@local/rnh-brain`**；
   - 常驻 host 被重启且 `session/list` 还能答（切换后 `/rnh/api/workspaces` 仍有远程工区）；
   - 接口返回里带每个节点的原文结果，节点没接受就带 `warning`，页面把节点的话显示出来；
5. 关掉开关：包从 bundle 列表移除，节点重启，工区照旧；
6. 把开关拨回默认值，profile 目录里的 `rnh-plugins.json` 那条记录被删掉，而不是存成同值
   （为什么存 profile 内、为什么删而不是存同值，见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之五「状态存哪」）；
7. 页面本身能滚动：整页高于窗口时出现滚动条（实测 `mainPanel` 1026px 高、内容 10658px；
   原因与修法见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之六「页面骨架是量出来的」）。

```powershell
node packages\dsh-remote-node-harness\test\version-unit.mjs       # 开关语义（哪些算第三方、默认开、顺序、容错）
node packages\dsh-remote-node-harness\test\run-all.mjs --layer e2e --only plugin-switch  # 真的落到节点并重启
```

## 7b. 加工作区：先选机器，再选目录

人工：左侧栏「工作区」旁的点号 → 添加工作区…（或新建会话时的「选择工作区」→「添加工作区…」）。

期望与判据：

1. 弹出的是**本项目的**对话框，不是系统原生选择框。第一屏是**表单**，字段顺序固定为
   项目名称 → 设备 → 源文件夹；「新建会话」入口标题是「创建项目」、末按钮「创建」，
   侧栏入口标题是「选择工作区文件夹」、末按钮「加入工作区」，其余字段完全一样；
2. 项目/工作区名称留空就用文件夹名；填了就用手填的名字；
3. 设备下拉圆角自绘，选项是「本机」+ 每个节点（`名字 · 主机`），**最后一项是「添加远程设备…」**，
   选中它进新增节点表单（与设置页同一个表单），提交后回到第一屏且新节点已经在列表里；
4. 选节点后，设备下方多一行「这台设备上已有项目？添加到侧栏 ›」，点开列出**那台机器上已有**的工作区，
   点一条直接按那条路径建/选工作区，不必再浏览；
5. 「源文件夹」是虚线空态卡片（「选择文件夹 / Harness 可以读取和编辑这些文件夹」）；点它进第二屏
   浏览页，标题「选择文件夹」，左上「‹ 返回」，机器仍可切换；
6. 浏览页：选「本机」列的是本机目录、**盘符 chips 覆盖所有存在的盘**（不只 C:）；选节点列的是
   **节点上的**目录（`/root` 下的真实名字），上一级/打开/直接输路径都能用，路径栏显示节点绝对路径；
7. 「＋ 新建文件夹」在对话框内展开内联表单：自己命名 → 「创建」 → 目录列表跳进新目录；本机与节点
   走同一个手势，落到各自磁盘上；建好后点「选择此文件夹」回第一屏，源文件夹显示成
   `名字 + 绝对路径 + 更换`；
8. 点末按钮：侧栏立刻出现这个工区（标题就是第 2 步的名字），`/rnh/api/workspaces` 里有
   `rnh_<nodeId>_…` 行且 `path` 是节点路径；
9. 进那个工区新建会话，会话 `cwd` 是节点路径 —— 与本地工区的操作完全相同。

失败先看：`GET /rnh/api/browse?node=<id>&path=` 的返回；节点未连接时该接口报
`this node has no stored password` 之类的 SSH 原文，而不是空列表。新建文件夹失败返回
`node-not-found` 404 / `node-offline` 409 / `name-invalid` 与 `create-failed` 400，不编造成功。
名称非空时先建工作区再交接，失败会停在表单里报错、不交接 —— 否则就是「点了没反应」。

```powershell
node packages\dsh-remote-node-harness\test\workspace-browse.mjs <base> <token>
```

判据与脚本的对应关系（脚本只是固定手势，标准以本条为准）：

| 判据 | 脚本里对应的断言 |
|---|---|
| 1 是本项目的对话框 | `client-bundle.mjs`：三个 `*.directoryFlow` 插槽都注册且渲染 |
| 2 可以自己命名 | `workspace-browse.mjs`：POST 带 `title` → 合并后的行 `title` 就是它，不带 `title` 时回落成文件夹名 |
| 3/4/5/6 设备与浏览 | 同脚本：下拉第一项 `''`＝本机，其余是节点（`名字 · 主机`）；节点那一路的 `nodeId` 就是被选中的节点、`home` 是节点上的 `/root`、`/` 没有上级、隐藏目录不出现、不存在的目录带 shell 原文；本机那一路的 `roots` 含非 `C:` 盘 |
| 7 能新建文件夹 | 同脚本：本机与节点各建一个目录，建完能列举到；重名与 `../escape` 各自 400 |
| 8 选中即落地 | 同脚本：POST 后返回 `rnh_<nodeId>_…` 身份 + 节点绝对 `path`，且出现在 `workspace/follow` 的合并 baseline 里 |
| 9 与本地操作相同 | 同脚本：同一目录再选一次是幂等的（同一个 workspaceId），相对路径被 400 拒绝 |

## 7c. 远程会话里那几处「和本地一样」

远程大脑的会话与本地会话在同一个侧栏，所以**本地能点的每个入口在远程会话里都得能用**，
或者给出一个说得通的拒绝。人工在**远程**工作区的会话里逐项过一遍：

| 入口 | 期望 | 凭什么判断 |
|---|---|---|
| 智能体协作开关 | 真的能开、能关 | 开关落到节点的 `agentTeams/setEnabled`；本机不报 `subagent tree access requires the exact live caller` |
| 子代理会话的历史 | 点开能读到那条子会话的记录 | 侧栏列出的子会话 id 是 `rnh_<nodeId>_<裸 uuid>`；`session/page` 返回 `cursor>0` 且含 `subagent/descriptor` |
| 产物卡片「在文件管理器中显示」 | 远程文件**不假装能开** | 点开得到 422，卡片显示「此文件没有可用的主机路径，请在侧边栏预览」；**不是**「无法在文件管理器中显示，请重试」那种让人反复重试的文案 |
| 产物卡片预览 | 能读到内容 | `/api/present.open` 先转发节点的 `session/page`，再被 `openVerified` 以 422 拒绝原生打开 —— 预览走的是另一条（`workspaceFiles/read`），照旧可用 |

## 8. 纯逻辑与契约层（每次改代码都要跑）

一条命令跑完这两层，它自己会挑对解释器（契约层要用 Electron 的 Node 读 `app.asar`）：

```powershell
node packages\dsh-remote-node-harness\test\run-all.mjs --layer offline,contract
```

单跑某一个套件时才用直调形式；`test/run-all.mjs --list` 打印全部 39 个套件与它们各自的依赖。
**每个套件守的是哪条上游契约、DSH 升级后按什么顺序重跑**，见 [`UPGRADE.zh.md`](UPGRADE.zh.md) §二。

```powershell
node packages\dsh-remote-node-harness\test\routing-unit.mjs
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\Program Files\DSH\DeepSeek Harness.exe" packages\dsh-remote-node-harness\test\dispatch-seam.mjs
```

## 9. 端到端（需要运行中的 Host + 连上的节点）

```powershell
node packages\dsh-remote-node-harness\test\run-all.mjs --layer e2e
node packages\dsh-remote-node-harness\test\run-all.mjs --layer e2e --host <base> --token <t>   # 复用已在跑的 Host
```

单跑某个套件时：`node packages\dsh-remote-node-harness\test\<套件>.mjs <base> <token>`。套件清单见
`run-all.mjs --list`，每个套件验什么见 `docs/ARCHITECTURE.md` §七。

## 判定

- 第 1–7c 节全部通过才算「能用」。任何一条失败都要先复现、留证据、写出可证伪的假设，再改。
- 退出码 0 只证明那一层；构建通过不代表界面正确，单测通过不代表端到端可用。
- 跑不了的项必须写明原因与替代证据，不许隐瞒。
- 每轮验收后把失败项、修复、重跑结果追加到本文档末尾的「验收记录」。

**端到端层的通过口径**：`0 failed`，且剩下的 SKIP 每一条都有具体原因。允许的 SKIP 只有四类：

| SKIP | 原因 |
|---|---|
| `e2e/browser` | 没有带 `--remote-debugging-port` 的 Chrome |
| `e2e/multi-node` | 只有一台可用节点 |
| `e2e/artefact` | 节点拿不到制品（网络），或 `RNH_SKIP_RELEASE=1` |
| `e2e/plugin-switch` | 本机没装任何第三方插件 |

**手机真机四步（看会话、新建工作区、看文件改动、答审批）不在自动化验收范围内。**
本轮只做到「桌面侧能证明的部分」：远端行进 `session/list`、`directoryPicker/list` 对不存在的
节点路径给空层、`workspace/create` 在节点上落盘、中转补丁装在产物里且 `local.relay.patched`
为真。**真机未验证就是未验证**，不许拿桌面结果代替。

## 验收记录

> 这里只留**结论与证据位置**，不复述修法 —— 每条修法都已写进
> `docs/ARCHITECTURE.md` 对应章节或代码注释里，两处各写一遍必然互相矛盾。

### 2026-11-17 · DSH 0.2.2-rc.3 · 节点 linux-x64

| 节 | 结果 | 证据 |
|---|---|---|
| 1 侧栏 | 通过 | 真实 Chrome 读 DOM：`grouptest`、`rnh-second`、`rnh-brain-test` 三个远程工区与本地工区在同一列表（`.scratch/browser-acceptance.png`） |
| 2 会话 | 通过 | 真下指令 → 节点真跑 write/bash/grep → `turn/end={kind:completed}` → 助手说 DONE → 独立 SSH 读到 `acceptance-*.txt` 字节与 prompt 一致（20 字节） |
| 3 终端 | 通过 | `environment` 返回 `/root/grouptest` + 65536；shells 为 `bash,pwsh`；attach 首帧 snapshot 且 writable；echo 命令收到 2 次回显；节点 ack；close 后花名册为空 |
| 4 审批/提问 | 通过 | `waterfall-unit` 7 段全过；`approval-acceptance` 在真节点上走完整条链：节点 `approval/asked` → 本机 `waterfall` 帧带着包裹后的 agentId → 答复 `$events/result` → 节点 `approval/decided=allowed-once` → 文件真的写出来；第二次改成拒绝，节点记 `rejected` 且文件不存在；`ask_user_question` 用 `{answers:[{id,selected}]}` 批量答复，节点的工具结果原样回带 `red` |
| 5 多节点 | 通过 | 同一机器两个 `remoteRoot` 同时 connected；两边工区 id 唯一；各建 Session 前缀各自 nodeId、读回落到正确节点；合并列表两行；移除一台不影响另一台 |
| 6 版本闸门 | 通过 | `version-unit` 全过；`artefact-acceptance` 在真节点 8 秒装完 832 MiB、原生包 `sherpa-onnx-linux-x64`/`sharp-linux-x64`（无 win-x64）、二次安装与回滚均通过；一台 3.9 GB 的旧树被替换成 832 MiB |
| 7 插件开关 | **已被取代** | 当时按"节点组合的每一行"做开关，实际用不了；现设计是**按 bundle**，见 §7 判据 |
| 8 纯逻辑 | 通过 | routing-unit / multipart-unit / provision-unit / waterfall-unit / version-unit / dispatch-seam / upstream-smoke / descriptor-smoke |
| 9 端到端 | 通过 | workspace-flow / host-routing / tool-parity / tool-git-image / client-bundle / event-relay / gateway-smoke / session / terminal / multi-node / artefact / browser / approval |

### 2026-11-17 · 一条命令跑完 22 个套件

`node test/run-all.mjs` 在 `rnhtest` + 真节点上跑出 **22 passed, 0 failed, 0 skipped in 250s**：

| 层 | 套件 |
|---|---|
| offline（6） | routing / multipart / provision / waterfall / version / composition |
| contract（3） | descriptor / dispatch / upstream（都走 Electron 的 Node 读 `app.asar`） |
| e2e（13） | gateway / host-routing / workspace-flow / tool-parity / tool-git-image / client-bundle / event-relay / session / terminal / multi-node / artefact / approval / browser |

runner 自己的三条硬约束（退出码要真的表示结论、没跑不等于通过、SKIP 必须带原因）是设计取舍，
见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §七「一条命令跑完」。实现上 runner 按
`failed.length` 决定退出码，并在「请求了 e2e 却一个都没跑成」时强制 `exit 1`；四种 SKIP 条件
（缺节点凭据、缺 Chrome 端口、节点无 Release 制品、`danger-full-access` 节点不发审批请求）见本文
「一条命令跑完」那张表。

### 2026-11-17 · 一条命令跑完 24 个套件

`node test/run-all.mjs` 在 `rnhtest` + 真节点（`probe-93`，linux-x64）上跑出
**24 passed, 0 failed, 0 skipped in 247.5s**：

| 层 | 套件 |
|---|---|
| offline（6） | routing / multipart / provision / waterfall / version / composition |
| contract（3） | descriptor / dispatch / upstream（都走 Electron 的 Node 读 `app.asar`） |
| e2e（15） | gateway / host-routing / workspace-flow / workspace-browse / plugin-switch / tool-parity / tool-git-image / client-bundle / event-relay / session / terminal / multi-node / artefact / approval / browser |

本轮新增的两个套件（`workspace-browse.mjs`、`plugin-switch.mjs`）各自验什么，见
[ARCHITECTURE](../../../docs/ARCHITECTURE.md) §七 测试表的对应行。

### 2026-11-17 · 一条命令跑完 24 个套件（第二次）

`node test/run-all.mjs --host … --token …`（复用已在跑的 `rnhtest` Host、真节点 `probe-93`）：
**22 passed, 1 failed, 1 skipped in 1747.5s**。

| 层 | 结果 |
|---|---|
| offline（6） | 全过 |
| contract（3） | 全过 |
| e2e（15） | 13 过；`artefact` 1500 s 超时；`browser` 因未设 `DSH_BROWSER_DEBUG_PORT` 报 SKIP |

修完两条之后**重跑全绿**：`24 passed, 0 failed, 0 skipped in 1217.9s`
（`DSH_BROWSER_DEBUG_PORT=9222` 已设；`artefact` 单项 964.1 s）。

两个非绿项都不是功能坏了，逐条结论如下（修法与常量见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之四）：

1. **`artefact` 超时是一次真的缺陷暴露，已修。** 单独复跑 68 s 全过，说明装得上；慢的是下载这一步。
   实测两条候选 URL 的差距：加速地址 4 s 拉完 172 683 323 字节，直连 GitHub 30 s 只拿到
   925 295 字节。修完后这一项的预算提到 2700 s（这套要装两次），实测 **653 s**，20 条断言全过。
2. **`browser` 是环境 SKIP，不是通过。** 单独用 `DSH_BROWSER_DEBUG_PORT=9222` 复跑全过
   （10 条断言：侧栏渲染、合并 baseline 7/7 远程工区、三个远程工区标题可见、插件入口
   「远程节点」可达、结束仍绘制），截图 `.scratch/browser-acceptance.png`。

本轮同时修掉的两个「页面上看着正常、换了会话就废」的问题（都已在实际 GUI 上验证）：
智能体协作开关（`agentTeams/setEnabled` 的 `Agent` 形参，修法见 §五「形参里是 `Agent` 的两个
例外」）、子代理会话历史（裸 uuid 按字段名包装，理由见 §四）。实测 5 个子会话 id 全是
`rnh_n00a5f7394401_<uuid>`，`session/page` 返回 `cursor=19` 且含 `subagent/descriptor`。

界面侧这轮补齐的两处（都在真实 Chrome 里点过）：

- **插件同步卡片**改成和官方「已安装插件」一致的排版：36×36 图标、标题、两行描述、右侧开关；
  没有自带图标的插件画一个中性方块图标（原先是一个彩色 emoji，混在真图标里像另一种东西）；
  中英文按浏览器语言各取一份。
- **目录对话框**：加了「工作区名称」输入框（留空用文件夹名）、圆角「在哪台机器上」下拉、
  「＋ 新建文件夹」内联表单、本机盘符 chips 覆盖所有存在的盘而不是只有 `C:`。真实 GUI 走查：
  切设备 → 新建文件夹 `accept-1794919839121` → 命名工作区「中继实验」→ 加入工作区，
  侧栏出现该工区（17 个工作区）。

### 2026-11-18 · 「创建项目」表单 + 六项功能真实用户验收

**这一轮的验收方式是用户视角**：下达一条真指令到节点，用界面点，再用独立 SSH 读磁盘核对。

一、全量矩阵（`node test/run-all.mjs`，`rnhtest` Host + 真节点 `probe-93`）：
第一次跑 **23 passed, 1 failed, 0 skipped in 1557.8s**，唯一失败项是 `e2e/multi-node` ——
这套测试给第二个记录写死了 password，而测试机只配了 `RNH_TEST_KEY_FILE`，于是第二个
记录没有可用凭据。与 `node.mjs` 对齐后单跑 **1 passed in 10.3s**，重跑全量
**24 passed, 0 failed, 0 skipped in 590.2s**。

二、第 6 项「创建项目」表单（真实 Chrome 9222，全部靠点击，不碰 API）：

| 判据 | 实测 |
|---|---|
| 新建会话入口是「创建项目」，字段序 项目名称 → 设备 → 源文件夹 | 通过：`aria-label="创建项目"`，正文含「项目名称 / 设备 / 本机 / probe-93 · <node-host> / 添加远程设备… / 源文件夹 / 选择文件夹 / 取消 / 创建」 |
| 侧栏入口说「选择工作区文件夹 / 工作区名称 / 加入工作区」 | 通过：同一组件在 `sidebar.workspaces.directoryFlow` 下报另一套词 |
| 设备选节点后出现「这台设备上已有项目？添加到侧栏 ›」 | 通过：切到 `probe-93` 后该行出现 |
| 点它能列出**那台机器上已有**的工作区 | 通过：`aria-label="添加到侧栏"` 的页里 8 行，与 `/rnh/api/workspaces` 的 8 条远程行一一对应 |
| 点一条直接交接，不必再浏览 | 通过：点「验收项目」→ 对话框关闭 → 进入该工区的新会话页 |
| 源文件夹是虚线空态卡片 | 通过：截图里「选择文件夹 / Harness 可以读取和编辑这些文件夹」是虚线卡 |
| 第二页「选择文件夹」可返回、机器仍可切 | 通过：正文首行「‹ 返回」，下拉仍在且值仍是节点 |

三、同一个对话框真的建出一个远程工区（用户在界面里做，不看接口）：

1. 表单里填名称 `验收项目`，设备选 `probe-93`；
2. 点源文件夹 → 第二页 → 「＋ 新建文件夹」→ 命名 `accept-project-1` → 「创建」→ 列表跳进
   `/root/accept-project-1`；
3. 「选择此文件夹」→ 回第一屏，源文件夹显示 `accept-project-1 / /root/accept-project-1 / 更换`；
4. 「创建」→ 对话框关闭，侧栏出现「验收项目」；
5. 接口核对：`/rnh/api/workspaces` 从 7 条变 8 条，多出
   `验收项目 | /root/accept-project-1 | rnh_n00a5f7394401_ef149cfe-…`。

四、像真实用户一样给远程大脑下达任务（验收的核心，不是跑脚本）：

在「验收项目」工区新建会话，用真实 `Input.insertText` 敲入并点 `aria-label="发送消息"`：

> 在 /root/accept-project-1 下做三件事，每件都用工具真做：1. 用 write 工具创建
> task-ACCEPT_540623.txt，内容只有一行 ACCEPT_540623；2. 用 bash 工具运行
> wc -c task-ACCEPT_540623.txt 并原样贴出输出；3. 用 bash 工具运行 hostname 并原样贴出输出。
> 最后一行只回复 DONE。

页面回读：**「已完成，用时 14秒」**，正文三段 —— 已用 write 工具创建那个文件、代码块
`14 task-ACCEPT_540623.txt`、代码块 `Develop`、末行 `DONE`；用量算 `1 轮 4 步 · 256 tok/s`。

**独立证据**（另开一条 SSH，不复用插件的连接）：

```
$ cat /root/accept-project-1/task-ACCEPT_540623.txt   →  ACCEPT_540623
$ wc -c …                                             →  14 /root/accept-project-1/task-ACCEPT_540623.txt
$ hostname                                            →  Develop
```

节点的 `hostname` 是 `Develop`，本地不是 —— 这条比任何日志都直接地说明工具真的在节点上跑。

再验证界面里的产物入口：点会话里「在侧边栏打开 …/task-ACCEPT_540623.txt」，右侧预览直接显示
`ACCEPT_540623` —— 远程产物的预览走 `workspaceFiles/read`，和本地一样能用。

五、这一轮动到的代码与文档：`client.js` 的 `WorkspaceFolderFlow` 从「一个文件浏览器」改成
「表单 + 浏览 + 加设备 + 已有项目」四页（两套词按插槽名选，新增 15 个文案键）；
`docs/ARCHITECTURE.md` §六之六 补对话框形态；`multi-node-acceptance.mjs` 支持 key 认证。

### 2026-11-19 · 开机自动连接、节点管理模式命名、设置页样式对齐

这一轮由三条用户反馈驱动，每条都先复现再改。修法都写进了
`docs/ARCHITECTURE.md`（§连接状态机、§六之七、§六之六「页面骨架是量出来的」），这里只记结论。

一、**「重启后远程节点界面无变化」→ 真因是开机后一个节点都没连。** 用内存注册表 + 内存凭据库的
夹具复现：修复前 `connect` 调用 **0 次**，修复后 **1 次**；`rnhtest` Host 冷启动 24 s 后
`rnh/api/nodes` 直接报 `state: connected`，无需点击。根因与修法见
[ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六「开机自动连接：先取凭据，再判断」。

二、**「节点管理模式怎么没有出现」→ 预设装上了，但它在选择器里叫 `node-control`。**
`agentPresets/list` 一直有它，`node-control.mjs` 的 13 条断言也一直全过。补上 `name: 节点管理`
与说明后与 `rhino-mode` 同形；为什么这两个字段是可选的、漏写为什么不报错，见
[ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之七「预设必须有 `name` 和 `description`」。

三、**设置页风格与官方不一致。** 七项逐项实测对齐，顺带修掉组标题被压成竖排的真实布局缺陷；
逐项数值与三处踩过的坑见 [ARCHITECTURE](../../../docs/ARCHITECTURE.md) §六之六「页面骨架是量出来的」。

**验收证据（全部可复跑）**

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 纯逻辑 + 契约 | `run-all.mjs --layer offline,contract` | 11 + 3 全过 |
| 端到端（15 套件，`rnhtest` Host + 真节点 `probe-93`） | `run-all.mjs --layer e2e --skip artefact,browser` | **15 passed, 0 failed, 0 skipped in 161.7s** |
| 清单自洽 | `test/install-unit.mjs` | 157 checks passed |
| 开机自动连接 | `test/autoconnect-unit.mjs` | 6 checks passed |
| 节点管理模式 | `test/node-control.mjs` | 13 checks passed |
| 设置页截图 | `.scratch/acceptance-2026-11-19/v-settings.png` | 远程节点页：本机 / 远程 / 工作区 / 插件同步 四组卡片 |
| 四页选择器截图 | 同目录 `v-form` `v-device` `v-roots-local` `v-roots-node` `v-browse` | 表单 → 此设备/盘符 → 节点/根目录 → 浏览 |

截图方法记一笔（这是截图通道的坑，不是设计取舍，所以留在这里）：headless Chrome 用
`Page.captureScreenshot` 的**默认路径**抓不到对话框文字（DOM 有正确 rect 与颜色，PNG 里只有遮罩
和白色卡片）。实测 `clip.scale = 1`（full / inset / half / offset 四种）全部拿不到，
`clip.scale = 2` 能拿到（同一 rect 从 0 个暗像素变 213 个）。真实 Electron 窗口是 GPU 合成，文字正常。

### 2026-11-20 · 节点连接被 sshd 判损坏：命令行超了 256 KiB

**症状**：节点 `/var/log/auth.log` 里成百上千条

```
Bad packet length 88734736.
ssh_dispatch_run_fatal: Connection from user root <本机地址> port 62259: Connection corrupted
```

rnh 随即报节点掉线，于是 `plugin-switch` / `tool-parity` / `tool-git-image` / `event-relay`
一起红，全量 e2e 长期停在 `13 passed, 4 failed`。

**量出来的分界**（30 s 窗口，只读节点自己的计数器，`base + dsh-web-app` 打底）：

| 桌面 profile 里有什么 | 连接 | 损坏 |
|---|---|---|
| 只有 rnh | 1 | 0 |
| rnh + `dsh-whale-widget` | 7 | 6 |
| rnh + `dsh-whale-widget`，开关拨到 `{"sync":false}` | 1 | 0 |
| rnh + 插件列着但入口文件改名（装不成也导不进） | 7 | 6 |
| 不启动任何测试 Host，空跑 40 s | 0 | 0 |

即：**多一个 bundle 就坏，与那个 bundle 是什么代码无关**；差别只在 rnh 会不会去"把插件送到
节点"。再把 `syncConfig` 的每一步单独停掉（整包副本 + 真 Host），只有停掉 `#installPlugins`
时损坏消失。

**真因**：ssh2 把一次 exec 请求**当成一个 SSH 包**发出去（`Protocol.js:1273`
`alloc(1 + 4 + 4 + 4 + 1 + 4 + cmdLen)`），OpenSSH 的 `PACKET_MAX_SIZE` 是 256 KiB。
`writePluginBundle` 把整棵插件树 base64 之后拼进命令行，`dsh-whale-widget` 在磁盘上 5.9 MB，
拼出来正好 **7,923,386 字节** —— 与日志里那个反复出现的 `7923616` 差 230 字节（脚本尾部）。
超过上限后 sshd 不是回一个错误，而是读完这个包之后流位置就错了，之后每个包都按错位长度读，
那就是 `Bad packet length` 与 `Connection corrupted`。

单条连接、只发一条命令量的边界：

| 命令行长 | 结果 |
|---|---|
| 240,000 | 连接 +0，损坏 +0 |
| 262,000 | 连接 +0，损坏 +0 |
| 262,200 | 连接 +6，损坏 +6 |
| 300,000 | 连接 +6，损坏 +6 |
| 同样内容走 **stdin**（300 KB / 7.9 MB） | 连接 +0，损坏 +0 |

**修法**（`fix(ssh): 插件树改走 stdin`）：两个 writer 的 payload 从 heredoc 改成 stdin（channel-data
按协商的 `packetSize` 分片，多大都不成一个超大包）；`SshConnection.exec` 加本地闸门
`MAX_COMMAND_BYTES = 128 KiB`，超过就在本地抛 `SSH_FAILURE.PROTOCOL`，不再把包发出去让服务器去
损坏连接。新套件 `test/packet-unit.mjs`（offline 层）钉住这条规则。

**验收证据**

| 项 | 命令 | 结果 |
|---|---|---|
| 纯逻辑 + 组合 | `run-all.mjs --layer offline` | **14 passed, 0 failed, 0 skipped in 2.3s** |
| 契约缝隙 | `run-all.mjs --layer contract` | **3 passed, 0 failed, 0 skipped in 709ms** |
| 端到端（18 套件，`rnhtest` + 真节点 `probe-93`） | `run-all.mjs --layer e2e` | **17 passed, 0 failed, 1 skipped in 270.0s** |
| 全量冷启动（35 套件，三层） | `run-all.mjs` | **34 passed, 0 failed, 1 skipped in 289.8s** |
| 节点侧损坏计数（全量跑前 → 后） | `grep -c 'Connection corrupted' /var/log/auth.log` | **2024 → 2024（+0）** |

唯一 SKIP 是 `e2e/browser`（未设 `DSH_BROWSER_DEBUG_PORT`），不是通过。

同一轮还修了一处独立的健壮性缺陷：`RemoteHost.stop()` 的兜底 `pkill -f '…/lib/bin.js'` 会匹配到
执行它自己的 `sh -c`（argv 里就带着这个模式），把自己杀掉、channel 无退出码。改成 `bin[.]js`
后实测 `{"out":"SURVIVED","code":0}`，且仍然杀到了真正的 resident host（节点上 2 个变 1 个）。

### 2026-11-22 · 插件 0.6.7 · 中转补丁 + 节点上空层 + 体验层

这一轮改了三处，验收口径也随之变了。

**改了什么**

| 项 | 内容 | 守它的套件 |
|---|---|---|
| 中转产物补丁 | Host 每次启动给已安装的 `ds-harness-remote` 打一处补丁，让 `rnh_` 开头的会话 id 跳过中转的本机 realpath 授权。锚点缺失就整份放弃并报原因 | `relay-patch-unit`（offline） |
| 节点上空层 | `directoryPicker/list` / `/rnh/api/browse` 对节点上**合法但不存在的绝对路径**返回 `exists: false` 的空层，而不是报错。手机因此能在节点上新建工作区 | `picker-flow` / `workspace-browse`（e2e） |
| 体验层 | 失败主操作映射成按钮（含新增「重置主机密钥」）、阶段计时、下载进度、恢复预算「第 n/3 次」、复制错误、密码显示切换 | `errors-unit` / `client-bundle` / `transfer-unit` / `rnh-lifecycle-unit` |
| 脚手架 | 节点路径与 profile 名从 `/rnh/api/nodes` 的 `remoteRoot` 派生（`test/layout.mjs`）；`run-all` 真的用 `RNH_TEST_*` 播种节点；`artefact` 的版本从 Host 读，不再写死 `0.2.2-rc.3` | 全部 e2e |

**本轮实测**

| 层 | 命令 | 结果 |
|---|---|---|
| offline | `run-all.mjs --layer offline` | **19 passed, 0 failed, 0 skipped in 11.0s** |
| contract | `run-all.mjs --layer contract` | **3 passed, 0 failed, 0 skipped in 856ms** |
| e2e | `run-all.mjs --layer e2e`（`rnhtest` + 真节点） | **15 passed, 0 failed, 2 skipped in 275.1s** |

**中转补丁在真实调用路径上验证过**，不只是单测里成立：给 `rnhtest` 装上
`ds-harness-remote@0.6.6`、启动一次 Host 之后，它的 `dist/index.js` 被打上补丁
（sidecar 记 `installed: 0.6.6, anchors: 3`）；再启动一次，文件 sha256 完全不变。

`desktop` 与 `fleettest` 两个 profile 的 0.6.7 是通过 `link:` 指向这个仓库的源码，
所以它们不需要重新打包；`rnhtest` 装的是 pack 出来的 tgz，改完代码要重新 pack + install，
否则跑的还是旧字节 —— 这一轮踩过一次。

唯一两处 SKIP：`browser`（没有带 `--remote-debugging-port` 的 Chrome）与 `plugin-switch`
（这台桌面没装第三方插件，而 rnhtest 里只有本插件，它本来就该被排除在开关列表外）。
两条都不是通过。

**这一轮跑到 0 failed 之前修掉的六处，全部是脚手架而不是产品缺陷：**

| 现象 | 真因 | 修法 |
---|---|---|
| Host 起不来：`credentials-local: invalid document … DUPLICATE_KEY` | 真实 home 的 `.credentials.yaml` 里本节点的记录被写了两遍（同一 `kind/payload` 出现两次），YAML 解析直接失败，**整个 DSH 启动失败** | 删掉第二份重复块；用 `ssh2` 分别试两个历史密码，只保留节点真正接受的那个（9 字符的那个，18 字符的被拒）。备份在 `.scratch/credentials-broken-20261122.yaml` |
| 5 个 LLM 套件 `Authentication Fails` | 测试 Host 的 profile 没有 provider 覆盖，回落到 `api.deepseek.com`，它不认这台机器的 key | `rnhtest/cordis.patch.yml` 加 `llm-deepseek.baseURL`（与桌面 profile 一致），key 仍只从真实 home 读进子进程环境 |
| 所有 turn 都 `No available channel for model deepseek-flash`（503，重试 97 次） | 只补 `baseURL` 不够：bundle 默认模型是 `deepseek-flash`，而代理只提供 `deepseek-v4.1-flash` 等四个 | 同一 patch 加 `agent-default-model`；**`provider` 必须一起写**，只写 `model` 会让该行校验失败（`$.provider missing required value`），连带 `session-controller` 与 `ui-deliverables` 挂掉 |
| 每个 `bash` 都 `SANDBOX_ESCALATION_UNAVAILABLE` | 节点没有可用沙箱后端（无 bubblewrap、无 Landlock），`workspace-write` 无法执行，而审批通道又不可用 | patch 里加 `permission` 行，`defaultPreset: danger-full-access`（与桌面 profile 同口径） |
| `workspace-flow` 的「节点上有会话目录」失败 | 断言写死 `--root-rnh-brain-test--`，而节点上的远端工区是 `/root/rnh-second` | 目录名从会话自己的 `cwd` 派生（`--root-rnh-second--`） |
| `plugin-switch` 被记成 FAIL 而不是 SKIP | 空列表时先判了 `rows.length > 0`，再走到「没有第三方插件」的 exit 3；libuv 收尾的断言又被读成崩溃 | 提前判空并 `await sleep(250)` 后退出 3 |

**手机侧：未验证**

GOAL §六 的手机判据四步（会话列表里看到远端会话、在节点上新建工作区、看文件改动、答审批）
**本轮没有在任何真机上执行**。桌面侧能证明的部分已经证明：远端行确实进 `session/list`、
`directoryPicker/list` 对不存在的节点路径给空层、`workspace/create` 在节点上落盘、补丁装在
产物里且 `local.relay.patched` 为真。真机验证等用户接入设备后单独做，结论写进下一段验收记录。

**这一轮仍不能声称「手机达到生产力水准」**：GOAL §六 那一半只有真机能判。桌面这一半的判据
（连上节点 → 远端工区 → 会话 → agent 在节点上跑工具 → 文件在节点磁盘 → 侧栏能看到 → 审批能答）
本轮已经全部通过，见上表 e2e 那一行。

### 2026-11-22 · 中转服务端 0.6.5 → 0.6.7，本机插件 0.6.6 → 0.6.7

用户要求升级这台机器连的中转链路。两件事分开做，因为失败面不同：服务端重启会断一次连接，
插件换字节则可能让 Host 起不来。

**服务端（`192.168.3.x` 网段的部署机，`/root/dsh-deploy/server`）**

| 项 | 之前 | 现在 |
|---|---|---|
| compose 的 image | `:latest`（实际解析到 0.6.5 的构建，2026-11-14） | `:0.6.7`（digest `sha256:e3d77ff0…`，2026-11-21 构建） |
| build 段 | 指向 `../src/ds-harness-remote-main`（11-15 的源码树） | **已删**。留着它，一次普通的 `up` 会按旧源码重新构建而不是用钉住的镜像 |
| 容器 label | `0.6.5` | `0.6.7` |
| health | healthy | healthy（`since 2026-11-22T12:12:09Z`） |
| 经 nginx | 200 | `http 200 in 0.019726s` |

备份：`compose.yaml.bak-20261122-121204`。容器里的 `apps/server/package.json` 仍是
`0.5.21` —— 那是 server app 的版本号，不是发行版；判断版本只能看镜像 label。

**本机三个 profile**

`desktop` / `fleettest` / `rnhtest` 全部到 `ds-harness-remote@0.6.7`，三处的
`dist/index.js` 现在是同一份（sha256 `3E70227C…`，185 个文件、4,469,439 字节）。

**中转补丁在 0.6.7 上仍然成立**，这是最要紧的一条：起一次 Host 后 rnhtest 的那份被打上，
sidecar 记 `installed: "0.6.7", anchors: 3`。单独用 0.6.7 的 tarball 跑 `planPatch`
也是三个锚点 3/3 —— 上游没有动 `assertNativeWorkspaceFileCall` 那一带。

**冒烟**

| 套件 | 结果 |
|---|---|
| `e2e/gateway` | PASS |
| `e2e/host-routing` | PASS |
| `e2e/picker-flow` | PASS |

`3 passed, 0 failed, 0 skipped in 22.7s`。没有跑全量 e2e：这一轮只换了两端的版本字节，
产品代码一行没改，而这三个套件正好覆盖「Host 起得来」「每个路由端点通」
「手机看节点那条路」。

**顺带记两条踩坑**（已写进 `UPGRADE.zh.md` §八）：`docker pull … | tail` 的 `$?` 是
tail 的退出码，第一次升级因此误报「镜像没到」；desktop profile 的 pnpm 有
`virtualStoreDirMaxLength: 60` 与 `minimumReleaseAge` 两道门槛，直接 `pnpm install`
会分别报 `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF` 和被拦下。