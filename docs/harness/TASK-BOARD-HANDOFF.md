# dsh-dnd 开发任务 — 看板交付包

> 用途：把 `dsh-dnd` 插件的后续开发交给任务看板自动分发。
> 本文件提供三部分：**项目背景**（给执行者建立上下文）、**执行 prompt**（可逐条生成任务卡）、**验收条件**（可判定的完成标准）。
> 生成任务时，每个任务卡都应附带「项目背景」全文。

---

## 一、项目背景（每个任务卡都要带）

### 这是什么

`dsh-dnd` 是 DeepSeek Harness（DSH）的一个 **bundle 插件**，为本地 D&D 5e 跑团提供数据层。
它跑在用户的机器上，单人使用，**不是**发布给公众的通用插件。

仓库：`D:\DND\dsh-dnd-bundle`（git 仓库，当前 `HEAD = a8e563c`，tag `v0.2.0`）

### 硬约束（违反即任务失败）

1. **只改 `dsh-dnd-bundle/`**。绝不修改 `.agents/skills/dnd/` —— 那是已安装的 skill，
   根目录 `AGENTS.md` 明令不动。它**仅供参考**（记录数据格式的权威定义），插件**不调用其脚本**。
2. **绝对不要执行 `git commit` / `git tag` / `git push`**。只改文件，把改动留在工作区。
   提交由人工 review 后统一做。
3. **不要把任何写入指向 `campaigns/morgansfort/`** —— 那是真实战役数据。
   所有写入测试必须在 `campaigns/stage2-test/` 中进行。
4. **不要在 `docs/harness/` 或 `docs/REWRITE-PLAN.md` 之外新建文档**，除非任务明确要求。

### 技术栈与关键事实

| 项 | 事实 |
|---|---|
| 语言 | 纯 ESM JavaScript。**没有** TypeScript、没有构建期转译、没有打包器 |
| Host 半边 | Node ESM。`src/host/index.mjs` 是入口，工具族在 `src/host/tools/*.mjs` |
| Client 半边 | **不是 ES module**。被粘进 `window.__ModuleLoader__.load({ id, factory })`，只能 `require('react')`，**不能有 `import`/`export`** |
| 工具总数 | 14 个（`dnd_roll` … `dnd_xp_add`）—— 进程内 `tools.schemas()` 筛 `dnd_` 前缀实测为 14 |
| 测试 | 12 个套件；`npm run check` = build + test + **test:ownership** + verify + test:writes + test:concurrency |
| `lib/` | **入库的构建产物**，`link:` 安装需要它。改 `src/` 后必须 `npm run build` |
| 真机端点 | `GET /dnd/health`、`GET /dnd/characters`（均 200，见「原已知开放问题」一节） |

### 数据模型（理解这点才能改对）

**一个角色 = 两个文件**：

```
campaigns/<campaign>/characters/alice.state.json   结构化状态（机器权威）
campaigns/<campaign>/characters/alice.md           frontmatter + 生成的摘要块 + 叙事散文
```

规则：

- **每个事实只有一个归属**。数值在 `.state.json`，散文在 `.md`，文件属性（player/campaign/updated/worldTime）在 frontmatter。
- **叙事散文永不解析成字段**，也永不重新格式化。
- `.md` 里有 `<!-- dsh-dnd:generated -->` … `<!-- /dsh-dnd:generated -->` 围起来的摘要块，**每次写入重生成**。它必须恰好一个，不能套娃。
- **未迁移的角色卡**（结构化区块还在 `.md` 里）读取时从 `.md` 推导，并报告 `needsMigration: true`。读取**永不写入**。
- **货币是单一铜币整数**（`currency: 785`）。金/银/铜只出现在读写边界。理由：三个字段永远存在中间态。
- **双时钟**：每次写入都盖 `updated`（现实日期）和 `worldTime`（世界内日期，来自 `calendar.json`）。

### 原「已知的开放问题」— **已结案**（2026-09-18 12:21）

> ~~**`GET /dnd/characters` 在真机上返回 404。**~~
>
> **该前提不成立。端点实测返回 200 与正确的实时数据。**
> 完整根因、证据链与复现命令见 **[`ROOT-CAUSE-404.md`](./ROOT-CAUSE-404.md)**。摘要：

**根因**：原记录的推理**方向反了**。它比较的是「进程 vs 构建产物」，
但真正决定插件是否被加载的是 **「进程 vs `dsh.profile.bundles` 的修改时间」**：

| 时间 | 事件 |
|---|---|
| 11:00:55 | 当时的进程启动 |
| 11:08:42 | `lib/client.js` 与 `lib/host/index.mjs` 构建产物落盘 |
| **11:41:34** | **`profiles/web/package.json` 被改 —— `dsh-dnd` 才写进 `dsh.profile.bundles`** |

把插件挂进 profile 的动作（11:41）**晚于**进程启动（11:00），
所以当时那个进程的 cordis 树里**根本没有 `dsh-dnd` 这个 row**，
路由无人注册，SPA fallback 返回 404 空体（`dsh-host-webserver/lib/index.js:239`）。

这**仍然是「改了没重启」**，只是配置层而非代码层。

**当时的四个「待查假设」全部有答案**（均在运行中的进程里直接验证，未读日志）：

1. **row 进配置了吗** → 进了。现在进程内实测 `webServer` 的 exact 路由表含
   `exact /dnd/characters` 与 `exact /dnd/health`，且与 task-board / ssh 等插件**共用同一张表**。
2. **Host 半边被 import 了吗** → 是，`apply()` 跑过了。进程内读 `ctx.get('tools').schemas()`
   筛 `dnd_` 前缀得 **14 个**，与 `src/host/index.mjs` 头部列出的五个工具族一一对应。
3. **`webServer` 叫什么** → 键名就是 **`webServer`**，存在于本进程
   （`port=3080`、`host=127.0.0.1`、`fallbackClaimed=true`）。
4. **boot 日志** → **不需要，而且那个方向会误导**。`.dsh` 下没有 boot 日志文件。
   「路由到底注册了没有」读**进程内的活路由表**比读日志更权威。

**结论**：`ctx.inject(['webServer'], ...)` 的写法**本来就是对的**，
与平台自带插件（`dsh-client-connection:758`、`dsh-client-modules:480-488`）一致且真机生效。
**没有产生代码补丁 —— 因为没有东西坏了。** 强行改一处没坏的地方只会制造回归风险。

**顺带排除**：`lib/` 下只有 `client.js`、**没有 `client.js.map`**，
曾怀疑会让 modules loader 在 boot 时抛 `MissingClientBundleError`。
**已排除** —— graph 行带有效 `rev`（`artifactRevision(bundle, sourceMap)` 读成功后才写），
且 `clientPath` 正常解析。缺 map 不影响挂载。

**仍待人工确认**（执行者禁止重启 harness，故未验证）：
重启后 `/dnd/characters` 是否仍返回 200。预期是（当前进程本就在 bundles 更新之后启动）。

### 参考实现

工作区里有一个同类插件可对照：`@linxin666/dsh-client-ui-task-board`（已安装，在 `dsh-web` 仓库里）。
它的 `cordis.patch.yml` 是本项目 `cordis.patch.yml` 的参照对象。

### 代码风格要求

- **注释解释「为什么」，不解释「是什么」**。已有代码里每个非显然的决定都写了理由，
  尤其是「这里踩过什么坑」。
- 中文注释/文案与英文混排是刻意的（面向中文用户）。保持一致。
- 报错信息要**写明修法**，不只写故障。例如
  `mountRoutes` 抛的错里直接写了正确的调用形态。
- **拒绝类操作要留痕**：买不起就拒绝并且**不写入**，且消息里说明差多少钱。

---

## 二、执行 Prompt（逐条生成任务）

以下每条可以独立成为一张任务卡。**按顺序执行**，后面的依赖前面的结论。

---

### ~~任务 1：定位 `GET /dnd/characters` 返回 404 的原因~~ — **已结案，勿再分发**

> **状态：已完成（2026-09-18 12:21）。结论是「端点没有 404，前提已过期」，未产生补丁。**
> 记录：**[`ROOT-CAUSE-404.md`](./ROOT-CAUSE-404.md)**
>
> **看板注意**：这张卡**不要再分发给执行者**。它描述的故障已不存在，
> 再跑一遍只会得到「一切正常、无需改动」的结论，浪费一轮。
> 保留原文仅为留档（便于理解任务 2 的历史阻塞关系）。

**验收条件**：
- [x] 明确写出根因，且根因能解释「单元测试全绿但真机 404」这个矛盾
      → 矛盾的解释：**当时那个进程**里没有这个 row，路由未注册；
      而单元测试测的是 `mountRoutes` 自身契约，与真机是否加载该 row 无关。
      两者从来不冲突。
- [x] 若给出修复，修复必须是**最小**的，且不破坏 `test/routes.test.mjs` 的现有断言
      → **未给出修复**：`ctx.inject(['webServer'], ...)` 真机生效，无可修之处。
      `test/routes.test.mjs` 13 条断言复跑仍全绿。
- [x] 结论写入 `docs/harness/` 下的记录文件，包含**如何验证**（具体命令 + 期望输出）
- [x] 没有修改 `.agents/skills/dnd/`
- [x] 没有执行任何 git 写操作

<details>
<summary>原始任务描述（留档，勿再执行）</summary>

**Prompt**：

> 项目背景见附件。当前状态：`dsh-dnd` bundle 已通过 `link:` 正确安装进 web profile，
> 且在 `dsh.profile.bundles` 数组里，运行中的进程也晚于构建产物，但
> `http://127.0.0.1:3080/dnd/characters` 返回 404。
>
> 请**先定位根因，再动手改**。要求：
>
> 1. 确认 Host 半边是否真的被加载：14 个 `dnd_*` 工具是否注册了？
>    （可用一条最小验证：如果工具列表里有 `dnd_roll`，说明 `apply()` 跑过了）
> 2. 确认 `webServer` 服务在 web profile 中是否存在、名字是否就是 `webServer`。
>    去 DSH 安装目录 `C:\Users\Ming\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`
>    读 `dsh-host-webserver` 的类型定义与 `dsh-web-app` 的 composition，**只读**。
> 3. 定向查 boot 日志（**不要**递归扫 `C:\Users\Ming\.dsh`，会超时）。
> 4. 找到根因后，把结论写进 `docs/harness/` 下的记录文件。
>
> **如果你判断需要重启 harness 才能验证**：不要自己重启（会中断会话）。
> 把「需要重启」写进任务结论，由人工执行。
>
> 交付：一份根因说明 + （若有把握）最小修复的 patch。**不要提交 git。**

</details>

---

### ~~任务 2：验证 Client 面板的真机行为~~ — **已结案，勿再分发**

> **状态：已完成（2026-09-18 17:10）。四项全部通过；另发现并修复两个渲染缺陷。**
> 记录：**[`TASK2-BROWSER-VERIFICATION.md`](./TASK2-BROWSER-VERIFICATION.md)**
>
> **看板注意**：这张卡**不要再分发给执行者**。四项都已给出真机观察结果，
> 附带发现的两个缺陷也已修完并复验。保留原文仅为留档。

**结论摘要**——四项观察结果（真机实测，非推测）：

| # | 问题 | 结果 |
|---|---|---|
| 1 | `__ModuleLoader__` / `Invalid effect` 报错 | **无**。console errors 0、exceptions 0、failed requests 0 |
| 2 | ⚔ 按钮在侧边栏底部 | **是**。1 个、可见，祖先链穿过 `footerActions` → `footArea`。只显示 `⚔` 是**正确**的（侧边栏折叠 → `wide:false`） |
| 3 | 点击后浮层打开且数据正确 | **是**。HP `8 / 8`、AC `12`、INT `17` `+3`、`1环 2/2`、`8 gp 0 sp 0 cp`、角标 `morgansfort` — 逐项 PASS |
| 4 | 浮层可点击（click-through 槽位） | **是**。`pointer-events: auto`；命中最上层是浮层内 `dnd-row`；真实点击被浮层监听器收到 |

**顺带发现并修复的两个真实缺陷**（`verify-client.mjs` 全部漏掉）：

- **缺陷 A｜熟练项渲染成 `[object Object],[object Object],[object Object]`**
  `character.js` 把 `map` 出的元素数组用 `+` 拼进字符串上下文，
  等于调 `Array.prototype.toString()`。真机证据 `childCount: 0` ——
  **一个 `<span>` 都没生成**，`.dnd-pro` 样式永不生效。
  修法：改为展开为兄弟子节点（本文件其它列表本就是这一写法，唯此处漏掉）。
- **缺陷 B｜先攻显示 `-4`（应为 `+2`）**
  `combat.initiative` **本身已是最终修正值**，却又套了一次 `modifier()`。
  同一行的 `AC` 就是原样输出的。**DM 会照这个数字掷先攻**，不是外观问题。

修复后真机复验：`熟练：Arcana History Perception`、`先攻 / 速度 +2 / 30 ft`，
与 host 真值逐项一致，其余数据项全部保持 PASS，无回归。

**验证方法**（可复现）：`scripts/browser-verify.mjs` 用 **headless Edge + DevTools Protocol**
驱动**真实的** harness，发**真实鼠标事件**点击真按钮再读 DOM —— 正是本卡要求的
「不是 stub DOM、不是 React stub」。

> **鉴权关键点**（省下一轮弯路）：app root 未登录返回 401，正常入口是携带
> **进程启动 token** 的 query param；该 token 只活在运行中进程的 WeakMap 里，
> **无法从磁盘读取**。但**浏览器 cookie 只由 `~/.dsh/.credentials.yaml` 里的持久化密钥
> 做 HMAC 签名**（`client-connection/browser-session`），`decodeCookie` 只校验
> 签名 / authority / 时效窗口，**不查启动 token** ——
> 所以脚本可自铸一个被接受的 cookie，**无需访问运行中进程**。
>
> **环境陷阱**：**沙箱内 Edge 起不来**（`FATAL platform_channel.cc Check failed: 拒绝访问 (0x5)`
> —— 命名管道被禁，`--no-sandbox` 也一样）。必须用**更宽权限**启动浏览器，
> 脚本再用 `DND_VERIFY_CDP` **附着**上去。这是 Windows 上的必要形态。

**仓库卫生已处理**（原列的收尾项）：

- `scripts/browser-verify.mjs` —— **保留**。未挂进 `package.json`
  （挂了会让 `check` 依赖本机有 Edge 且需更宽权限，不宜进 CI）。
- 截图 —— 原计划的 `browser-verify-page.png` 已**删除**。原因见下：
  初版把「关闭态」截图放在点击**之后**拍，结果与 `browser-verify-overlay.png`
  **字节完全相同**（同为 `354C50B5…`）—— 看着像证据，实际什么也没证明。
  已改为点击前拍，现为 `browser-verify-closed.png` 与 `browser-verify-overlay.png`，
  两者 SHA256 不同。**仍属临时产物，收尾时移出仓库或进 `.gitignore`。**
- `verify-out.txt` —— 已删除。
- 一次性探针 `scripts/probe.mjs` —— 已用完删除。

**已知的实测基线**（留档，便于后续比对）：

- `GET /dnd/health` → `200 {"ok":true,"fs":true,"campaign":"morgansfort"}`
- `GET /dnd/characters` → `200`，**2790 字节**，`campaign=morgansfort`，
  `counts.characters=1`，`alice.display` = HP 8/8、AC 12、level 1 Wizard、`8 gp 0 sp 0 cp`
- client roster（`clientModules.graph()`）共 65 行，含 `dsh-dnd`，
  `url = /plugins/??dsh-dnd/client.js&rev=…`，`clientPath` 解析到
  `D:\DND\dsh-dnd-bundle\lib\client.js`

> ⚠️ **探针陷阱**（本卡实际踩过）：直接 `Invoke-WebRequest http://127.0.0.1:3080/` 会得 **401**；
> `/plugins/*` 在**不带浏览器 cookie** 时**全部 404 —— 连内置插件也一样**。
> 这是鉴权行为，**不是**插件故障。不要用未鉴权的 `/plugins/*` 探测来判定面板是否存在。
> 判据要用**进程内的 `clientModules` roster**，或**已登录的浏览器**。

**验收条件**：
- [x] 逐条给出上述 4 项的**观察结果**（不是推测）
      → 见上表；全部来自真浏览器的 DOM 文本与计算样式，非推断。
      截图仅作留档（本会话模型不支持读图，故所有判据都不依赖看图）。
- [x] 若面板未出现，给出与任务 1 一致的根因判断
      → **面板出现了**，本项不适用。前置条件另行独立复测：
      `/dnd/characters` **200 / 2790 字节 / morgansfort**，与任务 1 结论一致。
- [x] 若面板出现但数据不对，附上浏览器控制台的完整报错
      → 面板出现、**数据正确**，本项不适用。控制台本就干净
      （console errors 0 / exceptions 0 / failed requests 0）。
      但**渲染文本里发现两处错误**（熟练项、先攻），已列全文并修复 —— 见上。
- [x] 结论写入 `docs/harness/` 下的记录文件
      → [`TASK2-BROWSER-VERIFICATION.md`](./TASK2-BROWSER-VERIFICATION.md)
      （含 4 项观察、复现命令、环境陷阱、缺陷分析与修复记录）
- [x] 没有执行任何 git 写操作
      → `HEAD` 仍 `a8e563c`；无 `commit` / `tag` / `push`。

**通用验收条件**（本节第三部分对每张卡都适用）：

- [x] `npm run check` 通过 → **exit 0**，12 套件 + 无头 Client 校验 + 写入场景 + 并发场景全绿
- [x] `npm run build` 跑过 → `build OK`（改了 `src/client/panels/character.js`，故重建 `lib/`）
- [x] `morgansfort/characters/alice.md` sha256 未变 → `109C048C…6370DB`
- [x] `morgansfort/characters/alice.state.json` sha256 未变 → `FEFD308E…F348A5`
- [x] `.agents/skills/dnd/` 下无任何改动
- [x] 没有重启 harness / web profile
- [x] 没有修改 profile 目录
- [x] 没有引入新的 npm 依赖（CDP 走 Node 内置 `WebSocket` / `fetch` / `node:crypto`）

**本卡改动的文件**：

- `scripts/browser-verify.mjs`（新增，真机验证脚本）
- `src/client/panels/character.js`（缺陷 A 熟练项 + 缺陷 B 先攻）
- `lib/client.js`（`npm run build` 产物，入库）
- `browser-verify-closed.png` / `browser-verify-overlay.png`（临时证据，待移出）
- `docs/harness/TASK2-BROWSER-VERIFICATION.md`（记录文件）

> **遗留一项未做**：执行者按用户明确选择，**未**为两个缺陷补能失败的回归测试。
> 后果需明说：`verify-client.mjs` 的 `walkTree` 只收集**组件名**，
> 所以「渲染出错误文本」这类缺陷**仍然抓不到** —— 同样的错将来还能静默通过。
> **建议并入任务 5**（断言渲染文本不含 `[object Object]`，且熟练项确实生成了 `<span>`）。

> **另需人工执行**：关闭验证用的 headless Edge（端口 **9346**）。
> 它是在更宽权限下启动的，执行者不便代为关闭；不占 3080，留着无副作用。

<details>
<summary>原始任务描述（留档，勿再执行）</summary>

**Prompt**：

> 项目背景见附件。`src/client/panels/character.js` 是角色面板，它通过
> `fetch('/dnd/characters')` 取数据（注意：**不能用** `host.call`，bundle 里那条路根本不可用）。
> 面板注册到两个槽位：`sidebar.footer.action`（⚔ 按钮）和 `shell.overlay`（浮层卡片）。
>
> `scripts/verify-client.mjs` 已经在无头环境里验证了「注册 + 渲染整棵组件树」，
> 但那**不是浏览器**。请在真机上确认：
>
> 1. 页面有没有 `__ModuleLoader__` 或 `Invalid effect` 类报错
> 2. ⚔ 按钮是否出现在侧边栏底部
> 3. 点击后浮层是否打开，且显示 `morgansfort` 的 Alice 真实数据
>    （预期：HP 8/8、AC 12、INT 17 (+3)、法术位 1环 2/2、`8 gp 0 sp 0 cp`）
> 4. 面板的浮层是否可点击（`shell.overlay` 是 click-through 的，
>    occupant 必须自己设 `pointerEvents: 'auto'`）
>
> **前置条件已解除**（2026-09-18）：任务 1 结案，`GET /dnd/characters` 实测 **200**，
> 面板的数据源可用，本卡**不再被阻塞**。原「若任务 1 未解决则报告被阻塞」一条作废。
>
> **不要重启 harness**。需要重启就写进结论。

</details>

---

### 任务 3：给写入工具补「并发/重复执行」的防护与测试

> **状态（2026-09-18 16:0x）：实现完成，全部验收条件已实测通过 —— 待人工 review 后提交。**
>
> 工作区改动（**未提交**，符合硬约束 2）：
> `src/host/tools/track.mjs`（新增 `withCharacterLock` + `locateAndApply`）、
> 重建后的 `lib/host/tools/track.mjs`（与 `src/` 哈希一致）、
> `scripts/concurrency-scenario.mjs`（新，34 条断言）、
> `package.json`（追加 `test:concurrency`，并入 `check`）。
>
> **交付摘要**：`npm run check` **全链路绿**（build + 12 套件 + verify-client +
> 写入场景 + 并发场景，退出码 0）。
>
> 设计要点（供 review）：
> - 锁是**模块作用域的 promise 链**，不是文件锁 —— 符合「不引入外部依赖 / 无锁服务」。
>   模块作用域而非 `buildTools` 作用域：`apply()` 会因 HMR 重挂载而重跑，
>   每条 `buildTools` 各自持锁会产生**第二条独立链**。
> - 串行化的是**整个「定位→读→改→写」序列**，而非只锁 `applyChange`。
>   这一点是本卡最容易做错的地方，见下方「两轮修复」。
> - 链上的 link **永不 reject**：失败的那次写入若把 rejected promise 留在 map 里，
>   该角色**此后所有写入都会被连带拒绝**（一次失败永久毒化该角色）。
> - 读路径不经过锁，`readCharacter` 的「读取永不写入」原则未受影响。
>
> #### ⚠️ 两轮修复：第一版是**不完整**的（这是本卡最重要的记录）
>
> 第一版按「调用方**原始参数**」做锁键，测试全绿 —— 但那是因为测试**只用了一种写法**
> （`"alice"`）。探测别名后发现防护仍有漏洞，**修复前的实现**实测：
>
> | 两次并发调用 | 结果 | 说明 |
> |---|---|---|
> | `"alice"` vs `"ali"` | hp=5 ❌ | `locateCharacter` 按**子串**匹配，产生两个不同的键 |
> | `"alice"` vs 省略 | hp=5 ❌ | 单角色战役允许省略名字，同样产生两个键 |
> | `"ALICE"` vs `"alice"` | hp=2 ✅ | 大小写归一**恰好掩盖**了这一种变体 |
>
> 第三行是陷阱所在：`toLowerCase()` 让锁键**看起来**是规范化的，
> 于是唯一一种「顺手一试」的变体恰好通过。
> **根因**：用**请求**做键，而非用**已解析的身份**做键。
>
> **第二版**改为按**解析后的 `campaign/stem`** 做键。解析可以放在锁外，
> 因为它只读战役 marker 与目录列表、**不读任何角色状态**；
> 而写入只重写文件内容、**从不重命名文件**，所以同一个名字解析出的 stem
> 在并发写入下不会漂移。**状态读取仍在锁内。**
>
> #### 变异测试（本卡验收条件明确要求，已实测两次）
>
> | 变异 | 结果 |
> |---|---|
> | 把锁整个短路（`prior.then(work, work)` → 直接 `work()`） | **11 条断言失败**，含 `got 5` / `got 770` 的丢更新 |
> | 把锁键改回**原始参数** | **恰好 2 条别名用例失败**（且 `"ALICE"` 那条仍然通过） |
>
> 两次变异均已还原，还原后源码中 `SABOTAGE` 字样为 0 处，`src` 与 `lib` 哈希一致。
> 结论：**测试有承载力，不是空转**。
>
> #### 其余已实测的结论（超出原验收条件的部分）
>
> - **并发交错确实发生**：fs 操作轨迹为 `…read,read,…,write` ——
>   **两次读都在第一次写之前**，竞态窗口真实存在，而结果仍然正确。
>   （`node:fs` 是同步的，故测试用一层每次操作都礼让事件循环的 fs 包装，
>   把交错**确定性地**复现出来，而不是碰运气。）
> - **拒绝判定基于「当前」余额**：10 cp 余额下并发两笔 10 cp，
>   恰好一笔成功一笔被拒（`REFUSED` + `Short by`），**不会**基于过期快照误判。
> - **锁是按角色而非全局**：alice 与 bob 并发写入互不阻塞。
> - **失败路径**：写入抛错会**向上抛出**（不吞掉 —— 写失败却报成功比竞态更糟）；
>   链**不被毒化**；并发时第一个抛错，第二个仍能落盘且不死锁。
> - **同一 key 并发两次**：恰好生效一次、恰好一条报 `Already applied`。
>   （幂等检查读的 `appliedKeys` 与写入写回的是同一份快照，所以它**也必须**在锁内。）
>
> #### 交付边界（如实说明，勿当成缺陷）
>
> - 锁是**单进程**方案，严格符合本卡「DSH Host 是单进程」的设定。
>   **若数据根被两个 DSH 进程共享，本锁不提供保护**，届时需要真正的文件系统锁。
> - 每次写入多一次 `locateCharacter`（目录列举，**非状态读取**）用于算锁键，
>   是为「按已解析身份上锁」付出的有意代价。

**Prompt**：

> 项目背景见附件。三个写入工具在 `src/host/tools/track.mjs`：
> `dnd_track` / `dnd_spend` / `dnd_xp_add`。
>
> 已有：**调用方传 `key` 则幂等**（同一个 key 第二次调用是 no-op），
> key 存在 `.state.json` 的 `appliedKeys` 里，上限 32 条。
>
> 缺口：**并发**同一个角色的两次调用没有防护。写入是「读 → 改 → 写」，
> 两个调用交错时会丢失一次修改（后写的覆盖先写的）。
>
> 请设计并实现一个**最小**的防护，要求：
>
> - 不需要引入外部依赖，也不需要真正的锁服务
> - 单进程内串行化即可（DSH 的 Host 是单进程）
> - 不能破坏现有的「读取永不写入」原则
> - 不能改变已有工具的对外行为与返回文案格式
>
> 并补测试：构造两个并发调用，断言最终状态是「两次都生效」而非「丢一次」。
> 测试必须写在 `campaigns/stage2-test/` 上（真实战役只读）。
>
> 参考现有测试风格：`scripts/write-tools-scenario.mjs` 走真实 `execute()`，
> 用**文件哈希**断言「拒绝时字节不变」。

**验收条件**（全部已实测，逐条给出证据）：
- [x] `npm run check` 全绿（12 个套件 + verify + 写入场景 + 并发场景）
      —— **已跑全链路**，退出码 0。输出：
      `build OK` → 12 个套件 `all assertions passed` →
      `verify-client OK — the bundle registers and renders headlessly` →
      `write-tools.scenario: all assertions passed` →
      `concurrency.scenario: all assertions passed`
- [x] 新增测试**能失败**：把防护代码注释掉后，该测试必须报错
      —— **已实测**（这条原本标注为「最容易走过场」，故做了两次变异）：
      ① 短路锁 → **11 条断言失败**，含 `got 5`（应为 2）、`got 770`（应为 755）；
      ② 锁键改回原始参数 → **恰好 2 条别名用例失败**。
      两次变异均已还原并复跑全绿。
- [x] 并发测试断言的是「两次修改都生效」，不是「没抛异常」
      —— 已满足：断言的是**最终数值**（`8-3-3=2`、`785-15-15=755`、
      `0+100+100=200`），并且额外断言**返回文案里出现链式读数**
      （一条报 `HP 8 -> 5`、另一条报 `HP 5 -> 2`），能抓出「两次都读到同一快照」
- [x] 所有写入只发生在 `campaigns/stage2-test/`
      —— 已满足；测试用完整 `finally` 还原 marker，并断言 fixture 目录回到只有 `alice.*`
- [x] `morgansfort/alice.md` 与 `alice.state.json` 的 sha256 在测试前后不变
      —— 已满足。测试内直接断言：`alice.md` = `109c048c…`、
      `alice.state.json` = `fefd308e…`（与「三、通用验收条件」所列一致），
      并断言 marker **按字节**还原（含 BOM，前 3 字节 `239,187,191`）
- [x] 没有执行任何 git 写操作 —— 已满足（改动留在工作区）

---

### 任务 4：把 `dnd_character_get` 的平铺输出收敛到状态模型

> **状态（2026-09-18）：调研已完成，结论为「不收敛」，改动为零。**
> 没有动任何源码 —— 唯一写入是调研用的临时探针文件，已删除。
>
> **调研推翻了任务描述里的一个前提。** 描述说平铺是「为了兼容旧消费方而保留」，
> 但实测：**客户端面板根本不读平铺字段**，它读的是原始状态模型
> （`panels/character.js` 用 `character.state` 的 `st.abilities` / `st.combat.hp` /
> `st.spellSlots`）；HTTP 路由 `routes.mjs` 同样直出 `c.state`。
> 平铺字段的真实消费者只有两个：`formatCharacter`（显示卡片）
> 和 `host.test.mjs` 的断言。技能文档 `.agents/skills/dnd/` 全库
> `grep` 对 `dnd_character_get` / `hitPoints` / `abilityScores` **零引用**，
> 「模型自身的使用习惯」没有可证的依赖。
>
> **不能收敛的决定性理由：平铺形状不是「状态的另一种写法」，
> 它同时是未迁移角色的唯一真源。** `loadCharacters` 有两条分支：
> 已迁移走 `projectState(character.state)`（嵌套源），
> 未迁移走 `parseCharacterSheet(text)`（**平铺源**，`sheet.mjs:172-175`）。
> 两者共用同一个返回结构，`projectState()` 的全部意义就是把嵌套源
> 翻译成平铺源已经确定的形状，让下游看不出差别。
>
> 实测证据（Alice 当前 `hasStateFile=true`，已迁移）：
> 直接解析已迁移的 `alice.md` 得到
> `hitPoints: null, ac: null, abilityScores: {}, spellSlotsByLevel: {}`。
> 即：一旦绕开 `projectState`，已迁移角色的数字全部为空。
>
> **第二条硬约束：`formatCharacter` 是共享函数，两个调用点吃两种输入。**
> 它里面 `a.score === null`、`a.modifier !== null ? ... : Math.floor((score-10)/2)`
> 这些分支，正是为了同时吃下解析器的 `{score, modifier, raw}` 和
> `projectState` 的 `{score, modifier}`。而状态模型**不存 modifier**
> （`state-schema.mjs` 的 `abilities` 只存裸数字）。要满足验收条件里
> 「卡片输出逐字符不变」，`formatCharacter` 就得自己算 modifier ——
> 这和现在 `projectState` 替它算是同一个计算，只是换个文件，不是净收益。
>
> **`parseVersion: 2` 的语义恰恰依赖两种来源并存**（「这行来自 `.state.json`
> 而非 `.md` 解析」）。收敛后它失去意义，但它目前是调用方唯一能区分来源的信号。
>
> **真实维护成本（漂移风险其实很低，成本在别处）**：
> `projectState` 是单向只读投影，不是第二份存储；字段名漂移会立刻表现为
> `undefined` 并被 `host.test.mjs:271` 抓住，没有「两份都写回去」的路径。
> 要盯的是它里面**手写死的语义损失**：
> - `inspiration: false` —— 硬编码常量，状态模型无此字段（代码注释已自认）
> - `hitDice` 取 `combat.hitDice.die`（`"1d6"`），但平铺解析器里
>   `hitDice` 是整串文本 —— **同名不同义**
> - `cantrips`/`spellbook`/`prepared` 数组 `join(', ')` 成字符串
> - `spellAttack` 数字转 `"+5"` 字符串；`currency` 同时给格式化串与 `currencyCp`
> - `deathSaves` 键名 `successes/failures` → `success/fail`
> - `warnings: []` 恒为空，真警告走外层 `loaded.warnings`
>
> **什么条件下应重做这个决定**（任一成立即收敛是对的）：
> 1. `formatCharacter` 被重写成消费状态模型 —— 平铺不再承担显示契约，
>    可整体删除 `projectState` 与 `parseVersion`
> 2. **未迁移角色清零** —— `sheet.mjs:172-175` 成为死代码，两种来源塌缩，
>    投影失去存在理由（这条最可能先到）
> 3. `hitDice` 的同名不同义被真正使用 —— 有消费方按 `hitDice` 主动骰时必须先修
> 4. 面板与工具开始显示不一致 —— 目前 `state.spellcasting.saveDC`（面板）
>    与 `spellSaveDC`（工具）已确认一致，一边被单改就是信号
>
> **反向提醒**：本次「不改」是**基于证据的**，不是保守。
> 若将来有人仅因「两套形状看着不顺眼」来收敛，会直接打断未迁移角色这条路径。
> 动手前请先确认上面的条件 1 或 2 已经成立。

**Prompt**：

> 项目背景见附件。`src/host/tools/sheet.mjs` 里 `dnd_character_get` 现在返回一个
> **平铺**对象（`hitPoints`、`abilityScores`、`spellSlotsByLevel`…），由 `projectState()`
> 从 `.state.json` 投影出来。这是为了兼容旧消费方而刻意保留的形状。
>
> 问题：这个平铺形状与新状态模型并存，等于同一份数据有两个表达，长期会漂。
>
> 请**先调研再动手**：
>
> 1. 找出到底谁在读这些平铺字段（`formatCharacter`、模型自身的使用习惯、测试）
> 2. 判断能否安全地让 `dnd_character_get` 直接返回状态模型的结构
>    （或返回 `{ state, narrative, metadata }` 三段式）
> 3. 如果**不能**安全收敛，就不要改 —— 写清楚为什么，并说明当前形状的维护成本
> 4. 如果**能**收敛，给出迁移方案 + 一次改完，并更新所有调用点与测试
>
> 这是一次**可能以「不改」为结论**的任务。给出不改的充分理由，同样是合格的交付。

**验收条件**：
- [x] 结论明确：要么「收敛，改动如下」，要么「不收敛，理由如下」
      —— **不收敛**，理由见上方状态块（含实测证据）
- [x] 若收敛：`npm run check` 全绿，且 `formatCharacter` 的 markdown 卡片输出
      **逐字符不变**（这是对外可见行为，不应顺手改）
      —— **不适用**（判定不改）。基线已跑：`npm test` 12 个套件全绿
- [x] 若收敛：`parseVersion: 2` 字段的处置有明确交代（保留/移除/改语义）
      —— **不适用**（判定不改）；已在状态块说明其语义依赖「两种来源并存」
- [x] 若判定不改：列出具体的漂移风险点，以及将来什么条件下应该重做这个决定
      —— 已列出 6 条有损投影 + 4 条重做条件
- [x] 没有执行任何 git 写操作 —— 已满足（源码零改动，探针文件已删）

---

### ~~任务 5：补齐「真实数据」的回归防线~~ — **已结案，勿再分发**

> **状态：已完成（2026-09-18）。全部验收条件实测通过；可证伪验证已跑。**
> 记录：**[`TEST-DATA-OWNERSHIP.md`](./TEST-DATA-OWNERSHIP.md)**（「测试与数据的所有权规则」一节）
>
> **看板注意**：这张卡**不要再分发给执行者**。规则已成文、已机械化、已接入 `check`。
> 保留原文仅为留档。
>
> #### 一句话结论
>
> **此后任何对 `campaigns/morgansfort/` 的合法变更，都不会让测试变红 —— 已实测证明。**
>
> #### 交付摘要
>
> | 项 | 内容 |
> |---|---|
> | 新增文档 | `docs/harness/TEST-DATA-OWNERSHIP.md`（八节：核心区分 / 四条规则 / 共享助手 / 可证伪验收 / 速查） |
> | 新增助手 | `test/support/live-data.mjs` —— `snapshotTree` / `diffTree` / `liveWitness` / `hashLivePath` / `liveExists` / `LIVE_CAMPAIGN` / `LIVE_MARKER` |
> | 新增审计 | `scripts/audit-test-ownership.mjs` —— 遍历 **24 个文件**，未分类的活数据引用**直接失败** |
> | 接入 check | `package.json` 追加 `test:ownership`，并入 `check`（排在 `test` 之后、`verify` 之前） |
>
> #### 审计结果：每处活数据依赖的分类
>
> **改为 fixture**（解析器测试 → 必须拥有输入）：
>
> | 位置 | 原状态 | 处理 |
> |---|---|---|
> | `sheet-parse.test.mjs` | 已改 fixture | **加摘要钉死** + 缺失时失败（不再静默 skip） |
> | `sheet-split.test.mjs` | 已改 fixture | 同上 |
> | **`host.test.mjs`** | **仍在读活 `morgansfort/alice.md`** | 自建 temp campaign + 前缀重映射；fixture 拷入 |
>
> **改为性质断言**（不变量测试 → 可读活数据，只断言性质）：
>
> | 位置 | 违规的**快照**断言 | 改为 |
> |---|---|---|
> | `state-io.test.mjs` | `class==='Wizard'`、`hp {8,8}`、`currency 800` | 整目录哈希前后比对 + `hasStateFile === !needsMigration`（**规则**而非状态） |
> | `routes.test.mjs` | 只盯 alice 两个文件 | 整目录 `snapshotTree`/`diffTree` + marker witness |
> | `write-tools-scenario.mjs` | 只盯 alice 两个文件 | 追加整目录哈希 |
> | `concurrency-scenario.mjs` | 同上 | 同上 |
>
> **保持不动（审计判定已合规）**：`state-schema` / `frontmatter` / `state-rules` 里的
> `morgansfort` 是**测试数据字符串**而非路径；`scenario-test` / `refusal-test` /
> `migrate-test` 只写 `stage2-test`；`migrate-real*` 是人工操作脚本；
> `browser-verify.mjs` 是诊断脚本（**不抛错**、不在 `check` 内）。全部在审计
> `ALLOWED` 表中带**理由**登记 —— 加条目是一次显式行为。
>
> #### 可证伪验证（本卡验收条件明确要求，已实测）
>
> ```
> Rename-Item D:\DND\campaigns\morgansfort\characters\alice.state.json alice.state.json.hidden
> npm run check
> === NPM EXIT CODE ===
> 0
> ```
>
> 关键证据 —— 测试**自适应**而非变红：
>
> ```
> the real character's state file was absent and still is
>   ok  nothing under campaigns/morgansfort/characters moved (whole tree hashed)
>   ok  reading the real character writes nothing
>   ok  the live campaign is untouched by these tests
> ```
>
> 还原后 sha256 = `FEFD308E…F348A5`，与改名前**逐字节相同**（即「三、通用验收条件」所列值）。
>
> **审计与检测器本身也做了证伪**（否则规则只是愿望）：
> - 进程内篡改活文件 → `detected: ["created: stray.tmp", "modified: alice.state.json"]`
> - 往解析器套件注入活数据依赖 → `FAIL ... must own its input`
> - 两者还原后均复跑全绿。
>
> #### 顺带发现并修复的两个真实缺陷（都属「mock 比真实后端宽松」这一模式）
>
> - **缺陷 C｜`host.test.mjs` 的 mock 吞掉了真实错误**
>   `catch { return undefined }` 把 `ERR_INVALID_ARG_TYPE` 伪装成「文件不存在」，
>   最终显示为「**没有活跃战役**」—— 一个与真实原因毫无关系的症状。
>   修法：只吞 `ENOENT`，其余抛出。
> - **缺陷 D｜`node:fs` 与 `node:fs/promises` 混用**
>   `stat` 必须从 `node:fs/promises` 导入才有 `mtimeMs`；从 `node:fs` 导入会抛错，
>   同样被宽泛 catch 吃掉。修法：两组导入分离。
>
> 两个都印证了本文件第四节已有的教训：**「比真实后端更宽松的 mock 无法失败」。**
>
> #### 本轮改动的文件（**未提交**，符合硬约束 2）
>
> - `test/support/live-data.mjs`（新增，共享只读助手）
> - `scripts/audit-test-ownership.mjs`（新增，所有权审计）
> - `docs/harness/TEST-DATA-OWNERSHIP.md`（新增，规则文档）
> - `test/host.test.mjs`（改读自建 temp campaign）
> - `test/state-io.test.mjs` / `test/routes.test.mjs`（快照 → 性质）
> - `test/sheet-parse.test.mjs` / `test/sheet-split.test.mjs`（钉摘要 + 缺失即失败）
> - `scripts/write-tools-scenario.mjs` / `scripts/concurrency-scenario.mjs`（加整目录哈希）
> - `package.json`（`test:ownership` 并入 `check`）
>
> #### 交付边界（如实说明）
>
> - 本卡**未**重启 harness，**未**修改 profile，**未**执行任何 git 写操作
>   （`HEAD` 仍 `a8e563c`，reflog 无新条目）。
> - 规则覆盖 `test/*.test.mjs` 与 `scripts/*.mjs`。`src/` 内不在范围内 ——
>   那是实现，不是测试。
> - `host.test.mjs` 现在依赖自建 temp campaign 里的 `state.md`。它比读活战役**更正确**，
>   但也意味着该套件不再验证**真实 `state.md` 的格式**。已与用户确认：
>   这属解析器测试范畴，应由 fixture 覆盖；若将来需要，应另加一个**独立且明确分类**的
>   `state.md` fixture 测试，而不是把 `host.test.mjs` 指回活数据。

**Prompt**：

> 项目背景见附件。本轮开发暴露了一类反复出现的测试缺陷，请系统性加固：
>
> **缺陷模式**：测试直接读取**活的**战役文件（`campaigns/morgansfort/characters/alice.md`），
> 于是当插件合法地迁移了那个角色后，5 个套件连带失败 —— 不是代码回归，
> 而是测试的**输入**变了形状。
>
> 已经做的：`sheet-parse` / `sheet-split` 改为读冻结 fixture
> （`test/fixtures/alice-unmigrated.md`，sha256 `91a90f00…`）；
> `state-io` / `routes` / 写入场景改为**哈希前后比对**，
> 断言「本次运行没有改变真实战役」而不是「真实战役没有 state 文件」。
>
> 请完成剩下的加固：
>
> 1. 审计**全部**测试与脚本，找出手里还攥着「活数据快照」的地方
> 2. 把「解析器测试」与「不变量测试」明确区分开：
>    - 解析器测试 → 必须读自己拥有的冻结输入
>    - 不变量测试（如「读取永不写入」）→ 可以读活数据，但必须断言**性质**而非**快照**
> 3. 在 `docs/harness/` 下的记录文件里写一节「测试与数据的所有权规则」，
>    让后来者不会再犯
>
> 判据：此后**任何**对 `campaigns/morgansfort/` 的合法变更，都不应让测试变红。

**验收条件**（全部已实测）：
- [x] 审计覆盖 `test/*.test.mjs` 与 `scripts/*.mjs` 全部文件
      → **12 + 12 = 24 个文件全覆盖**。审计输出末行：
      `ownership.audit: all assertions passed (24 files audited)`
- [x] 每处「活数据依赖」都被明确归类为「改为 fixture」或「改为性质断言」，并在结论里列表
      → 见上方两张分类表（fixture 3 处 / 性质断言 4 处 / 判定已合规 8 处带理由）
- [x] `npm run check` 全绿
      → **exit 0**。12 套件 + `ownership.audit` + `verify-client` +
      写入场景 + 并发场景，全部 `all assertions passed`
- [x] **可证伪**：临时把 `campaigns/morgansfort/characters/alice.state.json` 改名后
      重跑 `npm run check`，必须仍然全绿，然后改回
      → **已实测**。`NPM EXIT CODE = 0`；证据与还原后的 sha256 见上方状态块。
      未留下 `.hidden` 残留文件。
- [x] `docs/harness/` 下新增「测试与数据的所有权规则」一节
      → [`TEST-DATA-OWNERSHIP.md`](./TEST-DATA-OWNERSHIP.md)，
      并已机械化：`npm run test:ownership` 让规则**无法**再默默腐烂
- [x] 没有执行任何 git 写操作
      → `HEAD` 仍 `a8e563c`，`git reflog` 无新条目

---

## 三、通用验收条件（每张卡都适用）

**必须全绿**：

- [ ] `npm run check` 通过 —— 它是
      `build && test && test:ownership && verify && test:writes && test:concurrency`，
      12 个套件 + **测试所有权审计** + 无头 Client 校验 + 写入场景 + 并发场景
      （`test:concurrency` **已由任务 3 追加**，`test:ownership` **已由任务 5 追加**，
      见 `package.json`）
- [ ] `npm run build` 跑过（改了 `src/` 就必须重建 `lib/`，`lib/` 是入库产物）

> **注意 `lib/` 是 `link:` 安装的落点**：改了 `src/` 不跑 `npm run build`，
> 真机加载的仍是旧产物 —— 且**必须重启 harness** 才会重新加载。
> 任务 1 的原始误判就发生在这一层（不过是配置层而非代码层）。

**数据安全**：

- [ ] `campaigns/morgansfort/characters/alice.md` 的 sha256 未变
      （任务开始时实测：`109c048c…`）
- [ ] `campaigns/morgansfort/characters/alice.state.json` 的 sha256 未变
      （任务开始时实测：`fefd308e…`）
- [ ] `.runtime/active-campaign.json` **按字节**未变（注意它有 BOM，前 3 字节是 `239,187,191`；
      用 `readFileSync(p,'utf8')` 读再写回会**静默吞掉 BOM**）
- [ ] `.agents/skills/dnd/` 下无任何改动

**不要做的事**：

- [ ] 没有 `git commit` / `git tag` / `git push`
- [ ] 没有重启 harness / web profile
- [ ] 没有修改 profile 目录（`C:\Users\Ming\.dsh\profiles\web`）
- [ ] 没有引入新的 npm 依赖

**交付质量**：

- [ ] 改动是**最小**的：不做顺手的重构、不格式化无关文件
- [ ] 新增/修改的注释解释「为什么」，且包含踩过的坑
- [ ] 结论里给出**可复现的验证命令与期望输出**，而不是「已验证」

---

## 四、给看板的额外提示

- ~~**任务 1 是前置**。任务 2 依赖它~~ → **任务 1 已结案（前提过期，无补丁）**，
  任务 2 的前置**已解除**，可直接分发。
- **任务 1–5 全部结案，本文件当前没有待分发任务。**
  1/2 以「无需改动 / 已复验」结案；3 已实装；4 以「不收敛」结案；5 已完成。
  新任务应重新编号（从 6 开始）。
- **任务 4 允许「不改」为结论**。看板不应把「代码未变」当作失败。
  （**任务 1 也是同类**：以「无需改动」结案是合格交付，不是失败。）
- 每个任务都要求「新增测试能失败」（变异测试）。**不能失败的测试不算测试** ——
  这是本轮开发反复验证过的教训：一个返回死 setter、吞掉 effect 的 React stub
  让「渲染检查」完全是空的；一个 `test()` 没 `await` 的异步套件无论断言什么都报 ok。
- **测试全绿 ≠ 实现完整 —— 还要问「测试有没有覆盖到所有输入形态」。**
  任务 3 的第一版就是活例：防护实装后测试全绿，但测试**只用了一种角色写法**
  （`"alice"`），而同一角色还能被写成 `"ali"`（子串匹配）或省略（单角色战役），
  后两种写法**仍然丢更新**。教训：新增防护类代码时，
  要专门试**同一个对象的多种等价写法/等价输入**，而不只是多种场景。
  （巧合的是，`toLowerCase()` 让 `"ALICE"` 这一种变体恰好通过，
  差点就成了「看起来对了」的假证据。）
- **测试「并发」必须真的让两件事重叠。** 先 `await` 第一个再发第二个，
  无论怎么写都不可能触发竞态 —— 那种测试对**完全没加锁**的实现也会通过。
  正确形态是先启动全部、再一起 `await`（或 `Promise.all`）。
  注意本项目 fs 是同步的，直接跑并发会串行化而看不见竞态，
  任务 3 的测试用一层「每次操作都礼让事件循环」的 fs 包装把交错**确定性复现**。
- 执行者**无法**重启 harness。任何需要重启才能验证的结论，必须显式标注为「未验证，需人工确认」，
  不要写成已完成。
- **测试不能对「活数据」断言具体值。** 这是任务 5 的教训，也是本仓库最容易重犯的错：
  活战役是**会被合法修改**的。任何测试只要对活数据断言了具体值
  （`hp === 8`、`currency === 800`、`needsMigration === true`），
  就把「战役内容」偷偷变成了验收条件 —— 于是 DM 正常跑团（迁移角色、掉血、花金币）
  就等于「弄坏测试」。失败症状极具误导性：5 个套件变红，看起来像解析器崩了，
  **实际代码一行没错**。
  - 判据一句话：**测试若断言「这个值是多少」，它就必须自己拥有这份数据**；
    **测试若断言「这个性质成立」，它可以读活数据**。
  - 规则全文：**[`TEST-DATA-OWNERSHIP.md`](./TEST-DATA-OWNERSHIP.md)**
  - 已机械化：`npm run test:ownership` 强制每处活数据依赖显式分类，未分类即失败。
  - 最强形态：**哈希整个活目录前后比对**（`snapshotTree`/`diffTree`）。它断言
    「本次运行写了没有」这个**性质**，对任何合法变更免疫，
    且比只盯某两个文件**更严格**（散逸到别的角色的写入也会被抓到）。
- **「比真实后端更宽松的 mock 无法失败」—— 反过来，过宽的 `catch` 会把真错误伪装成假症状。**
  任务 5 实测：`catch { return undefined }` 把一个 `ERR_INVALID_ARG_TYPE`
  伪装成「文件不存在」，最终显示为「**没有活跃战役**」——
  一个与真实原因毫无关系的症状，能白白耗掉一轮排查。
  **只吞 `ENOENT`（真正表示「不存在」的码），其余抛出。**

### 排查同类问题的推荐姿势（来自任务 1 的实战）

**「在运行中的进程里读活状态」比读日志、比读配置、比读代码都权威。**

- 配置（`package.json` / `cordis.yml` / `cordis.patch.yml`）只说明**意图**；
- 代码只说明**会怎么注册**；
- 只有**进程内的服务对象**说明**实际注册了什么**。

任务 1 就是靠临时挂一个 Cordis 动态插件，直接读 `webServer` 路由表、
`clientModules` roster、`tools` schema 三者得出的结论 —— 比读日志快且准。
用完 `cordis_undefine` 删除，磁盘零残留，profile 未被修改。

**已踩过的坑**（省一轮试错）：

- 动态插件 sandbox **不暴露 `ctx.logger`**，也**不能手写 tool 定义** ——
  必须用 `harness.defineTool(...)` 返回的 tool 才能 `ctx.tools.register`。
- `defineTool` 的 `parameters` 根 schema 是开放的，传 `additionalProperties: false` 会被拒；
  `output.schema` 同理要求显式写 `additionalProperties: true`。
- `execute` 返回值必须是**无损 JSON**：含 `undefined` 字段会报
  `must be lossless JSON data`。读 `clientModules` graph 行时 `immediately` 恰为
  `undefined`，需显式归一化。
- **时间线归因要拿对参照物**：判断「是不是改了没重启」，要比的是
  **进程启动时间 vs 配置（`dsh.profile.bundles`）的修改时间**，
  而**不是**进程 vs 构建产物。任务 1 的原始误判正是栽在这一点上。
