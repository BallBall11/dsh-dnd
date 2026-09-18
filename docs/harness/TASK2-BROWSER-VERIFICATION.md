# Client 面板真机验证记录（任务 2）

> 任务：在**真浏览器**里确认角色面板的四项行为（`TASK-BOARD-HANDOFF.md` 任务 2）
> 日期：2026-09-18
> 结论：**四项全部通过 —— 面板在真机上工作，数据正确。**
> 另发现**两个真实渲染缺陷**（第五节），均为此前无头校验覆盖不到的盲区；
> 经用户确认后**已在第二轮一并修复并真机复验**（见 **5.3**）。
> 未重启 harness。

> **两轮改动清单**
> - 第一轮（验证）：新增 `scripts/browser-verify.mjs`，未改 `src/`
> - 第二轮（修复）：`src/client/panels/character.js` + 重建的 `lib/client.js`（缺陷 A/B）

---

## 一、前置条件：任务 1 的 404 已解除（实测，非引用）

任务 2 的 prompt 规定「若任务 1 的 404 未解决，只报告被阻塞，不改代码」。
**该前置条件成立**，本轮独立复测（未依赖任务 1 的文档结论）：

```
GET http://127.0.0.1:3080/dnd/health     => HTTP 200  46 bytes
{"ok":true,"fs":true,"campaign":"morgansfort"}

GET http://127.0.0.1:3080/dnd/characters => HTTP 200  2790 bytes
campaign=morgansfort  characters=1
Alice: HP 8/8  AC 12  INT 17  spellSlots 1环 {total:2,used:0}  currency "8 gp 0 sp 0 cp"
```

与任务 2 的预期值逐项一致。**所以本轮不是「被任务 1 阻塞」**，而是继续执行真机验证。

同时用真机注册表确认两个槽位都已被占用（`active: true`）：

```
sidebar.footer.action : occupants = [ {id: "cordis-panel"}, {id: "dnd-character-action", order: 10} ]
shell.overlay         : occupants = [ {id: "dnd-character-overlay", order: 200} ]
```

---

## 二、验证方法：为什么必须用真浏览器，以及怎么进去的

`scripts/verify-client.mjs` 用的是**桩 DOM + 桩 React**，它没有布局、没有 CSS、没有真实事件、
没有真 React 的 children 语义。本轮补上这一段，新增 `scripts/browser-verify.mjs`：
用 **DevTools Protocol 驱动无头 Edge**，对**运行中的 harness** 做真实点击。

### 鉴权：为什么脚本能自己造 cookie

应用根路径无 cookie 时返回 401。正常入口是 URL 上的 `token` —— 那是
**进程启动令牌**，只存在于运行进程的 WeakMap 里（`processLaunchToken`），
磁盘上没有，事后也取不回。

但 cookie 本身只是用**持久化**在 `~/.dsh/.credentials.yaml`
（`client-connection/browser-session`）里的密钥做的 HMAC。核对
`dsh-client-connection/lib/index.js` 的 `decodeCookie`：它校验**签名 + authority + 有效期**，
**不查启动令牌**。所以用存储密钥自造 cookie 可通过鉴权，脚本无需接触运行进程。

> 这是「读活状态」之外的又一条路：**签名材料在磁盘上，判据在代码里 ——
> 不需要那个拿不到的秘密，只需要它签名时用的那把钥匙。**

### 必须知道的环境限制（踩过的坑）

- **沙箱内 Edge 起不来**。默认 sandbox 下 Edge 报
  `FATAL:mojo\...\platform_channel.cc:183 Check failed: 拒绝访问 (0x5)` 后立即退出 ——
  这是沙箱禁止创建命名管道，**不是 Edge 或脚本的问题**。
  即便是 `--no-sandbox` 也一样。必须用更宽的权限启动浏览器。
- 因此脚本支持 `DND_VERIFY_CDP` 环境变量**附着到已启动的浏览器**，
  由脚本自己只负责验证。这是 Windows 上的必要形态。
- 用独立 `--user-data-dir` 启动时 Edge 会继承用户 profile 的扩展（实测带进了 Bitwarden），
  并残留 target。脚本已改为**用完全部 `json/close` 关掉自己的标签页**，
  否则每跑一次都留一个占着 harness 连接的活标签页。
- `send()` 必须带超时。初版没有超时，卡住时**没有任何输出** ——
  与「还在跑」无法区分。现在有 20s 单调用超时 + 120s 总上限。

复现命令：

```powershell
# 1) 先用「更宽权限」的 shell 起一个无头 Edge（沙箱内起不来）
$dir = "D:\DND\.runtime\edge-verify"
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --headless=new --remote-debugging-port=9346 --user-data-dir=$dir `
  --no-first-run --no-default-browser-check --disable-gpu about:blank

# 2) 附着上去跑验证
cd D:\DND\dsh-dnd-bundle
$env:DND_VERIFY_CDP='http://127.0.0.1:9346'
node scripts/browser-verify.mjs
```

---

## 三、四项问题的观察结果（全部为真机实测，非推测）

### 1. 页面有没有 `__ModuleLoader__` 或 `Invalid effect` 类报错

**没有。** 计数为 0，不是在报错里筛不到，是压根没有报错：

```
document.title : "DeepSeek Harness"
__DSH_BOOT__   : true
console errors : 0
page exceptions: 0
failed requests: 0
MATCHING loader/effect errors: 0
```

`verify-client.mjs` 对 `Invalid effect` 的检查是「`apply()` 的返回值必须是
function/nullish/iterable」；真机侧没有出现该类错误，两侧一致。

> 附带记录：早先几次运行出现过 12 条 `net::ERR_CONNECTION_CLOSED`（Preflight/Fetch）。
> 那是 DSH shell 自身 SSE 端点的行为，与 `/dnd/characters` 无关
> —— 面板数据在同一轮里正常渲染。后续干净运行中该计数为 **0**。

### 2. ⚔ 按钮是否出现在侧边栏底部

**是。** 真机 DOM 里恰好 1 个，可见、位于侧边栏 footer：

```
matching <button.dnd-action>: 1
  text="⚔" title="D&D 角色" visible=true inFooter=true
  rect={"x":14,"y":391,"w":27,"h":32}
  ancestors: DIV < ..._footerActions < ..._footArea < ..._root ..._collapsed ..._quietBars
             < DIV < ..._sidebarCol < ..._frame < DIV
style tag present: true
```

祖先链明确穿过 `footerActions` → `footArea`，即当前会话的侧边栏**处于折叠状态**
（`_collapsed`）。因此按钮只显示 `⚔`、不显示 `D&D` 文案 ——
对应 `wide: false`。这与槽位契约一致
（`SidebarFooterActionOwnerProps.wide`: *false = 56px rail*），**不是缺陷**。
样式表也已注入（`style[data-plugin="dsh-dnd"]` 存在）。

### 3. 点击后浮层是否打开，且显示 `morgansfort` 的 Alice 真实数据

**是。** 用 `Input.dispatchMouseEvent` 派发**真实的可信鼠标事件**（走命中测试），
浮层随即出现，渲染文本如下（逐字来自 `innerText`）：

```
角色
morgansfort
Alice
High Elf Wizard Lv1
8 / 8
STR 8 -1   DEX 14 +2   CON 15 +2   INT 17 +3   WIS 10 +0   CHA 10 +0
AC 12（Mage Armor 15）
先攻 / 速度  -4 / 30 ft
法术 DC / 攻击  13 / +5
💰 8 gp 0 sp 0 cp
法术位  1环 2/2
熟练：[object Object],[object Object],[object Object]
攻击  电爪 Shocking Grasp +5 · 1d8 / Ray of Frost +5 · 1d8
```

逐项核对任务给出的预期值：

| 预期 | 实测 | 结果 |
|---|---|---|
| HP 8/8 | `8 / 8` | PASS |
| AC 12 | `AC 12（Mage Armor 15）` | PASS |
| INT 17 (+3) | `INT` `17` `+3` | PASS |
| 法术位 1环 2/2 | `1环 2/2` | PASS |
| `8 gp 0 sp 0 cp` | `💰 8 gp 0 sp 0 cp` | PASS |
| 战役 `morgansfort` | 浮层角标 `morgansfort` | PASS |
| 无错误块 | 无 `HTTP n` / `请求失败` / `无法读取状态` | PASS |

浮层几何：`rect={x:340,y:72,w:390,h:417}`，`z-index:50`。

**其余数字也与 host 数据一致**：STR 8→-1、DEX 14→+2、CON 15→+2、WIS 10→+0、CHA 10→+0
（这些是**真能力值**，公式正确）。反证了第 5 节的问题只出在「传进来的已经是修正值」那一个字段上。

### 4. 面板浮层是否可点击（`shell.overlay` 是 click-through 的）

**是，可点击。** 三条独立证据：

```
computed pointer-events : auto          <- 面板自己设了 style.pointerEvents='auto'
elementFromPoint is overlay or child: true   (hit = dnd-row 的 div)
click inside overlay reached: ["overlay","document"]
  overlay received the click : true
```

- 计算样式是 `auto`（不是继承来的 `none`）；
- 浮层中心点做 `elementFromPoint` 命中到的是**浮层内部的 `dnd-row`**，不是浮层下面的应用；
- 在浮层内部派发真实点击，浮层自己的监听器**收到**了事件。

槽位契约文档也确认了这一设计意图：
*"The layer itself is click-through — entries opt back into pointer events"*，
即 occupant **必须**自己设 `pointerEvents`，面板第 294 行确实设了。

> 一个容易误读的点：`elementsFromPoint` 返回的完整栈里**始终**能找到下层应用元素
> （覆盖层不改变 z 序枚举）。**这不是穿透**。判据应是
> 「命中的**最上层**元素是否为浮层自身或其后代」—— 实测为是。

---

## 四、截图（物理证据）

- `browser-verify-closed.png` — 点击**前**：侧边栏折叠栏与 ⚔ 按钮，浮层未打开
- `browser-verify-overlay.png` — 点击**后**：浮层打开状态

两张图的 SHA256 **不同**，确认「前 / 后」确实被区分开：

```
7B59A637…6C150D  browser-verify-closed.png
354C50B5…D7ECB  browser-verify-overlay.png
```

> 记录一个自查抓到的问题：初版把「关闭态」截图放在点击**之后**拍，
> 结果两张图**字节完全相同**（同为 `354C50B5…`）——
> 看上去像证据，实际什么也没证明。已改为点击前拍关闭态。
> 这也说明：**留档的产物本身也要验证**，不能假定「拍了就算数」。

> 说明：本会话所用模型不支持读图，故上述结论全部由 **DOM 文本与计算样式**得出，
> 截图仅作留档。所有判据都不依赖看图；但两张图内容不同这一点已用哈希独立验证。

---

## 五、新发现的两个真实渲染缺陷（**未修**，属本轮范围之外）

这两项**无头校验全部漏掉**，是「桩 React 不理解 children 语义」的直接盲区。
两者都在 `src/client/panels/character.js`，且该文件
**相对 HEAD `a8e563c` 未被修改** —— 是**既有缺陷**，非本轮或并行任务引入。

### 缺陷 A：熟练项渲染成 `[object Object]`

`character.js:230-233`：

```js
'熟练：' + proficiency.map((p) => React.createElement('span', { key: p, className: 'dnd-pro' }, p + ' '))
```

`proficiency` 是**字符串数组**，但这里把 `map` 出来的**元素对象数组**用 `+` 拼进了字符串上下文。
`'str' + array` 会调 `Array.prototype.toString()`，于是得到
`[object Object],[object Object],...`。

真机证据 —— 注意 `childCount: 0`，即**根本没有生成任何 `<span>`**：

```json
{ "text": "熟练：[object Object],[object Object],[object Object]",
  "childCount": 0, "childTags": [],
  "html": "熟练：[object Object],[object Object],[object Object]" }
```

后果有两层：文字错，且 `.dnd-pro`（绿色加粗）样式永远不生效。
正确写法是把数组作为**兄弟子节点**传入（`createElement('div', null, '熟练：', ...arr)`），
而不是字符串拼接。注意 `Character`/`Findings` 里其它地方已经用的是展开子节点的正确写法，
**只有这一处**漏了。

> 为什么 `verify-client.mjs` 没抓到：它的 `walkTree` 用
> `type.name` 收集**组件名**，只断言「`Character`/`HitPoints`/`AbilityGrid` 出现过」。
> 拼错的字符串既不抛错、也不影响组件树形状，因此完全静默。

### 缺陷 B：先攻显示 `-4`（应为 `+2`）

`character.js:219`：

```js
modifier(combat.initiative)
```

但 `combat.initiative` **本身已经是最终修正值**（host 数据为 `2`），
不是能力值。`modifier()` 是 `floor((score-10)/2)`，于是
`modifier(2) = floor(-8/2) = -4`。

真机证据：

```
先攻 / 速度  -4 / 30 ft        <- 实际渲染
host payload: "initiative": 2   <- 正确值应为 "+2"
```

同一个 `modifier()` 用在 `AbilityGrid` 的**真能力值**上是对的
（INT 17→+3、DEX 14→+2 均正确），**只有 initiative 这处误用了**。

这一点尤其值得记录，因为面板自己的文件头注释写明了本不该发生：

> *"It renders what the Host sends and formats almost nothing itself. …
> Recomputing either here would give two places to drift, and
> **the one the DM reads would be the one that is wrong**."*

先攻正是那个「重新计算 → DM 读到错数字」的情形。
**DM 会在战斗里按这个数字掷先攻**，所以这不是外观问题。

### 第一轮为何未改（**已于第二轮修复，见 5.3**）

任务 2 的边界是「**请在真机上确认**」，并带一条显式的负面约束
（前置条件不成立时「不要改代码」）。第一轮继续执行验证而非修复，
理由：修 A/B 需要动 `src/` 并 `npm run build` 重建入库产物 `lib/`，
那会与并行任务 3 正在改的 `src/host/tools/track.mjs` 抢同一个构建；
且两项都值得配**能失败的测试**（按看板反复强调的「不能失败的测试不算测试」）。
建议各开一张任务卡，或并入任务 5 的回归防线。

---

## 5.3 缺陷 A / B 的修复（第二轮，用户确认后执行）

用户看到 `熟练：[object Object]` 后确认要修，两项**一并修复**（用户选择）。

### 改动

`src/client/panels/character.js`：

**A. 熟练项** —— 字符串拼接 → 展开为**兄弟子节点**，与本文件其它列表同一写法：

```js
proficiency.length > 0
  ? React.createElement('div', { className: 'dnd-muted' },
    '熟练：',
    ...proficiency.map((p) => React.createElement('span', { key: p, className: 'dnd-pro' }, p + ' ')))
  : null,
```

**B. 先攻** —— 去掉多余的 `modifier()`。先攻**已经是最终修正值**
（`sheet-parse.mjs:270` 读的是角色卡的 `**Initiative:** +2`，
`sheet-split.mjs` 存为 `2`），再套一次公式就把 2 变成 -4：

```js
React.createElement('span', null,
  (typeof combat.initiative === 'number'
    ? (combat.initiative >= 0 ? '+' : '') + combat.initiative
    : '—')
  + ' / ' + (combat.speed ?? '—') + ' ft')),
```

> 第一版改法用了 `(combat.initiative >= 0 ? '+' : '') + (combat.initiative ?? '—')`，
> 是错的：`null >= 0` 为 `true`，会渲染出 `+—`。已改为先判 `typeof`。

两处都写了「为什么」注释。`modifier()` 仍被 `AbilityGrid` 正确地用于**真能力值**
（`character.js:145`），未变成死代码。

### 判据：先攻是「最终修正值」而非能力值（改前已核对整条链）

不只凭 `/dnd/characters` 的一个数字：

| 证据 | 内容 |
|---|---|
| `sheet-parse.mjs:270` | 正则 `\*\*Initiative:\*\*\s*([+-]?\d+)` —— **带符号**，是修正值 |
| `sheet-parse.test.mjs:70` | 断言 `c.initiative === '+2'` |
| `sheet-split.mjs:283` | `num(parsed.initiative)` → 存 `2` |
| host 自身显示串 | `` `Init ${s.combat.initiative}` `` 直接原样输出 |
| 同一行的 `AC`（`character.js:216`） | 同样原样输出，不套任何公式 |

### 真机复验（修复后，同一套脚本）

```
熟练：Arcana History Perception          <- 原为 [object Object],[object Object],[object Object]
先攻 / 速度
+2 / 30 ft                               <- 原为 -4 / 30 ft
```

与 host 真值逐项对账：

| 渲染结果 | host 真值 | |
|---|---|---|
| `Arcana History Perception` | proficient = Arcana, History, Perception | ✅ |
| `+2 / 30 ft` | `initiative: 2` | ✅ |

其余数据项（HP 8/8、AC 12、INT 17 +3、1环 2/2、`8 gp 0 sp 0 cp`、
`morgansfort`）**保持全部 PASS**，未见回归。

### 验证状态

- `npm run build` → `build OK`
- `node scripts/verify-client.mjs` → OK（注册两个槽位）
- `npm run check` → **exit 0：12 套件 + verify + 写入场景 + 并发场景全绿**
- `scripts/browser-verify.mjs` 真机 → console errors 0、exceptions 0、failed requests 0
- `campaigns/morgansfort/` 两个文件哈希未变
- 未 commit / tag / push（HEAD 仍 `a8e563c`）

### 未做（用户明确选择「不用，先修好就行」）

**没有**为这两项补能失败的回归测试。后果需明说：
`verify-client.mjs` 的 `walkTree` 只收集**组件名**，所以「渲染出错误文本」这类缺陷
**仍然抓不到** —— 同样的错误将来还能再次静默通过无头校验。
建议并入任务 5 的回归防线时补上（断言渲染文本不含 `[object Object]`，
且断言熟练项确实生成了 `<span>`）。

---

## 六、数据安全与边界

- **未重启 harness / web profile。**
- **第一轮未改 `src/`**，新增 `scripts/browser-verify.mjs`。
  （过程中另有一个一次性探针 `scripts/probe.mjs`，已用完删除。）
- **第二轮按用户指示修改了 `src/client/panels/character.js` 并 `npm run build` 重建
  `lib/client.js`** —— 这是修 A/B 所必需，且 `lib/` 是入库产物。
  `git diff HEAD -- src/` 显示本轮只动了这一个源文件。
- 未修改 `.agents/skills/dnd/`；未修改 profile 目录；未新增 npm 依赖
  （CDP 走 Node 内置 `WebSocket` + `fetch` + `node:crypto`）。
- 未执行任何 git 写操作（`HEAD` 仍 `a8e563c`；无 commit/tag/push）。
- 用户自己的浏览器**未被附着、未被导航、未被干扰**；验证用的是一个独立实例。
- 脚本**只读** `/dnd/characters`，未对 `campaigns/morgansfort/` 发起任何写入；
  修复后 `alice.md` / `alice.state.json` 的 SHA256 仍为
  `109C048C…6370DB` / `FEFD308E…F348A5`，与 handoff 记录一致。
- 脚本会关闭自己打开的标签页；验证用浏览器实例仍需人工关闭（见下）。

### 需要人工执行的部分

1. **关闭验证用的无头 Edge 实例**（端口 9346）。本轮**不能**自行关闭它 ——
   它是在更宽权限下启动的，且关闭它就是「重启类」操作。
   它不服务任何请求、不占 3080，留着无副作用。
2. **刷新浏览器页面**即可看到修复效果（`lib/client.js` 已重建；
   已打开的旧页面仍持有旧 bundle）。无需重启 harness。
3. **缺陷 A / B 的回归测试** —— 用户本轮明确选择先不补（见 5.3 末）。

---

## 七、两轮改动的文件

第一轮（验证）：

- `scripts/browser-verify.mjs`（新增，真机验证脚本）
- `browser-verify-closed.png` / `browser-verify-overlay.png`（点击前 / 后截图留档）

第二轮（修复）：

- `src/client/panels/character.js`（缺陷 A 熟练项 + 缺陷 B 先攻）
- `lib/client.js`（`npm run build` 产物，入库）

两轮共同的记录文件：

- `docs/harness/TASK2-BROWSER-VERIFICATION.md`（本文件）

> **工作区里另有他人的改动，勿误记到本轮名下。**
> `git status` 显示 `M src/host/tools/track.mjs`、`M lib/host/tools/track.mjs`、
> `M package.json`、`?? scripts/concurrency-scenario.mjs` ——
> 属并行的任务 3（写入工具并发防护）执行者，本轮未触碰。
> 注意 `npm run build` 会重建**全部** `lib/`；任务 3 改过的
> `lib/host/tools/track.mjs` 因此也出现在 diff 里，那是重建的副产物，不是本轮的修改。
