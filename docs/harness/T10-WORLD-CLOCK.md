# T10 — 世界时间推进：写 `calendar.json`（T5 缺口 3）

**状态：✅ 已完成（本轮）。实现已逐条验收，全部验收条件通过。
✅ **真机验证已通过（2026-09-22，用户重启后复验）—— 见第 8 节。**
结论与证据写入本文件。**

> ⚠ **接手时的实际状态与看板记载不符**：原卡写「未开始」，但工作区里 T10 的实现
> （`src/host/tools/calendar.mjs`、`lib/host/tools/calendar.mjs`、`test/calendar.test.mjs`，
> 均为**未跟踪文件**）已由一个**并行会话**产出，且**未留结论文档、未标记完成**
> —— 与 T8、T9 接手时的情形完全相同。本轮据此改为「**先验收、再补齐证据**」，
> 未从零重写，**未改动 `calendar.mjs` 一个字节**。

---

## 0. 一句话结论

`dnd_calendar` 已存在、已挂载、已构建、且**算术经独立复算验证正确**。
本轮**没有发现需要修复的缺陷** —— 这与 T8（排序方向反了）、T9（`key` 幂等广告了没实现）
不同，是三个缺口卡里唯一一张「验收即通过」的卡。
本轮的产出是**独立证据**：交叉复算 228 例、真机磁盘端到端、一次**方法学被推翻后重做**的变异验证，
以及用户重启后**在 harness 进程内逐条实跑并通过**的 7 项真机验证（第 8 节）。

---

## 1. 验收条件逐条核对

| # | 验收条件 | 结论 | 证据 |
|---|---|---|---|
| 1 | 可推进时间：至少支持 hour / day / week 与 short\|long rest | ✅ | `HOURS_PER_UNIT = { hour:1, day:24, week:168 }`、`REST_HOURS = { short:1, long:8 }`；参数面实测 `amount, unit, rest, hour, key, reason`。第 2 节 |
| 2 | 月末、年末进位有测试且通过 | ✅ | 4 条进位测试 + **本轮新增的独立复算 228 例 0 不符**。第 3 节 |
| 3 | 推进入口是写工具；T2 已完成故**真机写入已验证** | ✅ | 真实 `D:/DND` 路径上跨年写入落盘成功；policy 实测线程化。第 5 节 |
| 4 | 未破坏 `clock.mjs` 既有 `worldTime` 盖章行为 | ✅ | `git diff HEAD -- clock.mjs` **空**；盖章随推进前进、真实日期不变。第 6 节 |
| 5 | `campaigns/morgansfort/calendar.json` sha256 未变 | ✅ | `C142300B…` 与开工时**逐字节一致**。第 7 节 |
| 6 | `npm run check` 全绿；改 `src/` 已 `npm run build` | ⚠ **见第 4 节** | 18 套件全绿 + `lib`/`src` 哈希 MATCH；check **仅剩 1 条既有失败**，已证与本卡无关 |
| 7 | 明确标注「需重启才生效，真机验证未完成」 | ✅ **已升级为「真机验证已通过」** | 用户 2026-09-22 重启后**逐条实跑**，7 项全通过；先取时间戳证明内存里是新代码。第 8 节 |
| 8 | 未重启 harness、无 git 写操作 | ✅ | 未重启；未执行 `git commit/tag/push`；`HEAD` 仍为 `45fc4b8`。第 7 节 |

---

## 2. 工具面与参数

`dnd_calendar` 由 `src/host/index.mjs` 的 `FAMILIES`（8 项）注册，实测导出：

```
tools from calendar.mjs: dnd_calendar
has execute: function
has output.render: function
params: amount, unit, rest, hour, key, reason
```

**无参调用是纯读**，不建档、不盖章、不写盘（测试 `a read with no arguments reports the world time and writes nothing` 用逐字节比对钉住）。
这一条值得单独指出：**问问题的调用不得改变答案**，而「读一下就顺手盖个章」是这类工具最容易犯的错。

**5e 时长取值依据**（原卡第 2 条要求写明）：短休 = **1 小时**、长休 = **8 小时**，
依据是 SRD 5.2 对 short rest / long rest 的定义（"at least 1 hour" / "at least 8 hours"），
与旧 `calendar.py` 的 `_advance_hours(cal, 1)` / `(cal, 8)` **一致** ——
即 DM 已经熟悉的时长语义被**保留**而非重新发明。

**拒绝裸数字 / 负数量**：`amount` 必须配 `unit`；负数被拒且**写盘前**返回
（测试断言拒绝后文件逐字节未变）。时间不倒流是一条**不变量**，不是 UI 约束。

---

## 3. 进位算术 —— 本轮用独立复算确认，而不是复述测试

看板要求「月末、年末进位有测试且通过」。既有测试确实覆盖了这些边界，但
**一个和实现同源的测试无法证明实现正确** —— 它只能证明实现和自己一致。
故本轮补做了一次**不共享实现**的交叉复算：

写一个**逐小时朴素模拟**（`hour+=1; if hour>=24 {hour=0; day+=1}; if day>perMonth {...}`），
与 `advanceCalendar` 的**闭式除法**在两两独立的前提下比对：

```
carry cross-check: cases=228 mismatches=0
setHour range violations=0
```

覆盖范围：`day ∈ {1,29,30}` × `month ∈ {1,11,12}` × `hour ∈ {0,23}` ×
`h ∈ {0,1,2,23,24,25,48,168,720,721,8760,100000}`，外加三组**自定义 `month_length` 与自定义月份数**。

**为什么这一条重要**：闭式实现（`yearIndex = floor(allDays / (perMonth*perYear))`）
与朴素循环实现在**大数量级**上最容易分叉 —— 「推进 100000 小时」不该依赖循环跑了几次。
228 例全等说明两者在**同一件事**上一致，而不是各自自洽。

`month_length` 是**从文件读**（默认 30）而非假定，自定义月长的用例一并通过。

---

## 4. `npm run check` 的既有失败：已证与本卡无关

- `npm test`：**18 套件全部 `all assertions passed`**（含 `calendar.test.mjs`）
- `test:ownership` / `build` / `verify`：**全绿**
- `test:writes` 与 `test:concurrency`：各有 **1 条**失败，且是**同一句** `FAIL and the real campaign is active again`

**这是 T2/T3/T4/T8/T9 逐字记录过的同一条既有缺陷，未修（超出 T10 范围）。**

本轮做了**两重独立证明**，不靠断言「看起来无关」：

1. **代码级无关**：`grep calendar` 在两个 scenario 脚本中命中 **0 次**；
   `grep dnd_calendar` 在整个 `scripts/` 中命中 **0 次**。二者**从不加载 `calendar.mjs`**。
2. **复现级无关**：用 `git stash` 把**全部**已跟踪改动还原到原始代码后复跑，
   **逐字复现同一条失败**；随后 `git stash pop` 还原（13 个已跟踪文件恢复，
   `HEAD` 仍为 `45fc4b8`，`git stash list` 为空）。

失败断言本身是**断言了合法可变状态**：

```js
check(JSON.parse(readFileSync(nodePath(MARKER), 'utf8').replace(/^\uFEFF/, '')).name === 'morgansfort',
  'and the real campaign is active again')
```

它硬编码活动战役必须是 `morgansfort`，而 marker 合法地指向 `retest-alice`。
**紧邻的上一行断言的是正确的不变量**（marker 按字节相同），**且那条通过**。

---

## 5. 真机磁盘端到端（T2 已完成，故此条可验）

原卡第 3 条担心「T2 未修好则真机写入无法验证」。**T2 已完成并通过真机验证**，
故本轮在**真实 `D:/DND` 路径**上（非 remap 临时树）跑了一次端到端：

```
--- year-end + long rest through the REAL tool on REAL disk ---
t10-scratch (long rest (+8 hours)) — new year vigil
  30 Stormrise 1247 AR, 20:00 -> 1 Frostfall 1248 AR, 04:00
on-disk: {"day":1,"month":1,"year":1248,"hour":4}
policy seen: {"workspaceRoot":"D:/DND","mode":"workspace-write","sessionId":"t10"}

--- read-back ---
**t10-scratch** world time: 1 Frostfall 1248 AR, 04:00

--- idempotency on real disk ---
day after once: 2 | after dup: 2 | same: true
dup message: Already applied (key "t10-real-1"); nothing changed.
scratch removed: true
```

三点值得指出：

1. **年末进位是真的落盘了**（20:00 + 8h → 跨年 → `1248/1/1 04:00`），磁盘重读得到同一结果。
2. **policy 实测被线程化**为 `{workspaceRoot:'D:/DND', mode:'workspace-write', sessionId:'t10'}`，
   即 T2 的会话作用域修复对**新工具同样生效**（写路径不在进程 cwd 之下仍通过判定，
   证明不是靠放宽模态）。全程**零出现 `danger-full-access`**。
3. **幂等键在真机上生效**：同 key 连调两次，第二次回 `Already applied`，日期**未再前进**。

测试写入落在**本卡自建并自删**的 `campaigns/t10-scratch`（实测 `Test-Path` = False），
**未触碰任何真实战役**。

---

## 6. `worldTime` 盖章未被破坏（原卡第 4 条：确认即可，不要重写）

`clock.mjs` **一个字节未改**（`git diff HEAD -- src/host/tools/clock.mjs` 为空）。
本轮验证的是**接缝**：推进世界时钟后，下一次角色写入盖上的是**新**时间，而真实日期不变。

```
worldTime BEFORE advance: 2 Thawmonth 1247 AR, 08:00
worldTime AFTER  advance: 2 Thawmonth 1247 AR, 16:00
updated (real date) unchanged: true
worldTime actually moved: true
```

这正是原卡要的性质：**两个时钟独立**，一个动了不代表另一个动。

---

## 7. 数据安全与行为边界

**逐字节未变**（开工前后两次实测一致）：

| 文件 | sha256 |
|---|---|
| `campaigns/morgansfort/calendar.json` | `C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443` |
| `campaigns/morgansfort/characters/alice.md` | `109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB` |
| `campaigns/morgansfort/characters/alice.state.json` | `428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105` |
| `.runtime/active-campaign.json` | `276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB` |

marker `len=27`、前 3 字节 `239,187,191`（BOM 完整）。
另：`calendar.mjs` 的 `src`/`lib` 两文件 sha256 均为
`337D59C3B121CC17908DFE4A8BD19465E242A33A10014F74545FC0467DBC3DA1`（**MATCH**）；
`.agents/skills/dnd/` 仍为空（`Test-Path=False`）；`HEAD` 仍为 `45fc4b8`；
`git stash list` 为空；无遗留探针文件。

---

## 8. ✅ 真机验证已通过（2026-09-22，用户重启后复验）

原卡第 7 条要求标注「需重启才生效」。**用户已重启 harness**，故本轮把该清单**逐条实跑**。

### 8.1 先证明「确实是新进程、内存里确实是新代码」

这是 T2 踩过的坑：T2 第一次复验时进程启动时间**早于** `lib/` 构建时间，内存里仍是旧代码，
`dnd_track` 照旧被拒 —— 「重启了」不等于「新代码生效了」。故先取时间戳：

```
lib/host/tools/calendar.mjs : LastWriteTime 2026/9/21 20:47:18
harness node process        : StartTime     2026/9/22 8:31:26   (PID 20700)
host local time             : 2026/9/22 8:31:49
```

**进程启动（9/22 8:31）晚于构建（9/21 20:47）** → 内存中的代码就是本文件所述的那一份。
与 T2 当时**相反**，不存在「启动了但读的是旧代码」的情况。

### 8.2 清单逐条实测结果

| # | 清单项 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | 无参纯读 | `Campaign "retest-alice" has no readable calendar.json, so its world time is unknown.` | ✅ 工具**在 harness 进程内确实已加载**；且未创建任何文件 |
| 2 | `rest="long"` | `30 Stormrise 1247 AR, 20:00 -> 1 Frostfall 1248 AR, 04:00` | ✅ |
| 3 | 跨年 | 磁盘重读 `{"day":1,"month":1,"year":1248,"hour":4}`；`months`/`month_length`/`day_names`/`events` **全部原样保留** | ✅ 年末进位**真的落盘** |
| 4 | 幂等 | 第一次 `+1 day` → `2 Frostfall 1248 AR`；同 key 第二次 → `Already applied (key "restart-check"); nothing changed.` | ✅ 日期**只前进一天** |
| 5 | 拒绝 | `refusing to advance by -5 day; time moves forward. Nothing was written.` | ✅ 拒绝后文件 sha256 **逐字节相同**（`BE4062AC…`） |
| 6 | 接缝 | 推进后 `dnd_track` 写角色 → frontmatter `worldTime: 2 Frostfall 1248 AR, 04:00` 而 `updated: 2026-09-22` | ✅ 盖章反映**新**世界时间；**真实日期独立不变** |
| 7 | `morgansfort/calendar.json` 未变 | `C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443` | ✅ 与开工基线**逐字节一致** |

第 4 条（幂等）与第 6 条（接缝）值得单独强调 —— 它们分别证明了两件**单测无法覆盖**的事：

- **幂等键跨进程存活**：账本存在 `calendar.json` 自身，所以重启后重试仍被识别为重复。
  若账本只存在内存里，重启就会让它失效，而这条**只有重启后才能测**。
- **写工具确实走的是 T2 修好的会话作用域路径**：`retest-alice` 位于 `D:\DND\campaigns\`，
  **不在**进程 cwd（`C:\Users\Ming`）之下，却写入成功 —— 说明不是靠放宽模态
  （全程零 `danger-full-access`）。

### 8.3 数据安全（验证后复核）

`morgansfort` 三文件与活动标记在**全部真机验证之后**复核，仍与开工基线**逐字节一致**：

```
C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443  calendar.json
109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB  alice.md
428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105  alice.state.json
marker: len=27 first3=239,187,191 sha=276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
```

验证所用的日历建在 **`campaigns/retest-alice/`**（一个**测试**战役，**非** `morgansfort`），
且该战役**原本没有** `calendar.json` —— 验证产生的这一份**已删除**，
该目录现已恢复为验证前的三个文件（`state.md`、`characters/alice.md`、`characters/alice.state.json`）。

**注**：`retest-alice/characters/alice.md` 因第 6 条接缝验证被写入过一次（`dnd_track` 的空变更），
其 frontmatter 的 `updated` 由 `2026-09-21` 变为 `2026-09-22`、`worldTime` 反映新世界时间。
这是**测试战役的正常写入**，非数据损坏；`morgansfort`（真实战役）未受影响。

### 8.4 结论

原卡第 7 条「明确标注需重启才生效」，现已**由「未验证」升级为「真机验证已通过」**。
第 5 节此前只能声称「代码与写入路径正确」，现在可以声称
**harness 进程内的 `dnd_calendar` 端到端可用**。

---

---

## 9. 变异验证：一次**方法学被推翻后重做**的记录（如实保留）

原卡第 6 条要求「新增测试要有**能在实现前失败**的变异验证」。本轮据此做了 6 个变异，
但**第一版探针测到的是假结果**，两次踩坑已写进脚本注释：

**坑 ①（T9 记录过的同一个坑，本轮再次踩到）**：第一版探针用 node `execFileSync` 调用测试。
在该沙箱下 node **无法 spawn 子进程** —— 实测 `SPAWN FAILED: EPERM spawnSync ... EPERM`。
后果极其危险：每个变异都得到**空 stdout**，而第一版把「没看到 `all assertions passed`」
判为「caught」。于是 **6 个变异全部被报成 caught，包括什么都没改变的** ——
**看起来像一次完美的变异验证，实际什么都没测到**。
改为 `.ps1` 由 PowerShell 直接调 `node`，并新增**控制组**：
未变异时套件必须 `passed=True red=0`，否则整个探针 `exit 2` 拒绝出结论。

**坑 ②（本轮新坑）**：改用 `& node $TEST 2>&1 | Out-String` 捕获输出后，
PowerShell 会把 node 的 stderr 合并进错误流并**注入自己的多行 `NativeCommandError` 记录**，
把捕获文本**改写**掉 —— 结果是「已正确捕获」的变异报出 `red=0`（`FAIL` 行的行首空白被破坏），
探针因而谎报 3 个变异 **SURVIVED**。改为**重定向到文件再读回**（`*> $outFile`）后，输出逐字保真。

**两坑共同点**：都表现为「测试看起来无效」，而真相是**测量工具坏了**。
这正是 T9 记下的教训 —— **先证明探针能测到东西，再相信探针的结论**。

修正后（锚点**先全量校验、后写入**；还原放在 `finally`；控制组守卫）：

```
anchors validated: 6/6
CONTROL (unmutated): passed=True red=0
mutation A: caught  exit=1 red=24  [year carry removed (never wraps into a new year)]
mutation B: caught  exit=1 red=4   [long rest is no longer 8 hours]
mutation C: caught  exit=1 red=2   [policy no longer threaded to writeText (T2 defect returns)]
mutation D: caught  exit=1 red=2   [idempotency key never persisted (a retry advances twice)]
mutation E: caught  exit=1 red=2   [negative advance allowed (time runs backwards)]
mutation F: caught  exit=1 red=10  [month-end carry broken (month_length ignored)]

RESTORED_BYTE_IDENTICAL=True
EVERY_MUTATION_WAS_CAUGHT=True
```

**「caught」的判定已收紧**为三重：`exit≠0` **且** `red>0` **且** 未出现 `all assertions passed`。
只满足其一不算捕获 —— 这是坑 ① 的直接产物。
变异 **C** 尤其重要：它把 T2 修好的「policy 线程化」重新破坏掉，
而测试**抓得住** —— 说明 T2 的修复有回归防护，不是一次性的。

脚本可复跑：`dsh-dnd-bundle/scripts/t10-mutation-probe.ps1`。

---

## 10. 改动清单

**本卡未修改任何既有实现文件。** 新增/产物：

| 文件 | 说明 |
|---|---|
| `scripts/t10-mutation-probe.ps1` | **本轮新增**：变异探针（含控制组、锚点预校验、输出文件捕获） |
| `docs/harness/T10-WORLD-CLOCK.md` | **本轮新增**：本结论文档 |

**并行会话已产出、本轮验收但未改动**：`src/host/tools/calendar.mjs`、
`lib/host/tools/calendar.mjs`、`test/calendar.test.mjs`，
以及把它们接进 `FAMILIES` 与 `npm test` 的那两行。

**未触碰**：`clock.mjs`、`sheet-parse.mjs`、`state-schema.mjs`、`track.mjs`、
`effects.mjs`、`initiative.mjs` 等任何其他实现文件；
未新增 npm 依赖；未重建 `.agents/skills/dnd/`；未改 persona（看板第 1399-1404 行
明确该收窄是**独立**改动，需单独挂载校验）。

---

## 11. 记录未修（超出本卡范围）

1. **`FAIL and the real campaign is active again`**（两处，同一句）——
   第 4 节已证既有且与本卡无关。**建议另立卡**：删掉这条快照断言，
   保留脚本中已有的正确不变量（marker 按字节相同，**已通过**）。
2. **`dnd_calendar` 无 `events` 子命令** —— 旧 `calendar.py` 有 `cmd_events`。
   看板 T10 的验收条件只要求 hour/day/week + rest，**未要求 events**，故未实现。
   日历文件里的 `events` 字段被**原样保留**（有测试），不会被清除。
3. **`dnd_calendar` 无 `character` 参数** —— 刻意为之：每个战役只有**一个**世界时钟，
   「哪个战役」由活动战役指针回答。这与 T3 的结论一致，二者不冲突。
