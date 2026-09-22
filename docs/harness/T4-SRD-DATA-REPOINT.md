# T4 — `dnd_srd_lookup` 数据路径重指向：结论记录

> 任务：`docs/PLAN-dnd-preset-defects-TASK-BOARD.md` 的 **T4**
> 日期：2026-09-19
> 结论：**缺陷已修复，真机验证已通过。** 数据集从战役工作区移入插件包 `data/`，成为插件自带依赖。
> 与看板原文的差异见第一节：修法**不是**指向 `refferenceskills/`，而是**把数据搬进包里**（用户裁定）。

---

## 一、与看板原文的差异（用户裁定）

看板 T4 原提示词要求把路径改到 `D:/DND/refferenceskills/dnd/data/`。执行前用户改判：

> 「将 data 中的规则文件移动到 dsh-dnd-bundle 中，这应该是插件内置的依赖，不能放在工作区内，需要同步」

这个改判是对的，且比原方案更根本：

| | 原方案（指向 `refferenceskills/`） | 实际方案（搬进包内） |
|---|---|---|
| 归属 | 仍是**工作区里的外部路径**，插件依赖工作区布局 | 数据**随包发布**，插件自包含 |
| 复发风险 | 该目录被移动/重命名/清理 → 同一缺陷复发 | 包在哪数据在哪，与工作区解耦 |
| 语义 | 「SRD 数据集碰巧放在那儿」 | 「SRD 数据集是本插件的依赖」 |

原缺陷的**根因不是路径写错，而是归属错位**：一张随插件发布的查询表被放在了战役工作区里，
于是任何一次清理都能把它带走 —— 事实上已经发生过一次（用户删掉了 `.agents/skills/dnd/`）。

---

## 二、修复前实测（缺陷证据）

在运行中的进程内调用真机工具：

```
dnd_srd_lookup { query: "goblin" }
→ SRD dataset not found for ruleset 2014: D:/DND/.agents/skills/dnd/data/dnd5e_srd.json
```

两个问题：

1. **数据集确实拿不到** —— `D:/DND/.agents/skills/dnd/` 已被用户故意删除（现为空目录）。
2. **报错不可操作** —— 「dataset not found」读起来像「这条目不存在」，
   即一次**正常的查询未命中**。DM 会把它当成合法结果接受并继续跑团，
   而不是意识到**插件没装全**。这是本缺陷能藏住的原因。

---

## 三、改了什么

### 3.1 数据搬家

```
D:\DND\refferenceskills\dnd\data\  →  D:\DND\dsh-dnd-bundle\data\
  dnd5e_srd.json        1,263,812 字节   sha256 前缀 a2237515cb48df0d
  dnd5e_srd_2024.json   1,533,791 字节   sha256 前缀 e8dc3abc8bad4c32
  dnd5e_supplemental.json  19,242 字节   sha256 前缀 cd1465065cddb463
```

**逐字节副本**（上表哈希为搬运后实测，与源文件一致）。源目录**保留未动**。

### 3.2 路径解析：`SKILL_ROOT` → `DATA_ROOT`

`src/host/tools/shared.mjs`：

```js
export const DATA_ROOT = new URL('../../../data', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')   // Windows: URL pathname 是 /D:/...，fs 服务要 D:/...
```

**为什么用 `import.meta.url` 而不是配置根**：插件行按**裸包名**挂载，
`import.meta.url` 就是锚点 —— 包装在哪（本机是 `link:` junction，将来可能是 registry 包），
`data/` 都在 `lib/host/tools/` 的上两级。配置路径会把「位置只对一台机器的布局成立」
这件事重新引入，正是本次要消除的失败模式。

`import.meta` 是**语言特性**，不是被 import 的 node builtin，
所以 `shared.mjs`「不引入任何 builtin」的既有约束仍然成立（该文件顶部注释所述）。

### 3.3 修复 `SKILL_ROOT` 常量

`SKILL_ROOT` 被删除（全仓库只剩 `lookup.mjs` 一处使用，已随之改写）。
不再保留一个指向已删除目录的常量。

### 3.4 报错可操作化 + 与「未命中」可区分

`src/host/tools/lookup.mjs`：

- 数据集缺失 → `[dataset missing]` 标签 + 缺哪个文件 + 去哪找 + **怎么修**
- 查询未命中 → `[no match]` 标签 + 明确「**数据集已被搜索**，所以这条目就是不在里面」

两个标签是**机器可判定**的区分，测试直接断言它们。此前两者都以「not found」措辞收尾。

### 3.5 `package.json` 的 `files` 补上 `data`

原来只列 `lib`。数据集成为随包发布的依赖后，**必须**进 `files`，
否则发布出去的包里没有数据 —— 那就是同一个缺陷换个形式复发。

### 3.6 测试

`test/host.test.mjs`：

- 重映射豁免从 `.agents/skills/dnd/data` 改为同时豁免包内 `data`（保留原行，
  因为它是「为什么豁免」的记录）。
- 新增：**两个 ruleset 都返回真实条目**（证明数据集既找得到、也解析得了）。
- 新增：**缺失与未命中可区分** —— 断言 `[no match]` 与 `[dataset missing]` 各自出现、
  且互不冒充；后半段临时让 `dnd5e_srd.json` 的 `stat` 返回 undefined，逼出 `[dataset missing]`。

---

## 四、验收：可复现命令与实测输出

### 4.1 数据集确实从新位置加载（直接 import 构建产物）

```
$ node -e "import('./lib/host/tools/shared.mjs').then(m=>console.log(m.DATA_ROOT))"
DATA_ROOT = D:/DND/dsh-dnd-bundle/data
```

### 4.2 两个 ruleset 都命中真实条目

```
ruleset 2014 -> [ruleset 2014] 2 matches:
ruleset 2024 -> [ruleset 2024] 5 matches:
```

（`query:"goblin"`, `category:"monster"`）

### 4.3 未命中与数据集缺失可区分

```
$ dnd_srd_lookup { query: "zzzznotathing" }
[no match] No SRD entry matches "zzzznotathing" (ruleset 2014).
The dataset was searched, so this entry is simply not in it.
```

### 4.4 变异验证：新测试**能失败**

把 `DATA_ROOT` 改回已删除的旧路径，`host.test.mjs` 立即变红：

```
FAIL dnd_srd_lookup finds a spell
     [dataset missing] The 2024 SRD dataset is not installed: D:/DND/.agents/skills/dnd/data/dnd5e_srd_2024.json
FAIL dnd_srd_lookup honours an explicit ruleset override
FAIL dnd_srd_lookup reports an honest miss
FAIL dnd_srd_lookup reads the datasets the PACKAGE ships, for both rulesets
```

改回后全绿。**测试不是镜子。**

### 4.5 构建与套件

```
$ npm run build      → build OK
$ npm test           → 12 套件全绿（含新增的 T4 断言）
$ npm run test:ownership → 24 files audited, all assertions passed
$ npm run verify     → verify-client OK — the bundle registers and renders headlessly
```

`lib/` 与 `src/` 哈希一致（两个改动文件实测 MATCH）。

### 4.6 `lib/` 是入库产物，已重建

`host/tools/shared.mjs`、`host/tools/lookup.mjs` 的 src↔lib sha256 均 MATCH。

---

## 五、真机验证：**已完成（用户重启后复验通过）**

**bundle 改动必须重启 harness 才加载**，执行者按硬约束未自行重启。
用户在**重启前**的实测为：

```
dnd_srd_lookup { query: "goblin" }
→ SRD dataset not found for ruleset 2014: D:/DND/.agents/skills/dnd/data/dnd5e_srd.json
```

用户重启 harness 后，在**运行中的真机进程内**复验（同一进程、同一 `lib`）：

| 调用 | 结果 |
|---|---|
| `{ query: "goblin", category: "monster" }`（跟随活跃战役 ruleset） | ✅ `[ruleset 2014] 2 matches` —— Goblin、Hobgoblin，含完整 statblock |
| `{ query: "goblin", category: "monster", ruleset: "2024" }` | ✅ `[ruleset 2024] 5 matches` —— Goblin Boss / Minion / Warrior、Hobgoblin Captain / Warrior |
| `{ query: "fireball", category: "spell", ruleset: "2014" }` | ✅ 2 matches —— Fireball (Level 3)、Delayed Blast Fireball (Level 7) |
| `{ query: "poisoned", category: "condition" }` | ✅ 1 match —— Poisoned，含规则文本 |
| `{ query: "longsword", category: "weapon" }` | ✅ 1 match —— Longsword |
| `{ query: "zzzznotathing" }` | ✅ `[no match] … The dataset was searched, so this entry is simply not in it.` |

**三条关键验收在真机上成立**：

1. **2014 与 2024 两个数据集都命中** —— 且各自返回**该规则集独有**的条目
   （2014 是 Goblin / Hobgoblin；2024 是 Goblin Boss / Minion / Warrior、
   Hobgoblin Captain / Warrior，statblock 格式也不同：2024 用「Action — Scimitar (1d6 slashing)」，
   2014 用「Action — Scimitar: Melee Weapon Attack: +4 to hit…」）。
   这证明读到的确实是**两个不同的数据集**，而不是同一个文件被读两次。
2. **`query="goblin"` 返回条目**，不再是 `[dataset missing]` —— 缺陷已消除。
3. **缺失与未命中在真机上可区分** —— 未命中返回 `[no match]`，且明确「数据集已被搜索」。

`[dataset missing]` 分支**未在真机上复现**（真机数据集完好，构造不出来）——
该分支由 **4.4 的变异验证**覆盖（把 `DATA_ROOT` 改回旧路径即触发）。

**限制说明**：未在重启前后逐字节比对进程加载的模块，所以「进程确实加载了新 `lib`」
这一结论的证据是**行为性的** —— 旧路径下该调用必然失败，重启后成功，
且返回内容随 ruleset 变化。这与「加载了新产物」一致。

---

## 六、数据安全与约束

| 检查项 | 结果 |
|---|---|
| `campaigns/morgansfort/characters/alice.md` sha256 | `109c048c…70db` **未变**（与 T4 基线一致） |
| `campaigns/morgansfort/characters/alice.state.json` sha256 | `428ad562…d105` **未变** |
| `.runtime/active-campaign.json` | 27 字节、BOM `239,187,191` 完好、哈希 `276b1b66…` **按字节未变** |
| `.agents/skills/dnd/` | **未重建**（仍为空，0 项） |
| `refferenceskills/dnd/` | **未改动**（源文件仍在） |
| `git commit` / `tag` / `push` | **无**（HEAD 仍为 `45fc4b8`） |
| 重启 harness / web profile | 执行者**未重启**；由用户自行重启以完成真机验证（第五节） |
| 修改 `C:\Users\Ming\.dsh\profiles\web\` | **无** |
| 修改 `node_modules` | **无** |
| 新增 npm 依赖 | **无** |

**以上全部在用户重启后再次复验，结果相同**（`alice.md` 与重启前同值，
marker 仍 27 字节、BOM 完好、哈希 `276b1b66…`）。

**关于看板的一条基线**：T4 与「三、通用验收条件」都写
`alice.state.json` 基线为 `fefd308e…`。**实测该值对不上** ——
当前（也是本轮开始前的）真实值是 `428ad562…`，且 `campaigns/morgansfort/` 下
不存在任何 `fefd308e` 开头的文件。看板该行基线是错的，本轮以**实测值**为准并全程未变。
（`alice.md` 的 `109c048c…` 基线则完全吻合。）

---

## 七、本轮发现的两个既有缺陷（**不在 T4 范围内，未修**）

跑 `npm run check` 时，`test:writes` 与 `test:concurrency` 各有**同一处**失败：

```
FAIL and the real campaign is active again
```

原因：两个脚本都**硬编码**活跃战役必须是 `morgansfort`：

```js
// scripts/write-tools-scenario.mjs:394
check(JSON.parse(...).name === 'morgansfort', 'and the real campaign is active again')
```

而当前 `.runtime/active-campaign.json` 指向 `retest-alice`（用户跑团时合法切换的）。

**已证实与本轮改动无关**：把本轮全部改动 `git stash` 后在**原始代码**上复跑，
两处失败**同样出现**。这是「测试断言了合法可变的状态」——
正是 `docs/harness/TEST-DATA-OWNERSHIP.md` 所禁止的**快照断言**。

**未修的理由**：属于 T4 范围之外，且看板明确要求「不做任何超出本卡的内容」。
本轮的 6 个套件段（build / 12 suites / ownership / verify）全绿，
失败只在这两个 scenario 的这**一条**断言上。

建议另立卡：把该断言从「活跃战役名叫 morgansfort」改为不变量
（「运行前后 marker 按字节相同」，脚本里**已经有**这一条且通过），
即删掉/改写这条快照断言。

---

## 八、遗留观察（未处理）

- `data/dnd5e_supplemental.json` 与 `data/graph/verb_table_seed.yaml` **未被搬运**：
  当前 14 个工具都不读它们（`lookup.mjs` 只用两个 SRD 文件）。
  只搬了插件实际依赖的两个文件，避免把无关资产带进包。
- `refferenceskills/dnd/` 保持原样，供 skill 文档参考；插件**不调用**它。
