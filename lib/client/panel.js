/**
 * dnd panel — Client half (module form, no theme skin).
 *
 * Panel-oriented: a small registry of panels. Only the character panel is
 * shipped today; adding a panel = appending one { id, order, title, Action,
 * Overlay } entry (plus a Host data handler). No theme override is applied —
 * the dusk skin was removed deliberately.
 *
 * The character panel shows the active campaign's characters (fed by the Host
 * `dnd.characters` RPC) in a floating `shell.overlay`, opened from a
 * `sidebar.footer.action` toggle ("⚔ 角色"). Footer layout fix kept: the
 * action stacks vertically under the shell's Cordis badge and never clips.
 *
 * Runtime: browser. Plain React via React.createElement. `React`, `host`,
 * `styles`, `ctx` are provided by the Client runtime.
 */

export const name = 'dnd-panel-client'
export const inject = ['slots']

// --- shared panel state -----------------------------------------------------
const panelState = { open: false }
const listeners = new Set()
function setOpen(v) { panelState.open = v; listeners.forEach((l) => l()) }
function toggle() { setOpen(!panelState.open) }
function useOpen() {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    const l = () => setTick((t) => t + 1)
    listeners.add(l)
    return () => listeners.delete(l)
  }, [])
  return panelState.open
}

// --- CSS (panel only, no theme tokens) -------------------------------------
const css = `
.dnd-char-overlay{position:fixed;right:16px;top:72px;width:340px;max-height:calc(100vh - 100px);overflow:auto;z-index:50;pointer-events:auto;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;font-size:13px;line-height:1.45;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dnd-char-body{padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.dnd-char-sub{opacity:.75;font-size:12px}
.dnd-char-hpbar{position:relative;height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
.dnd-char-hpfill{position:absolute;left:0;top:0;bottom:0;background:var(--dsw-alias-state-success-primary);border-radius:6px}
.dnd-char-abgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
.dnd-char-ab{text-align:center;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 2px}
.dnd-char-ab b{display:block;font-size:12px;opacity:.7}
.dnd-char-ab span{font-weight:600;font-size:13px}
.dnd-char-sk{display:flex;justify-content:space-between;gap:6px;padding:2px 0}
.dnd-char-h2{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.7;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:2px}
.dnd-char-sect{display:flex;flex-direction:column;gap:4px}
.dnd-char-load,.dnd-char-err{padding:14px;opacity:.75}
.hHd-Xa_footerActions:has(.dnd-char-action){flex-wrap:wrap}
.dnd-char-action{display:inline-flex;flex:none;align-items:center;justify-content:flex-start;gap:6px;background:none;border:none;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:0 8px;border-radius:8px;white-space:nowrap;min-width:0;height:32px;line-height:1;overflow:visible;box-sizing:border-box}
.dnd-char-action.dnd-char-wide{flex:0 0 100%;width:100%;padding:0 4px}
.dnd-char-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-char-action-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;font-size:15px;line-height:1}
.dnd-char-action-label{flex:none;font-size:13px;line-height:1;letter-spacing:.01em}
.dnd-char-action.dnd-rail{width:32px;height:32px;padding:0;justify-content:center;flex:0 0 auto}
.dnd-char-dice{font-weight:600}
`

// --- character panel --------------------------------------------------------
function CharacterPanel() {
  const [data, setData] = React.useState(null)
  const [err, setErr] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    host.call('dnd.characters', {}).then((res) => {
      if (!alive) return
      if (res && typeof res === 'object' && res.error) setErr(res.error)
      else setData(res)
    }).catch((e) => alive && setErr(String(e && e.message ? e.message : e)))
    return () => { alive = false }
  }, [])
  if (err) return React.createElement('div', { className: 'dnd-char-err' }, '无法读取角色：' + String(err))
  if (!data) return React.createElement('div', { className: 'dnd-char-load' }, '读取角色数据中…')
  const chars = data.characters || []
  return React.createElement(
    'div',
    { className: 'dnd-char-overlay dnd-char-body' },
    React.createElement('div', { className: 'dnd-char-sub' }, '战役 ' + (data.campaign || '—')),
    data.situation && data.situation.location ? React.createElement('div', { className: 'dnd-char-sub' }, '📍 ' + data.situation.location) : null,
    data.situation && data.situation.date ? React.createElement('div', { className: 'dnd-char-sub' }, '🗓 ' + data.situation.date) : null,
    chars.length === 0
      ? React.createElement('div', { className: 'dnd-char-sub' }, '（无角色数据）')
      : chars.map((c) => React.createElement(CharacterCard, { key: c.file + c.name, c }))
  )
}
function hpPct(c) {
  if (!c.hitPoints || !c.hitPoints.max) return 100
  return Math.max(0, Math.min(100, (c.hitPoints.current / c.hitPoints.max) * 100))
}
function CharacterCard({ c }) {
  const hp = c.hitPoints
  const attrs = c.abilityScores || {}
  const abNames = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  return React.createElement('div', { className: 'dnd-char-sect' },
    React.createElement('div', null,
      React.createElement('b', null, c.name || '(unnamed)'),
      c.klass ? React.createElement('span', { className: 'dnd-char-sub' }, '  ' + (c.race ? c.race.split(' (')[0] + ' ' : '') + c.klass + (c.level ? ' Lv' + c.level : '')) : null
    ),
    hp
      ? React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 3 } },
            React.createElement('span', null, 'HP'),
            React.createElement('span', null, hp.current + ' / ' + hp.max + (c.tempHp ? ' (+' + c.tempHp + ')' : ''))),
          React.createElement('div', { className: 'dnd-char-hpbar' },
            React.createElement('div', { className: 'dnd-char-hpfill', style: { width: hpPct(c) + '%' } })))
      : null,
    React.createElement('div', { className: 'dnd-char-sub' },
      [c.ac !== null && c.ac !== undefined ? 'AC ' + c.ac : null,
       c.initiative ? '先攻 ' + c.initiative : null,
       c.speed ? '速度 ' + c.speed : null].filter(Boolean).join(' · ')),
    React.createElement('div', { className: 'dnd-char-abgrid' },
      abNames.map((n) => React.createElement('div', { className: 'dnd-char-ab', key: n },
        React.createElement('b', null, n),
        React.createElement('span', null, attrs[n] || '—')))),
    c.skills && c.skills.length
      ? React.createElement('div', { className: 'dnd-char-sect' },
          React.createElement('div', { className: 'dnd-char-h2' }, '技能'),
          c.skills.map((s) => React.createElement('div', { className: 'dnd-char-sk', key: s.name },
            React.createElement('span', null, (s.proficient ? '● ' : '') + s.name + ' (' + (s.ability || '') + ')'),
            React.createElement('span', { className: 'dnd-char-dice' }, s.bonus))))
      : null,
    c.attacks && c.attacks.length
      ? React.createElement('div', { className: 'dnd-char-sect' },
          React.createElement('div', { className: 'dnd-char-h2' }, '攻击'),
          c.attacks.map((a) => React.createElement('div', { className: 'dnd-char-sk', key: a.name },
            React.createElement('span', null, a.name + (a.type ? ' (' + a.type + ')' : '')),
            React.createElement('span', null, a.bonus + (a.damage ? ' · ' + a.damage : '')))))
      : null,
    c.spellSlots && c.spellSlots.total
      ? React.createElement('div', { className: 'dnd-char-sect' },
          React.createElement('div', { className: 'dnd-char-h2' }, '法术位'),
          React.createElement('div', { className: 'dnd-char-sub' },
            'Lv' + c.spellSlots.level + '：' + (c.spellSlots.total - c.spellSlots.used) + ' / ' + c.spellSlots.total +
            (c.spellSaveDC ? '   DC ' + c.spellSaveDC : '') + (c.spellAttack ? '  攻 ' + c.spellAttack : '')))
      : null,
    c.currency ? React.createElement('div', { className: 'dnd-char-sub' }, '💰 ' + c.currency) : null)
}
function CharacterOverlay() {
  const open = useOpen()
  if (!open) return null
  return React.createElement('div', { style: { pointerEvents: 'none' } },
    React.createElement('div', { style: { pointerEvents: 'auto' } },
      React.createElement(CharacterPanel, null)))
}
function CharacterAction(props) {
  const wide = props.wide !== false
  return React.createElement('button', {
    type: 'button',
    className: 'dnd-char-action' + (wide ? ' dnd-char-wide' : ' dnd-rail'),
    title: '角色面板',
    'aria-label': '角色面板',
    onClick: toggle,
  },
    React.createElement('span', { className: 'dnd-char-action-icon' }, '⚔'),
    wide ? React.createElement('span', { className: 'dnd-char-action-label' }, '角色') : null)
}

// --- panel registry ---------------------------------------------------------
// Each panel: { id, label, action: (props)=>Node, overlay: ()=>Node }.
// The character panel is the only entry today; future panels append here.
const PANELS = [
  {
    id: 'dnd-char-panel',
    actionId: 'dnd-char-action',
    label: () => '角色',
    renderAction: (props) => React.createElement(CharacterAction, { wide: props.wide }),
    renderOverlay: () => React.createElement(CharacterOverlay, null),
  },
]

export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  styles.insert(css)
  for (const panel of PANELS) {
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: panel.id, order: 200 },
      () => React.createElement('div', null, panel.renderOverlay())))
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: panel.actionId, order: 10, label: panel.label },
      (props) => React.createElement('div', null, panel.renderAction(props))))
  }
  // Return a disposer for the whole fiber so stop/update removes everything.
  return {}
}
