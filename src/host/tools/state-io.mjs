/**
 * tools/state-io.mjs — reading and writing a character's two files.
 *
 * ## The model
 *
 * A character is stored as two files that never overlap:
 *
 *   `<name>.state.json`  structured state — the machine's authority
 *   `<name>.md`          frontmatter (file metadata) + summary + narrative
 *
 * `readCharacter` returns both, and this is the only correct way to obtain a
 * full character. Reading the `.md` alone yields narrative and metadata but no
 * numbers, because the numbers are not in it — they were moved out precisely
 * so there would be one copy of each fact.
 *
 * ## The migration case, and why it is handled here
 *
 * Sheets written before this design carry their structured sections inline in
 * the `.md`. `readCharacter` therefore has two sources to consider, and the
 * rule is:
 *
 *   .state.json exists  ->  it is the authority; the .md holds only narrative
 *   .state.json absent  ->  derive state from the .md (first read of an
 *                           unmigrated sheet) and report that migration is
 *                           available
 *
 * The second case must not silently rewrite anything. Reading a sheet is a
 * read; converting it is an explicit `writeCharacter` by a caller that asked
 * for it.
 *
 * ## Why reads never write
 *
 * The panel polls `readCharacter`. If reading could write, every page view
 * would be a filesystem mutation, and a bug in the panel would corrupt the
 * campaign. Reads are pure.
 */

import { splitSheet, composeSheet, dropLegacyMetadataLine } from './sheet-split.mjs'
import { serializeState, parseState, normalizeState, SCHEMA_VERSION } from './state-schema.mjs'
import { buildMetadata } from './clock.mjs'
import { validateState, hasErrors, formatFindings } from './state-rules.mjs'
import { readTextOrUndefined, listMarkdown } from './shared.mjs'

/** `<dir>/<name>.state.json` */
export function statePath(dir, name) {
  return `${dir}/${name}.state.json`
}

/**
 * Is this a complaint that a structured section is absent from the sheet?
 *
 * Those warnings are correct for an unmigrated sheet and wrong for a migrated
 * one, where the section's contents now live in `.state.json`. Matched by
 * wording, which is brittle — but the alternative is threading a flag through
 * the parser, and the wording is produced in one place. The phrases are kept
 * deliberately specific so an unrelated future warning is not swallowed.
 *
 * @param warning - one warning string from the sheet parser.
 */
function isStructuralWarning(warning) {
  return /No "## [A-Za-z &]+" section/.test(warning)
    || /No ability-score table found/.test(warning)
    || /No attack table found/.test(warning)
    || /No skill table found/.test(warning)
}

/** `<dir>/<name>.md` */
export function sheetPath(dir, name) {
  return `${dir}/${name}.md`
}

/**
 * Read one character.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory (absolute).
 * @param name - the sheet filename stem, e.g. `alice`.
 * @returns `{ name, state, narrative, metadata, title, warnings, needsMigration,
 *   hasStateFile }`. `state` is null only when neither source yields anything.
 */
export async function readCharacter(fs, dir, name) {
  const warnings = []
  const sheetText = await readTextOrUndefined(fs, sheetPath(dir, name))
  const stateText = await readTextOrUndefined(fs, statePath(dir, name))

  if (sheetText === undefined && stateText === undefined) {
    return { name, state: null, narrative: '', metadata: {}, title: null, warnings: [`no files found for "${name}"`], needsMigration: false, hasStateFile: false }
  }

  // The narrative half. Parsed even when a state file exists, because the
  // frontmatter and the prose both come from here.
  const sheet = sheetText !== undefined
    ? splitSheet(sheetText, { name })
    : { state: null, narrative: '', metadata: {}, title: null, sections: [], warnings: [] }

  const hasStateFile = stateText !== undefined

  // When a state file exists it is the authority, and the sheet is supposed to
  // be narrative only — its structured sections have MOVED. Warning that
  // "## Combat Stats" is missing would tell the DM their character is broken
  // when the numbers are sitting in the file right next to it, correct. So
  // structural warnings are dropped in that case; anything else the sheet
  // parser reported (a malformed frontmatter block, unreadable prose) still
  // surfaces, because the state file does not speak to those.
  for (const w of sheet.warnings ?? []) {
    if (hasStateFile && isStructuralWarning(w)) continue
    warnings.push(w)
  }

  let state = null
  let needsMigration = false

  if (hasStateFile) {
    const parsed = parseState(stateText)
    for (const w of parsed.warnings ?? []) warnings.push(w)
    state = parsed.state
    if (state === null) {
      // A corrupt state file must not silently fall back to the sheet: that
      // would show stale numbers as if they were current. Report it and let
      // the caller decide.
      warnings.push('state file could not be read; the character has no authoritative numbers')
    }
  } else {
    // Unmigrated sheet: its structured sections are the only source.
    state = sheet.state
    needsMigration = true
  }

  // Fill in what only the frontmatter knows. `name` is not in the state file's
  // own field set beyond identity, and a sheet renamed on disk should win.
  if (state !== null) {
    state = normalizeState({ ...state, name: state.name ?? sheet.metadata?.name ?? name })
  }

  return {
    name,
    state,
    narrative: sheet.narrative,
    metadata: sheet.metadata ?? {},
    title: sheet.title,
    warnings,
    needsMigration,
    hasStateFile,
  }
}

/**
 * Write one character.
 *
 * Writes the state file and re-composes the `.md` from the narrative plus a
 * fresh summary. **Only the narrative and the frontmatter are carried into the
 * `.md`**; the structured sections are not written back to it, because they
 * live in the state file.
 *
 * Both clocks are stamped: `updated` with the real date, `worldTime` from the
 * campaign calendar. Any change to state or narrative updates both, so a stale
 * timestamp cannot claim a file is current.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @param name - the sheet filename stem.
 * @param options - `{ state, narrative, metadata, calendar, player, campaign,
 *   now, backup }`.
 * @returns `{ written, backup, metadata, warnings }`.
 */
export async function writeCharacter(fs, dir, name, options = {}) {
  const warnings = []
  const { state, narrative, calendar = null, now = new Date() } = options

  const existing = await readTextOrUndefined(fs, sheetPath(dir, name))
  const priorMetadata = existing !== undefined ? splitSheet(existing, { name }).metadata : {}

  const metadata = buildMetadata({
    player: options.player ?? priorMetadata.player ?? null,
    campaign: options.campaign ?? priorMetadata.campaign ?? null,
    calendar,
    tags: options.tags ?? priorMetadata.tags ?? ['pc'],
    now,
  })

  const title = options.title ?? `# ${state?.name ?? name}`
  // The frontmatter written below carries player/campaign/updated, so the
  // legacy inline copy is superseded by definition. Stripping it here is what
  // keeps the fact in one place: on read the line survives, because it may be
  // the only copy, but on write a replacement is guaranteed.
  const cleanNarrative = dropLegacyMetadataLine(narrative ?? '')

  // Validate before writing, and refuse a state that cannot exist. Clamping
  // would be worse than the bug: a DM reading a plausible number has no way to
  // learn the character was in an impossible state. A refused write is
  // visible; a silently repaired one is not.
  const normalized = normalizeState(state ?? {})
  const findings = validateState(normalized)
  for (const line of formatFindings(findings)) warnings.push(line)
  if (options.strict !== false && hasErrors(findings)) {
    return {
      written: null,
      metadata,
      findings,
      warnings,
      refused: true,
      reason: 'refusing to write an invalid state: '
        + formatFindings(findings.filter((f) => f.level === 'error')).join('; '),
    }
  }

  const sheetText = composeSheet(cleanNarrative, normalized, { title, metadata })
  const stateText = serializeState(normalized)

  // The state file is written first: it is the authority, so if the second
  // write fails the pair is still readable with current numbers.
  await fs.writeText(await fs.resolve(statePath(dir, name)), stateText)
  await fs.writeText(await fs.resolve(sheetPath(dir, name)), sheetText)

  return { written: { state: statePath(dir, name), sheet: sheetPath(dir, name) }, metadata, findings, warnings, refused: false }
}

/**
 * List every character in a directory.
 *
 * A character is any `.md` file without its own `.state.json` sibling, or any
 * `.state.json`. Files are deduplicated by stem so a migrated character is
 * reported once.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @returns an array of `{ name, hasStateFile }`, sorted by name.
 */
export async function listCharacters(fs, dir) {
  const files = await listMarkdown(fs, dir)
  const names = new Map()
  for (const file of files) {
    const stem = file.name.replace(/\.md$/i, '')
    names.set(stem, { name: stem, hasStateFile: false })
  }
  // A state file with no .md is still a character; do not lose it.
  try {
    const target = await fs.resolve(dir)
    const entries = await fs.listDir(target)
    for (const entry of entries) {
      const m = String(entry.name).match(/^(.*)\.state\.json$/i)
      if (m === null) continue
      const stem = m[1]
      names.set(stem, { name: stem, hasStateFile: true })
    }
  } catch {
    // A missing directory simply has no characters.
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Read every character in a directory.
 * @returns `{ characters, warnings }` where each character is a readCharacter result.
 */
export async function readAllCharacters(fs, dir) {
  const listed = await listCharacters(fs, dir)
  const characters = []
  const warnings = []
  for (const { name } of listed) {
    const character = await readCharacter(fs, dir, name)
    for (const w of character.warnings) warnings.push(`${name}: ${w}`)
    characters.push(character)
  }
  return { characters, warnings }
}

export { SCHEMA_VERSION }
