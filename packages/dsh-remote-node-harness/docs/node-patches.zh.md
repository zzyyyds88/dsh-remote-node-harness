# 节点源码偏差台账

节点运行时是从上游源码编译的（`scripts/build-fork-runtime.mjs`），本表记录**我们对上游
源码做的每一处改动**。删包（`DROP_RULES`）与删文件（`ARTEFACT_RESIDUE`）是打包步骤，不进
本表；本表只管「改了源码的行为」。

## 为什么要有这张表

上游会修 bug、会重构。它改到我们改过的那几行时，补丁会冲突。冲突本身不是问题 ——
**静默丢掉我们的改动才是**。所以：

1. 每个补丁是一个独立文件（`packages/dsh-remote-node-harness/patches/node/NNNN-*.patch`），
   标准 unified diff，可以单独读、单独测、单独弃用。
2. 构建时 `git apply --3way` 逐个应用，**失败就停下报错**，绝不 `--reject` 留下 `.rej`
   文件继续打包。
3. 上游自己的修复永远在底下：补丁叠加在选中的 tag 之上，上游修好的字节自然进来，
   不需要我们再搬一次。
4. 本表与补丁文件**一一对应**，由 `test/node-patches-unit.mjs` 断言。缺一行、六列里
   有一列空着，测试就红。

## 六列的含义

| 列 | 回答什么 |
|---|---|
| 补丁 | 文件名，与 `patches/node/` 下的文件同名 |
| 改了什么 | 哪个包、哪个文件、大概哪几行 |
| 移除了什么 | 节点不再具备的行为（写具体，不写「优化」） |
| 为什么节点不需要 | 理由。写不出来的不许进表 |
| 怎么验证的 | 跑过的命令或实测记录 |
| 上游改到同一处怎么办 | 冲突时怎么重做，不是「看情况」 |

## 当前补丁

| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |
|---|---|---|---|---|---|
| `0001-team-write-scope-overlap-all-live-tasks.patch` | `packages/team/agent-team/src/task-view.ts`：`projectTaskView` 的写作用域比对从「只比 `in_progress` 的兄弟任务」改为「比每一条非 `deleted` 的任务」，并在提示里带上对方状态（`(pending)` / `(completed)` / `(in_progress)`）；配套改 `tests/team.spec.ts`、`tests/projection-events.spec.ts` 三处断言 | 「一个任务完成后，它和别的任务的写作用域冲突就不再出现」这条行为。改动前，兄弟任务一 `complete`，重叠警告立刻消失，调用方看到的是「无冲突」，而已写过的文件仍可能被后一个任务再写一遍 | 不是「节点不需要」，是**上游行为本身就是缺陷**：ADVISORY 的语义是「提示冲突」，过滤掉历史任务等于在最需要提示的时刻（兄弟任务刚写完同一批文件）删掉提示。用户实测报告了这一条（缺陷 2），节点是它唯一的使用面 | 三处断言按新语义重写并跑绿：`npx vitest run packages/team packages/client/ui-agent-team` → **57 文件 / 1343 通过 / 1 跳过**；`npx tsc --noEmit -p packages/team/agent-team` 无输出 | 上游若修了同一处，先看它是否已经改成「比所有活动任务」。是则删掉本补丁与台账行；否（只是重构）则按新行号重出补丁，六列里「移除了什么」一栏改成上游的表述。警告文案是断言的一部分，上游改文案时补丁必然冲突，这是好事 |
| `0002-fork-seed-covers-requesting-turn.patch` | `packages/subagent/subagent-fork-in-process/src/index.ts`：切点从「最后一个 `turn/end`」改为「最后一条携带未应答 tool-call 的 `assistant/message` 之前」，再用 `buildForkSeed` 收口；`packages/subagent/tool-subagent/src/index.ts` 的模型可见措辞随之改准；`packages/subagent/subagent/src/types.ts` 与 `docs/subsystems/subagent.md`、两个 README 的措辞同步；四处测试断言按新语义重写 | 「首轮委派/轮次中点委派时子 agent 拿不到任何上下文」。改动前，父会话还没有 `turn/end` 时 provider 直接返回空 seed，子会话 `isSeeded: false`、`inheritedEventCount: 0`，而工具描述却向模型承诺「seeded with all completed turns so far」，子 agent 于是回答「看不到这段对话」；父会话已经有若干轮时，切在 `turn/end` 又会丢掉**当前轮的用户请求**——正是要求它做这件事的那一条 | 同上：这是**上游缺陷**，不是节点冗余。缺陷 3 的实测证据：父会话里埋的标记词在子会话里 `sees MARMALADE: false`；录制日志的 34/34 个切点经 `buildForkSeed` 收口后全部被 `Session.create` 接受且 turn 边界平衡 | `npx vitest run packages/subagent packages/team packages/client/ui-agent-team` → **57 文件 / 1343 通过 / 1 跳过**；`npx tsc --noEmit` 逐个包通过；`packages/subagent/subagent-fork-in-process/tests` 13 条全过（含新增「首轮 fork 也 seeded 且继承用户请求」） | 上游若已经改成同样的切点，删本补丁。若上游只是改了 `buildForkSeed` 的签名或 `TurnEndReason`，`--3way` 会重定位；若上游把 `forkCut` 的判断逻辑改写，冲突点就在 `forkCut` 一个函数里，按新事件词汇重写这二十行即可，测试断言可原样保留 |

> 两个补丁都叠在上游 tag `dsh-v0.2.2-rc.5` 之上，构建时 `git apply --3way` 逐个应用，
> 失败即停（`test/node-patches-unit.mjs` 断言四种情形）。
> 台账为空曾是 build 5/6 的事实：**源码与上游 tag 逐字节相同**，差异全在打包步骤里
> （归档文件数 41 846 → 25 038）。build 7 起不再是空集 —— 上面两行是第一批。
> 剩余候选（`dsh-client-*` 的浏览器半边、`dsh-doc` skill 的 Windows 分支）仍需先过证据
> 标准，验不过就标「待观察」，不硬改。

## 构建侧源码修复（不进归档，所以不是补丁）

fork 里还有一类改动：改的是**构建/发布工具链**，产出的归档字节里没有它们。它们不能写成
`patches/node/*.patch`（补丁是给「节点读到的源码」用的），但也**不能不入账** —— 否则
「fork 上除了台账那几条还有别的改动」就成了一句无法核对的话。

`build-fork-runtime.mjs` 在动手前会跑 `checkForkBase()`：fork 的 HEAD 必须**要么就是**
`dsh-v<version>` 那个 commit，**要么是**下表里的某个提交，且工作树干净。不在表里的提交
会让构建停下并报出它的哈希 —— 这就是「改了不记」的闸门。

| 提交 | 改了什么 | 为什么必须改 | 为什么不进归档 |
|---|---|---|---|
| `057ce8f3` | `scripts/release/verify-packed-install.ts`：Windows 上改用 Node 跑 npm 的 JS 入口，而不是 spawn `npm.cmd` | `npm.cmd` 是批处理 shim，没有 shell 时 `spawnSync` 直接 ENOENT/EINVAL，装包验证在 Windows 上根本跑不起来 | `scripts/` 不在 `@deepseek-ai/dsh` 的 `files` 里，归档里没有这个文件（已实测：解包归档 `grep verify-packed-install` 无命中） |

> 台账与上表的区别只有一条：**节点会不会读到那段代码**。会 → 必须是补丁；不会 → 记在这里。
