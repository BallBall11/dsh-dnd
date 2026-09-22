# T9 — 计时效果 / 专注 / 死亡豁免（T5 缺口 2）

**状态：✅ 已完成（本轮）。实现已验收并修复一个真实缺陷（广告了却未实现的 `key` 幂等）。
结论与证据写入本文件。真机验证未完成 —— 需重启才生效，见第 8 节。**

> ⚠ **接手时的实际状态与看板记载不符**：原卡写「未开始」，但工作区里 T9 的实现
> （`src/host/tools/effects.mjs`、`encounter-io.mjs`、`test/effects-rules.test.mjs`、
> `test/encounter-effects.test.mjs`，均为**未跟踪文件**，mtime `2026-09-21 13:53:59`）
> 已由一个**并行会话**产出，且**未留结论文档、未标记完成** —— 与 T8 接手时的情形相同。
> 本轮据此改为「**先验收、再修不合格部分**」，未从零重写。

---

## 1. 分层决策：为什么是三个新工具，而不是扩展 `dnd_track`

原卡第 1 条要求**明确给出理由，不要默默塞进去**。实现给出了理由（`effects.mjs` 头部
第 1 节），本轮验收确认为**成立**：

| 论点 | 内容 |
|---|---|
| `dnd_track` 的可推理性来自「读一个数、改一个数」 | 9 个字段（hp / tempHp / spellSlots / xp / conditions / removeConditions / resource / resourceDelta / key），每个字段都是独立标量，参数**不携带历史** |
| 时长**不是**角色身上的一个数 | 它是**具名效果**（Bless / Hunter's Mark）身上的数，且一名角色可同时持有多个。`dnd_track` 无法表达「哪个效果」，需要另加一整套寻址方案（effectName / effectAction / effectDuration），且任一字段离开其余字段便无意义 |
| 三个动词不是标量而是一个**状态机** | `start → tick*` → `end/expire`，且转移带后果：结束效果可能结束专注，打断专注强制一次豁免。`dnd_track` 按固定顺序套用字段并回报一张扁平变更表，没有位置表达「结束**这个**效果同时丢掉了**那个**法术的专注」 |
| tick 是**战役级**操作，不是角色级 | 推进一轮会推进**每个**参战者身上的**每个**效果。`dnd_track` 键定一名角色，逐轮 tick 就必须逐人调用一次，且**极易遗漏** —— 正是本卡要消除的失败模式 |

**结论**：`dnd_track` 继续改**表上的数**，本模块拥有**有生命周期的东西**。
唯一的越界是刻意且微小的：`dnd_death_save` 在写 encounter 计数的**同时**把计数镜像到
角色表**既有的** `combat.deathSaves` 字段（`state-schema.mjs:80`、`:98`），
因为读该字段的面板不能变陈旧。**该字段语义未改变。**

---

## 2. 纯函数化：计时为什么用「显式 tick」而不是挂钟

原卡第 2 条要求评估「每轮手动 tick，还是绑到某个既有动作上」，并**纯函数化优先**。

**实现的选择：显式 tick，且核心算术是纯函数。** 验收确认理由充分：

```
tickEffects(effects, { rounds: 1 }) -> { remaining, expired, elapsed, advanced }
```

读时钟、不碰磁盘、既不修改入参也不修改模块级状态。**不采用** `tracker.py` 的
`started_at = time.time()` 挂钟算法，理由（`effects.mjs` 第 3 节）：

1. **挂钟是任何测试都控制不了、任何 DM 都验证不了的隐藏状态** —— 「Hunter's Mark 还剩 4 分钟」
   会变成关于宿主系统时钟的断言，而不是关于游戏的断言。单测要么 sleep（慢、易抖），
   要么伪造时钟（那测的是伪造）。
2. **它在两次调用之间静默改变含义** —— 一次长休、DM 出声思考十分钟、笔记本睡了一夜，
   都会推进一个桌上从未叙述过的时间。
3. **不可恢复** —— 一旦余量由 `started_at` 派生，文件记录的不再是「买了多少」，
   而是「DM 什么时候按了键」。

**代价如实写明**：DM 必须告诉工具时间流逝了，它**永不自行 tick**。
忘记 tick 的 DM 会发现一个 10 分钟法术在一小时后仍在运行 —— 一个**可见的**错误答案，
而不是一个不可见的。这正是本仓库纯函数偏好所换取的取舍。

**单位换算是一张表**（`UNIT_SECONDS`）：`1 round = 6s`（SRD 5.2 "The Order of Combat"）、
`1 minute = 60s`、`1 hour = 3600s`。内部一律以**秒**计数，故一次 tick 可递减混合单位集合。
一次 `rounds` tick 是**一轮（6 秒）**，不是「效果所用单位的 1 个」——
否则一个 1 分钟法术会在一个回合后过期。

---

## 3. 专注：与「必须触发的豁免」的交互

原卡第 3 条要求「专注被打断时要能触发一次豁免」。验收确认实现正确（SRD 5.2 "Concentration"）：

```
DC = max(10, floor(damage / 2))
```

用 `Math.floor` 而非 `Math.round`：21 点伤害的一半是 10.5，规则取 10 与一半中的**较高者**，
故 DC 在 22 点伤害之前一直保持 10；30 点时为 15。已在测试中钉住
（`breaking concentration at 21 damage stays at DC 10, not 11`）。

丢失专注是 DM **必须宣布**的事，故豁免不只是被记录：`dnd_concentration action: "break"`
返回 DC 以及一行**可直接运行**的 `dnd_save` 调用。当过期效果正是专注对象时，
`dnd_effect action: "tick"` 在输出中报告同一次中断，使过期**无法静默**留下一个指向已结束法术的专注标记。

两处刻意的不发明：
- **过期不是伤害**，故 tick 引发的中断**不编造 DC**，只说明发生了什么。
- 打断专注会去掉效果上的专注标记，但**效果本身照跑** —— 专注被打断的 Bless 仍有它的回合数在计时。
  连计时一起删掉会静默删掉一个 DM 可用的事实。

---

## 4. 死亡豁免：模型走到哪一步

原卡第 4 条要求「3 次失败时给出**明确**的死亡结论」。已实现（SRD 5.2 "Death Saving Throws"）：

| 规则 | 实现 |
|---|---|
| 3 次成功 = STABLE | `verdictFor` → `'stable'`，输出「STABLE and unconscious at 0 HP」 |
| 3 次失败 = DEAD | `verdictFor` → `'dead'`，输出「Three failed death saves: the character is DEAD. This is the rules verdict, not a suggestion」 |
| 自然 1 = **两次**失败 | `isNat1 ? 2 : 1`，且在封顶吸收掉一次时**明说**（`(capped at 3; N of the 2 were counted)`） |
| 自然 20 = 恢复 1 HP 并清空计数 | 独立的 `'revived'` 判定 + `regainsHp: true` |

**刻意不建模**：HP 恢复时**自动**重置计数。那意味着本工具要盯着 `dnd_track` 家族做出的每一次
HP 变更（跨两个模块、两个文件），而半接线的版本会在规则并未要求重置的时刻重置。
改用显式的 `action: "reset"`，且工具的 description **写明这一点**，
使模型据此行动而不是意外发现。

---

## 5. 状态落盘：复用 T8 的 encounter 文件（原卡第 5 条）

原卡第 5 条要求与 T8 协调。验收确认**已复用**，未各建一套：

```
<name>.encounter.json
  sections.initiative   <- T8 拥有
  sections.turnOrder    <- T8 拥有
  sections.effects      <- T9 拥有
  sections.concentration<- T9 拥有
  sections.deathSaves   <- T9 拥有（encounter 级）
  sections.appliedKeys  <- T9 拥有（本轮新增，见第 6 节）
```

**两个写入家族，一个文件**，靠 `mergeEncounter`（`encounter-io.mjs:156`）保全：
读取整个文件 → 只替换自己的键 → 写回。故 T8 的 `initiative`/`turnOrder` 能挺过一次 tick。
测试已断言这一点（`THIS family writes only its own sections; initiative survives byte-intact`）。

**两处值得记下的实现细节**（验收确认为正确）：
- `clearEncounterSection` 的 `sectionName` 是**必填且无默认值**，缺失时**抛错**。
  文件头（`:232-243`）写明为什么：早期草稿硬编码了 `INITIATIVE_SECTION`，而它是**共享**助手 ——
  效果家族调用它会**静默覆盖**先攻段并毁掉对方的活动回合顺序，两半都不会报错。
- 本模块**刻意不使用** `clearEncounterSection`，因为它硬编码了先攻段。

---

## 6. 本轮发现并修复的真实缺陷：广告了却未实现的 `key` 幂等

### 6.1 缺陷

三个工具都在 **schema 与 description 里**广告 `key` 参数：

> `"Idempotency key. Repeating a call with the same key changes nothing the second time."`

但 `effects.mjs` 中 **`args.key` 零消费**（`grep` 实证：`args.key` 无命中）。
即：**承诺写在契约里，实现里没有。** 后果按工具严重度递增：

| 工具 | 重试的实际后果 |
|---|---|
| `dnd_effect` `start` | 看似幂等 —— 但那只是「同名替换」的**巧合**，不是幂等。`end` 与 `tick` 都会重跑 |
| `dnd_concentration` `start` | 用新的 `since` 时间戳**重写**记录 |
| **`dnd_death_save`** | **致命**：重试的 `failure` 给计数**再加一次失败**。在 0/2 处重试会报告角色 **DEAD** —— 而该工具自己的契约说重试不可能这样做。一个在超时后重试的模型会杀死一个只是濒死的角色 |

**实证（修复前）**，`scripts/t9-key-probe.mjs`：

```
dnd_death_save  tally before: null  after 1st: {"successes":0,"failures":1}  after 2nd: {"successes":0,"failures":2}
  -> idempotent? NO - ONE RETRY COST A SECOND DEATH-SAVE FAILURE
dnd_concentration  before/after 2nd: since=...38.098Z / since=...38.100Z
  -> creates a DIFFERENT since stamp? YES - RE-WROTE THE RECORD
```

### 6.2 修法

**账本放在本家族已经拥有的 encounter 文件里**（`sections.appliedKeys`），
与 `dnd_track` 把账本放在 `<name>.state.json` 的 `appliedKeys`、`calendar.mjs` 放在
`calendar.json` 是同一模式：**每个账本住在它自己家族所写的文件里**，
这正是让「检查—记录」在该文件的锁下**原子**的原因。

若放在角色表上，一次死亡豁免重试就得读写一个本家族只做镜像的文件，
而查重会落在序列化计数的锁**之外**。

新增（`effects.mjs`）：

| 导出 | 作用 |
|---|---|
| `APPLIED_KEYS_SECTION` / `MAX_ENCOUNTER_KEYS = 32` | 账本段名与上限（与 `state-schema.mjs` 的 `MAX_APPLIED_KEYS` 对齐） |
| `requestKey(args)` | 读 caller 的 key；**空串 = 无 key**（否则空 key 会变成共享桶，让之后每次无 key 调用都成为重复） |
| `asKeyList(value)` | 安全的字符串数组 |
| `withKeyRecorded(keys, key)` | 纯函数：新增在末、超限丢最旧 |
| `duplicateReply(loaded, key, label)` | **在锁内、在任何变更之前**运行；返回重复回复或 `undefined` |

三处关键性质（均有注释写死）：
1. **在变更之前**，不是之后 —— 事后发现的重复得撤销，而「撤销一次死亡豁免」是读者无法验证的修补。
2. **在锁内** —— 账本由 `loadSections` 在该角色的链下读取，故同 key 的两次并发调用会序列化：
   第二次看到第一次的记录并停止。放在锁外会让两者都读到空账本并都套用。
3. **写路径各自记录** —— `dnd_effect` 的 start / end / tick、`dnd_concentration` 的 start / end、
   `dnd_death_save` 的 failure / success / reset 全部记录；**status / list 等只读调用既不检查也不记录**。

**团体 tick 的粒度不同**（唯一需要特别处理的路径）：一次调用会写**多个**文件，
故 key 是**逐角色**检查与记录。已在注释与测试中写明：团体调用对某些角色是重试、对另一些是首次套用，
只推进尚未移动的角色**正是重试的意图**。

### 6.3 变异验证（6 个变异，全部被捕获）

`scripts/t9-mutation-probe-run.ps1`，可复跑：

```
baseline run: FAILs=0 allPassed=True

A: death-save duplicate check removed............. FAILs=2 allPassed=False
B: requestKey always null (the ORIGINAL defect)... FAILs=7 allPassed=False
C: ledger written but never checked............... FAILs=5 allPassed=False
D: concentration-start check removed.............. FAILs=1 allPassed=False
E: key ledger cap removed......................... FAILs=1 allPassed=False
F: party tick skips characters who already took the key FAILs=2 allPassed=False

restored sha256: 82FDCEA020EF759350F56C5F1B30339B8AF2C7942B2B93611D06F6B799A384C5
RESTORED_BYTE_IDENTICAL=True
EVERY_MUTATION_WAS_CAUGHT=True
final run after restore: FAILs=0 allPassed=True
```

**变异 B 就是原始缺陷本身**（`requestKey` 恒返回 null），**7 条断言变红** ——
证明新增测试**有能力**抓住「广告了却未实现」这一形态，不是镜子测试。
每个变异后逐字节还原，sha256 实测一致。

### 6.4 过程中两个被踩到并已修正的坑（如实记录）

1. **探针自己留了一个变异在源码里。** 第一版 node 探针在循环内**惰性**校验锚点：
   变异 A 已写入、变异 B 的锚点未命中时抛错，**A 从未被还原**，源码带着
   `// MUTATION A: check removed` 留在盘上（导致该轮 2 条测试变红）。
   发现后立即还原并复跑全绿。**修正**：锚点在**任何写入之前**一次性全部校验，
   且还原放进 `finally`。这正是仓库既有风格中「把坑写死」的做法。
2. **node 在受限沙箱下无法 spawn 子进程。** 第一版探针用 `spawnSync` 跑被测套件，
   实测 `status=null err=EPERM` —— 于是它对**每个**变异都报告 `FAILs=0`，
   即**什么都没测到却看起来像「测试无效」**。**修正**：探针改为 `.ps1`，
   由 pwsh 直接调 `node`（pwsh 可以 spawn）。这个坑已写进探针注释，
   否则下一个人会再次得出「测试抓不住任何东西」的错误结论。

---

## 7. 验收条件逐条核对

| 条件 | 结果 |
|---|---|
| 分层决策已说明理由 | ✅ 见第 1 节；实现内注释 `effects.mjs` 头部第 1 节 |
| 计时效果可 start / tick / end，时长单位至少覆盖 rounds 与 minutes | ✅ `parseDuration` 覆盖 rounds / seconds / minutes / hours / indefinite，**并对裸数字拒绝**（"10" 可能是 10 轮或 10 分钟，猜测会产出静默的错误答案）。测试：`parses rounds, minutes, hours and indefinite`、`a BARE number is refused rather than guessed at`、`a 5-round effect expires on the FIFTH round tick` |
| 专注可建立、可打断（触发豁免）、可结束 | ✅ start / break / end / status 四动作；break 带 damage 时给出 DC 与可直接运行的 `dnd_save` 行；21 点伤害仍为 DC 10 已钉住 |
| 死亡豁免可推进 success/failure，3 次失败给出死亡结论 | ✅ 含自然 1 = 两次失败、自然 20 复活；`three failures produce an explicit DEAD conclusion` 断言输出含 `DEAD` 与 `Three failed death saves` |
| 与 T8 的状态落盘方案一致 | ✅ 复用 `<name>.encounter.json` + `mergeEncounter`；先攻段跨家族写入逐字节存活（有测试） |
| 新增测试有**能在实现前失败**的变异验证 | ✅ 6 个变异全部被捕获，含「原始缺陷」形态（B → 7 红）；每个逐字节还原 |
| `npm run check` 全绿；改 `src/` 已 `npm run build` | ⚠ 见下方「已知偏差」；`lib/` 与 `src/` 的 sha256 实测 **MATCH** |
| **明确标注「需重启才生效，真机验证未完成」** | ✅ 见第 8 节 |
| `campaigns/morgansfort/` 两文件 sha256 未变；未重启 harness、无 git 写操作 | ✅ 见第 9 节 |

### 已知偏差（记录在案，不掩盖）

- **`npm run check` 有且仅有 1 条失败**：`FAIL and the real campaign is active again`
  （`scripts/write-tools-scenario.mjs:394-395`）。
  该断言硬编码 `name === 'morgansfort'`，而活动标记当前**合法地**指向 `retest-alice`。
  **已证实与本卡无关**：
  1. 该脚本**完全不涉及**任何 T9 工具（`grep` 实证：`effects` / `dnd_effect` /
     `dnd_concentration` / `dnd_death_save` 在该脚本中**零命中**）—— 它不加载 `effects.mjs`；
  2. 脚本自己就在下一行（`:397-398`）写明「不变量是『本次运行没有改变真实战役的任何东西』，
     而不是『真实战役没有状态文件』」—— **那个正确的不变量断言（`:393`，标记按字节相同）通过**。
  这是看板 T2 / T3 / T4 / T8 各卡**逐字记录过的同一条既有缺陷**（T8 曾用 `git stash` 在原始代码上复跑复现），
  **本卡未修**（超出 T9 范围）。建议另立卡：删掉这条快照断言，保留 `:393` 的不变量。
- 本轮**未改** `calendar.mjs`、`initiative.mjs`、`roll.mjs`、`state-schema.mjs`
  等任何 T10 / T8 相关文件；`git status` 中它们的改动来自并行会话。

---

## 8. 真机验证：未完成（需重启才生效）

**⚠ 明确标注：需重启才生效，真机验证未完成。**

按看板硬约束第 4 条，执行者**不得重启 harness**。`lib/` 是 `link:` 安装的落点，
改动已 `npm run build` 进 `lib/`（sha256 与 `src/` MATCH），但**运行中的进程加载的仍是旧产物**。
故三个新工具的**真机行为**、以及本轮幂等修复的**真机行为**，本轮均**无法验证**。

需人工确认的最小验证清单（重启后）：

1. `dnd_effect` `{name:"Bless", duration:"10r"}` → 回复含 `10 rounds`；
   `{action:"tick", rounds:1}` 连续 10 次 → 第 10 次报 `EXPIRED`。
2. `dnd_concentration` `{spell:"Bless", damage:30, saveMod:5}`（action break）→ 回复含 `DC 15`
   与一行 `dnd_save mod 5, dc 15`。
3. `dnd_death_save` 三次 `failure` → 第三次报 `DEAD`。
4. **幂等**：`dnd_death_save` `{action:"failure", key:"k1"}` 连调两次 →
   第二次回复 `Already applied (key "k1")`，且 `<name>.encounter.json` 的
   `sections.deathSaves.failures` **仍为 1**。
5. 落盘位置：上述操作后 `<name>.encounter.json` 出现
   `sections.effects` / `concentration` / `deathSaves` / `appliedKeys`，
   且**已有的** `sections.initiative` / `turnOrder` 逐字节未变。

---

## 9. 数据安全（本轮实测）

| 项 | 开工时实测 | 收工时实测 | 结论 |
|---|---|---|---|
| `campaigns/morgansfort/characters/alice.md` | `109C048C…` | `109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB` | **未变** |
| `campaigns/morgansfort/characters/alice.state.json` | `428AD562…` | `428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105` | **未变** |
| `campaigns/morgansfort/calendar.json` | `C142300B…` | `C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443` | **未变** |
| `.runtime/active-campaign.json` | `len=27`，前 3 字节 `239,187,191`，`276B1B66…` | 同上，**完全相同** | **按字节未变**（含 BOM；本轮从未写入该文件） |
| `.agents/skills/dnd/` | `Test-Path = False` | `Test-Path = False`，文件数 0 | **未被重建** |
| `refferenceskills/dnd/` | 106 个文件 | 106 个文件 | **未改动** |
| `HEAD` | `45fc4b8` | `45fc4b8` | **无 git 写操作** |

`alice.state.json` 的看板记载基线为 `fefd308e…` —— **该基线值有误**（T1 / T4 / T5 / T8 与
本轮各自独立实测均为 `428AD562…`，且 `morgansfort/` 下不存在 `fefd308e` 开头的文件）。
判据取「与自己开工时实测的值相比未变」，**已满足**。

写入测试全部落在**各测试自有的 `mkdtemp` 临时树**内（`test/encounter-effects.test.mjs`
用 `remap()` 把生产数据根映射进临时树，并**在文件头断言映射确实生效**，
否则断言的就是一个没人写过的树、而真实树正在被修改）。
测试还在首尾对**真实** `campaigns/morgansfort/characters/` 整树与活动标记做哈希快照，
断言二者未动 —— 该断言本轮通过。

未重启 harness；无 `git commit/tag/push`；未改 `profiles/web/`；未改 `node_modules` 下任何文件；
未新增 npm 依赖；未重建 `.agents/skills/dnd/`。

---

## 10. 本轮改动清单（最小化）

| 文件 | 改动 |
|---|---|
| `src/host/tools/effects.mjs` | **修改**：新增账本段/上限/4 个纯函数 + 锁内查重助手；三个工具消费 `key`；tick 的命名与团体两路逐角色处理；修一处 `key` 变量遮蔽（团体 tick 的锁键改名 `lockKey`） |
| `lib/**` | `npm run build` 重建（`lib/` 是入库产物） |
| `test/encounter-effects.test.mjs` | **新增 9 条测试**（8 条幂等 + 1 条团体 tick 重试） |
| `scripts/t9-key-probe.mjs` | 新增：修复**前**的缺陷实证（证据留存，不进 `check` 链） |
| `scripts/t9-key-probe2.mjs` | 新增：逐工具、各自 key 的修复**后**验证 |
| `scripts/t9-mutation-probe-run.ps1` | 新增：6 个变异验证（可复跑） |
| `docs/harness/T9-EFFECTS-CONCENTRATION-DEATH-SAVES.md` | 本文件 |

**未改**：`calendar.mjs`（T10）、`initiative.mjs` / `roll.mjs`（T8）、`state-schema.mjs`、
`state-io.mjs`、`track.mjs`、`session-scope.mjs`、`encounter-io.mjs`、`shared.mjs`、
`clock.mjs`，以及任何读函数。`package.json` 的依赖零改动。

---

## 11. 本卡未做（明确边界）

- **未改 persona**。原卡与看板第 1278-1283 行都明确：三个缺口全部完成后对
  `SCRIPT ROUTE: STOPPED` 段的收窄是**一次独立的 persona 改动**，
  **不要在各自的卡里顺手做**（还需 `standingKeyFor('dnd-gm')` 挂载校验 + 越权写入授权）。
  T10 尚未完成，故该收窄**本轮不具备条件**。
- **未修** `write-tools-scenario.mjs:394` 的既有快照断言（超出 T9 范围，已建议另立卡）。
- **未做真机验证**（硬约束禁止重启）。
- 未重启 harness、无 git 写操作、未改 profile、未重建 `.agents/skills/dnd/`、未新增 npm 依赖。
