window.__ModuleLoader__.load({ id: "dsh-dnd", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __frag_panels_smoke = (function () {
 

const React = require('react')

 
const DND_API = '/dnd'

 
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

 
async function fetchCharacters() {
  try {
    const res = await fetch(DND_API + '/characters', { cache: 'no-store' })
    const body = await res.json()
    return { status: res.status, body }
  } catch (error) {
    return { status: 0, body: { error: String(error && error.message ? error.message : error) } }
  }
}

 
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
   
   
  return () => {   }
}

return { apply, inject: ['slots'] }

})();

 

 
const panelModules = [
  __frag_panels_smoke,
]

 
const inject = ['slots']

 
function apply(ctx) {
  for (const panel of panelModules) {
    if (panel === undefined || typeof panel.apply !== 'function') continue
    panel.apply(ctx)
  }
   
  return () => {   }
}

return { apply, inject }

return module.exports; } });
