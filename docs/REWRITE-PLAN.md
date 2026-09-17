# dsh-dnd 重写方案：功能清单与实施计划

> 状态：**阶段 0、1、2、3 已实施并实测通过。阶段 4（发布）待做。**
> 范围：**只重写 `dsh-dnd` 插件**（Host 工具族 + Client 面板）。
> 不改 `.agents/skills/dnd/`（那是已安装的 skill，`D:\DND\AGENTS.md` 明令不动）。
> 前置阅读：`docs/BUNDLE-COMPAT-AUDIT.md`（三缺陷诊断，本方案是它的执行版）。

---

## 0. 定位（v2 修订）

> **本节已重写。** 旧版把 `dsh-dnd` 定位为"dnd skill 的原生加速层"，
> 并围绕"与 Python 脚本互斥"设计。**该前提已作废。**

`dsh-dnd` 是一个**独立的 D&D 数据层**：

| 层 | 职责 |
|---|---|
| **状态层**（新增） | 角色卡的**结构化状态**——内存对象 + JSON 文件，插件的权威领域 |
| **叙事层** | 角色卡的自由文本（自我描述、旅程经历、特性描述），人可编辑 |
| **表现层** | Client 面板、摘要工具 |

**与 `.agents/skills/dnd/` 的关系**：**仅供参考，不再调用**。技能文档的价值在于它记录了
**数据格式的权威定义**（模板排版、字段语义），这些定义我们**沿用**；但插件不调用其脚本、
不与其争抢写入权、不需要互斥。

**这意味着旧版 §2.6「写入互斥」整节作废**——没有第二个写入者了。

---

## 1. 两条已确立的设计原则

### 1.1 叙事与状态必须分离

模板（`templates/character-sheet.md`）的内容按**能否无歧义结构化**分类：

| 分类 | 区块 | 归属 |
|---|---|---|
| **结构化状态** | Identity、Ability Scores、Combat Stats、Saving Throws、Skills、Attacks、Spell Slots、Spells、Equipment、Currency | `characters/<name>.state.json` |
| **叙事文本** | Character Pillar、Backstory & Notes、**Features & Traits** | `characters/<name>.md` |

分类依据（已与需求方确认）：

- **法术列表 → 结构化**。法术名是明确的，且能查 SRD 校验。
- **装备背包 → 结构化**。杂物件（"根据常识和当前情形可以拥有但不必列出"）**由大模型按上下文判断**，
  不写入文件，也不做枚举约束。
- **Features & Traits → 纯文本**。每条是 `**名称** — 一段散文`，格式化会毁掉它。

**每个字段只有一个归属，零重复，零漂移。**

### 1.2 文件格式选 JSON（附完整论证与更正记录）

**决策：`characters/<name>.state.json`，JSON pretty（2 空格缩进）。**

选型经过一次**结论反转**，记录如下以免重蹈：

| 轮次 | 主张 | 依据 | 结果 |
|---|---|---|---|
| 1 | JSON 的列表 diff 很差 | 逐行按索引比较，得"54 行变更" | ❌ **测量方法错误** |
| 2 | 改用 TOML | 基于 (1) 的错误数据 | ❌ 前提不成立 |
| 3 | **JSON** | **真实 `git diff` 实测** | ✅ **当前决策** |

**错误根源**：第 1 轮用的是 `lines[i] !== lines2[i]` 的逐行索引对比，它把**因插入而位移的行**
全部计为"变更"。**git 用的是 Myers diff**，会正确识别插入并对齐后续行。

**实测证据**（真实 git 仓库，非模拟）：

```
在 JSON 数组中插入一个法术：
  git diff --numstat  ->  1  0      (纯新增，零删除)
  +    "New Spell",

同样内容写成 TOML 单行数组：
  git diff --numstat  ->  1  1      (整行替换)
  -prepared = ["Mage Armor", "Magic Missile", ...]
  +prepared = ["Mage Armor", "New Spell", "Magic Missile", ...]
```

**JSON 的 diff 实际优于 TOML**（`+1 -0` vs `+1 -1`）。

最终对比：

| 维度 | JSON pretty | TOML |
|---|---|---|
| 标量改动 | ✅ 1 行 | ✅ 1 行 |
| **列表插入** | ✅ **`+1 -0`** | ✅ `+1 -1` |
| 字典（物品:数量）| ✅ 1 行 | ✅ 1 行 |
| 体积 | 984 字符 | 489 字符 |
| **解析器** | ✅ **`JSON.parse` 内置** | ❌ 需手写 ~100 行 |

**决定性理由**：diff 友好度 JSON 更优或持平；TOML 仅剩体积优势，**不足以抵偿手写解析器的
维护成本与规范边界风险**（Node 24 无内置 TOML 解析器，profile 内也无相关依赖）。

---

## 2. JSON schema（v1）

```jsonc
{
  "schema": 1,                       // 版本号，格式演进用
  "name": "Alice",
  "player": null,
  "campaign": "morgansfort",
  "updated": "2026-09-04",

  "identity": {
    "race": "High Elf (Elf)", "class": "Wizard", "level": 1,
    "background": "Sage", "alignment": null,
    "xp": 0, "xpNext": 300
  },

  "abilities": { "STR": 8, "DEX": 14, "CON": 15, "INT": 17, "WIS": 10, "CHA": 10 },

  "combat": {
    "hp": { "current": 8, "max": 8 }, "tempHp": 0,
    "ac": 12, "mageArmorAc": 15,
    "initiative": 2, "speed": 30,
    "hitDice": { "die": "d6", "remaining": 1 },
    "deathSaves": { "successes": 0, "failures": 0 }
  },

  "saves": { "STR": -1, "DEX": 2, "CON": 2, "INT": 5, "WIS": 2, "CHA": 0 },
  "proficientSaves": ["INT", "WIS"],

  "skills": {
    "Arcana":     { "ability": "INT", "bonus": 5, "proficient": true },
    "Stealth":    { "ability": "DEX", "bonus": 2, "proficient": false }
  },

  "attacks": [
    { "name": "电爪 Shocking Grasp", "bonus": 5, "damage": "1d8", "type": "Lightning" }
  ],

  "spellcasting": { "ability": "INT", "saveDC": 13, "attackBonus": 5 },

  // 法术位：整数键。注意读取时会被 JS 引擎提升排序，写入时须显式排序（见 §4.2）
  "spellSlots": { "1": { "total": 2, "used": 0 } },

  "spells": {
    "cantrips":  ["Light", "Mage Hand", "电爪 Shocking Grasp"],
    "spellbook": ["Detect Magic", "Mage Armor"],
    "prepared":  ["Mage Armor", "Sleep"]
  },

  // 装备：字典形式 name -> 数量。数量为 1 时仍显式写出，保持 diff 稳定
  "equipment": {
    "weapons": { "Quarterstaff": 1, "Dagger": 1 },
    "armour":  {},
    "gear":    { "Spellbook": 1, "Parchment": 8 }
  },

  // 货币：单一铜币整数。三级币种只出现在读写边界。
  // 理由见 §6 规则 2——三分字段永远存在中间态。
  "currency": 800,
  "warnings": []                     // 解析期问题，绝不静默吞掉
}
```

**装备用字典 `name -> qty`**（已确认）：
- 改数量 = 改一行（`"Parchment": 8` → `7`），实测 `git diff --numstat` = `1 1`
- 增删物品 = 增删一行
- 比 `["Parchment x8"]` 更结构化，比 `[{name,qty}]` 体积小且 diff 干净

---

## 3. 文件布局

```
campaigns/<campaign>/
  characters/
    alice.md          叙事层：Pillar、Backstory、Features & Traits
    alice.state.json  状态层：六维/HP/AC/技能/攻击/法术位/法术/装备/货币
```

`alice.md` 顶部保留一个**由插件生成的只读摘要块**，供人一眼看全：

```markdown
# Alice
<!-- dsh-dnd:generated — 数值请改 alice.state.json，本块会被覆盖 -->
> HP 8/8 · AC 12 (Mage Armor 15) · Init +2 · Speed 30
> STR 8 (-1) · DEX 14 (+2) · CON 15 (+2) · INT 17 (+3) · WIS 10 (+0) · CHA 10 (+0)
> 法术位 1环 1/2 · 法术DC 13 · 法术攻击 +5
> 💰 8 gp 0 sp 0 cp

## Character Pillar
...
```

**写入策略**：
- `.state.json` — **整文件重写**，字段顺序由序列化器固定（§4.2），diff 稳定
- `.md` — **只替换摘要块**（由 `<!-- dsh-dnd:generated -->` 标记界定），正文一字不动

---

## 4. 实施要点

### 4.1 序列化器必须保证确定性

`JSON.stringify` 不能直接用——必须**归一化字段顺序**，否则每次写出的键序可能不同，产生假 diff。

- 顶层与各段字段**按固定顺序**输出（schema 中的书写顺序）
- `skills` / `equipment` 的键按**插入顺序**保留（物品顺序是 DM 的语义信息）
- 空容器统一输出为 `{}` / `[]`，不省略

### 4.2 整数键陷阱（实测确认）

JS 对象会把**整数样式的键提升到前面并升序排列**：

```
{ Zombie:1, "10":x, "2":y, Alpha:2, "1":z }
  ->  1, 2, 10, Zombie, Alpha
```

`spellSlots` 的键是 `"1"`、`"2"`……**正好命中这条规则**。影响：

- 读取时**无需担心**——环阶本来就该升序
- 写入时**必须显式排序**，否则 10 环（不存在）与 2 环的次序在跨引擎时可能不一致
- **物品名不会命中**（非纯数字），保持插入顺序，符合预期

### 4.3 重复键（实测确认）

`JSON.parse('{"Robe":1,"Robe":2}')` → `{"Robe":2}`，**后者胜出，不报错**。

手改 JSON 若写重键会**静默丢数据**。因此：
- `.state.json` 的写路径**不接受**外部提供的原始 JSON 文本，只接受结构化对象
- 解析失败或出现异常时记入 `warnings[]`，面板显式显示

---

## 5. 现状：阶段 0/1 已完成

### 阶段 0 —— 加载链路（✅ 已完成，真机验证）

产出 **闭包工厂**形态的 `lib/client.js`，替换 v0.1.0 的裸 ESM（缺陷 A）。

- `scripts/build.mjs` 产出 `banner` / `intro` / `footer` 包裹，并**内置构建闸门**拒绝 ESM 语法
- `scripts/verify-client.mjs` 用 stub loader **真实求值** `lib/client.js`
- 真机确认：`sidebar.footer.action` 与 `shell.overlay` 均有 occupant，按钮可见可开

### 阶段 1 —— Host 只读工具族（✅ 已完成，11 个工具真机验证）

| 族 | 工具 |
|---|---|
| `tools/roll.mjs` | `dnd_roll` `dnd_check` `dnd_attack` `dnd_save` `dnd_mastery` `dnd_dc` |
| `tools/lookup.mjs` | `dnd_srd_lookup` |
| `tools/campaign.mjs` | `dnd_campaign_state` `dnd_campaign_search` `dnd_arc_status` |
| `tools/sheet.mjs` | `dnd_character_get` |

**依赖形态**：`inject: ['tools']`（唯一硬依赖）；`fs` **软依赖**，5/11 工具需要，
惰性读取以便晚注册的 fs 也能用；`logger` 软依赖。

**真机抓出的 3 个 bug**（全部由重启实测发现，无一为读代码所得）：

| # | Bug | 为何测试漏掉 |
|---|---|---|
| 1 | BOM 致"无活跃战役" | 手写 fixture 不含 BOM |
| 2 | 挂载时缓存 `fs` | mock 的 fs 永远就绪 |
| 3 | 传路径而非 `FsTarget` | **mock 比真实实现宽松** |

**第 3 个的教训最重**：mock 接受字符串，于是它验证的是"代码怎么调"而非"服务怎么定义"。
**比真实实现宽松的 mock 不可能失败。** 已重建为严格形态（传字符串即抛 `TypeError`）。

**另一处自我更正**：曾把"解析器只认 `| Slot |`"当作 v0.1.0 的缺陷。
查证后：模板（`templates/character-sheet.md:67`）与 `session_recap.py:153` 都明确写
**`| Level | Total | Used |`**，`alice.md` 完全正确。`Slot` 是**我自己凭空假设的表头**，
是我在重写时**新引入**的 bug，比原缺陷更严重（原来是少显示，我的是完全不显示）。
**根因：照想象写，而非照权威来源写。**

---

## 6. 后续阶段

### 阶段 2 —— 状态层（✅ 已完成，真机验证）

拆分为 **2a–2h** 逐段实施，每段测试通过后再进下一段。产物：

| 模块 | 职责 |
|---|---|
| `tools/state-schema.mjs` | 结构化 schema + **确定性**序列化（26 断言） |
| `tools/state-rules.mjs` | **货币单一整数**换算 + 合法性校验 |
| `tools/frontmatter.mjs` | YAML frontmatter 读写（子集，无依赖） |
| `tools/clock.mjs` | **双时钟**：实钟 + 世界钟（读 `calendar.json`） |
| `tools/sheet-split.mjs` | 拆分：结构化 / 叙事 / 元数据 |
| `tools/state-io.mjs` | 读写两文件，读**永不写** |

**一个角色 = 两个文件**：

```
characters/alice.state.json   结构化状态（机器权威）  currency 为单一整数
characters/alice.md           frontmatter + 摘要块 + 叙事（人维护）
```

**已确立的规则**：

1. **每个事实只有一个归属**——数值在 `.state.json`，叙事在 `.md` 正文，
   文件属性（player/campaign/updated/worldTime/tags）在 `.md` frontmatter
2. **货币是单一铜币整数**。三级币种只出现在读写边界。
   **理由**：三分字段永远存在中间态，改其一就产生「算术正确、物理无意义」的值
   （`8 gp 0 sp 0 cp` 花 15 cp → `-15 cp`）。单一整数让坏状态**无法被构造**
3. **买单看总额**，不看单个币种——800 cp 买得起 15 cp 的东西，即使没有铜币
4. **买不起就拒绝**，不记账。校验只报告、绝不修正——「把负数改成 0」比 bug 更糟，
   因为 DM 看到貌似合理的数字，永远不知道角色曾处于不可能状态
5. **分层**：`dnd_spend` 等工具在**工具层**做业务判断（买不起 → 返回给 DM），
   `writeCharacter` 的校验作**兜底**。拒绝购买是业务决定，不该只在写入层发生
6. **读取永不写入**——面板会轮询，读操作若能写，每次翻页都是一次文件改动

**阶段 2 真机/实测抓出的 bug（8 个）**：

| # | Bug | 后果 | 为何测试漏掉 |
|---|---|---|---|
| 1 | BOM 致"无活跃战役" | 工具报错 | 手写 fixture 不含 BOM |
| 2 | 挂载时缓存 `fs` | 数据工具全废 | mock 的 fs 永远就绪 |
| 3 | 传路径而非 `FsTarget` | 目录列举恒空 | **mock 比真实实现宽松** |
| 4 | 豁免分隔行误判 | 六项豁免全 `null` | fixture 无负值豁免 |
| 5 | `**Currency:**` 当物品 | 背包多出假条目 | 未测真实角色卡 |
| 6 | 熟练豁免丢修正 | `+5*` → NaN | fixture 无熟练标记 |
| 7 | **空 frontmatter 摧毁文档** | 下次读取**吞掉整个文件** | 未试过空元数据 |
| 8 | 摘要块当正文 | 每次写入**套娃**一层 | 只测了一次往返 |

**第 3 个的教训最重**：mock 接受字符串，于是它验证的是"代码怎么调"而非"服务怎么定义"。
**比真实实现宽松的 mock 不可能失败。** 已重建为严格形态。

**另一处自我更正**：曾把"解析器只认 `| Slot |`"当作 v0.1.0 的缺陷。
查证后：模板（`templates/character-sheet.md:67`）与 `session_recap.py:153` 都明确写
**`| Level | Total | Used |`**，`alice.md` 完全正确。`Slot` 是**我自己凭空假设的表头**。
**根因：照想象写，而非照权威来源写。**

### 阶段 3 —— 跨端通道 + 角色面板

> 前置：阶段 2 已验收（`campaigns/stage2-test` 端到端跑通）。

**分为 3a–3e 五步**，每步可独立验收。原计划把五件事堆成一个阶段，
出问题无法定位——v0.1.0 的失败模式正是「业务逻辑写在能加载之前」。

#### 3a 路由（无 UI）

- `src/host/routes.mjs`：`inject(['webServer'])` + `ctx.effect()` 管理 disposer
- `GET /dnd/characters` → JSON
- **契约测试**：用真实 http 请求打这条路由

**验收**：`curl 127.0.0.1:3080/dnd/characters` 返回 Alice 的 JSON。

#### 3b Client 改 fetch（UI 不变）

- `host.call` → `fetch`（相对路径，裸 fetch，无 credentials）
- **UI 保持 smoke**，只把数据源换成真实路由
- **先证明通道通，再做面板**——v0.1.0 就是面板写完了才发现 `host.call` 在
  bundle 里根本不可用（缺陷 C）

**验收**：重启后 smoke 面板显示「读到 N 个角色」。

#### 3c 真实角色面板

- HP 条 / 六维 / 技能 / 攻击 / 法术位 / `warnings[]`
- 替换 smoke 面板

**验收**：面板显示 `stage2-test` 的 Alice 真实数据（HP 5/8, AC 12, INT 17 (+3),
法术位 1环 1/2, 7 gp 8 sp 5 cp），`warnings[]` 有内容时显式显示。

#### 3d 写入工具

- `dnd_track` / `dnd_spend` / `dnd_xp_add`
- **业务判断在工具层**（§6 规则 5）：买不起 → 工具返回给 DM，写入层校验只作兜底
- **幂等性**：重复请求不重复扣款
- 全部测试在 `stage2-test`

**验收**：`dnd_spend` 买得起 → 写入；买不起 → 拒绝且文件字节不变。

#### 3e 工具参数校验

- 补 `query` 等必填校验（真机误传暴露：缺 `query` 时执行成搜索 `"undefined"`）

---

### 阶段 3 实施结果（已完成）

**3a–3e 全部实施并通过 `npm run check`**（11 个单元/契约套件 + 无头 Client 校验
+ 写入工具场景脚本）。

#### 交付物

| 文件 | 作用 |
|---|---|
| `src/host/routes.mjs` | `GET /dnd/characters`、`GET /dnd/health` |
| `src/client/panels/character.js` | 真实角色面板（替换 smoke） |
| `src/host/tools/track.mjs` | `dnd_track` / `dnd_spend` / `dnd_xp_add` |
| `scripts/verify-client.mjs` | 无头跑 client.js：注册 + 渲染整棵树 |
| `scripts/write-tools-scenario.mjs` | 走真实 `execute()` 的写入验收 |
| `test/tool-args.test.mjs` | 空参数行为审计，16 个工具全覆盖 |

工具总数 11 → **14**。

#### 阶段 3 抓出的 bug（6 个）

| # | Bug | 后果 | 为何测试漏掉 |
|---|---|---|---|
| 9 | `ctx.get('webServer')` + 外层 `ctx.effect` | 路由**静默不注册**，404 空 body | `register()` 返回 disposer 且报成功 |
| 10 | 新字段未列入 `TOP_LEVEL_ORDER` | `conditions` / `appliedKeys` **写入即丢失**，幂等失效 | 归一化静默丢字段，工具报告成功 |
| 11 | `conditions` 不在 `ALWAYS_PRESENT` | 面板读 `.length` 抛错 | 未测「从未中状态」的角色 |
| 12 | 法术位符号取反 | `used` **朝反方向变**，且看着合理 | **测试写的是同样的错**，会锁死 bug |
| 13 | `String(undefined)` 当数据（3e） | 搜索 `"undefined"`，像一次正常未命中 | 空串检查拦不住非空串 |
| 14 | `dnd_track` 空参数仍写入 | 未改变任何值却刷新双时钟 | 无 `required` 可依赖（字段本就全可选） |

**第 9 个的教训**：`register()` 成功 ≠ 路由生效。**失败是无声的**，
所以 `mountRoutes` 现在**抛异常**并在消息里写明修法。

**第 12 个的教训**：**测试和被测代码犯了同一个错**，于是测试通过、bug 留存。
写入类断言必须独立于实现推导期望值。

**第 14 个的教训**：`required` 是给模型的**提示，不是强制**。工具必须自查参数；
但更根本的是「**什么都没改就不该落盘**」——这才是该断言的性质。

#### 关于 mock 的第三次教训

`verify-client.mjs` 的 React stub 一开始返回**死 setter、吞掉 effect**，
于是「展开态渲染」检查是**空的**：数据 effect 从未运行，body 停在 `idle`，
`Body` 返回 `null`，角色子树**从未被构建**。

**不能失败的 mock 不可能验证。** 重建后 stub 会跑 hook、跨渲染保留 state、
walk 整棵元素树，并**用变异测试证明它真的会失败**。

#### 验收方式的一贯原则

- **拒绝类断言比对文件哈希**，不比对重读值——「文件不该变」是关于**字节**的断言，
  用同一个解析器重读只会自我印证
- **写入测试全部在 `campaigns/stage2-test`**；活动战役标记在 `finally` 中还原，
  且**按字节读写**（`readFileSync(_, 'utf8')` 会吞掉 BOM）
- 真实 `morgansfort/alice.md` 每次运行前后哈希比对，sha256 始终保持
  `91a90f00…`，且其旁不出现 `.state.json`

---

### 关于安全层：**明确不做**（决策记录）

参照实现 `dsh-task-board` 有 loopback 检查、CSRF tripwire、proxy token、
body 上限。**本项目一概不做**，理由如下。

**事实**：`dsh-web-app/cordis.patch.yml` 写的是
`host: !!js ctx.webStartup.host ?? '127.0.0.1'`——**默认绑定回环**。
要监听局域网必须有人**主动改配置**。

**判断**：`dsh-task-board` 是**发布给所有 DSH 用户的通用插件**，用户可能配
`0.0.0.0`、走反向代理、暴露公网，所以它必须自己设防。`dsh-dnd` 是**本机私人
插件**，就在自己的机器上玩 D&D。为「除非主动配置否则不会发生」的情况加防护，
是**为想象中的威胁写代码**。

**更重要的分层理由**：若真到了需要防局域网的地步，该修的是**绑定地址**，
不是给每条路由加一遍检查。每个插件作者各自判断安全边界本身就是错误的分层。

**保留的唯一防护**：`register()` 的 disposer 必须交给 `ctx.effect()`。
因为 `webServer` 契约明确「重复 (kind, path) **抛异常**」
（`dsh-host-webserver/lib/types/index.d.ts:85-90`），热重载时旧路由未清理会
**导致挂载失败**。这不是安全考虑，是正确性问题。

**这处错误的性质**：与 `| Slot |` 表头错误**是同一类错误的反面**——
那次是**凭空想象**一个不存在的规范，这次是**过度套用**一个不适用的规范
（把「权威实现的做法」当成了「权威规范」）。前者是特定场景的解决方案，
后者才是必须遵守的契约。

### 阶段 4 —— 发布

1. `v0.2.0` 打 tag，README 补安装指令（`dsh plugin --profile web add ...`）
2. `package.json` 版本号改为合法 semver（当前 `0.2.0-stage0` 不可发布）
3. **真实战役迁移**：`morgansfort/alice.md` 拆分——**需你明确同意后才执行**，
   且迁移前备份

**验收**：全部写入测试在 throwaway 战役；**真实 `morgansfort/alice.md` 保持不动**。

---

## 7. 验收标准

**阶段 2 已完成（✅ 实测通过）**：
- [x] `.state.json` 序列化**确定性**：同一对象两次序列化字节相同
- [x] 序列化→解析→序列化 **幂等**
- [x] 中文物品名/法术名 round-trip 无损
- [x] `.md` 摘要块外的正文**写入前后字节相同**
- [x] 迁移后再次迁移**到达不动点**（1636 → 1636 字节，哈希相同）
- [x] 读取真实 `alice.md` 后**字节不变**，且**不产生** `.state.json`
- [x] **买不起就拒绝**：拒绝写入时文件**字节不变**
- [x] 货币花销统一在总额上运算：800 cp 花 15 → **785 cp**（显示 `7 gp 8 sp 5 cp`）

**阶段 3 验收**：
- [x] 页面无 `__ModuleLoader__` / `Invalid effect` 报错
- [x] `apply` 返回函数/nullish/可迭代，**绝不返回裸对象**（`verify-client` 断言）
- [x] 无 `import()`、无 `process`/`Buffer` 裸全局（构建闸门 + 契约测试）
- [x] 面板显示的数值与 `.state.json` 一致
- [x] `ctx.inject(['webServer'])` + `ctx.effect()` 挂载，重复注册抛异常
- [x] 买不起 → 拒绝且文件**字节不变**；重复 `key` 不二次扣款
- [x] 空参数不写入（16 个工具全审计）
- [ ] `Slots.listSubTree` 看到 occupant —— **需真机重启后确认**（见下）

**验证方法（重要）**：
> **动态 Cordis 插件无法验证 bundle**（不同契约）。
> 唯一有效验证 = **真实安装 → 重启 → 查槽位 occupant + 面板数据**。

> ⚠️ **尚未做的一次验证**：`/dnd/characters` 路由挂载修复（bug 9）之后
> **还没有重启过 DSH**。改动生效于**进程重启**，不是热重载。
> 面板与路由的真机确认仍然待办，是阶段 4 的第一件事。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Client 再次加载失败 | 阶段 0 已过关；构建闸门 + headless verify 持续守卫 |
| 面板显示错数据 | `warnings[]` 显式显示，绝不静默 |
| 破坏真实战役数据 | 全部写入测试在 throwaway 战役；`morgansfort/alice.md` 只读 |
| **迁移损坏旧角色卡** | 迁移前备份；先解析成功再改写 |
| 序列化不确定致假 diff | §4.1 归一化字段顺序 + 幂等测试 |
| 手改 JSON 写重键丢数据 | §4.3 写路径只接受结构化对象 |

---

## 9. git 策略

```
v0.1.0   7be8adc  Client 加载失败（原始缺陷）
阶段 0   7ce6dc8  闭包工厂 + 构建闸门
阶段 1   12febba  11 个只读工具
         a8bc7df  fs 依赖修复（后被 0ca5136 修正）
         0ca5136  仅 tools 硬依赖
         0d6f72e  FsTarget 契约修复
计划 v2  db5edca  定位重写：独立数据层，skill 仅供参考
阶段 2   da104e1  state-schema + 确定性序列化
         8a6fa01  拆分：状态 / 元数据 / 叙事
         9abd241  写路径剥离过期内联元数据
         dd8a0d5  货币单一整数 + 拒绝写入非法状态
阶段 3   794a85d  路由改由 ctx.inject 挂载（bug 9）
         2c1bb8c  真实角色面板，替换 smoke（3c）
         6bdcc82  写入工具 dnd_track / dnd_spend / dnd_xp_add（3d）
         65bc706  工具参数校验 + 16 工具空参数审计（3e）
阶段 4   (待做)   发布 v0.2.0：semver、README 安装指令、打 tag
```

`lib/` 继续入库——`link:` 安装需要，免构建。

---

## 10. 已确认决策记录

| 问题 | 决策 |
|---|---|
| 叙事/状态划分 | ✅ 分离为 `.md` + `.state.json` |
| 文件格式 | ✅ **JSON pretty**（TOML 因需手写解析器而否决）|
| 法术列表 | ✅ 结构化 |
| 装备背包 | ✅ 结构化，**字典 `name -> qty`**；杂物件由大模型按上下文判断 |
| Features & Traits | ✅ 纯文本，留在 `.md` |
| 装备数量表达 | ✅ 字典键值对（非 `"Parchment x8"`）|
| 与 skill 的关系 | ✅ **仅供参考，不再调用** |
| 写入互斥 | ✅ **不需要**（无第二写入者）|
| 元数据位置 | ✅ `.md` frontmatter（YAML 子集） |
| 时钟 | ✅ **双时钟**：实钟 + 世界钟，每次写入都刷新 |
| 摘要块内容 | ✅ **只有数值**，不含元数据 |
| 货币存储 | ✅ **单一铜币整数**，币种只在读写边界 |
| 货币运算 | ✅ 统一在总额上运算，**只在总额不足时报错** |
| 买不起 | ✅ **拒绝写入**，不记账；业务判断在工具层 |
| 校验行为 | ✅ **只报告，绝不修正** |
| 幂等性 | ✅ **调用方给 `key`**；无 key 则每次都应用（连打两次=两次伤害）|
| 幂等键存储 | ✅ 存在 `.state.json` 的 `appliedKeys`，**上限 32 条**（重试是秒级的）|
| HP 越界 | ✅ **钳制并报告**（0 是地板，不是错误；死亡豁免从 0 开始）|
| 临时 HP | ✅ **不叠加**，取较高者（规则如此；求和会让角色比规则更强）|
| 升级 | ✅ `dnd_xp_add` **只加经验，不自动升级**——升级改写 HP/法术位/特性，是规则决定 |
| 安全层 | ✅ **不做**（见上；本机单人插件，默认绑回环）|
