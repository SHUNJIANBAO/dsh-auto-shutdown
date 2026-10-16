# dsh-auto-shutdown

全局自动关机开关：开启后，等**所有会话与后台任务都结束**，进入可取消倒计时，倒计时结束执行平台关机命令。

> ⚠️ **这是本仓库里唯一会真的关掉你电脑的插件。**
> Windows 上倒计时可以用 `shutdown.exe /a` 取消（UI 的「取消关机」按钮）；
> **macOS / Linux 走 `/sbin/shutdown -h now`，一旦触发不可撤销**，UI 会明确提示。
> 默认**关闭**，装完不会自己动。

## 用法

| 入口 | 说明 |
| --- | --- |
| 输入框下方 composer dock 的**电源图标** | 点击开启 / 关闭；开启后显示状态与倒计时 |
| `/shutdown-auto on` / `off` / `status` | 人体命令，无 UI 环境和排障时用 |

**行为契约**：

- **全局开关，默认关闭**。状态记录在 `~/.dsh/auto-shutdown-state.json`，但**只在同一次运行的宿主进程内沿用**（补丁热重载 / 第二个窗口）；**重新打开 DSH 一律从「关闭」开始**，不会继承上次遗留的开启状态。
- 开启后，当所有根会话批次转为空闲、且没有 agent 报错、且 `jobs` 里没有 running/stopping
  （后台任务计入等待），开始静默窗口确认（`idleGraceSec`，默认 3s，防止多会话收尾抖动），
  然后进入倒计时（`countdownSec` + `marginSec`，默认 60 + 5 秒）。
- **倒计时期间来了新任务 → 自动 `shutdown.exe /a` 取消，开关保持开启**，等下次全部空闲再倒计时。
- `/cancel`（或关开关）在倒计时/已触发期间会取消关机。
- Windows 命令：`shutdown.exe /s /t <countdownSec+marginSec>`；取消：`shutdown.exe /a`。

## 安装

```sh
# GitHub
dsh plugin --profile <profile> add github:SHUNJIANBAO/dsh-auto-shutdown

# 本地开发 / 离线
dsh plugin --profile <profile> add /abs/path/to/dsh-auto-shutdown
```

官方桌面客户端：侧栏 **插件 → 添加插件**，粘包名、`github:` 地址或本地绝对路径。
装完**完全重启**客户端（宿主半不热加载）。

零 `dependencies`、零 `peerDependencies`、代码内无绝对路径 —— 换机器、离线、DSH 升级都不会卡在装依赖或版本校验上。

## 验收（**不要真关机**）

```sh
node dev/harness.mjs   # 61 项断言
```

harness 是**完全沙箱化**的：`subprocess.spawn` 被完整 mock（只记录 argv，**绝不真正执行关机命令**）、
`os.homedir()` 指向临时目录、用虚拟时钟推进静默期，末尾自检 `S1 production log untouched` +
`S2 no real shutdown invoked`。跑它不会碰到你的机器。

装好后看 `~/.dsh/dsh-auto-shutdown.log`，**这四行齐全就说明插件健康**：

```
插件已挂载：平台 win32，开关默认关闭，命令 shutdown.exe /s /t 65，...
启动自检: 就绪[...] 待命[...] 定时器[...]
能力就绪: jobs（后台任务已计入等待）
能力就绪: commands（/shutdown-auto 已注册）
能力就绪: webServer（HTTP 路由已注册 /api/dsh-auto-shutdown/{state,arm,cancel}）
```

排障签名：

| 日志现象 | 含义 |
| --- | --- |
| 有「插件已挂载」，**紧跟不到**「启动自检」 | `apply()` 半途抛出 → 插件静默消失、UI 只剩「不可用」 |
| `触发评估: ctx.setTimeout 不可用(...)，退回全局定时器` | **预期现象**：宿主 timer 入口不可用，插件已自动降级，功能照常 |
| `定时器[不可用(<真实报错>) → 全局 setTimeout]` | 同上，自检行里顺带回答了「timer 为什么坏」 |

要验真实链路（可选，**需要你盯着**）：点电源图标开启 → 日志出现「已开启」→ 任务全部结束后出现
`★ 任务完成 → 60 秒后关机` 与 `shutdown: ...shutdown.exe /s /t 65` → **立刻**点「取消关机」。
不要在无人看管时做这一步。

## 回滚

```sh
dsh plugin --profile <profile> remove dsh-auto-shutdown
```

或手工：从 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 两处的
`dsh-auto-shutdown`，删掉 `node_modules/dsh-auto-shutdown`，重启。

**先确认开关是关的**（`~/.dsh/auto-shutdown-state.json` 里 `"enabled": false`），
否则卸载前的倒计时仍可能触发关机。

## 结构

```
dsh-auto-shutdown/
├── package.json          # dsh.bundle.patch + dsh.client(immediately) + exports["./client"]
├── cordis.patch.yml      # bundle patch：插入一行（id: auto-shutdown）
├── lib/
│   ├── index.js          # 宿主半：开关状态机、静默窗口、倒计时、HTTP 路由、命令
│   └── client.js         # 浏览器半：composer dock 的电源图标 + 轮询 /api/dsh-auto-shutdown/*
└── dev/
    └── harness.mjs       # 61 项沙箱化回归（A 正常时序 / B 冷启动竞态 / C ctx.setTimeout 调用抛错 / D 读取即抛错 / E 跨进程不继承开关）
```

**宿主入口铁律**（`lib/index.js` 里已经这么做，改代码时别破坏）：`ctx.setTimeout` / `ctx.on` /
`ctx.inject` / `ctx.get` 在这些宿主上可能是「**读一下就抛**」的状态（`typeof x === 'function'`
判断不出来），必须整体包在 try/catch 里并退回降级路径 —— 定时器走 `setPluginTimer()`，
自检走 `timerBackendLabel()`。`apply()` 半途抛出 = 插件静默消失、UI 只剩「不可用」。

## 许可

MIT。见 [LICENSE](LICENSE)。
