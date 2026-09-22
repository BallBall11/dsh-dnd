# dsh-dnd 已安装版本问题报告

> 审计对象：`D:\DND\dsh-dnd-bundle`（已通过 `link:` 安装进 web profile，junction 指向 `D:\DND\dsh-dnd-bundle`）
> 审计基线：**HEAD = 45fc4b8**（"test: stop coupling the suite to live campaign data"），package version `0.2.0`
> 审计方式：**只读**代码审查 + 在真实运行实例上实测（`/dnd/health`、`/dnd/characters`、`cordis_inspect_query`）+ 对纯函数模块做临时探针脚本实测（探针已全部删除，工作树未留痕）
> 本报告**只做问题汇报与修改建议，不修改任何代码**。

---

## 0. 审计时的并发写入警告（先读这一条）

审计过程中，`D:\DND\dsh-dnd-bundle` 被**另一个写入者**并发修改了。审计开始与结束时的工作树不同：

| 时刻 | 状态 |
|---|---|
| 审计开始 | 工作树干净，HEAD = `45fc4b8` |
| 审计结束 | `src/host/tools/shared.mjs`、`src/host/tools/lookup.mjs` 被改（16:18–16:20），新增未跟踪的 `data/` 目录 |

新增的改动引入 `DATA_ROOT`（用 `import.meta.url` 解析包内 `data/`），并把 SRD 数据集从 skill 的 `SKILL_ROOT` 迁到包自带的 `data/`。

**这带来一个必须立刻注意的状态：`lib/\*\*` 构建于 15:51，而 `src/host/tools/\*` 改于 16:18–16:20 —— `lib/` 相对 `src/` 已过期。**

```
lib/host/tools/lookup.mjs:13   import { DND_ROOT, SKILL_ROOT, ... } from './shared.mjs'
lib/host/tools/lookup.mjs:16   2014: `${SKILL_ROOT}/data/dnd5e_srd.json`,
```

`lib/` 才是 `link:` 安装真正加载的产物（`main`/`exports["."]` 指向 `lib/`）。**因此在执行 `npm run build` 之前，这次 SRD 修复对运行中的 harness 完全无效**；而 `npm test` 之所以全绿，是因为它测的是 `src/`。这与本报告 §3.1 的"src/lib 漂移"是同一类问题的现场实例。

> 建议：把这看作一个独立的**发布完整性缺陷**——`lib/` 入库但无构建校验门禁，导致"测过了"与"装好了"可以不一致。

---

## 1. 结论摘要

安装版本**整体可用且质量明显高于同类**：14 个 Host 工具全部正确注册（已用 `cordis_inspect_query → Tool.listTools` 实测确认），两条 HTTP 路由在线并返回真实数据，Client 面板的 `lib/client.js` 是合法的 `__ModuleLoader__` 闭包工厂形态。

但在**金额解析、摘要块渲染、写入工具语义、并发/幂等、以及 src↔lib 一致性**上存在若干**真实可复现**的缺陷，其中 3 个属于"静默错数"级别——正是该插件自己的设计文档反复声明要消灭的那类失败。

| 等级 | 数量 | 说明 |
|---|---|---|
| 🔴 严重（静默产生错误数值） | 4 | 金额千位逗号截断、金额负数混合符号、摘要块 `undefined` 泄漏、SRD/构建产物漂移 |
| 🟠 中等（行为与文档/规则不符） | 6 | crit+keep 骰数错误、advantage 语义分裂、tempHp 文案与行为不符、resource 大小写、`dnd_characters` 面板 `+null`、硬编码 morgansfort 断言 |
| 🟡 轻微（健壮性/一致性） | 6 | 空参数、未知键丢弃、验证覆盖缺口等 |

---

## 2. 🔴 严重缺陷

### 缺陷 1 — 金额千位分隔符被静默截断，产生 1000 倍误差

**位置**：`src/host/tools/state-rules.mjs` → `parseCurrency()`（第 141 行正则）

**实测**（探针直接调用 `parseCurrency`）：

| 输入 | 返回铜币 | 正确值 | 后果 |
|---|---|---|---|
| `"1,000 gp"` | **1** | 100000 | 少 5 个数量级 |
| `"1,234 gp"` | **23401** | 123400 | 错 |
| `"2,500 gp"` | **50002** | 250000 | 错 |

**根因**：正则 `/(-?\d+)\s*(pp|gp|...)?/g` 只认连续数字。`"1,000 gp"` 中 `1` 先匹配到一个**无单位**的裸数字（落入 `default` 分支按铜币计），随后 `000` 再匹配一次；单位 `gp` 只作用于最后一段。

**为什么严重**：`dnd_spend` 直接用它算花费。DM 输入 `"1,000 gp"` 买一件装备，角色只会被扣 **1 cp**，且工具会报告"Spent 1 cp"——一个看起来完全合理的成功结果。这正是插件设计文档开篇（`state-rules.mjs` 第 9–26 行）声明要根除的"DM 读到一个貌似合理却不真的数字"。

**建议**：
1. 解析前剥离千位分隔符：`s.replace(/(?<=\d),(?=\d{3}\b)/g, '')`，或在数字捕获组中允许逗号 `(-?\d[\d,]*)` 后再 `replace(/,/g,'')`。
2. **更根本**：金额解析应当**拒绝**无法干净解释的输入，而不是"尽力猜"。`parseCurrency` 目前对 `"abc"` 返回 0、对 `"$8"` 返回 8、对 `"gp 8"` 返回 8——宽容到无法区分"这是 8 铜"和"我没读懂"。
3. 给 `dnd_spend` 加一条断言：若 `amount` 字符串里出现逗号或非数字单位碎片，返回明确的"无法解析"而不是静默取一个数。

---

### 缺陷 2 — 负数金额渲染为混合符号，破坏"单一整数"的核心不变量

**位置**：`src/host/tools/state-rules.mjs` → `fromCopper()`（第 77–93 行）

**实测**：
```
formatCurrency(-15)   -> "0 gp -1 sp -5 cp"
formatCurrency(-115)  -> "-1 gp -1 sp -5 cp"
fromCopper(-15)       -> { gp: 0, sp: -1, cp: -5 }
```

**问题**：`-15` 渲染成 `0 gp -1 sp -5 cp`。注意 `gp: 0` 是**正零**（`part()` 把 `-0` 归一成 `0`），后面两段是负的——这正是该文件第 71–75 行注释声称已避免的"混合符号形式"。注释说 "Every unit has the same sign as the total"，但对 `-15` 而言 `gp` 段是 `0`（无符号），视觉上仍是混合形态。

**为什么严重**：`state-rules.mjs` 第 9–26 行的整个设计论证——"三分字段永远存在中间态，`8 gp 0 sp -15 cp` 是算术正确、物理无意义的值，单一整数让坏状态**无法被构造**"——的前提是**输出侧也只产生合法形态**。现在输入侧确实只有一个整数，但输出侧又把混合符号形态造了回来。

**建议**：
1. `formatCurrency` 对负总额统一渲染为 `-7 gp 8 sp 5 cp`（符号前置一次），或直接返回 `-785 cp`。
2. 若保留 `fromCopper` 的逐段符号，需在文档与测试中明确"这不是可回存的形态"；并补一条 `fromCopper(n) → toCopper(...) === n` 的往返测试（当前无此断言）。
3. 校验层 `validateState` 已把负货币判为 `error`，可复用同一渲染路径，避免"错误信息里出现混合符号"。

---

### 缺陷 3 — 生成的摘要块把字面量 `undefined` 写进人类阅读的角色卡

**位置**：`src/host/tools/sheet-split.mjs` → `renderSummaryBlock()`（第 544–546 行）

**实测**：
```
> HP 0/8 · AC undefined (Mage Armor undefined) · Init — · Speed —
> HP — · AC undefined (Mage Armor undefined) · ...
```

**根因**：`s.combat.ac !== null` 对 `undefined` 判定为 `true`，于是模板字符串插入了 `undefined`。

**为什么严重**：这个块会被 `composeSheet` 写进 `characters/<name>.md`，是**每次写入都刷新、DM 会直接阅读**的区域。真实 `morgansfort/alice.md` 之所以没出现该问题，只是因为那个角色的 state 恰好字段齐全——**缺陷对数据完整度敏感，一旦角色卡字段不全（新建角色、未迁移角色、部分字段缺失）就会立刻显形**。

**建议**：
1. 用统一的"可空渲染"助手，例如 `fmt(v, fallback='—')`，把 `!== null` 一律改成 `!= null`（同时覆盖 `undefined`），或显式 `Number.isFinite()`。
2. `ageArmorAc` 与 `saveDC`/`attackBonus` 分支（第 545、559 行）有同类问题，需一并修。
3. 加断言：`renderSummaryBlock(normalizeState({}))` 的输出中**不得包含字符串 `undefined`**。当前测试未覆盖"字段缺失"这一形态。

---

### 缺陷 4 — `lib/` 与 `src/` 可静默漂移，"测过的"不等于"装上的"

**位置**：`scripts/build.mjs` + 已入库的 `lib/`

**实测证据**：`lib/host/tools/lookup.mjs` 构建于 15:51、仍导入 `SKILL_ROOT`；`src/host/tools/lookup.mjs` 改于 16:20、已改为 `DATA_ROOT`。`npm test` 全绿（测 `src/`），但**运行中的 harness 加载的是过期的 `lib/`**。

**为什么严重**：`link:` 安装通过 `exports["."] → ./lib/host/index.mjs` 解析，**`lib/` 就是交付物**。该项目已有一个专门的 `build.test.mjs` 来断言交付物形态（这正是 v0.1.0 的教训），但它只检查 `client.js` 的**文本形状**，不检查 **`lib/` 是否由当前 `src/` 构建而来**。

**建议**：
1. 在 `npm run check` 里加"构建后 `git diff --exit-code lib/` 必须为空"的门禁（即 `lib/` 必须与 `src/` 同步入库）。
2. 或让 `build.test.mjs` 比对 `lib/host/**.mjs` 与 `src/host/**.mjs` 的字节（当前 host 半是逐字节复制，可以直接 `assert.deepEqual`）。
3. `scripts/watch.mjs` 存在但显然不是常驻运行；建议在 README/安装脚本中明确"修改 `src/` 后必须 `npm run build` 并提交 `lib/`"。

---

## 3. 🟠 中等缺陷

### 缺陷 5 — SRD 数据集路径指向已消失的目录（并发修复中，但 `lib/` 未同步）

**位置**：`src/host/tools/shared.mjs` `SKILL_ROOT`（HEAD 版本）

**实测**：`D:\DND\.agents` 目前是**空目录**（`GetFileSystemEntries` 返回 0 项）。`host.test.mjs` 在 HEAD 上实测失败：

```
FAIL dnd_srd_lookup finds a spell
     SRD dataset not found for ruleset 2024: D:/DND/.agents/skills/dnd/data/dnd5e_srd_2024.json
FAIL dnd_srd_lookup honours an explicit ruleset override
FAIL dnd_srd_lookup reports an honest miss
host.test.mjs: 3 failure(s)
```

**已在并发修复中**（新增包内 `data/`，含 `dnd5e_srd.json` 1.26 MB、`dnd5e_srd_2024.json` 1.53 MB、`dnd5e_supplemental.json`）。但见缺陷 4：**在 `npm run build` 之前不生效**。

**建议**：
1. 立刻 `npm run build` 并提交 `lib/`，让运行实例真正拿到新路径。
2. 修复方向本身是对的（数据集是**插件自身的依赖**，应随包发布，而不是寄居在可被清理的 skill 目录）。补一条测试断言"包内 `data/` 两个数据集存在"，避免此依赖再次漂移到包外。
3. 同时注意 `data/` 目前**未被加入 `package.json` 的 `files` 数组**（当前为 `["lib","cordis.patch.yml","README.md","CHANGELOG.md"]`）。`link:` 安装不受影响，但一旦发布到 registry，`data/` 会被漏掉——这会**精确复现同一个缺陷**。**建议把 `"data"` 加进 `files`。**

---

### 缺陷 6 — 暴击对 keep 表达式翻倍了骰池却保持 keep 数，违反规则

**位置**：`src/host/tools/roll.mjs` → `doubleDice()`（第 100–105 行）

**实测**（强制自然 20）：
```
dnd_attack { damage: "2d6kh1" }
-> Damage 4d6kh1 = [5, 1, 6, 3] keep [6] = **6** (crit: dice doubled)
```

**问题**：`doubleDice` 只把 `count` 翻倍（`2d6kh1` → `4d6kh1`），但 **keep 数仍是 1**。RAW 是"暴击把伤害骰数翻倍"，因此应保留 2 颗（`4d6kh2`）。结果：投了 4 颗骰子却只取最高 1 颗，**伤害系统性偏低**且看不出来。普通表达式（`1d8+3→2d8+3`、`2d6+4→4d6+4`）实测**正确**，平坦修正值未被翻倍。

**建议**：
1. `doubleDice` 应同时把 `kh/kl` 的 keep 数翻倍。
2. 或者更稳妥：**拒绝**对带 `kh/kl` 的表达式自动翻倍，提示 DM 手动给出暴击骰式。伤害骰极少用 keep，与其猜错不如不猜。

---

### 缺陷 7 — `advantage` 语义在两条代码路径上分裂，且与 disadvantage 同时给出时静默偏向后者

**位置**：`src/host/tools/roll.mjs` → `dnd_roll.execute`（第 192–201 行）

**实测**：
```
dnd_roll { spec:"d20",   advantage:true }  -> 投 2 次取高   ✅
dnd_roll { spec:"2d6+3", advantage:true }  -> 完全忽略 advantage，投 2d6  ✅(合理)
dnd_roll { spec:"2d20kh1", advantage:true } -> 投 2 组、每组 1d20kh1，再取高
        = "2d20kh1 = [17,14] keep [17] | 2d20kh1 = [5,17] keep [17] → pick higher"
```

问题有三层：
1. `advantage` 只对 `expr.sides === 20` 生效，但对 `2d20kh1`（本身已是"优势"写法）**又叠加了一次**，导致**投 4 颗 d20**且输出文案 `2d20kh1` 与实际行为不符。
2. 判定条件是 `sides === 20` 而非 `count`，所以 `2d20`（伤害用的双骰）也会被当成 d20 检定处理。
3. `advantage:true, disadvantage:true` 同时给出时，实测**静默取 disadvantage**（`useLower = Boolean(args.disadvantage)`）。5e 规则里两者同时存在应相互抵消（正常一投），而不是"劣势优先"。

**建议**：
1. 把 `advantage`/`disadvantage` 的适用条件收紧为"恰好一颗 d20"（`count === 1 && sides === 20 && keep === null`），否则返回明确提示"该骰式不支持 advantage 参数"。
2. 两者同时为真时取消二者（净 0），并在输出中说明。

---

### 缺陷 8 — `tempHp` 的描述文案与实现行为不一致

**位置**：`src/host/tools/track.mjs` 工具 schema 第 350 行 vs `applyTrackChanges` 第 563–578 行

**实测**：
```
tempHp:"+8"  当已有 5  -> 8   （取较高）
tempHp:"+3"  当已有 5  -> 5   （不变）
tempHp:"-5"  当已有 0  -> 0   （静默，changes 为空数组）
```

**问题**：
1. Schema 描述写 `"+8" to set`，但 `+8` 实际是"取较高"，**不是 set**；真正的 set 语义只有 `"=N"` 才有（`op.mode === 'set'`）。描述会误导模型。
2. `tempHp:"-5"` 在已有 0 时**不产生任何 change 记录**（第 574 行条件不成立，第 575 行要求 `op.value > 0`），于是 `changes` 为空。虽然 `touched` 已 push，写入仍会发生并刷新双时钟，但 DM 看不到任何说明——与该项目"每次都报告发生了什么"的风格不符。

**建议**：
1. 修正 schema 描述：`"+N" 取较高（不叠加）；"=N" 直接设定；"-N" 扣减且不低于 0`。
2. `-N` 导致无变化时补一条 `changes` 说明。

---

### 缺陷 9 — `resource` 名称大小写敏感，拼错即静默新建物品

**位置**：`src/host/tools/track.mjs` 第 652–675 行

**实测**：
```
resource:"rations", resourceDelta:"-1"   （卡上是 "Rations"）
-> gear 仍为 {"Rations":3}，changes 为空数组
```

**问题**：`gear[itemName]` 精确匹配失败 → `before = 0` → `after = -1` → 触发 `after < 0` 拒绝。但**拒绝信息不会说"你是不是想写 Rations"**，DM 得到的是"角色只有 0 x rations"，而卡上明明有 3 份。更糟的是反向情形：`resource:"rations", resourceDelta:"+1"` 会**静默新建一个叫 `rations` 的新物品**，与 `Rations` 并存——直接破坏"每个事实只有一个归属"。

**建议**：
1. 查找时先精确匹配，失败则做**大小写不敏感**匹配并回落到既有键名。
2. 都不匹配且 `delta > 0` 时，新建前给出明确提示（或要求显式 `create: true`）。

---

### 缺陷 10 — 面板在两个位置渲染字面量 `+null`

**位置**：`src/client/panels/character.js` 第 233 行（法术 DC/攻击）、第 256 行（攻击加成）

**实测**（模拟宿主返回的 partial state）：
```
saveDC=13, attackBonus=null  ->  "13 / +null"
attack { bonus:null }        ->  "+null · 1d8"
```

**问题**：`(x >= 0 ? '+' : '') + x` 在 `x === null` 时给出 `"+null"`。法术行只在 `saveDC != null` 时渲染，所以"有 DC 无攻击加值"的角色（完全合法的数据形态）会命中。攻击行同理。

**建议**：抽出 `signed(v)` 助手：`v == null ? '—' : (v >= 0 ? '+' : '') + v`，两处共用。`verify-client.mjs` 的 fixture 里 `saveDC/attackBonus` 都是 `null`，恰好绕过了这个分支，建议补一个"只有 DC 没有攻击加值"的用例。

---

### 缺陷 11 — 两个场景脚本硬编码 `morgansfort`，与文件自身声明的"不变量"自相矛盾

**位置**：`scripts/write-tools-scenario.mjs:394`、`scripts/concurrency-scenario.mjs:365`

**实测**（两个脚本均失败）：
```
ok   the marker was restored byte-for-byte, BOM included
FAIL and the real campaign is active again
ok   nothing under campaigns/morgansfort/characters moved (whole tree hashed)
```

**问题**：断言写死 `JSON.parse(marker).name === 'morgansfort'`。当前活动战役标记是 `retest-alice`（审计起点），因此**必然失败**。讽刺的是，紧接着的第 397–402 行注释正是在讲"之前硬编码了某个状态，导致合法变更后测试变红"——**同一个错误在同一个文件里又犯了一次**。`npm run check` 因此长期无法全绿。

**建议**：
1. 该断言应该只验证"标记被按字节还原"（上一行已经做了），**不应**再对标记内容取立场。
2. 若确实想验证"还原成运行前的那个战役"，应把还原前的值存下来比对，而不是写死 `morgansfort`。

---

## 4. 🟡 轻微问题与健壮性缺口

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 12 | `state-schema.mjs:157-349` | `normalizeState` 丢弃所有不在 `TOP_LEVEL_ORDER` 的顶层键（实测 `{foo:'bar'}` 被静默删除）。注释说这是刻意的，但**未知键通常来自新版本写出的文件**，降级打开时静默丢数据风险高 | 至少把未知顶层键记入 `warnings` |
| 13 | `state-schema.mjs:335-339` | `NUMERIC_FIELDS` 之外的嵌套键不做类型归一；`identity.homebrew` 这类未知键被原样保留（实测），与"丢弃未知字段"策略不一致 | 明确策略并一致执行 |
| 14 | `state-rules.mjs:224` | HP 只给 `current` 或只给 `max` 时仅 warn（实测）。`current:null, max:10` 是"未初始化"而非非法，可接受；但 `current:5, max:null` 会让 `hpBand` 静默不显色 | 区分两种情况给不同提示 |
| 15 | `roll.mjs:180,212` 等 | schema 里用 `required: true` 写在**属性内部**（如 `spec`），同时又在 `required` 数组里列一次。DSH 的 `ToolDefinition` 只认顶层 `required` 数组，属性内的 `required` 是无效冗余 | 删掉属性内的 `required`，避免读者误以为有两套机制 |
| 16 | `lookup.mjs:158` / `campaign.mjs:155` | `Number(args.max) > 0 ? Number(args.max) : 5`：`max: 0`、`max: -1`、`max: "abc"` 全部静默回落到默认值，而非提示参数非法 | 显式校验并报错 |
| 17 | `sheet-parse.mjs:228` | `hpMatch` 用 `\d+`，无法解析负数或带符号 HP；且 `isSeparator` 依赖字符类判断，注释承认对 `\| -1 \| +2 \|` 这类行需要靠"无字母数字"来区分 | 已有 `sheet-split.mjs` 的 `dataRows` 用同样思路，可统一 |
| 18 | `clock.mjs:62` | `formatWorldTime` 硬编码纪元后缀 `AR`，对不同战役的历法（如 `DR`、`KE`）无法配置 | 让 `calendar.json` 提供 `era` 字段 |
| 19 | `routes.mjs` | 无安全层是**已记录的决策**（`REWRITE-PLAN.md §关于安全层`），本机回环可接受。但 `/dnd/characters` 会返回**全部角色完整 state**（含叙事外的所有数值），若将来绑定变更则暴露面较大 | 保留决策，但在 `README` 保留显式提醒即可 |
| 20 | `package.json` | `private: true`，无法发布到 registry；`files` 未含 `data/`（见缺陷 5） | 若计划分发则需改；否则保留 `link:` 安装并明确说明 |

---

## 5. 值得肯定的部分（避免只列问题）

- **工具注册与路由实测健康**：14 个工具全部出现在 `Tool.listTools`；`GET /dnd/health` 返回 `{"ok":true,"fs":true,"campaign":"retest-alice"}`；`GET /dnd/characters` 返回真实完整 state。
- **Client 半形态正确**：`lib/client.js` 是合法的 `__ModuleLoader__.load({id:"dsh-dnd", factory})` 闭包工厂，`build.mjs` 内置了拒绝 ESM 语法的闸门；`verify-client.mjs` 会真实求值并遍历渲染树，不是空壳校验。
- **写路径设计扎实**：`withCharacterLock` 的“先解析成 stem 再上锁”确实修掉了 "alice"/"ali"/省略名 三种拼法绕过互斥的问题；并发场景脚本实测两条写都落盘（`8-1-1=6`）。
- **拒绝写入按字节哈希比对**（而非重读值），这是正确的方法论。
- **测试数据所有权规则**（`TEST-DATA-OWNERSHIP.md` + `audit-test-ownership.mjs`）是一个很好的机制，本次唯一违反它的正是缺陷 11 那两处硬编码。

---

## 6. 建议的修复顺序

**第一批（静默错数，优先）**
1. 缺陷 1 `parseCurrency` 千位逗号 —— 影响金额
2. 缺陷 3 摘要块 `undefined` 泄漏 —— 写进人类可读文件
3. 缺陷 4 `lib/` 同步门禁 + **立即 `npm run build`** —— 决定修复是否真的生效
4. 缺陷 5 数据集路径收尾（含把 `data/` 加入 `files`）

**第二批（规则正确性）**
5. 缺陷 6 暴击 + keep
6. 缺陷 7 advantage 语义
7. 缺陷 2 负金额渲染
8. 缺陷 8 / 9 写入工具文案与大小写

**第三批（表现层与测试健康度）**
9. 缺陷 10 面板 `+null`
10. 缺陷 11 场景脚本硬编码（恢复 `npm run check` 全绿）
11. 表格中 12–20 的健壮性项

**贯穿性建议**：本项目已两次记录"测试与被测代码犯同一个错"（`REWRITE-PLAN.md` 阶段 3 bug 12）与"mock 比真实实现宽松"（bug 3）。本次缺陷 1、3、10 都属于**同类第三次**——**输入形态的边界（千位逗号、缺字段、null 加值）没有被任何 fixture 覆盖**。建议专门增设一组"畸形输入"fixture：字段缺失的 state、带千位逗号的金额、`keep` 骰式的暴击、`null` 加值的角色卡。这比继续逐条打补丁更能防止复发。

---

## 7. 附录：本次审计的实际验证手段

| 手段 | 用途 |
|---|---|
| `cordis_inspect_query(host, Tool, listTools)` | 确认 14 个工具真实注册及其 schema |
| `cordis_inspect_query(host, Service, listService)` | 核对 `fs`/`tools`/`webServer` 契约（`stat`/`listDir` 收 `FsTarget`、`register` 重复即抛） |
| `cordis_inspect_query(client, Service, listService{slots})` | 确认 `slots.inject` 与 `slots.register` 签名 |
| `cordis_inspect_query(client, Slots, listSubTree)` | 确认 `shell.overlay` / `sidebar.footer.action` 为合法槽位 |
| `Invoke-WebRequest /dnd/health`、`/dnd/characters` | 实测路由在线并返回真实数据 |
| 临时探针脚本（已删除） | 对 `parseCurrency`/`fromCopper`/`renderSummaryBlock`/`applyTrackChanges`/`parseDice` 等纯函数做穷举边界实测 |
| `npm test` / `npm run test:writes` / `test:concurrency` | 复现 HEAD 上的 3 处 SRD 失败与 2 处硬编码断言失败 |
| PowerShell `.NET` API 列目录 | 确认 `D:\DND\.agents` 为空（数据集路径失效的根因） |

> 所有探针文件均已删除，`git status` 中除并发写入者自己的改动外无本审计留下的痕迹。
