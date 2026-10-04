/**
 * verify-client.mjs — evaluate the emitted client.js the way the real loader
 * does, in a stubbed browser, and assert the plugin actually registers.
 *
 * build.test.mjs asserts the artifact's *text*. This asserts its *behaviour*:
 * it provides window.__ModuleLoader__.load, a require() table answering
 * 'react', and a minimal DOM, then runs the bundle and inspects what was
 * registered. A bundle can satisfy every string assertion and still throw at
 * evaluation — this catches that before the profile does.
 *
 * Node is not a browser, but the only browser facilities the client half uses
 * are document.head/querySelector/createElement, and those are tiny to stub.
 * That makes this a genuine pre-flight check rather than a formality.
 */

const registrations = []
const styleTags = []

/** Minimal DOM surface: enough for style injection and the slot registry. */
const document = {
  // The head may also receive non-style elements (the panel injects a
  // viewport meta when missing); only <style> tags count here.
  head: { appendChild: (el) => { if (el.tagName === 'style') styleTags.push(el) } },
  querySelector: () => null,
  createElement: (tag) => {
    const el = { tagName: tag, dataset: {}, textContent: '', attributes: {} }
    // The panel injects a viewport meta when the host page lacks one, so the
    // stub must answer setAttribute like a real element.
    el.setAttribute = (name, value) => { el.attributes[name] = value }
    return el
  },
}

/**
 * Drive the panel's module-private open flag the way a user does: the Action
 * button's onClick.
 *
 * Two levels are involved. The registered component is the slot's render thunk
 * (`(props) => createElement(Action, props)`), and the onClick lives on the
 * element `Action` returns. The React stub builds element objects without
 * running handlers, so the handler is invoked by hand here.
 */
function openForVerification() {
  const action = registrations.find((r) => r.slot === 'sidebar.footer.action')
  if (!action || typeof action.component !== 'function') return
  // Thunk -> element whose type is Action; rendering that yields the <button>.
  const thunkElement = renderWithHooks(action.component, { wide: true }).element
  if (thunkElement === null || thunkElement === undefined) return
  const inner = typeof thunkElement.type === 'function'
    ? renderWithHooks(thunkElement.type, thunkElement.props || {}).element
    : thunkElement
  const onClick = inner && inner.props && inner.props.onClick
  if (typeof onClick === 'function') onClick()
}

/** The loader: capture the factory and run it, exactly as the shell does. */
let factoryRan = false
let registeredId = null
const moduleExports = {}
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      registeredId = spec.id
      if (typeof spec.factory !== 'function') {
        throw new Error('__ModuleLoader__.load called without a factory function')
      }
      const out = spec.factory(fakeRequire)
      factoryRan = true
      Object.assign(moduleExports, out)
    },
  },
}
globalThis.document = document

/**
 * A fetch stub answering the panel's one request with a realistic payload.
 *
 * Shaped from the real /dnd/characters response (src/host/routes.mjs): the
 * point is that the panel's branches are exercised with the field names the
 * Host actually sends, so a rename on either side shows up as a failure here
 * rather than as an empty panel in the browser.
 */
const CHARACTER_PAYLOAD = {
  campaign: 'verify',
  characters: [{
    name: 'Alice',
    hasStateFile: true,
    needsMigration: false,
    state: {
      name: 'Alice',
      identity: { race: 'Human (Variant)', class: 'Fighter', level: 3 },
      abilities: { STR: 16, DEX: 14, CON: 15, INT: 10, WIS: 12, CHA: 8 },
      combat: { hp: { current: 24, max: 28 }, tempHp: 0, ac: 18, initiative: 2, speed: 30 },
      spellcasting: { saveDC: null, attackBonus: null },
      spellSlots: {},
      skills: { Athletics: { proficient: true, bonus: 5 } },
    },
    display: { currency: '8 gp 0 sp 0 cp', hp: '24/28', level: 3, class: 'Fighter', race: 'Human' },
    findings: [],
  }],
  warnings: [],
  counts: { characters: 1, needsMigration: 0 },
}
globalThis.fetch = () => Promise.resolve({
  status: 200,
  json: () => Promise.resolve(CHARACTER_PAYLOAD),
})

/** The frozen module table: only what the client half is allowed to require. */
function fakeRequire(id) {
  if (id === 'react') return REACT
  throw new Error(`verify-client: require('${id}') is not in the loader module table`)
}

/**
 * A React stub that behaves like React on MOUNT, which is the only phase this
 * checker exercises.
 *
 * The first version of this stub returned a dead setter and swallowed effects.
 * That made the open-state check vacuous: the panel's data effect never ran, so
 * the body stayed at phase 'idle', Body returned null, and the character tree
 * the check exists to exercise was never built. A stub that cannot fail cannot
 * verify — the same mistake as the fs mock that accepted a path string.
 *
 * Hooks are stored per component instance and replayed on every render of that
 * instance, with state writes marking the instance dirty. No scheduler, no
 * dependency-array diffing beyond identity, no bailout: enough to reach the
 * code under test, and no further claim than that.
 */
/**
 * Hook state must survive re-renders, exactly as it does in React. Keying
 * instances by component identity (rather than allocating one per call) is what
 * lets the settled render see the state the fetch wrote — without it the panel
 * re-renders from `idle`, Body returns null, and the check silently verifies
 * nothing.
 */
const instances = new WeakMap()
let currentInstance = null

const REACT = {
  version: '18.3.1-stub',
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    const inst = requireInstance('useState')
    const i = inst.hookIndex++
    if (!(i in inst.hooks)) {
      inst.hooks[i] = typeof initial === 'function' ? initial() : initial
    }
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.hooks[i]) : next
      if (Object.is(value, inst.hooks[i])) return
      inst.hooks[i] = value
      inst.dirty = true
    }
    return [inst.hooks[i], set]
  },
  useEffect: (fn) => {
    const inst = requireInstance('useEffect')
    const i = inst.hookIndex++
    inst.effects.push({ index: i, fn })
  },
  useMemo: (fn) => fn(),
}

function requireInstance(hook) {
  if (currentInstance === null) {
    throw new Error(`react stub: ${hook}() called outside a rendered component`)
  }
  return currentInstance
}

/** Render one component instance, running its effects, then settle the tree. */
function renderWithHooks(component, props) {
  let inst = instances.get(component)
  if (inst === undefined) {
    inst = { hooks: {}, cleanups: {}, dirty: false }
    instances.set(component, inst)
  }
  inst.hookIndex = 0
  inst.effects = []

  const previous = currentInstance
  currentInstance = inst
  let element
  try {
    element = component(props)
  } finally {
    currentInstance = previous
  }

  // Effects run on mount only. Re-rendering must not re-run them, or the
  // panel's fetch would loop — the same reason React needs a dependency array.
  if (!inst.mounted) {
    inst.mounted = true
    for (const effect of inst.effects) {
      const cleanup = effect.fn()
      if (typeof cleanup === 'function') inst.cleanups[effect.index] = cleanup
    }
  }
  return { element, inst }
}

/**
 * Let every already-queued microtask run. Used to settle the panel's fetch
 * chain without a scheduler or fake timers.
 */
async function drainMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/**
 * Walk a rendered element tree, invoking function components and descending
 * into what they return, collecting the component names encountered.
 *
 * This is how the check reaches `Character` / `HitPoints`: they live below
 * `Body`, and an element object alone would never reveal whether they build.
 */
function walkTree(node, seen, depth) {
  seen = seen || []
  depth = depth || 0
  if (depth > 32 || node === null || node === undefined || typeof node === 'boolean') return seen
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, seen, depth + 1)
    return seen
  }
  if (typeof node === 'string' || typeof node === 'number') return seen
  if (typeof node !== 'object') return seen

  const type = node.type
  if (typeof type === 'function') {
    seen.push(type.name || 'anonymous')
    // Nested components render through renderWithHooks too, so their hooks get
    // an instance — calling type(props) directly would trip the guard above and
    // is exactly the situation the guard exists to catch.
    walkTree(renderWithHooks(type, node.props || {}).element, seen, depth + 1)
    return seen
  }
  if (Array.isArray(node.children)) walkTree(node.children, seen, depth + 1)
  return seen
}

/** Fake ctx: `slots` records registrations so we can inspect them. */
const slots = {
  inject: (slotName, fn) => { fn() },
  register: (meta, component) => {
    registrations.push({ slot: meta.name, id: meta.id, order: meta.order, component })
    return () => {}
  },
}
const ctx = { get: (name) => (name === 'slots' ? slots : undefined) }

// --- run it ---------------------------------------------------------------
const source = await (await import('node:fs/promises')).readFile(
  new URL('../lib/client.js', import.meta.url), 'utf8')

try {
  // eslint-disable-next-line no-new-func
  new Function(source)()
} catch (error) {
  console.error('verify-client FAILED: client.js threw at evaluation')
  console.error(error)
  process.exit(1)
}

const failures = []
const ok = (cond, msg) => { if (!cond) failures.push(msg) }

ok(registeredId === 'dsh-dnd', `registered id was ${JSON.stringify(registeredId)}, expected "dsh-dnd"`)
ok(factoryRan, 'the factory never ran')
ok(typeof moduleExports.apply === 'function', 'module.exports.apply is missing')
ok(Array.isArray(moduleExports.inject), 'module.exports.inject is missing')

// The fiber contract: apply() must not return a bare object.
if (typeof moduleExports.apply === 'function') {
  let returned
  try {
    returned = moduleExports.apply(ctx)
  } catch (error) {
    failures.push('apply(ctx) threw: ' + error.message)
  }
  const legal = returned === undefined || returned === null || typeof returned === 'function'
    || (typeof returned === 'object' && (Symbol.iterator in returned || Symbol.asyncIterator in returned))
  ok(legal, `apply() returned ${JSON.stringify(returned)} — fiber accepts only function/nullish/iterable ('Invalid effect')`)
}

const bySlot = Object.fromEntries(registrations.map((r) => [r.slot, r]))
ok(bySlot['sidebar.footer.action'] !== undefined, 'nothing registered into sidebar.footer.action')
ok(bySlot['shell.overlay'] !== undefined, 'nothing registered into shell.overlay')
ok(bySlot['sidebar.footer.action']?.id === 'dnd-character-action',
  `sidebar.footer.action id was ${bySlot['sidebar.footer.action']?.id}`)
ok(bySlot['shell.overlay']?.id === 'dnd-character-overlay',
  `shell.overlay id was ${bySlot['shell.overlay']?.id}`)
ok(styleTags.length === 1, `expected exactly 1 injected <style>, got ${styleTags.length}`)
ok(styleTags[0]?.dataset?.plugin === 'dsh-dnd', 'injected <style> is missing data-plugin="dsh-dnd"')

// Rendering must not throw — a renderer crash is what actually blanks a panel.
// Components are rendered through renderWithHooks so their effects run; a bare
// component(props) call would leave effects unexecuted and verify less.
if (typeof bySlot['sidebar.footer.action']?.component === 'function') {
  try {
    renderWithHooks(bySlot['sidebar.footer.action'].component, { wide: true })
  } catch (error) {
    failures.push('sidebar action component threw when rendered: ' + error.message)
  }
}
if (typeof bySlot['shell.overlay']?.component === 'function') {
  try {
    renderWithHooks(bySlot['shell.overlay'].component, {})
  } catch (error) {
    failures.push('overlay component threw when rendered: ' + error.message)
  }

  // The check above renders the CLOSED state, which returns null — so it never
  // reaches the panel body, which is where a render bug would actually live.
  // Open the store, let the fetch settle, and render again.
  try {
    openForVerification()

    // The registered component is the SLOT's render thunk — the Host calls it to
    // get an element, and that element's type is the panel's own component.
    // Walking the thunk's result is what actually descends into the panel;
    // stopping at the thunk would only ever see "Overlay".
    const renderSlot = bySlot['shell.overlay'].component
    const opened = walkTree(renderWithHooks(renderSlot, {}).element)
    ok(opened.length > 1, `the open overlay rendered only: ${opened.join(', ') || 'nothing'}`)

    // The effect kicked off a promise; React would re-render once it settles.
    // Drain microtasks, then render again so the body has data.
    await drainMicrotasks()
    const seen = walkTree(renderWithHooks(renderSlot, {}).element)

    ok(seen.includes('Body'),
      'the open overlay rendered no Body — the panel tree was never built')
    ok(seen.includes('Character'),
      `the panel never built a Character (saw: ${seen.join(', ')})`)
    ok(seen.some((n) => n === 'HitPoints' || n === 'AbilityGrid'),
      `the open overlay rendered no character detail (saw: ${seen.join(', ') || 'nothing'})`)
  } catch (error) {
    failures.push('overlay component threw when OPEN with data: ' + error.message)
  }
}

if (failures.length > 0) {
  console.error('verify-client FAILED:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('verify-client OK — the bundle registers and renders headlessly')
console.log('  registered id :', registeredId)
console.log('  exports       :', Object.keys(moduleExports).join(', '))
console.log('  slots         :', registrations.map((r) => `${r.slot}#${r.id}`).join(', '))
