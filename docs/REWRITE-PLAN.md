# dsh-dnd 重写方案：功能清单与实施计划

> 状态：**规划完成，未改代码。**
> 范围：**只重写 `dsh-dnd` 插件**（Host 工具族 + Client 面板）。
> 不改 `.agents/skills/dnd/`（那是已安装的 skill，`D:\DND\AGENTS.md` 明令不动）。
> 前置阅读：`docs/BUNDLE-COMPAT-AUDIT.md`（三缺陷诊断，本方案是它的执行版）。

---

## 0. 一句话定位

`dsh-dnd` 是 D&D skill 的**原生加速层**，不是替代品：

| 层 | 谁 | 职责 |
|---|---|---|
| **权威层** | `.agents/skills/dnd/scripts/*.py` | 全部持久化状态、掷骰仪式、display companion、完整规则书 |
| **加速层** | `dsh-dnd` 插件 | 高频、只读或小写入的表上操作，省掉一次 shell 往返 |

判据很简单：**能纯函数算出来的、或者读一个 markdown 字段就能答的，归插件；需要写复杂状态、需要展示、需要联网的，归脚本。**

---

## 1. 现状评估（为什么"另起炉灶"是对的）

现有实现不是"有几个 bug"，而是**三个层面的系统性错误**：

### 1.1 Client 半完全不成立（审计缺陷 A/B/C）

| 缺陷 | 事实 | 证据 |
|---|---|---|
| A | `lib/client.js` 是普通 ESM，bundle 必须是闭包工厂 | `shared/tsdown.client.ts:376-378` |
| B | 源码用 `React`/`styles`/`host` 三个裸全局，那是动态插件专属 | Client `Builtin.listBuiltins` |
| C | `host.call`/`harness.handle` 强制要 `pluginId`+`pluginRunId`，bundle 没有 | `dsh-cordis-client-runner/lib/client.js:5072` |

**后果**：角色面板从未工作过。底边栏那个 ⚔ 按钮不存在，不是"少了一行"。

### 1.2 Host 半功能性不足

10 个工具，但覆盖面窄且和脚本重复度高：

- `dnd_roll` / `dnd_check` / `dnd_attack` / `dnd_save` —— 纯计算，**这部分是对的**，价值真实（省一次 `dice.py` 往返，且不必解析 stdout）
- `dnd_srd_lookup` —— 每次调用 `JSON.parse` 整个 SRD 文件（1453 条），无缓存
- `dnd_campaign_search` —— 命令行式全文件扫描，无索引
- `dnd_character_get` —— 解析器只认一种固定 markdown 排版，`spellSlots` 只抓第一个 `Nst` 行（多环阶法师直接丢数据）
- `dnd_xp_add` / `dnd_track` —— 直接改角色文件，**与 `xp.py` / `tracker.py` 争抢写入权**，是数据损坏来源

### 1.3 工程形态与参照仓库脱节

| 维度 | 现状 | 参照（`dsh-task-board`） |
|---|---|---|
| patch 行名 | `./lib/host/index.mjs` | 裸包名 `@linxin666/...` |
| 构建 | 手写 `copyFile`，无打包 | `tsdown` + `clientBundle()` 预设 |
| `dsh.client.inject` | `["slots"]`（服务名，错） | 包名数组 |
| 跨端 | `host.call`（不可用） | `webServer` 路由 + `fetch` |
| 测试 | 3 个手写脚本 | vitest 全套 |

**结论**：与其修，不如按参照仓库的正确形态重写。Host 的**纯计算工具逻辑可以保留**（那部分没问题），其余推倒。

---

## 2. 功能清单

按"归插件 / 归脚本"分组。★ = 新建，◆ = 重写，○ = 保留。

### 2.1 Host 工具（模型可调用）

#### A. 掷骰与判定 — 纯计算，零 IO ★核心价值

| 工具 | 说明 | 备注 |
|---|---|---|
| `dnd_roll` ○ | `NdM±X`，优势/劣势，`silent` | 逻辑已对，补 `kh/kl`（`4d6kh3`） |
| `dnd_check` ○ | d20+mod vs DC，nat20/nat1 | 已对 |
| `dnd_attack` ○ | 攻击 vs AC，暴击双骰 | 已对 |
| `dnd_save` ○ | 豁免 vs DC | 已对 |
| `dnd_mastery` ★ | 2024 武器精通 8 种特性查表 | 纯静态表，`combat.py mastery` 的原生版 |
| `dnd_dc` ★ | 技能→DC 常用档位、被动检定计算 | 表上高频，纯函数 |

#### B. 战役数据读取 — 只读，带缓存

| 工具 | 说明 | 备注 |
|---|---|---|
| `dnd_campaign_state` ○ | `state.md` 关键 section | 已对，补 section 列表 |
| `dnd_character_get` ◆ | 角色卡解析 | **重写解析器**，见 2.5 |
| `dnd_campaign_search` ◆ | 语料检索 | 加**进程内索引缓存**（mtime 失效） |
| `dnd_srd_lookup` ◆ | SRD 查询 | 加**按 ruleset 的模块级缓存**（现每次 parse 全文件） |
| `dnd_graph_context` ★ | 读 `graph.json`，场景子图 | `/dm:dnd graph scene-context` 的原生版 |
| `dnd_recap` ★ | 读 `.recap/*.json` 做状态 diff | `session_recap.py diff --json` 的只读镜像 |
| `dnd_arc_status` ★ | 读 `## Campaign Arc` 当前拍点 | 高频、结构固定 |

#### C. 小写入 — 必须与脚本互斥

| 工具 | 说明 | 风险控制 |
|---|---|---|
| `dnd_track` ◆ | HP/临时/激励/死亡豁免 | **加文件锁 + 写前重读**，见 2.6 |
| `dnd_xp_add` ◆ | CR→XP 写入 | 同上 |

> **决策点**：这两个工具与 `tracker.py` / `xp.py` 写同一批文件。方案见 §2.6。

#### D. 明确**不做**的（留给脚本）

`calendar.py`（世界时钟）、`oracle.py`、`import_campaign.py`、`sync_srd.py`、
`npc_rename.py`、`name_registry.py`、`corpus_check.py`、`display/*`（全部）。

理由：要么需要复杂状态机，要么需要网络，要么是低频一次性操作——插件化收益 < 维护成本。

### 2.2 Client 面板（可扩展注册表）

**保留注册表结构**（你要求的"后续可能添加其他面板"），首版只装角色面板。

| 面板 | 状态 | 数据源 |
|---|---|---|
| 角色面板 | v0.2.0 | `GET /dnd/characters` |
| 战役面板 | v0.3.0 预留 | `GET /dnd/situation` |
| 骰池/日志 | 暂不做 | —— |

**挂载点**（已核对 DSH 真实契约）：

| 槽 | 用途 | 契约 |
|---|---|---|
| `sidebar.footer.action` | ⚔ 角色 开关 | `kind: 'list'`，owner props `{ wide: boolean }` |
| `shell.overlay` | 浮动面板 | `kind: 'list'`，**点击穿透**，occupant 需自己开 `pointer-events` |

出处：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:69-73`、
`dsh-client-ui-layout/lib/types/client/index.d.ts:80-83`。

**明确不做**：皮肤/theme token 覆盖（你已要求去掉）。

### 2.3 跨端通道

```
Host:  ctx.webServer.register({ kind:'exact', path:'/dnd/characters', handler })
Client: fetch('/dnd/characters', { cache:'no-store' })
```

一条 `GET`，纯只读，无需 SSE。将来若要推送（战斗回合变化）再加 `EventSource`。

契约出处：`dsh-host-webserver/lib/types/index.d.ts:33-39`。

### 2.4 构建与打包形态

| 项 | 目标 |
|---|---|
| patch 行 | `id: dnd` / `name: dsh-dnd`（裸包名） |
| `exports["."]` | `./lib/host/index.mjs`（node 半） |
| `exports["./client"]` | `./lib/client.js`（闭包工厂） |
| `dsh.bundle.patch` | `./cordis.patch.yml` |
| `dsh.client.inject` | **依赖包名**（非服务名） |
| 构建 | 手写 `build.mjs` 产出 banner/footer/intro 包裹（不引入 tsdown，保持无 TS） |

产出形态（严格对齐 `shared/tsdown.client.ts:376-378`）：

```js
window.__ModuleLoader__.load({ id: "dsh-dnd", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* module body */
return module.exports; } });
```

### 2.5 角色卡解析器重写（v0.2.0 重点）

现有 `parseCharacterSheet` 的问题：

1. `spellSlots` 只用 `/^\|\s*(\d+)st\s*\|/` 抓**一行** → 多环阶角色丢数据
2. `abilityScores` 只认 `| STR | DEX | ...` 单表头
3. 无 HP/AC 缺失时的容错，静默返回 `null`
4. 无 schema 版本，格式演进无法判断

目标：改为**按 section 分块 + 每块多策略**，返回 `{ version, warnings[], ...}`，
并在面板上显示 warnings（而不是静默错）。

### 2.6 写入互斥（必须解决）

`dnd_track` 和 `tracker.py` 会写同一批 `.md` 文件。方案：

- **读-改-写加锁**：进程内 per-file mutex
- **写前重读**：拿到锁后重新读，不用陈旧文本（现有实现用 `readText` 的快照改，有丢更新窗口）
- **幂等校验**：写后重读确认目标字段已变
- **可选**：写前比对 mtime，若在锁等待期间被外部改过，放弃并要求重试

---

## 3. 实施计划

四个阶段，每阶段**独立可验收**，失败不阻塞后续。

### 阶段 0 —— 骨架与契约验证（不写业务逻辑）

**目标**：先证明"能装、能启动、能被浏览器加载"，再写功能。

1. 新建目录结构（保留 git 历史，`git mv` 而非新建仓库）：
   ```
   src/host/index.mjs        coordinator（单行入口）
   src/host/tools/*.mjs      每个 domain 一个
   src/host/routes.mjs       webServer 路由
   src/client/index.js       client 入口（闭包工厂形态）
   src/client/panels/*.js    面板注册表
   ```
2. `scripts/build.mjs` 改为产出 banner/footer/intro 包裹
3. `package.json` / `cordis.patch.yml` 改为参照形态
4. **Client 只放一个最小面板**：一个按钮 + 一个显示 `Hello` 的 overlay

**验收**（唯一有效验证 = 真机）：
- `dsh plugin --profile web add link:D:/DND/dsh-dnd-bundle`
- 启动 → 页面无 `__ModuleLoader__` 报错
- `Slots.listSubTree` 查 `sidebar.footer.action` occupant **包含 `dnd-*`**
- 点按钮，overlay 出现

> 这一步是硬门槛。**在它通过前不写任何业务逻辑**——上次的失败就是先写了一堆功能再发现加载不了。

### 阶段 1 —— Host 只读工具族

1. 迁移纯计算工具（`dnd_roll`/`check`/`attack`/`save`），逻辑照搬（已验证正确）
2. 新增 `dnd_mastery` / `dnd_dc`
3. 重写 `dnd_srd_lookup`（加缓存）、`dnd_campaign_search`（加索引）
4. 重写 `parseCharacterSheet`（§2.5）
5. 新增 `dnd_graph_context` / `dnd_recap` / `dnd_arc_status`

**验收**：`node test/coordinator-check.mjs` 工具数正确 + 每个工具有单测。
**重点**：`parseCharacterSheet` 对新旧两种排版都要过。

### 阶段 2 —— 跨端通道 + 角色面板

1. `src/host/routes.mjs`：`GET /dnd/characters` 返回
   `{ campaign, situation, characters[], warnings[] }`
2. 路由注册用 `ctx.inject(['webServer'], ...)` + `ctx.effect()` 归属 fiber
3. Client 用 `fetch`，去掉所有 `host.call`
4. 面板渲染：HP 条 / 六维 / 技能 / 攻击 / 法术位 / warnings

**验收**：面板显示 morgansfort 的 alice 真实数据（HP 8/8, AC 12, INT 16, 法术位 1 环）。

### 阶段 3 —— 小写入 + 发布

1. `dnd_track` / `dnd_xp_add` 按 §2.6 加锁重写
2. 与 `tracker.py` / `xp.py` 的互斥做回归测试
3. `npm run build` → 提交 → `v0.2.0`
4. README 更新安装指令

**验收**：E2E 在 `host-test` 上跑通，真实 `morgansfort/alice.md` 保持不动。

---

## 4. 验收标准（每阶段都要满足）

**通用**：
- [ ] 页面无 `__ModuleLoader__` / `Invalid effect` 报错
- [ ] `Slots.listSubTree` 能看到 dsh-dnd 的 occupant
- [ ] `apply` 返回函数/nullish/可迭代，**绝不返回裸对象**
- [ ] 无 `import()`、无 `process`/`Buffer`/`fs` 裸全局（Host 用 `ctx.get('fs')`）

**验证方法（重要）**：
> **动态 Cordis 插件无法验证 bundle。** 两者是不同契约（见审计 §6）。
> 唯一有效验证 = **真实安装 → 启动 → 查槽位 occupant + 面板数据**。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| Client 再次加载失败 | 阶段 0 先过关再往下；对照 `tsdown.client.ts:376-378` 逐字比对产出 |
| 面板显示错数据 | 解析器加 `warnings[]`，面板显式显示而非静默 |
| 写入丢更新 | §2.6 加锁 + 写前重读 |
| 与脚本行为不一致 | 脚本仍是权威；插件是加速层，不一致时以脚本为准并在警告中提示 |
| 破坏真实战役数据 | 全部测试在 `host-test`；`morgansfort/alice.md` 只读 |
| profile 装不上 | `link:` 模式先验证；发布走 registry 需要 `npm publish` |

---

## 6. git 策略

当前状态：HEAD = `7be8adc`（`v0.1.0`，**带 bug**），工作区有 5 个 M + 4 个 ??。

```
v0.1.0  7be8adc  当前 HEAD，Client 加载失败
   ↓  本次重写
v0.2.0           阶段 0-2 完成（Client 可用 + 只读工具 + 面板）
v0.3.0           阶段 3 完成（小写入 + 发布）
```

- 阶段 0 完成 → 提交（**不打包**，只证明能加载）
- 阶段 2 完成 → 打 `v0.2.0`
- 阶段 3 完成 → 打 `v0.3.0`
- `lib/` 继续入库（`link:` 安装需要，免构建）

---

## 7. 待你确认

1. **§2.1C 的写入工具**：`dnd_track` / `dnd_xp_add` 要不要保留？
   - 保留 = 表上更快，但需处理与 `tracker.py` / `xp.py` 的互斥
   - 去掉 = 零风险，但每次改 HP 都要走一次 shell
   - **我的建议：保留，按 §2.6 加锁。**

2. **构建方式**：继续手写 `build.mjs`（零依赖），还是引入 `tsdown`（对齐参照仓库，但要加 TS 工具链）？
   - **我的建议：手写。** 代码是纯 JS，没有 TS/JSX/CSS Modules，`tsdown` 的价值都在我们不需要的地方。

3. **阶段 0 的门槛**：同意"加载不通过就不写业务逻辑"吗？
