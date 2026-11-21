# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

三条规则：

- **改了运行时行为 → minor**，**只改文档与元数据 → patch**，**破坏既有安装或身份语义 → major**。
- 每条都说清「谁受影响」，因为这套东西的读者是「装它的人」，不是写它的人。
- 与 `docs/ARCHITECTURE.md` 的章节对应，细节不去那边重复。

## [0.6.6] — 2026-11-21

### 修复

- **`release-runtime.yml` 的 `win32-x64` 腿必然失败，`darwin-arm64` 腿打不起来。** 这两条
  都是第一次真跑才暴露的，静态判读看不出来：
  - Windows 腿跑在 `shell: bash` 下，`tar` 解析到 Git Bash 的 GNU tar，它把绝对路径
    `D:\...` 当成**远程主机**（`tar: Cannot connect to D: resolve failed`），把 `D:/...`
    当成名为 `D:...` 的文件；System32 的 bsdtar 两种都认，所以同一脚本在 PowerShell 下
    打包正常、只在 CI 里死。`publish-runtime.mjs` 与 `build-fork-runtime.mjs` 改成
    **`cwd` 落到输出目录 + 相对 `-C`**，这是两种 tar 的交集（两种二进制各测过）。
  - `macos-14` 已退役，失败信息（`The configuration 'macos-14-arm64-us-default' is not
    supported`，0 秒取消）看起来像标签写错。实测（run 44908940637）：`macos-15` 与
    `macos-latest` 都是 arm64，`macos-13` 一直排队。改钉 `macos-15`，不用
    `macos-latest`，免得 image 滚动时悄悄换掉构建环境。
  - 顺手修掉打包摘要里的 `NaN`：`${mib(stripped)}` 把 `{bytes, files}` 对象喂给了数字。

### 变更

- **`release-runtime.yml` 不再发布 `v<version>-upstream` 对比树。** 每次四条腿共约 640 MiB
  资产，而没有任何东西读它：`verify-packed-install` 要的是 `.tgz` 目录，仓库与 fork 里
  也没有脚本去下那个 tag。打包步骤留着（它回答「钉的这个上游 tag 还能不能干净打包」），
  publish 作业删掉，权限从 `contents: write` 降到 `read`。

### 文档

- **AGENTS.md §4 与 `ARCHITECTURE.md` 的非目标自相矛盾。** 两处都写「不改上游语义（fork
  只允许构建侧修复）」，而 build 7 的 0001/0002 就是改上游行为。口径改为：节点的内核就是
  官方源码的 fork，**改源码是主路径**，要求只剩「每一处改动都能被列举出来」，并按节点会不会
  读到那段代码分成两类（读到 → 补丁 + 台账；读不到 → `BUILD_SIDE_COMMITS` 一行）。
  ADR-0007 §五与 ADR-0008 同步。
- **`node-patches.zh.md` 新增「构建侧源码修复」一节**，记 `057ce8f3`
  （`verify-packed-install.ts` 在 Windows 上用 Node 跑 npm 的 JS 入口）：它改的是
  `scripts/`，归档里没有那段代码，所以当不了补丁，但也不能不记。

### 新增

- **`checkForkBase()`：把「fork 只差台账里这几条」从声称变成断言。** 构建前检查 fork 的
  HEAD 必须就是 `dsh-v<version>`，或它上面每个提交都在 `BUILD_SIDE_COMMITS` 里；工作树
  只允许在补丁覆盖的文件上有差异，其余按路径报错。未入账的提交报哈希，手工改过的文件报
  路径 —— 这两种情况是同一个故障的两面：归档不再等于台账。
- `test/fork-base-unit.mjs` 用临时仓库断言三种触发情形（未入账提交、手改文件、缺 tag）
  与一路放行（真 fork `057ce8f3 on dsh-v0.2.2-rc.5`），已注册进 offline 层。

### 未变

- `RUNTIME_BUILD` 仍是 **7**，归档字节未变。这一版只动构建工具链与文档，节点不需要重装。

## [0.6.5] — 2026-11-21

### 修复

- **`release-runtime.yml` 里 `--out` 的基准弄错了，这个 workflow 一跑必挂。**
  `publish-runtime.mjs` 把 `--out` 相对**插件包根**解析（`resolve(pluginRoot, value('out'))`），
  而 workflow 传的是裸 `dist`、后面 `upload-artifact` 又按**仓库根**取 `dist/dsh-*.tar.gz`，
  且写了 `if-no-files-found: error`。结果是：四个平台各自打包成功，然后在收集产物那一步
  全部失败。这个 workflow 从未运行过，所以一直没人发现。改成绝对路径
  `${GITHUB_WORKSPACE}/dist`，并在注释里写明这个基准，不再依赖读者知道它。
- **CI 只跑 16 个离线套件里的 9 个，而漏掉的正好包含补丁链守卫。**
  `ci.yml` 手写了一份套件清单，`run-all.mjs` 里另有一份注册表，两份已经漂移：
  `node-patches`（保证 `patches/node/*.patch` 与偏差台账一致）、`rnh-lifecycle`、
  `errors`、`autoconnect`、`packet`、`provision`、`composition` 都不在 CI 里。
  手抄一份已经存在的清单只会继续烂下去，所以 CI 现在直接
  `node test/run-all.mjs --layer offline`，清单由注册表决定。两个读 `app.asar` 的套件
  在没有桌面安装的机器上自己 exit 3，`run-all` 把它们报成 SKIP 并写明原因，不算通过。

### 文档

- **ADR-0008 有三处还在说「补丁链是空的」。** 第六节当时确实空着（那是对的：能用删包/
  删文件表达的就不该写补丁），但 build 7 落了 0001/0002 两条。第六节重写为「哪些够格进补丁、
  哪些仍不做」，验收表与 `RUNTIME_BUILD` 段落一并更新。
- **对外文档的归档数字还停在 build 5。** `README.md`、插件 `README.md`、
  `ARCHITECTURE.md`、`UPGRADE.zh.md` 写的是 57.9 MiB / 25 038 文件 / 91 839 618 字节 /
  267.4 MiB 解包，实际 build 7 是 **58.2 MiB / 25 167 文件 / 61 071 397 字节 /
  269.5 MiB 解包**。ADR-0007 里的历史测量值保持原样（那是决策当时的记录）。

### 清理

- 删掉 `packages/dsh-remote-node-harness/patches/node/.gitkeep`：目录里已有两条真补丁，
  占位文件不再有意义。
- 删掉仓库根的 `openspec/`：只有一个 `config.yaml` 和两个空 `.gitkeep`，没有任何 change，
  属于半套工具痕迹。
- 公开的 CNB release `v0.2.2-rc.5` 上有一个 2026-11-19 调试残留的 `confirm-probe.txt`
  （11 字节），已删除；匿名下载现在 404，同 release 的归档仍 200 / 61 071 397 字节。
- `0.6.4` 的 tarball 从 `packages/dsh-remote-node-harness/dist/` 归位到 `dist/plugin/`，
  与 0.6.0–0.6.3 及 UPGRADE 文档写的流程一致。

### 未变

- `RUNTIME_BUILD` 仍是 **7**：这一版没有改任何进归档的字节，节点不需要重装运行时。
  装 0.6.5 只换插件代码。

## [0.6.4] — 2026-11-21

### 修复

**两条上游缺陷，落成节点补丁链的第一批补丁（`patches/node/0001`、`0002`）。**
此前 build 5/6 的节点树源码与上游 tag 逐字节相同，本项目的差异全在删包与删文件里；
这两条改的是上游代码的行为，所以 `RUNTIME_BUILD` 6 → 7、归档重新编译并覆盖发布。
每一条的发生条件、改动位置、验证方式与「上游改到同一处怎么办」都写在
[`node-patches.zh.md`](packages/dsh-remote-node-harness/docs/node-patches.zh.md)。

- **Team 的写作用域冲突警告会在兄弟任务一完成时消失。**
  `projectTaskView` 只拿 `in_progress` 的兄弟任务比对，所以任务 A 与任务 B 都声明
  同一批路径时，只要 A 先 `complete`，B 看到的警告就变成空的 —— 调用方读到的是
  「无冲突」，而那批文件刚刚被 A 写过、B 接下来还要再写一遍。这正是最需要提示的时刻。
  现在比对每一条非 `deleted` 的任务，并在警告里带上对方状态
  （`write scopes overlap with task-2 (pending)`），调用方能自己分清「正在撞车」和
  「已经有人写过」。
- **fork 子会话在该继承的时候什么都没继承。**
  provider 把切点定死在「最后一个 `turn/end`」：父会话还没完成任何一轮时（首轮就委派、
  或者第一轮还没跑完）返回空 seed，子会话 `isSeeded: false`、`inheritedEventCount: 0`，
  而工具描述向模型承诺的是「seeded with all completed turns so far」—— 子 agent 于是
  回答「看不到这段对话」。父会话已经有若干轮时，切在 `turn/end` 又会丢掉**当前轮的用户
  请求**，也就是要求它做这件事的那一条。现在切点落在「最后一条携带未应答 tool-call 的
  `assistant/message` 之前」，再用 `buildForkSeed` 收口：用户请求进了 seed，父级自己那条
  委派调用被切掉（不给子 agent 一条「后果未知」的合成结果，避免它自己再去委派一次）。
  工具措辞同步改准：它继承的是「截至本次委派处的对话」，看不到本次委派请求本身，
  被压缩过的片段以摘要形式到达它。

### 测试

- 上游 fork 侧：`packages/subagent`、`packages/team`、`packages/client/ui-agent-team`
  共 **57 个测试文件 / 1343 通过 / 1 跳过**（`npx vitest run` 实跑）。新增一条
  「首轮 fork 也 seeded 且继承用户请求」，重写四条因切点变化而失效的断言
  （首轮 `isSeeded`、`inheritedEventCount`、seed 末尾事件、继承事件的排序）。
- 本仓库：`test/node-patches-unit.mjs` 全过（含新增两个真实补丁的台账一致性；
  `checkPatches` 报告 `{"patches":2,"problems":[]}`），`test/version-unit.mjs`、
  `test/fork-runtime-unit.mjs` 全过。
- 未验证：`host-routing` / `workspace-flow` / `tool-parity` / `client-bundle` /
  `artefact` 五层端到端需要运行中的 Host + 已连接节点（`RNH_TEST_*` 未设置），本轮没跑。

### 构建

- `scripts/build-fork-runtime.mjs` 在 Windows 上改用 corepack 的 JS 入口调用 pnpm。
  旧的 `run('corepack', …)` 在 Windows 下必失败：`corepack` 只有 `.cmd` 垫片，
  无 shell 的 `spawnSync` 不按 `PATHEXT` 解析，返回 `status: null`，报错信息里只有一个
  `exited with null`。这条只影响**打包机**，节点侧无变化。

## [0.6.3] — 2026-11-21

### 修复

- **节点上的 `glob` 与 `grep` 全部不可用：装好的运行时里 `rg` 没有可执行位。**
  实测反馈（节点 `linux-x64`，DSH `0.2.2-rc.5`）：任何检索都报
  `glob subprocess failed before reporting an outcome (ripgrep provider failure)`，
  而 `read`/`write`/`edit` 正常。根因在制品打包与解包的接缝上：bsdtar 在 Windows
  打包机上给**每个**条目写 `-rw-rw-rw-`，`chmodSync` 在 Windows 上只剩 `100666`，
  所以归档里一个 `+x` 都没有（实测发布的那份 rc.5 归档：25 038 个文件，0 个带 `+x`）；
  而 `installScript` 解包后只补 `node-pty/prebuilds/*/spawn-helper`，**Linux 树里根本
  没有这个文件**，等于什么都没补。`@vscode/ripgrep-linux-x64/bin/rg` 于是以 0666 落地，
  `dsh-util-ripgrep` 按路径 spawn 它且**没有系统 `rg` 兜底**，整条检索链路瘫痪，
  而 `inspectRuntime` 判这棵树「in step」——坏得没有任何提示。
  - 补位规则改成**按形状**而不是按路径清单（清单会在下一次依赖升级时悄悄失效）：
    `node_modules/<pkg>/…/bin/` 下的文件、按名字的 `spawn-helper`、按后缀的 `*.node`。
    判定函数 `isArtefactExecutable` 在 `src/remote/artefact.js`，**打包侧
    （`publish-runtime.mjs`、`build-fork-runtime.mjs`）与安装侧共用同一个**，
    两处不可能对「哪些文件是程序」有不同意见。`node_modules/.bin/*` 故意不匹配：
    那是 npm 给 shell 写的 shim，本运行时没有任何代码解析它。
  - 补位之后**要验**：`installScript` 对 `bin/rg` 与 `bin/landlock-run` 逐个测 `-x`，
    不通过就删 staging、`exit 7`（`ARTEFACT_NOT_EXECUTABLE`）让调用方回滚，位置在
    `mv "$staging" "$runtime"` 之前。补不上却不报错，等于又造一个「看起来装好了、
    第一次搜索才炸」的节点。
  - 受影响范围：**每一个装过 0.6.2 及更早版本的节点**。本次修复要靠 `RUNTIME_BUILD`
    5 → 6 才能触达它们 —— 归档字节与 build 5 完全相同，但戳不同，节点下次连接会重装
    同一份字节并补上可执行位。

### 测试

- `test/version-unit.mjs` 新增一组：`isArtefactExecutable` 的形状判定（`bin/rg`、
  `landlock-run`、`spawn-helper`、`*.node` 命中；普通 JS 与 `.bin/*` shim 不命中）、
  生成的 `find` 表达式在**真 shell** 里对假树跑一遍（本机没有 POSIX shell 时显式 skip，
  不假装通过）、以及安装脚本里 `ARTEFACT_NOT_EXECUTABLE` 的判定顺序必须早于
  `mv "$staging" "$runtime"`。
- `test/fork-runtime-unit.mjs` 新增两条：两个打包脚本都必须 import 并调用同一个
  `isArtefactExecutable`，且都不再保留旧的 `entry.name !== 'spawn-helper'` 写法 ——
  规则的第二个副本正是这个缺陷的成因。

### 文档

- `docs/ARCHITECTURE.md`「可执行位」一节重写：旧文写的是「补 `spawn-helper`」，
  正是这次出错的规则；补上按形状的新规则、`exit 7` 的语义、以及为什么归档字节没变
  仍要 bump `RUNTIME_BUILD`。
- `docs/adr-0006-node-runtime-supply.zh.md` §六第 2 条补 2026-11-21 修订说明。
- `packages/dsh-remote-node-harness/docs/UPGRADE.zh.md` 补一条判据：
  **改动的是安装脚本、必须让节点重装一次才生效，也要 bump `RUNTIME_BUILD`。**

## [0.6.2] — 2026-11-21

### 修复

- **补丁链的「已应用」识别是错的，真冲突会被当成正常放行。** `applyPatches` 原来用
  `git apply --3way --check` 判断能不能应用，而它**对三种情形都返回 0**，只在输出里
  说「cleanly」还是「with conflicts」。实测（git 2.51，同一个补丁三棵树）：
  干净应用 0、已应用 0、真冲突 0。于是第二次构建会把「已经在树里」判成 `applied` 并
  再打一遍，而真冲突也会被当成可应用、随后在真应用时才失败。现在两个判定改成**不带
  `--3way` 的普通 `--check` / `--check --reverse`**（它们的退出码才区分三态），`--3way`
  只用于真正落地那一步，并且在 `--3way --check` 报 `with conflicts` 时先抛错、不写树。
  四种情形都进了 `test/node-patches-unit.mjs`：首次应用、已应用、上游把 hunk 挪位（必须
  重定位成功）、上游改写同一行（必须抛错且不落 `.rej`/`.orig`）。

### 变更

- **仓库里补上了 `patches/node/` 目录（含 `.gitkeep`）。** 之前它不存在，`listPatches` 对不存在
  的目录返回空数组，所以测试是绿的，但按 `UPGRADE` 教的第一步往里放补丁时得自己 `mkdir`。
  这个目录只在打包机上用（`build-fork-runtime.mjs` 从仓库工作树里读），不进插件 tarball ——
  装插件的人没有也不需要它。
- **发布说明里的节点安装路径改回 `~/.dsh-remote-node-harness`。** 之前写的是 `~/.dsh-rnh`，
  而 `DEFAULT_REMOTE_ROOT` 从来是前者。这条路径在 `publish-runtime.mjs` 里是第二份拼写
  （那个脚本不能 import daemon，否则会把 `ssh2` 拖进打包脚本），所以
  `test/fork-runtime-unit.mjs` 新增一条断言：发布说明里的路径必须等于 daemon 的常量。

### 文档

- ADR-0008 状态行的 `58.0 MiB` 改成 `57.9 MiB`，并修掉指向不存在的「第九节」（实际是第六节）。
- 台账 `node-patches.zh.md` 的文件数订正：41 846 → 25 038（删 16 808），原文写的
  `24601−41846` 两个数都不对。
- CHANGELOG 0.6.0 与 README 的改名表里，节点安装根同样从 `~/.dsh-rnh` 改回
  `~/.dsh-remote-node-harness`。

## [0.6.1] — 2026-11-21

### 变更

- **节点运行时做包内裁剪，`RUNTIME_BUILD` 4 → 5。** 节点下一次连接会重装一次运行时，
  下载量少三分之一：归档 87.6 → **57.9 MiB**，解包 408.2 → **267.4 MiB**。包集合没变
  （119 个包仍是那 119 个），删的是包里面没人读的字节：

  | 类目 | 删了多少 | 为什么是死的 |
  |---|---|---|
  | 非声明 `.ts`/`.tsx` 源码 | 9 540 个 / 91.9 MiB | 运行时加载 `lib/*.js`；1 207 个 manifest 里没有一条 `main`/`bin`/`exports` 的运行时条件指向 `.ts` |
  | `.d.cts` 类型声明 | 7 110 个 / 22.7 MiB | 声明文件；原规则漏了 `.cts` 这个拼法 |
  | 无人读的 `.md` | 601 个 / 5.3 MiB | 原规则 `/(^|\/)\.md$/` 只匹配**文件名恰好叫 `.md`** 的，`guide.md`、`HISTORY.md` 全漏 |
  | Windows 调试符号 | 4 个 / 19.8 MiB | linux 归档里的 `conpty*.pdb` |
  | 跨平台原生二进制 | 38 个 / 5.7 MiB | linux 归档里的 `win32-*` prebuilds、ConPTY、`.cmd`/`.ps1` shim |

  **验收是 A/B，不是「看起来还在」**：同一份大脑组合分别喂 build 4 与 build 5 的树，
  10 个端点的状态码与响应体逐字节相同，差 0 个。另外 build 5 在 Linux（WSL Ubuntu 24.04
  + Node 24.15.0）里解包启动、打印 `dsh web:`、换 cookie 得 200、`POST /api/session/list`
  返回 `{"items":[]}`。细节见 `docs/adr-0008-node-source-trim.zh.md`。

- **新增节点源码补丁链与偏差台账。** 上一版规定「fork 的源码改动只有构建侧修复」，这条
  被推翻：源码改动现在允许，但必须是一个 `patches/node/NNNN-*.patch`，构建时
  `git apply --3way` 逐个应用，**冲突即报错**，且必须在
  `packages/dsh-remote-node-harness/docs/node-patches.zh.md` 有一行台账（改了什么、
  移除了什么、为什么节点不需要、怎么验证、上游改到同一处怎么办）。
  这样上游修的 bug 一定进得来（补丁叠在 tag 之上），我们自己的改动也不会升级时静默丢失。
  **当前补丁为空** —— 截至本次发版，节点树的源码与上游 tag 逐字节相同，全部差异都在
  删包和删文件里。台账空着是诚实的结果，不是没做。

- **`@deepseek-ai/dsh/docs/` 例外保留（481 个文件 / 4.66 MiB）。** 没有代码读它，
  但 `dsh-doc` skill 在节点组合里，它的 `references/locate-docs.md` 让 agent 去打开
  `DSH_INSTALL_DIR/docs/user/index.md`。路径写在散文里，`import` 扫描看不见 ——
  第一版规则把这 481 个全删了，skill 指着一片空。**能力留着，它引用的东西就得留着。**

### 修复

- **三条裁剪规则的正则写错，一年多没生效。** `/(^|\/)\.md$/` 匹配的是「文件名就叫 `.md`」，
  `.d.cts` 完全没覆盖，`.pdb` 与跨平台 prebuilds 也没规则。它们不会报错，只是让每个节点
  多下 30 MiB。
- **`publish-runtime.mjs` 与 `build-fork-runtime.mjs` 各有一份裁剪实现。** 两份会漂移成
  「同一版本、不同内容」的两棵归档，而 `RUNTIME_BUILD` 正是为了防这件事。现在两处都调
  同一个 `stripResidue`，规则与例外只有一份。

## [0.6.0] — 2026-11-20

### 变更（破坏性）

- **项目改名：`dsh-fleet` → `dsh-remote-node-harness`，显示名 `DSHpl` → `DSH RemoteNodeHarness`。**
  这一条不是发版元数据，是**已装用户的迁移**：

  | 层 | 旧 | 新 |
  |---|---|---|
  | npm 包 | `@greatbaby/dsh-fleet` | `@greatbaby/dsh-remote-node-harness` |
  | 目录 | `packages/dsh-fleet` | `packages/dsh-remote-node-harness` |
  | 大脑包 | `@local/dsh-fleet-brain` | `@local/rnh-brain` |
  | GitHub 仓库 | `zzyyyds88/dsh-fleet` | `zzyyyds88/dsh-remote-node-harness` |
  | CNB 仓库 | `serendipity-archive/dsh-fleet` | **不变** —— CNB 的 Open API 不能改仓库名 |
  | 节点安装根 | `~/.dsh-fleet` | `~/.dsh-remote-node-harness` |
  | 节点 profile | `~/.dsh/profiles/fleet` | `~/.dsh/profiles/rnh` |
  | 会话 id 前缀 | `fleet_<node>_<uuid>` | `rnh_<node>_<uuid>` |
  | 远端路径命名空间 | `/@fleet` | `/@rnh` |
  | 本地设置 API | `/fleet/api` | `/rnh/api` |
  | 本地节点表 | `$DSH_HOME/fleet/nodes.json` | `$DSH_HOME/rnh/nodes.json` |
  | 环境变量 | `DSH_FLEET_*` | `RNH_*` |

  **受影响：所有人，且不可就地升级。** 旧的 `fleet_` 会话 id、旧 `~/.dsh-fleet` 运行时、
  旧 `nodes.json` 都不会被读取 —— 节点会在下一次连接时按新根重装运行时并重新生成身份。
  迁移步骤：`dsh plugin --profile <p> remove @greatbaby/dsh-fleet`，再按
  [README §安装](README.md) 装新包；节点那边不用手工清，旧目录留着不影响（可以删）。
  历史 CHANGELOG 段与 ADR-0005 保留旧名，因为它们记录的是当时的事实。

  **CNB 仓库名没跟着改，这是被迫的。** CNB 的 `PATCH /{repo}` 只接受四个字段
  （`dto.RepoPatch`：`description` / `license` / `site` / `topics`），传 `name` 返回 200 但什么也不改；
  在组织下新建同名仓库拿到的是 Private，而节点无凭据、匿名 404。所以 `CNB_REPOSITORY` 仍是
  `serendipity-archive/dsh-fleet`，下载路径不变 —— 这对节点是好事，改名不需要重发制品。

  **旧 npm 包 `@greatbaby/dsh-fleet` 已标弃用，但删不掉。** 三个版本（`0.0.0-stage` /
  `0.5.0` / `0.5.1`）现在都带 deprecated 文案，指向新仓库与新的安装方式，`npm install` 时会
  打出来。`npm unpublish --force` 被 registry 拒了：`403 Granular access tokens that bypass
  two-factor authentication may not perform this action` —— 本机这枚 token 是绕过 2FA 的
  granular token，npm 2026 年已禁止这类 token 执行删除。发布时刻距今 45.5 小时，72 小时窗口
  还没过，所以挡住它的是**权限不是时间**：要在 npm 网页上用带 2FA 的会话手动 unpublish。
- **节点运行时改由本项目从 fork 编译，npm 兜底路线删除。** 节点跑的不再是上游 npm 发布版，
  而是本仓库对上游源码 fork 后编译、裁剪出来的树：删掉浏览器面（62 个 `dsh-client-ui-*`）、
  Office 引擎（339.5 MiB）、实验性 bundle 与 CUA，解包 **2014.6 MiB → 408.6 MiB**，归档
  **165 MiB → 87.6 MiB / 41 846 文件**。理由：组合层能决定加载哪些行，决定不了磁盘上有哪些包，
  也决定不了那些行里面的代码。见 [`docs/adr-0007`](docs/adr-0007-fork-node-runtime.zh.md)。
  **受影响**：所有人 —— 跟着上游从自动变成手动，上游发版后节点在新制品发出来之前连不上。
- **`npm install` 兜底整条删除，`RUNTIME_ROUTES` 常量、`runtime` 与 `registry` 配置项一起删。**
  那条兜底装的是上游发布版，却写同一枚 `{"build":N,"via":"npm"}` 的戳，于是一次网络抖动就会把
  节点永久钉在上游版本上，而界面显示「已就绪」。留着它比删掉它更危险，所以不是关掉开关。
  拿不到制品现在**报错**并逐条列出试过的 URL。「拿不到 ≠ 拿到的是坏的」不变：校验和/解包失败
  仍然回滚后抛错。**受影响**：所有配置里写过 `runtime:` / `registry:` 的人（键被忽略）。
- **`RUNTIME_BUILD` 3 → 4。** 树的内容变了（少了 500 MiB 包、多了 fork 的字节），版本号表达
  不了这件事。所有在用节点会在下一次连接时重装一次。
- **`mirrors` 配置项删除，`DEFAULT_MIRRORS` 退役成 `RETIRED_MIRRORS`。** 国内节点连不上
  GitHub，加速站的前提不成立；而且它们实测抖动 40 倍（0.2–9.6 MB/s）。`DEFAULT_SOURCES`
  现在只有 CNB 一条，`{kind:'prefix'}` 仍支持，所以接私有镜像是一个配置值。GitHub Release
  仍收到同一份字节作灾备与留档，节点不从那里取。**受影响**：设过 `mirrors` 的人。

### 新增

- **`build-fork-runtime.mjs`：一条命令完成 fork 编译、裁剪、打包、上传。** `--reuse` 复用
  已解包的树（只改裁剪规则时几十秒）；`--publish` 传 GitHub Release，`--cnb` 传 CNB。
  `trim-fork-runtime.mjs` 是裁剪规则的唯一来源（`DROP_RULES` 每条带理由），
  `ARTEFACT_RESIDUE` 也被 `publish-runtime.mjs` import，两份清单不会漂成两个字节。
  `test/fork-runtime-unit.mjs`（34 条断言）守着留什么、删什么、以及两条载重规则。
  **受影响**：维护者。
- **制品改从 CNB 下载，现在它是唯一的源。** `artefactUrls()` 的源是对象数组
  （`{kind:'template', template}` / `{kind:'prefix', prefix}`）。实测参考节点拉
  91 839 618 字节整档：CNB **17.6 s、重复测量抖动 <1%**。抖动才是问题：同样的节点同样的归档，
  有时半分钟有时一小时，读起来就是「连接卡住了」。**受影响**：所有人。
- **插件本体改由 CNB Release 的 tarball 分发。** `dsh plugin add -w https://…/*.tgz` 是 DSH
  安装器的原生形态（`install-spec.js` 对 http(s) tarball 有明确分支），所以不再依赖 npm 上还
  留着哪个版本。桌面端会话里的 `plugin_manager(action='install_bundle', target=<该 URL>)`
  走同一个安装器，所以「让 agent 装」不需要敲命令。**受影响**：新安装的人。
- **断线现在看得见，并且会自动重连。** SSH socket 掉了之后 `state` 原来一直是 `connected`：
  卡片是绿的、侧栏还列着那台机器的工作区，而任何调用都回 `rnh/node-offline` —— 一个界面上
  从未出现过的状态。现在 `close` 事件（排除 `invalidate`/`dispose` 这两条主动路径）上报给
  `Rnh`，状态落 `idle` 并记 `droppedAt`；重连是 2s/4s/8s 三档，之后每 2 分钟，直到成功或
  用户点断开。**受影响**：所有节点。
- **失败可归因：稳定错误码 + 一个动作 + 是否可重试。** `core/errors.js` 把每次失败分类成
  `{code, message, action, retryable, detail}`，判定顺序是「显式 code > SSH category > phase
  推断 > unknown」。密码错**不配重试按钮** —— 按了只会得到同一次失败。失败的 phase 也不再被
  清空，所以阶段列表停在出错的那一格。
- **每个节点自带最近 100 行连接日志**，写入即脱敏（`password=` / `token:` /
  `Authorization: Bearer` / 私钥块 / `ssh://user:pass@host`），路由
  `/rnh/api/nodes/<id>/log`，卡片上可展开、可复制。
- **主机密钥首次记录、之后每次都验。** `hostVerifier` 从写下的第一天起就在读
  `target.hostFingerprint`，但全仓库没有一处给它赋过值 —— 于是每次都走「首次」分支并
  `verify(true)`。这条链是死代码，中间人可以无条件接管连接。现在首次握手写进
  `NodeRecord.hostKey`，之后不符就拒绝并把两侧指纹写进日志。
- **手机端选择器首屏是设备层。** 手机调用 `directoryPicker/list` 不带 path，原来返回的是
  **桌面机自己的 home**，手机永远出不去本机；`/@rnh` 只有主动拼路径才到得了，而手机界面上
  没有入口。现在首屏是「此设备 + 各已连接节点」。
- **每台设备记住上次用的目录**，设备列表按最近连接排序，超过两台才给搜索框。

### 修复

- **拿不到 `.sha256` 不再等于「不校验就装」。** 原来的校验步骤是 `if fetch …; then`，镜像只要
  漏发边车文件，整个比较就被跳过，未经验证的字节直接解包 —— 正是校验和存在的理由。现在缺边车
  以退出码 6（`ARTEFACT_CHECKSUM_UNAVAILABLE`）失败并回滚，与「源没给」（码 3）、「字节坏了」
  （码 4）分开报。**受影响**：源上少发了 `.sha256` 的部署。
- **下载超时不再被 SSH 层提前掐断。** `curl --max-time` 是 30 分钟，而 `install` 那次 `exec`
  只等 15 分钟：慢线路上 curl 还在正常下载，Host 这边先 `KILL` 了 channel，而 `channel.close()`
  并不会收掉远端的 `curl`（`budget-recovery` 探针实测过）。现在 exec 超时跟随
  `FETCH_CEILING_SECONDS + 60s`。**受影响**：线路慢或归档大时的首次安装。
- **制品字节坏了仍然报错，不会被重试。** 校验和不符、解包失败、归档里没有
  `node_modules/@deepseek-ai/dsh/lib/bin.js`（退出码 4/5）一律回滚到 `runtime.previous` 后抛错：
  重试同一个坏源只会更慢、下载更多，还会把「哪个源坏了」掩盖掉。这条在删掉 npm 兜底之后仍然
  成立，而且更强 —— 现在根本没有第二条路可以「再来一次」。
- **构建戳必须写，否则每次连接重装。** `inspectRuntime` 会把无戳的树读成「早于构建戳」→
  `decideGate` 返回 `node-runtime-repack` → 重装，一分钟的安装变成一分钟的连接。`parseStamp`
  仍认旧格式的裸整数，现场节点的 `2` 不会因为换格式被判不可用；`npm` 这个 `via` 值也仍被读取
  （旧节点带着它），只是不再有代码写它。
- **归档里不再混进打包机的原生产物。** 包的 `install` 脚本按**打包机**的 `process.platform`
  跑，koffi 的 `cnoke` 于是在 Windows 上编出 `koffi/build/win32_x64`。实测那份 rc.5 归档里有
  48 个 `.exe`/`.cmd`/`.dll`/`.lib` 和 147 条 `koffi/build` 条目，全在一个 `linux-x64` 制品里。
  打包改为 `--ignore-scripts`（树里每个原生依赖都自带预编译平台包；实测 968.2 → 957.3 MiB，
  四个原生模块都在）。
- **节点解包时补回 `spawn-helper` 的可执行位。** 实测 bsdtar 在 Windows 上给每个条目写
  `-rw-rw-rw-`，`chmodSync` 是空操作，`--owner/--group` 也改不了。Darwin 节点上
  `node-pty/prebuilds/*/spawn-helper` 因此不可执行，终端在**第一次打开时**才失败，错误信息
  一个字都不会提到这个文件。现在 `installScript` 解包后自己 `chmod 0755`。这一条同时修好
  已经发出去的归档。
- **节点掉线时工作区行不再消失。** `RemoteWorkspaces.sync()` 原来只要节点不在 `routable()`
  里就把整份 baseline 丢掉 —— 断线那一刻侧栏里整台机器的工作区消失，一分钟重连成功后又回来。
  现在只有**记录被删**才丢行，只是连不上时行留着并标 `offline`。
- **插件树不再塞进命令行，SSH 连接不再被 sshd 判损坏。** 节点 `auth.log` 里长期刷
  `Bad packet length 88734736.` + `Connection corrupted`，插件随即报节点掉线，端到端
  长期停在 `13 passed, 4 failed`。真因不是加密、并发或运行时，而是命令行的长度：ssh2 把一次
  `exec` 请求当成**一个** SSH 包发出去（`Protocol.js:1273`），OpenSSH 的 `PACKET_MAX_SIZE`
  是 256 KiB，超了之后服务端不回错误、而是流位置错乱。`writePluginBundle` 当时把整棵插件树
  base64 拼进命令行，`dsh-whale-widget` 在磁盘上 5.9 MB，拼出来 **7,923,386 字节**，与日志里
  那个 `7923616` 差 230 字节（脚本尾部）。单连接量出来的边界：命令行 262,000 字节干净、
  262,200 字节六条连接全坏，而同样内容走 stdin 不论多大都干净。两个 writer 的 payload 改走
  stdin，`SshConnection.exec` 另加 `MAX_COMMAND_BYTES = 128 KiB` 的本地闸门。
  **受影响**：所有在节点上开过插件的安装（本地 `link:` 插件尤其重，因为它的整棵树都要复制）。
  新增 `offline/packet` 套件守着。实测修完：全量 **34 passed, 0 failed, 1 skipped**，
  节点侧损坏计数跑前跑后都是 2024（+0）。
- **通道预算满时重连，而不是一直等。** 十次长 exec 会把一条连接的 `MaxSessions` 用满，而
  `channel.close()` 在远端命令还活着时并不归还名额 —— 实测那条连接在整个 40 s 观察窗口里
  一直拒绝新通道。现在先在同一条连接上短退避重试，仍不行才丢连接重新握手换一份空预算；
  后者不报掉线、不走重连阶梯，节点保持 `connected`。
- **凭据没变就不重建连接。** `NodeRuntime.adopt()` 原来每次把记录读回来都 `invalidate()`，
  于是刚连上的节点立刻被自己踢掉。现在只有 host / port / username / 认证方式真的变了才重置。
- **兜底的 `pkill` 不再杀掉自己。** `RemoteHost.stop()` 在没有 status 文件时跑
  `pkill -f '…/lib/bin.js'`，而执行它的 `sh -c` 自己的 argv 里就带着这个模式，于是把自己杀掉、
  channel 无退出码。实测普通模式 `{"out":"","code":null}`、`bin[.]js` 这种方括号写法
  `{"out":"SURVIVED","code":0}`，且仍然杀到了真正的 resident host（节点上 2 个变 1 个）。
- **空补丁写成 `[]` 而不是空文件。** 一个没有行的 patch 文件会让 Loader 报语法错，看起来像
  插件没装好。

### 说明

- `RUNTIME_BUILD` 从 2 升到 3（打包规则与戳格式都变了），节点会在下一次连接时重装一次。
- **发布侧补了两道闸门，都是「代码里写着、但只有一句注释挡着」的地方。**
  `publish-runtime.mjs` 不带 `--cnb-only` 时会用 `pack()` 现打一棵上游树（registry 解析、
  无 fork、无裁剪），而它和节点下载用的是同一个上传路径：同名、同版本、校验和自洽，
  换掉之后下载侧看不出来。现在 `assertPublishable()` 在两条上传路径前抛出，唯一出口是
  `--cnb-only`。另一道是 `releaseNotes()` 原来按 `--out` 目录里有什么就写什么，一个撤掉的
  平台只要本地还留着一份旧归档就会重新出现在发行说明里、还带一个看起来合法的 sha256；
  现在按 `PUBLISHED_PLATFORMS` 过滤。`test/fork-runtime-unit.mjs` 两条都守着。
- **节点不升 Node 24，`MINIMUM_NODE_MAJOR` 保持 22。** 上游 `engines.node` 写的是
  `>=24.9.0`，但 305 个依赖包里真正的 Node 24 API（`Promise.try` / `RegExp.escape` /
  `Float16Array` / `node:sqlite`）是 **0 处**，唯一的 `await using` 命中是 acorn 解析器里的
  字符串字面量；`workflow-ptc` 在节点组合里是 `disabled: true`，加载不到。抬高门槛的唯一
  后果是一部分现场机器连不上。依据见 `docs/adr-0006-node-runtime-supply.zh.md` §四-2。
- **节点上装插件时，npm 不再顺手把 DSH 自己拉下来。** 第三方 bundle 的
  `peerDependencies` 写的是 `@deepseek-ai/dsh-*` 的区间（`^0.2.0-rc.1` 之类），
  npm 满足 peer 的办法是把那个包**装进节点的 profile**，而 profile 的
  `node_modules/@deepseek-ai/` 解析顺序在运行时树之前。实测：节点运行时是
  `0.2.2-rc.3`，装一个插件后被塞进 `dsh-session@0.2.0-rc.2`、`dsh-agent@0.2.0-rc.2`
  等 32 个包，常驻 host 报 `2 required plugins did not activate`、不打 URL，
  `connect` 只报一段日志尾巴。`RemoteHost.installPlugins` 现在固定带
  `--legacy-peer-deps`：运行时树是这些包的唯一来源，插件不许把 DSH 一起带来。
  **受影响**：所有在节点上打开过插件的安装。已坏掉的节点重连一次即可自愈
  （下一次 `npm install` 会把多出来的 `@deepseek-ai/*` 剪掉）。
- **一个新 profile 必须先由 DSH 自己创建。** DSH 创建 profile 时会写全
  `package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml` 三件套；手搓一个只有
  `package.json` 的目录会得到一个看起来像 profile 的空壳，`pnpm add -w` 报
  `--workspace-root may only be used inside a workspace`，DSH 把它当成安装失败。实测撞过。
- **DSH 0.2.2-rc.3 → rc.5 已核实，零改动。** 从已安装的 rc.5 重新派生节点组合后
  `git diff` 为空（上游只删了 `authentication-token` 与 `ui-session-status` 两行，都在被丢掉的
  那一侧），契约层 3 个套件全过，手机端那个端点名 `subagents/interruptByUser` 在 rc.5 里也
  没变。**受影响**：无需动作，节点在下一次连接时自己装 rc.5。
- **测试矩阵从 31 个套件变成 35 个**（`offline` 11 → 14，新增 `fleet-lifecycle`、`errors`、
  `packet`）。`e2e/gateway` 的依赖声明从 `needs: 'node'` 改成 `'host'`：它读的
  `status.json` 只在**本机 Host 连上节点**之后才指向一个活着的进程，声明成 `'node'` 会让它
  在冷启动时第一个跑、读到上一轮留下的死 pid。

## [0.5.1] — 2026-11-18

**只改发布元数据，运行时行为与 0.5.0 相同。** 0.5.0 已经发到 registry，同号不能再发，
所以命名空间更正随这个 patch 版本出。

### 修复

- **包名从 `@zzyyyds88/dsh-fleet` 改为 `@greatbaby/dsh-fleet`。** 原计划的 scope
  是照着 GitHub 用户名取的，但 npm 的 scope 只认**账号名或组织名**，而发布账号叫
  `greatbaby`：`npm access list packages '@zzyyyds88'` 返回 `404 Scope not found`，
  发布时报 403。`@greatbaby` 是账号自己的 scope，注册即得，不必另建组织。
  GitHub 仓库地址（`github.com/zzyyyds88/dsh-fleet`）不受影响，那是另一件事。

### 说明

- 0.5.0 在 registry 上是一个**未被引用的历史版本**（发布时名字还叫 `@zzyyyds88/...`，
  而那个 scope 不属于本账号，所以它从未真正可安装）。以 0.5.1 为准。
- registry 上还有一个 `0.0.0-stage` 占位版本，是 npm 暂存发布流程自动建的，不是本项目发的。

## [0.5.0] — 2026-11-18

**发布形态变更，已安装的用户要重装一次。** 包名从 `@local/dsh-fleet` 改为
`@greatbaby/dsh-fleet`：`local` 这个 npm 作用域属于他人的组织，`dsh-fleet` 这个包名
已被人占用。旧名已无法安装，也不会有更新。替换命令见下。

### 变更

- **包名改为 `@greatbaby/dsh-fleet`**，并发布到 npm。安装不再需要先 clone 仓库：
  `dsh plugin --profile <p> add -w @greatbaby/dsh-fleet`。
  从旧名迁移：先 `dsh plugin --profile <p> remove @local/dsh-fleet`，再用新名安装，
  最后把 profile 的 `dsh.profile.bundles` 里的旧名换成新名。
- 客户端插件 id 与包名同步（DSH 要求二者相等），因此浏览器半会重新注册一次。
- 本包不再是 `private`，补齐 `repository` / `license` / `keywords` 等 npm 元数据。

### 移除

- 被跟踪却早已过期的 `packages/dsh-fleet/package-lock.json`（写的是 0.1.0）。
  profile 的依赖一直由 pnpm 管理，这份 lock 从未参与任何安装。

### 文档

- 新增 `LICENSE`（MIT）。
- 新增 `docs/adr-0005-release-and-maintenance.zh.md`：包名依据、发布形态、三条升级链。
- `UPGRADE.zh.md` 补中转插件与 DSH Go 两条升级链 —— 此前只覆盖 DSH 本身，
  而这两条是无声失效的来源。
- 根 `README.md` 修掉五处与代码不符的表述，安装章节改为 npm 优先。

## [0.4.0] — 2026-11-18

### 新增

- **节点控制模式**：agent preset `node-control` + `fleetControl` 服务 + 只注册一个工具的
  `./node-control` 入口。该预设的工具集就是它的 `config.plugins`，因此「除节点管理外一律拒绝」
  是组合属性，不是运行时判断。密钥只收引用、拒绝内联，因为工具参数会写进会话日志。
- **`/@fleet/<nodeId>/…` 路径命名空间**：手机用同一套「本机绝对路径」语法就能浏览与选择
  节点目录。中转在 dispatch 前会 `mkdir -p`，这个前缀把它的落点限制在 `<盘>:\@fleet\` 之下，
  fleet 在工作区建好后自底向上 `rmdir` 空目录链 —— 精确清理，不是启发式。
- **目录选择器由 fleet 整体替换**（不是装饰）：桌面上 `directory-picker-auto` 解析成 native
  后端，原生 `list` 会 `requireCapability("browse")` 抛错，中转随即改用自己那份实现，
  继承式的装饰永远调不到。
- **A 类端点补路由**：`goals`、`userQuestions`、`subagents`、`commands`、`messageFeedback`、
  `sessionReferenceResolver`、`fileReferences`、`schedule`。这批的共同形态是「不路由不报错，
  只是回答这台 Host 的」—— 目标条消失、斜杠命令列本机的、`@` 补全给 Windows 路径。
- **插件下发默认全开**，另加 `NODE_NEVER_SYNC` 硬排除清单（本插件、brain bundle、中转插件）。
  理由：装了插件又连了节点的人要的是一套工作环境，不是一个悄悄不同的第二套；
  而「哪些绝不能被送到节点」必须逐条列举，不能靠命名空间推断。

### 变更

- `dsh.bundle.patch` 从字符串改为有序数组，新增 `presets/node-control.patch.yml` 一层。
- 补 `engines.dsh`（`>=0.2.2-rc.3 <0.3.0`）：不满足范围的 DSH 直接拒装，而不是半组合。
- `files` 补上 `presets/*.patch.yml`，并补上此前一直缺失的 `docs/DETAIL*.md` 与 `preview.svg`
  （`meta.detail` 指向不存在的文件时，详情页会显示失败而不是回退到 README）。

### 修复

- 已跟踪文档里的真实内网地址与公网域名换成占位符（本仓库是公开的），`install-unit` 现在会拦。

## [0.3.0] — 2026-11-16

### 新增

- 节点侧组合 `@local/dsh-fleet-brain`：从官方 `dsh-web-app` 派生，减去浏览器面，
  节点 profile 只组合 `dsh-base` + brain，浏览器面**根本不加载**（不是加载后禁用）。
  派生而非手写的理由：`web-app` 有 621 行且每个 release 都在变，手抄会腐烂。
- 插件同步单位从「节点组合里的行」改为「用户安装的 bundle」。

### 说明

首个正式插件版本。此前是原型阶段，没有对外安装形态，不列。