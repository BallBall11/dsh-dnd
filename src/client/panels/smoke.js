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

/** CSS is injected as a <style data-plugin> tag, never a bare global. */
const CSS = `
.dnd-smoke-action{display:inline-flex;align-items:center;gap:6px;background:none;border:none;
  color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:0 8px;border-radius:8px;
  white-space:nowrap;height:32px;line-height:1;box-sizing:border-box}
.dnd-smoke-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-smoke-overlay{position:fixed;right:16px;top:72px;width:260px;z-index:50;
  border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;font-size:13px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary);padding:14px}
.dnd-smoke-muted{opacity:.75;font-size:12px;margin-top:6px}
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

/** The floating panel: `shell.overlay` is click-through, so we opt back in. */
function SmokeOverlay() {
  const open = useOpen()
  if (!open) return null
  return React.createElement('div', {
    className: 'dnd-smoke-overlay',
    style: { pointerEvents: 'auto' },
  },
  React.createElement('strong', null, 'dsh-dnd 已加载'),
  React.createElement('div', { className: 'dnd-smoke-muted' }, '阶段 0 · 加载链路验证'),
  React.createElement('div', { className: 'dnd-smoke-muted' }, 'React ' + (React.version || '?')))
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
