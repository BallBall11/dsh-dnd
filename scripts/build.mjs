/**
 * build.mjs — assemble lib/ from src/ for the published bundle.
 *
 * Two very different output shapes, and getting them confused is exactly what
 * broke v0.1.0:
 *
 *   Host half  (src/host/**.mjs)  -> lib/host/**.mjs   plain ESM, copied verbatim
 *   Client half (src/client/**.js) -> lib/client.js    __ModuleLoader__ closure factory
 *
 * The client half is NOT a module in the ordinary sense. dsh-web fetches
 * /plugins/<id>/client.js outside Vite's module graph and evaluates it as a
 * classic script; the ONLY thing that makes the plugin exist is a call to
 * window.__ModuleLoader__.load({ id, factory }) made *by that file*. Returning
 * an ESM module (export const name / export function apply) registers nothing
 * and the loader reports:
 *
 *     bundle /plugins/.../client.js loaded without registering "<id>"
 *     via __ModuleLoader__.load
 *
 * The banner/footer/intro below are the exact contract shared/tsdown.client.ts
 * emits for the reference plugins (see its outputOptions, lines ~376-378):
 *
 *   banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
 *   footer: 'return module.exports; } });'
 *   intro:  'var module = { exports: {} }; var exports = module.exports;'
 *
 * We hand-roll it rather than adopt tsdown because this plugin has no
 * TypeScript, JSX, or CSS Modules — the parts tsdown would be doing real work
 * on. What we need from it is these three lines.
 *
 * `require` is the factory parameter: the loader answers it from its frozen
 * module table (react, react-dom, cordis, the dsh-client-* platform modules).
 * Anything NOT in that table is a guaranteed runtime throw, so the client
 * half must not import anything else.
 */
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..'
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

/** Registration key the loader matches against the graph row: the package name. */
const PLUGIN_ID = pkg.name

const srcHost = path.join(root, 'src/host')
const srcClient = path.join(root, 'src/client')
const lib = path.join(root, 'lib')
const libHost = path.join(lib, 'host')

await rm(lib, { recursive: true, force: true })
await mkdir(libHost, { recursive: true })
await mkdir(lib, { recursive: true })

/** Recursively collect files under `dir`, returning POSIX-relative paths. */
async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, base))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

// --- Host half: plain ESM, copied verbatim --------------------------------
const hostFiles = await walk(srcHost)
for (const rel of hostFiles) {
  if (!rel.endsWith('.mjs')) continue
  const dest = path.join(libHost, rel)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, await readFile(path.join(srcHost, rel)))
  console.log('host   ->', 'lib/host/' + rel)
}

// --- Client half: closure factory ----------------------------------------
/**
 * Wrap one client source file body in the loader contract.
 *
 * The source is authored as a plain script whose top level is the factory
 * body: it may use `require(...)`, create React elements, and assign to
 * `export`-like names via the trailing `return { ... }` it writes itself.
 * Concretely each src/client/**.js must end by returning its module exports,
 * e.g. `return { apply, inject }`.
 *
 * @param body - the source text of the client module.
 * @returns the full client.js contents, ready to serve.
 */
function wrapClientModule(body) {
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    body,
    'return module.exports; } });',
    '',
  ].join('\n')
}

/**
 * Assemble every src/client/**.js into ONE client.js.
 *
 * Each panel file is a factory-body fragment that ends with `return {...}`,
 * which cannot simply be concatenated (a `return` ends the factory). So each
 * fragment is wrapped in an IIFE bound to a stable local name, and the entry
 * file (src/client/index.js) consumes those locals. This keeps panels in
 * separate, reviewable files without a bundler.
 */
const CLIENT_ENTRY = 'index.js'
const clientFiles = (await walk(srcClient)).filter((f) => f.endsWith('.js')).sort()
if (!clientFiles.includes(CLIENT_ENTRY)) {
  throw new Error(`build: src/client/${CLIENT_ENTRY} is required (the client entry)`)
}

/**
 * Strip comments from a client source body.
 *
 * The client half ships to the browser, and the sources are commentary-heavy
 * on purpose — they explain contract decisions that are not visible in the
 * code. That prose is worth keeping in `src/` and worth nothing in the bundle:
 * measured at 41% of the emitted bytes, all of it parsed and discarded on
 * every page load.
 *
 * This is a scanner rather than a regex, because a regex cannot tell a comment
 * from the same characters inside a string or a regex literal, and getting
 * that wrong corrupts the shipped file. It tracks:
 *
 *   - single/double/backtick strings, with escapes and `${}` nesting
 *   - regex literals, distinguished from division by the previous token
 *
 * Comments become a single space, never nothing, so `a/*x*​/b` cannot silently
 * become `ab`.
 *
 * @param code - a client source file.
 * @returns the same code with comments removed.
 */
function stripComments(code) {
  let out = ''
  let i = 0
  /** The last significant character, used to tell a regex from a divide. */
  let prev = ''
  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    // Strings, including template literals with their `${}` substitutions.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < code.length) {
        const c = code[i]
        if (c === '\\') { out += code[i] + (code[i + 1] ?? ''); i += 2; continue }
        if (c === quote) { out += c; i += 1; break }
        // A `${` inside a template opens an expression; recurse so a comment
        // inside the substitution is handled rather than swallowed.
        if (quote === '`' && c === '$' && code[i + 1] === '{') {
          out += '${'
          i += 2
          let depth = 1
          let expr = ''
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth += 1
            else if (code[i] === '}') { depth -= 1; if (depth === 0) break }
            expr += code[i]
            i += 1
          }
          out += stripComments(expr)
          out += '}'
          i += 1
          continue
        }
        out += c
        i += 1
      }
      prev = quote
      continue
    }

    // Line comment.
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i += 1
      out += ' '
      continue
    }
    // Block comment.
    if (ch === '/' && next === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    // Regex literal: a `/` that follows something expecting an operand. A `/`
    // after an identifier, `)`, `]` or a number is division instead.
    if (ch === '/' && !/[\w$)\]]$/.test(prev)) {
      out += ch
      i += 1
      let inClass = false
      while (i < code.length) {
        const c = code[i]
        if (c === '\\') { out += code[i] + (code[i + 1] ?? ''); i += 2; continue }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) { out += c; i += 1; break }
        else if (c === '\n') break
        out += c
        i += 1
      }
      while (i < code.length && /[a-z]/.test(code[i])) { out += code[i]; i += 1 }
      prev = '/'
      continue
    }

    out += ch
    if (!/\s/.test(ch)) prev = ch
    i += 1
  }
  return out
}

const fragments = []
for (const rel of clientFiles) {
  if (rel === CLIENT_ENTRY) continue
  // panels/foo.js -> __panel_foo ; helpers/bar.js -> __helpers_bar
  const local = '__frag_' + rel.replace(/\.js$/, '').replace(/[^a-zA-Z0-9]/g, '_')
  const raw = await readFile(path.join(srcClient, rel), 'utf8')
  const body = stripComments(raw)
  fragments.push(`var ${local} = (function () {\n${body}\n})();`)
  console.log('client ->', 'fragment', rel, 'as', local, `(${raw.length} -> ${body.length} bytes)`)
}

const entryRaw = await readFile(path.join(srcClient, CLIENT_ENTRY), 'utf8')
const entryBody = stripComments(entryRaw)
const clientOut = wrapClientModule([...fragments, entryBody].join('\n\n'))

await writeFile(path.join(lib, 'client.js'), clientOut)
console.log('client ->', 'lib/client.js', `(${clientOut.length} bytes, id=${PLUGIN_ID})`)

// --- Sanity gate ----------------------------------------------------------
// Fail the build rather than ship an artifact the loader will reject. This is
// the check whose absence let v0.1.0 publish a client half that could never
// register.
if (!clientOut.includes(`__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}`)) {
  throw new Error('build: emitted client.js does not call __ModuleLoader__.load with the package id')
}
if (!clientOut.trimEnd().endsWith('return module.exports; } });')) {
  throw new Error('build: emitted client.js does not end with the factory footer')
}
for (const forbidden of [/\bexport\s+const\b/, /\bexport\s+function\b/, /^\s*import\s/m]) {
  if (forbidden.test(clientOut)) {
    throw new Error(`build: emitted client.js still contains ESM syntax (${forbidden}); it must be a factory body`)
  }
}

console.log('build OK')
