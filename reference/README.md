# `reference/` — 上游源码，只读参考，不进版本库

这里放的是**别人写的代码**，用来读契约、对协议、抄组合方式。它们各自是独立的
git 仓库，克隆在本地，**不提交到本仓库**（见根 `.gitignore`）。

| 目录 | 是什么 | 为什么要它 |
|---|---|---|
| `deepseek-harness/` | DeepSeek Harness 官方 monorepo（`deepseek-ai/deepseek-harness`） | 节点大脑就是它本体。插件要写节点侧的组合（bundle），必须读它的 `packages/bundle/*`、`packages/boot/app-boot`、`packages/api/*`；三条运行时缝隙（`@Remote` 描述符、Gateway 的 `Reflect.get` dispatch、参数名解析）也在这里有原文 |
| `zcode/` | ZCode（`zai-org/ZCode`） | 远控架构的参照物：它怎么让"远端有大脑"、怎么下发配置、怎么只装一个 server。本插件的第一版路线就是照它定的 |
| `dsh-Go/` | DSH Go（`ccch1mneyyy/dsh-Go`）—— DeepSeek Harness 的手机 App | **手机那条链路的另一端**。它决定 rnh 必须长成什么形状：哪些端点在它的允许列表里、工作区怎么添加、目录选择器怎么走。改手机入口相关的东西之前必须先读它，不能靠猜 |
| `ds-harness-remote/` | DS Harness Remote（`liguobao/ds-harness-remote`）—— 手机到桌面 Host 的中转 | **中转的白名单是硬边界**：手机能调哪些端点由它决定，rnh 只能在白名单之内工作。写跨端的路由、判断"手机能不能用"之前，读 `packages/plugin/src/harness-remote-bridge.ts` 的 `HARNESS_REMOTE_ALLOWLIST` |

## 重新拉取

本机的全局 git 代理已失效，直连 `github.com` 会超时。用加速站（按 AGENTS.md §13 的顺序试，
`git.yylx.win` 不可用时用 `gh.meali.top`）：

```bash
git -c http.proxy= -c https.proxy= clone --depth 1 \
  https://gh.meali.top/https://github.com/deepseek-ai/deepseek-harness.git \
  reference/deepseek-harness

git -c http.proxy= -c https.proxy= clone --depth 1 \
  https://gh.meali.top/https://github.com/zai-org/ZCode.git \
  reference/zcode

# 需要完整历史时先浅克隆再 fetch --unshallow（浅克隆比全量快一个数量级）
git -c http.proxy= -c https.proxy= clone --depth 1 --single-branch \
  https://gh.meali.top/https://github.com/ccch1mneyyy/dsh-Go.git \
  reference/dsh-Go
git -C reference/dsh-Go -c http.proxy= -c https.proxy= fetch --unshallow origin

git -c http.proxy= -c https.proxy= clone --depth 1 \
  https://gh.meali.top/https://github.com/liguobao/ds-harness-remote.git \
  reference/ds-harness-remote
```

## 钉住的版本（读之前先确认，否则读到的契约与运行时对不上）

| 目录 | 本机钉住的提交 | 版本 |
|---|---|---|
| `deepseek-harness/` | `39163dd3` | `0.2.2-rc.3`（与本机桌面端一致） |
| `zcode/` | `fec97590` | `v3.18.2` |
| `dsh-Go/` | `5fc5f41a`（3069 个提交，完整历史） | `1.3.0` |
| `ds-harness-remote/` | `439f1ac` | `0.6.7`（本机装的是 `0.6.6`） |

`ds-harness-remote` 的克隆是 **0.6.7**，本机装的是 **0.6.6**。读白名单时以 0.6.6 的
`packages/plugin/dist/index.js` 为准，源码树用来理解意图。两者在 `HARNESS_REMOTE_ALLOWLIST`
上的差异要单独核，不能默认相同。
