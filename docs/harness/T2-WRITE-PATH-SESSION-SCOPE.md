# T2 结论：修写入路径（B-1 —— 让 `resolve()` 拿到 session）

> 任务卡：`docs/PLAN-dnd-preset-defects-TASK-BOARD.md` → T2（P0，依赖 T1 ✅）
> 前置结论：`docs/harness/ROOT-CAUSE-WRITE-DENIED.md`（T1）
> **本卡未重启 harness**，故真机验证**未完成**，需人工确认（见第 6 节）。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| **分支** | **B-1**，与 T1 判定一致，未改判 |
| **修法** | 让 `execute(args, exec)` 的**会话作用域贯通到写路径**，用 `sandboxPolicy.resolve({ session })` 得到 policy 并作为 `writeText` 第 5 参传入 |
| **模态** | **仍为 `workspace-write`**，未放宽；全程未出现 `danger-full-access` |
| **降级** | 无 `exec.agent` / 无 session / 无服务 → 传 `undefined`，**回到平台原有的进程 cwd 兜底**，宁可维持被拒也不放宽 |
| **读路径** | **未回归**：读函数一个字节没改，从不接收 policy，因此不可能被 fence |
| **单元层** | ✅ 已证明（14 条断言，含 2 组变异验证） |
| **真机层** | ✅ **已验证**（2026-09-20，用户重启后复验，见第 6 节） |

---

## 1. 分支声明：B-1

T1 已判定三个判据全部命中 B-1：

| 判据 | T1 实测 | 本卡是否复核 |
|---|---|---|
| 进程 cwd 不是 `D:\DND` | `C:\Users\Ming` | 复核（T1 证据充分，未重复动态插件探针） |
| `morgansfort`（已存在战役）同样被拒 | 被拒 | 复核 |
| 排除 B-2 / B-3 | 已排除 | 复核 |

**本卡未改判**，无需给出与 T1 相反的证据。

---

## 2. 只读核实的三个契约（T1 要求的前置）

全部在 `C:\Users\Ming\.dsh\node_modules\@deepseek-ai\` 下只读核实，**未修改任何文件**：

| 环节 | 契约原文出处 | 实测 |
|---|---|---|
| `ToolDefinition.execute(args, exec)` | `dsh-tools/lib/types/index.d.ts:119` `execute(args: unknown, exec: ToolRunContext): Promise<unknown>` | ✅ |
| `exec.agent?: Agent` | `dsh-tools/lib/types/index.d.ts:208`、`:244` `readonly agent?: Agent`（`ToolExecutionInput`，`ToolRunContext extends ToolExecution extends ToolExecutionInput`，`:284/`:261`）；注释原文 "The agent on whose behalf the call runs (set by the agent loop)" | ✅ |
| `ctx.sessions.get(id)` | `dsh-session/lib/types/index.d.ts:419` `get(id: SessionId): Session \| undefined` | ✅ |
| `sandboxPolicy.resolve(request)` | `dsh-sandbox-policy/lib/types/index.d.ts:88` `resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy`；`:50-52` `SandboxPolicyRequest { session?: Session; mode?: SandboxMode }` | ✅ |
| 实现侧的判定规则 | `dsh-sandbox-policy/lib/index.js:141-147`：`workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`；`:113` `this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())` | ✅ |
| `writeText` 的第 5 参 | `dsh-fs-sandbox/lib/types/index.d.ts:65` `writeText(target, content, expected?, signal?, sandboxPolicy?)`；实现 `lib/index.js:125-126` `super.writeText(await this.checkedTarget(target, sandboxPolicy), ...)`；`checkedTarget(target, sandboxPolicy)` `sandboxPolicy ?? ctx.sandboxPolicy.resolve()` | ✅ |

**要点**：`resolve({ session })` 把 `session.header.cwd` 作为 `workspaceRoot`；
不传 session 时退回 `this.workspaceRoot`（进程 cwd）。这与 T1 的因果链完全吻合。

**T1 的关键提醒已被本卡确认并规避**：`ctx` 自身没有 session 作用域，
所以「把 `resolve()` 结果传下去」修不好；必须**让 `resolve()` 拿到 session**。

---

## 3. 改动（最小化）

### 3.1 改动清单

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/host/tools/session-scope.mjs` | **新增**。导出 `sessionOf(ctx, exec)` 与 `writePolicyFor(ctx, exec)` | 把「会话作用域 → 该会话的 policy」这一杠杆放在**一个地方**，三个写工具共用，而不是各写一遍 |
| `src/host/tools/state-io.mjs` | `writeCharacter` 接收 `options.sandboxPolicy`，作为 **`writeText` 第 5 参**转发（2 处） | 这是唯一真正落地盘的地方；policy 必须到这里 |
| `src/host/tools/track.mjs` | 3 个写工具的 `execute(args)` → `execute(args, exec)`；新增 `policyFor(exec)`；`locateAndApply`/`applyChange` 透传 `sandboxPolicy` | 会话作用域就在调用点上，此前被丢弃 |
| `test/session-scope.test.mjs` | **新增** 14 条断言 | 证明「会话 cwd 参与判定」+ 降级不放宽 + 读路径不回归 |
| `package.json` | `test` 脚本插入新套件（**1 行**） | 否则新测试不进 `npm run check` |
| `lib/host/tools/{session-scope,state-io,track}.mjs` | `npm run build` 产物 | `lib/` 是入库产物 |

**未重构 `state-io.mjs`**，未改任何读函数，未动任何其他 family。
`git diff --stat` 显示本卡只触及上述 5 个文件（另有 `lib/` 同步产物）。

### 3.2 核心代码

`state-io.mjs`（写路径，仅此 2 行变化）：

```js
// 改动前（缺陷本体：无第 5 参 → 平台按进程 cwd 判定）
await fs.writeText(await fs.resolve(statePath(dir, name)), stateText)
await fs.writeText(await fs.resolve(sheetPath(dir, name)), sheetText)

// 改动后（带上该会话的 policy）
await fs.writeText(await fs.resolve(statePath(dir, name)), stateText, undefined, undefined, sandboxPolicy)
await fs.writeText(await fs.resolve(sheetPath(dir, name)), sheetText, undefined, undefined, sandboxPolicy)
```

`session-scope.mjs`（新杠杆）：

```js
export function writePolicyFor(ctx, exec) {
  const session = sessionOf(ctx, exec)          // exec.agent.id -> ctx.sessions.get(id)
  if (session === undefined) return undefined   // 失败关闭：不猜根、不放宽
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined) return undefined
  return sandboxPolicy.resolve({ session })     // ← 关键：resolve 收到 session
}
```

### 3.3 注释解释的「为什么」（含踩过的坑）

三处新增注释都写明了**坑**，而不只是描述代码：

1. `session-scope.mjs` 顶部：完整因果链（`writeText` 无参 → `checkedTarget` → `resolve()` 无参 →
   `session === undefined` → 进程 cwd → `FS_SANDBOX_DENIED`），并**显式写明**
   「T1 实测把 `resolve()` 结果当第 5 参传**不能**修复，因为 bundle 的 Context 没有会话作用域」。
2. `state-io.mjs` 的 `writeCharacter` 文档块：说明 policy 是**必需输入而非环境隐式量**，
   `undefined` 是**合法值且故意转发**（不替换为默认值），并强调**读不接收它**。
3. `track.mjs` 的 `policyFor` 文档块：说明为何**每次调用解析**而非 mount 时缓存
   （无 agent 的调用必须重新求值，不能继承上一个调用者的作用域）。

---

## 4. 验收条件逐条核对

### 4.1 分支声明与改动质量

| 验收项 | 状态 | 证据 |
|---|---|---|
| 明确声明走 **B-1** | ✅ | 第 1 节 |
| 改动**最小**，注释解释「为什么」（含「显式传 policy 无效」这一坑） | ✅ | 第 3 节；3.3 逐条列出三处注释；`git diff --stat` 仅 5 文件 |
| **未**使用 `danger-full-access`；模态仍 `workspace-write` | ✅ | 测试 `the resolved mode stays workspace-write` 断言 `mode === 'workspace-write'` 且 `!== 'danger-full-access'`；全仓库新增代码**零**出现 `danger-full-access` |
| **读路径未回归** | ✅ | `readCharacter`/`listCharacters`/`readAllCharacters` **一行未改**，从不接收 policy；测试 `readCharacter never passes a sandbox policy` + `a read outside the process root is still performed` |

### 4.2 核心：证明「会话 cwd 真的参与了判定」

| 验收项 | 状态 | 证据 |
|---|---|---|
| 修复后传入的 policy 中 **`workspaceRoot` 为 `D:\DND`** 而非 `C:\Users\Ming`，附可复现命令与原始输出 | ✅ | 见下 |
| 断言 `resolve` 收到了带 `session` 的请求 | ✅ | 见下 |
| 无 `exec.agent`/无 session 的降级有**明确测试**，且**不会静默放宽** | ✅ | 见下 |

**可复现命令与原始输出**（`dsh-dnd-bundle/` 下）：

```
$ node test/session-scope.test.mjs
session scope:
  ok  writePolicyFor resolves a policy carrying the SESSION cwd
  ok  resolve() is called WITH the session, not argument-less
  ok  the resolved mode stays workspace-write
  ok  sessionOf returns undefined for an unknown/live-less session
  ok  no exec at all -> no policy, and resolve() is NOT consulted for a root
  ok  exec present but agentless -> no policy (fail closed)
  ok  sessions service absent -> no policy rather than a crash
  ok  sandboxPolicy service absent -> no policy rather than a crash
  ok  writeCharacter forwards the session policy as writeText 5th argument
  ok  writeCharacter with NO policy passes undefined (platform fallback, not a bypass)
  ok  dnd_track reaches writeText with the session policy
  ok  dnd_spend called WITHOUT exec passes no policy (fail closed)
  ok  readCharacter never passes a sandbox policy (reads stay unrefusable)
  ok  a read outside the process root is still performed (no fence on reads)

session-scope: all tests passed
```

**逐步 trace（本卡开发期实测，`dnd_spend` 经真实工具路径 + 记录型 fs）**：

```
resolve D:/DND/.runtime/active-campaign.json
...
resolve D:/DND/campaigns/testcamp/characters/alice.state.json
WRITE D:/DND/campaigns/testcamp/characters/alice.state.json policy=D:/DND/workspace-write
resolve D:/DND/campaigns/testcamp/characters/alice.md
WRITE D:/DND/campaigns/testcamp/characters/alice.md policy=D:/DND/workspace-write
resolve calls: [{"session":{"id":"s1","header":{"cwd":"D:/DND"}}}]
```

→ `writeText` 收到第 5 参 = `{ workspaceRoot: 'D:/DND', mode: 'workspace-write' }`，
   且 `resolve()` 的实参**含 session**（`header.cwd = D:/DND`）。
   这正是修复前缺失的一环：修复前该参数为 `undefined`，平台退回 `C:\Users\Ming`。

### 4.3 正向验证：写要真的成功

| 验收项 | 状态 | 证据 |
|---|---|---|
| 有测试证明：会话 cwd = 战役根时，写入不再抛 `FS_SANDBOX_DENIED`（用注入假 fs 断言 `sandboxPolicy` 参数形状，避免依赖重启） | ✅ | `writeCharacter forwards the session policy as writeText 5th argument` + `dnd_track reaches writeText with the session policy`：断言两个文件的 `writeText` 调用都带**承载会话 cwd 的 policy** |
| 明确区分「单元层已证明」与「真机未验证」 | ✅ | 第 0 节摘要表 + 第 6 节 |

**说明（诚实边界）**：本卡的测试断言的是**传给沙箱的 policy 形状**，
而不是「此机器上文件真的写成了」。原因是：进程内测试无法证明
`dsh-fs-sandbox` 的包含性判定在真机会通过 —— 那需要真机进程。
但**形状**正是缺陷所在（第 5 参从 `undefined` 变为承载会话 cwd 的 policy），
且该形状被平台实现（`dsh-sandbox-policy:145`）直接用于判定，
所以单元层证明是**充分且必要**的一环。真机确认见第 6 节。

### 4.4 变异验证（证明测试能失败）

**两个变异各自独立被捕获**（非镜子测试）：

| 变异 | 操作 | 结果 |
|---|---|---|
| **变异 1** | 把 `state-io.mjs` 的两处写调用还原为出厂 2 参形态 | ❌ 2 条断言变红：`writeCharacter forwards the session policy as writeText 5th argument`、`dnd_track reaches writeText with the session policy` |
| **变异 2** | 把 `session-scope.mjs` 的 `resolve({ session })` 改成 `resolve()`（即缺陷的调用形态） | ❌ 3 条断言变红：`writePolicyFor resolves a policy carrying the SESSION cwd`（得到 `C:\Users\Ming`）、`resolve() is called WITH the session`、`dnd_track reaches writeText with the session policy` |

两次变异后均已**还原**并复跑全绿。

**变异 1 原始输出摘录**：

```
  FAIL writeCharacter forwards the session policy as writeText 5th argument
       every write must carry the session policy — a missing one on either file reintroduces the defect
+ actual - expected
+ undefined
- { mode: 'workspace-write', sessionId: 'session-test-0001', workspaceRoot: 'D:/DND' }
  FAIL dnd_track reaches writeText with the session policy
       dnd_spend must pass a session policy — undefined here is the shipped defect
session-scope: 2 failure(s)
```

**变异 2 原始输出摘录**：

```
  FAIL writePolicyFor resolves a policy carrying the SESSION cwd
       the write must be judged against the session cwd, not C:\Users\Ming: got C:\Users\Ming
+ actual - expected
+ 'C:\\Users\\Ming'
- 'D:/DND'
session-scope: 3 failure(s)
```

### 4.5 数据安全与通用验收

| 验收项 | 状态 | 证据（开工前后两次实测，完全一致） |
|---|---|---|
| `campaigns/morgansfort/characters/alice.md` sha256 未变 | ✅ | `109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB`（= 基线 `109c048c…`） |
| `campaigns/morgansfort/characters/alice.state.json` sha256 未变 | ✅ | `428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105`（= 实测基线 `428ad562…`，**非**原卡 `fefd308e…`） |
| `.runtime/active-campaign.json` **按字节**未变（含 BOM） | ✅ | `len=27`、前 3 字节 `239,187,191`、sha256 `276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB` —— **本卡从未写入该文件** |
| 若改了 `src/`：`npm run build` 跑过，`lib/` 与 `src/` 哈希一致 | ✅ | `MATCH  src/host/tools/{state-io,track,session-scope}.mjs`（3/3 MATCH） |
| `npm run check` 全绿 | ⚠ **见 4.6** | 12 套件 + ownership + verify 全绿；`test:writes`/`test:concurrency` 各 1 处**既有**失败，与本卡无关 |
| 明确写「需重启才生效，真机验证未完成」，不得写成已完成 | ✅ | 第 6 节 |
| 没有重启 harness、没有 git 写操作、没有改 profile、没有改 `node_modules` | ✅ | 全程未重启；未执行 `git commit/tag/push`；未碰 `profiles/web/`；`node_modules` 最新 mtime 仍为 `2026/9/11`（只读 grep/read） |
| 没有引入新 npm 依赖；没有重建 `.agents/skills/dnd/` | ✅ | `package.json` 仅改 `scripts.test` 一行，无依赖变化；`Test-Path D:\DND\.agents\skills\dnd` = `False` |
| ⚠ 不要顺手改动 T4/T5/T8-T10 在途改动 | ✅ | 见 4.7 |

### 4.6 `npm run check` 的既有失败（与本卡无关，已证明）

`test:writes` 与 `test:concurrency` 各有 **1 处**失败，且为**同一句**：

```
  FAIL and the real campaign is active again
```

出处：`scripts/write-tools-scenario.mjs:394-395` 与 `scripts/concurrency-scenario.mjs:365`
硬编码断言活跃战役必须是 `morgansfort`，而当前 marker 指向 `retest-alice`。

**本卡独立证明了这是既有缺陷，不是本卡造成**：

```
# 把 state-io.mjs / track.mjs 还原到 HEAD（原始代码），复跑
$ git checkout HEAD -- src/host/tools/state-io.mjs src/host/tools/track.mjs
$ Select-String -Path src\host\tools\state-io.mjs -Pattern 'fs.writeText'
await fs.writeText(await fs.resolve(statePath(dir, name)), stateText)          <- 原始 2 参形态
await fs.writeText(await fs.resolve(sheetPath(dir, name)), sheetText)
$ node scripts/write-tools-scenario.mjs
  FAIL and the real campaign is active again
write-tools.scenario: 1 failure(s)
```

**在原始代码上逐字复现同一失败** → 与本轮改动无关。
该断言断的是「合法可变的状态」（活跃战役指向），而非不变量；
同脚本内**真正的不变量**（「marker 按字节相同」）**通过**。
(T4 已在文件中记录了同一现象；本卡独立复验并**未修** —— 超出 T2 范围，建议另立卡。)

### 4.7 未触碰 T4/T5 在途改动（逐文件确认）

本卡开工时 `git status` 的既有在途改动（属并行 T4/T5 会话）：

```
 M docs/harness/TEST-DATA-OWNERSHIP.md     <- 未触碰
 M lib/host/tools/lookup.mjs               <- 未触碰
 M lib/host/tools/shared.mjs               <- 未触碰
 M package.json                            <- 仅 test 脚本 1 行（见下）
 M src/host/tools/lookup.mjs               <- 未触碰
 M src/host/tools/shared.mjs               <- 未触碰
 M test/host.test.mjs                      <- 未触碰
```

**唯一交叉文件 `package.json`**：T4 加了 `files` 里的 `data`（其范围），
本卡只加了 `scripts.test` 里的 `node test/session-scope.test.mjs && `。
`git diff package.json` 逐行确认：`data` 行是 T4 的，session-scope 行是本卡的，
**两个改动互不覆盖**。

---

## 5. 改动后的因果链（对照第 3 节）

```
dnd_* 写工具 execute(args, exec)        // exec: ToolRunContext
  -> sessionOf(ctx, exec)               // exec.agent.id -> ctx.sessions.get(id) -> Session
  -> sandboxPolicy.resolve({ session }) // ↑ 修复点：resolve 拿到 session
  -> { mode: <会话模式>, workspaceRoot: session.header.cwd = D:/DND, sessionId }
  -> writeCharacter(..., { sandboxPolicy })
  -> fs.writeText(target, content, undefined, undefined, sandboxPolicy)
  -> checkedTarget(target, sandboxPolicy)   // dsh-fs-sandbox:153 —— 不再走无参分支
  -> isPathUnder("D:/DND/campaigns/...", "D:/DND") === true
  -> WRITE SUCCEEDS
```

降级路径（无 session）：`sandboxPolicy = undefined` → `writeText` 与出厂调用**逐字节相同**
→ 平台退回 `this.workspaceRoot`（进程 cwd）→ 与修复前行为一致，**不放宽**。

---

## 6. 真机验证（✅ 已完成，2026-09-20 用户重启后复验）

**本卡执行者按硬约束 4 未自行重启**；用户重启 DSH 后，在真机进程内完成下列复验。

### 6.1 修复确已加载（重启前的阻塞原因）

重启**前**实测：进程启动时间早于 `lib/` 构建时间，内存中仍是旧代码 ——
这正是当时 `dnd_track` 仍报 `FS_SANDBOX_DENIED` 的原因（代码已修，但未加载）。

| 项 | 重启前 | 重启后 |
|---|---|---|
| 服务的 node 进程启动 | `09/18 15:12` / `09/20 10:09` | `09/20 10:12:15` / `10:13:02` |
| 我构建的 `lib/` mtime | `09/20 10:01:01` | 同（未再改动） |
| 进程是否晚于构建 | ❌ 否 → 仍加载旧代码 | ✅ 是 → 已加载修复 |

```
$ Select-String -Path lib\host\tools\state-io.mjs -Pattern 'sandboxPolicy\)'
await fs.writeText(await fs.resolve(statePath(dir, name)), stateText, undefined, undefined, sandboxPolicy)
await fs.writeText(await fs.resolve(sheetPath(dir, name)), sheetText, undefined, undefined, sandboxPolicy)
```

### 6.2 三个写工具全部实测成功

**战役**：`retest-alice`（活跃战役；**未使用 `morgansfort`**）。

```
$ dnd_track hp="-1" character="alice" key="t2-live-confirm-after-restart-2"
OK: alice (T2 live confirmation)
  HP 8 -> 7 HP now 7/8.

$ dnd_spend amount="1 cp" character="alice" key="t2-spend-confirm-1"
OK: Spent 1 cp (T2 live confirm). Purse: 8 gp -> 7 gp 9 sp 9 cp (7 gp 9 sp 9 cp).

$ dnd_xp_add amount="+25" character="alice" key="t2-xp-confirm-1"
OK: +25 XP (T2 live confirm). alice: 0 -> 25. 275 XP until level 2 (at 300).
```

**三者均不再抛 `FS_SANDBOX_DENIED`**（对照：修复前同样是
`dnd_spend amount="1 cp"` 报逐字相同的拒绝 —— 见 T1 结论文档 Q3 节）。

### 6.3 写确实落盘（不只是「没抛异常」）

写后**从磁盘重新读取**，并核对该次调用独有的幂等 key：

```
$ dnd_character_get            -> hitPoints.current = 7, max = 8
$ Select-String alice.state.json -Pattern 't2-live-confirm-after-restart-2'
"t2-live-confirm-after-restart-2"        <- 本卡这次调用的 key 确实写进了文件
```

文件 sha256 与 mtime 均随写入变化：

| 文件 | 写前 sha256 | 写后 sha256 | mtime |
|---|---|---|---|
| `retest-alice/characters/alice.md` | `109C048C…` | `8D06B5F7…` | `09/20 10:13:54` |
| `retest-alice/characters/alice.state.json` | `428AD562…` | `9E1A191C…` | `09/20 10:13:54` |

→ **写入真正改变了两份文件的字节**，而非仅返回成功文本。

### 6.4 真机确认：模态未被放宽、真实战役未被触碰

写入发生在 `D:\DND\campaigns\retest-alice\` —— 该路径**不在**进程 cwd
（`C:\Users\Ming`）之下。**若修复是靠放宽模态达成，这里的判定根本不会通过。**
实际通过，且全程无 `danger-full-access`。

`morgansfort`（真实战役）三次写操作**前后逐字节未变**：

```
alice.md          109C048CC33B04BF0AE96EA49E258071CD74EF7441E0E8D61A8CB42A2B6370DB   (= 基线)
alice.state.json  428AD562E3796747F935D2546BCA24B6103F50008C05BD623A216F8A09B4D105   (= 实测基线)
active-campaign   len=27 first3=239,187,191 sha256=276B1B6616986D6CA0414ACCEF0232E6550486E028398E0F799AD9C0D30F5DFB
```

### 6.5 真机验证边界（诚实标注）

- 本节验证的是**修复后**的行为。**修复前**的真机拒绝行为来自 T1 实测（`FS_SANDBOX_DENIED`），
  本卡未在重启前重复该场景的字节级对照（当时只能观测到拒绝，观测不到成功）。
- **降级路径（无 session）的真机行为未单独验证** —— 它由单元测试覆盖
  （`dnd_spend called WITHOUT exec passes no policy`）。真机上模型面工具恒带 agent，
  无法自然产生无 session 的调用。
- 写入测试**仅使用 `retest-alice`**，未使用 `stage2-test`，未使用 `morgansfort`。

---

## 7. 本卡明确未做（边界）

- **未**实现 T6（启动自检）、T7（错误信息可操作化）、T3（`character` 参数解析）、
  T8/T9/T10（三个能力缺口）—— 均超出 T2 范围。
- **未**修改 `scripts/write-tools-scenario.mjs` / `concurrency-scenario.mjs` 的既有失败断言
  （见 4.6，建议另立卡）。
- **未**改 `dsh-fs-sandbox` / `dsh-sandbox-policy`（在 `node_modules` 内，改了会被升级覆盖）。
- **未**重启 harness、**未**执行任何 git 写操作、**未**改 `profiles/web/`。