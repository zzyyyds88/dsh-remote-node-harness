# DSH 远程节点插件 · 架构（v0.3）

> **目标本身在 [`GOAL.zh.md`](GOAL.zh.md)**，那是最高真源：做什么、为谁做、什么算达成、做决定的规则。
> 本文只答"怎么做"和"每个决定否决了什么"；两者冲突时以 GOAL 为准，改本文。
>
> 目标：让远程 Linux 机器上的工作区**在本地桌面端里像本地工作区一样使用**，同时顺便解决 `@artenx/dshb` 的痛点 —— **工具不可用**（grep/glob、git、read_image 在远程失效）。
>
> 参考实现：`zai-org/ZCode`。它远控好用的根本原因是**远端有大脑**：本地不发每条指令，只连过去用。本插件走同一条路。
>
> 两个包：`packages/dsh-remote-node-harness`（插件，装在桌面端）与 `packages/rnh-brain`（节点侧的 DSH 组合，只当大脑）。

---

## 一、结论先行

**大脑留在节点上。** 每台机器跑一个完整的 DSH Host，`bash`、`grep`、`glob`、`git`、`read_image`、PTY、MCP 服务器、skills 全部在**那台机器自己的进程里**执行，用它的文件系统、它的二进制、它的 shell。本地只是**调度者**。

这不是"本地发指令、远端执行"的代理模型。代理模型有四个绕不过去的硬缺口，全部被本方案避开：

| 代理模型的缺口 | 证据 | 本方案 |
|---|---|---|
| MCP 服务器在**本机** spawn | `dsh-mcp-client/src/transport.ts` 用 MCP SDK 直连，不经 `ctx.subprocess`，无法重定向 | 远端 Host 自己 spawn 它自己的 MCP |
| skills 用 `node:fs` 扫**本机** | 各 skill 目录由本地进程枚举 | 远端 Host 扫它自己的 |
| bash/pwsh 方言按 `process.platform` 二选一 | 本地 Windows 会选 pwsh，转发到 Linux 必然 127 | 远端 Host 是 Linux，自然选 bash |
| 沙箱无法延伸到远端 | 本地 `DSH_PERMISSION_MODE` 管的是本地进程 | 远端 Host 用自己的权限模式 |

前三条正是 `dshb` 报 `code=127` / 工具找不到的根因；靠路径翻译、argv 改写、可执行文件解析去补，是补不完的。

**然后是混排。** 远程 Host 的会话与工作区必须作为**真实的行**出现在本地 Host 的 `session/list` 与 `workspace/follow` 里 —— 不是新开一个面板、也不是 iframe 另一个页面。理由有二：

1. 这样桌面端的侧栏、会话视图、文件查看器、审批、终端、job、goal 全部照常工作，因为它们看的本来就是这两个接口；
2. `ds-harness-remote`（P2P 端到端加密远控）的白名单里有 `session/list` / `session/follow` / `session/prompt` / `session/page` / `workspace/follow` / `workspaceFiles/*`（0.6.5 与 0.6.6 都一样，后者只多放行 5 个端点）。本地网关多返回远程行，手机端就自然读得到这些**会话行**，**它一行都不用改**。

   这句话要限定在「会话行」上，不能推广到「节点上的文件」。手机对**远端会话**调 `workspaceFiles/{read,readBytes,readAll,stat,search}` 会被中转自己挡下：它在 dispatch 前先 `resolveWorkspaceRootForSession(sessionId)`，做法是让 Host 派发 `session/list`、取该行 `cwd`、再在 **Host 本机** `realpath()`。而 rnh 合并进来的远端行，`cwd` 是节点上的路径（`/root/proj`），本机 `realpath` 得 `ENOENT`，于是回 `WORKSPACE_UNAVAILABLE`（`authority-unavailable`）。这道闸门 0.6.5 就有（`WORKSPACE_FILE_READ_ENDPOINTS` 与 `resolveWorkspaceRootForSession` 两版逐字节相同），不是哪次升级引入的；`search` 只是又多了一个撞同一堵墙的端点。桌面端点开远端文件不受影响 —— 那条路走 rnh 的 `workspaceFileScope` lookup，不经过中转。见 [UPGRADE](../packages/dsh-remote-node-harness/docs/UPGRADE.zh.md) §九的漂移表。

手机那条路（DSH Go → 中转 → 桌面 Host → 节点）的形态、边界与实施顺序见
[ADR-0003](adr-0003-phone-control.zh.md)。一句话结论：中转的每一次调用走
`gateway.dispatch`，而 rnh 把 override 装在同一批 service 实例上，所以**混排与路由对手机
自动生效**，两个插件不需要互相知道对方存在。

手机入口需要 rnh 额外做四件事，设计与取舍见 [ADR-0004](adr-0004-node-control-and-picker.zh.md)：
节点路径用 `/@rnh/<nodeId>/…` 命名空间（于是中转 dispatch 前的 `mkdir` 落点被限制在一个可精确
清理的位置）、`directoryPicker` 的 `list`/`createDirectory` 由 rnh **整体接管**（原生后端在桌面
上是 `native`，装饰根本调不到）、一个只有 `rnh_nodes` 工具的「节点控制」预设、以及符合官方
`install_bundle` 的清单形态。

---

## 二、形态

```
┌────────────────────── 本地 Windows · DSH Desktop ──────────────────────┐
│  Electron 窗口 (dsh-app://app/)                                        │
│    └─ 本地 Host 进程 (dsh --profile desktop)                           │
│         ├─ 官方 /api、/api/remote.mux    ← 原样不动                    │
│         │     └─ 本插件在**实例**上覆写若干方法：                       │
│         │        session/list、workspace/follow、session/follow …      │
│         │        → 本地行 + 每个已连接节点的行                          │
│         ├─ typert.lookups('workspaceFileScope')  ← 覆写，保留 delegate  │
│         └─ /rnh/api                    ← 节点管理 + 按路径加工作区    │
└────────────────────────────────────────────────────────────────────────┘
                              │ SSH :22（唯一入口，不开放端口）
                              ▼
┌──────────────────── 远端 Linux · 常驻大脑 ─────────────────────────────┐
│  ~/.dsh-remote-node-harness/runtime/node_modules/@deepseek-ai/dsh                    │
│    └─ dsh --profile rnh --host 127.0.0.1 --port 0 --no-open          │
│         （profile 名按 remoteRoot 派生：~/.dsh-remote-node-harness → rnh，          │
│           ~/.dsh-remote-node-harness-b → rnh-b；见 §六之四「每节点一份路径」）        │
│         ├─ 完整 DSH Host：rg / git / read_image / bash / PTY 原生执行   │
│         └─ 会话、工作区、审批、终端全部在远端，本地不复制                │
│  ~/.dsh-remote-node-harness/run/{status.json, pid, host.log}                         │
└────────────────────────────────────────────────────────────────────────┘
```

本地与节点之间只有**一条 SSH 连接**，上面同时跑 HTTP 与 WebSocket：`ssh2` 的 `forwardOut` 开一条 `direct-tcpip`，之后手写 HTTP/1.1 与 RFC 6455 都骑在这条字节流上。节点的 Host 只监听它自己的 loopback。

---

## 三、五条接入缝隙（各有测试）

插件**不替换任何上游 Loader 行**，也**不从 `app.asar` 里 import 任何东西**。全部接入点都在运行时。
前三条是路由的基础，后两条是「上游在方法体之前就把身份解掉了」时唯一的入口 —— 它们的存在理由
比前三条更窄，但**必须单独列出来**：任何一条被上游改掉，那一整类端点会静默失效，而不是报错。

### 缝隙一：实例上的 own property

`@Remote` 装饰器不是静态属性：它走 `context.addInitializer`，per-instance 执行 `mark(Object.getPrototypeOf(this), …)`，写在**类原型**上，key 是字符串 `'@deepseek-ai/dsh-typert-protocol/remote-methods'`。而 Gateway dispatch 走 `Reflect.get(view, name)` —— `receiverContext.extend({ invocation }).get(serviceKey)` 拿到的 view 会**优先读实例 own property**。

于是：在实例上装一个同名 own property，dispatch 命中它，而 discovery（`remoteMethods` / SRC claims）仍然读原型 → **声明面不变，实现换了**。`test/dispatch-seam.mjs` 实证了这点，并验证未标注端点在覆写后依然走原型。

还有一个必须守住的约束：Gateway 用 `Function.prototype.toString` 解析形参名（`methodParameterNames`），所以 overrider 的**形参名必须与上游签名一致**，否则 wire 字段对不上。

### 缝隙二：`typert.lookups.configure('workspaceFileScope', …)`

`workspaceFiles/*` 的第一个参数是 `workspaceFileScopeId`，Host 先用 lookup 把它解析成 `{sessionId, workspaceRoot}`。而 `rnh_<node>_<id>` 不是本地 Session，上游 lookups 会先返回 `not-found`，**根本轮不到装饰器**。

所以覆写这个 lookup：先取回上游 provider 的 resolve 做 delegate，本地 id 原样委托，`rnh_` id 合成 `{sessionId, workspaceRoot:'/'}`。`test/host-routing.mjs` 同时验证了**远程读到节点磁盘**和**本地仍然读到本地磁盘**。

### 缝隙三：SSH `direct-tcpip` 上的 HTTP 与 RFC 6455

`test/gateway-smoke.mjs` 证明 cookie 铸造、unary RPC、流载体 upgrade 都能在一条 SSH channel 上跑通。注意两点，都是自写客户端最容易踩的坑：

- Gateway 每 2 秒 ping 一次（`websocketHeartbeatIntervalMs` 默认 2000），**不应答就断**；
- 带字节的结果**不是 JSON**：Gateway 把每个 `Uint8Array` 换成 `null`、记下它的 JSON 路径，字节另走 `multipart/form-data` 分片。`workspaceFiles/readBytes` 就是这条路 —— 只会 `JSON.parse` 的客户端会拿到一个 `HTTP 200` 但解不开的响应体，很容易误判成"节点坏了"。`src/host/multipart.js` 专门负责还原它在正确的路径上（有 `test/multipart-unit.mjs` 守着）。

### 缝隙四：`typert.lookupStore.resolvers` 里的 `agent` 项

`agent: Agent` 形参在**方法体之前**就被 Gateway 解析掉，所以装饰器看到的已经是占位对象 —— 想换掉解析结果，只能换 resolver 本身。而公开的 `typert.lookups.configure('agent', …)` 已被 `@deepseek-ai/dsh-api-session-controller` 占用（`configure` 对同一 key 第二次调用直接抛错）。

所以 `host/lookups.js` 直接替换 `typert.lookupStore.resolvers` 这个 `Map` 里的 `'agent'` 项：`rnh_` 前缀合成占位 Agent（`{ id, ctx }`，`ctx` 用插件自己的长命 Context），其余 id 原样委派给被替换掉的那个 resolver；`dispose` 时只在自己仍是当前项的情况下还原（否则会把别人的覆盖删掉）。

为什么必须走到这一层：`terminal/*` 九个端点里六个吃 `Agent`，`goals/*`、`userQuestions/*`、`subagents/*` 同样。占位对象不是注册过的 Agent，`ctx.agents.get(id)` 拿不到它 —— 所以装饰器不能指望它，只能拿它的 `id` 去解节点，再用**节点自己的**形参转发（见 §五「形参里是 `Agent` 的两个例外」）。

`test/routing-extra-unit.mjs` 用 `{ id, ctx: {}, session: undefined }` 这个与 `lookups.js` 完全同形的占位对象驱动每个 `agentEndpoint`。

### 缝隙五：Gateway 的待处理事件表（waterfall 中继）

上游唯一的「发起一次本地 waterfall」入口是 `api-remotes` 的监听器，它要求 `this` 是 `scopeTarget(agent, agent)` 造出的 carrier —— 模块私有 WeakMap，只有 `@deepseek-ai/dsh-scope` 能注册，而本插件不 import 上游。

但**监听器之后**全是实例上的普通状态：Gateway 把待处理的转发事件存在 `pendingRemoteEvents`，用 `deliverRemoteEvent` 投递，浏览器答复经 `receiveRemoteEventResult` 回到同一张表。所以 `host/remote-waterfall.js` 自己造一条与 `startRemoteEvent` 同形的 pending 记进那张表，把投递、去重、结算交给上游。

三条硬约束：

1. `agentId` 必须 `Router.toLocal` 包成 `rnh_…`，否则浏览器合成的 scope 用裸 id，卡片进不了那张会话；
2. `frame.request` 里不能有 `agent` / `signal` / 显式 `undefined` —— 浏览器自己补前两个；
3. 没有活的 owner 客户端（`gateway.hasLiveClient()` 为假）时立刻答 `next`，否则 pending 永挂、把远程回合吊死。超过 10 分钟没人答同样答 `next`（上游 approval 的默认值本来就是 `'unavailable'`，所以这是**降级回原状**，不是新增失败模式）。

`test/waterfall-unit.mjs` 逐条钉住这三种结局，`test/approval-acceptance.mjs` 在真节点上走完整圈。

---

## 四、身份：一个字符串回答三个问题

远程身份过边界时是 `rnh_<nodeId>_<remoteId>`，例如

```
rnh_n0123456789ab_session-1dc98667-3f1e-4f47-9d5b-2a4e2b3d3f6a
└─ 5+13 字符 ──┘└─ 节点上原本的 session-<uuid> ──────────────┘
```

解出来既知道该发给哪个节点，也知道节点上原本是谁 —— **没有第二张路由表**可以和 UI 里已有的身份失同步。

一条必须遵守的规则：**只有完整匹配 Session 身份形状的字符串才重写**。松散的 `startsWith('session-')` 会把事件**类型** `session-log-deepseek/delivery-accepted` 也改写掉，于是客户端渲染的每一个事件都被静默污染。`test/host-routing.mjs` 有一条专门的断言守这个。

**子代理的 Session 没有 `session-` 前缀**：节点用裸 uuid 铸造它（`sessionId: "026e33cb-…"`，父 Session 才是 `session-<uuid>`）。所以「按值匹配形状」不够，方向反过来的 `toLocal` 还得**按字段名**包装：`sessionId`、`childSessionId`、`parentSessionId` 里出现裸 uuid 一律包。只按值匹配的后果实测过一次：侧栏列出的子代理 id 是裸 uuid，浏览器按目录行拼出 `{kind:'subagent', parentSessionId, childSessionId}` 地址，本机 `decodeRemoteId` 解不出来，`session/page` 落到本地实现，本机没有那段日志，于是「历史加载失败：subagent is unavailable（subagent/not-found）」。字段名是这里唯一的判据，因为一个裸 uuid 只可能是子代理 Session，而只有 Session 字段能装它。

Workspace 身份同理（`rnh_<nodeId>_<workspaceId>`），只是包装点不同（`workspaceId` / `workspaceIds` / `beforeWorkspaceId`）。

---

## 五、路由表

| 命名空间 | 路由 | 说明 |
|---|---|---|
| `session/list`、`search` | **合并** | 本地结果 + 每个可路由节点的结果，节点不可达时跳过而不是整体失败 |
| `session/create` | **路由** | 目标 workspace 是远程的 → 在节点上建 Session（节点上真的有 `~/.dsh/sessions/--root-<dir>--/`） |
| `session/prompt`、`cancel`、`rename`、`fork`、`attachment`、`page`、`events`、`state`、`wait`、`projections`、`selectModel`、`updateQueue` | **路由** | 按 `sessionId` / `address` 找到节点 |
| `session/follow`、`observeEvent`、`observeProjections`、`observeState` | **合并/桥接** | 流方法的第一个位置参数**就是** request 对象本身（不是 `{request}` 包装），转发时按节点形参名 `request` 重新包一层 |
| `session/control` | **合并** | Host 级、每连接一条，不是按 Session 路由：本地流 + 每个节点的投影块，并成一帧 baseline 再串增量 |
| `$events`（网关自有端点） | **中继** | 节点的 `api-session/*` 事件重新在本机 emit，身份包成本地形式；同一流上的 waterfall 用 `next` 答掉 |
| `workspace/follow` | **合并** | 一条流里同时推送本地 baseline 与每个节点 baseline；之后再串各自增量 |
| `workspace/create` | **按路径路由** | `/@rnh/<nodeId>/…` 直接定节点（见下）；裸 POSIX 路径逐节点尝试（节点侧 `realpath` 校验必须通过）。成功后清理中转 dispatch 前 `mkdir` 出来的幽灵目录 |
| `directoryPicker/list`、`createDirectory` | **整体替换，不是装饰** | 原生后端在桌面上解析成 `native`，`list` 会 `requireCapability("browse")` 抛错，中转随即改用自己那份实现 —— 只做装饰永远调不到。见下 |
| `workspace/rename` 等变更 | **按 owner 转发** | 按 workspaceId 找节点 |
| `workspaceFiles/{list,stat,read,…}` | **路由** | 靠缝隙二解析出节点，payload 用 `workspaceFileScopeId` |
| `agentTeams/setEnabled` | **按 owner 转发** | 形参是 `Agent`，但装饰器先用 `agent.id` 解出节点再转发，见下 |
| `sessionQuery.readEvent` | **按 owner 转发** | Host 内部方法，没有 wire 端点，见下 |
| `job/list`、`follow`、`kill` | **路由** | 按 Session id 找节点；`follow` 的 `sessionId` 是可选的（无主 job 谁都能看），没有它就不猜节点 |
| `terminal/list`、`watch` | **路由** | 让侧栏能报告远程 Session 的终端 |
| `terminal/create`、`attach` … | **路由** | 形参是 `Agent`，由 `overrideAgentLookup` 先给出占位对象，装饰器再用 `agent.id` 解出节点 |
| `goals/{get,create,edit,pause,resume,complete,clear}` | **路由** | 身份是 `agent: Agent`。不路由的表现是目标条消失（本机注册表里没有那个 Session） |
| `userQuestions/{answer,attachWait}` | **路由** | 同上；`attachWait` 是流，必须代理而不是 await，否则卡片的倒计时不启动 |
| `subagents/{prompt,interruptByUser}` | **路由** | 子代理自己的 Session id 是裸 uuid，`request.childSessionId` / 第一个字符串形参都可能是它 |
| `commands/{list,execute}` | **路由** | 斜杠命令是**节点那份组合**提供的，本机答案会列出不存在的命令 |
| `messageFeedback/{list,put,delete}` | **路由** | 身份在 `request.sessionId`；不路由时点赞要么找不到会话，要么落到本机同形状的另一个会话上 |
| `sessionReferenceResolver/candidates` | **路由** | `@` 提及的会话列表该是节点的 |
| `fileReferences/list` | **路由** | 路径补全，答错最直观：远程会话里出现本机的 Windows 路径 |
| `schedule/catalog`、`list` | **合并** | 条目是 Host 级的，只能合并：本机的行 + 每个节点的行，节点行的 `id` 包成 `rnh_<nodeId>_<id>`。分页在合并后的行上算 |
| `schedule/{view,edit,run,history}` | **路由** | 按那个包裹 id 解回节点与它自己的条目 id |
| `schedule/create` | **路由** | 身份在 `request.target.sessionId`：给远程会话建的任务必须建在节点上 |
| `schedule/deleteInactive` | **本机 + 广播** | 无身份；不在节点上也清一遍，否则下次合并会显示「删不掉」的任务 |
| `schedule/deliveryLimits`、`session/modelCatalog`、`agentPresets/*`、`settings/*`、`pluginManager/*` | **保持本地** | 描述的是**这个安装**的模型与配置，与节点无关 |

### 判据：它读的状态在谁那儿

上表是「已经决定的」。判据不是「名字像不像远程」，而是**这条端点读的状态存在谁那儿**。

没有路由时的表现是**静默落到本地实现**：不报错，拿到的是一份「看起来合理但属于另一台
机器」的答案。这正是子代理历史与智能体协作那两条 bug 的共同形态，也是上面这批端点补
路由的理由 —— `goals/get` 回答 `undefined` 不是错误，是「这个会话没有目标」，于是目标条
就消失了。

接入方式不是重复劳动：`router.js` 提供了四种形状的工厂，因为身份在这四类位置上出现，
而且**只有一类能被通用处理**。

| 身份在哪 | 工厂 | 注意 |
|---|---|---|
| `agent: Agent` 形参 | `agentEndpoint` | 网关在方法体之前按 `lookup` 解析这个形参，所以装饰器看到的已经是占位对象；转发时只把 `agentId` 换成节点自己的 id |
| `request.*` 字段 | `fieldEndpoint` | 只解包这一个字段，request 里其它身份仍然保持包裹状态 |
| 第一个字符串形参 | `firstArgEndpoint` | wire 字段名必须照 descriptor 写（`childSessionId`，不是 `sessionId`），否则报 `args fields do not match the descriptor` |
| 没有身份（Host 级条目） | 手写合并 | `schedule` 是唯一一类：条目不属于某个会话，所以只能合并 + 把 id 包起来 |

还有一个反复踩到的点：这些装饰器要装在**每个服务自己的 `ctx.inject`** 里，不是在
`sessionController` 那个回调里 `scope.get(name)`。后者在服务晚挂载时永远看不到它，
而且失败是静默的 —— 那个命名空间一直回答本机。

`workspace/create` 的按路径路由有个现实理由：**本地目录选择器只能浏览本机**，永远选不到节点上的 `/root/project`。所以远程工作区从 `/rnh/api/workspaces` 加入（设置页节点行展开后的输入框），它在节点上 `workspace/create`，再把结果包装成本地身份还回来。

### 节点路径的语法位置：`/@rnh/<nodeId>/…`

`ds-harness-remote` 的手机端只会说「本机绝对路径」，节点路径必须挤进同一套语法。用
`/@rnh` 前缀（细节与取舍见 [ADR-0004](adr-0004-node-control-and-picker.zh.md) §二）：

```
/@rnh                       → 节点列表
/@rnh/<nodeId>/             → 那台节点的文件系统根
/@rnh/<nodeId>/root/proj    → 那台节点上的 /root/proj
```

三条理由，每条都能被否证：

- `rnh://x` **不行**：win32 上 `isAbsolute` 为 false，中转 dispatch 之前的
  `ensureHostWorkspaceDirectory` 会先抛 `INVALID_MESSAGE`，rnh 收不到请求；
- 只做「逐节点试」不行：只能选已存在的目录，多台同名路径谁先谁得；
- `/@rnh` 让中转那次 `mkdir` 的落点被限制在 `<盘>:\@rnh\` 之下 —— 于是清理是**精确的**
  （自底向上 `rmdir`，`ENOTEMPTY` 就停），不是靠 mtime 或「目录为空」猜出来的。

`browse.js` 的 `listLocal` 因此补了 `crumbs` 字段：手机端的面包屑要能读成「主目录 / 节点名 / root / proj」，
而原生后端的 listing 形状里没有这一段。

### 形参里是 `Agent` 的两个例外

上游把「带身份的端点」分成两类：身份在 `request.sessionId` 里，或者身份是一个 `Agent` 对象（`invocation.kind === 'context', context: 'agent'`）。第一类靠 `decodeRemoteId` 就够了；第二类不能只靠包装 id —— Gateway 在方法体运行**之前**就用 `ctx.typert.contexts.registerHost('agent', …)` 把 `agentId` 解成节点上那个 Agent，而我们的 `overrideAgentLookup` 只能给包装 id 造一个**占位对象**。占位对象不是注册过的 Agent，`ctx.agents.get(id)` 拿不到它，于是上游自己的守卫先炸：

- `agentTeams/setEnabled`：`TeamService` 第一行就 `ctx.subagents.rootOf(agent)`，要求 `agents.get(caller.id) === caller`，否则抛 `subagent tree access requires the exact live caller`。它不是 `RemoteError`，Gateway 兜底成 `gateway/internal`，浏览器把原文显示成「智能体协作无法打开」。
- `sessionQuery.readEvent`：不是 `@Remote`，是 Host 内部方法，`/api/present.open` 用它按 `{sessionId, seq}` 取事件。远程 Session 的事件不在本机的 query engine 里，于是那个路由 404，卡片显示「无法在文件管理器中显示，请重试」—— 一句让人反复重试却永远不可能成功的话。

两个都用同一种办法绕开，因为上游那两个方法体的**前置条件在本机无法满足**：装饰器先用 `agent.id` / `request.sessionId` 解出节点，再把**节点自己的形参**转过去。`sessionQuery.readEvent` 没有 wire 端点，所以读法是拿 `session/page` 钉在事件自己的 `seq` 上（`throughSeq` 取该 seq），Session 头从 `session/list` 那一行取 `cwd` —— 路由只用 `cwd` 定位工作区根目录。

转发之后 `/api/present.open` 不再是 404 而是 **422**，这不是退步而正是正确答案：`openVerified` 用 `ctx.fs.processPathFromHostPath` 把节点路径映射成本机路径，节点上的 `/root/x.html` 在 Windows 上没有映射，于是拒绝。上游客户端把 422 记成 `nativeUnavailable`，文案是「此文件没有可用的主机路径，请在侧边栏预览」—— 这是对一台远程机器上的文件唯一诚实的答案，也正好对得上 zcode 的判据：只有目标是本机（或 WSL）时才提供「在文件管理器中显示」。

### 为什么"快照对"不等于"侧栏活"

上面这些合并回答的是**某一刻的状态**。侧栏不是靠快照重建的：上游客户端另有两路活流，本地 Session 天然在流里，远程 Session 不在 —— 只做合并的话，行会"在，但死着"。

| 活流 | 携带什么 | 不中继的症状 |
|---|---|---|
| `$events`（网关自有端点）→ `api-session/added`、`removed`、`status`、`activity`、`error` | 行的新增/消失、运行中的转圈、最近活动时间、agent 错误 | 新建的远程 Session 要等下一次整表拉取才出现；转圈永远不转 |
| `session/control` → 每个 Session 的投影块（`title`、`modelSelection`、`permissions`、`inbox`…） | 标题、选中模型、待处理的审批/提问标记 | 标题停在 "New Session"，节点上改的标题永远追不过来 |

两路都是 **Host 级、每连接一条**，不是按 Session 路由，所以处理方式不是转发而是**并流**：

- `session/control` 由 `RemoteControl` 持有每个节点一条，投影块合成一份 baseline（远程块的身份用本地包裹形式），每个本地消费者各拿一条合并流。**合并后的流只发一帧 baseline**：上游客户端把任何 baseline 都当"这就是全部"，先推远程再推本地会把远程块擦掉 —— 那处 bug 只在读第二帧时暴露，看起来像"远程投影从来没生效"。节点集合变化时用最后一份本地块重折一次再发，等价于上游重连。
- 远程块**不是**节点 baseline 的转发，而是本机自己攒的一份。节点那边 `session/control` 的 baseline 取的是它**内存里活着的** Session（`ctx.sessions.list()`），远程会话在节点上不常驻，重启一次就空了 —— 实测：插件开关重启节点后，节点自己的 baseline 是 `{}`，转发它就等于"远程投影消失"。所以 `RemoteControl` 在首帧看到某个 Session 时建块、按 `changes` 逐键合并、`asOfSeq` 跟着 `seq` 前进，与上游客户端应用 `projection` 帧的规则一致。这样晚连上的客户端（刷新页面、第二个窗口）拿到的 baseline 里有这些会话，而它无法像本地行那样用 `session/list` 修 —— 远程行在列表里是快照，不是一个投影块。
- `$events` 由 `RemoteEvents` 每个节点开一条，把闭合白名单里的五个事件用 `Router.toLocal` 包一遍后在本机 `ctx.emit`。上游的 `api-remotes` 本来就会把这些事件转发给每个已连接客户端，所以**浏览器侧一行没改**，远程事件就走本地事件同一条管道。

白名单是闭合的：重发一个本机也会发的事件是安全的（客户端按身份合并），但重发一个需要本机 `Agent` 才能解释的事件不是。`test/event-relay.mjs` 用的判据是"在节点上直接建的 Session" —— 本机没发过那个调用，浏览器听到的一切只可能来自中继。

同一 `$events` 流上还有 `approval/request`、`user-questions/request` 两个 waterfall，它们是**要弹卡的**，不是用 `next` 答掉。`RemoteWaterfalls` 把帧里的 `agentId` 包成本地身份后塞进上游 Gateway 的 `pendingRemoteEvents`，等浏览器通过 `$events/result` 答复，再把答案原样转给节点（`{kind:'result', value}` 或 `{kind:'next'}`）。没有浏览器在听时立刻答 `next`，十分钟没人答也答 `next` —— 两种情况都退化成"节点的默认值"，绝不把远程回合吊死。判据见 §七 的 `approval-acceptance.mjs`。

**两路流都必须能自己活回来。** 常驻 host 一重启（插件开关就会重启它），网关的载体连同所有逻辑流一起断，而 `RemoteEvents` / `RemoteControl` 里的节点条目还留在 Map 里 —— 只判断"这个节点在不在 Map 里"就永远不会重开。实测症状：一次插件开关之后，节点上新开的 Session 不再产生任何事件，侧栏的投影块消失，审批卡在本机点了通过而节点从没收到答案，`tool-parity` 等了一次"已经跑完的回合"整整 7 分钟。

**更难判的是那个载体看着还活着。** 宿主进程没了，这条 socket 的 `writable` 仍是 true：写进去的帧没人读，于是 `session/follow` 打开成功、一帧都收不到 —— 比报错更糟，因为它长得像"节点没有输出"。所以恢复分三层，缺一层都会留下一个静默的空流：

1. `gateway.reset()` 由**重启它的人**调用（`syncConfig` 在 `ensureServing({force:true})` 之后），作废载体和所有逻辑流，并用代号（generation）让旧 socket 迟到的 `close` 不再清掉新的载体；
2. 每条流的 `onEnd` 调用 `gateway.revive()`：延迟 1 秒重开，最多 8 次。1 秒不是随便取的 —— 同时刻重连打到的是正在关停的 host，必然失败；
3. `openStream` 在写失败时丢掉载体重试一次，`carrierClient` 在 socket 已 `destroyed` 或不可写时重开；升级被 401 拒绝时重新换取 cookie（重启后的宿主发的是新 cookie）。

---

## 六、包结构

```
D:\ProjectHub\DSHpl\
  README.md             仓库说明
  AGENTS.md             协作规则（本项目的硬约束）
  docs/ARCHITECTURE.md  本文档：设计与取舍
  packages/
    dsh-remote-node-harness/          插件：Host 侧 + 浏览器侧
    rnh-brain/            节点侧 bundle：只当大脑的 DSH 组合（生成物 + 生成脚本）
  reference/            上游源码（DSH / ZCode），独立克隆，不进版本库
```

```
packages/dsh-remote-node-harness/
  package.json          dsh.bundle.patch（数组：插件行 + 预设行）+ dsh.client + engines.dsh
  cordis.patch.yml      insert: dsh-remote-node-harness（单行；不禁用任何上游行）
  presets/
    node-control.patch.yml  preset-node-control：persona + 一个 rnh_nodes 工具
  src/
    core/               nodes.json 注册表、凭据、HTTP 错误、每插件同步开关的语义
    ssh/                ssh2 连接池、exec、forwardOut、错误分类
    remote/             远端守护：probe / install / 节点 profile / 配置 / start / verify
    node-control/       `./node-control` 入口：只注册 `rnh_nodes` 一个工具（预设挂它，不挂整个插件）
    host/
      ssh-http.js       把 SSH channel 当 socket 用，手写 HTTP/1.1
      ws.js             手写 RFC 6455 客户端（应答 ping、帧重组）
      remote-gateway.js cookie 铸造、unary call（401 自动重试一次）、逻辑流
      multipart.js      Gateway 的 multipart 应答解码（字节附件还原）
      provision.js      模型行复制、凭据下发、配置渲染
      browse.js         选工作区时的目录浏览：本机 readdir / 节点 find，同一返回形状（含 crumbs）
      picker-paths.js   `/@rnh/<nodeId>/…` 命名空间：编解码、影子路径、精确清理
      rnh-control.js  `rnhControl` 服务：节点增删改连断，工具唯一可及的面
      sync-switches.js  每插件开关：读本机 profile manifest、记住选择、算节点 bundle 列表
      brain-bundle.generated.js  节点组合（生成物，来自 rnh-brain）
      routing.js        身份编解码、AsyncQueue、ChangeSignal、own-property 覆写
      router.js         toRemote / toLocal / toLocalWorkspace / call / 流
      remote-workspaces.js  每节点一条 workspace/follow，baseline 缓存与合并
      remote-events.js  每节点一条 $events，把 api-session/* 中继进本机事件总线
      remote-control.js 每节点一条 session/control，投影块并流给每个客户端
      decorators.js     五个命名空间的路由装饰器（session / workspace / workspaceFiles / job / terminal）
                        + 合并后的 control 流 + directoryPicker 的**整体替换**
      lookups.js        workspaceFileScope lookup 覆写
      rnh.js          节点运行时状态机
    client/client.js    设置页 + 侧栏面板 + 主区页面 + 加工作区的目录选择对话框
  locale/{en,zh}.json  含 meta.detail 指向 docs/DETAIL*.md
  docs/DETAIL.md  docs/DETAIL.zh.md  docs/preview.svg   插件详情页（会被安装清单检查）
  icon.svg  README.md
  test/                  见下
```

```
packages/rnh-brain/
  package.json          dsh.bundle.patch（含 4 个 preset 层）
  cordis.patch.yml      生成物：98 行 upstream → 60 行大脑组合
  presets/*.yml         原样复制自 upstream
  src/runtime.js        手写：大脑自己的运行时胶水（打印入口 URL、提供 webApp）
  scripts/
    sync-from-upstream.mjs   从已安装 release 派生组合
    check-composition.mjs    断言结果仍然是个大脑
    embed-into-rnh.mjs     把整包嵌进插件
```

### 连接状态机

`probe → install（版本不符才装）→ provision（brain bundle + profile 清单 + 配置）→ start → verify`。最后一步是必须的：verify 会真的发一次 `session/list`，**只有它成功才报 connected**。少了这一步，"进程起来了但会话通道不通"会伪装成成功。

provision 阶段内部顺序也是语义的：**组合先于启动**（profile 必须已经指向 brain bundle）、**配置先于启动**（模型行必须已在盘上）、**凭据晚于启动**（只能通过节点自己的 Remote API 推，需要它已经在应答）。

**失败时 phase 不清空，而且要分类。** 原来 `catch` 里把 `runtime.phase` 抹成 `undefined`，于是「解包运行时失败」和「SSH 握手失败」在界面上长得一样：一行红字加一个重试按钮 —— 而重试按钮只对其中一种有意义。现在两件事：

- phase 保留，所以 `PhaseList` 能停在失败的那一格上；
- `classifyFailure(error, { phase })`（`src/core/errors.js`）给出 `{ code, message, action, retryable, detail }`。判定顺序是**显式 code > SSH category > phase 推断 > unknown**，越具体越优先。`action` 是一个封闭集合（`fix-credential` / `review-host-key` / `check-network` / `retry` / `upgrade-node` / `upgrade-desktop` / `reinstall` / `inspect-log`），客户端把它翻成按钮；`retryable` 是**关于原因的事实**，所以密码错不配重试按钮 —— 按了只会得到同一次失败。`offline/errors` 套件（88 项）守住这四条以及下面日志的脱敏。

### 断线要看得见，重连要成阶梯

在 2026-11-19 之前，SSH socket 掉了之后 `state` **一直是 `connected`**：`SshConnection` 清掉自己的 client 就完事，没有任何人被告知。后果是卡片一直是绿的、侧栏还列着那台机器的工作区，而任何调用都回 `rnh/node-offline` —— 一个界面上从未出现过的状态。`disconnect()` 和 `invalidate()` 也会触发 `close`，所以「主动断开」和「掉线」必须分开：`#ending` 这个 WeakSet 记下自己主动结束的 client，只有不在其中的 `close` 才算掉线。

掉线后的阶梯是 `2s / 4s / 8s` 三次，之后每 **2 分钟**，直到成功或用户点「断开」。实测：`systemctl restart ssh` 两秒回来（第一档就成），整机重启 21 s 回来（落在第三或第四档）。阶梯期间**不报错**：状态是 `idle` + `droppedAt`，卡片写「已断线，正在重连」。用户点断开是唯一「别试了」的表达，所以 `disconnect()` 先取消定时器。

**工作区行在掉线时保留。** 原来 `RemoteWorkspaces.sync()` 只要节点不在 `routable()` 里就把整份 baseline 丢掉 —— 于是断线那一刻侧栏里整台机器的工作区消失，一分钟重连成功后又回来，读起来就是「我的东西没了」。现在只有**记录被删**才丢行；只是连不上时行留着并标 `offline`（`nodeStates()` 能区分「这台机器没有工作区」和「这台机器现在不应答」）。

### 主机密钥：首次记录，之后每次都验

`SshConnection` 的 `hostVerifier` 从写下的第一天起就在读 `target.hostFingerprint`，但**全仓库没有任何地方给它赋过值** —— 于是 `expected` 永远是 `undefined`，每次都走「首次」分支并 `verify(true)`。也就是说这条链是死代码，中间人可以无条件接管连接。

现在：`NodeRecord.hostKey`（`SHA256:…`，OpenSSH 形式）在首次握手时由 `Rnh.#recordHostKey` 写进注册表，`#runtimeOf` 每次把记录里的值同步给已有的 `SshConnection`（否则重连时还在看 `undefined`，每次都是「首次」）。之后每握手比对一次，不符则拒绝并把两侧指纹写进该节点的日志。

这是 **trust-on-first-use**，不是完整的主机身份验证：首次连接仍然可能被中间人。它买到的是「之后每一次都可证明」，以及「密钥变了要人来确认」——插件不会自动接受新密钥，也没有忽略开关。`SECURITY.md` 里写明了这个局限。

### 节点自带日志

`ctx.logger` 写的是桌面端的总日志，出了问题的人找不到它，找到了也被别的节点和插件混在一起。所以每个 `NodeRuntime` 还有一个 `NodeLog`（`src/host/node-log.js`）：最近 100 行，带 ISO 时间戳与级别，**写入时脱敏**（不是读取时——已经存下来的东西已经泄露了），路由是 `/rnh/api/nodes/<id>/log`，卡片上可展开、可复制。

脱敏规则有顺序要求：`Bearer` 那条必须在 `key=value` 那条**之前**。反过来会让 `Authorization: Bearer abc.def` 被 `authorization` 规则吃掉前一半、把 token 本身留在行里 —— 实测就是这个结果，`offline/errors` 里有一条断言守着它。

### 一次 exec 就是一个 SSH 包：命令行不能装 payload

ssh2 发一次 exec 请求时**不切包**：`Protocol.js:1273` 的 `alloc(1 + 4 + 4 + 4 + 1 + 4 + cmdLen)` 说明整条命令就是单个 `SSH_MSG_CHANNEL_REQUEST` 包，多大都一样。而 OpenSSH 的 `PACKET_MAX_SIZE` 是 256 KiB。超了以后服务端**不回错误**：它按错位的长度继续读，接着每个包都被当成垃圾 —— 日志里是 `Bad packet length <某个数>` 紧跟 `Connection corrupted`，客户端看到的是连接自己断了。

这条踩过一次，代价是一整轮 e2e 全红：`writePluginBundle` 把整棵插件树 base64 之后拼进命令行，`dsh-whale-widget` 在磁盘上 5.9 MB，拼出来 **7,923,386 字节**，而节点日志里反复出现的 `7923616` 就是这个数（差 230 字节 = 脚本尾部）。单连接量出来的边界正好在 256 KiB：

| 命令行长 | 结果 |
|---|---|
| 262,000 | 干净 |
| 262,200 | 6 条连接全坏 |
| 同样内容走 stdin（300 KB / 7.9 MB） | 干净 |

所以规则是**payload 走 stdin，命令行走 argv**。stdin 是 channel-data，按协商的 `packetSize`（32 KiB）分片，多大都不成一个超大包；`writeBrainBundle` / `writePluginBundle` 的树就是这么过去的。同时 `SshConnection.exec` 有一道本地闸门 `MAX_COMMAND_BYTES = 128 KiB`，超了就在本地抛 `SSH_FAILURE.PROTOCOL` —— 本地报错是调用方唯一能处理的结果，服务端给的是一次掉线。`offline/packet` 套件钉住这两条。

顺带一个同类的坑：`pkill -f` 匹配的是**任意命令行**，所以 `RemoteHost.stop()` 兜底脚本里的模式会匹配到执行它自己的 `sh -c`（argv 里就带着这个模式），把自己杀掉、channel 无退出码。实测普通模式 `{"out":"","code":null}`、`bin[.]js` 这种加方括号的 `{"out":"SURVIVED","code":0}`，而对真正的 resident host 依然匹配（节点上 2 个变 1 个）。凡是 `pkill -f` 的模式里出现自己的字面量，都要这样打断它。


### 开机自动连接：先取凭据，再判断

`autoConnect` 曾经是这个形状：遍历记录 → `if (!runtime.credentialsReady()) continue` → `connect()`。看起来是"没有凭据就别白连一次"，实际上**每次开机都一个都连不上**：`runtime.secret` 只由 `put()` 和 `connect()` 填充，刚构造出来的 runtime 一律是"没有凭据"，于是这个 `continue` 把每个节点都跳过了。实测症状：重启后设置页全显示「未连接」、侧栏里一个远程工作区都没有 —— 和「插件坏了」完全无法区分；而手动点「连接」就能连上，那正是 autoConnect 要省掉的动作。

所以顺序必须是**先 `#adoptSecret()`，再判断**：凭据是开机时的状态，不是连接时才知道的东西。读凭据失败只记一行日志并跳过该节点（`connect()` 自己还会再取一次并抛出命名错误），一个坏掉的凭据库不该把整个循环带走。`test/autoconnect-unit.mjs` 用内存注册表 + 内存凭据库守住这四条：有凭据就连、没凭据不连、禁用的不连、凭据库抛错不外泄。

---

## 六之二、节点侧：源码级定制组合 + 自建运行时

### 问题

节点的常驻宿主是一个**独立的 DSH 安装**（`npm i @deepseek-ai/dsh`），有自己的 `~/.dsh`：自己的 profile、自己的凭据库、自己的模型名册。这带来两件事：

1. **它装的是 web-app 组合**，等于在服务器上加载一整套浏览器插件 —— 56 个 `dsh-client-ui-*` 包、SPA dist 服务、HMR 链、桌面 telemetry。没有窗口的机器上，这些要么空转，要么在缺 dist 时直接报错。
2. **它没有 provider 路由、没有 API key**，所以能启动、能答 `session/list`，然后**第一句话就失败**。从桌面端看，这和"路由坏了"长得一模一样。

### 决定：定制**组合** + 自建**运行时**

节点侧的定制分两层，一层决定**加载哪些行**，一层决定**那些行的代码从哪来**。

**层一：组合层，不 fork 包。** 这是本节最初的取舍，仍然成立：

上游发布的 6 个 bundle 是：`base`（核心，无 Host）、`web-app`（核心 + 浏览器面）、`headless`（一次性任务，无 Host/HTTP）、`acp-app`、`sdk-app`、`sdk-minimal`。**没有一个是大脑**：唯一带 Host + HTTP + Remote API 的是 `web-app`，而它同时带着整个浏览器面。

| | 直接改官方包的源码 | **定制组合层（采用）** |
|---|---|---|
| 节点上装什么 | 自己改过的 `@deepseek-ai/dsh-*` | 官方包 + 一个本地 bundle |
| 删 UI 的彻底程度 | 物理删除 | 组合层不含该行 → **根本不加载** |
| 出问题的样子 | 编译错或运行期缺符号 | 组合缺行 → 启动时明确报 "entry did not activate" |

关键认识：**"删掉"不等于"物理删代码"**。DSH 是 Cordis 组合式架构，一个插件是否存在于运行时完全由 profile 的组合层决定。组合层里没有 `@deepseek-ai/dsh-client-ui-*` 这些行，那些包连 `import` 都不会发生 —— 效果等价于删除，但可逆、可跟随升级。

所以节点侧是一个新包 **`@local/rnh-brain`**，它是一个合法的 DSH bundle（声明 `dsh.bundle.patch`），内容是 `dsh-web-app` 减去浏览器面。节点 profile 组合：

```
@deepseek-ai/dsh-base + @local/rnh-brain      ← 现在是这个
@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app    ← 之前是这个
```

`dsh-web-app` 这一层根本不出现在组合里，不是"加载后再 disable"。

**层二：运行时自建，从 fork 编译。** 组合层能决定加载哪些行，决定不了那些行**里面的代码**，也决定不了磁盘上有哪些包。所以节点跑的那棵树由本项目自己构建（详见 [`adr-0007-fork-node-runtime.zh.md`](adr-0007-fork-node-runtime.zh.md)）：

| | 上游发布版（ADR-0006） | **自建运行时（采用）** |
|---|---|---|
| 节点跑什么 | `npm install` 出来的官方树 | 本项目从 fork 编译的树 |
| 树里有什么 | 上游装出来的一切（含 62 个浏览器包、339.5 MiB Office 引擎） | 只留大脑需要的，再删包内无人读的字节（build 4 实测 2014.6 → 408.6，build 8 是 415.9 MiB —— 它比 build 7 大的唯一原因是 Office 引擎（145.3 MiB WASM）回来了） |
| 拿不到制品 | 落 npm，慢一点但能连 | **报错**，逐条列出试过的 URL |
| 上游发新版之后 | 节点自己就跟上了 | **本项目要重新编译并发版** |

这两层不重叠：组合层是"要哪些行"，运行时是"那些行从哪来"。**后者的代价写在明面上** —— 跟着上游从自动变成手动，这是为了换来对节点运行时的完全控制。

### 怎么减：从**已安装的 release** 派生，不是从 master

`web-app` 的 patch 是 **621 行 / 123 行 insert**（实测 `0.2.2-rc.3` 的 `cordis.patch.yml`），手抄会腐。所以 `packages/rnh-brain/scripts/sync-from-upstream.mjs` 做这个减法并生成 patch：

- **keep**：全部 host-plane 行 —— Remote 控制器（session/workspace/workspaceFiles/job/terminal/settings）、传输层（webserver、`/api`、launch token）、服务（workspace、schedule、mcp-manager、agent-preset-registry）、`web-startup`。
- **drop**：全部 `@deepseek-ai/dsh-client-ui-*` 包的行（节点没有窗口；按**包名**判断，实测 56 行 —— 其中 `entry-customization` 的 id 不以 `ui-` 开头，只按 id 前缀过滤会漏掉它），加 9 个浏览器专属行，每个在脚本里写明理由：

  | 行 | 为什么大脑不要 |
  |---|---|
  | `web-runtime` | 挂 SPA dist、开桌面浏览器 —— 换成 `brain-runtime` |
  | `modules` | 组装 `window.__DSH_BOOT__`、serve `/plugins/*/client.js` |
  | `client-hmr` | 浏览器热更链 |
  | `harness-dev-context` | 提示词里写"你正在扩展这个 GUI" —— 没有 GUI |
  | `directory-picker` | 在节点的屏幕上弹原生目录框 |
  | `open-in-app` | 在节点上启动桌面应用 |
  | `session-log-download` | 浏览器下载对话框 |
  | `product-analytics` / `desktop-product-telemetry` | 桌面端遥测 |

- **公式化的两条**（不手抄，从上游读）：`system-prompt` 与 `session-query-sqlite` 两个 surface 值；以及 agent plane 的 22 条 `disabled: true`（大脑的 Session 和桌面一样通过 preset 挂工具，所以基础层的工具行必须同样让位）。后者是**真的 disable**，因为它指向的行都在 `dsh-base` 里存在 —— 与"disable 一个不存在的 UI 行"性质不同。

**为什么必须从已安装的 release 派生**：第一版从 master 生成，多出了一行 `authentication-token`。而 `0.2.2-rc.3` 根本没有发布 `dsh-host-authentication-token` 这个包，节点启动报 `1 entry did not activate: Cannot find package '@deepseek-ai/dsh-host-authentication-token'`。master 领先于发布版，组合必须描述它要**启动进去的那个运行时**。现在脚本默认读 `DSH_INSTALL_DIR`（已安装），checkout 只作为对照手段。

### 大脑自己的运行时胶水

`web-runtime` 被拿掉后，少了两件事，而它们都直接影响插件能否连上：

1. **打印入口 URL** —— 插件**解析端口和 launch token 的唯一来源**。
2. **认领 index fallback 座位** —— cookie 交换发生在这里。`/?token=…` 由 `connection.authorizeIndex` 换成一个 303 + `Set-Cookie`；没有这个座位，请求会落到一个**没有 fallback** 的 webserver 上，得到 404。

第 2 条是这块最容易被漏掉的一环，因为它失败的样子极具误导性：`/api` 本身完全正常，但任何一个"先拿 URL 再换 cookie"的客户端都会在第一步就拿到 404，看起来像"节点没有 Remote API"。

所以 `@local/rnh-brain/runtime` 做三件事：

- 提供 `webApp` 服务（Host 契约的一部分，其它行会读）；
- 等 Loader 组合完成后，用 `connection.authenticatedUrl()` 打印 `dsh web: <url>`，格式与本机桌面端解析的那一行完全一致；
- 用 `webServer.registerFallback` 认领 index 座位：入口路径走 `connection.authorizeIndex`，其余未匹配路径 404；
- **不挂** `frontend-static`（没有 dist 可服务）、**不开**浏览器。

还有一条 Cordis 的硬约束：`inject` 必须声明插件读取的每一个服务。漏了 `webServer` 会在插件体里抛 `cannot get property "webServer" without inject`，而如果抛出点在 promise 链里，症状是**宿主启动、端口在听、一行不打印** —— 就是这个模块第一次写完时的样子。

### 传送链路：生成物，不手改

```
packages/rnh-brain/
  cordis.patch.yml            ← 生成物（98 行上游 → 60 行大脑）
  presets/*.patch.yml         ← 原样复制（大脑的 Session 也要有 standard preset）
  src/runtime.js              ← 手写：唯一的大脑专属代码
  scripts/sync-from-upstream.mjs   ← 做减法并生成上面两者
  scripts/check-composition.mjs    ← 断言结果"仍然是个大脑"
  scripts/embed-into-rnh.mjs     ← 把整包嵌进插件
        ↓
packages/dsh-remote-node-harness/src/host/brain-bundle.generated.js   ← 生成物（字符串常量）
```

**为什么嵌进插件而不是运行时读路径**：插件跑在 DSH 自己的安装里（桌面构建里是 `app.asar` 内部），不能假设 `rnh-brain` 这个包在同一块盘上。嵌入后没有运行时路径假设。

节点上落到 `~/.dsh/profiles/rnh/node_modules/@local/rnh-brain/` —— **profile 自己的 `node_modules`**，因为 Loader 解析一行 `name` 时的 profile 拦截层就是它。

### 幂等与顺序

`connect` 的 provision 阶段现在做四件事，前三个都在宿主启动**之前**：

1. `writeBrainBundle` — 按 path+content 的 sha256 判断是否要重写；一致就跳过（实测第二次返回 `{changed:false}`）。
2. `writeProfileBundles` — 只在 bundle 列表不同时写 profile manifest。
3. `writePatch` — 模型行 + 权限预设，写进节点自有 profile 的 patch（下节）。
4. 启动，`patchChanged = 任一为真` 时重启。

### 职责切分：谁拥有什么

这一节是上一轮返工的直接产物 —— 三个地方曾经各写一半，导致"哪份才生效"要靠猜。

| 关注点 | 唯一拥有者 | 载体 |
|---|---|---|
| 节点跑哪些插件 | `packages/rnh-brain` | profile 的 `dsh.profile.bundles` |
| 节点的模型名册与权限预设 | `host/provision.js` | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| 节点的 API key | `host/provision.js` | 节点凭据库（经节点 `credentials/set`） |
| 节点上的 DSH 版本 | `remote/daemon.js` | 下载 Release 制品（`dsh-<ver>-<platform>.tar.gz`）替换 `runtime/`，见 §六之四 |

**overlay 里不再出现 `disabled: true`。** 它曾经写过 56 条禁用浏览器行的 patch，但组合层已经把那些行全部去掉了 —— 于是这 56 条指向不存在 id 的 patch 是纯空转。更糟的是它掩盖信号：如果哪天某个 UI 行真的出现在节点组合里，正确反应是"组合错了"，而不是"悄悄把它关掉"。实测确认 `applyPatches` 对不存在的 id 只发一条 `ctx.logger.warn("patch: entry %C not found")` 然后跳过 —— 也就是说这类空转 patch **在正常输出里根本看不见**，是纯粹的静默噪音。

真正需要 `disabled: true` 的只有 agent plane 的 22 条，它们在 `dsh-base` 里确实存在；那份清单属于组合层，不属于 overlay。

### 模型与凭据：节点自有 profile 的 patch + Remote API

组合层决定"有哪些插件"，但不决定"模型是什么、key 是哪把"。这两件事由本机驱动，并且**不只是连接那一刻**：

1. **配置**（`~/.dsh/profiles/rnh/cordis.patch.yml`）：从活的 `configEditor.configuration()` 复制 provider 路由、默认模型、权限预设。账号登录型 provider 不复制（那是本机的登录态）。这是**插件自有 profile** 的配置层，节点宿主会热重载它 —— 改配置不需要重启宿主。
2. **凭据**：那些行点名的 `apiKeyEnv` 在本机 `credentials.resolve()` 取值，通过节点自己的 `credentials/set` 写入节点凭据库。key 的 ref 不只从 `apiKeyEnv` 取 —— 那字段只有显式设置过才在组合后的 patch 里；没设时用 adapter 默认值（`llm-deepseek-api-key` → `DEEPSEEK_API_KEY`），否则会得到"provider 加载成功但没有 key"的节点。
3. **跟随**：本机订阅自己的 `app-boot/config-reload`（`configEditor` 每次写配置后 emit）与 `credentials/reference-updated`，把 `syncConfig()` 派给所有已连接节点。两次事件可能连续来，所以合并到 250ms 的定时器上，避免读到只应用了一半的组合。

`connect` 在 `provision` 里报告：`rows` / `refs` / `composition{bundle, files, changed}`。

#### 为什么不是 `--patch` overlay（实测过一次，推翻了原来的设计）

`--patch` 传入的覆盖层**不在 HMR 的监视列表里**。上游 `dsh-hmr` 只 watch 两个路径：`profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`。所以 overlay 方案有两个无法回避的缺陷：改配置要重启宿主、且只在连接时同步。

节点上逐条验证过（`docs/adr-0001`）：

| 实验 | 结果 |
|---|---|
| 往 overlay 里加一行指向不存在包的行 | 进程不变、日志零新增 —— 确认不被 watch |
| 往 `profiles/rnh/cordis.patch.yml` 写 3 个模型（原子 `mv`） | 8 秒后 `session/modelCatalog` 返回它们，**PID 不变** |
| 用 `>` 原地改写同一个文件 | 同样生效（chokidar + `awaitWriteFinish` 两种写法都收得到） |

换到自有 profile 还顺手解决了一个所有权问题：`web` 是上游的 profile，插件不该和别的东西抢同一个 `cordis.patch.yml`。现在 `~/.dsh/profiles/rnh` 完全属于这个插件。

同期验证了真实链路：本地把 `reasoningEffort: high` 改成 `max` → 8 秒内节点 profile patch 里就是 `max`，节点 PID 不变；改回 `high` 同样跟着回来。

### 验证

- `scripts/check-composition.mjs`：断言 7 个 Remote 控制器行在、4 个传输行在（`webserver` / `connection` / `api-remotes` / `web-startup`）、`brain-runtime` 在、`web-runtime` 不在、没有任何 `dsh-client-ui-*`、agent-plane 的 6 条关键 disable 在（组合层里一共 22 条，这里只钉「少了就一定挂」的那 6 条）、4 个 preset 文件都存在且被声明、整份 YAML 能解析。
- 实测（192.168.x.x，DSH 0.2.2-rc.3）：`base + brain` 组合启动成功并打印 `dsh web: http://127.0.0.1:…?token=…`，五个端到端测试全绿。

`check-composition` 里的传输行**故意只列 4 条而不是 5 条**：早期版本断言过 `authentication-token`，而 `0.2.2-rc.3` 没有发布那个包 —— 一个契约测试必须测**这个 release 的契约**，不能测记忆里的契约。launch token 由 `connection.authenticatedUrl()` 提供，所以 `connection` 那条才是必须的。

### 遗留的一处真实风险

组合层的行 id 是上游的内部命名（`session-controller`、`workspace-files` …）。上游重命名一行，本包的 patch 就会指向一个不存在的 id。

**上游对此是静默的**：`applyPatches`（`@deepseek-ai/cordis-plugin-include`）在 `entryMap.get(id)` 落空时只调 `warn("patch: entry %C not found", id)`，然后 `continue`；该 warn 走 `ctx.logger.warn`，正常启动输出里看不到。所以"组合少了一行"不会以任何显眼方式失败，节点会照常启动、照常答 `session/list`，只是那个端点不存在。

这就是 `check-composition.mjs` 存在的理由：把它变成**启动前的显式断言**，而不是靠运行期发现。

---

## 六之三、运行时契约与失败形态

### `/rnh/api` 的鉴权边界

`/rnh/api` 用 `kind: 'prefix'` 注册，**没有写 `auth` 字段** —— 而 webserver 的默认策略是 `auth ?? 'required'`，`required` 又要求 `webserver/authorize` 的 bail 给出 `allow` + 一个 Peer。这个 bail 由 `dsh-client-connection` 的 Host 半边实现：它检查 Host/Origin fence，再验 cookie。

所以这组管理端点和 `/api` **同一把锁**：没有 `?token=` 换来的 cookie 就是 401/403。这一点必须写下来，因为"我自己注册的 prefix 默认是不是开放的"是那种想当然就会错的问题。

### 凭据与状态存在哪

| 数据 | 位置 | 说明 |
|---|---|---|
| 节点记录（host/port/user/名） | `$DSH_HOME/rnh/nodes.json` | 插件自己的目录，不动 desktop profile 的任何文件 |
| 节点密码/私钥 | DSH 凭据库的 record：`dsh-remote-node-harness/n<id>` | 走 `ctx.credentials.modifyRecord`，序列化的读-改-写，所以"只换密码、保留私钥"是安全的 |
| 节点的模型配置 | 节点 `~/.dsh/profiles/rnh/cordis.patch.yml` | 插件拥有；每次连接重写，本地一改就重新下发（宿主热重载，不重启） |
| 节点的 brain bundle | 节点 `~/.dsh/profiles/rnh/node_modules/@local/rnh-brain/` | profile 自己的 `node_modules`（Loader 的 profile 拦截层） |

### 并发、超时、失败

- **每节点串行**：`Rnh.serial(runtime, action)` 把同一台机器的所有生命周期动作排在一条 promise 链上。两个并发 `connect` 不会各起一个宿主。
- **SSH 重试**：`MAX_RETRIES = 3`，指数退避从 `BASE_DELAY_MS = 400` 起；只对可重试分类重试（连接类），认证失败直接抛。
- **握手超时**：`READY_TIMEOUT_MS = 20 000`。
- **Gateway 401**：`RemoteGateway.call` 捕获一次 401 → 丢掉缓存的 cookie、重新铸造 → 重试一次。之后再 401 就报 `GATEWAY_FAILURE.AUTH`，不再循环。
- **节点不可达时**：`session/list` 等合并类端点**跳过**该节点而不是整体失败；侧栏少几行，而不是一条错误把整个列表干掉。

---

## 六之四、桌面与节点的版本对齐

### 两个版本，两种比法

节点是**独立安装**的 DSH，桌面插件也是独立发版的，所以有两个版本会各自漂移，而且它们的
容忍度不同：

| 漂移 | 断什么 | 判定 |
|---|---|---|
| DSH 运行时版本 | 节点的 Remote 描述符集就是路由 decorator 派发的目标；Session 日志格式、Gateway 线协议也跟着变 | 必须**完全相等** |
| 大脑构建版本（本插件的包版本） | 节点组合的哪些行存在 | 允许节点**落后**，不允许**超前** |

节点领先时拒绝连接，而不是"大概能跑"：那说明另一台更新的桌面已经配过这台机器，本机无法
预知它写了哪些行。判定与文案在 `src/core/version.js` 的 `decideGate`，它只回答"该做什么、
为什么"，安装由 `RemoteHost.install` 执行 —— 这样设置页能原样显示原因。

### 版本号说不清的事：打包规则

版本相等不代表树相等。运行时是本插件自己打的包，同一个 `0.2.2-rc.3` 可以用不同的裁剪规则
打两次。实测教训：一条 `/(^|\/)docs?\//` 的裁剪规则把 `yaml/dist/doc/directives.js` 也删了，
因为它在 `dist/` 下、名字像文档，其实是 `dist/compose/composer.js` 要 require 的代码。所有
从那个制品装出来的节点启动即 `MODULE_NOT_FOUND`，而版本闸门说"已是最新"，没有任何东西会来
修它。

所以安装时在树里写 `.rnh-artefact.json`（`RUNTIME_BUILD` 常量），连接时连同版本一起读；
stamp 不符或缺席就**重装**。改 `STRIPPED`、改归档布局、或改由谁来解析（见下节），都必须同时
bump `RUNTIME_BUILD`。戳的格式与它记录的第二个事实（`via`）在下节展开。

### 运行时从哪来：一条路，本项目自建的制品

节点拿到运行时**只有一条路**：下载本项目自己构建的制品。制品由
`scripts/build-fork-runtime.mjs` 从本仓库对上游源码的 fork 编译、裁剪、打包，再由
`scripts/publish-runtime.mjs` 发到 CNB 与 GitHub Release。节点下它，解到 `~/.dsh-remote-node-harness/runtime`。

**为什么从「上游发布版 + 两条路」改成「自建 + 一条路」。** ADR-0006 的两条路线解决的是**等待**：
上游发版之后没人打制品，节点就卡住。它没有解决**控制**：节点上跑的那棵树内容由上游决定，
本项目一个字节都改不了 —— 于是"节点不要浏览器面那 62 个包""节点不要 339.5 MiB 的 Office 引擎"
这些主张只能停留在组合层，磁盘上的包一个不少。完整理由与代价见
[`adr-0007-fork-node-runtime.zh.md`](adr-0007-fork-node-runtime.zh.md)。

| | ADR-0006（上游发布版，两条路） | 现在（自建，一条路） |
|---|---|---|
| 节点跑什么 | `npm install` 出来的官方树 | 本项目从 fork 编译的树 |
| 树大小（解包） | 957.3 MiB / 496 包 | **415.9 MiB / 25 266 文件**（裁剪 + 去残留，build 8；含 Office WASM 引擎） |
| 归档 | 165 MiB | **103.1 MiB** / 108 150 360 字节（build 8） |
| 下载 | 加速站 0.2–9.6 MB/s | **CNB 约 18 s**（实测 91 839 618 字节 17.6 s，build 4） |
| 拿不到制品 | 落 npm，慢一点但能连 | **报错**，逐条列出试过的 URL |
| 上游发新版之后 | 节点自己就跟上 | **本项目要重新编译并发版** |

**裁剪分三种粒度，别把它们混为一谈。** 包级（`DROP_RULES`，删 119 个包）、文件级
（`ARTEFACT_RESIDUE`，删包内文件）、**源码级**（`patches/node/*.patch`，改上游代码的行为）。
前两种是「删」，第三种是「改」，走补丁链 + 偏差台账，见
[`adr-0008-node-source-trim.zh.md`](adr-0008-node-source-trim.zh.md) 与
[`node-patches.zh.md`](../packages/dsh-remote-node-harness/docs/node-patches.zh.md)。
截至 build 6 源码级改动为 **0**：全部差异都在前两种粒度里。build 6 与 build 5 的归档
**字节完全相同**，只是安装脚本的可执行位规则变了（见下文「可执行位」一节）。
**build 7 起不再是 0**：两个上游缺陷（Team 写作用域警告、fork 子会话首轮无继承）以
`patches/node/0001`、`0002` 两条补丁落地，所以归档字节第一次因为「节点跑的代码不同」而变化。
两条补丁的改动范围、理由、验证与冲突处置写在
[`node-patches.zh.md`](../packages/dsh-remote-node-harness/docs/node-patches.zh.md)。

**「fork 只差台账里这几条」是断言，不是声称。** `build-fork-runtime.mjs` 在动手前跑
`checkForkBase()`：fork 的 HEAD 必须就是 `dsh-v<version>` 那个提交，或者它上面多出来的每一个
提交都在 `node-patches.mjs` 的 `BUILD_SIDE_COMMITS` 里（构建侧修复，归档里没有那段代码，
所以当不了补丁）；工作树只允许在**补丁覆盖的文件**上有差异，其余脏文件按路径报错。
两个方向都是同一次故障：归档不再等于台账。`test/fork-base-unit.mjs` 用临时仓库把三种情形
（未入账提交、手工改过的文件、没打 tag）各断言一遍，并顺带跑一次真 fork。

**文件级裁掉的四类死字节，每一类都是先量后删。** build 4 的归档 408.2 MiB 里，
`src/**.ts` 91.9 MiB、`.d.cts` 22.7 MiB、无人读的 `.md` 5.3 MiB、Windows 调试符号与
跨平台 prebuilds 28.4 MiB。删的依据不是「看起来像垃圾」：

| 类目 | 为什么是死的 | 怎么验的 |
|---|---|---|
| 非声明 `.ts`/`.tsx` | 运行时加载 `lib/*.js` | 1 207 个 manifest 里，`main`/`bin`/`exports` 的 `import`·`require`·`default`·`node` 条件**无一**指向 `.ts`；`types` 与 zod 的 `@zod/source` 这类自定义条件指向 `.ts`，但那是打包器/类型检查器读的。全树没有一条 `import … './x.ts'`，也没有一处把 `.ts` 当数据读 |
| `.d.cts` | 声明文件 | 原规则只写了 `.d.ts`/`.d.mts`，漏了 `.cts` |
| 无人读的 `.md` | 文档 | 全树搜 `readFile…new URL(…'.md')` 与 `join(…, 'SKILL.md')`，命中 5 类目录形状（`skills/`、`assets/`、`references/`、`templates/`、`SKILL.md`），其余 601 个无读者 |
| `.pdb` 与跨平台 prebuilds | linux 归档里的 win32/darwin 二进制 | `node-pty` 用 `prebuilds/${process.platform}-${process.arch}` 拼路径，六个目录只有一个可能被加载；build 4 里 23.2 MiB 的 prebuilds 只对应 0.07 MiB 可达字节 |

**`@deepseek-ai/dsh/docs/` 是唯一一处「没有代码读、却必须留」的例外。** 481 个文件、
4.66 MiB。`dsh-doc` skill 在节点组合里（`skill-filesystem` 的 `customSkillDirs` 指向
`@deepseek-ai/dsh-agent-preset`），它的 `references/locate-docs.md` 直接让读者打开
`DSH_INSTALL_DIR/docs/user/index.md` 与 `docs/upgrade-guide/`。路径写在散文里，
`import`/`readFile` 扫描看不见 —— 第一版规则把 481 个全删了，skill 指着一片空。
**能力留着，它引用的东西就得留着。**

**A/B 是裁剪规则的验收方法。** 同一份大脑组合，分别喂 build 4 与 build 5 的树，
逐个端点比应答：`session/list`、`session/create`、`session/page`、`session/search`、
`workspace/create`、`terminal/shells`、`terminal/list`、`schedule/list`、`schedule/catalog`、
`skill/list` —— 10 个端点，状态码与响应体**逐字节相同**，差 0 个。删掉 16 808 个文件
没有改变任何一个回答，这才是「删的是死字节」的证据。

**判据只有一条：拿不到 ≠ 拿到的是坏的。**

| 情形 | 现在 | 为什么 |
|---|---|---|
| CNB 拿不到 / 没有 `curl`、`wget` / 平台打不出标签 / 没配源 | 报错，列出试过的 URL | 没有第二条路可落。这是 fork 路线的代价，写在明面上 |
| 校验和不符、解包失败、归档里没有 `node_modules/@deepseek-ai/dsh/lib/bin.js`（退出码 4/5）、解包后某个直接 spawn 的二进制没有 `+x`（退出码 7） | 回滚 + **抛错** | 字节到了但是错的。重试同一个坏源只会更慢、还把「哪个源坏了」掩盖 |

**为什么连 npm 兜底也删了，而不是留着当保险。** 那条兜底装的是**上游发布版**，而且写的是
同一枚 `{"build":4,"via":"npm"}` 的戳。于是一个走了兜底的节点会被判成「可用」，此后再也不会被
换回 fork 树 —— 一次网络抖动就把节点永久钉在上游版本上，而界面显示「已就绪」。留着它比删掉它
更危险，所以 `RUNTIME_ROUTES` 这个常量也一起没了：只有一条路时，「路线」不是一个概念。

**制品必须按平台分。** DSH 不是纯 JS：`node-pty`、`sharp`、`sherpa-onnx`、`koffi` 带原生二进制，
安装树里就写着平台（`sherpa-onnx-win-x64`、`@img/sharp-linux-x64`、`@koromix/koffi-linux-x64`）。
把 Windows 的树解到 Linux 节点上，节点能起来，但终端和图片工具会在第一次使用时炸 ——
比它替代的慢安装更糟，因为失败得更晚、离原因更远。所以构建脚本用 npm 的
`--os/--cpu/--libc` **为目标平台解析**，按 `--platform` 的目标值给（`linux-x64`、
`win32-x64`、`linux-x64-musl` 等）。

**但「能打标签」和「会发布」是两件事，只有 `linux-x64` 属于后者。** 名单在
`src/remote/artefact.js` 的 `PUBLISHED_PLATFORMS`，`publish-runtime.mjs` 在动手上传前先查它，
不在名单里就直接抛错 —— 两个入口（fork 构建与 CI）共用一个上传器，所以这条闸门只有一处。

- **`win32-x64` 是删掉的那个，删得有理。** 它能构建、也能启动（实测：解包后打印
  `dsh web: <url>`、换 cookie、`POST /api/session/list` 200），但**没有任何节点能向它要**：
  `platformTag()` 没有 Windows 拼写（探针读 `uname -s`，Windows 上是 `MINGW64_NT-…` 或什么都没有）；
  节点侧 21 处 `sh -c`（探针、安装、启停、写 profile、读状态）、`setsid nohup` 拉常驻进程、
  `/lib/ld-musl-*` 探 libc；传输只有 SSH。留着它就是 85 MiB 没人取的资产加一行让人以为
  「Windows 也能当节点」的 release 说明。本地不加 `--publish` 仍可构建，那是冒烟测试的路。
- **`linux-arm64` / `darwin-arm64` 从来没发过**，也没机器验过。它们能打标签，节点会得到一个
  诚实的 `ARTEFACT_UNAVAILABLE` 并列出击过的 URL —— 那是正确行为，不是缺口。

**Linux 还要按 C 库分，而且这件事现在由节点的 `uname` 决定。** `koffi` 与 `sharp` 同一个包名
下同时发布 glibc 与 musl 两套二进制，加载器按它运行的那个 libc 挑 —— 把 glibc 树给 Alpine 节点，
失败落在第一个用到它的工具上，而不是安装时。所以 `platformTag()` 对 Linux 的 musl 机器返回
`linux-x64-musl`（探测两路：`ldd --version` 与 `/lib/ld-musl-*`，任一命中即 musl）。
这条以前是 npm 路线的 `--libc=musl` 顺手保证的，路线删掉之后必须由制品名承担 ——
否则 musl 节点会去下一个从没人构建过的 `linux-x64`，装起来「成功」，用起来崩。
**只发 `linux-x64` 时，Alpine 节点会明确报「没有这个平台的制品」**，那是正确行为。

**装完要留痕，否则每次连接都重装。** 安装写 `BUILD_STAMP`（`.rnh-artefact.json`），
内容是 `stampJson()` 的 `{"build":N,"via":"artefact"}`。`via` 只上报、不参与判定，
`build` 参与判定：`inspectRuntime` 要求它等于 `RUNTIME_BUILD`。没有这一枚戳，`inspectRuntime`
会把树读成「早于构建戳」→ `decideGate` 返回 `node-runtime-repack` → **每次连接重装一次**。
`parseStamp` 仍认旧格式的裸整数（现场节点的 `2`），格式升级不能把在用节点判成不可用。

**`RUNTIME_BUILD` 现在是 7。** 3 → 4 是 fork：树的内容变了（少了 500 MiB 包、多了 fork 的字节），
版本号表达不了这件事，只有戳能。4 → 5 是**包内裁剪**：包集合没变，同一个包里少了
TypeScript 源码、`.d.cts` 声明、调试符号与无人读的文档 —— 实测 408.2 → 268.4 MiB。
5 → 6 是**安装脚本**：归档字节完全相同，改的是解包后补可执行位的那一步。6 → 7 是**源码**：
两条节点补丁改了 `lib/` 里真正跑的代码，所以归档字节第一次因为「代码不同」而变。
**改 `ARTEFACT_RESIDUE`、改裁剪规则、改归档布局、改由谁来解析、加一条节点补丁，
都必须同时 bump**，否则老节点读到的戳是「当前」，它会一直跑旧字节 —— 实测过这条链：`doc/` 被
当文档删掉，`yaml/dist/doc/directives.js` 跟着没了，节点启动即 `MODULE_NOT_FOUND`，而闸门说
「已就绪」。

**可执行位是 `tar` 传不了的那一件事。** 实测 bsdtar 在 Windows 上给每个条目写
`-rw-rw-rw-`，`chmodSync` 在 Windows 上只剩 `100666`，`--owner/--group` 改了也没用 ——
打包机根本没有可写进归档的 mode。所以解包后补位这一步是**唯一**能修的地方，而且必须
在节点上做：已经发布的归档改不了。

**这一条曾经只补 `spawn-helper`，代价是整个文件检索能力。** 2026-11-21 在真节点上实测：
`@vscode/ripgrep-linux-x64/bin/rg` 到节点是 0666，`dsh-util-ripgrep` 按路径 spawn 它
且**没有系统 `rg` 兜底**，于是每次 `glob`/`grep` 都报 `ripgrep provider failure`，
而 `inspectRuntime` 判这棵树「in step」——坏得很安静。Linux 树里根本没有 `spawn-helper`，
所以旧规则在 Linux 上等于什么都没补。

现在的规则是**按形状**，不是按路径清单（清单会在下一次依赖升级时悄悄失效）：
`node_modules/<pkg>/…/bin/` 下的文件、按名字的 `spawn-helper`、按后缀的 `*.node`，
判定函数是 `isArtefactExecutable`（`src/remote/artefact.js`），**打包侧和安装侧共用同一个**，
两处不可能对「哪些文件是程序」有不同意见。`node_modules/.bin/*` 故意不匹配：那是 npm 给
shell 写的 shim，本运行时没有任何代码解析它（两个消费方都不出现 `.bin`）。

补位之后还要**验**：`installScript` 对 `bin/rg` 与 `bin/landlock-run` 逐个测 `-x`，
不通过就删掉 staging、`exit 7`（`ARTEFACT_NOT_EXECUTABLE`）、让调用方回滚 ——
在 `mv "$staging" "$runtime"` **之前**。补不上却不报错，就是又造一个「看起来装好了、
第一次搜索才炸」的节点。

**这一条改了 `RUNTIME_BUILD`（5 → 6），虽然归档字节一个没变。** 戳是唯一能触达
「已经装好、版本相同」节点的杠杆：`inspectRuntime` 见戳相同就直接复用，不 bump 就永远
不会去修真正需要修的那些节点。

**节点侧不硬拦 `engines`。** 上游 `0.2.2` 的四个 rc 全部声明 `engines.node: ">=24.9.0"`，
而现场节点是 Node v22.20.0、一直在跑 rc.3。制品路线从不读这个字段（它解包一棵树），
所以 `MINIMUM_NODE_MAJOR` 保持 22：**2026-11-19 已核实，依据见 ADR-0006 §四-2**。

安装脚本的其余硬约束（`src/remote/artefact.js`）：`set -eu`；`~/…` 要换成 `$HOME` 才能带引号
（否则会真的建一个叫 `~` 的目录）；下载器 `curl`/`wget` 二选一；校验和在下载时失败而不是首次
使用时失败；解压到 `runtime.incoming` 后整体 rename，失败回滚到 `runtime.previous`。

**发到哪：CNB 是唯一的下载源。** 加速站只能**前缀**一个 GitHub URL，表达不了 CNB 的路径形状
（`https://cnb.cool/<org>/<repo>/-/releases/download/<tag>/<file>`），所以 `artefactUrls()` 的
参数是「源对象数组」：`{kind:'template', template}` 填 `{version}/{platform}/{tag}/{file}`，
`{kind:'prefix', prefix}` 仍做拼接。`DEFAULT_SOURCES` **只有一条**：CNB。四个加速站前缀退成
`RETIRED_MIRRORS`（只作记录，不是候选），`mirrors` 配置项删除 —— 没有第二个源时，「换加速站」
这个旋钮是空的。`{kind:'prefix'}` 这种源仍然支持，所以接一个私有镜像是一个配置值，不是一次改代码。

**为什么不是「CNB 在前、加速站在后」。** 因为加速站每一个都实测过抖动：同一个归档、同一台节点，
0.2–9.6 MB/s，**40 倍**。一张列表里排着已知会抖的条目，只会把「一个失败」变成「一串慢失败」。
而用户的现场条件更直接：**国内节点连不上 GitHub**，加速站是给 GitHub 加速的，所以它们连理论上的
用途都不成立。GitHub Release 仍会收到同一份字节（`--publish`，灾备与留档），但**节点不从那里取**。

| 源 | 完整 91 839 618 字节耗时 | 吞吐 | 抖动 | 现在 |
|---|---|---|---|---|
| CNB（公开仓库，匿名 302 → `asset.cnb.cool`，Range/206） | 17.6 s | ~5 MB/s | <1% | **唯一的源** |
| `git.yylx.win` / `gh.inkchills.cn` / `tvv.tw` / `ghfast.top` | — | 0.2–9.6 MB/s | 40 倍 | 已退役 |
| 直连 GitHub（**从来不是候选**） | 1.8 小时（165 MiB 时实测） | ~27 KB/s | — | 不适用 |

`github.akams.cn` 是这些替代站的**汇总目录，不是代理**：`https://github.akams.cn/https://github.com/…`
回 404。留在这里是因为接私有镜像时仍要从那里找域名。
`artefactUrls()` 因此接受 `sources`，为空时抛 `no artefact source configured`。
`version-unit` 断言了「只有一条候选」「它就是 CNB 且形状正确」「**没有任何一条以
`https://github.com/` 开头**」「空项不算候选」「空列表报命名错误」，并用桩连接跑
`RemoteHost.install` 证明拿不到制品**报错而不是落 npm**。

发布侧有四个实测撞过的坑，全在 `scripts/publish-runtime.mjs --cnb` 里：
`target_commitish` 必填且必须解析成提交对象（空仓库要先 push 一次 `main`）；重复建同名
release 返回 **409** 且响应体没有 id（要按 tag 再查）；**`PUT` 到预签名地址返回 200 不等于
附件已关联**，必须再 `POST` 一次返回里的 `verify_url`，否则 assets 一直为空、匿名下载 404；
`ttl` 最大 180 天、`0` 是永久。发布脚本最后会回读 CNB 自己算的 `hash_value` 与本地 sha256 比对，
不一致就报错 —— 「传上去了」和「传对了」是两件事。

**制品的构建搬到了 CI**（`.github/workflows/release-runtime.yml`）：各平台在本平台 runner 上
打包（`--platform` 认 libc 后缀，`linux-x64-musl`），打包与上传分成两个作业 —— 多条腿同时
`gh release create` 会互抢，且抢输看起来像打包 bug。**注意：CI 打包的是上游发布版，不是 fork**；
fork 路线的构建要在有 fork checkout 的机器上跑 `build-fork-runtime.mjs`（见 ADR-0007）。

**下载要有下限，也要有上限。** 旧脚本对 curl 只有 `--connect-timeout 15 --retry 2` —— 那只管
**建连**，不管**传输**。现在的判据是 `--speed-limit 4096 --speed-time 60`（低于 4 KB/s 持续 60 秒
就放弃这一路；全部候选挂掉就按 `ARTEFACT_UNAVAILABLE` 返回，由调用方报错）
加 `--max-time 1800`（慢但能用的线路仍有 ~100 KB/s 的完整预算）。两个数都是常量
（`FETCH_FLOOR_BYTES` / `FETCH_FLOOR_SECONDS` / `FETCH_CEILING_SECONDS`），`version-unit` 有断言守着。

### 每节点一份路径

两个节点记录可以指向同一台机器的不同 `remoteRoot` —— 这是测试第二个节点最方便的方式，也是真
实用法（主大脑旁边放一个实验性的）。所以 `REMOTE_LAYOUT` 从常量改成 `remoteLayout(root)`，
profile 名也按 root 派生（`~/.dsh-remote-node-harness` 仍是 `rnh`，`~/.dsh-remote-node-harness-b` 是 `rnh-b`）。用
常量时第二个节点会静默复用第一个的 runtime、常驻进程和状态文件，"连了两个节点"其实是一个节点
数了两遍 —— 实测过。Session 日志仍共用 `~/.dsh`：同一台机器上的两个 root 是两副大脑，不是
两台机器。

## 六之五、每插件同步开关

开关的单位是**插件（bundle）**，不是内部行。第一版把本机组合里的每一行都列成一行开关，实测 **207 行**：
那描述的是组合，不是选择 —— 没人「安装」`tool-result-pruner`，人装的是一个插件。现在一行一个
bundle，取自 profile manifest 的 `dependencies` 与 `dsh.profile.bundles`，`@deepseek-ai/*`、
`@greatbaby/dsh-remote-node-harness`、`@local/rnh-brain` 排除（前两类是产品本身，后一个正是「节点成为大脑」）。

### 默认全开，另有一份硬排除清单

`dsh-base` 是节点的底座，大脑 bundle 是它的减法，二者不是选项。其余插件默认**下发**：这台机器装了、
起了作用，节点就是同一个工作面的延伸。五个名字**永远不发**，写在 `NODE_NEVER_SYNC` 里而不是靠前缀
规则推断：

| 名字 | 为什么 |
|---|---|
| `@greatbaby/dsh-remote-node-harness` | 桌面端插件；而且它的「节点控制」预设里是增删节点的工具 —— 被控节点能控制别的节点，正是明确否定过的形态 |
| `@local/dsh-remote-node-harness` | 同一个包在 0.5.0 之前的名字。就地升级过的 profile 仍然列着它，「这是我自己的旧拼法」不是把它送去节点的理由 |
| `@local/rnh-brain` | 节点侧的减法本身，已经在列表里 |
| `ds-harness-remote` | 会让节点变成第二个中转 Host，多开一个入口 |
| `@dsh-remote/plugin` | 同上，旧包名 |

`isThirdParty` 的 `@deepseek-ai/*` 规则仍然保留：它回答「这是不是产品本身」，
和「这个不能进节点」是两件事。

开关打开的含义是「它也在那台机器上运行」，这一条要求真正能落地：

1. 在节点上 `npm install <name>@<本机 manifest 里的 spec>`（沿用本机的版本区间，两边同一个 release）；
2. 再写节点的 `dsh.profile.bundles`，顺序是 **base → 你打开的插件 → 大脑 bundle**（bundle 按列表
   顺序组合，大脑 patch 必须压在上游之上）；
3. bundle 列表变化是模块代码变化，常驻 host 必须重启，`syncConfig` 里就地重启并 `gateway.reset()`（旧 socket 看着可写，实则是尸体，不 reset 的话后续所有流都是空的）。

### 三个踩过的坑

**顺序**：`npm install` 会剪掉 profile `dependencies` 里没有的包，而大脑 bundle 是**拷进去**的
（不是 npm 装的），所以它当时算「多余」。实测：打开一个插件后 `node_modules/@local/rnh-brain`
被删，节点报 `cannot resolve profile bundle "@local/rnh-brain"`，常驻 host 起不来。因此
`writeBrainBundle` 必须排在 npm **之后**，connect 与 sync 两条路径都一样。

**peer 会把 DSH 自己拉进节点**：第三方 bundle 的 `peerDependencies` 写的是
`@deepseek-ai/dsh-*` 的区间（`dsh-pet` 写 `^0.2.0-rc.1`，`dsh-whale-widget` 同样），npm 满足
peer 的办法是**把那个包装进当前 profile**，而 profile 的 `node_modules/@deepseek-ai/` 在解析顺序上
压过运行时树。实测（`0.2.2-rc.3` 运行时）：装一个插件之后节点 profile 里多出 32 个
`@deepseek-ai/*`，其中 `dsh-session` / `dsh-agent` / `dsh-scope` 是 `0.2.0-rc.2`；常驻 host
报 `2 required plugins did not activate`、一行 URL 都不打，`connect` 报的是日志尾巴而不是节点。
所以 `installPlugins` 固定带 `--legacy-peer-deps`：**运行时树是这些包的唯一来源**，插件不许把
DSH 一起带来。这条不是可选的兼容开关 —— 去掉它，任何节点只要打开过一个插件就起不来。

**报告**：`npm install` 对一个列表是原子的，失败时无法安全地指认某一个包，所以失败就报「这一批都
没确认装上 + npm 最后四行」，不编造单包诊断。`POST /rnh/api/plugins/:bundle` 同步执行完再返回
每个节点做了什么；任何节点没接受就带上 `warning`，页面把节点原文显示出来 —— 一个显示「已保存」
而节点什么都没组合的复选框，正是这个界面要防的 bug。

### 状态存哪

存**profile 目录**里的 `rnh-plugins.json`，不是 `$DSH_HOME/rnh/plugins.json`：同一个 home 下
`desktop` 与 `rnhtest` 的插件集不同，存在 home 里会让一个 profile 的选择决定另一个 profile 的节点。
把开关拨回默认值**删掉那条记录**而不是存同值，这样升级改了默认值还能到达从没碰过它的用户。

### 节点的 profile patch 只管配置

`renderBrainPatch` 只写模型清单与权限预设。插件集不在里面 —— 一个 concern 一个写入者，否则
`disabled: true` 会成为「这个插件不在节点上」的第二种说法，两个答案就是节点组合出没人选过的东西的
来源。旧的 207 行开关正是这么写的（`- id: X` + `disabled: true` 进节点 patch，只写节点组合里真有
的行；曾让一台节点的 patch 堆了 59 条什么也没决定的条目），这条路径已删除。

## 六之六、加工作区：先选机器，再选目录

目标体验是「操作远程大脑和操作本地大脑一样，只有设置工作区这一步不同」，所以加工作区的流程是
**先选哪台机器，再在那台机器上浏览目录**，本地与远程共用同一个对话框。

壳（shell）自己的目录选择器浏览的是**本机**，永远选不到节点上的 `/root/project`。插件占用壳声明的
三个 `*.directoryFlow` 插槽（`sidebar.workspaces` / `conversation.hero.workspace` /
`workspace.picker`），用自己的对话框替换它：三个入口一次全覆盖，不用改壳里的任何一个调用点。
`props.onPicked(path)` 之后仍然是壳去建工作区，所以本地路径走原路，远程路径由 Host 半边的
`workspace/create` 装饰器按「绝对 POSIX 路径」路由到能看见它的节点。

浏览走 `GET /rnh/api/browse?node=&path=`：不带 `node` 读本机（`readdir`），带 `node` 读那台机器
（复用插件已有的 SSH 连接跑 `find -maxdepth 1`）。两边返回同一形状，页面只有一条渲染路径 —— 这
才是「和本地一样」的具体含义。不经过节点的 Harness，因为浏览目录是文件系统问题，而且那样会要求
节点先起来才能选它自己的目录。

### 一个对话框，四页，第三种叫法

第一屏是**表单**：项目名称 → 设备 → 源文件夹。设备不再是一个下拉：它是一个**字段样的按钮**，点开
「选择设备」页 —— 下拉装不下「添加远程设备…」这种动作，也装不下每台机器一行说明。

**设备页**（`page: 'device'`）一行一台机器：`此设备`，加每个已连接节点（名字 + `host · 节点根目录`），
末尾「添加远程设备…」进新增节点表单页（与设置页共用 `NodeForm`）。

**入口页**（`page: 'roots'`）回答「那台机器上从哪开始」，而且两侧的答案**故意不同**：选本机列出
`localRoots()` 探到的**盘符**（`C:\`、`D:\`…），选节点列出**那台机器的根**（`/`，由 `/browse?node=` 的
`roots` 返回）。把盘符列表给节点、或把 POSIX 根给 Windows，正是设备这一步存在的意义所在 —— 共用一份
列表就等于又把两侧混成一个。页脚保留「浏览全部目录」：直接进浏览页，落在那台机器的 home。

**浏览页**（`page: 'browse'`）不再有机器选择器（它在入口页），面包屑返回键回到入口页，标题是
`<设备> · 选择文件夹`，所以「我现在到底在看哪台机器」在每一页都写着。

把文件浏览器当第一屏读起来是「操作一个目录对话框」，先问名字才读成「创建一个项目」—— 这正是人来这里
要做的事。

**同一份表单在两处入口说两套词**，靠插槽名自己判断，不猜上下文：「新建会话」的两个入口
（`conversation.hero.workspace`、`workspace.picker`）说「创建项目 / 项目名称 / 创建」；侧栏加号
（`sidebar.workspaces`）说「选择工作区文件夹 / 工作区名称 / 加入工作区」。判断依据是注册时把插槽名
塞进 props（`origin`），因为组件本身拿不到自己被哪个洞注册。

设备页里，选了节点就多出一行「这台设备上已有项目？添加到侧栏 ›」，点开列出**那台机器上已有的
工作区**（按 `rnh_<nodeId>_` 前缀筛合并后的 baseline），点一条直接交接路径 —— 已存在的目录不必
再浏览一遍去找。这是 zcode 表单里那一行的等价物。

**每台设备记住上次用的目录。** 入口页在盘符/根之上多一行「上次使用 · `<path>`」，点一条直接带着
它回到表单。理由很直白：项目基本都在一个地方，「加一个工作区」几乎总是「把同一个文件夹再加一次」，
而每次都要走两级目录才回到原处是这个过程唯一慢的地方。按**设备**记，因为路径不能跨机器复用 ——
`/root/project` 在桌面端什么都不是。存在 `localStorage` 而不是节点记录里：它是一个只在这个浏览器
profile 里有意义的小便利，写进注册表会让每条节点记录都带一个只有 UI 读的字段；`localStorage` 在
某些隐私窗口里会抛，所以读写都包了 try —— 记不住路径的目录选择器仍然要能打开。

**设备列表按最近连接排，超过两个才给搜索框。** 想要的顺序不是字母序：常用的是刚连上的那台。
`lastConnectedAt` 由注册表在每次成功连接时写，所以这个排序不需要额外状态，也能跨重启。搜索框只在
两个以上才出现 —— 一个只有两台机器时还占一行的输入框，花掉的注意力比省下的多。

### 视觉口径：用壳的 token，不自己造型

对话框与设置页的颜色、圆角、阴影、字号全部取自前端 bundle 里真实存在的 `--dsw-*` 变量（
`--dsw-alias-bg-layer-*`、`--dsw-alias-border-l1..l4`、`--dsw-radius-*`、`--dsw-elevation-*`、
`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`、`--dsw-alias-switch-thumb`…）。**不变量 = 不渲染**，
所以每个写进代码的变量都先在 `index-*.css` 里确认过；`--dsw-shadow-lg`、`--dsw-alias-font-code` 这类
想当然的名字曾经静默回退成别的字体/没有阴影，已从代码里删干净。

图标与状态点用壳的 `@deepseek-ai/dsh-client-ui-primitives`（`IconFolderCloseRegular`、
`IconChevronLeftOutlineRegular`、`IconChevronRightOutlineRegular`、`IconChevronsUpDownOutlineRegular`、
`IconPlusOutlineRegular`、`StateDot`、`Button`），不再用 `📁 ▼ ‹ ＋` 这类字形：字形在别人的字体栈里长什么样不受控。该模块因此写进
`dsh.client.inject`（插件读取的每个服务都要声明，漏了就是 `cannot get property "X" without inject`），
而 `test/install-unit.mjs` 会核对客户端半边**只** `require` 声明过的产品模块名。

#### 页面骨架是量出来的，不是照抄样式表的

设置页的骨架照官方「插件」页做，但**依据是运行中的 DOM，不是别人 lib 里的 CSS 字符串**。
两页放在同一个 1400×1000 的视口里各量一遍，逐项对齐：

| 项 | 官方「插件」页 | 本插件「远程节点」页 |
|---|---|---|
| 页面根 | `padding: 0 48px`；`flex column; align-items: center` | 同 |
| 滚动列 | `width: calc(100% + 96px); margin-inline: -48px`；`padding: 0 48px 48px`；`gap: 32px` | 同（顶部 `padding-top` 由页头承担） |
| 页头 | 标题 `20px/28px 500`，说明 `13px/20px` secondary，`padding-top: 28px` | 同 |
| 内容列 | 子块 `max-width: 960px` | 同 |
| 卡片 | `card-head` gap 14 / padding 8；图标 48×48、`.5px` 边框、`radius-lg`；标题 `14px/20px 500` 单行省略；说明 `13px/18px` tertiary | 同 |
| 按钮 | 高 32、`radius-md`、`13px/20px` | 同 |
| 开关 | 36×20、`padding: 2`、`radius: 999px`、thumb 16、选中 `translate(16px)`、`transform .12s ease` | 同 |

三处曾真实踩到的坑：

1. **组标题被挤成竖排**。`groupHead` 是 `display:flex`，标题没写 `flex`/`white-space`，旁边一个
   会长的提示把它压到 23 px 宽，四个字竖着堆成 68 px 高。修法是标题 `flex: 0 0 auto; white-space:
   nowrap`、提示 `flex: 1 1 auto; min-width: 0` —— 官方样式表里没写这两行，因为它的标题在
   `groupHead` 里是唯一子元素；照抄别人的属性不等于照抄别人的结果。
2. **页面没有滚动条**。壳的 `centerCol` 是 `overflow: hidden`，页面比框架高就被**直接裁掉**，
   而祖先都不滚。所以页面必须自己 `height: 100%` 并把唯一可滚的孩子交给 `pageBody`
   （`overflow: hidden auto`），这是本插件唯一能决定这件事的地方。
3. **`max-width: 960` 不能加在页面根上**。官方把它加在**内容子块**上，页面根是满宽；加错一层
   会让滚动条跑到文字列里面。

节点上新建的目录、填的名称、选定的文件夹在交接前都还只是本页状态：**名称非空时先 `POST
/rnh/api/workspaces` 再交接路径**，因为目录选择洞只回传 `path`，标题没有别的地方可放；`create`
是幂等的，壳随后解析到的就是刚建的那一行。名称为空则走壳的廉价路径（标题由壳从文件夹名派生）。

## 六之七、节点控制：一个只有一种能力的会话

「节点控制模式」不是一个新会话类型，是一个 **agent preset**（`presets/node-control.patch.yml`）。
三个部件：

| 部件 | 是什么 | 为什么这样切 |
|---|---|---|
| `rnhControl` 服务 | `ctx.provide('rnhControl', …)`，方法 `list / add / update / remove / connect / disconnect / status` | 注册表本来就存在，只是以前只挂在 `/rnh/api` 上；工具不该去摸 HTTP |
| `rnh_nodes` 工具 | 新入口 `@greatbaby/dsh-remote-node-harness/node-control`，只注册这一个工具 | 预设的 `config.plugins` 会整包挂载，挂整个插件等于把装饰器、看门狗、设置 API 拖进 agent 作用域 |
| `preset-node-control` | `config.plugins` 只有 `persona` + `rnh-nodes` | 见下 |

### 「其他一律拒绝」为什么是构造保证

web-app 的 patch 把 host 平面上的 agent 工具行全部 `disabled: true`，所以**一个会话的工具集就是它自己那份
preset 的 `config.plugins`**。本预设只列一个工具，这个会话就没有别的工具：没有 `bash`、没有 `read`、
没有 web、没有子代理、没有工作流、没有 skills。不需要 `ctx.tools.restrict` —— 加了就是第二份清单，
两份迟早不一致，而「preset 即能力全集」本来就是这套组合语义。

preset 的 `persona` 行只负责把这件事说清楚（拒绝什么、怎么引导用户去对的地方），不负责实现它。

### 预设必须有 `name` 和 `description`

`config.id` 只决定身份，**不决定它长什么样**。`@deepseek-ai/dsh-agent-preset` 的 schema 里
`name` / `description` / `order` 都是可选的，所以少写两个字段不会报错 —— 会话输入框的模式选择器
里就直接显示 `node-control` 这个裸 id，夹在「犀牛模式」（有名称有说明）和几个内置模式之间，
看起来像插件没装完的残留，而不是一个有人特意装的模式。实测对照：`rhino-mode` 写了
`name: 犀牛模式` + 一句 `description`，`agentPresets/list` 就把它带出来。

所以本预设补上 `name: 节点管理` 与一句说明；`description` 里同时写清**没有什么**（没有文件、
终端、搜索、联网工具），因为「点进去发现什么都不能干」是这类受限模式最容易被误判的地方。

### 密钥不能作为工具参数

会话日志会原样记录工具参数。在聊天里贴密码等于把它写进历史文件，所以 `add` 只收两种**引用**：

| 形式 | 含义 |
|---|---|
| `{ kind: 'key', path: '~/.ssh/id_ed25519' }` | 本机已存在的私钥文件 |
| `{ kind: 'password', env: 'RNH_NODE_PW' }` | 本机已设置的环境变量名 |
| `{ kind: 'agent' }` | 本机 SSH agent（默认） |

内联 `password` / `privateKey` 被显式拒绝（`auth-inline-refused`），并在错误里指出该去「设置 › 远程节点」。
`readAuthReference` 读到的值直接写进 `ctx.credentials`，路径与内容都不回显。

### 被控节点永远不装这套

`@greatbaby/dsh-remote-node-harness` 在 `NODE_NEVER_SYNC` 里（见 §六之五）：它带的就是这个预设，节点装上就等于「被控节点能
控制别的节点」，正好是要避免的形态。`version-unit` 与 `plugin-switch` 各有一条断言守着。

## 六之八、中转产物补丁：手机读远端会话文件的唯一出路

手机读「远端会话」的文件，在链路上被中转挡下。这一节记录为什么只能改产物、补丁长什么样、
以及它凭什么不会变成一颗定时炸弹。决策记录见
[ADR-0008](adr-0008-relay-artifact-patch.zh.md)。

### 拦截点在哪

`ds-harness-remote` 的 `HarnessRemoteBridge.call()` 在 dispatch 前对读类端点做一次**本机**
授权：`resolveWorkspaceRootForSession` 让 Host 派发 `session/list`、取该行 `cwd`、再在桌面
本机 `realpath()` 并 `stat()`；随后 `assertNativeWorkspaceFileCall` 还会对目标文件本身
`lstat()` + `realpath()`。

rnh 合并进来的远端行 `cwd` 是**节点路径**（`/root/proj`）。本机没有这个目录，两处都
`ENOENT`，手机拿到 `WORKSPACE_UNAVAILABLE`。受影响端点：
`workspaceFiles/{read,readBytes,readAll,stat,search}`。

### 三个被否掉的方案

| 方案 | 否掉的理由 |
|---|---|
| 改中转仓库 | 与上游发版直接冲突，每次发布都要重打；GOAL §七-3 已定两个仓库不改 |
| 运行时从外部包住 | `HarnessRemoteBridge` 不在产物导出里；`dshRemote` 只暴露 runtime；`resolveWorkspaceRoot` 是构造参数、`assertNativeWorkspaceFileCall` 是私有方法 —— 三条路都堵死 |
| 本机放一份远端目录副本 | `realpath(cwd)` 能过，但 `lstat(<本机>/root/proj/a.txt)` 仍 `ENOENT`，要过就得放真实副本 —— 那是 GOAL §七-5 明令禁止的镜像 |

### 补丁做什么

只做一件事：**`rnh_<nodeId>_<remoteId>` 形式的会话 id 跳过本机授权，原样放行给 rnh 装饰器。**
路径边界交给节点自己算 —— 节点按自己的会话头重算 `workspaceFileScope`，
`workspaceFiles/{read,readAll,stat,readBytes}` 的限制仍在节点上生效。这与已经路由的
`session/page`、`terminal/*` 是同一个信任模型：**这个 Host 已经通过 SSH 信任那台节点**，
中转不该再用「本机文件系统」给它出第二次证明。

注入一个判定，并在两处调用点前加排除条件：

```js
const __rnhRemoteScope = id => typeof id === "string" && /^rnh_[a-z0-9]+_/.test(id)
```

### 三条硬约束

1. **每个锚点必须恰好命中 1 次。** 0 次或多次就整份放弃并报出「期望几处、实际几处、版本号」。
   半打的补丁比不打更糟：症状会随端点跳，而且每次都不一样。
2. **写盘只能「新文件 + rename」。** pnpm 把同一份 `dist/index.js` 硬链接进每个装了中转的
   profile（实测 `nlink: 2`、同 inode）。就地写会连带改掉另一个 profile 的副本；`rename`
   只替换目录项。`relay-patch-unit` 有一条断言守这个（打完后 `nlink` 变 1、兄弟副本字节不变）。
3. **必须能退。** 首次打之前把原文件复制成 `index.js.rnh-orig`（只在源文件没有补丁标记时写），
   sidecar 记 `{ version, originalSha256, patchedSha256, anchors }`，`revertRelayPatch()` 就是一次复制。

### 每次启动重新检测

`apply()` 里调一次 `applyRelayPatch()`。稳态是「已有标记且哈希对得上」→ 什么都不做。
中转升级会整份替换 `dist/index.js`，标记消失 → 重新对锚点；锚点对不上就放弃并写原因。
结果进 `GET /rnh/api/nodes` 的 `local.relay`（`installed` / `patched` / `anchors` / `reason`），
**不只写日志** —— 否则「补丁是否生效」只能靠翻文件。

配置 `relayPatch: false` 可整体关闭。

### 节点上「不存在的绝对路径」

同一条链上另一处改动，服务的是「手机在节点上新建工作区」（GOAL §五-1）。手机的端点白名单里
没有 `directoryPicker/createDirectory`，所以「新建文件夹」按钮不渲染；它的「输入路径」在能
浏览时会转成 `browse(path)`，而 `directoryPicker/list` 对节点上不存在的目录原本直接报错，
就停在那里。

改法是 `listRemote` 把「不在」与「不让看」分成两个互斥标记（`RNH_BROWSE_MISSING` /
`RNH_BROWSE_ERROR`），前者在路径合法时返回一个**空层**，并带 `exists: false`：

```
输入 /root/newproj → 空层里点确认 → 中转 dispatch 前 mkdir -p 造本机幽灵目录
  → rnh 的 workspace/create 在节点上 mkdir -p 并登记 → 成功后精确 rmdir 掉本机那条空链
```

只有「绝对 POSIX、不是 `/`、不含 `..`」才给空层；权限问题、不是目录、非法路径仍走
`RNH_BROWSE_ERROR` 报错，因为下一步会在节点上真的 `mkdir -p` 出来。本机（`listLocal`）的
语义不变，仍是不存在就报错 —— 本机不需要从选择器里造目录。

## 六之九、能力单一真源、状态机、安装事务（2026-11-23 重写）

这一节记录一次结构性重写。起点是一句判断：「节点端做得太烂，修了几百遍，到底有没有彻底重构」。
核对下来，**现象成立、归因要修正一次**：141 次提交里真正落在节点生命周期（`src/remote/` +
`packages/rnh-brain`）的只有 6 次，其中 3 次是 fix —— 节点侧被改得很少，却反复出问题。
原因不是没人修，是同一类结构缺陷在长新 bug。

设计文档与逐条实证在 [`refactor-node-side.zh.md`](refactor-node-side.zh.md)。下面只写结论形状。

### 能力：从 26 处声明到一处

「节点有什么能力」原来被声明在 6 组 26 处，**互不校验**：组合行、预设行、打包保留名单
（`RETAINED`）、打包删除规则（`DROP_RULES`）、provision 复制白名单、`dsh.bundle.patch`；
外加 3 份节点固定组合、4 份 bundle 名、**4 种键空间**（行 id / 无 scope 目录名 / 包全名 / 报告名）。

现在只有一处：`packages/rnh-brain/capabilities.mjs`，零依赖纯数据 + 纯函数，
**全仓唯一允许出现 `@deepseek-ai/` 字面量的文件**。每个能力自带 `verdict`：

| verdict | 未满足时 | 今天用在哪 |
|---|---|---|
| `required` | 拒绝（形状留着，今天都用得上） | 大脑本身：传输、控制器、agent 平面、office、模型平面 |
| `optional` | 组合与预设里**都不出现**（不是宣告了再失败） | 形状已有，暂无成员 |
| `never` | 行不在，包也不该在盘上 | 浏览器面、Electron 壳、computer use、实验包、开发工具链、外部 agent bundle |

下游一律派生、不许手写：组合行集（`composedRowIds`）、预设行集（`presetRowIds`）、
打包保留集（`keptPackages`，`trim-fork-runtime.mjs` 的 `RETAINED` 就是它）、删除理由、
provision 白名单、bundle 名。

**这解决了 office 那一类缺陷的根**：原来保留 `dsh-office-kit`、却按前缀删掉它硬依赖的
`libreoffice-kit`（含 Linux 上真正使用的 WASM 引擎），于是三个 office 工具永远在目录里、
永远一调用就抛「Kit is not installed」。更糟的是守住它的那条断言查错了关系
（「被保留的名字是否命中删除规则」=同名交叉，而真实失效是「被保留的包**依赖**的包被删」
=依赖闭包交叉），且夹具不写 `dependencies`，改对关系也抓不住。
现在 `keepClosure()` 沿 `dependencies` 求运行时闭包（peer 只收名不递归、dev 不追、
**optional 不追** —— 这正是 Linux 能删掉 189.7 MiB win32 引擎的原因），并断言
「闭包里没有任何包命中删除规则」。

### 三种声明不一致，现在会在离线层变红

`offline/capabilities` 把每一处现状与注册表对账：组合 59 行、4 个预设共 112 行、
6 个保留包、11 条删除规则、provision 白名单、bundle 名、平台。任何一处单独漂移都红。

`offline/generated` 守住三段生成链的最后一跳：`cordis.patch.yml` + `presets/` 改了却没重跑
`embed-into-rnh.mjs`，节点上跑的就是旧组合 —— 这件事**已经发生过一次**（源里 `MCP server fleet`
被写成 `rhn`，嵌入副本没跟着改，CI 全绿）。

`offline/fork-runtime` 的闭包闸门；`build-fork-runtime.mjs` 在打出归档前调
`unresolvedInTree(staging, RETAINED)` —— 缺包直接让构建失败，不再把装不起来的树发出去。

### 状态：15 个可变字段到一个判别联合

原来 `state`（4 值）+ `phase`（5 值字符串）+ `serving` + `error` + `failure` + `droppedAt` +
`recoveries` + `recoveryAttempts` + `transfer` + `gate` + `provision` + `runtimeVia` 等字段并存，
靠 `describe()` 的「有值才展开」拼成隐式联合类型，跨字段不变量由客户端各自补救 ——
于是出现「connecting 期间 serving 仍有值」「断开后 state=idle 却残留 error 渲染红块」
「syncConfig 失败仍显示绿点」这类组合。

现在 `src/host/node-status.js`：
`idle | connecting | connected | recovering | failed | stopping | terminated`。
`reduce(status, event, ctx)` 是纯函数（22 个事件），副作用是显式列表
（`publish`/`armTimer`/`cancelTimer`/`invalidateSocket`/`resetGateway`/`stopResidentHost`/
`persistOutcome`/`log`），由 `rnh.js` 一层 interpreter 执行。六条不变量可以用
`violationsOf()` 双向断言（构造非法 status 能抓到 + `reduce` 产出的永远合法）。

`describe()` 从 status 纯投影，**旧字段名一个没改、没删**（手机端也读它），只新增
`kind`/`gate`/`lastError`。`state` 的三个新值里 `recovering` 对外仍报 `idle` + `droppedAt`
（设置页本来就靠这个组合渲染「已断线，正在重连」）；`stopping`/`terminated` 靠客户端的
未知值兜底。

`gate` 首次进 `describe()`：用户此前看不到「这次连接为什么要重装」。

### 安装：一次事务，不是两半

原来失败处理被切成两半：shell 管字节与目录、JS 管版本与状态，各自补齐「自己那半」的回滚，
而中间那个窗口（换目录、传输被杀、status 与进程不一致）没人管。三条实证：
校验失败的回滚会把**好的现役树**换成**更旧的备份**（降级）；传输超时根本不进回滚；
`status.json` 里 profile 写死常量而比较用派生名，非默认 root **每次 connect 都重启宿主**。

现在：

- 布局是 `runtime -> runtime.<n>`（符号链接）+ 保留一代。解包/校验/chmod/打戳/自检全在
  `runtime.<n+1>` 里完成，**唯一的提交语句是一条 `ln -sfn`**。任何失败都不触碰现役；
  「回滚」是同一个操作反向。
- shell 与 JS 之间是**最后一行 JSON**（`trap finish EXIT` 保证任何退出都有），退出码只作诊断。
  这套替掉了「退出码 + stderr 哨兵子串」——后者靠命名规避子串碰撞，还会被采集上限截断。
- 进程身份是「pid 存在 且 `/proc/<pid>/cmdline` 含 `--profile <名>`（两侧锚定）且 starttime 相等」，
  不再用 `kill -0` 当活着。

### 失败只有一个出口

一条规则：**每条远端能力都必须暴露 `state`，`catch(() => undefined)` 禁止出现在能力路径上**。
原来 11 处把失败翻译成「看起来正常」：凭据推送失败仍 CONNECTED、`ensureServing` 不看退出码、
错误帧先 `finish()` 再 `onEnd(error)` 于是被降级成 EOF、`find` 缺失当空目录、lookup 覆盖失败静默、
`decorators` 的方法名不存在静默跳过、客户端的四个 `.catch(() => undefined)`……

各文件头注释一直在写「静默本地作答是必须消灭的失败模式」——**实现与文档相反**。

### 这一节之外、仍然开着的口子

- `dropPackages()` 按**无 scope 的目录名**匹配 `DROP_RULES`，而保留集用**全名** —— 键空间不统一
  是已知债务，改它会改变构建删什么，需要重新构建制品验收。
- 节点 brain 没有独立版本号（它是以文件写入的，唯一戳是内容哈希），所以 `decideGate` 的
  brain 分支保持惰性 —— 代价是「节点被别的桌面装新了要拒绝」这条保护仍然不存在。
- `decorators.js` 仍是单文件约 1010 行、按命名空间分 18 个 `decorate*` 函数。
  设计 §九 批 5 第 23 项的两半都做完了 —— 合并流骨架（`host/merge-stream.js`）与
  四个 `Remote*` 的 per-node 簿记（`host/node-stream-set.js`）—— 但**按命名空间拆分
  `decorators.js` 本身未做**，那是同一条项里的第三件事。
- `client.js` 仍是单文件约 2350 行，`node-view.js` 的纯视图模型没有独立出来。
- `artefact.js` 的 `quote()` 不转义内部单引号。触发面只剩「发布源配置里塞了带单引号的 URL」，
  属发布侧配置错误 —— `remoteRoot` 已在注册表入口校验，路径不再可能带引号。

### 已经关上的口子（本轮）

- **`remoteRoot` 的远端命令注入面**：`normalizeRemoteRoot()` 在 `normalizeNode` 里做白名单校验
  （`[A-Za-z0-9._\-/~+@,=:]`，每个允许字符在未加引号的 shell 词里都惰性；`~` 只在开头）。
  `normalizeNode` 是记录被创建或修改的唯一路径，所以 35 处 `sh -c` 插值不用改一行就安全了。
  空格被拒绝：允许它会让 `mkdir -p <root>/run` 裂成两个参数。
- 错误词汇**只剩一张表**：`src/core/errors.js` 的 `ERROR_CODES` + `classifyFailure`。
  `daemon.js` 的 `PROVISION_FAILURES`（旧那套、零消费者）已删，设计 §七 的「失败只有一个出口」
  因此在词汇层面成立。
- 两份逐行同构的合并流骨架收敛成 `host/merge-stream.js`：生命周期归一处，
  `mergeControlStream` / `mergeWorkspaceStream` 各自只提供载荷策略。`detach()` 幂等，
  订阅恰好释放一次（`merge-stream-unit` 断言）。
- 四个 `Remote*` 类各自抄了一遍的 per-node 簿记收敛成 `host/node-stream-set.js`。
  它只算「发生了什么」（`plan()` 返回 `left`/`arrived`/`staying` 且**不做任何改动**），
  因为其中三个对「节点离开了」的反应是关流，而 `RemoteWorkspaces` 要保留行并标记 offline ——
  同一条事实、两种 policy，共用的是事实那一半。
- 设计 §八 列的 11 项死代码已删；`encode` 与 `SecretStore.describe` 经复核**不是**死代码，
  保留（设计文档里的那两条是误判，已在 §八 注明）。

### 目录浏览的协议（F1/F2 修完之后）

`browse.js` 不再解析文本：每个事实是 `type\0value\0` 记录，名字块 NUL 分隔 + base64 包裹，
`find` 的退出码直接检查。名字因此不可能伪装成事实，非 UTF-8 名字带 `unrepresentable` 标记
而不是被静默替换成 U+FFFD。路径合法性只有一处（`posix-path.js` 的 `normalizePosix`）：
折叠 `//`、`.`、`..`，**越过根报错而不钳制**，`listRemote` / `makeRemoteDirectory` /
`ensureRemoteDirectory` / `decodePickerPath` / `index.js` 的 `workspace/create` 全部走它。

---

## 七、测试

共 54 个套件（`run-all.mjs --list` 是唯一权威清单），分三层：**offline** 34 个（纯逻辑 + 组合
检查 + 真 POSIX shell 跑安装脚本与目录列举脚本）、**contract** 3 个（读 `app.asar` 里的上游包）、**e2e** 17 个
（运行中的 Host + 连上的节点）。下表按「守哪条设计」分组，同一层内的顺序不代表执行顺序。

| 脚本 | 验证什么 | 依赖 |
|---|---|---|
| `routing-unit.mjs` | 身份往返、流扇出、工作区合并、本地调用直达上游、job 三个端点、control 只发一帧 baseline | 无（假 rnh） |
| `routing-extra-unit.mjs` | 其余带身份的命名空间按各自形状路由：goals/userQuestions 按 `Agent`、feedback 按 request 字段、subagents 按裸 uuid、schedule 合并 + 逐条路由 | 无（假 rnh） |
| `gateway-smoke.mjs` | SSH 上的 cookie、unary RPC、流载体 upgrade | 真实节点 |
| `descriptor-smoke.mjs` | 上游包的 descriptor 与 `static inject` 可从 `app.asar` 读到 | Electron Node |
| `dispatch-seam.mjs` | Gateway 的 view 会读取实例 own property；声明端点集不变 | Electron Node |
| `upstream-smoke.mjs` | 上游控制器的 `static inject` 与导出可用 | Electron Node |
| `host-routing.mjs` | **每个**路由端点走本地 `/api`，以及该保持本地的端点仍然本地；含一次**二进制**读取（远端图片预览靠它） | 运行中的 Host + 已连接节点 |
| `workspace-flow.mjs` | 端到端手势：按路径加远程工作区 → 在里面建 Session → 发消息 → 节点 bash 真跑 → 文件真出现在节点磁盘 → 会话归入工作区 → 出现在 `session/list` 且 cwd 是节点绝对路径 | 同上 |
| `tool-parity.mjs` | 镜像方案过不了的那一关：agent 自己的 `read`/`write`/`edit`/`grep`/`glob` 打的是节点真实路径，没有路径类失败，整份 transcript 里没有 Windows 路径 | 同上 |
| `tool-git-image.mjs` | `git` 打真仓库、`read_image` 开真 PNG、`grep` 搜真文件 —— 三个在"工具在本地跑、只是对着镜像"时必然坏掉的工具 | 同上 |
| `multipart-unit.mjs` | Gateway 的 `multipart/form-data` 应答能解：字节附件在正确的 JSON 路径上还原成 `Uint8Array`，畸形分片被拒绝而不是静默读成 `null` | 无 |
| `provision-unit.mjs` | 下发给节点的东西是对的：provider 行复制而账号行不复制、行里没写 `apiKeyEnv` 时也能推断出 key ref、配置能过真 YAML 解析器 | Electron Node（解析器在 `app.asar` 里） |
| `rnh-brain/scripts/check-composition.mjs` | 节点组合仍然是个**大脑**：7 个 Remote 控制器行在、4 个传输行在（`webserver` / `connection` / `api-remotes` / `web-startup`）、`web-runtime` 不在、没有任何 `dsh-client-ui-*`、6 条 agent-plane disable 在、preset 文件齐全且已声明、YAML 可解析 | Electron Node（借用安装里的 YAML 解析器） |
| `rnh-brain/scripts/sync-from-upstream.mjs` | **生成器，不是套件**（不在 `run-all` 的调度表里，因为它会写 `cordis.patch.yml`）。它把组合从已安装的 release 重新派生；「生成后与已提交版本一致」这条由 `generated` 套件间接证明 —— 它断言内嵌副本与磁盘上的源逐字节一致（按行尾归一），所以手改生成物会立刻红。`check-composition` 是另一件事：断言组合仍然是个大脑 | 已安装的 DSH release（只在升级时手动跑） |
| `client-bundle.mjs` | 桌面端真的 serve 了这份客户端代码；三个槽位注册且能渲染 | 运行中的 Host |
| `event-relay.mjs` | 在**节点上直接建**的 Session 能到达浏览器：`api-session/*` 列表事件与 `session/control` 投影帧都带着包裹后的身份到达；baseline 里有远程投影块；没有任何裸的节点 Session id 泄漏 | 运行中的 Host + 已连接节点 |
| `session-acceptance.mjs` | **像用户一样**：在远程工作区真实建 Session、真实下一条要让 agent 用 write/bash/grep 干活的指令、读回 `session/follow` 核对三条工具调用与结果、`turn/end` 是 `completed`、助手说 DONE；再用**独立 SSH 连接**读节点上的产物字节 | 运行中的 Host + 已连接节点 |
| `terminal-acceptance.mjs` | 远程会话里的真 PTY：`environment`/`shells`/`create` 走路由后的 agent lookup、attach 首帧 snapshot、写入 `echo` 命令、读到输出与节点 ack、`close` 后从花名册消失 | 同上 |
| `multi-node-acceptance.mjs` | 同时连两台（同一机器两个 `remoteRoot`）：侧栏两边的工区都在且 id 唯一、各自建的 Session 落到各自节点、合并列表里是两行、移除一台不影响另一台 | 同上 |
| `artefact-acceptance.mjs` | 在真节点上跑真安装脚本：下载、校验 sha256、解压、替换、`--version`、二次安装、回滚；断言原生包是 `linux-x64` 而非 `win-x64`。脚本自己报 `ARTEFACT_UNAVAILABLE`（这台网络拿不到制品，exit 3）时记 **SKIP** 并打印原因 —— 实测这台节点连不上加速地址、直连只有 ~41 KiB/s，165 MiB 要 68 分钟，30 分钟上限正在起作用 | 节点 + 已发布的 Release 制品 |
| `approval-acceptance.mjs` | **审批与提问真的走完一整圈**：节点 `approval/asked` → 本机 `$events` 上的 `waterfall` 帧（agentId 已包裹）→ 用 `$events/result` 答复 → 节点 `approval/decided` 记下所选值 → 文件真的写出；第二次改成拒绝，文件不存在；`ask_user_question` 用批量 `{answers:[{id,selected}]}` 往返 | 运行中的 Host + 已连接节点（节点需 `approval: ask`） |
| `browser-acceptance.mjs` | 真 Chrome + CDP：渲染后的侧栏文本里**真的有**远程工区；插件自己的入口可达；截图留证。API 测试看不见"baseline 把远程行冲掉"这类问题 | 运行中的 Host + 带 `--remote-debugging-port` 的 Chrome |
| `version-unit.mjs` | 版本闸门的每个分支（含 rc 排序）、制品 URL、安装脚本内容、每节点 layout 派生、插件开关语义（哪些 bundle 算第三方、**默认全开**、硬排除清单、节点列表顺序、状态文件容错） | 无 |
| `waterfall-unit.mjs` | 审批/提问中继：允许的 waterfall 才发到浏览器、拒绝与超时各自结算、节点断开时卡片被取消、问题按自己的名字转发 | 无 |
| `workspace-browse.mjs` | 加工作区对话框背后的两个接口：本机与节点用同一形状回答、节点列的是节点的盘（`/` 没有上级、隐藏目录不列）；**本机**不存在的目录仍报错，**节点**上合法但不存在的绝对路径返回 `exists: false` 的空层 | 运行中的 Host + 已连接节点 |
| `picker-flow.mjs` | **手机**看节点这条路由：`/@rnh` 列出节点、`/@rnh/<id>/` 列出那台机器真实的根、每个 entry 都拼回命名空间、面包屑不越界、没记过的 id 报 `rnh/node-unknown`；节点上不存在的路径给出可确认的空层，拿它 `workspace/create` 之后节点上真有那个目录、桌面盘上那条幽灵链被清掉；已存在的路径同样建工区，且同目录下别人放的文件不动 | 同上 |
| `node-status-unit.mjs` | 状态机：7 个 kind 的判别联合、22 个事件、6 条不变量（`phase` 只在 connecting、`serving` 只在 connected、`error` 只在 failed…）、`recovering` 对外仍报 `idle` | 无 |
| `recovery-ladder-unit.mjs` | 假时钟上跑真阶梯：2 s → 4 s → 8 s → 2 min，漏掉的一级保持 `recovering` 而不报 `failed`，主动断开重置它，`dispose` 取消它 | 无 |
| `registry-unit.mjs` | `nodes.json` 只坏一个字段时不整表清零：改名式备份、逐条跳过、`normalizeNode` 抛 `node-invalid` → HTTP 400 | 无 |
| `capabilities-unit.mjs` | 能力注册表**自己**的逻辑：每条记录结构完整、三个 verdict 分支都真的会走（含 `optional`）、`*` 模式边界、保留集派生、凭据需求与推送的对照 | 无 |
| `gate-mutation-unit.mjs` | 闸门**自己的**测试：五种真实漂移各让 `check-capabilities --strict` 非零退出并说出是哪一处（在临时副本上做，不动工作区） | 无 |
| `browse-protocol-unit.mjs` | 目录列举的 `type\0value\0` 记录协议，在**真 POSIX shell** 上跑真脚本：marker 形状的目录名、含换行的名字、非 UTF-8 名字、缺 `find`、越界路径、`mkdir` 的单段校验 | 真 shell（WSL 或 `/bin/bash`），无则 SKIP |
| `merge-stream-unit.mjs` | 合并流的**生命周期**（载荷策略各自不同，只测共用那层）：抛错以 rejection 到达消费者、`return()`/abort 恰好释放订阅一次、`prelude` 在首帧之前 | 无 |
| `node-stream-set-unit.mjs` | 四个 `Remote*` 共用的 per-node 簿记：`plan()` 只分类不改任何东西（`left`/`arrived`/`staying`）、同一节点只创建一次、`drop()` 在出路关流且只关一次、`disposeAll()` 全关 | 无 |
| `ws-frame-unit.mjs` | WS 帧纯编解码：控制帧载荷 ≤125 字节（超了就是损坏帧）、分片明确拒绝而不是拼错 | 无 |
| `http-over-ssh-unit.mjs` | SSH 上的 HTTP：超时预算唯一（`asSocket.setTimeout` 已删）、响应体有上限、`Content-Length` 不符时明确失败 | 无（假 socket） |
| `error-frame-unit.mjs` | 节点错误帧不被降级成正常结束：真 ws + 真 Gateway + 真 `AsyncQueue`，错误到达消费者 | 无（假 socket） |
| `install-shell-unit.mjs` | 生成物是**真能跑**的 POSIX shell：新鲜安装是指向编号代的符号链接、升级只留一代、坏校验和不动现役、提交点被 SIGKILL 后现役仍可启动、每条退出路径都以一行 JSON 结束 | 真 shell 且能建符号链接（WSL ext4），否则 SKIP |
| `packet-unit.mjs` | 一次 exec 请求就是一个 SSH 包：命令行超 128 KiB 在本地拒绝，不发出去让服务器损坏连接 | 无 |
| `errors-unit.mjs` | 失败分类的顺序（显式 code → ssh 类别 → ssh2 字面量 → 阶段）、每个 code 的 `action`/`retryable`、节点日志脱敏与长度上限 | 无 |
| `rnh-lifecycle-unit.mjs` | 节点生命周期：掉线变 `idle` 带时间戳、重连阶梯布防、主动断开取消它、首次主机密钥记录并回放、失败保留 phase、不可达节点保留工区行 | 无（假 connection/gateway） |
| `generated-sync-unit.mjs` | 生成物 `brain-bundle.generated.js` 与磁盘上的源**逐字节**一致，且它派生的凭据清单等于 `capabilities.mjs` 派生的那份 | 无 |
| `check-capabilities.mjs` | 能力单一真源的对账：组合行、预设行、保留包、删除包、provision 白名单、bundle 名，八个小节 | 无（`--strict` 是闸门） |
| `fork-base-unit.mjs` | fork 出来的节点基座与上游发布版一致：版本、bundle 名、profile 模板 | 已安装的 DSH release |
| `fork-runtime-unit.mjs` | 裁剪规则的两条载重规则：`@deepseek-ai/dsh-web-app` 的 manifest 必须留着；staging 清单只把 `@deepseek-ai/dsh` 列为依赖、其余进 `overrides` | 无 |
| `node-patches-unit.mjs` | 台账完整：每个改过的上游文件都有对应 patch，每个 patch 都能单独读、单独弃用 | 无 |
| `suite-registry-unit.mjs` | **矩阵自身的完整性**：磁盘上每个测试文件都被 `run-all` 调度、`run-all` 点名的每个文件都存在、每个条目都声明了 layer 且只用三个已知值。`registry-unit` 曾整批没被调度过而无人发现，这条是那件事的闸门 | 无 |
| `picker-paths-unit.mjs` | `/@rnh` 命名空间的编解码（两种路径规范化器都能过、大小写、盘符、重复分隔符、完整 segment 才匹配）；影子目录清理**删不掉**任何有内容的目录，也拒绝命名空间之外的路径 | 无 |
| `install-unit.mjs` | 安装清单自洽：`dsh.bundle.patch` 每个文件都存在且已声明、`engines.dsh` 是合法范围、`files` 覆盖所有运行物、`meta.detail` 指向真实文件、打包文件里没有内网地址与私钥 | 无 |
| `autoconnect-unit.mjs` | 重启后不点「连接」也能连上：`autoConnect` 先取凭据再判断，有凭据就连、没凭据/被禁用的不连、凭据库抛错只记日志不外泄 | 无（内存注册表 + 内存凭据库） |
| `rnh-control-unit.mjs` | 节点控制面：贴进对话的密钥被拒绝、引用在本机读取、任何返回值都不带认证材料 | 无（假 rnh） |
| `relay-patch-unit.mjs` | 中转产物补丁：三个锚点各命中一次才打、结果能过 `node --check`、重复启动幂等、未知中转整份放弃并报出命中数、解析失败时原文件一字不动、`rename` 后硬链接兄弟副本字节不变、`revert` 逐字节还原 | 无 |
| `transfer-unit.mjs` | 首次连接下载运行时期间的数字：速率取窗口平均而不是单次采样、ETA 只在总大小与速率都已知时出现且永不为负、源不给 `content-length` 就只报字节数不编百分比、归档路径与安装脚本同法派生 | 无 |
| `node-control.mjs` | 「节点管理模式」是个**组合**而不是一句提示：预设注册且只声明两行、会话能建、真跑一轮只调 `rnh_nodes` 一个工具、答案是真实节点名册 | 运行中的 Host + 已连接节点 |
| `plugin-switch.mjs` | 单个插件的开关真的落到节点：包被安装或复制上去、节点自己的 bundle 列表里排在脑 bundle **之前**、常驻 host 重启后仍答得出、远程工区数量不变；关回去同样干净，异常退出也恢复开关 | 同上 |
| 手工 §2b / §7c | 脚本走协议、用户走界面，两者都要过：真实 Chrome 里新建远程会话、敲字、发送、看到「已完成」；再看智能体协作开关、子代理历史、产物卡片的原生打开 | 运行中的 Host + 真实 Chrome |

### 一条命令跑完

`test/run-all.mjs` 是这套矩阵的唯一入口：它自己起一个隔离 profile 的 Host、连上已记录的节点、
按 **offline / contract / e2e** 三层依次执行，一个套件一行结论。它存在的理由不是省几条命令，而是
那三条容易做错的事：

- **契约测试必须用 Electron 的 Node 跑**（要读 `app.asar` 里的上游包），端到端必须用普通 Node 但
  需要一个活着的 Host。这两件事靠人记，迟早会漏；漏了的表现是"某个测试一直超时"，与真的坏了
  长得一样。
- **退出码必须代表结论。** 曾经有七个套件在记录失败后又 `process.exit(0)`，把失败吞掉。runner
  读的是退出码，所以它自己也要守这条：任何一层失败都非零退出。
- **没跑不等于通过。** 请求了端到端却一个都没能跑（没有节点、没有 Host）时退出码是 1，并说明
  "the layer that proves a user can work was not exercised"。缺 Chrome 端口、缺 Release 制品、
  节点不会发审批请求这类局部条件则记 SKIP 并给出原因 —— 套件可以退出码 3 声明"这台部署跑不了"。

升级 DSH 之后该按什么顺序重跑、每个测试守的是哪条上游契约，见 [`packages/dsh-remote-node-harness/docs/UPGRADE.zh.md`](../packages/dsh-remote-node-harness/docs/UPGRADE.zh.md)。

`test/carrier.mjs` 是被后五个共用的最小测试客户端，含一条硬要求：**必须应答 Gateway 的 2 秒 ping**，否则两秒后流被静默关闭 —— 这会让路由 bug 伪装成传输 bug。

`host-routing.mjs` 自己建 fixture：在远程工作区里建一个 Session、改名、并在节点上写一个 4×4 PNG 和一份文本。它曾经借用"最新一条远程 Session"和别的测试留下的 `git-image/` 目录 —— 那种写法会让结果取决于测试顺序，而一次因为目录空而失败的运行看起来和路由坏了完全一样。

---

## 八、明确不做的事

- **不改 Electron 主进程**：窗口只连本地 Host 这条约束不动。
- **不接管 `/api` 或 `/api/remote.mux`**：它们已被 gateway 独占，**本机**的 `registerFallback` 也已被 `frontend-static` 占走（节点上则相反：大脑没有 static，那个座位空着，由 `brain-runtime` 认领）。
- **不做本地镜像目录**：工作区路径就是节点上的真实路径。这正是工具能用的原因 —— 见下一节。
- **不碰上游 Loader 行**：插件自己的 `cordis.patch.yml` 只有一条 `insert`。
- **改上游源码必须留台账，不许改了不记**。节点运行时来自本项目的 fork，而 fork 就是**官方 DSH
  源码**——这个项目不另写节点端，改源码是主路径。要求只有一条：每一处源码改动都要能单独读、
  单独测、单独弃用，落在 `packages/dsh-remote-node-harness/patches/node/NNNN-*.patch` 并由
  `docs/node-patches.zh.md` 记一行。改了不记的后果不是「不优雅」，是**上游发版时改动被静默丢掉**——
  那才是真正的缺陷。删包与删文件是**打包步骤**，不进台账。见
  [`adr-0008`](adr-0008-node-source-trim.zh.md)。
- **不发 npm**。节点不经过 registry：拿的是归档。往 npm 发 375 个包只会多一条版本线。
- **不给 GitHub 留下载源**。GitHub Release 收到同一份字节作灾备与留档，但节点只从 CNB 取。
- **不做 per-node 组合定制**：所有节点共用同一份 `@local/rnh-brain`，也共用同一份构建产物。某台机器要不同插件集时再讨论，不预留空壳配置。

---

## 九、为什么"不做镜像"是功能而不是省略

`@artenx/dshb` 的做法是把远端目录镜像到本地（`%USERPROFILE%\.dsh\dshb\mirrors\<node>\<path>`），然后把每条指令发过去执行。镜像带来的不是性能问题，是**工具不可用**：

| 现象 | 镜像下的原因 |
|---|---|
| `rg` / `git` / `python3` 报 `code=127` | 命令解析用的是**本机**的 PATH |
| `read` / `write` / `edit` 报 `ENOENT` | 这三个工具是本地 `node:fs` 调用，锚在 Session cwd 上，而那个 cwd 是个只在本机存在的镜像路径 |
| `read_image` 打不开远端截图 | 字节是从只在本机存在的路径读的 |
| `grep` / `glob` 漏掉远端文件 | 走的是镜像，不是节点 |
| MCP 服务器、skills、`bash` vs `pwsh` | 全部按本地进程解析 |

远端大脑把这一整类问题**消掉**而不是修好：工具就是节点的工具。

所以 `test/tool-parity.mjs` 的断言不是"命令跑通了"，而是：

- agent 自己的 `read`/`write`/`edit`/`grep`/`glob`/`bash` **每一个都被真的调用**（全部退化成 bash 也算不合格）；
- 没有任何文件工具因为**路径**失败；
- 整份 transcript 里**没有** `dshb/mirrors` 或真实 Windows 路径；
- 写出来的文件在节点上 `cat` 得到，且本地文件 API 读回同一份字节。
