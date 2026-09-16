# dsh-dnd 重写方案：功能清单与实施计划

> 状态：**规划完成。阶段 0、1 已实施并真机验证。**
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

  "currency": { "gp": 8, "sp": 0, "cp": 0 },
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

### 阶段 2 —— 跨端通道 + 角色面板

1. **拆分状态与叙事**：新增 `src/host/tools/state-io.mjs`
   - `readState(fs, dir, name)` → 解析 `.state.json`（不存在则从 `.md` 迁移，见下）
   - `writeState(fs, dir, name, state)` → 确定性序列化 + 原子替换
   - **迁移路径**：首次遇到只有 `.md` 的角色时，解析其结构化区块生成 `.state.json`，
     并把 `.md` 中的结构化区块替换为摘要块。**迁移前备份原文件**
2. **摘要工具**：`formatCharacter` 已有，扩展为从状态对象生成（实测 1055 → ~120 token，降 88%）
3. **`src/host/routes.mjs`**：`ctx.inject(['webServer'], ...)` + `ctx.effect()` 注册
   `GET /dnd/characters`（`webServer.register({kind:'exact', path, handler})`）
4. **Client 改用 `fetch`**，移除所有 `host.call`（缺陷 C —— bundle 无 `pluginId`/`pluginRunId`）
5. **真实面板**：HP 条 / 六维 / 技能 / 攻击 / 法术位 / `warnings[]`
6. **补工具参数校验**（真机测试中误传参数暴露：缺 `query` 时执行成搜索 `"undefined"`）

**验收**：面板显示 morgansfort 的 Alice 真实数据（HP 8/8, AC 12, INT 17 (+3), 法术位 1环 0/2）。

### 阶段 3 —— 写入 + 发布

1. `dnd_track` / `dnd_xp_add` 写入 `.state.json`（**无互斥需求**——没有第二个写入者）
2. 定点更新 `.md` 的摘要块，正文不动
3. `v0.2.0` 打 tag，README 补安装指令（`dsh plugin --profile web add ...`）
4. `package.json` 版本号改为合法 semver（当前 `0.2.0-stage0` 不可发布）

**验收**：全部写入测试在 throwaway 战役；**真实 `morgansfort/alice.md` 保持不动**。

---

## 7. 验收标准

**通用**：
- [ ] 页面无 `__ModuleLoader__` / `Invalid effect` 报错
- [ ] `Slots.listSubTree` 能看到 dsh-dnd 的 occupant
- [ ] `apply` 返回函数/nullish/可迭代，**绝不返回裸对象**
- [ ] 无 `import()`、无 `process`/`Buffer` 裸全局

**验证方法（重要）**：
> **动态 Cordis 插件无法验证 bundle**（不同契约）。
> 唯一有效验证 = **真实安装 → 重启 → 查槽位 occupant + 面板数据**。

**新增（本次修订）**：
- [ ] `.state.json` 序列化**确定性**：同一对象两次序列化字节相同
- [ ] 序列化→解析→序列化 **幂等**
- [ ] 中文物品名/法术名 round-trip 无损
- [ ] `.md` 摘要块外的正文**写入前后字节相同**

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
v0.2.0           阶段 2 完成（状态层 + 跨端 + 面板）
v0.3.0           阶段 3 完成（写入 + 发布）
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
