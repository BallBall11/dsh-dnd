# dsh-dnd bundle 兼容性审计与修复方案

> 状态：**诊断完成，未改代码**（按用户要求选 C）。
> 结论：现有 bundle 的 **Client 半与跨端数据通道整体不成立**，不是补丁级问题。
> 参照实现：`D:\Code\dsh-web`（第三方插件仓库，`dsh-task-board` / `dsh-tool-describe-image` / `scripts/plugin-template`）。

---

## 1. 现象

安装后启动 web profile，浏览器报：

```
Failed to load plugins
failed to import loader entry 3e4ffd72 (@deepseek-ai/dsh-client-hmr):
client-modules: bundle /plugins/??...,dsh-dnd/client.js&rev=... loaded
without registering "dsh-dnd" via __ModuleLoader__.load
```

页面表现：侧边栏底部只有「任务管理」和空白终端（那两个属于 `cordis-panel` 等其他插件），
**没有 dsh-dnd 的任何 UI**。

槽位实测（`Slots.listSubTree`）：

| 槽 | occupant | 是否 dsh-dnd |
|---|---|---|
| `sidebar.footer.action` | `cordis-panel` | ❌ |
| `shell.overlay` | `[]`（空） | ❌ |

---

## 2. 三个独立缺陷

### 缺陷 A — Client 文件形态错误（直接导致上面的报错）

bundle 的 client 文件必须是 **closure-factory 产物**：

```js
window.__ModuleLoader__.load({
  id: "dsh-dnd",                                  // 必须等于包名 / 图行 id
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /* ... 模块体 ... */
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

来源：`shared/tsdown.client.ts:376-378`（`banner` / `footer` / `intro`），
契约见 `dsh-client-modules/lib/types/client/manifest.d.ts:147-157`：

> `id`: Plugin id (package name) — the registration key; **must match the graph row being executed**.

而 `lib/client.js` 目前是**普通 ESM**（`export const name` / `export function apply`），
从不调用 `__ModuleLoader__.load` → 加载器判「loaded without registering」。

> 注意：这是 **ESM 与 cloasure-factory 的格式差异**，与动态插件的 module form 无关。
> 我在 `src/client/panel.js` 里保留 `export const name` / `export function apply`
> 是**动态插件**的正确形态，但对 bundle **不适用**。

### 缺陷 B — 源码依赖动态插件专属全局

`src/client/panel.js` 使用三个**裸全局**：`React`、`styles`、`host`。

它们确实存在于 Client 的 `Builtin.listBuiltins`：

| builtin | 签名 |
|---|---|
| `React` | `React.createElement(...)` / `useState` / `useEffect` |
| `styles` | `styles.insert(css: string): () => void` |
| `host` | `host.call(method, args?): Promise<JsonValue>` |

**但只存在于动态 Cordis 插件的 eval 沙箱**（由 Client Guard 注入）。
bundle factory 里**没有这些全局**。参照实现里：

- React → `require('react')`（`noExternal` 决定哪些走 module table）
- CSS → 构建期内联 `<style data-plugin="<id>">`（`tsdown.client.ts:314-367`），
  或运行时 `document.createElement('style')`（`dsh-client-ui-jobs/lib/client.js:9-14`）
- 服务 → `ctx.get('...')` / 声明 `inject`

### 缺陷 C — 跨端通道选型错误（最根本）

`host.call` / `harness.handle` 这套 Package-private RPC **只有动态插件能用**。
证据 `dsh-cordis-client-runner/lib/client.js:5072-5079`：

```js
invoke: async (pluginId, pluginRunId, method, args) =>
  ctx.remote.dynamicCordisRunner.invoke(pluginId, pluginRunId, method, args)
```

它**强制要求 `pluginId` + `pluginRunId`** —— 而 **bundle 两者都没有**。

后果：`src/host/dnd-sheet.mjs` 里

```js
if (typeof harness !== 'undefined' && harness.handle) { ... }
```

这个守卫在 bundle 中**静默跳过** → Host 端 `dnd.characters` 处理器**从未注册**；
面板的 `host.call('dnd.characters', {})` **永远不可能成功**。

**即：整条 Client↔Host 数据链路在这套设计下从未、也不可能工作。**

---

## 3. 参照实现给出的正确做法

### 3.1 Host 半：注册模型工具

用**真实服务** `ctx.tools.register(...)`（不是动态 `harness.registerTool`）：

```ts
// dsh-tool-describe-image/src/index.ts:200
ctx.tools.register(defineTool({ name, description, parameters, output, execute }))

// dsh-git-graph/src/index.ts:111-113（延迟注入 + effect 归属 fiber）
toolFiber = ctx.inject(['tools'], (toolCtx) => {
  toolCtx.effect(() => toolCtx.tools.register(buildWorktreeTool(ctx, service)), 'label')
})
```

→ 我们的 10 个 `dnd_*` 工具**注册方式本身没问题**（`ctx.get('tools').register`），
   只是 `harness.handle` 那段要删。

### 3.2 跨端通道：Host 注册 HTTP 路由，Client 用 fetch

**这是 bundle 唯一合法的跨端方案**，参照 `dsh-task-board`：

**Host 侧**（`src/index.ts:30` + `src/host-routes.ts`）：

```ts
export const inject = [..., 'webServer', ...]
// makeTaskBoardRoutes(service) 返回 WebRoute[]
for (const route of makeTaskBoardRoutes(service)) ctx.webServer.register(route)
```

**Client 侧**（`src/client/host-api.ts`）——纯 `fetch`：

```ts
async state() { return await this.request(`${PREFIX}/state`, { cache: 'no-store' }) }
async action(a) { return await this.request(`${PREFIX}/action`, { method:'POST', ... }) }
subscribe(l) { const es = new EventSource(`${PREFIX}/events`); ... }  // SSE push
```

> `typert` Remote namespace（`ctx.remote.<ns>`）是**另一条**路，但它依赖
> `TypertContribution` 的生成式产物（`z.ZodType` + `typeSymbol`，
> `dsh-typert-registry/lib/types/types.d.ts:1` 明写 "Pure generated-artifact"），
> 需要构建期 codegen。本仓库的两个第三方插件（`dsh-ssh` / `dsh-usage`）
> **都没有用 typert**。故**不建议**走这条路。

### 3.3 `cordis.patch.yml`：行名用**裸包名**，不是相对路径

模板（`scripts/plugin-template/cordis.patch.yml`）：

```yaml
- insert:
    - id: ui-__NAME__
      name: '@linxin666/dsh-client-ui-__NAME__'
```

`dsh-task-board` 同样是裸包名。注释说明：

> The row is a bare plugin by package name: **the node half (exports ".") runs in the host
> process**, and the `dsh.client` declaration makes the browser half (exports "./client")
> load in the web GUI.

→ 我们现在的 `name: ./lib/host/index.mjs` 是**非标准写法**。
   （注：它**确实**修好了 `multiple active Loader sources`，因为单行满足了
   "exactly one source" 规则；但改用裸包名更符合约定，且顺带解决多模块行的问题。）

### 3.4 `package.json` 的 `dsh.client.inject` 要填**依赖包名**

参照 `dsh-task-board`：

```json
"dsh": { "client": { "inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-api-remotes"
], "platform": "web" } }
```

我们目前是 `"inject": ["slots"]` —— **错**。这里填的是**包名**（图行依赖边），
不是服务名。

---

## 4. 修复方案（分三阶段，建议按序）

### 阶段 1：让 Client 半能加载（修 A + B）

1. 重写 `src/client/panel.js` 为 bundle 形态：
   - 去掉 `export`，改为赋值 `exports.apply` / `exports.inject`
   - `React` → `require('react')`
   - CSS 改为 factory 内注入 `<style data-plugin="dsh-dnd">`
   - `apply` **不能返回 `{}`**（见下方「额外修复」）
2. 改 `scripts/build.mjs`：为 client 产出加 banner/footer/intro 包裹
3. 改 `package.json`：`dsh.client.inject` 填包名 + `exports["./client"]` 已正确

**验收**：刷新页面，`Slots.listSubTree` 中 `sidebar.footer.action` 出现 dsh-dnd 条目。

### 阶段 2：接通数据通道（修 C）

1. `src/host/dnd-sheet.mjs`：删除 `harness.handle('dnd.characters')` 整段
2. 新建 `src/host/dnd-routes.mjs`：用 `webServer` 注册 `GET /dnd-dnd/characters`
   （返回与今日 `dnd.characters` **相同的 JSON**，含 campaign/situation/characters）
3. Host `inject` 增加 `'webServer'`（可选服务，用 `ctx.get('webServer')` 探测）
4. Client 改为 `fetch('/dnd-dnd/characters', { cache: 'no-store' })`

> 若只需静态读取、无需推送，**不需要 SSE**；task-board 用 SSE 是因为它有 Host 侧
> 后台任务要主动推。我们首版用纯 `fetch` 即可。

**验收**：面板显示 morgansfort 的 alice 数据（HP/AC/属性/技能/攻击/法术位）。

### 阶段 3：回归与发布

1. 重跑 `test/coordinator-check.mjs`（10 工具）+ `test/parse.test.mjs`
2. 真机安装验证（`link:` → 启动 → 槽位 occupant + 面板数据）
3. git 提交历史欠账（见下）

---

## 5. 额外修复：`return {}` 是 `Invalid effect`

`src/client/panel.js:186` 原为 `return {}`。Cordis fiber effect 只接受
**函数 / nullish / 可迭代对象**（`@deepseek-ai/cordis/src/fiber.ts:366-398`）：

```ts
const effect = runner.execute.call(this)
if (typeof effect === 'function') { ... }
else if (isNullable(effect)) { /* return */ }
else if (!isObject(effect)) throw new TypeError('Invalid effect')
else if ('then' in effect) { ... }
else if (Symbol.iterator in effect) { ... }
else if (Symbol.asyncIterator in effect) { ... }
else throw new TypeError('Invalid effect')   // ← 裸 {} 落这里
```

抛错会让整个 fiber 加载失败，**回滚该 `apply` 已收集的全部 effect**
（`styles.insert` + 两个 `slots.inject`）。

已改为返回 disposer 函数。**但注意**：这只是让 `apply` 合法，
**不解决缺陷 A**——文件仍旧不是 `__ModuleLoader__` 形态，仍会加载失败。

> 同一坑我在 Host 侧也踩过一次（`{ dispose() {} }`）。
> 正确习惯：**`apply` 不返回裸对象**；副作用交给 `ctx.effect()` 或保留服务返回的 disposer。

---

## 6. 架构层面的教训

**动态 Cordis 插件 ≠ 可安装 bundle。** 两者是**不同的运行时契约**：

| 维度 | 动态插件 | bundle |
|---|---|---|
| 代码来源 | 宿主进程内 eval | `/plugins/<id>/client.js` |
| Client 形态 | ESM (`export apply`) | `__ModuleLoader__.load({id, factory})` |
| React / styles / host | Guard 注入的全局 | `require` / 服务 / HTTP |
| 跨端 RPC | `harness.handle` + `host.call` | **不可用** → `webServer` 路由 + `fetch` |
| 工具注册 | `harness.registerTool(ctx, harness.defineTool(...))` | `ctx.tools.register(defineTool(...))` |
| `apply` 返回值 | 函数/nullish/可迭代 | 同左 |

我此前用**动态插件模式"验证"bundle**，方法论上就是错的：
动态插件走的是另一套契约，**无法证明 bundle 可用**。
唯一有效的验证是**真实安装 + 启动 + 检查槽位 occupant**。

---

## 7. 待办清单

- [ ] 阶段 1：Client 改为 `__ModuleLoader__` factory 形态 + build 脚本产出包裹
- [ ] 阶段 1：`React` 走 `require`，CSS 改为 factory 内 `<style>` 注入
- [ ] 阶段 1：`package.json` 的 `dsh.client.inject` 填依赖包名
- [ ] 阶段 2：删除 `harness.handle`，改 `webServer` 路由 + 客户端 `fetch`
- [ ] 阶段 3：重跑单测 + 真机安装验证（槽位 occupant + 面板数据）
- [ ] git：提交累积的三处修复（见 §8），打 `v0.1.1`

---

## 8. git 欠账（当前 HEAD 仍为带 bug 的 `v0.1.0`）

工作区已修但**未提交**：

1. **5 行 patch → 单行协调器**（`src/host/index.mjs` + `cordis.patch.yml` 重写 + `main` 指向）
   —— 修 `multiple active Loader sources` 启动失败
2. **`src/client/panel.js` 的 `return {}` → disposer 函数** —— 修 `Invalid effect`
3. 本次审计发现的三处新缺陷（A/B/C）**尚未开始修**

建议：阶段 1+2 完成后再一次性提交为 `v0.1.1`，避免把中间态入版本库。
