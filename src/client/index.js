/**
 * Client entry — the outer half of the bundle's client plugin.
 *
 * build.mjs assembles lib/client.js as:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-dnd", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     <each other src/client/**.js wrapped as var __frag_x = (function(){...})()>
 *     <this file>
 *     return module.exports; } });
 *
 * So this file is a factory BODY, not a module: no `export`, no `import`. It
 * sees the fragment locals declared just above it and returns the plugin
 * object the loader will apply.
 */

/** Panel registry. Adding a panel = wrapping one more fragment and listing it. */
const panelModules = [
  __frag_panels_character,
]

/** Services every panel needs before it can register anything. */
const inject = ['slots']

/**
 * Apply each registered panel module.
 * @param ctx - client context provided by the loader.
 */
function apply(ctx) {
  for (const panel of panelModules) {
    if (panel === undefined || typeof panel.apply !== 'function') continue
    panel.apply(ctx)
  }
  // Fibers accept only a function / nullish / iterable. Never return {}.
  return () => { /* child registrations are fiber-owned */ }
}

return { apply, inject }
