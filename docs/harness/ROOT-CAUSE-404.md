# `GET /dnd/characters` 404 — 根因记录

> 任务：定位 `/dnd/characters` 返回 404 的原因（`TASK-BOARD-HANDOFF.md` 任务 1）
> 日期：2026-09-18
> 结论：**前提不成立 —— 该端点没有 404，它在真机上返回 200 与正确的实时数据。**
> 本轮**未产生代码补丁**，因为没有任何东西坏了。这本身是交付结论。

---

## 一、结论先行

`TASK-BOARD-HANDOFF.md` 记录的「`GET /dnd/characters` 在真机上返回 404」是一个**过期的观察**。
在本轮实测中，同一个地址、同一个运行中的进程：

```
GET http://127.0.0.1:3080/dnd/health     => HTTP 200
{"ok":true,"fs":true,"campaign":"morgansfort"}

GET http://127.0.0.1:3080/dnd/characters => HTTP 200   bytes=2790
campaign=morgansfort characters=1
alice display: HP=8/8 AC=12 level=1 Wizard
alice currency: 8 gp 0 sp 0 cp
```

数据与任务 2 的预期完全一致（HP 8/8、AC 12、`8 gp 0 sp 0 cp`）。
**限制**：**没有重启 harness**（任务明确禁止）。所以以上是**当前正在运行的进程**的实测，
而非「重启后仍成立」的断言 —— 见第五节。

---

## 二、逐条回答任务提出的四个问题

### 1. Host 半边是否真的被加载？14 个 `dnd_*` 工具注册了吗？

**是，14 个全部注册。** `apply()` 确实跑过了。

判据不是「tool 列表看起来有」，而是在**进程内**读 `ctx.get('tools').schemas()`
并筛 `dnd_` 前缀，得到 14 个名字：

```
dnd_roll dnd_check dnd_attack dnd_save dnd_mastery dnd_dc
dnd_srd_lookup dnd_campaign_state dnd_campaign_search dnd_arc_status
dnd_character_get dnd_track dnd_spend dnd_xp_add
```

这与 `src/host/index.mjs` 头部注释里列出的五个工具族一一对应。

### 2. `webServer` 在 web profile 里的名字是否就是 `webServer`？

**是，键名就是 `webServer`，且在本进程存在。**

只读核对（未修改安装目录）：

- `dsh-host-webserver/lib/types/index.d.ts:15-18` —
  `declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`
- `dsh-web-app/cordis.patch.yml:135-143` — 该 bundle 确实插入了
  `- id: webserver / name: '@deepseek-ai/dsh-host-webserver'`，
  `inject: [webStartup]`，`host`/`port` 来自 `ctx.webStartup`（回退 `127.0.0.1:3080`）。
- 进程内实测：`webServer` 存在，`port=3080`，`host=127.0.0.1`，
  `fallbackClaimed=true`（SPA dist 已占住 fallback 座位）。

### 3. boot 日志

**没有单独查 boot 日志，因为不需要，而且那个方向会误导。**

`C:\Users\Ming\.dsh` 下只有 `settings.yaml` / `package.json` / `.credentials.yaml` 等，
没有 boot 日志文件。**这不是问题** —— 日志能回答的「路由到底注册了没有」，
进程内的 `webServer` 路由表回答得更直接、更权威（见下）。

以后遇到同类问题，优先用这条路，不要去找日志文件。

### 4. 定向读到的关键证据：**活路由表**

这是本轮的决定性证据。在运行中的进程里读 `webServer` 的私有两张表，
拿到**当前真实注册的完整路由清单**。其中包含：

```
exact  /dnd/characters
exact  /dnd/health
```

两条都在。同一张表里还有 `@linxin666/dsh-client-ui-task-board`、`dsh-ssh`、
`skin-center` 等其它 bundle 的路由 —— 说明这张表就是所有插件共享的那一张，
`dsh-dnd` 的行确实进去了，**不是「注册了个没人看的影子表」**。

---

## 三、同时核对 Client 半边：也已正确挂载

`clientModules.graph().entries` 共 **65** 行，其中包含 `dsh-dnd`：

```json
{ "id": "dsh-dnd",
  "url": "/plugins/??dsh-dnd/client.js&rev=509146f266996d68-58",
  "rev": "509146f266996d68-58",
  "inject": [] }
```

并且 `clientModules.clientPath('dsh-dnd')` 解析到
`D:\DND\dsh-dnd-bundle\lib\client.js`（即 `link:` 指向的真实目录，junction 生效）。

**所以 host 路由、client roster 两条线都是通的。**

---

## 四、那原始的 404 是怎么来的？—— 时间线

这是唯一能解释「当时确实看到了 404」的事实链：

| 时间 | 事件 |
|---|---|
| 11:00:55 | 当前进程启动（`TASK-BOARD-HANDOFF.md` 记录） |
| 11:08:42 | `lib/client.js` 与 `lib/host/index.mjs` 构建产物落盘 |
| **11:41:34** | **`C:\Users\Ming\.dsh\profiles\web\package.json` 被修改**（即把 `dsh-dnd` 写进 `dsh.profile.bundles`） |

`dsh.profile.bundles` 是**启动时读取**的组合输入。把 `dsh-dnd` 加进 bundles 列表的动作
（11:41）**晚于**进程启动（11:00）。因此：

- **当时那个进程的 cordis 树里根本没有 `dsh-dnd` 这个 row** —— 路由自然没人注册，
  SPA fallback 返回 404 空体（正是 `lib/index.js:239` 的 `res.writeHead(404); res.end()`）。
- 但 `dnd_*` 工具在当时也应该是**没有的** —— 这一点无法回溯验证，因为当时的进程已经不在。

而现在这个进程（即我实测的进程）**晚于 11:41**，所以它读到了更新后的 bundles 列表，
`dsh-dnd` 被正确加载 —— 一切正常。

> **重要修正**：handoff 文档里「运行中的进程（PID 41808，启动于 11:00:55）晚于构建产物
> （`lib/client.js` 写于 11:00:44），所以不是『改了没重启』」这个推理**方向反了**。
> 它比的是「进程 vs 构建产物」，而真正决定加载与否的是
> **「进程 vs `dsh.profile.bundles` 的修改时间」**。
> 进程晚于产物、却早于「把插件挂进 profile」的那一刻 —— 这正是「改了没重启」，
> 只不过是**配置层**的改动，不是代码层的。

### 另一个被排除的嫌疑：缺少 `client.js.map`

`lib/` 下只有 `client.js`，**没有 `client.js.map`**。曾怀疑这会让 modules loader
在 boot 时抛 `MissingClientBundleError`。

**已排除**：graph 行带有有效 `rev`（`...-58`），而 `rev` 正是
`artifactRevision(bundle, sourceMap)` 读成功后才写上的；`client-modules` 也确实
解析出了 `clientPath`。缺 map 不影响挂载。

（附带发现：`client-modules/lib/index.js:253` 只有在**提供** sourcemap 时才走
`/plugins/<id>/client.js.map` 的路径重定位；没有 map 就没有这条路径。故不影响。）

---

## 五、需要人工执行的验证（**未验证项**）

以下结论**本轮不能自行验证**，因为验证它必须重启 harness，而任务禁止（会中断会话）。
**请不要把下面的内容当成已完成**：

1. **重启后 `/dnd/characters` 是否仍返回 200。**
   预期：是。因为当前进程已经是在 bundles 更新之后启动的，重启只是重放同一组合。

2. **Client 面板是否真的出现在浏览器里**（⚔ 按钮 + 浮层数据）。
   这是任务 2 的范围，本轮只证明了 roster 与 bundle 可达。

复现命令（无需重启，随时可跑）：

```powershell
# 期望 HTTP 200 且 ok=true
Invoke-WebRequest http://127.0.0.1:3080/dnd/health -UseBasicParsing | Select-Object StatusCode,Content

# 期望 HTTP 200，~2790 字节，campaign=morgansfort
Invoke-WebRequest http://127.0.0.1:3080/dnd/characters -UseBasicParsing | Select-Object StatusCode,RawContentLength
```

> **注意**：直接用 `Invoke-WebRequest http://127.0.0.1:3080/` 取页面会得到 **401**，
> `/plugins/*` 未带浏览器 cookie 时全部 **404**（连内置插件也一样）。
> 这是鉴权行为，**不是**插件故障 —— 排查时不要被它误导。

---

## 六、本轮为什么没有补丁

**没有可修的东西。** 具体地：

- `webServer` 名字正确、存在、路由表里两条 `/dnd/*` 都在；
- `ctx.inject(['webServer'], (webCtx) => webCtx.effect(...))` 的写法**与平台自带插件一致**
  （`dsh-client-connection/lib/index.js:758`、`dsh-client-modules/lib/index.js:480-488`
  用的是同一形态），并且 `dsh-client-modules:487` 还给出更强的写法
  —— 先 `ctx.get('webServer')` 判空、没有再 `ctx.inject`。**当前写法在真机上生效了**，
  不需要改；
- 14 个工具全部注册，client roster 有 `dsh-dnd` 行；
- `node test/routes.test.mjs` 13 条断言全绿。

按「最小改动」要求，**强行改一处没有坏的地方，只会制造回归风险**。
所以本轮交付的是根因说明，不是 patch。

### 唯一值得记录的加固建议（**未实施，供决策**）

`src/host/index.mjs:124` 目前无条件 `ctx.inject(['webServer'], ...)`。
`dsh-client-modules:487` 的写法是：

```js
if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerWebCarrier)
else registerWebCarrier(ctx)
```

两者**语义等价**（`ctx.inject` 在依赖已存在时会立即执行 callback），
差别只在多一次 `ctx.get` 判空。**不建议改** —— 没有观察到任何失败模式，
这属于风格偏好而非缺陷修复，会违反「不做顺手重构」。

---

## 七、验证方法学（本轮用过、值得复用的手段）

**「在运行中的进程里读活状态」比读日志、比读配置、比读代码都权威。**

配置（`package.json` / `cordis.yml` / `cordis.patch.yml`）只说明**意图**；
代码只说明**会怎么注册**；只有进程内的服务对象说明**实际注册了什么**。

本轮通过一个临时 Cordis 动态插件读取了三个服务的实时状态
（`webServer` 路由表、`clientModules` roster、`tools` schema），
用完即 `cordis_undefine` 删除，未在磁盘留下任何痕迹，也未改动 profile。

踩到的坑（供下次省时间）：

- 动态插件的 sandbox **不暴露 `ctx.logger`**，也**不能手写 tool 定义** ——
  必须用 `harness.defineTool(...)` 返回的 tool 才能 `ctx.tools.register`。
- `defineTool` 的 `parameters` 根 schema 是开放的，
  `additionalProperties: false` 会被拒；`output.schema` 同理要求显式 `additionalProperties: true`。
- `execute` 的返回值必须是**无损 JSON**：`undefined` 字段会让调用报
  `must be lossless JSON data`。读 `clientModules` graph 行时 `immediately`
  恰好是 `undefined`，需要显式归一化。

---

## 八、数据安全声明

- 未修改 `.agents/skills/dnd/`；
- 未执行任何 git 写操作（`commit` / `tag` / `push`）；`HEAD` 仍为 `a8e563c`，tag 仍只有 `v0.1.0` / `v0.2.0`；
- 未修改 profile 目录 `C:\Users\Ming\.dsh\profiles\web`
  （`package.json` mtime 仍为 11:41:34，`cordis.patch.yml` 仍为 09-17 18:08）；
- 未重启 harness / web profile；
- 对 `campaigns/morgansfort/` 只读，实测哈希与 handoff 记录一致：
  - `alice.md` = `109c048c…6370DB`
  - `alice.state.json` = `fefd308e…F348A5`
  - `.runtime/active-campaign.json` 前 3 字节仍为 `239,187,191`（BOM 完好），26 字节；
- DSH 安装目录**只读**。

### 本轮**唯一**改动的文件

`docs/harness/ROOT-CAUSE-404.md`（本文件）。

> **工作区里另有他人的改动，勿误记到本轮名下。**
> `git status` 在 12:21 显示：
> `M src/host/tools/track.mjs`、`M lib/host/tools/track.mjs`、`M package.json`、
> `?? scripts/concurrency-scenario.mjs`。
> 这些文件的 mtime 为 12:13–12:18，属于**并行的任务 3**
> （写入工具的并发防护）执行者的工作。本轮只写了本文件。
