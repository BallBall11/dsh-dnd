/**
 * tools/encounter-io.mjs — reading and writing a character's ENCOUNTER file.
 *
 *   <name>.encounter.json    transient combat state — turn order, live effects
 *
 * ## Why this file exists at all, and why it is not the state file
 *
 * The three parts of a character have three different lifetimes:
 *
 *   <name>.md             narrative + frontmatter — durable, hand-edited
 *   <name>.state.json     the numbered sheet       — durable, schema-owned
 *   <name>.encounter.json TRANSIENT combat state   — deliberately ephemeral
 *
 * Turn order, the round counter, and (later) live effects are true only for the
 * duration of one fight. Putting them in `.state.json` would make them subject
 * to the schema's validation and serialization, and would mean that "roll
 * initiative" is an edit to the character's canonical sheet — a change that
 * survives a long rest, appears in every diff of the character, and has to be
 * explainable to a validator that exists to protect ability scores and HP.
 * None of that is true of a turn order.
 *
 * Writing them into `state.md` was the other candidate the task considered. It
 * is rejected for a different reason: `state.md` is PROSE that the DM and the
 * player both edit by hand. A machine-written turn order dropped into it would
 * be overwritten by the next hand edit, and its presence would make the file's
 * shape depend on whether a fight happened to be running.
 *
 * So encounter state gets its own file. It is machine-owned, it is keyed by
 * character, and deleting it is always safe — the worst outcome is that the DM
 * re-rolls initiative.
 *
 * ## Two writers, one file
 *
 * Turn order (the initiative tool) and live effects (the timed-effects tool)
 * both belong to the same file, and they are written by DIFFERENT tool families.
 * The rule that keeps them from destroying each other is: **read the whole file,
 * change only your own keys, write it back**. `mergeEncounter` is the one place
 * that does it, so neither family can accidentally replace the file wholesale.
 * A missing section is normal, never an error, and no reader may assume the
 * other section is present.
 *
 * ## Ownership
 *
 * T8 owns `initiative` and `turnOrder`. T9 owns `effects`, `concentration`
 * and `deathSaves` (encounter-scoped). Either may be absent.
 *
 * ## Reads never write
 *
 * `readEncounter` is pure, like `readCharacter`: it returns an empty encounter
 * for a file that does not exist rather than materializing one. Creating the
 * file is a decision for a writer.
 */

import { readTextOrUndefined, parseJsonLoose, listFiles } from './shared.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'

/** The section this module's own tool family owns. */
export const INITIATIVE_SECTION = 'initiative'

/** The section the timed-effects family owns; named here so both can see it. */
export const EFFECTS_SECTION = 'effects'

/** Bumped only if the encounter file's shape changes incompatibly. */
export const ENCOUNTER_VERSION = 1

/** `<dir>/<name>.encounter.json` */
export function encounterPath(dir, name) {
  return `${dir}/${name}.encounter.json`
}

/**
 * An empty encounter, for a character that has never been in a fight.
 *
 * Returned by `readEncounter` instead of null so every reader can index into
 * the result without a null-check — the same reasoning as `ALWAYS_PRESENT` in
 * state-schema.mjs. Use `malformed` to distinguish "no file" from "unreadable
 * file".
 *
 * @returns a fresh empty encounter object.
 */
export function emptyEncounter() {
  return { version: ENCOUNTER_VERSION, sections: {} }
}

/**
 * Read one character's encounter file.
 *
 * Never throws. A missing file yields an empty encounter with `exists: false`;
 * a corrupt file yields an empty encounter with `malformed: true` AND the
 * warning text, because those two cases call for different behaviour. Silently
 * treating a corrupt file as empty is how a running fight's turn order would
 * vanish without anyone being told.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory (absolute).
 * @param name - the sheet filename stem, e.g. `alice`.
 * @returns `{ encounter, exists, malformed, warnings }`. `encounter` is never
 *   null.
 */
export async function readEncounter(fs, dir, name) {
  const warnings = []
  const text = await readTextOrUndefined(fs, encounterPath(dir, name))
  if (text === undefined) {
    return { encounter: emptyEncounter(), exists: false, malformed: false, warnings }
  }

  let parsed
  try {
    // BOM tolerance via the house `stripBom`/parseJsonLoose pair: a file this
    // bundle writes has no BOM, but one a human repaired in Notepad on Windows
    // will, and JSON.parse rejects \uFEFF with "Unexpected token".
    parsed = parseJsonLoose(text)
  } catch (error) {
    warnings.push(`${name}.encounter.json could not be parsed (${error && error.message ? error.message : error}); treating it as empty`)
    return { encounter: emptyEncounter(), exists: true, malformed: true, warnings }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${name}.encounter.json is not a JSON object; treating it as empty`)
    return { encounter: emptyEncounter(), exists: true, malformed: true, warnings }
  }

  const sections = parsed.sections !== null && typeof parsed.sections === 'object' && !Array.isArray(parsed.sections)
    ? parsed.sections
    : {}
  return {
    encounter: {
      version: typeof parsed.version === 'number' ? parsed.version : ENCOUNTER_VERSION,
      sections,
    },
    exists: true,
    malformed: false,
    warnings,
  }
}

/**
 * Merge one section into an encounter WITHOUT dropping anything else.
 *
 * The whole reason two tool families can share this file. `sections` is spread
 * first and the incoming key written after, so a writer touches exactly one
 * section key:
 *
 *   - the other family's section survives untouched
 *   - an unknown section a future family adds survives untouched
 *   - the top-level `version` survives
 *
 * A shallow merge is correct here rather than a deep one: sections are
 * independent by construction, and a deep merge would let a writer resurrect
 * half of a section it meant to replace wholesale.
 *
 * @param encounter - the encounter as read (may be an empty one).
 * @param sectionName - the key to write, e.g. `'initiative'`.
 * @param value - the value to store under that key.
 * @returns a new encounter object; the input is not mutated.
 */
export function mergeEncounter(encounter, sectionName, value) {
  const base = encounter !== null && typeof encounter === 'object' ? encounter : emptyEncounter()
  const sections = base.sections !== null && typeof base.sections === 'object' && !Array.isArray(base.sections)
    ? base.sections
    : {}
  return {
    version: typeof base.version === 'number' ? base.version : ENCOUNTER_VERSION,
    sections: { ...sections, [sectionName]: value },
  }
}

/**
 * Read one section of an encounter, tolerating its absence.
 * @param encounter - an encounter as returned by `readEncounter`.
 * @param sectionName - the key to read.
 * @returns the section value, or undefined.
 */
export function sectionOf(encounter, sectionName) {
  const sections = encounter?.sections
  if (sections === null || typeof sections !== 'object') return undefined
  return sections[sectionName]
}

/**
 * Write one character's encounter file.
 *
 * ## The sandbox policy travels the same path as every other write
 *
 * `sandboxPolicy` is forwarded as the 5th argument to `fs.writeText`, exactly
 * as state-io.mjs does. That argument decides which ROOT the write is judged
 * against; omitting it is the defect that made every campaign write refusable,
 * because the fs sandbox then falls back to a root derived from the harness
 * process's cwd. The caller resolves it from the tool call's own session (see
 * session-scope.mjs). `undefined` is a legitimate value and is forwarded
 * rather than replaced with a default: no session means the platform's existing
 * fail-closed process-cwd fallback, never a guessed root.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @param name - the sheet filename stem.
 * @param encounter - the full encounter to write.
 * @param sandboxPolicy - a resolved `SandboxExecutionPolicy` for the CALLING
 *   SESSION, or undefined.
 * @returns `{ path }`.
 */
export async function writeEncounter(fs, dir, name, encounter, sandboxPolicy) {
  const path = encounterPath(dir, name)
  const text = JSON.stringify(encounter, null, 2) + '\n'
  // Translated on refusal so a sandbox denial names the root and the remedy
  // instead of restating the mode (T7). Both encounter families go through
  // here, so both get the same message.
  await withWriteDiagnosis(
    async () => fs.writeText(await fs.resolve(path), text, undefined, undefined, sandboxPolicy),
    { policy: sandboxPolicy, operation: 'encounter write' },
  )
  return { path }
}

/**
 * Drop this family's section from an encounter, leaving everything else.
 *
 * ## Why this is a merge and not a delete
 *
 * The fs service exposes no delete/remove at all — its contract is resolve /
 * stat / readText / listDir / writeText / editText. There is nothing to call.
 *
 * That turns out to be the RIGHT shape rather than a limitation to work around.
 * Ending an encounter must not remove the whole file, because the timed-effects
 * family may still hold live state in it, and because "the file is gone" and
 * "the fight is over" are different facts. So ending a fight rewrites THIS
 * family's section and leaves the file in place, which:
 *
 *   - leaves the other family's section byte-intact
 *   - leaves the file present, so the campaign tree's shape does not depend on
 *     whether a fight happens to be running
 *   - goes through the SAME policy-threaded write path as every other write
 *
 * A shallow "delete the key" would also work, but an explicit marker is
 * preferred: it lets a later reader tell "this encounter is over" from "no
 * encounter was ever rolled", which look identical in a file that simply has no
 * `initiative` key.
 *
 * ## `sectionName` is a REQUIRED parameter, and that is the whole point
 *
 * An earlier draft of this function hard-coded `INITIATIVE_SECTION`. It was
 * published as a SHARED helper, so the effects family would have called it and
 * silently overwritten the initiative section with its own marker — destroying
 * the other family's live turn order while reporting a `hadSection` computed
 * against the wrong key. Neither half would have raised an error: the turn
 * order would simply be gone.
 *
 * So the section name is explicit and has NO default. A default is the same bug
 * wearing a shorter call site — the effects family would omit the argument and
 * land back on `initiative`. Every caller must name the section it owns.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @param name - the sheet filename stem.
 * @param encounter - the encounter as read.
 * @param sectionName - the section THIS caller owns, e.g. `INITIATIVE_SECTION`.
 *   Required; omitting it is a programming error and throws rather than
 *   defaulting.
 * @param marker - the value to store under that section key.
 * @param sandboxPolicy - the calling session's resolved policy, or undefined.
 * @returns `{ hadSection }` — false when that section was absent, so the
 *   caller can report "there was nothing running" rather than claiming to have
 *   ended one.
 */
export async function clearEncounterSection(fs, dir, name, encounter, sectionName, marker, sandboxPolicy) {
  if (typeof sectionName !== 'string' || sectionName.trim() === '') {
    // Thrown, not defaulted. A default here is precisely the bug described
    // above: the other family omits the argument and clears the turn order.
    throw new Error('encounter-io: clearEncounterSection needs an explicit sectionName')
  }
  const sections = encounter !== null && typeof encounter === 'object' && encounter.sections !== null
    && typeof encounter?.sections === 'object'
    ? encounter.sections
    : {}
  const hadSection = Object.prototype.hasOwnProperty.call(sections, sectionName)
  await writeEncounter(fs, dir, name, mergeEncounter(encounter, sectionName, marker), sandboxPolicy)
  return { hadSection }
}

/**
 * List the character stems that currently HAVE an encounter file.
 *
 * Used by the read tool's "which encounters are running?" answer. Like every
 * other read here it never writes, and a directory it cannot read yields an
 * empty list rather than an error.
 *
 * @param fs - the host fs service.
 * @param dir - the character directory.
 * @returns an array of stems, sorted.
 */
export async function listEncounters(fs, dir) {
  const files = await listFiles(fs, dir)
  const stems = []
  for (const file of files) {
    const m = String(file.name).match(/^(.*)\.encounter\.json$/i)
    if (m !== null && m[1] !== '') stems.push(m[1])
  }
  return stems.sort((a, b) => a.localeCompare(b))
}
