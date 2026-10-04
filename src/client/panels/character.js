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

// Party layout: 4 uniform columns on wide screens, dropping with the
// viewport (3 / 2 / 1) so a phone shows one full-width card instead of four
// crushed slivers. Each breakpoint re-declares the border reset for the
// FIRST cell of every row; wrapped rows gain a top hairline so cards still
// read as separate columns. NOTE: no block comments inside the CSS string —
// the build strips comments outside strings only, so one would ship.
const CSS = `
.dnd-action{display:inline-flex;align-items:center;gap:6px;background:none;border:none;
  color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;padding:0 8px;border-radius:8px;
  white-space:nowrap;height:32px;line-height:1;box-sizing:border-box}
.dnd-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-overlay{position:fixed;right:16px;top:72px;bottom:72px;width:max-content;min-width:300px;max-width:calc(100vw - 32px);
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
.dnd-pro{color:var(--dsw-alias-label-primary)}
.dnd-err{margin-top:8px;font-size:12px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-error-primary)}
.dnd-warn{margin-top:8px;font-size:12px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-state-warn-primary)}
.dnd-slots{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.dnd-slot{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:3px 8px;font-size:12px}
.dnd-slot i{font-style:normal;color:var(--dsw-alias-label-secondary)}
.dnd-party{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:start}
.dnd-party>*{padding:0 9px;min-width:0;overflow-wrap:anywhere}
.dnd-party>*+*{border-left:1px solid var(--dsw-alias-border-l1)}
.dnd-party>*:nth-child(4n+1){border-left:none;padding-left:0}
@media (max-width:1100px){
  .dnd-party{grid-template-columns:repeat(3,minmax(0,1fr))}
  .dnd-party>*{padding:0 9px}
  .dnd-party>*:nth-child(3n+1){border-left:none;padding-left:0}
  .dnd-party>*:nth-child(3n+2),.dnd-party>*:nth-child(3n){padding-left:9px}
}
@media (max-width:820px){
  .dnd-party{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:14px}
  .dnd-party>*{padding:0 9px}
  .dnd-party>*:nth-child(2n+1){border-left:none;padding-left:0}
  .dnd-party>*:nth-child(2n){padding-left:9px}
  .dnd-party>*:nth-child(n+3){border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
}
@media (max-width:560px){
  .dnd-party{grid-template-columns:minmax(0,1fr);row-gap:14px}
  .dnd-party>*{border-left:none;padding:0}
  .dnd-party>*+*{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
  .dnd-overlay{left:12px;right:12px;width:auto;min-width:0;top:64px;bottom:12px;padding:12px}
  .dnd-grid{grid-template-columns:repeat(3,1fr)}
}
.dnd-tag{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  border:1px solid var(--dsw-alias-border-l1)}
.dnd-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.dnd-sec{font-size:12px;font-weight:600;margin:8px 0 2px;color:var(--dsw-alias-label-primary)}
.dnd-collapse{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.dnd-collapse-hd{display:flex;align-items:center;gap:6px;width:100%;border:none;background:none;
  font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;
  padding:7px 10px;text-align:left;box-sizing:border-box}
.dnd-collapse-hd:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dnd-collapse-hd .arrow{margin-left:auto;transition:transform .15s ease;color:var(--dsw-alias-label-secondary);font-size:10px}
.dnd-collapse-hd .arrow.open{transform:rotate(90deg)}
.dnd-collapse-hd .count{font-weight:400;color:var(--dsw-alias-label-secondary)}
.dnd-collapse-body{padding:2px 10px 8px;overflow-wrap:anywhere}
.dnd-spellcard{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px;margin:4px 0;background:var(--dsw-alias-bg-layer-2)}
.dnd-spellcard b{font-size:12px}
.dnd-spellcard .en{color:var(--dsw-alias-label-secondary);font-size:10px;margin-left:4px}
.dnd-spellcard .meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px}
.dnd-spellcard .meta em{font-style:normal;color:var(--dsw-alias-state-warn-primary)}
.dnd-eq{display:flex;justify-content:space-between;gap:6px;padding:3px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);align-items:baseline}
.dnd-eq:last-child{border-bottom:none}
.dnd-eq .en{color:var(--dsw-alias-label-secondary);font-size:10px}
.dnd-eq .meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dnd-chip{display:inline-block;border-radius:6px;padding:1px 6px;font-size:10px;margin:2px 2px 0 0;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dnd-chip.mastery{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dnd-feat{padding:3px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.dnd-feat:last-child{border-bottom:none}
.dnd-feat b{font-size:12px}
.dnd-feat .en{color:var(--dsw-alias-label-secondary);font-size:10px;margin-left:4px}
.dnd-feat p{margin:1px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dnd-levelchips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dnd-levelchip{border-radius:6px;padding:2px 7px;font-size:11px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1)}
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

/**
 * Load the character list on open, then poll while the panel stays open, so
 * numbers written by dnd_* tools during play appear without a manual close +
 * reopen. Each poll replaces the whole result — there is no merging, so a
 * character deleted mid-session disappears instead of lingering.
 */
const POLL_MS = 10000

function useCharacters(open) {
  const [state, setState] = React.useState({ phase: 'idle', status: 0, body: null })
  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    const load = () => {
      fetch(DND_API + '/characters', { cache: 'no-store' })
        .then(async (res) => ({ status: res.status, body: await res.json() }))
        .catch((error) => ({ status: 0, body: { error: String(error && error.message ? error.message : error) } }))
        .then((result) => { if (!cancelled) setState({ phase: 'done', ...result }) })
    }
    setState({ phase: 'loading', status: 0, body: null })
    load()
    const timer = setInterval(load, POLL_MS)
    // A polling timer that is alive only to keep a browser panel fresh must
    // not keep a headless node process (verify-client renders the OPEN panel)
    // alive forever — that hung `npm run check` at verify until processes
    // were killed by hand.
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    return () => { cancelled = true; clearInterval(timer) }
  }, [open])
  return state
}

/**
 * The display index behind the panel's Chinese labels and spell/weapon info:
 * fetched ONCE per page (the payload derives from the bundle's own datasets,
 * not from campaign state, so polling it would be waste), kept in a module
 * promise and shared by every render.
 */
let metaPromise = null
function loadMeta() {
  if (metaPromise === null) {
    metaPromise = fetch(DND_API + '/meta', { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : null))
      .catch(() => null)
  }
  return metaPromise
}

function useMeta() {
  const [meta, setMeta] = React.useState(null)
  React.useEffect(() => {
    let cancelled = false
    loadMeta().then((data) => { if (!cancelled) setMeta(data) })
    return () => { cancelled = true }
  }, [])
  return meta
}

/** zh term for an EN key, falling back to the key itself. */
function zh(meta, map, key) {
  if (meta !== null && meta !== undefined && key !== null && key !== undefined) {
    const table = meta[map] ?? {}
    const hit = table[key]
    if (typeof hit === 'string' && hit !== '') return hit
    // Skill keys arrive in two shapes: sheet-parse stores CamelCase
    // ("SleightOfHand"), the map keys on display names ("Sleight of Hand").
    const spaced = String(key).replace(/([a-z])([A-Z])/g, '$1 $2')
    if (spaced !== key) {
      const retry = table[spaced]
      if (typeof retry === 'string' && retry !== '') return retry
    }
  }
  return key
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

function AbilityGrid({ state, meta }) {
  const keys = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  return React.createElement('div', { className: 'dnd-grid' },
    ...keys.map((k) => React.createElement('div', { key: k, className: 'dnd-cell' },
      React.createElement('span', { title: k }, zh(meta, 'abilities', k)),
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

/**
 * A collapsible card section. Open state lives here per (characterId, title)
 * in one module map, so it survives the 10s poll re-render (a useState inside
 * the mapped Character would remount and snap shut every refresh) and
 * persists across close/reopen within the page lifetime. Default: open for a
 * character's first section only when it carries few entries; spells default
 * CLOSED because they are the longest list.
 */
const SECTION_STATE = new Map()

function Section({ characterId, title, count, defaultOpen, children }) {
  const key = characterId + '::' + title
  const open = SECTION_STATE.has(key) ? SECTION_STATE.get(key) : Boolean(defaultOpen)
  const toggle = () => {
    SECTION_STATE.set(key, !open)
    // Re-render without a hook: the flag lives outside React, so force the
    // same way useOpen() does.
    for (const listener of OPEN.listeners) listener()
  }
  return React.createElement('div', { className: 'dnd-collapse' },
    React.createElement('button', { type: 'button', className: 'dnd-collapse-hd', onClick: toggle },
      React.createElement('span', null, title),
      count !== undefined && count !== null ? React.createElement('span', { className: 'count' }, ' (' + count + ')') : null,
      React.createElement('span', { className: 'arrow' + (open ? ' open' : '') }, '▶')),
    open ? React.createElement('div', { className: 'dnd-collapse-body' }, children) : null)
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
 * One spell with its combat line: the Chinese name (English beside it when
 * they differ), ring/school and the Host-parsed damage/save line. The panel
 * renders what /dnd/meta sends and never re-parses the SRD itself.
 */
function SpellCard({ name, meta }) {  const entry = meta !== null && meta !== undefined ? (meta.spells ?? {})[name] : undefined
  const displayName = entry !== undefined && entry.zh !== null && entry.zh !== undefined ? entry.zh : name
  const metaBits = []
  if (entry !== undefined && entry.level !== null && entry.level !== undefined) metaBits.push(entry.level + '环')
  if (entry !== undefined && entry.school) metaBits.push(entry.school)
  return React.createElement('div', { className: 'dnd-spellcard' },
    React.createElement('div', null,
      React.createElement('b', null, displayName),
      displayName !== name ? React.createElement('span', { className: 'en' }, name) : null),
    (metaBits.length > 0 || (entry !== undefined && entry.info))
      ? React.createElement('div', { className: 'meta' },
        metaBits.join(' · '),
        entry !== undefined && entry.info
          ? React.createElement('em', null, (metaBits.length > 0 ? ' | ' : '') + entry.info)
          : null)
      : null)
}

/**
 * The castable spell surface: cantrips, prepared spells and the spellbook,
 * each entry a card with damage/save info.
 */
function SpellList({ characterId, st, meta }) {
  const spells = st.spells ?? {}
  const lists = [
    ['戏法', Array.isArray(spells.cantrips) ? spells.cantrips : []],
    ['已准备', Array.isArray(spells.prepared) ? spells.prepared : []],
    ['法术书', Array.isArray(spells.spellbook) ? spells.spellbook : []],
  ]
  const total = lists.reduce((n, [, items]) => n + items.length, 0)
  if (total === 0) return null
  return React.createElement(Section, { characterId, title: '法术', count: total, defaultOpen: false },
    ...lists.flatMap(([label, items]) => items.length === 0 ? [] : [
      React.createElement('div', { key: label + '-label', className: 'dnd-label' }, label),
      ...items.map((name, i) => React.createElement(SpellCard, { key: label + i, name, meta })),
    ]))
}

/**
 * Equipped weapons and armor with what they DO: the weapon's damage dice, its
 * properties (灵巧/轻型/…) and — under the 2024 rules — the mastery property
 * the weapon grants, which IS a special action in play. Data comes from
 * /dnd/meta's weapons/armor index; a weapon the datasets do not know renders
 * by name alone instead of disappearing.
 */
function Equipment({ characterId, st, meta }) {
  const equipment = st.equipment ?? {}
  const weaponNames = Object.keys(equipment.weapons ?? {})
  const armorNames = Object.keys(equipment.armour ?? {})
  const gearNames = Object.keys(equipment.gear ?? {})
  if (weaponNames.length === 0 && armorNames.length === 0 && gearNames.length === 0) return null
  const weaponMeta = (name) => meta !== null && meta !== undefined ? (meta.weapons ?? {})[name] : undefined
  const armorMeta = (name) => meta !== null && meta !== undefined ? (meta.armor ?? {})[name] : undefined
  // Equipment the datasets do not index (an instrument stashed under weapons,
  // a small knife) still gets its Chinese name from the curated name maps.
  const weaponName = (name) => {
    const w = weaponMeta(name)
    if (w !== undefined && w.zh) return w.zh
    const byWeapon = zh(meta, 'weaponNames', name)
    if (byWeapon !== name) return byWeapon
    const byGear = zh(meta, 'gear', name)
    if (byGear !== name) return byGear
    return name
  }
  const armorName = (name) => {
    const a = armorMeta(name)
    if (a !== undefined && a.zh) return a.zh
    const byArmor = zh(meta, 'armorNames', name)
    return byArmor !== name ? byArmor : name
  }
  const qty = (map, name) => { const n = map[name]; return n !== undefined && n !== 1 ? ' ×' + n : '' }
  return React.createElement(Section, { characterId, title: '装备', count: weaponNames.length + armorNames.length, defaultOpen: true },
    ...weaponNames.map((name) => {
      const w = weaponMeta(name)
      const displayName = weaponName(name)
      return React.createElement(React.Fragment, { key: 'w' + name },
        React.createElement('div', { className: 'dnd-eq' },
          React.createElement('span', null,
            React.createElement('b', null, displayName + qty(equipment.weapons, name)),
            displayName !== name ? React.createElement('span', { className: 'en' }, name) : null),
          React.createElement('span', { className: 'meta' },
            w !== undefined && w.damage ? w.damage : '—')),
        w !== undefined && (w.properties.length > 0 || w.mastery)
          ? React.createElement('div', { className: 'dnd-levelchips' },
            ...w.properties.map((p, i) => React.createElement('span', { key: i, className: 'dnd-chip' }, p)),
            w.mastery
              ? React.createElement('span', { className: 'dnd-chip mastery', title: '武器精通（2024）' }, '精通·' + zh(meta, 'mastery', w.mastery))
              : null)
          : null)
    }),
    ...armorNames.map((name) => {
      const a = armorMeta(name)
      const displayName = armorName(name)
      return React.createElement('div', { key: 'a' + name, className: 'dnd-eq' },
        React.createElement('span', null,
          React.createElement('b', null, displayName + qty(equipment.armour, name)),
          displayName !== name ? React.createElement('span', { className: 'en' }, name) : null),
        React.createElement('span', { className: 'meta' }, a !== undefined && a.ac ? a.ac : ''))
    }),
    gearNames.length > 0
      ? React.createElement('div', { className: 'dnd-levelchips' },
        ...gearNames.map((g) => React.createElement('span', { key: g, className: 'dnd-chip' },
          zh(meta, 'gear', g) + qty(equipment.gear, g))))
      : null)
}

/**
 * Class features, from two sources the Host already owns:
 *   - the class table at the character's level (/dnd/meta classes[ruleset]) —
 *     the features the rules say the character HAS, even on a lazy sheet;
 *   - the sheet's own Features & Traits entries (character.features), the
 *     hand-written list the DM maintains.
 */
function Features({ character, st, meta, ruleset }) {
  const sheetFeatures = Array.isArray(character.features) ? character.features : []
  const identity = st.identity ?? {}
  const className = identity.class
  const level = identity.level
  let tableFeatures = []
  if (meta !== null && meta !== undefined && className !== null && className !== undefined
    && level !== null && level !== undefined) {
    const byLevel = ((meta.classes ?? {})[ruleset] ?? {})[String(className)] ?? null
    if (Array.isArray(byLevel)) {
      for (let lv = 1; lv <= Math.min(level, byLevel.length); lv += 1) {
        tableFeatures = tableFeatures.concat(Array.isArray(byLevel[lv - 1]) ? byLevel[lv - 1] : [])
      }
    }
  }
  if (tableFeatures.length === 0 && sheetFeatures.length === 0) return null
  return React.createElement(Section, { characterId: character.name, title: '特性与动作', count: tableFeatures.length + sheetFeatures.length, defaultOpen: true },
    tableFeatures.length > 0
      ? React.createElement('div', { className: 'dnd-levelchips' },
        ...tableFeatures.map((f, i) => React.createElement('span', { key: i, className: 'dnd-levelchip' }, zh(meta, 'features', f))))
      : null,
    ...sheetFeatures.map((f, i) => React.createElement('div', { key: 's' + i, className: 'dnd-feat' },
      React.createElement('b', null, zh(meta, 'features', f.name)),
      f.text !== '' ? React.createElement('p', null, f.text) : null)))
}

function Character({ character, meta, ruleset }) {
  const st = character.state
  if (st === null || st === undefined) {
    return React.createElement('div', { className: 'dnd-err' },
      character.name + '：' + (character.error ?? '无法读取状态'))
  }
  const identity = st.identity ?? {}
  const combat = st.combat ?? {}
  // Race/class render in Chinese where the curated map knows them ("Bard" ->
  // 吟游诗人), keeping the English beside when the card title shortened them.
  const raceRaw = identity.race !== null && identity.race !== undefined ? String(identity.race).split(' (')[0] : null
  const raceZh = raceRaw !== null ? zh(meta, 'races', raceRaw) : null
  const classZh = identity.class !== null && identity.class !== undefined ? zh(meta, 'classNames', identity.class) : null
  const title = [raceZh, classZh]
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
    React.createElement(AbilityGrid, { state: st, meta }),
    React.createElement('div', { className: 'dnd-sep' }),
    React.createElement('div', { className: 'dnd-row' },
      React.createElement('span', null, '护甲 AC'),
      React.createElement('span', null,
        (combat.ac ?? '—') + (combat.mageArmorAc ? '（法师护甲 ' + combat.mageArmorAc + '）' : ''))),
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
        + ' / ' + (combat.speed ?? '—') + ' 尺')),
    st.spellcasting.saveDC !== null && st.spellcasting.saveDC !== undefined
      ? React.createElement('div', { className: 'dnd-row' },
        React.createElement('span', null,
          '法术 DC / 攻击'
          + (st.spellcasting.ability ? '（' + zh(meta, 'abilities', st.spellcasting.ability) + '）' : '')),
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
        ...proficiency.map((p) => React.createElement('span', { key: p, className: 'dnd-pro' }, zh(meta, 'skills', p) + ' ')))
      : null,
    React.createElement(Equipment, { characterId: st.name ?? character.name, st, meta }),
    React.createElement(Features, { character, st, meta, ruleset }),
    React.createElement(SpellList, { characterId: st.name ?? character.name, st, meta }),
    React.createElement(Findings, { findings: character.findings }))
}

/** Render the transport result; every branch is an outcome a DM might hit. */
function Body({ result, meta }) {
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
    React.createElement('div', { className: 'dnd-party' },
      // `meta` arrives as a PROP from Overlay (useMeta's fetch), never on the
      // transport result — the earlier version read result.meta, which is
      // always undefined, so every card silently rendered without its
      // Chinese names and combat lines.
      ...characters.map((c) => React.createElement('div', { key: c.name },
        React.createElement(Character, { character: c, meta, ruleset: result.body.ruleset ?? '2014' })))),
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
  const meta = useMeta()
  if (!open) return null
  const campaign = result.body && result.body.campaign ? result.body.campaign : null
  return React.createElement('div', {
    className: 'dnd-overlay',
    style: { pointerEvents: 'auto' },
  },
  React.createElement('div', { className: 'dnd-head' },
    React.createElement('div', { className: 'dnd-name' }, '角色'),
    campaign !== null ? React.createElement('span', { className: 'dnd-tag' }, campaign) : null),
  React.createElement(Body, { result, meta }))
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
