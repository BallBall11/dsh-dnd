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
  head: { appendChild: (el) => { styleTags.push(el) } },
  querySelector: () => null,
  createElement: (tag) => {
    const el = { tagName: tag, dataset: {}, textContent: '' }
    return el
  },
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

/** The frozen module table: only what the client half is allowed to require. */
function fakeRequire(id) {
  if (id === 'react') return REACT
  throw new Error(`verify-client: require('${id}') is not in the loader module table`)
}

/** A React stub good enough to build elements, hooks, and a version string. */
const REACT = {
  version: '18.3.1-stub',
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
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
ok(bySlot['sidebar.footer.action']?.id === 'dnd-smoke-action',
  `sidebar.footer.action id was ${bySlot['sidebar.footer.action']?.id}`)
ok(bySlot['shell.overlay']?.id === 'dnd-smoke-overlay',
  `shell.overlay id was ${bySlot['shell.overlay']?.id}`)
ok(styleTags.length === 1, `expected exactly 1 injected <style>, got ${styleTags.length}`)
ok(styleTags[0]?.dataset?.plugin === 'dsh-dnd', 'injected <style> is missing data-plugin="dsh-dnd"')

// Rendering must not throw — a renderer crash is what actually blanks a panel.
if (typeof bySlot['sidebar.footer.action']?.component === 'function') {
  try {
    bySlot['sidebar.footer.action'].component({ wide: true })
  } catch (error) {
    failures.push('sidebar action component threw when rendered: ' + error.message)
  }
}
if (typeof bySlot['shell.overlay']?.component === 'function') {
  try {
    bySlot['shell.overlay'].component({})
  } catch (error) {
    failures.push('overlay component threw when rendered: ' + error.message)
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
