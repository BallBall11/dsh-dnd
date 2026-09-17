/**
 * Stage-0 smoke panel — proves the bundle load chain works end to end.
 *
 * Authored as a factory-body fragment, NOT an ES module. This file is pasted
 * inside `window.__ModuleLoader__.load({ id, factory })` by scripts/build.mjs,
 * so it may not use `export` / `import`. It ends by returning the module
 * exports, which build.mjs wires into the IIFE fragment table.
 *
 * Deliberately near-empty: one sidebar button and one overlay that says hello.
 * The ONLY question stage 0 answers is "does the loader register us and do our
 * slot registrations appear?". Business panels come after that is proven.
 *
 * Available in the factory scope:
 *   require  - the loader's frozen module table (react, react-dom, cordis, ...)
 *   module / exports - the classic CJS shim injected by build.mjs
 */

const React = require('react')

/**
 * The Host route namespace.
 *
 * Kept in sync with `src/host/routes.mjs` by construction rather than by
 * convention: `test/client-host-contract.test.mjs` parses both files and fails
 * if the two prefixes disagree, because a typo here would surface only as an
 * empty panel at runtime.
 */
const DND_API = '/dnd'

/** CSS is injected as a <style data-plugin> tag, never a bare global. */
const CSS = `
.dnd-smoke-action{display:inline-flex;align-items:center;gap:6px;background:none;border:none;
  color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:0 8px;border-radius:8px;
  white-space:nowrap;height:32px;line-height:1;box-sizing:border-box}
.dnd-smoke-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-smoke-overlay{position:fixed;right:16px;top:72px;width:300px;z-index:50;
  border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;font-size:13px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary);padding:14px}
.dnd-smoke-muted{opacity:.75;font-size:12px;margin-top:6px}
.dnd-smoke-row{margin-top:6px;font-variant-numeric:tabular-nums}
.dnd-smoke-error{margin-top:8px;font-size:12px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary)}
`

/**
 * Inject the stylesheet once per page, keyed by a stable attribute so a
 * hot-reload does not stack duplicate tags.
 * @returns the tag element, or undefined when there is no document.
 */
function ensureStyle() {
  if (typeof document === 'undefined') return undefined
  const existing = document.querySelector('style[data-plugin="dsh-dnd"]')
  if (existing !== null && existing !== undefined) return existing
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-dnd'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return tag
}

const OPEN = { value: false }

/** Tiny external store so the button and the overlay share one open flag. */
function useOpen() {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const listener = () => force((n) => n + 1)
    OPEN.listeners.add(listener)
    return () => { OPEN.listeners.delete(listener) }
  }, [])
  return OPEN.value
}
OPEN.listeners = new Set()
function setOpen(next) {
  OPEN.value = next
  for (const listener of OPEN.listeners) listener()
}

/**
 * Fetch the character list from the Host.
 *
 * A bundle talks to the Host over plain HTTP. It cannot use `host.call` /
 * `harness.handle`, because that path requires a pluginId and pluginRunId that
 * only exist for a plugin the dynamic runner is hosting — v0.1.0 built its
 * panel on `host.call` and it could never have worked.
 *
 * The URL is relative, so it resolves against the page origin and needs no
 * configuration. No credentials and no custom headers: the route is
 * same-origin, and the Host deliberately applies no CSRF or loopback fence of
 * its own (see docs/REWRITE-PLAN.md, "关于安全层").
 *
 * @returns `{ status, body }`; never throws, so a caller renders a message
 *   instead of an unhandled rejection in the middle of a render.
 */
async function fetchCharacters() {
  try {
    const res = await fetch(DND_API + '/characters', { cache: 'no-store' })
    const body = await res.json()
    return { status: res.status, body }
  } catch (error) {
    return { status: 0, body: { error: String(error && error.message ? error.message : error) } }
  }
}

/**
 * Load the character list once and keep it.
 *
 * Deliberately brute force for stage 3b: one fetch when the overlay first
 * opens. The point of this step is to prove the transport works at all; live
 * refresh, polling and per-character detail belong to 3c.
 */
function useCharacters(open) {
  const [state, setState] = React.useState({ phase: 'idle', status: 0, body: null })
  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setState({ phase: 'loading', status: 0, body: null })
    fetchCharacters().then((result) => {
      if (!cancelled) setState({ phase: 'done', status: result.status, body: result.body })
    })
    return () => { cancelled = true }
  }, [open])
  return state
}

/** The sidebar footer action: `sidebar.footer.action` is a list slot. */
function SmokeAction(props) {
  const wide = props !== null && props !== undefined && props.wide !== false
  return React.createElement('button', {
    type: 'button',
    className: 'dnd-smoke-action',
    title: 'D&D 状态',
    'aria-label': 'D&D 状态',
    onClick: () => setOpen(!OPEN.value),
  }, React.createElement('span', null, '⚔'), wide ? React.createElement('span', null, 'D&D') : null)
}

/**
 * Render the transport result.
 *
 * Every branch is a real outcome a DM might hit, and each one says something
 * actionable rather than showing an empty list: a 404 with an error message
 * means no campaign is loaded, a 503 means the Host lacks a filesystem, and a
 * status of 0 means the request never left the page.
 */
function renderLoad(state) {
  if (state.phase === 'loading') {
    return React.createElement('div', { className: 'dnd-smoke-muted' }, '读取中…')
  }
  if (state.phase !== 'done') return null

  if (state.status === 0) {
    return React.createElement('div', { className: 'dnd-smoke-error' },
      '请求失败：' + (state.body && state.body.error ? state.body.error : 'unknown'))
  }
  if (state.status !== 200) {
    return React.createElement('div', { className: 'dnd-smoke-error' },
      'HTTP ' + state.status + '：' + (state.body && state.body.error ? state.body.error : ''))
  }

  const characters = (state.body && state.body.characters) || []
  if (characters.length === 0) {
    return React.createElement('div', { className: 'dnd-smoke-muted' }, '活动战役没有角色')
  }

  return React.createElement('div', null,
    React.createElement('div', { className: 'dnd-smoke-muted' },
      '战役 ' + state.body.campaign + ' · ' + characters.length + ' 个角色'),
    ...characters.map((c) => React.createElement('div', { key: c.name, className: 'dnd-smoke-row' },
      React.createElement('strong', null, c.state && c.state.name ? c.state.name : c.name),
      c.display ? ' · HP ' + c.display.hp.current + '/' + c.display.hp.max : '',
      c.display && c.display.currency ? ' · ' + c.display.currency : '')),
    (state.body.warnings || []).length > 0
      ? React.createElement('div', { className: 'dnd-smoke-error' }, state.body.warnings.join('; '))
      : null)
}

/** The floating panel: `shell.overlay` is click-through, so we opt back in. */
function SmokeOverlay() {
  const open = useOpen()
  const state = useCharacters(open)
  if (!open) return null
  return React.createElement('div', {
    className: 'dnd-smoke-overlay',
    style: { pointerEvents: 'auto' },
  },
  React.createElement('strong', null, 'dsh-dnd 已加载'),
  React.createElement('div', { className: 'dnd-smoke-muted' }, '阶段 3b · 跨端通道验证'),
  renderLoad(state))
}

const PANELS = [
  { overlayId: 'dnd-smoke-overlay', actionId: 'dnd-smoke-action', order: 10 },
]

/**
 * Register the smoke panel into both slots.
 * @param ctx - the client context; `slots` is the only service used.
 */
function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ensureStyle()
  for (const panel of PANELS) {
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: panel.overlayId, order: 200 },
      () => React.createElement(SmokeOverlay, null)))
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: panel.actionId, order: panel.order },
      (props) => React.createElement(SmokeAction, props)))
  }
  // A fiber effect may be a function, nullish, or an iterable of disposers.
  // A bare object throws `Invalid effect` and unwinds everything above.
  return () => { /* fiber-owned effects unwind automatically */ }
}

return { apply, inject: ['slots'] }
