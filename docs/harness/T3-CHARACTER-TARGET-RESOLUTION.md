# T3 结论：写工具的目标解析 —— **证伪**（`character` 参数未被忽略）

> 任务卡：`docs/PLAN-dnd-preset-defects-TASK-BOARD.md` → T3（依赖 T2 ✅）
> 前置结论：`docs/harness/T2-WRITE-PATH-SESSION-SCOPE.md`（T2：写入被拒的根因）
> **本卡未重启 harness、未做任何 git 写操作。**

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| **结论** | **证伪（REFUTED）**。`character` 参数**确实参与**目标路径解析，写入落在被点名的角色上 |
| **改动** | **实现零改动**。仅**新增**一个测试套件 + `package.json` 一行 + 本文件 |
| **四种等价写法** | **全部逐一实测通过**（见第 3 节，每种写法各自独立取证） |
| **报告的成因** | 报告把 **T2 的写入拒绝**误读成了「目标被忽略」——见第 5 节，含**同构复现** |
| **歧义隐患** | 存在且**已知**：两个角色名共享子串时，按排序取第一个，**静默**。本卡**只记录、不改变行为**（第 6 节） |
| **变异验证** | 4 个变异，3 个被捕获（A/B/D）；1 个（C）**按构造不可观测**，已在测试注释与第 4.4 节如实记录，未掩饰 |
| **`npm run check`** | 失败数 **前 1 / 后 1**，且是**同一条**既有失败（`write-tools-scenario.mjs`），**无新增失败** |
| **数据安全** | `morgansfort` 与活动战役 `retest-alice` **字节未变**；活动标记 sha256 未变（含 BOM） |

---

## 1. 只读核实：`requested` 在哪里被消费

`src/host/tools/track.mjs` 的 `locateCharacter`（**:98-133**）是唯一的目标解析点。
`requested` 的消费**精确落在 :111-119**：

```js
 98  async function locateCharacter(fs, requested) {
 99    const located = await activeCampaignDir(fs)
100    if (located === undefined) {
101      return { error: 'No active campaign. Load one with /dm:dnd load <campaign> first.' }
102    }
103    const dir = `${located.dir}/characters`      // ← 只在「活动战役」内解析
104    const listed = await listCharacters(fs, dir)
105
106    if (listed.length === 0) {
107      return { error: `No characters in campaign ${located.campaign}.` }
108    }
109
110    let name
111    if (requested !== undefined && String(requested).trim() !== '') {   // ← 消费点 1：判空
112      const wanted = String(requested).toLowerCase().trim()             // ← 消费点 2：折叠大小写
113      const match = listed.find((c) => c.name.toLowerCase() === wanted) // ← 消费点 3a：精确层
114        ?? listed.find((c) => c.name.toLowerCase().includes(wanted))    // ← 消费点 3b：子串层
115      if (match === undefined) {
116        const available = listed.map((c) => c.name).join(', ')
117        return { error: `Character "${requested}" not found in ${located.campaign}. Available: ${available}` }
118      }
119      name = match.name                                                 // ← 消费点 4：得出 name
120    } else if (listed.length === 1) {                                   // ← 消费点 5：省略时的唯一分支
121      // Unambiguous, so requiring the name would be ceremony.
122      name = listed[0].name
123    } else {
124      const available = listed.map((c) => c.name).join(', ')
125      return { error: `Which character? ${located.campaign} has ${listed.length}: ${available}` }
126    }
127
128    const character = await readCharacter(fs, dir, name)   // ← name 决定读谁
129    ...
132    return { dir, campaign: located.campaign, name, character }
133  }
```

`name` 再经 `state-io.mjs:45` 的 `statePath(dir, name)` → `${dir}/${name}.state.json`，
以及 `applyChange`（track.mjs:192）的 `writeCharacter(fs, located.dir, located.name, ...)`。
**参数 → name → 路径**这条链是完整的，且三个写工具都经由它：

| 调用点 | 行 | 传参 |
|---|---|---|
| `dnd_track` | :409 | `locateAndApply(fs, args.character, ...)` |
| `dnd_spend` | :460 | `locateAndApply(fs, args.character, ...)` |
| `dnd_xp_add` | :523 | `locateAndApply(fs, args.character, ...)` |
| `locateAndApply` | :306/:309/:319 | `locateCharacter(fs, requested)`（锁外一次、**锁内再一次**） |

**注意 :319**：`locateAndApply` 在**锁内重新解析一次**。因此本卡的所有断言都作用在
真实写入的那一次解析上，而不是锁外那次仅用于算锁键的预解析。

---

## 2. 方法：为什么断言**文件摘要**而不是返回文案

`dnd_track` 返回的句子（`alice — HP 5 -> 3`）由 `located.name` 生成，
而 `located.name` **正是被测对象**。拿它做断言等于让嫌疑人自证清白：
一个既忽略参数、又汇报被忽略名字的实现会**照样通过**。

所以每种写法的证据都是：**对全部角色表的字节做 sha256，写入前后比对，
要求「恰好一张表动了，且是应该动的那张」**。文案只打印给人看，从不参与断言。

### 2.1 测试环境（避开硬编码 `D:/DND` 的坑）

`shared.mjs:15` 硬编码 `DND_ROOT = 'D:/DND'`，`activeCampaignDir()` 由它拼出
`${DND_ROOT}/campaigns/${campaign}`，**不接受任何参数或环境变量**。
因此「把 mock fs 指向临时目录」是**不够**的：必须先让工具解析出的路径本身落进临时树。

本卡采用 `test/host.test.mjs` / `test/routes.test.mjs` 的既有做法：
在 mock fs 的 `resolve()/stat()/readText()/listDir()` **内部重映射** `D:/DND` 前缀。

> ⚠ **本卡的探针在开发早期确实踩过一次**：第一版探针只在 mock 里指向临时目录，
> 而工具仍解析真实 `D:/DND/campaigns/<活动战役>`，写进了**活动战役**。
> 发现后立即修正为重映射方案，并核对活动标记 sha256。见第 7.2 节。

### 2.2 为什么是**三个**角色，而不是两个

解析有三层：**精确** → **子串** → （仅当战役只有一个角色时）**唯一角色**。
**两个角色无法区分前两层**：任何能被精确命中的名字，子串层也会选中同一张表。

本卡用的阵容是：

```
排序后：  ana-maria , maria , alice
```

`"maria"` 是**判别探针**：它是 `ana-maria` 的**真子串**，且**排在它后面**。
所以只有**精确层生效**时才返回 `maria`。实测（删掉精确层）：

```
"maria" -> ana-maria ; maria hp = 5, ana-maria hp = 4      ← 写错了人
```

> **这一点本卡也踩过一次。** 最初的阵容是 `alice / bob / bob-alice`，探针用 `"bob"`。
> 变异验证时**该测试没变红** —— 因为**前缀永远排在自己的扩展名之前**，
> 子串层照样先命中 `bob`，两层结果相同，精确层因此**不可观测**。
> 这正是本卡要避免的那种「永远绿的测试」。改用非前缀子串（`maria` / `ana-maria`）后变异才被捕获。

---

## 3. 四种等价写法的逐一实测

**可复现命令**（`dsh-dnd-bundle/` 下）：

```
$ node test/character-target.test.mjs
```

**原始输出**：

```
character target resolution:
  ok  an exact name writes to that character and to nobody else
  ok  a differently-cased name resolves to the same character
  ok  a substring resolves to the character whose name contains it
  ok  an EXACT match wins over a longer name that contains it
  ok  surrounding whitespace does not change the target
  ok  an omitted name is refused when the campaign has several characters
  ok  an omitted name writes to the sole character when there is exactly one
  ok  an unknown name is refused and nothing is written
  ok  resolution is scoped to the ACTIVE campaign, by design
  ok  all three write tools resolve the target the same way
  ok  a substring shared by two names resolves by order, and that is recorded here

character-target.test.mjs: all assertions passed
```

### 3.1 逐写法证据表

| # | 写法 | 分支 | 写入前 → 后 | 只有谁动了 |
|---|---|---|---|---|
| 1 | `"alice"` | 精确 | alice 5→2，maria/ana-maria 保持 5 | **alice** |
| 2 | `"ALICE"` | 折叠后精确 | alice 5→2 | **alice** |
| 2b | `"mira"`（表存为 `Mira`） | **折叠的是候选名一侧** | `Mira` 5→2，`mira-vane` 保持 5 | **Mira** |
| 3 | `"ali"` | 子串 | alice 5→2 | **alice** |
| 3b | `"maria"` | **精确优先于子串** | maria 5→2，ana-maria 保持 5 | **maria** |
| 3c | `"  ALI  "` | trim + 折叠 | alice 5→2 | **alice** |
| 4a | **省略**（单角色战役） | `listed.length === 1` | alice 5→2 | **alice** |
| 4b | **省略**（多角色战役） | 歧义 → 拒绝 | **零张表动** | **无人** |
| 5 | `"nobody"` | 未命中 → 拒绝 | **零张表动** | **无人** |

### 3.2 省略写法为什么**必须**在多角色时被拒

卡上把「省略」列为等价写法之一，但它的**合法条件**是「战役恰好一个角色」。
多角色时省略**不是**等价写法而是歧义。本卡实测其被**拒绝且一张表都没动**：

```
F omitted (3 chars)      -> "Which character? targetcamp has 3: ..."  MOVED=[]
G undefined              -> "Which character? targetcamp has 3: ..."  MOVED=[]
F2 empty string          -> "Which character? targetcamp has 3: ..."  MOVED=[]
K omitted (1 char)       -> "alice"                                    alice hp=2
```

若这里不是拒绝而是「静默取第一个」，那才**真的**是报告所担心的损坏级缺陷。
实测为**拒绝**，因此报告描述的最坏情形在省略路径上也不成立。

### 3.3 三个写工具的一致性

`dnd_track` / `dnd_spend` / `dnd_xp_add` 是**三处独立代码**，
只测其中一个会留下另外两个漂移的余地。测试 `all three write tools resolve the target the same way` 逐一取证：
`dnd_xp_add{character:'MARIA'}`、`dnd_track{character:'maria'}` 只动 `maria` 的字节；
`dnd_spend{character:'ana-maria'}` 只扣 `ana-maria` 的钱（100 cp → 0），`maria`/`alice` 仍为 100。

---

## 4. 变异验证（证明测试**能**失败）

命令：`node test/character-target.test.mjs`（每次变异后还原并复跑全绿）。

### 4.1 四个变异

| 变异 | 操作（`src/host/tools/track.mjs`） | 结果 |
|---|---|---|
| **A** | 删除精确层，只留 `includes(wanted)` 子串层 | ❌ **2 条变红** |
| **B** | `requested` 完全忽略（`if (false)` + `else if (true)`，永远取第一个） | ❌ **6 条变红** |
| **C** | 只删候选名一侧的 `.toLowerCase()`（精确层变大小写敏感） | ⚠ **不红**（见 4.4，按构造不可观测） |
| **C2** | 精确层大小写敏感 **且** 删除子串层 | ❌ **4 条变红**（含大小写用例） |
| **D** | 停用 `listed.length === 1` 单角色分支 | ❌ **1 条变红** |

### 4.2 变异 A 原始输出

```
=== MUTATION A — exact-match tier DELETED (substring only) ===
  FAIL an EXACT match wins over a longer name that contains it
  FAIL all three write tools resolve the target the same way
EXIT=1
character-target.test.mjs: 2 failure(s)
```

**变异 A 下 `"maria"` 的实际去向**（真实解析器实测）：

```
roster (sorted as locateCharacter sees it): ana-maria, maria
"maria" -> ana-maria
   maria hp     = 5
   ana-maria hp = 4        ← 写错了人，且工具汇报的是被写的那张表
```

**还原后**：

```
roster (sorted as locateCharacter sees it): ana-maria, maria
"maria" -> maria
   maria hp     = 4
   ana-maria hp = 5
```

### 4.3 变异 B 原始输出

```
=== MUTATION B — `requested` IGNORED (first listed character always wins) ===
  FAIL an EXACT match wins over a longer name that contains it
  FAIL an omitted name is refused when the campaign has several characters
  FAIL an unknown name is refused and nothing is written
  FAIL resolution is scoped to the ACTIVE campaign, by design
  FAIL all three write tools resolve the target the same way
  FAIL a substring shared by two names resolves by order, and that is recorded here
EXIT=1
character-target.test.mjs: 6 failure(s)
```

**变异 B 正是报告 Bug 2b 所描述的实现**（`character` 被忽略、永远写活动战役里的第一个角色）。
测试把它抓住了 —— 说明本套件**有能力**证实该缺陷，只是真实代码并没有这个缺陷。

### 4.4 变异 C：**未能捕获，如实记录**

```
=== MUTATION C — candidate-side case folding REMOVED ===
EXIT=0
```

**原因（不是测试写错，是变异本身不可观测）**：任何「精确层因大小写而失配」的阵容，
子串层（**仍然折叠大小写**）会命中**同一个 stem**，于是工具行为**完全没变**：

```
wanted = 'mira', stems = ['Mira', 'mira-vane']
  候选名折叠   : Mira
  候选名不折叠 : undefined        ← 精确层失配
  子串层(折叠) : Mira             ← 结果与折叠时相同
```

**一个测试无法观测不改变任何结果的变异。** 使大小写折叠可观测需**同时**删除子串层 —— 即变异 C2：

```
=== MUTATION C2 — exact tier case-SENSITIVE and substring tier REMOVED ===
  FAIL a differently-cased name resolves to the same character
  FAIL a substring resolves to the character whose name contains it
  FAIL surrounding whitespace does not change the target
  FAIL a substring shared by two names resolves by order, and that is recorded here
EXIT=1
character-target.test.mjs: 4 failure(s)
```

该边界已写进测试文件的注释（`BOUNDARY, measured and recorded rather than papered over`），
**没有**用一句「已验证」掩盖。

---

## 5. 报告为什么会得出「目标被忽略」的结论

**最可能的成因：T2 的写入拒绝被误读。**

T2 修复前，写路径不传 `sandboxPolicy`，平台退回**进程 cwd**（`C:\Users\Ming`）判定，
于是任何 `D:\DND` 下的写入都得到：

```
cannot write "D:\DND\campaigns\<campaign>\characters\alice.state.json":
file access denied under workspace-write mode
```

**这一拒绝与 `character` 取什么值毫无关系**，但对使用者而言，
「我点了名，结果一号数字都没动」与「我的点名被无视了」**在现象上完全同构**。

### 5.1 T2 时代失败形态的复现（实测，且比预期**更有力**）

T2 之后真实路径已不再被拒，故用**等价构造**复现：把 fs mock 的 `writeText`
换成抛出**与出厂缺陷逐字相同**的 `FS_SANDBOX_DENIED`，再对**不同**的
`character` 取值逐一调用（两角色阵容 `alice` / `bob`）。

**可复现命令**：`node scripts/t3-refusal-probe.mjs`（`dsh-dnd-bundle/` 下）
> 该探针**不在** `npm run check` 链内（它演示的是 T2 之前的失败形态，不是当前行为），
> 作为**证据留存**置于 `scripts/`。其写入全部落在 mkdtemp 临时树内，且 mock 拒绝一切写入。

**原始输出**：

```
T2-era write refusal, across DIFFERENT character arguments
(a "target ignored" defect must treat these differently)

character="alice"    -> THREW: FS_SANDBOX_DENIED: cannot write "…/refcamp/characters/alice.state.json": file access denied under workspace-write mode
                        files moved: NONE
character="ALICE"    -> THREW: FS_SANDBOX_DENIED: cannot write "…/refcamp/characters/alice.state.json": …  ← 同一个文件
                        files moved: NONE
character="ali"      -> THREW: FS_SANDBOX_DENIED: cannot write "…/refcamp/characters/alice.state.json": …  ← 同一个文件
                        files moved: NONE
character omitted    -> Which character? refcamp has 2: alice, bob
                        files moved: NONE
character="bob"      -> THREW: FS_SANDBOX_DENIED: cannot write "…/refcamp/characters/bob.state.json":   …  ← **另一个**文件
                        files moved: NONE
character="nobody"   -> Character "nobody" not found in refcamp. Available: alice, bob
                        files moved: NONE
```

**这张表本身就是对报告的驳斥**，逐条读：

1. `"alice"` / `"ALICE"` / `"ali"` 三种写法**都尝试写 `alice.state.json`** ——
   即三种输入形态在**目标解析阶段**被正确折叠到**同一个**文件。报告说「显式传 `character` 仍指向活动战役的角色」，
   但这里决定被写文件的正是**参数**，不是活动战役里「某个固定角色」。
2. `"bob"` 尝试写的是 **`bob.state.json`** —— **另一个**文件。
   若参数被忽略、永远指向同一个（活动战役的）角色，这一行**不可能**与 `"alice"` 不同。
3. `"nobody"` 与「省略」**根本没有走到写入**，而是给出**针对目标**的拒绝文案
   （`not found` 列出 `alice, bob`；歧义列出 `Which character?`）。
   若参数不参与解析，这两种输入**应当**与 `"alice"` 一样走到写入才失败。

**结论**：失败发生在**目标解析之后**，与目标无关，正是 T2 记录的写入许可环节
（`resolve()` 未收到 session → 进程 cwd 判定 → `FS_SANDBOX_DENIED`）。
T2 已独立证实该根因，与 `locateCharacter` 无关。

**这正是报告会得出「目标被忽略」的原因**：DM 看到的是
「我点名了 alice，结果一号数字都没动」——
至于工具**曾经正确找到** alice 并**在写入那一步**被拒，从表面上完全看不出来。

> ⚠ **需要注意与第 3 节的区别**：第 3 节是在**已修好**的代码上测的实际落盘；
> 本节是在**模拟 T2 之前**的环境下测的**尝试目标**。
> 两者合起来才完整：解析一直是正确的，曾经坏掉的是写入许可。

### 5.2 本卡现在能给出的反证

T2 已在位，写入不再被拒。于是同样的四种写法**全部成功，且各自落在正确的表上**（第 3 节）。
即：**一旦移除了那个与目标无关的拒绝，目标解析立刻表现为正确** ——
这是「缺陷在写入许可、不在目标解析」的直接证据。

---

## 6. 歧义隐患：**记录，不修**（`"ma"` 这类共享子串）

当两个角色名共享一个子串时，:113-114 **按排序取第一个，静默**：

```
roster: ana-maria, maria, alice
"ma" -> ana-maria      （ana-maria 先于 maria 排序）
        maria hp 仍为 5，ana-maria hp 5→2
```

**判断：这是缺陷，但不在本卡范围内，且不应按本卡的方式修。**

理由：
1. **本卡的争议点是「显式名称被忽略」**。`"ma"` 是**部分**名称，不是显式全名；
   子串匹配是**文档化的便利**（工具参数说明写着 "Character name or stem"），
   把「恰好有歧义的部分匹配」改成拒绝，会**收紧一个既有便利**，
   属于行为变更而非缺陷修复。
2. **静默是真问题**：取名 `"ma"` 的 DM 不会知道存在 `ana-maria`。
   但这应当作为**独立的一张卡**处理（建议：多个子串命中时改为拒绝并列出候选，
   与省略写法在多角色时拒绝的处理保持一致）。
3. **本卡已把当前行为钉死**在测试 `a substring shared by two names resolves by order, and that is recorded here`：
   将来若有意改变优先级，会**先在这里变红**，而不是无声漂移。

---

## 7. 数据安全与通用验收

### 7.1 逐条核对

| 验收项 | 状态 | 证据 |
|---|---|---|
| 结论明确（证实/证伪） | ✅ | **证伪**，第 0 节 + 第 1、3、5 节 |
| 四种等价写法逐一有独立证据 | ✅ | 第 3.1 节表（含 2b/3b/3c 三个额外分支） |
| 若修复：新测试能在修复前失败 | — | **未修复**（无需修复）；改为提供**变异验证**证明测试**能**红：第 4 节 |
| `npm run check` 无**新增**失败 | ✅ | 前 **1** / 后 **1**，且为**同一条**既有失败 |
| 写入测试全部在受控目录 | ✅ | 写入只发生在**每个测试自有的 mkdtemp 临时树**内（``dnd-target-*``），`os.tmpdir()` 下 |
| 未重启 harness、未做 git 写操作 | ✅ | 全程无 `git commit/tag/push` |
| `campaigns/morgansfort/` 未改动 | ✅ | 第 7.2 节哈希 |
| 活动战役（`retest-alice`）未被写入 | ✅ | 第 7.2 节哈希 |
| `.agents/skills/dnd/` 未重建 | ✅ | 未创建任何文件于该路径 |
| 未新增 npm 依赖 | ✅ | `package.json` 仅 `test` 脚本插一行 |

### 7.2 实时哈希（本卡开工时与收尾时逐项核对）

**活动战役标记** `.runtime/active-campaign.json`（含 BOM，`len=27`）：

```
开工前 sha256 : 276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
收尾时 sha256 : 276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
identical     : True
内容          : {"name": "retest-alice"}
```

> 本卡的测试**从不写活动标记**：它把 `D:/DND/.runtime` 重映射进临时树，
> 在临时树里写一份自己的标记，真实标记只读不写。

**`campaigns/morgansfort/characters/`**：

```
alice.md          109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB
alice.state.json  428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105
```

**`campaigns/retest-alice/characters/`**（当前活动战役）：

```
alice.md          1864 bytes  426BE01BEDD551A10759D0EBDCDBC57A4A89FA44212AB05E52C34585270022F3
alice.state.json  3948 bytes  9C61C7F32829C1E6909214D745D0CC63E09C3E22ECF01C7CE11B06EB429E686C
```

### 7.3 `campaigns/stage2-test/` 最终状态：**已还原为原样**

卡上允许在 `stage2-test` 造第二个角色，但**实测证明那样会破坏既有套件**：

```
dnd_track — hit points
  FAIL damage below 0 clamps to 0, got 5
  FAIL and says it clamped: "Which character? stage2-test has 3: alice, bob, bob-alice"
  ...
TypeError: Cannot read properties of undefined (reading 'length')
    at scripts/write-tools-scenario.mjs:288
```

原因：该脚本**绝大多数调用都省略 `character`**（它测的是 HP/法术位/货币规则，不是目标解析）。
多出角色后每条省略调用都变成歧义拒绝。故：

- 已**删除**本卡临时加入的 `bob` / `bob-alice`；
- `stage2-test/characters/` 现仅存 `alice.md` + `alice.state.json`（与开工时一致）；
- 永久测试改为**自带 mkdtemp 临时树**，这也是 `scripts/audit-test-ownership.mjs` 对 `*.test.mjs` 的归属要求。

### 7.4 `npm run check` 前后对照（原始 tail）

**前**：

```
the real campaign was never touched
  ok  morgansfort/alice.md is byte-identical
  ok  the active-campaign marker still exists
  ok  the marker was restored byte-for-byte, BOM included
  FAIL and the real campaign is active again
  ok  the real character's state file was present and still is
  ok  and it is byte-identical
  ok  nothing under campaigns/morgansfort/characters moved (whole tree hashed)

write-tools.scenario: 1 failure(s)
```

**后**（同一位置、同一条失败）：

```
the real campaign was never touched
  ok  morgansfort/alice.md is byte-identical
  ok  the active-campaign marker still exists
  ok  the marker was restored byte-for-byte, BOM included
  FAIL and the real campaign is active again
  ok  the real character's state file was present and still is
  ok  and it is byte-identical
  ok  nothing under campaigns/morgansfort/characters moved (whole tree hashed)

write-tools.scenario: 1 failure(s)
```

`^\s*FAIL` 计数：**前 1 条 / 后 1 条**，内容均为
`FAIL and the real campaign is active again` —— 即任务书声明的**既有缺陷**
（脚本断言活动战役必须是 `morgansfort`，而标记指向 `retest-alice`）。
**无新增失败。** 新增套件在 `check` 中全绿（11/11）。

---

## 8. 改动清单

| 文件 | 改动 | 为什么 |
|---|---|---|
| `test/character-target.test.mjs` | **新增**（11 条断言） | 钉死「`character` 参与目标解析」这一事实，可证伪、可变异 |
| `scripts/t3-refusal-probe.mjs` | **新增**（证据留存，**不进** `check` 链） | 复现 T2 时代的失败形态，逐写法打印**被尝试写入的文件**，作为第 5.1 节的原始证据 |
| `package.json` | `test` 脚本插入 1 段（**1 行内**） | 否则新测试不进 `npm run check` |
| `docs/harness/T3-CHARACTER-TARGET-RESOLUTION.md` | **新增**（本文件） | 结论与证据 |

**`src/` 与 `lib/` 零改动**，因此**无需 `npm run build`**（`check` 内仍会跑，产物一致）。
未触及 `lookup.mjs` / `shared.mjs` / `host.test.mjs` 等 T4/T5/T8-T10 的并行在途改动。

---

## 9. 本文件**不**证明的事（诚实边界）

1. **不证明真机 GUI 路径**。本卡的证据来自直接调用 `buildTools(ctx)` 得到的工具对象，
   `execute(args)` 走的是与真实调用**同一条** `locateAndApply → locateCharacter → writeCharacter` 链，
   但**未经由** harness 的工具注册/调度层，也未在 Web GUI 里手工点一次。
2. **不证明沙箱在真机通过**。临时树的写入用的是 mock fs（直接 `writeFileSync`），
   不经过 `dsh-fs-sandbox`。沙箱自身的正确性属 T2 范围，本卡不重复论证。
3. **变异 C 未捕获**（第 4.4 节）。本套件**不能**观测「只删候选名大小写折叠」这一变异，
   因为该变异不改变任何结果。已如实记录，未声称已覆盖。
4. **子串歧义仍是隐患**（第 6 节）。本卡**故意不修**，只钉住当前行为。
5. **未验证跨战役**。工具**设计上**只在活动战役内解析（第 10 节），
   本卡只证明该边界**存在且被测试钉住**，未评估「是否应该支持跨战役」这一产品问题。
6. **第 5.1 节是模拟环境，不是历史现场**。该节的 `FS_SANDBOX_DENIED` 由本卡的 fs mock
   **主动抛出**（逐字照抄出厂错误），用来演示 T2 之前的失败形态。
   它**不**是「在 T2 修复前跑过的存档输出」—— 本卡开工时 T2 已在工作树中。
   它证明的是：**该拒绝形态与目标无关**，因此足以解释报告为什么那样读。

---

## 10. 关于「活动战役指针」的定性

`locateCharacter` **先**读活动标记（:99），**再**只在该战役的 `characters/` 里解析（:103-104）。
这是**设计**，不是缺陷：工具没有跨战役概念，`character` 是**战役内**的名字。

本卡用测试 `resolution is scoped to the ACTIVE campaign, by design` 把这条边界钉住：
在**非活动**战役 `othercamp` 里放一个 `carol`，再点名 `"carol"` ——
实测**未命中**、**零张表动**、且拒绝文案**报出被搜索的战役名**（`targetcamp`）。

因此报告的措辞值得修正：**「写入指向当前活动战役的角色」这句话本身是描述设计，不是描述缺陷**。
真正的缺陷表述应当是「`character` 被忽略，写入退化为活动战役里的任意角色」——
而这一点**实测不成立**（变异 B 证明测试能抓住它，真实代码不触发它）。

**风险仍然存在但性质不同**：活动标记若**设错战役**，写工具会去**另一个战役**里找同名角色
（找到就写，找不到就报 not found）。这是**标记正确性**的问题，不是目标解析的问题，
应当由「加载战役」这一步的正确性来保证，属另一张卡。
