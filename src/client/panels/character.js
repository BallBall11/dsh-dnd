/**
 * panels/character.js — the character panel.
 *
 * Authored as a factory-body fragment, NOT an ES module: this file is pasted
 * inside `window.__ModuleLoader__.load({ id, factory })` by scripts/build.mjs,
 * so it may not use `export` / `import`. It ends by returning the module
 * exports, which build.mjs wires into the IIFE fragment table.
 *
 * ## Where the data comes from
 *
 * `fetch('/dnd/characters')`, served by src/host/routes.mjs. A bundle cannot
 * use `host.call` — that path needs a pluginId and pluginRunId the dynamic
 * runner owns — so HTTP is the only transport available to us.
 *
 * ## What this panel deliberately does
 *
 * It renders what the Host sends and formats almost nothing itself. Money
 * arrives pre-formatted as `display.currency`, and validation findings arrive
 * as strings. Recomputing either here would give two places to drift, and the
 * one the DM reads would be the one that is wrong.
 *
 * It shows problems. A character whose state is impossible renders with the
 * findings visible under it rather than being hidden, because the alternative
 * is a DM reading a plausible number that is not true — the failure this whole
 * project keeps running into.
 *
 * ## Deliberately absent for now
 *
 * Polling, editing and per-character detail views. Stage 3c is the read-only
 * panel; live refresh and writes are 3d. One fetch per open, as in 3b.
 */

const React = require('react')

/** The Host route namespace, kept in sync by test/client-host-contract.test.mjs. */
const DND_API = '/dnd'

const CSS = `
.dnd-action{display:inline-flex;align-items:center;gap:6px;background:none;border:none;
  color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:0 8px;border-radius:8px;
  white-space:nowrap;height:32px;line-height:1;box-sizing:border-box}
.dnd-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-overlay{position:fixed;right:16px;top:72px;width:360px;max-height:calc(100vh - 96px);
  overflow-y:auto;z-index:50;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);
  font-family:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);padding:14px}
.dnd-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dnd-name{font-size:15px;font-weight:600}
.dnd-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.dnd-muted{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px}
.dnd-sep{height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}
.dnd-hp{display:flex;align-items:center;gap:8px;margin-top:8px}
.dnd-hpbar{flex:1;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dnd-hpfill{height:100%;border-radius:4px;background:var(--dsw-alias-state-success-primary)}
.dnd-hpfill.low{background:var(--dsw-alias-state-warn-primary)}
.dnd-hpfill.crit{background:var(--dsw-alias-state-error-primary)}
.dnd-num{font-variant-numeric:tabular-nums}
.dnd-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-top:8px;text-align:center}
.dnd-cell{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:5px 2px}
.dnd-cell b{display:block;font-size:14px;font-variant-numeric:tabular-nums}
.dnd-cell span{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.dnd-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
.dnd-row span:last-child{font-variant-numeric:tabular-nums}
.dnd-tag{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dnd-pro{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dnd-err{margin-top:8px;font-size:12px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-error-primary)}
.dnd-warn{margin-top:8px;font-size:12px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-warn-primary)}
.dnd-slots{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.dnd-slot{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:3px 8px;font-size:12px}
.dnd-slot i{font-style:normal;color:var(--dsw-alias-label-secondary)}
.dnd-spells{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0}
.dnd-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px}
`

/** Inject the stylesheet once, keyed so a reload does not stack duplicates. */
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

const OPEN = { value: false, listeners: new Set() }

/** A tiny external store so the button and the overlay share one open flag. */
function useOpen() {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const listener = () => force((n) => n + 1)
    OPEN.listeners.add(listener)
    return () => { OPEN.listeners.delete(listener) }
  }, [])
  return OPEN.value
}

function setOpen(next) {
  OPEN.value = next
  for (const listener of OPEN.listeners) listener()
}

/** Load the character list, once per open. Never throws into a render. */
function useCharacters(open) {
  const [state, setState] = React.useState({ phase: 'idle', status: 0, body: null })
  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setState({ phase: 'loading', status: 0, body: null })
    fetch(DND_API + '/characters', { cache: 'no-store' })
      .then(async (res) => ({ status: res.status, body: await res.json() }))
      .catch((error) => ({ status: 0, body: { error: String(error && error.message ? error.message : error) } }))
      .then((result) => { if (!cancelled) setState({ phase: 'done', ...result }) })
    return () => { cancelled = true }
  }, [open])
  return state
}

/** The modifier shown beside an ability score. */
function modifier(score) {
  if (typeof score !== 'number') return '—'
  const mod = Math.floor((score - 10) / 2)
  return (mod >= 0 ? '+' : '') + mod
}

/** Hit-point band: full-ish, hurt, or near death. */
function hpBand(current, max) {
  if (typeof current !== 'number' || typeof max !== 'number' || max <= 0) return ''
  const ratio = current / max
  if (current <= 0) return 'crit'
  if (ratio <= 0.25) return 'crit'
  if (ratio <= 0.5) return 'low'
  return ''
}

function AbilityGrid({ state }) {
  const keys = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  return React.createElement('div', { className: 'dnd-grid' },
    ...keys.map((k) => React.createElement('div', { key: k, className: 'dnd-cell' },
      React.createElement('span', null, k),
      React.createElement('b', null, state.abilities[k] ?? '—'),
      React.createElement('span', null, modifier(state.abilities[k])))))
}

function HitPoints({ combat }) {
  const hp = combat.hp ?? {}
  const band = hpBand(hp.current, hp.max)
  const pct = typeof hp.current === 'number' && typeof hp.max === 'number' && hp.max > 0
    ? Math.max(0, Math.min(100, (hp.current / hp.max) * 100))
    : 0
  return React.createElement('div', { className: 'dnd-hp' },
    React.createElement('span', { className: 'dnd-num' },
      React.createElement('b', null, hp.current ?? '—'), ' / ', hp.max ?? '—'),
    React.createElement('div', { className: 'dnd-hpbar' },
      React.createElement('div', { className: 'dnd-hpfill ' + band, style: { width: pct + '%' } })),
    combat.tempHp > 0 ? React.createElement('span', { className: 'dnd-tag' }, '+' + combat.tempHp) : null)
}

function Slots({ slots }) {
  const levels = Object.keys(slots ?? {})
  if (levels.length === 0) return null
  return React.createElement('div', null,
    React.createElement('div', { className: 'dnd-muted' }, '法术位'),
    React.createElement('div', { className: 'dnd-slots' },
      ...levels.map((lvl) => {
        const s = slots[lvl] ?? {}
        const left = (s.total ?? 0) - (s.used ?? 0)
        return React.createElement('span', { key: lvl, className: 'dnd-slot' },
          React.createElement('i', null, lvl + '环 '),
          React.createElement('b', { className: 'dnd-num' }, left + '/' + (s.total ?? 0)))
      })))
}

/** Findings arrive pre-formatted from the Host; errors are separated out. */
function Findings({ findings }) {
  if (!Array.isArray(findings) || findings.length === 0) return null
  const errors = findings.filter((f) => f.startsWith('ERROR'))
  const warnings = findings.filter((f) => !f.startsWith('ERROR'))
  return React.createElement('div', null,
    ...errors.map((f, i) => React.createElement('div', { key: 'e' + i, className: 'dnd-err' }, f)),
    ...warnings.map((f, i) => React.createElement('div', { key: 'w' + i, className: 'dnd-warn' }, f)))
}

/**
 * The castable spell surface: cantrips, prepared spells and the spellbook.
 * The Host already splits `spells` into the three lists, so the panel only
 * decides how to present them — it must not re-derive what is "castable",
 * otherwise the panel and the sheet grow two opinions. There is no attacks
 * list: the sheet parser's weapon rows were neither complete (no unarmed,
 * no spell attacks) nor actionable, so the state model dropped them.
 */
function ActionList({ st }) {
  const spells = st.spells ?? {}
  const lists = [
    ['戏法', Array.isArray(spells.cantrips) ? spells.cantrips : []],
    ['已准备', Array.isArray(spells.prepared) ? spells.prepared : []],
    ['法术书', Array.isArray(spells.spellbook) ? spells.spellbook : []],
  ]
  if (!lists.some(([, items]) => items.length > 0)) return null
  return React.createElement('div', null,
    React.createElement('div', { className: 'dnd-muted' }, '戏法 / 法术'),
    ...lists.flatMap(([label, items]) => items.length === 0 ? [] : [
      React.createElement('div', { key: label + '-label', className: 'dnd-label' }, label),
      React.createElement('div', { key: label + '-items', className: 'dnd-spells' },
        ...items.map((name, i) => React.createElement('span', { key: i, className: 'dnd-tag' }, name))),
    ]))
}

function Character({ character }) {
  const st = character.state
  if (st === null || st === undefined) {
    return React.createElement('div', { className: 'dnd-err' },
      character.name + '：' + (character.error ?? '无法读取状态'))
  }
  const identity = st.identity ?? {}
  const combat = st.combat ?? {}
  const title = [identity.race ? String(identity.race).split(' (')[0] : null, identity.class]
    .filter(Boolean).join(' ')
  const proficiency = Object.entries(st.skills ?? {})
    .filter(([, v]) => v.proficient)
    .map(([name]) => name)

  return React.createElement('div', null,
    React.createElement('div', { className: 'dnd-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'dnd-name' }, st.name ?? character.name),
        React.createElement('div', { className: 'dnd-sub' },
          title + (identity.level !== null && identity.level !== undefined ? ' Lv' + identity.level : ''))),
      character.needsMigration
        ? React.createElement('span', { className: 'dnd-tag', title: '尚未拆分出 .state.json' }, '未迁移')
        : null),
    React.createElement(HitPoints, { combat }),
    React.createElement(AbilityGrid, { state: st }),
    React.createElement('div', { className: 'dnd-sep' }),
    React.createElement('div', { className: 'dnd-row' },
      React.createElement('span', null, 'AC'),
      React.createElement('span', null,
        (combat.ac ?? '—') + (combat.mageArmorAc ? '（Mage Armor ' + combat.mageArmorAc + '）' : ''))),
    React.createElement('div', { className: 'dnd-row' },
      React.createElement('span', null, '先攻 / 速度'),
      // initiative arrives as a FINAL modifier (sheet-parse reads the sheet's
      // "**Initiative:** +2", sheet-split stores 2), not an ability score.
      // Running it through modifier() re-applied the formula and turned 2 into
      // -4 — the panel showing a number the DM would roll against and lose on.
      // AC on the row above is rendered raw for the same reason.
      React.createElement('span', null,
        (typeof combat.initiative === 'number'
          ? (combat.initiative >= 0 ? '+' : '') + combat.initiative
          : '—')
        + ' / ' + (combat.speed ?? '—') + ' ft')),
    st.spellcasting.saveDC !== null && st.spellcasting.saveDC !== undefined
      ? React.createElement('div', { className: 'dnd-row' },
        React.createElement('span', null, '法术 DC / 攻击'),
        React.createElement('span', null,
          st.spellcasting.saveDC + ' / ' + (st.spellcasting.attackBonus >= 0 ? '+' : '') + st.spellcasting.attackBonus))
      : null,
    React.createElement('div', { className: 'dnd-row' },
      React.createElement('span', null, '💰 ' + (character.display && character.display.currency ? character.display.currency : '—')),
      React.createElement('span', null, '')),
    React.createElement(Slots, { slots: st.spellSlots }),
    proficiency.length > 0
      ? React.createElement('div', { className: 'dnd-muted' },
        // The spans must be SIBLING children, not concatenated into the label.
        // `'熟练：' + arr` stringifies the element objects through
        // Array.prototype.toString, so the panel rendered the literal text
        // "[object Object],[object Object]" and created no <span> at all —
        // which also meant .dnd-pro never styled anything. Every other list in
        // this file spreads its children; this was the one place that did not.
        '熟练：',
        ...proficiency.map((p) => React.createElement('span', { key: p, className: 'dnd-pro' }, p + ' ')))
      : null,
    React.createElement(ActionList, { st }),
    React.createElement(Findings, { findings: character.findings }))
}

/** Render the transport result; every branch is an outcome a DM might hit. */
function Body({ result }) {
  if (result.phase === 'loading') return React.createElement('div', { className: 'dnd-muted' }, '读取中…')
  if (result.phase !== 'done') return null

  if (result.status === 0) {
    return React.createElement('div', { className: 'dnd-err' },
      '请求失败：' + (result.body && result.body.error ? result.body.error : 'unknown'))
  }
  if (result.status !== 200) {
    return React.createElement('div', { className: 'dnd-err' },
      'HTTP ' + result.status + '：' + (result.body && result.body.error ? result.body.error : ''))
  }

  const characters = (result.body && result.body.characters) || []
  const warnings = (result.body && result.body.warnings) || []
  if (characters.length === 0) {
    return React.createElement('div', null,
      React.createElement('div', { className: 'dnd-muted' },
        '战役 ' + result.body.campaign + ' 没有角色'),
      ...warnings.map((w, i) => React.createElement('div', { key: i, className: 'dnd-warn' }, w)))
  }

  return React.createElement('div', null,
    ...characters.map((c, i) => React.createElement('div', { key: c.name },
      i > 0 ? React.createElement('div', { className: 'dnd-sep' }) : null,
      React.createElement(Character, { character: c }))),
    ...warnings.map((w, i) => React.createElement('div', { key: 'gw' + i, className: 'dnd-warn' }, w)))
}

function Action(props) {
  const wide = props !== null && props !== undefined && props.wide !== false
  return React.createElement('button', {
    type: 'button',
    className: 'dnd-action',
    title: 'D&D 角色',
    'aria-label': 'D&D 角色',
    onClick: () => setOpen(!OPEN.value),
  }, React.createElement('span', null, '⚔'), wide ? React.createElement('span', null, 'D&D') : null)
}

/** `shell.overlay` is click-through, so the panel opts back into pointer events. */
function Overlay() {
  const open = useOpen()
  const result = useCharacters(open)
  if (!open) return null
  const campaign = result.body && result.body.campaign ? result.body.campaign : null
  return React.createElement('div', {
    className: 'dnd-overlay',
    style: { pointerEvents: 'auto' },
  },
  React.createElement('div', { className: 'dnd-head' },
    React.createElement('div', { className: 'dnd-name' }, '角色'),
    campaign !== null ? React.createElement('span', { className: 'dnd-tag' }, campaign) : null),
  React.createElement(Body, { result }))
}

const PANELS = [
  { overlayId: 'dnd-character-overlay', actionId: 'dnd-character-action', order: 10 },
]

/**
 * Register the character panel into both slots.
 * @param ctx - the client context; `slots` is the only service used.
 */
function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ensureStyle()
  for (const panel of PANELS) {
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: panel.overlayId, order: 200 },
      () => React.createElement(Overlay, null)))
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: panel.actionId, order: panel.order },
      (props) => React.createElement(Action, props)))
  }
  // A fiber effect may be a function, nullish, or an iterable of disposers.
  return () => { /* fiber-owned effects unwind automatically */ }
}

return { apply, inject: ['slots'] }
