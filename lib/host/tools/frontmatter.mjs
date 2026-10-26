/**
 * tools/frontmatter.mjs — a deliberately small YAML frontmatter reader/writer.
 *
 * ## Scope, and why it is small
 *
 * This handles exactly the frontmatter this plugin writes and the shapes a
 * person is likely to type into it:
 *
 *   ---
 *   player: —
 *   campaign: morgansfort
 *   updated: 2026-09-04
 *   tags: [pc, wizard]        # or a block list (see below)
 *   ---
 *
 * It is NOT a YAML implementation, and says so rather than half-implementing
 * the spec. No nested maps beyond one level, no anchors, no multi-document
 * streams, no block scalars. A real YAML parser would be a dependency and a
 * security surface (YAML can construct objects) for a six-line header.
 *
 * ## What it must never do
 *
 * Lose data. Frontmatter sits at the top of a file whose body is hand-written
 * prose, so a parser that mangles the header risks the whole document. Every
 * function here either round-trips its input exactly or reports a warning —
 * never silently rewrites.
 *
 * Numbers are the one place the format is ambiguous. `updated: 2026-09-04`
 * must stay a string (a date is not arithmetic), while `level: 3` should read
 * as a number. Types are decided per key by the schema, not guessed from the
 * text, so `tags: [1, 2]` cannot turn a tag into a number.
 */

/** The fence that opens and closes a frontmatter block. */
const FENCE = '---'

/**
 * Keys whose values stay strings no matter how numeric they look.
 *
 * `2026-09-04` is the motivating case: it is a date, and coercing it to a
 * number would be wrong in a way that only shows up months later when the
 * value is rendered.
 */
const STRING_KEYS = new Set([
  'player', 'campaign', 'updated', 'worldTime', 'name', 'class', 'race', 'background', 'alignment',
])

/** Keys that read as a list of strings. */
const LIST_KEYS = new Set(['tags', 'aliases'])

/**
 * Split a document into its frontmatter and body.
 *
 * The body is returned byte-exact, including its leading blank line, because
 * it is the part that must survive untouched.
 *
 * @param text - the whole file.
 * @returns `{ data, body, raw, present }`. When no frontmatter is present,
 *   `data` is `{}`, `body` is the entire input, and `present` is false.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  const warnings = []

  // A frontmatter block must be the very first thing in the file. A leading
  // BOM is tolerated; leading whitespace is not, matching common practice.
  const normalized = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
  if (!normalized.startsWith(FENCE + '\n') && !normalized.startsWith(FENCE + '\r\n')) {
    // Also accept a block that is exactly `---` with no trailing newline.
    if (normalized.trimEnd() !== FENCE) {
      return { data: {}, body: src, raw: '', present: false, warnings }
    }
  }

  const lines = normalized.split(/\r?\n/)
  if (lines[0].trim() !== FENCE) {
    return { data: {}, body: src, raw: '', present: false, warnings }
  }

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) { end = i; break }
  }
  if (end === -1) {
    // An unterminated block is treated as body, not swallowed. Losing the
    // top of a document because a fence was forgotten would be worse than
    // leaving it unparsed.
    warnings.push('frontmatter opened with --- but never closed; treating the file as plain markdown')
    return { data: {}, body: src, raw: '', present: false, warnings }
  }

  const raw = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  const data = parseBlock(raw, warnings)
  return { data, body, raw, present: true, warnings }
}

/** Parse the key/value lines of a frontmatter block. */
function parseBlock(raw, warnings) {
  const data = {}
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    // A block-style list item (`  - value`) attaches to the preceding key.
    const itemMatch = line.match(/^\s+-\s+(.*)$/)
    if (itemMatch !== null) {
      const keys = Object.keys(data)
      const last = keys[keys.length - 1]
      if (last !== undefined && Array.isArray(data[last])) {
        data[last].push(unquote(itemMatch[1].trim()))
      } else {
        warnings.push(`frontmatter line ${i + 1}: list item with no preceding key`)
      }
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (kv === null) {
      warnings.push(`frontmatter line ${i + 1}: not a key: value pair — ${JSON.stringify(line)}`)
      continue
    }
    const key = kv[1]
    const valueText = kv[2].trim()

    if (valueText === '') {
      // `tags:` followed by block items, or a genuinely empty value. Declared
      // as an empty list and filled by the following `-` lines if any appear.
      data[key] = LIST_KEYS.has(key) ? [] : null
      continue
    }

    if (valueText.startsWith('[') && valueText.endsWith(']')) {
      data[key] = splitInlineList(valueText)
      continue
    }

    data[key] = coerce(key, valueText)
  }

  return data
}

/** Decide a scalar's type from its key, never from its appearance alone. */
function coerce(key, valueText) {
  const text = unquote(valueText)
  if (LIST_KEYS.has(key)) return [text]
  if (STRING_KEYS.has(key)) return text
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  // Only bare integers and decimals become numbers; a date keeps its dashes.
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** Strip matching single or double quotes. */
function unquote(valueText) {
  const s = String(valueText).trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/** `[a, b, "c, d"]` -> `["a", "b", "c, d"]`. Commas inside quotes are kept. */
function splitInlineList(valueText) {
  const inner = valueText.slice(1, -1)
  const out = []
  let current = ''
  let quote = null
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { out.push(current.trim()); current = ''; continue }
    current += ch
  }
  out.push(current.trim())
  return out.filter((s) => s !== '')
}

/**
 * Render frontmatter from a data object.
 *
 * Returns an **empty string** when there is nothing to write. Emitting a bare
 * `---\n---` pair instead would be actively destructive: on the next read the
 * parser would swallow the whole document as an (empty) frontmatter block and
 * the file would come back with no body at all. Observed, not hypothetical.
 *
 * @param data - `{ key: value }`; arrays render as inline lists.
 * @param order - preferred key order.
 * @returns the block including both fences and a trailing newline, or `''`.
 */
export function renderFrontmatter(data, order = []) {
  const source = data !== null && typeof data === 'object' ? data : {}
  // Only keys with an actual value count; null means "known but empty" and is
  // still written, but a missing key is not.
  const present = Object.keys(source).filter((k) => source[k] !== undefined)
  if (present.length === 0) return ''

  const keys = order.filter((k) => present.includes(k)).concat(present.filter((k) => !order.includes(k)))
  const lines = [FENCE]
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => renderScalar(v)).join(', ')}]`)
      continue
    }
    if (value === null) {
      lines.push(`${key}:`)
      continue
    }
    lines.push(`${key}: ${renderScalar(value)}`)
  }
  lines.push(FENCE)
  return lines.join('\n') + '\n'
}

/** Render one scalar, quoting only when the bare form would be ambiguous. */
function renderScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value)
  // Quote when the text would not survive a re-read unchanged: empty or padded
  // values, anything starting with a YAML indicator, an embedded `: ` or `,`
  // that could read as structure, a boolean/null/number lookalike, or a value
  // already wrapped in quotes.
  if (s === ''
    || /^[\s]|[\s]$/.test(s)
    || /^[[\]{}"'#&*!|>%@`,]/.test(s)
    || /: |:$|,$/.test(s)
    || /^(true|false|null|~)$/i.test(s)
    || /^-?\d+(\.\d+)?$/.test(s)
    || /^["']/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

/**
 * Replace or insert the frontmatter block of a document.
 *
 * The body is appended **verbatim**. When frontmatter already exists it is
 * replaced in place; otherwise it is prepended.
 *
 * @param text - the whole file.
 * @param data - the frontmatter to write.
 * @param order - preferred key order.
 * @returns the new file contents.
 */
export function writeFrontmatter(text, data, order = []) {
  const { body, present } = parseFrontmatter(text)
  const block = renderFrontmatter(data, order)
  if (block === '') return String(text ?? '')
  // `block` already ends with a newline after the closing fence. Exactly one
  // blank line then separates it from the body, matching the convention the
  // rest of the campaign files use. `parseFrontmatter` returns the body with
  // its own leading newline still attached, so it is stripped once — no more,
  // and none when absent, since blank lines inside a body are content.
  const rest = present ? body.replace(/^\n/, '') : String(text ?? '')
  return rest === '' ? block : `${block}\n${rest}`
}
