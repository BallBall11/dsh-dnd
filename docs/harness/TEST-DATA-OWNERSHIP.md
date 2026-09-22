# 测试与数据的所有权规则

> 用途：让「测试读活战役数据」这一类缺陷不再复发。每个新写测试的人在动手前读这一节。
> 背景缺陷：`test/*.test.mjs` 直接读 `campaigns/morgansfort/characters/alice.md`。
> 插件随后**合法地**迁移了那个角色，5 个套件同时变红 —— 不是代码回归，是测试的输入变了形状。
> 强制手段：`npm run test:ownership`（`scripts/audit-test-ownership.mjs`），已接入 `npm run check`。

---

## 一、核心区分：解析器测试 vs 不变量测试

一个测试要么在问「代码读得对不对」，要么在问「代码守不守规矩」。两者对输入的**所有权**要求相反。

| | 解析器测试（parser test） | 不变量测试（invariant test） |
|---|---|---|
| 问的问题 | 这个格式，代码读得对吗？ | 无论数据是什么，这个承诺成立吗？ |
| 例子 | `sheet-parse`、`sheet-split`、`frontmatter` | 「读取永不写入」「写入幂等」「并发不丢更新」 |
| 输入归属 | **必须自己拥有** | 可以读活数据 |
| 输入来源 | `test/fixtures/`（冻结 fixture） | 活战役目录，或 `campaigns/stage2-test/` |
| 断言形式 | 可以断言**具体值**（`INT === 17`） | **只能断言性质**，禁止快照 |

一句话判据：

> **测试若断言「这个值是多少」，它就必须自己拥有这份数据。**
> **测试若断言「这个性质成立」，它可以读活数据 —— 但只能断言性质。**

### 为什么不能混

活数据是**会被合法修改**的。ANY 测试只要对活数据断言了具体值，就把「战役内容」
偷偷变成了验收条件 —— 于是改战役（迁移、升级、掉血、花金币）就等于「弄坏测试」。

失败时的症状极具误导性：5 个套件变红，看起来像解析器崩了，实际代码一行没错。
这正是本轮要根除的东西。

---

## 二、规则 1：解析器测试必须读自己拥有的冻结输入

```js
// ✅ 正确：读提交进仓库的冻结 fixture
const REAL_SHEET = new URL('./fixtures/alice-unmigrated.md', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')   // Windows：去掉 /D:/ 的前导斜杠

// ❌ 错误：读活战役文件 —— 插件一迁移它就变形状
const REAL_SHEET = 'D:/DND/campaigns/morgansfort/characters/alice.md'
```

### fixture 的硬性要求

1. **提交进仓库**，放在 `test/fixtures/`。
2. **用摘要钉死**。`sheet-parse` / `sheet-split` 都断言 `FIXTURE_SHA256`：
   ```js
   const FIXTURE_SHA256 = '91a90f003c8166997765dfd2e82c4ae6cd0040ae465dfc681919c38ef6aa6688'
   ```
   能被随意编辑成「当前代码恰好接受的样子」的东西不是 fixture，是镜子。
   钉住摘要让任何改动都成为一次**显式行为**。
3. **缺失时失败，不许跳过**。原来的 `else { console.log('skip ...') }` 会让整块
   真实 sheet 断言静默不跑、套件仍然全绿 —— 这正是「`| Slot |` 表头写错却全绿」的形状。
   现在缺 fixture 直接 `failures += 1`。
4. **来源必须是真实数据**。fixture 若由代码的假设生成，就抓不到错误假设。
   `alice-unmigrated.md` 是迁移前的**真实** sheet 的逐字节副本。

#### 当前 fixture 清单

| fixture | 摘要 | 来源 | 使用者 |
|---|---|---|---|
| `test/fixtures/alice-unmigrated.md` | `91a90f00…6688` | `morgansfort/alice.md` 迁移前的真实内容 | `sheet-parse.test.mjs`、`sheet-split.test.mjs` |

---

## 三、规则 2：不变量测试可以读活数据，但只能断言性质

不变量测试**必须**读活数据：承诺要对**所有**数据形状成立，只看临时目录证明不了。
但它禁止断言快照。

### 允许的断言（性质）

```js
// ✅ 「这次运行没有改变真实战役」—— 对整个目录做哈希前后比对
const before = snapshotTree(LIVE_CHAR_DIR)
await readAllCharacters(fs, LIVE_CHAR_DIR)
const changes = diffTree(before, snapshotTree(LIVE_CHAR_DIR))
assert.deepEqual(changes, [], 'reading must not write: ' + changes.join('; '))

// ✅ 「标志与文件互为反面」—— 规则，不是某个角色的当前状态
assert.equal(c.hasStateFile, !c.needsMigration)

// ✅ 「两次读结果相同」—— 自洽性，不涉及具体值
assert.deepEqual(second.state, first.state)
```

### 禁止的断言（快照）

```js
// ❌ 战役状态快照 —— 角色一升级、一掉血就变红
assert.equal(c.state.identity.class, 'Wizard')
assert.deepEqual(c.state.combat.hp, { current: 8, max: 8 })
assert.equal(c.state.currency, 800)

// ❌ 迁移状态快照 —— 迁移是合法操作，这个代理条件必然过期
assert.equal(c.needsMigration, true)
assert.equal(existsSync(stateFile), false)
```

### 判据

> 如果这个断言会因为「DM 在正常跑团中做了一件完全合法的事」而变红，
> 它就是一个快照，必须改写。

### 为什么哈希整个目录，而不是盯两个文件

`campaigns/morgansfort/characters/` 是插件**自己会重写**的目录，因此它是
「本次运行写了没有」最诚实的证人。哈希整个目录：

- 对**任何**合法变更免疫（迁移、改名、改数字都不改变「没人写」这个事实）；
- 比只盯 alice 的两个文件**严格更强**（写到别的角色的散逸写入也会被抓到）。

---

## 四、规则 3：临时战役自建自用，绝不写入活战役

需要**写入**的测试自建目录，并在 `finally` 里恢复。

| 手法 | 位置 | 说明 |
|---|---|---|
| `mkdtempSync(tmpdir(), …)` | `state-io.test.mjs`、`routes.test.mjs` | 真磁盘、真 I/O，测完即删 |
| 前缀重映射 | `host.test.mjs`、`routes.test.mjs` | 把 `D:/DND/campaigns` 映到临时树，**保留生产路径形状** |
| `campaigns/stage2-test` | `write-tools-scenario.mjs`、`concurrency-scenario.mjs` | 可抛弃的写入沙盒 |
| `writeText` 直接抛异常 | `migrate-real-dryrun.mjs` | 让脚本**不可能**误写 |

### 两个必须记住的坑

**1. 代码根 ≠ 数据根**（见 `src/host/tools/shared.mjs`）

- `DND_ROOT = D:/DND` —— 数据根，**战役数据**在这里，测试必须重映射。
- `DATA_ROOT = <包目录>/data` —— 插件**自带的只读数据**，**SRD 数据集**在这里。
  由 `import.meta.url` 解析（`src/host/tools/shared.mjs`），不再依赖任何配置根。

  > 历史：这两个数据集原先放在 `D:/DND/.agents/skills/dnd/data/`，即已安装 skill 的代码根。
  > 该 skill 被**用户故意删除**后，`dnd_srd_lookup` 开始报「dataset not found」。
  > 根因不是路径写错，而是**归属错位**：随插件发布的查询表是插件的依赖，
  > 应当随包走，而不是放在战役工作区里、被任何一次清理带走。
  > 现已移入 `dsh-dnd-bundle/data/`。

SRD 数据集是随插件发布的只读参考数据，`dnd_srd_lookup` 是纯查询，输出不受
`campaigns/` 影响。它的路径**必须豁免重映射**，否则测的是副本而不是发布的工件。

**2. `stat`/`listDir` 收 FsTarget，不收路径字符串**

mock 若比真实后端更宽松，就永远不会失败 —— 本项目已经因此漏过两个 bug。
所以各套件的 mock 都**收到字符串就抛 TypeError**。

另：`node:fs` 与 `node:fs/promises` 不要混。`stat` 从 `node:fs/promises` 导入才有
`mtimeMs` 对象；从 `node:fs` 导入会抛 `ERR_INVALID_ARG_TYPE`，而一个宽泛的
`catch { return undefined }` 会把它伪装成「文件不存在」/「没有活跃战役」。

---

## 五、规则 4：新增活数据依赖必须显式分类

规则没人检查就会腐烂。`npm run test:ownership` 遍历**全部**
`test/*.test.mjs` 与 `scripts/*.mjs`，找出每一处活数据引用，并要求它已被分类：

- 文件用了共享助手 `test/support/live-data.mjs`，**或**
- 在审计脚本的 `ALLOWED` 表里有条目，且写明规则与理由。

未分类 → **直接失败**。这样新的活数据依赖不可能不经过一次「这属于哪条规则」的
判断就混进来。

审计还额外强制：

- 标为 `invariant` 的文件**必须**真的 import 助手（否则「不变量」只是口头声明）；
- 解析器套件不得出现任何指向活战役的路径构造；
- fixture 存在、摘要被钉、缺失时失败；
- 不变量测试的 live 代码块内**不得**出现战役快照值。

### 加一条新依赖时怎么做

1. 先判断：这是**解析器测试**还是**不变量测试**？
2. 解析器测试 → 建 fixture，钉摘要，别碰活数据。**不要**加 allowlist 条目。
3. 不变量测试 → 用 `test/support/live-data.mjs` 的 `snapshotTree`/`diffTree`/
   `liveWitness`，然后往 `ALLOWED` 加条目，并在 `reason` 里写清为什么。
4. 跑 `npm run test:ownership`。

---

## 六、共享助手 `test/support/live-data.mjs`

| 导出 | 用途 |
|---|---|
| `snapshotTree(dir)` | 递归快照目录：相对路径 → sha256 |
| `diffTree(before, after)` | 报告差异（`created:`/`modified:`/`deleted:`），全量 Map 比对会淹没真正变的那一条 |
| `liveWitness(path, label)` | 「这个路径这次动过没有」；`assertUnchanged()` 一行断言 |
| `hashLivePath(p)` / `liveBytes(p)` | 单文件摘要 / 字节，缺失返回 `null`，**永不抛** |
| `liveExists(p)` | 路径是否存在 |
| `LIVE_CAMPAIGN` / `LIVE_MARKER` | 活战役目录 / 活跃标记的规范常量 |

全部**只读**：这个模块在构造上就无法写入活数据。

---

## 七、验收：可证伪

规则必须能被证伪，否则只是愿望。

**1. 检测器真的抓得住写入**

```
$ node -e "…snapshot, tamper, diff…"
detected: [ "created: stray.tmp", "modified: alice.state.json" ]
clean after restore: []
```

**2. 审计真的抓得住回归**（往解析器套件注入活数据依赖）

```
FAIL unclassified live-data reference(s):
FAIL test/state-rules.test.mjs does not reach into live campaign data
     — a parser test must own its input (use test/fixtures/)
```

**3. 活战役改名后 `npm run check` 仍然全绿**

本轮判据：任何对 `campaigns/morgansfort/` 的**合法**变更都不应让测试变红。
验证方式（临时改名，跑完改回）：

```powershell
Rename-Item D:\DND\campaigns\morgansfort\characters\alice.state.json alice.state.json.hidden
npm run check          # 必须全绿
Rename-Item D:\DND\campaigns\morgansfort\characters\alice.state.json.hidden alice.state.json
```

结论见本轮交付说明。**注意**：`alice.state.json` 被移走后，角色变成「未迁移」态 ——
它仍然合法（`sheets` + 派生状态），这正是要证明的：形状变了，测试不变红。

---

## 八、速查

- 我断言了**具体值**？ → 我必须**拥有**这份数据（fixture / 临时目录）。
- 我读的是活数据？ → 我只能断言**性质**（没变、自洽、规则成立）。
- 我要**写入**？ → 自建临时目录，`finally` 恢复，并在最后哈希活战役证明没碰它。
- 我加了活数据依赖？ → 跑 `npm run test:ownership`，它会逼我分类。

> 判据一句话：**合法地改动 `campaigns/morgansfort/`，测试必须仍然全绿。**
