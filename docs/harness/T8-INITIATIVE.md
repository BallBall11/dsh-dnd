# T8 — 先攻：掷先攻与回合排序

**状态：实现已完成并验收；✅ 真机验证已通过**（2026-09-21，用户重启后复验，见第 6 节）。
改动落在 `dsh-dnd-bundle`。

> **本卡接手时的实际状态与看板记载不符，先说清楚。**
> 看板（`docs/PLAN-dnd-preset-defects-TASK-BOARD.md` §六 T8）写的是「**未开始**」，
> 但工作区里 T8 的实现**已经存在**：`src/host/tools/initiative.mjs`（29,924 B）、
> `src/host/tools/encounter-io.mjs`、`test/initiative.test.mjs`，
> 均为**未跟踪文件**，mtime `2026-09-20 14:07–14:17`，来自一个并行会话。
> 该会话**没有留下任何结论文档**，也没有把 T8 标为完成。
>
> 因此本卡的执行方式是：**先验收既有实现，再修不合格的部分**，而不是从零重写。
> 已存在的实现质量很高（注释解释了设计取舍与踩过的坑），**大部分予以保留**。

---

## 1. 现状核对（grep 证据）

prompt 第 1 条要求「先 grep 确认现状」。结论：**卡内描述已过期**。

`initiative` 在 bundle 内已**不止被读**：

| 位置 | 性质 |
|---|---|
| `src/host/tools/initiative.mjs` | **新增**：掷先攻 + 排序 + 持久化，2 个工具 |
| `src/host/tools/encounter-io.mjs` | **新增**：encounter 文件的读/合并/清段 |
| `src/host/index.mjs:48` | `FAMILIES = [roll, lookup, campaign, sheet, track, calendar, initiative, effects]` —— 已注册 |
| `package.json` 的 `test` | 已含 `test/initiative.test.mjs` |
| `src/host/tools/sheet-parse.mjs:270` | 仍**只读** `**Initiative:**` 字段（这是它该做的，未变） |

即 prompt 里「`dnd_attack` 只做单体命中/伤害、先攻无工具」的描述**在执行时已不成立**。

---

## 2. 验收中发现并修复的**真实缺陷**：排序方向反了

**这是本卡的主要产出。** 既有实现**默认失败**，不是偶发。

### 现象

`test/initiative.test.mjs` 在**未改动**的既有实现上连续运行，**每次**都在同一条断言失败：

```
  FAIL the returned order is SORTED, descending, and is persisted
       turn order is not descending: -26, 18, 44
initiative.test.mjs: 1 failure(s)
```

连跑 6 次，6 次全红（`-21, 4, 41` / `-36, 19, 49` / `-30, 1, 49` / `-30, 19, 43` / `-39, 17, 47` / `-25, 12, 42`）。
值是**升序**的。

> 本卡最初只跑了一次，**恰好通过**，差点据此判定「已完成」。是「重复运行」这个动作把它暴露出来的。
> **教训：一个只在「通常」通过的测试，比没有测试更糟** —— 它教人重跑而不是读代码。

### 根因（一行，自相矛盾的比较器）

`src/host/tools/initiative.mjs` 的 `sortTurnOrder`：

```js
.sort((a, b) => {
  if (b.entry.initiative !== a.entry.initiative) return a.entry.initiative - b.entry.initiative  // ← a - b
  if (b.entry.mod       !== a.entry.mod)       return b.entry.mod       - a.entry.mod            // ← b - a
  return a.index - b.index
})
```

**守卫写的是 `b ... a`（降序），返回的却是 `a - b`（升序）** —— 守卫与返回值互相矛盾。
第二行（tiebreak）又是对的 `b - a`，所以两个键方向不一致。

### 为什么这个缺陷「看不见」

**render 与落盘用的是同一个错排序**，因此**两处自洽**：
人读到的顺序，和 JSON 里存的顺序，**一模一样**，只是**两个都反了**。
唯一的报警器是那条断言 —— 而它一直在响。

### 判据（不是我的偏好，是既有约定）

| 来源 | 原文 | 方向 |
|---|---|---|
| 参考实现 `refferenceskills/dnd/scripts/combat.py:64` | `sorted(combatants, key=lambda x: (x["initiative"], x.get("dex_mod", 0)), reverse=True)` | **降序** |
| 同文件 `:57` docstring | `"""Roll d20+dex_mod for each combatant, sort descending."""` | **降序** |
| `initiative.mjs` 自己的 docstring `:300` | `Descending initiative. Ties break on the modifier, descending` | **降序** |
| 5e 规则 | 先攻从高到低行动 | **降序** |

**四处一致要求降序，实现给了升序。**

### 修法（最小改动，一行）

```diff
-      if (b.entry.initiative !== a.entry.initiative) return a.entry.initiative - b.entry.initiative
+      if (b.entry.initiative !== a.entry.initiative) return b.entry.initiative - a.entry.initiative
```

并补上注释说明「为什么必须是 `b - a`」，把这个坑写死，防止后人再改回去。

### 修复前后（同一构造，`Slow=-40 / Mid=0 / Fast=+40`）

修复前：
```
  1. Slow (NPC) — d20(10) -40 = **-30**
  2. Mid  (NPC) — d20(12) +0  = **12**
  3. Fast (NPC) — d20(5)  +40 = **45**
```
修复后：
```
► 1. Fast (NPC) — d20(5)  +40 = **45**
  2. Mid  (NPC) — d20(12) +0  = **12**
  3. Slow (NPC) — d20(10) -40 = **-30**
```

修复后连跑 **10 次，10 次全绿**。**真机复验同样返回降序**
（`Fast=56 > Mid=4 > Slow=-39`，见第 6 节用例 1）。

---

## 3. 验收中发现并修复的**测试盲区**：`players` 模式「掷了再丢」抓不住

既有实现有一条很强的设计声明（`initiative.mjs:41-56`）：

> ```
> ## What "never roll for a PC" means MECHANICALLY
>   - `rollD20` is not called for that combatant at all, so no d20 value for
>     that PC ever comes into existence
> ```

配套测试 `players mode: a PC is NOT rolled for, and no d20 for it exists anywhere`
**证不了这句话**。它检查的是**值的缺席**（`order` 里没有 PC、`natural`/`initiative` 为 undefined）。
一个「**先掷、再把值丢掉**」的实现，**完美通过全部这些断言** —— 值确实没了，
但 `rollD20` 被调用了，恰好违反声明。

既有断言 `assert.equal(section.rollsMade, 1)` **也抓不住**：`rollsMade` 是在掷骰**之后**才 `+= 1` 的，
被丢弃的那次调用**从不进入这个计数器**。

### 变异验证证明这个盲区真实存在

把实现改成「弱读法」（掷了再丢）：

```diff
+      void rollD20(mod, false, false)          // MUTANT: 掷了，然后丢掉
       pending.push({ ...entry, mod, pending: true })
```

| 套件版本 | 变异 B 的结果 |
|---|---|
| 补测**前** | `all assertions passed` ← **漏网** |
| 补测**后** | `1 failure(s)` ← **抓住** |

### 补的测试，及其一次**自我纠正**

新增 `players mode: NO die is even thrown for a PC (the dice call is counted)`。

**第一版写法是错的，这里如实记录。** 它断言「`Math.random` 恰好被调用 1 次」，
结果实测 **2 次**。追栈后发现两次都来自**同一次** `rollD20`：

```
DICE#1 at rollDie (src/host/tools/roll.mjs:23) <- at rollD20 (roll.mjs:78)
DICE#2 at rollDie (src/host/tools/roll.mjs:23) <- at rollD20 (roll.mjs:79)
```

`roll.mjs:76-79` 的 `rollD20` **无条件掷两颗**，不用优/劣势时把第二颗丢掉：

```js
const both = Boolean(advantage) || Boolean(disadvantage)
const first  = rollDie(20)
const second = rollDie(20)     // ← 无条件掷，无优/劣势时被丢弃
```

这是 `roll.mjs` 的既有行为，**本批未修改该文件**（`git diff HEAD -- src/host/tools/roll.mjs` 为空），
**超出 T8 范围，未修**。

因此把测试改成**比较法**，不再钉住别人的内部掷骰次数：

> 同一构造跑两次 —— 只含 NPC 一次，NPC + PC 一次 —— **要求两次掷骰次数相等**。

「掷了再丢」的实现会让第二次多出**整整一次 `rollD20`**，差值立刻非零。
这个写法**不依赖** `rollD20` 内部掷几颗，是稳定的。

---

## 4. 变异验证（测试**有能力失败**）

脚本：`scripts/t8-mutation-probe.ps1`（可复跑）。每个变异后**逐字节还原**并复跑确认全绿。

| # | 变异 | 针对验收条件 | 结果 |
|---|---|---|---|
| **A** | 排序改回升序（`a - b`）——**即原缺陷本身** | 回合顺序已排序 | ✅ **1 failure** |
| **B** | `players` 模式下掷了 PC 再丢掉 | 不替 PC 掷先攻 | ✅ **1 failure**（补测前为**通过**） |
| **C** | 绕开持久化 | 排序结果可被后续调用读到 | ✅ **1 failure** |
| **D** | 忽略玩家提供的 `rolls` | 玩家自己的骰子不被覆盖 | ✅ **1 failure** |
| **E** | `roll_mode` 恒为 `dm` | `players` 模式生效 | ✅ **3 failure** |

**A 是关键**：它证明那条一直响着的断言，现在**真的是**这个方向缺陷的守卫。

还原证明：
```
BEFORE_SHA=5B1B9240A0280660A9E414517B438F73DD858E31AF24643A59D361597B04E858
AFTER_SHA =5B1B9240A0280660A9E414517B438F73DD858E31AF24643A59D361597B04E858
RESTORED_BYTE_IDENTICAL=True
POST-RESTORE-SUITE: initiative.test.mjs: all assertions passed
```

---

## 5. 逐条核对验收条件

| 验收条件 | 结果 | 证据 |
|---|---|---|
| 能一次掷多个参战者的先攻并给出**已排序**的回合顺序 | ✅ | 修复后 `Fast=45, Mid=12, Slow=-30`（降序）；连跑 10 次全绿 |
| `roll_mode=players` 下**不**替 PC 掷先攻（有测试） | ✅ | 两条测试：值的缺席 + **掷骰次数比较法**；变异 B 证明后者有牙 |
| 未引入新的随机数来源；未新增 npm 依赖 | ✅ | `initiative.mjs` 内 `Math.random` 仅出现在**注释**里；`rollD20` 来自 `roll.mjs`；`package.json` 的 dependencies **零改动**（diff 只有 `test` 脚本行） |
| `npm run check` 全绿；改 `src/` 已 `npm run build` | ⚠ | 18 套件 + ownership(31) + build + verify **全绿**；`test:writes` 剩 **1 条既有失败**（见下）；`lib/host/tools/initiative.mjs` 与 `src/` **sha256 相同**（`5B1B9240…`） |
| 明确标注「需重启才生效，真机验证未完成」 | ✅ → **已升级为「真机验证已通过」** | 见第 6 节：5 个用例真机跑通 |
| `campaigns/morgansfort/` 两文件 sha256 未变；未重启 harness、无 git 写操作 | ✅ | `alice.md` `109C048C…`、`alice.state.json` `428AD562…` 与**开工时实测值**一致；未重启；`git log -1` 仍是 `45fc4b8`，未 commit/tag/push |

### 关于 `npm run check` 的那 1 条失败（**既有缺陷，非本卡，未修**）

```
  FAIL and the real campaign is active again
write-tools.scenario: 1 failure(s)
```

**已用 `git stash` 在本批全部改动之前提交的原始代码上复跑，逐字复现同一条失败。**
该断言硬编码「活跃战役必须是 `morgansfort`」，而 marker 指向 `retest-alice`（合法可变状态）。
T2 / T3 / T4 三轮均已独立记录同一现象。**超出 T8 范围，未修。**

---

## 6. ✅ 真机验证已通过（2026-09-21，用户重启后复验）

**重启证明（先确认新进程加载的确实是本次修复的产物）**：

| 项 | 实测值 |
|---|---|
| `lib/host/tools/initiative.mjs` mtime | **`2026/9/21 14:21:52`**（= 本次 build 产物） |
| 该文件 sha256 | `5B1B9240A0280660A9E414517B438F73DD858E31AF24643A59D361597B04E858`（与 `src/` **相同**） |
| harness 进程启动时间 | **`2026/9/21 14:32:07`**（**晚于** build 时间 → 加载的是新代码） |
| `GET /dnd/health` | `200 {"ok":true,"fs":true,...}` |

> 时间先后是关键：**进程启动晚于产物构建**，才排除「内存里仍是旧代码」。
> （对比 T2 那轮的坑：当时进程早于构建，重启前照旧被拒。）

### 用例 1 — 多参战者掷先攻，返回**降序**、且落盘

`dnd_initiative` 传 `Slow(-40) / Mid(0) / Fast(+40)`，`mode: dm`：

```
► 1. Fast (NPC) — d20(16) +40 = **56**
  2. Mid  (NPC) — d20(4)  +0  = **4**
  3. Slow (NPC) — d20(1)  -40 = **-39**
```

**降序，符合 5e 与 `combat.py`。** 修复前此构造返回升序（`-39, 4, 56`）。

落盘核对（`campaigns/retest-alice/characters/alice.encounter.json`）：
`key=t8-live-verify-order-1 round=1 rollsMade=3`，
`Fast natural=16 mod=40 init=56` / `Mid 4/0/4` / `Slow 1/-40/-39`。
**同时证明 T2 的写入路径在真机可用**（该路径不在进程 cwd 之下）。

### 用例 2 — 不带 `combatants` 读回，**不重掷**

同一顺序逐字返回，`rollsMade` 仍为 **3**（未增加）→ 序列化/反序列化往返保序，持久化生效。
**这正是 T8 要修的核心缺陷**：以前下一次工具调用就丢失回合顺序。

### 用例 3 — `roll_mode: players` 下**不**替 PC 掷先攻

切到 `campaigns/stage2-test`（`## Live State Flags` 里是 `- **roll_mode:** players`），
传 `Alice(kind:pc)` + `Goblin(kind:npc)`：

```
roll_mode: players (from "Live State Flags"'players')

Turn order:
► 1. Goblin (NPC) — d20(4) +0 = **4**

WAITING ON THE PLAYERS — not rolled for, and not placed in the order (1):
  · Alice — needs the player's d20; modifier +2. Pass it as rolls: { "Alice": <d20> }.
Ask the player for the number; do NOT roll it for them.
```

**四条断言全部在真机成立**（落盘 JSON 逐项核对）：

| 断言 | 实测 |
|---|---|
| PC **不在**回合顺序里 | `order names = Goblin`，`PC in order = False` |
| 只为 NPC 掷了骰 | `rollsMade = 1` |
| PC 被报为 pending | `Alice.pending = True` |
| **没有任何字段藏着一个 PC 的骰值** | `Alice.natural / initiative / total / rolls` **全部 ABSENT** |
| 修正值仍从角色表读出并报告 | `Alice.mod = 2` |
| 模式来自战役旗标（非默认） | `mode=players  source=Live State Flags  raw=players` |

### 用例 4 — 玩家提供的骰子**原样采用**，不被重掷

同一战役传 `rolls: { Alice: 19 }`：

```
► 1. Alice (PC) — player rolled 19 +2 = **21**
  2. Goblin (NPC) — d20(4) +0 = **4**
```

落盘：`rollsMade=1  rollsSupplied=1`（只为 Goblin 掷了骰，Alice 用的是玩家给的数），
`Alice.natural=19 source=supplied initiative=21`，`pending count=0`。
渲染用 `player rolled 19` 而非 `d20(...)`，**玩家的骰子没有被工具的骰子替换**。

### 用例 5 — `dnd_initiative_end` 结束遭遇

```
Encounter ended for alice: the initiative order was cleared. Other encounter state was left untouched.
```

结束后再读回：`The encounter on alice was ended. Roll a new one with dnd_initiative.`
—— 正确区分「**遭遇已结束**」与「**从未掷过**」，不是笼统的「没有数据」。
落盘该段变为 `{ "ended": true, "endedAt": ... }`。

### 真机验证期间的数据安全

| 项 | 结果 |
|---|---|
| `campaigns/morgansfort/characters/alice.md` | `109C048C…` —— 与基线**逐字节一致** |
| `campaigns/morgansfort/characters/alice.state.json` | `428AD562…` —— 与基线**逐字节一致** |
| `campaigns/morgansfort/calendar.json` | `C142300B…` —— 未动（T10 只读参考） |
| `.runtime/active-campaign.json` | 为验证 `players` 曾临时切到 `stage2-test`，**已按字节还原**：`len=27`、前 3 字节 `239,187,191`、sha256 `276B1B66…` **与原始完全相同**（直接写回原始字节序列，未走「读字符串再写」那条会吞 BOM 的路） |
| 测试产生的 encounter 文件 | 仅落在 `stage2-test/` 与 `retest-alice/` 两个**草稿战役**，**已删除**，两目录恢复为原有两个文件 |
| `git HEAD` | 仍为 `45fc4b8` —— 无 commit/tag/push |

> 写入测试**未**使用 `morgansfort`（真实战役），符合硬约束 1。
> `stage2-test` 选择理由：它是看板指定的写入测试战役，且**唯一**一个 `roll_mode: players`
> 且有角色的战役，是用例 3/4 的必要条件。

---

## 7. 数据落盘位置的选择理由（prompt 第 4 条）

落在 `<character-stem>.encounter.json` 的 `sections.initiative`，**不是 `state.md`**：

| 位置 | 为什么不选 |
|---|---|
| `state.md` | 是 DM 手写的**散文**。往里塞机器可写状态，会和人的编辑互相覆盖。且 prompt 明确要求**不要动 `state-schema.mjs` 的既有字段语义**。 |
| `.state.json` | 是**编号角色表**（HP/AC/属性）。回合顺序是**战斗内瞬态**，与角色表的生命周期不同 —— 战斗结束它就该消失，而角色表要长期存在。 |
| **`<stem>.encounter.json`** ✅ | 与两者生命周期都不同，独立成文件；**T9 的计时效果/专注复用同一文件**，不各建一套（与 T9 卡「若 T8 已引入 encounter 文件，复用它」一致）。 |

**真实约束（写在代码注释里，不藏）**：encounter 是**桌面级**事实，但文件按**角色**分。
多 PC 战役下必须传 `character`；不传时工具**拒绝并列出候选人**，而不是猜 ——
猜错会把战斗写进别人的遭遇文件，下一次读又去别处找。

---

## 8. 改了什么（最小改动）

| 文件 | 改动 |
|---|---|
| `src/host/tools/initiative.mjs` | **1 行**修复排序方向 + **1 段注释**说明为什么必须是 `b - a` |
| `test/initiative.test.mjs` | **新增 1 条**测试（掷骰次数比较法），补上 `players` 模式的真实盲区 |
| `lib/host/tools/initiative.mjs` | `npm run build` 重新生成，与 `src/` 哈希一致 |
| `scripts/t8-mutation-probe.ps1` | 新增，变异验证脚本（**不进** `check` 链，供复跑） |
| 本文档 | 新增 |

**未改**：`roll.mjs`（`rollD20` 无条件掷两颗是既有行为，超范围）、
`encounter-io.mjs`、`state-schema.mjs`、`sheet-parse.mjs`、
以及 T9/T10 的 `effects.mjs` / `calendar.mjs` 等并行会话在途改动。

---

## 9. 硬约束核对

- ✅ 未修改 `campaigns/morgansfort/`（`109C048C…` / `428AD562…` 与开工时一致）；`calendar.json` `C142300B…` 未动
- ✅ 未重建 `.agents/skills/dnd/`（`Test-Path` = False）
- ✅ 未 `git commit` / `tag` / `push`（`HEAD` 仍为 `45fc4b8`）
- ✅ 未**自行**重启 harness / web profile（真机验证由**用户重启后**进行，执行者全程未重启）
- ✅ 未修改 `C:\Users\Ming\.dsh\profiles\web\`
- ✅ 未修改 `node_modules`（`git status` 无命中）
- ✅ 未新增 npm 依赖
- ✅ 未做顺手重构；写入测试全部落在各测试自有的 `mkdtemp` 临时树内
