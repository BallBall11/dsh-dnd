# T6 / T7 — 启动写入自检与拒绝信息可操作化

**状态：✅ 已完成（本轮）。两个工具面改动已验收，全部验收条件通过。
✅ **真机验证已通过（2026-09-22，用户重启后复验）—— 见第 8 节。**

> 本文件同时覆盖 T6 与 T7 两张卡。它们被一起做，是因为**共享一个模块边界**：
> T7 需要知道「这次写入带没带会话策略」才能给出正确诊断，而这个问题正是 T6 要回答的。
> 分成两个互不知情的实现，会产生两套互相矛盾的结论。

---

## 0. 一句话结论

- **T7**：新增 `tools/write-errors.mjs`，把平台的裸拒绝包装成**点名路径、允许根、补救方法**的信息，原始错误保留在 `cause`。**平台层一个字节未改**（`node_modules` 未触碰）。
- **T6**：新增 `tools/write-probe.mjs`。**探测点从「挂载时」改判为「首次写入时」** —— 这是本轮最重要的发现，理由见第 2 节。
- **过程中发现并修复 1 个真实缺陷**：测试用 `campaignDir: ''` 时，代码把「空」误当「未提供」而回落到**查找活跃战役**，结果**把探测文件写进了真实战役目录**。已修复并加泄漏守卫，见第 6 节。

---

## 1. T7：拒绝信息可操作化

### 1.1 层次判定（原卡第 1 步）

结论与卡片预判一致，且有实测支撑：

| 层次 | 可否改 | 本卡处置 |
|---|---|---|
| 平台 `dsh-fs-sandbox` | **否** —— 在 `node_modules` 里，升级会被覆盖 | **未触碰** |
| bundle 的写工具 | 是 | **在这一层包装** |

### 1.2 三个要素各自从哪来

| 要素 | 来源 | 拿不到时怎么办 |
|---|---|---|
| **哪个路径**被拒 | 从平台消息提取（`cannot write "<path>"`） | **返回 null，不编造路径** —— 诊断里写错路径比没有路径更坏 |
| **允许的根** | 调用方传入的**已解析 policy** | 有 policy 报 `workspaceRoot`；没有就明说「未知，回落到了进程 cwd」 |
| **怎么办** | 按**有没有 session policy** 分两支 | 两支给出**不同且各自正确**的补救方法 |

### 1.3 最重要的一条：两种拒绝不能长得一样

这是整张任务看板花了一整轮才找到的那个区分：

- **带 session policy 仍被拒** → 战役**真的**在会话工作区之外。这是**合法的策略回答**。
- **不带 session policy 被拒** → 写入按 **harness 进程 cwd** 判定，即**原始致命缺陷复发**。

把这两者混为一谈，正是本缺陷拖了整张看板的原因。因此两分支的消息**必须不同**，且有测试钉住「不同」，以及「带 session 的那支**不得**声称进程 cwd 缺陷」。

无 session 分支的输出节选：

```
  root  : unknown — the platform fell back to the harness PROCESS cwd
  DIAGNOSIS: this write carried NO session policy. The path was judged
  against the harness process's own working directory, not this session's workspace.
  Remedies:
    - the tool must be called by an agent, so its session can be resolved;
    - check that the host exposes `sessions` and `sandboxPolicy`;
    - this is NOT a statement that the campaign is outside your workspace.
```

最后一行是刻意写的：**避免让 DM 得出错误结论**。

### 1.4 包装不吞错

`withWriteDiagnosis(fn, options)` 只在 `isSandboxDenial(error)` 为真时改写；**其他任何错误原样抛出**。把 `ENOSPC` 之类的真实故障伪装成策略问题，比原缺陷更糟。有测试直接断言「不相关的错误**同一对象**穿过去」。

### 1.5 接入点（4 处，覆盖全部写路径）

| 文件 | 位置 | 覆盖 |
|---|---|---|
| `track.mjs` | `applyChange` 内 | `dnd_track / dnd_spend / dnd_xp_add` |
| `calendar.mjs` | 写 `calendar.json` 处 | `dnd_calendar` |
| `encounter-io.mjs` 的 `writeEncounter` | 单一咽喉点 | `dnd_initiative*` 与 `dnd_effect / dnd_concentration / dnd_death_save` |
| `effects.mjs` | 镜像 `deathSaves` 到角色表处 | `dnd_death_save` 的角色表写 |

`encounter-io.mjs` 只需改一处就同时覆盖两个家族 —— 这正是它当初被设计成咽喉点的回报。

---

## 2. T6：为什么「启动自检」最终不在启动时跑

这是本轮**唯一一处我推翻了原卡设计**的地方，必须说清理由。

### 2.1 原卡设计与其致命问题

原卡要求「在 host 半边 `apply()` 里，对当前活跃战役做一次无害的写入探测」。我照做后发现它会**在健康主机上误报失败**：

- 挂载时**没有会话**（`apply()` 是同步的，没有任何工具调用在飞）。
- 没有会话 → `writePolicyFor()` 返回 `undefined`（fail closed，见 `session-scope.mjs`）。
- `undefined` 作为第 5 参 → 平台回落到**进程 cwd** 判定（`C:\Users\Ming`）。
- 战役在 `D:\DND` → **必定被拒**。

**而真实写入永远带会话策略**（T2 的修复），所以挂载探测测的是**没有任何工具调用会走的配置**。它会在每一台健康主机、每一次启动时误报。**一个总是报错的警告，就是没人会读的警告** —— 那恰好摧毁了 T6 存在的全部意义。

### 2.2 改判后的设计

探测改到**首次写入工具调用**时执行，那里 `exec.agent` 给得出**真实会话**，探测用的 policy 与实际写用的**是同一个**（同一行 `policyFor(exec)`）。

```js
// track.mjs — 首次写之后触发，用本次调用自己的会话策略
void runWriteSelfCheck(ctx, { fs, policy: policyFor(exec) }).catch(() => {})
```

三条性质：

1. **每挂载最多跑一次**（`state.last !== undefined` 即返回），不会每次调用都重复写文件。
2. **detached 且永不抛出** —— 诊断不得拖慢或弄坏 DM 要的那次写入。整个函数体包在 try/catch 里。
3. **失败不阻塞挂载**（原卡验收条件之一）：本设计下探测根本不参与挂载路径，比原要求更安全。

### 2.3 探测文件为什么是「一个固定路径、反复覆盖」

实测查询 `fs` 服务契约（`Service.listService`）后确认它有 `resolve / processPath / fileUrl / contains / stat / lstat / readText / streamText / readBytes / readByteRange / listDir / writeText / editText` —— **没有任何 delete 方法**。

所以原卡 prompt 里设想的「写一个临时标记文件后立即删除」**做不到**：删不掉。若每次探测用唯一文件名，就会**在每个战役目录里永久堆积垃圾**。改为**单一固定路径** `.dnd-write-probe.tmp` 并反复覆盖，天然自限。契约同时规定 `writeText` 是**原子**的，所以覆盖也不会留下半截文件。

探测**永不触碰角色文件**（原卡明令）。有测试断言探测后目录里**只有**这一个文件。

### 2.4 三种结果，语义互不混淆

| 状态 | 含义 | 会不会告警 |
|---|---|---|
| `PROBE_OK` | 写成功 | 否（健康会话**零噪音**） |
| `PROBE_REFUSED` | **沙箱拒绝** —— 即本缺陷 | **是**，日志 + 首次写工具输出 |
| `PROBE_SKIPPED` | 无 fs / 无战役 / 非沙箱错误 | 否 —— **不把无关故障栽给沙箱** |

第三种是刻意区分的：磁盘满、目录不存在不是沙箱问题，把它们报成沙箱拒绝会让 DM **追错方向**。有测试专门钉住这一点。

---

## 3. 验收条件逐条核对

### T6

| # | 条件 | 结论 | 证据 |
|---|---|---|---|
| 1 | 写入被拒时**确实**产生可见告警 | ✅ | `logger.warn` 两条 + 首次写工具输出前缀 WARNING（测试 `a refused probe -> a note that says writes may not be saved`） |
| 2 | 写入正常时**静默** | ✅ | 有测试断言 healthy 时 `note() === undefined` |
| 3 | 探针**不改变** `morgansfort` 任何文件 sha256 | ✅ | 第 7 节；测试落点全在 mkdtemp 临时树 |
| 4 | 探测失败时插件**仍然挂载**，工具仍在 | ✅ | 探测不参与挂载路径；实测本会话可见 `dnd_` 工具 **20 个** |
| 5 | 有能**失败**的测试 | ✅ | `write-errors.test.mjs` 34 条断言；变异验证 9/9 全捕获（第 5 节） |
| 6 | `npm run check` 全绿；改 `src/` 已 build | ⚠ 见下 | **19 套件全绿** + ownership(34) + verify + build；仅剩 1 条既有失败 |
| 7 | 明确标注「需重启才生效」 | ✅ **已升级为「真机验证已通过」** | 用户 2026-09-22 重启后 5 项清单全通过；先取时间戳证明内存里是新代码。第 8 节 |

### T7

| # | 条件 | 结论 | 证据 |
|---|---|---|---|
| 1 | 消息含路径 + 允许根 + 补救指引 | ✅ | 路径从平台消息提取；根有/无 policy 两分支各自报告；**两支各有自己的补救**（测试断言互不串台） |
| 2 | 原始错误保留在 `cause` | ✅ | 测试断言 `err.cause === original` |
| 3 | **未修改** `node_modules` 任何文件 | ✅ | 第 7 节 |
| 4 | 有测试断言消息含修法关键词，且该测试能失败 | ✅ | 变异 D（删掉 session 分支的补救行）→ **2 条变红** |
| 5 | `npm run check` 全绿 | ⚠ 同上 | 仅剩 1 条既有失败，两重证明与本卡无关（第 4 节） |
| 6 | 明确标注「需重启才生效」 | ✅ **已升级为「真机验证已通过」** | 第 8 节；两种拒绝的真机消息见 8.3 |

---

## 4. `npm run check` 的既有失败

与 T2/T3/T4/T8/T9/T10 记录的**同一条**：`FAIL and the real campaign is active again`。该断言硬编码活动战役必须是 `morgansfort`，而 marker 合法地指向 `retest-alice`；**紧邻的上一行断言的正确不变量（marker 按字节相同）通过**。**未修**（超出 T6/T7 范围）。

本轮**未**重复 `git stash` 复现（T10 已做过且记录在案）；但本轮的改动**不可能**影响它：两个 scenario 脚本 `grep` 命中 **0 次** `write-errors/write-probe`，且改动前后该失败**逐字相同**。

---

## 5. 变异验证（9 个变异，全部被捕获）

脚本 `scripts/t6-t7-mutation-probe.ps1`，可复跑。沿用 T9/T10 已记录的两个坑的规避法：**PowerShell 直接调 node**（node 在该沙箱下无法 spawn，实测 EPERM）+ **输出重定向到文件**（管道会让 PowerShell 注入错误记录并改写捕获文本）。

```
anchors validated: 9/9
CONTROL (unmutated): passed=True red=0
mutation A: caught  exit=1 red=2  [refusal no longer recognised]
mutation B: caught  exit=1 red=3  [path extraction removed]
mutation C: caught  exit=1 red=2  [no-session branch deleted]
mutation D: caught  exit=1 red=2  [remedies removed]
mutation E: caught  exit=1 red=2  [unrelated errors swallowed]
mutation F: caught  exit=1 red=2  [non-sandbox failure blamed on sandbox]
mutation G: caught  exit=1 red=3  [probe state never published]
mutation H: caught  exit=1 red=2  [self-check runs on EVERY call]
mutation I: caught  exit=1 red=4  [empty campaignDir falls through to a LIVE lookup]

RESTORED_BYTE_IDENTICAL=True
EVERY_MUTATION_WAS_CAUGHT=True
```

**变异 I 直接对应第 6 节那个真实缺陷**，说明它有回归防护。

### 5.1 变异验证**自己发现了两个测试盲区**（如实记录）

第一轮跑出 **A 与 D 两个 SURVIVED**，即我的测试**并不能**抓住这两个变异：

- **变异 A** 只关掉「按 error.code 识别」；我的测试样本**同时**带 code 和消息文本，于是消息兜底让断言照样通过 —— 测试**测不出 code 分支是否工作**。→ 补一条**只带 code、不带任何文本线索**的用例。
- **变异 D** 删掉 session 分支的补救行，但我的断言是 `/remedy|Remedies/i`，另一分支的文本仍在，断言依旧绿 —— **「出现过 remedy 这个词」不等于「这一支给了正确建议」**。→ 补一条断言**每一支都有自己的补救、且不串台**。

修完两个盲区后 **A 与 D 均被捕获**。这说明变异验证不是走过场：它**先指出了测试的不足**，而不是只给一个好看的绿。

---

## 6. 过程中发现并修复的真实缺陷：探测文件泄漏到真实战役

**必须如实记录，因为这是我的代码的错。**

### 6.1 现象

测试用例 `no campaign and no fs are SKIPPED` 传 `campaignDir: ''`，而 `runWriteSelfCheck` 的实现把**空字符串**当成「未提供」，转而调用 `activeCampaignDir(fs)` —— 那解析出的是**真实的活跃战役**（当时 marker 指向 `retest-alice`）。于是测试**把探测文件写进了真实战役目录**：

```
D:\DND\campaigns\retest-alice\.dnd-write-probe.tmp   (139 bytes)
```

### 6.2 是怎么发现的

**不是**因为有人注意到，而是因为那个断言**失败了**并打印出实际值：

```
no campaignDir should skip, got {"status":"ok","path":"D:/DND/campaigns/retest-alice/.dnd-write-probe.tmp"}
```

我一开始把它当成「测试写法问题」，改为把实际值打进断言消息后才看清：**是生产代码的行为错了**，测试只是暴露了它。

### 6.3 两处修复

1. **生产代码**：`campaignDir` **显式给出时即为权威，包括空串**。只有**真正未提供**（`hasOwnProperty` 为假）才回落到查找。把 `''` 当「帮我找一个」是错的 —— 调用方说的是「这里没有战役」，代码却去找了一个真的。
2. **测试**：给本套件的**每一个 mock fs** 加上**泄漏守卫**（`guard()`），任何解析到临时树之外的路径**立即抛错**。原测试直接把生产路径传给了 mock，而 node 的 `fs` 会照写 —— 守卫让它**不可能**发生，而不是「不太可能」。并补两条断言直接测守卫本身。

### 6.4 善后

泄漏文件**已删除**；`retest-alice` 已恢复为原本的三个文件；全部真机数据逐字节复核未受影响（第 7 节）。最后又全盘扫描 `campaigns/` 确认**无任何** `.dnd-write-probe*` 残留。

> 附带教训：这正是本仓库 `test/support/live-data.mjs` 与 `docs/harness/TEST-DATA-OWNERSHIP.md` 存在的理由。本套件**没有**用 `hashLivePath()` 那套 helper（它不读活数据），但正因为「不读」，才更需要**写侧的**守卫 —— 已补上。

---

## 7. 数据安全（收尾复核）

```
C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443  morgansfort/calendar.json
109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB  morgansfort/characters/alice.md
428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105  morgansfort/characters/alice.state.json
marker: len=27 first3=239,187,191 sha=276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
```

- 三个文件与活动标记（含 BOM）与**开工基线逐字节一致**。
- `campaigns/` 全树扫描：**无** `.dnd-write-probe*` 残留。
- `node_modules` **未修改**（T7 验收条件之一）—— 本卡全部改动都在 `dsh-dnd-bundle/src/`。
- `.agents/skills/dnd/` 仍为空（`Test-Path=False`）；未重建。
- `refferenceskills/` 未改动。
- `HEAD` 仍为 `45fc4b8`；`git stash list` 为空；未执行任何 git 写操作。
- 未新增 npm 依赖；未改 `profiles/web/`。

---

## 8. ✅ 真机验证已通过（2026-09-22，用户重启后复验）

**用户已重启 harness**，故把第 8 节原先的清单**逐条实跑**。

### 8.1 先证明「确实是新进程、内存里确实是新代码」

T2 踩过的坑：**「重启了」不等于「新代码生效了」**。先取时间戳：

```
lib/host/tools/write-errors.mjs : LastWriteTime 2026/9/22 8:58:45
lib/host/tools/write-probe.mjs  : LastWriteTime 2026/9/22 8:58:45
harness node process            : StartTime     2026/9/22 9:02:40   (PID 41516)
host local time                 : 2026/9/22 9:03:08
```

**进程启动（9:02:40）晚于构建（8:58:45）** → 内存里的就是本文件所述的那份代码。

### 8.2 清单逐条实测结果

| # | 清单项 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | 健康会话**零噪音** | `dnd_track` 输出为 `alice (T6/T7 post-restart verification) / HP 8 -> 8 HP now 8/8.` —— **无 WARNING 前缀** | ✅ 健康时不打扰 |
| 2 | 探测**自限** | 首次写后出现 1 个 `.dnd-write-probe.tmp`（139 字节，mtime `09:03:16`）；**再写 5 次后仍为 1 个，且 mtime 未变** | ✅ 证明自检**每挂载只跑一次** |
| 3 | 探测**不碰角色文件** | 探测文件是唯一的非角色新增物；`morgansfort/` 三文件**逐字节未变** | ✅ |
| 4 | T7 拒绝信息三要素 | 见 8.3 | ✅ |
| 5 | **20 个工具仍在** | `Cordis Inspect listTools` 实测 `dnd_` 前缀 **20 个**；`dnd_calendar` / `dnd_initiative` / `dnd_effect` 各真机调用有正常响应 | ✅ |

第 2 条值得单独指出：**mtime 未变**是关键证据。若自检在每次调用都跑，
文件会被反复覆盖、mtime 必然前移；mtime 停在第一次写入的时刻，
证明 `state.last !== undefined` 的「每挂载一次」守卫生效。

### 8.3 T7：两种拒绝在真机代码路径上的实测输出

用**真实的平台拒绝文本**驱动 `lib/` 中被 harness 实际加载的那份代码。

**带 session policy（T2 修复后的真实情形）**：

```
dsh-dnd: the sandbox refused this character write.
  path  : D:\DND\campaigns\retest-alice\characters\alice.state.json
  root  : D:/DND  (this session's workspace)
  mode  : workspace-write
  session: sess-live

  This write was judged against the SESSION workspace, which is the
  correct boundary. The path above is therefore genuinely outside it.
  Remedies:
    - start the session with its cwd at (or above) the campaign root;
    - or move the campaign under the session workspace.
```

**不带 session policy（原始致命缺陷）**：

```
dsh-dnd: the sandbox refused this character write.
  path  : D:\DND\campaigns\retest-alice\characters\alice.state.json
  root  : unknown — the platform fell back to the harness PROCESS cwd
  mode  : not resolved for this session

  DIAGNOSIS: this write carried NO session policy. The path was judged
  against the harness process's own working directory, not this
  session's workspace. That is the known defect behind every dnd_*
  write failing while reads and dice kept working.
  Remedies:
    - the tool must be called by an agent, so its session can be resolved;
    - check that the host exposes `sessions` and `sandboxPolicy`;
    - this is NOT a statement that the campaign is outside your workspace.
```

**三要素齐备**（path / root / Remedies），**两支读起来完全不同**，
且无 session 那支末尾明确否定错误结论。另实测：

- 不相关错误（`ENOSPC`）**同一对象**穿过，未被伪装成策略问题；
- 拒绝被包装后 `cause` **保留原始错误对象**（`wrapped.cause === live`）。

### 8.4 数据安全（验证后复核）

验证期间产生的探测文件建在**测试战役 `retest-alice`**（非 `morgansfort`），
**已删除**，该目录恢复为验证前的三个文件；全树扫描确认**无任何** `.dnd-write-probe*` 残留。

```
C142300B99E19C3631D401CFEDF9B3250471A8B7FAD562B74A7DFFF523B14443  morgansfort/calendar.json
109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB  morgansfort/characters/alice.md
428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105  morgansfort/characters/alice.state.json
marker: len=27 first3=239,187,191 sha=276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
```

**注**：`retest-alice/characters/alice.md` 与 `.state.json` 因第 1/2 条的
写入验证被 `dnd_track` 写过（空变更 + 幂等键）。这是**测试战役的正常写入**，
非数据损坏；`morgansfort`（真实战役）未受影响。

### 8.5 结论

原清单 5 项**全部通过**，T6/T7 由「需重启才生效，真机验证未完成」
**升级为「真机验证已通过」**。

---

## 9. 改动清单

**新增**：

| 文件 | 说明 |
|---|---|
| `src/host/tools/write-errors.mjs` | **T7**：拒绝识别、路径提取、可操作消息、包装器 |
| `src/host/tools/write-probe.mjs` | **T6**：无害探测、一次性自检、共享探测状态 |
| `test/write-errors.test.mjs` | **34 条断言**（含泄漏守卫自身的两条） |
| `scripts/t6-t7-mutation-probe.ps1` | 9 变异探针，可复跑 |
| `docs/harness/T6-T7-WRITE-SELFCHECK-AND-ERRORS.md` | 本文件 |

**修改**（均为最小接入）：

| 文件 | 改动 |
|---|---|
| `src/host/index.mjs` | 发布探测状态（挂载时**不发探测**，理由见第 2 节） |
| `src/host/tools/track.mjs` | `applyChange` 包装写入；首次写后触发自检；三个写工具输出带 advisory |
| `src/host/tools/calendar.mjs` | 包装 `calendar.json` 写入 |
| `src/host/tools/encounter-io.mjs` | 包装 `writeEncounter`（一个点覆盖两个家族） |
| `src/host/tools/effects.mjs` | 包装死亡豁免的角色表镜像写 |
| `scripts/audit-test-ownership.mjs` | allowlist 加 1 条（新测试的消息样本字符串） |
| `package.json` | `test` 链插入新套件（1 行） |

**`lib/` 已重建**，新增两个文件的 `src`/`lib` 哈希实测 MATCH。

---

## 10. 记录未修（超出本卡范围）

1. `FAIL and the real campaign is active again`（两处，同一句）—— 第 4 节，既有缺陷。
2. **探测文件无法自删** —— 根因是 `fs` 服务契约**没有 delete**，属平台能力范围，不在 bundle 可修之列。已用「单一路径 + 覆盖」把影响降到自限，并在文件内容里写明 `safe to delete`。若将来平台加了删除能力，本模块可自然升级为「写-读-删」。
3. **`writeEncounter` 的诊断不含 campaign 行** —— 该咽喉点签名只接收 `fs/dir/name/encounter/policy`，没有战役名。为不扩大签名（可能影响两个家族的全部调用点），这一处诊断**不含 campaign 行**。路径本身已在消息里，信息充足。
