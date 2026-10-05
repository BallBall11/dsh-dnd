# GM 工具缺口实施计划（已逐项讨论定稿）

日期：2026-10-04
状态：**已实施并验证**（代码 + 测试完成，`npm run check` 全绿；`verify-client` 已覆盖敌人分区的无头渲染断言；宿主真实主题下的视觉效果确认仍需宿主重启后人工查看）

> P2 追加（2026-10-04）：`dnd_level_up`（升级建议器）已落地——规划/确认
> 两段式，职业表数值取自战役 ruleset 数据集，XP 门槛 + force 裁定，ASI 与
> 法术准备只报告不代填。P2 剩余：任务/势力追踪（需新数据模型，待实际跑团
> 痛点再设计）、Calendar 随机事件联动（依赖 tables.json 扩充）。
交付顺序：**项目 3 → 1 → 2 → 4 → 5 → 6**，每项完成后跑全量 `test/` 套件。

## 背景共识

- 工具的调用者是 DeepSeek harness 扮演 DM 的 agent，不是人肉 GM；工具要在一次调用里完成结算并返回可复述给玩家的明细。
- 玩家看 party panel，采用电子游戏式设计：敌人真实血量可见，供玩家构建策略。
- 现有写路径三原则（拒绝写不改、幂等 key、双时钟刷新）与"读不写/写不读"分层必须保持。

## 项目 3：攻击伤害落地（含现存规则缺口修复）

**新模块** `src/host/tools/apply-damage.mjs`（纯函数）：
- 落地链：伤害总量 → **tempHp 先吸收** → 余量进 HP → clamp 到 [0, max] → 0 HP 处理。
- 抗性（减半）/易伤（翻倍）在 host 侧计算，返回中显式列出修正过程。
- 敌人（kind 含 `enemy` 标签）0 HP：自动加 `dead` 条件并报告"已被击败"；死亡豁免仍只属 PC。
- PC 0 HP：保持现有 massive-damage 报告与死亡豁免提示，不自动代管。

**dnd_attack 扩展**（`roll.mjs`）：
- 新可选参数 `target`（角色名）、`resistance`、`vulnerability`（逗号分隔伤害类型）。
- 给了 `target` 且命中：掷骰后自动落地伤害（走 locateAndApply 写路径），一次调用完成"掷骰+落血"；未命中不落。
- 未给 `target`：保持现有纯掷骰行为，零变化。
- `key` 参数沿用幂等键机制（重复调用不重复扣血）。

**dnd_track 现存缺口回修**（`track.mjs`）：
- `hp` 为负伤害时先消耗 `combat.tempHp`，余量才进 `hp.current`；变更列表如实报告吸收过程。

**测试** `test/apply-damage.test.mjs`：未命中不落、抗性/易伤/双修、tempHp 先扣、0 HP 敌人标记 dead、PC 濒死提示、幂等重放、dnd_track tempHp 修复回归。

## 项目 1：dnd_rest（长休/短休）

**新模块** `src/host/tools/rest.mjs` + 纯函数 `rest-rules.mjs`；写入复用 track.mjs 的 `locateAndApply`（需导出或抽共享）。

- **短休**：自动掷 HD（host 骰子引擎），每颗恢复 = 骰值 + CON 调整值（下限 1），clamp 到 max；`hitDice: "2"` 或 `"2d8"` 指定颗数，HD 不足 refuse 并报剩余量。
- **长休**（跟随战役 ruleset）：
  - 2014：回血 min(一半 max, 缺口)；2024：回满。
  - 共同：法术位 `used` 全清 0、HD 回 `ceil(total/2)`、死亡豁免 tally 清零。
  - conditions **不动**，只在返回中报告"当前条件仍在，是否解除由 DM 决定"。
  - encounter 效果**不代清**（跨存储无原子性），返回中列出该角色 running 的效果并提示用 `dnd_effect` 处理。
- **`party: true`**：批量结算全部 PC，每角色独立锁 + 独立幂等 key（键内嵌角色名），部分失败逐一报告成功/失败清单。
- **v1 多骰型（兼职）HD 拒绝**：schema 只有 `combat.hitDice.{die, remaining}` 单骰型；遇多骰型提示无法精确结算。

**测试** `test/rest-rules.test.mjs`：HD 不足、CON 负调整下限 1、2014/2024 双规则、法术位/HD/死亡豁免重置、幂等重放、party 批量部分失败、多骰型拒绝。

## 项目 2：敌人/NPC 面板

**路由**（`src/host/routes.mjs`）：
- `GET /dnd/characters` 加 `?include=enemies`；默认仍只回 PC（现有面板行为不变）。
- host 侧预格式化敌人卡：名称、真实 HP/最大 HP、AC、状态效果列表；不含钱币/法术位/装备明细。

**面板**（`src/client/panels/character.js`）：
- PC 列表下方加"敌人"分区，显示真实血量（电子游戏式策略体验），默认展开。
- 复用 264px 分栏、宿主主题 token、≤820px 对称边距方案；面板零自算。

**测试**：`test/routes.test.mjs` 扩展（include=enemies 过滤与预格式化）；浏览器验证参照 `TASK2-BROWSER-VERIFICATION.md` 流程。

## 项目 4：dnd_enemy_create（SRD 敌人卡生成）

**架构决策**：敌人与 PC **数据模型共用**（同 `characters/` 目录、同写入路径、同 schema、`kind: 'enemy'` 标签），**工具入口分开**（PC 从职业表推导，怪物从 SRD statblock 整卡落地——填卡方式本质不同）。

**新模块** `src/host/tools/enemy-create.mjs`：
- `fromSrd: "goblin"`：查 `srd-2024.json`（跟随战役 ruleset）自动填 AC/HP/速度/六维/CR/熟练。
- `count: 3`：自动命名 `Goblin-1`、`Goblin-2`、`Goblin-3`（`namePrefix` 可覆盖前缀）。
- `hpOverride`：覆盖 SRD 平均值（可传表达式掷骰）。
- 攻击描述（multiattack、攻击骰/伤害）是散文，存 `.md` 叙事段（解析器 verbatim 保留）；`state.json` 只存数字，**不动 schema**。
- 未知名：报错并列出数据集中可用的怪物名。

**测试** `test/enemy-create.test.mjs`：SRD 未知名、count 命名、override 优先、ruleset 映射、写入校验。

## 项目 5：遭遇难度计算 + loot 表

**新模块** `src/host/tools/encounter.mjs`：
- `dnd_encounter_difficulty({ party, enemies: [{ name, cr, count? }] })`。
- 标准 XP 阶梯：原始 XP 合计 × 数量系数 → 四档难度（简单/中等/困难/致命）。
- 角色等级从角色卡读取（缺卡报错点名）；纯计算、无写入、无新持久化。

**loot 定量表**：`data/tables.json`（带 `_meta` 标注来源与许可），按 CR 档位的精简金币/物品数量表，随 encounter 模块交付。

**测试** `test/encounter.test.mjs`：SRD 官方示例数值对拍；表结构合法（数量为正、CR 档位覆盖）。

## 项目 6：dnd_note 会话日志

**新模块** `src/host/tools/note.mjs`（第二个写工具族）：
- `dnd_note({ kind: "loot"|"hook"|"recap"|"freeform", body, reason? })`。
- **存储**：以 `## <世界时钟时刻> — <kind>` 标题追加进战役目录已有 `session-log.md`（该文件已在 `dnd_campaign_search` 语料内，搜索零改动）。
- **写入**：fs 无 append，实现为"读-改-写整文件"，配 per-campaign promise-chain 锁（模式同 `withCharacterLock`，键为战役文件）+ `sandboxPolicy` 会话作用域 + 双时钟。
- **防重复**：内容指纹去重——写入前检查文件末尾是否已有完全相同的一段（同 kind + 同 body），相同则报"已写入过"；不引入 sidecar 状态文件。
- **v1 不动 state.md**：返回文本提示 agent 自行决定是否更新 Active Quests / Open Threads 小节。

**测试** `test/note.test.mjs`：原子写（读改写）、目录无文件时创建、指纹去重、搜索命中、kind 校验、test-data 隔离。

## 共性约束（全部项目适用）

1. 不 commit / tag / push；不写真实战役 `morgansfort`（测试一律用 test-data，遵守 TEST-DATA-OWNERSHIP.md）。
2. 写路径全部走会话作用域（`session-scope.mjs`）+ 幂等/去重 + 双时钟刷新。
3. 面板只读、host 预格式化、宿主主题 token、无静默回退、fail-loud。
4. 每项独立可交付：独立模块 + 测试套件；项目 3 的 `apply-damage.mjs` 纯函数需先于项目 1 合入（rest 不依赖它，但 track 修复是共享前提）。

## 收尾

- `cordis.patch.yml`：注册新工具族 + 更新 GM preset 工具指引。
- `CHANGELOG.md`：[Unreleased] 记录全部六项。
- `docs/REWRITE-PLAN.md`：勾选对应阶段项。
- 全量 `test/` 通过。
