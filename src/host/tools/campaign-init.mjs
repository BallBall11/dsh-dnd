/**
 * tools/campaign-init.mjs — campaign bootstrap and workspace status.
 *
 *   dnd_campaign_status  the data root, every campaign on it, which is active
 *   dnd_campaign_create  scaffold a new campaign and make it the active one
 *
 * ## Why this family exists
 *
 * Every other campaign tool assumes a campaign ALREADY exists: `locate` finds
 * the marker, or the tool answers "No active campaign". Neither answer tells a
 * fresh workspace what to do next, and no tool could list campaigns or create
 * one. A GM preset asked to "set up a new campaign" therefore answered with
 * shell commands — Get-ChildItem over the home directory, grepping for the
 * runtime marker — because the filesystem was the only interface left that
 * knew anything about the layout. Discovery and creation are tool jobs, not
 * shell jobs, for the same reason `dnd_character_create` exists: the format
 * must be served, not guessed.
 *
 * `dnd_campaign_status` answers the questions the shell was being used for:
 * where is the data root (and WHY that one), what campaigns exist, which is
 * active, and is the marker stale. `dnd_campaign_create` writes the scaffold —
 * state.md with the section headings the read tools expect, arc/world/npc/
 * session-log documents — and, unless told otherwise, points the
 * active-campaign marker at it in the same call, so "create a campaign" is
 * one step and the next tool call just works.
 *
 * ## Write posture
 *
 * The scaffold files are new files under `campaigns/<name>/`; there is no
 * overwrite path. An existing campaign directory is refused — campaign
 * documents have no appliedKeys ledger and no lock-serialized diff, so a
 * "replace" here would be a silent clobber, and this bundle does not ship
 * those. The marker is written LAST: a scaffold that half-fails leaves no
 * active-campaign marker behind, so the workspace is never left pointing at a
 * campaign that does not fully exist.
 *
 * All writes go through `fs.writeText` with the session's resolved sandbox
 * policy (writePolicyFor), exactly like the character and calendar writes.
 * The fs contract has no mkdir: if the backend will not create
 * `campaigns/<name>/` as a side effect of writing into it, the backend's own
 * error travels to the caller verbatim — the tool never invents a filesystem.
 */

import {
  ROOT_ERROR,
  activeCampaignDir,
  dndRoot,
  exists,
  readActiveCampaign,
  readCampaignRuleset,
  readTextOrUndefined,
} from './shared.mjs'
import { listCharacters } from './state-io.mjs'
import { formatWorldTime, readCalendar } from './clock.mjs'
import { sessionOf, writePolicyFor } from './session-scope.mjs'
import { withWriteDiagnosis } from './write-errors.mjs'

/** Render a plain string result for the model. */
const renderText = (_args, value) => [{ type: 'text', text: String(value) }]

export const name = 'dnd-campaign-init'

/** The section headings a scaffolded state.md carries; campaign.mjs reads these. */
const STATE_SECTIONS = [
  ['Current Situation', '- **Location:** \n- **Party:** \n'],
  ['Active Quests', '- \n'],
  ['Open Threads', '- \n'],
  ['Live State Flags', '- **roll_mode:** auto\n'],
  ['World State', '- \n'],
  ['Campaign Arc', '- **Act:** 1\n- **Beat:** setup\n'],
  ['Pinned Facts', '- \n'],
  ['DM Style Notes', '- \n'],
  ['Recent Events', '- \n'],
]

/** A legal campaign directory name: lowercase slug. No traversal, no spaces. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Build this module's tools.
 * @param ctx - host context.
 * @returns an array of tool definitions.
 */
export function buildTools(ctx) {
  const getFs = () => ctx.get('fs')

  const status = {
    name: 'dnd_campaign_status',
    description: 'Report the D&D workspace: which data root is in effect (session workspace or DND_ROOT env) and why, every campaign directory under campaigns/, which one is active, and each campaign\'s shape (state.md present, ruleset, character counts). Call this FIRST when opening or setting up a workspace — it replaces exploring the filesystem with shell commands.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(_args, exec) {
      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const root = dndRoot(sessionOf(ctx, exec))
      if (root === undefined) return ROOT_ERROR

      const lines = [`**Data root:** ${root}`]
      const active = await readActiveCampaign(fs, { header: { cwd: root } })
      const activeDir = active !== undefined ? `${root}/campaigns/${active}` : undefined
      if (activeDir !== undefined && !(await exists(fs, activeDir))) {
        lines.push(`**Active campaign:** ${active} — MARKER STALE: ${activeDir} does not exist. Re-load or create a campaign.`)
      } else {
        lines.push(`**Active campaign:** ${active ?? 'none'}`)
      }

      // List every campaign directory. `campaigns` itself may not exist on a
      // brand-new workspace: that is the "empty workspace" answer, not an error.
      const names = await listCampaignDirs(fs, root)

      if (names.length === 0) {
        lines.push('**Campaigns:** none. Create one with dnd_campaign_create (name, ruleset), or load an existing one with /dm:dnd load <campaign>.')
        return lines.join('\n')
      }

      lines.push('**Campaigns:**')
      for (const campaign of names) {
        const dir = `${root}/campaigns/${campaign}`
        const summary = await campaignShape(fs, dir, campaign === active)
        lines.push(`- ${campaign}${campaign === active ? ' (active)' : ''}\n  ${summary}`)
      }
      lines.push('To start a new campaign: dnd_campaign_create. To switch: /dm:dnd load <campaign>.')
      return lines.join('\n')
    },
  }

  const create = {
    name: 'dnd_campaign_create',
    description: 'Create a new campaign: scaffold campaigns/<name>/ with state.md (Current Situation / Active Quests / Open Threads / Live State Flags / World State / Recent Events), arc.md, world.md, npcs.md and session-log.md, then write the active-campaign marker so every other dnd tool targets it. Refuses an existing campaign (no overwrite path). Afterwards use dnd_character_create to add characters.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Campaign slug: lowercase letters, digits, hyphens, e.g. "saltmarsh-tide". Required.' },
        ruleset: { type: 'string', description: '"2014" (default) or "2024" — which SRD the campaign runs under. Also settable later in state.md.' },
        title: { type: 'string', description: 'Display title, e.g. "The Tide of Saltmarsh". Defaults to the slug.' },
        description: { type: 'string', description: 'One-line premise, written into state.md under Current Situation.' },
        activate: { type: 'boolean', description: 'Point the active-campaign marker at the new campaign. Default true.' },
      },
      required: ['name'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      // Arguments are validated BEFORE anything is located — a missing `name`
      // must be diagnosed as such, not answered with a root error the caller
      // cannot connect to its mistake.
      const rawName = args.name === undefined || args.name === null ? '' : String(args.name).trim()
      const name = rawName.toLowerCase().replace(/\s+/g, '-')
      if (name === '') {
        return 'dnd_campaign_create needs a `name` — the campaign slug, e.g. "saltmarsh-tide". Nothing was written.'
      }
      if (!NAME_PATTERN.test(name)) {
        return `dnd_campaign_create refused — "${rawName}" is not a legal campaign slug (lowercase letters, digits, hyphens). Nothing was written.`
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const session = sessionOf(ctx, exec)
      const root = dndRoot(session)
      if (root === undefined) return ROOT_ERROR

      const ruleset = String(args.ruleset ?? '2014') === '2024' ? '2024' : '2014'
      const title = args.title !== undefined && String(args.title).trim() !== '' ? String(args.title).trim() : name
      const description = args.description !== undefined && String(args.description).trim() !== ''
        ? String(args.description).trim()
        : ''

      const dir = `${root}/campaigns/${name}`
      if (await exists(fs, dir)) {
        return `dnd_campaign_create refused — ${dir} already exists. Campaigns have no overwrite path; load it with /dm:dnd load ${name} or choose another name. Nothing was written.`
      }

      const policy = writePolicyFor(ctx, exec)
      const files = scaffoldFiles({ name, title, ruleset, description, calendarYear: args.calendarYear, calendarHour: args.calendarHour })

      // Files first, marker last: a half-failed scaffold must not leave an
      // active-campaign marker pointing at a campaign that does not exist.
      // The backend's own error propagates verbatim — when it cannot create
      // the directory, the caller sees the real failure, not a paraphrase.
      const written = []
      try {
        for (const [path, text] of files) {
          await fs.writeText(await fs.resolve(`${root}/${path}`), text, undefined, undefined, policy)
          written.push(path)
        }
        if (args.activate !== false) {
          const marker = `${root}/.runtime/active-campaign.json`
          await fs.writeText(await fs.resolve(marker), JSON.stringify({ name }) + '\n', undefined, undefined, policy)
          written.push(marker)
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        return `dnd_campaign_create failed after writing ${written.length} file(s) (${written.join(', ') || 'none'}). `
          + `Backend error: ${message}. The workspace may be missing the campaigns/ directory — create it and retry.`
      }

      const activated = args.activate !== false ? ' and set it ACTIVE' : ''
      return `Created campaign "${title}" (${name}) under ${dir}${activated}. `
        + `Ruleset: ${ruleset}. Files: ${files.map(([p]) => p).join(', ')}. `
        + `A default calendar.json is included (Calendar of Harptos, from 1492 DR) so dnd_calendar works immediately — adjust it with dnd_calendar set when the campaign's date matters. `
        + `Next: add characters with dnd_character_create, then play — dnd_campaign_state reads the state.md this scaffold created.`
    },
  }

  /** One line per campaign: has state.md, ruleset, character counts. */
  async function campaignShape(fs, dir, isActive) {
    const stateText = await readTextOrUndefined(fs, `${dir}/state.md`)
    if (stateText === undefined) return 'no state.md — incomplete campaign'
    const ruleset = await readCampaignRuleset(fs, dir)
    const characters = await listCharacters(fs, `${dir}/characters`)
    const pcs = characters.filter((c) => c.hasStateFile).length
    return `state.md ok, ruleset ${ruleset}, characters: ${pcs}`
  }

  /**
   * Distinct campaign directories: entries of campaigns/ that ARE directories.
   * The fs listing is raw (listDir) because the shared helpers expose files
   * only — and a campaign with no markdown yet must still be listed.
   */
  async function listCampaignDirs(fs, root) {
    try {
      const target = await fs.resolve(`${root}/campaigns`)
      const info = await fs.stat(target)
      if (info === undefined || info.type !== 'directory') return []
      const entries = await fs.listDir(target)
      return entries
        .filter((e) => e.type === 'directory')
        .map((e) => e.name)
        .sort()
    } catch {
      return []
    }
  }

  const update = {
    name: 'dnd_campaign_update',
    description: 'Update a campaign DOCUMENT under the active campaign: state.md (default), arc.md, world.md, npcs.md or session-log.md. '
      + 'Ops: "set-section" (replace one ## section body — the text you pass is carried verbatim, so this is where freeform prose goes), '
      + '"append" (add lines at the end of a section, creating the section when missing), '
      + '"remove" (drop every line in a section containing `match`), '
      + '"flag" (set **name:** value under Live State Flags — the machine-read flags: roll_mode, town_alarm, ...), '
      + '"activate" (point the active-campaign marker at `name`, for loading an existing campaign at session start). '
      + 'The frontmatter and the `# title` / `**Ruleset:**` preamble always survive byte-for-byte, as do untouched sections. '
      + 'Refusals write nothing.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Which document: "state" (default), "arc", "world", "npcs", "session-log". Ignored by op "activate".' },
        op: { type: 'string', description: '"set-section", "append", "remove", "flag", or "activate".' },
        section: { type: 'string', description: 'The ## heading, e.g. "Current Situation". Required for set-section/append/remove. Case-insensitive exact match.' },
        body: { type: 'string', description: 'For op "set-section": the new section content, verbatim. Paragraphs and bullets are free.' },
        text: { type: 'string', description: 'For op "append": lines to add at the end of the section, verbatim.' },
        match: { type: 'string', description: 'For op "remove": every line containing this substring is removed.' },
        name: { type: 'string', description: 'For op "flag": the flag name. For op "activate": the campaign slug to make active.' },
        value: { type: 'string', description: 'For op "flag": the new value, e.g. "players", "high".' },
        create: { type: 'boolean', description: 'With op "set-section": create the section when it does not exist. Default: refuse and list the existing headings.' },
      },
      required: ['op'],
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args, exec) {
      const op = args.op === undefined || args.op === null ? '' : String(args.op).trim()
      const OPS = ['set-section', 'append', 'remove', 'flag', 'activate']
      if (!OPS.includes(op)) {
        return 'dnd_campaign_update needs `op`: one of ' + OPS.map((o) => '"' + o + '"').join(', ') + '. Nothing was written.'
      }

      const fs = getFs()
      if (fs === undefined) return 'fs service unavailable'
      const session = sessionOf(ctx, exec)
      const root = dndRoot(session)
      if (root === undefined) return ROOT_ERROR
      const policy = writePolicyFor(ctx, exec)

      // Activate only writes the runtime marker; it is how a session loads an
      // existing campaign without hand-writing JSON into .runtime/.
      if (op === 'activate') {
        const rawName = args.name === undefined || args.name === null ? '' : String(args.name).trim().toLowerCase()
        if (rawName === '') return 'dnd_campaign_update op "activate" needs `name` — the campaign slug. Nothing was written.'
        if (!(await exists(fs, `${root}/campaigns/${rawName}`))) {
          const listed = (await listCampaignDirs(fs, root)).join(', ') || 'none'
          return `No campaign "${rawName}" under ${root}/campaigns. Campaigns: ${listed}. Nothing was written.`
        }
        const marker = `${root}/.runtime/active-campaign.json`
        const previous = await readActiveCampaign(fs, { header: { cwd: root } })
        try {
          await withWriteDiagnosis(
            async () => fs.writeText(await fs.resolve(marker), JSON.stringify({ name: rawName }) + '\n', undefined, undefined, policy),
            { policy, operation: 'active-campaign marker write' },
          )
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          return 'dnd_campaign_update failed to write the marker. Backend error: ' + message
        }
        return previous === rawName
          ? `The active campaign was already ${rawName}; the marker now names it explicitly.`
          : `Active campaign switched: ${previous ?? '(none)'} -> ${rawName}. Re-read state.md for the new campaign's flags and situation.`
      }

      // Everything else edits one document of the ACTIVE campaign.
      const located = await activeCampaignDir(fs, session)
      if (located?.error !== undefined) return located.error
      if (located === undefined) {
        return 'No active campaign. Load one with /dm:dnd load <campaign>, or dnd_campaign_update op "activate" name=<slug>. Nothing was written.'
      }
      const fileArg = args.file === undefined || args.file === null || String(args.file).trim() === ''
        ? 'state'
        : String(args.file).trim().toLowerCase()
      if (!['state', 'arc', 'world', 'npcs', 'session-log'].includes(fileArg)) {
        return 'dnd_campaign_update: `file` must be state, arc, world, npcs or session-log (got "' + args.file + '"). Nothing was written.'
      }
      const path = `${located.dir}/${fileArg}.md`

      const sectionName = args.section === undefined || args.section === null ? '' : String(args.section).trim()
      const body = args.body === undefined || args.body === null ? '' : String(args.body)
      const text = args.text === undefined || args.text === null ? '' : String(args.text)
      const match = args.match === undefined || args.match === null ? '' : String(args.match).trim()

      if (op === 'flag') {
        const flagName = args.name === undefined || args.name === null ? '' : String(args.name).trim()
        const flagValue = args.value === undefined || args.value === null ? '' : String(args.value).trim()
        if (flagName === '' || flagValue === '') {
          return 'dnd_campaign_update op "flag" needs `name` and `value`, e.g. name "town_alarm" value "high". Nothing was written.'
        }
        return withDocLock(`${located.campaign}/${fileArg}.md`, async () => {
          const docText = await readTextOrUndefined(fs, path)
          if (docText === undefined) return `No ${fileArg}.md in campaign ${located.campaign}. Nothing was written.`
          const doc = splitDoc(docText)
          const idx = findDocSection(doc.sections, 'Live State Flags')
          if (idx === -1) {
            return `No "Live State Flags" section in ${fileArg}.md. Sections: ${doc.sections.map((s) => s.heading).join('; ') || 'none'}. Nothing was written.`
          }
          const s = doc.sections[idx]
          const marker = '**' + flagName + ':'
          const lineIndex = s.lines.findIndex((l) => l.includes(marker))
          let oldValue = null
          if (lineIndex === -1) {
            s.lines.push('- **' + flagName + ':** ' + flagValue)
          } else {
            const old = s.lines[lineIndex]
            const at = old.indexOf(':**') + 3
            oldValue = old.slice(at).replace(/\*$/, '').trim()
            s.lines[lineIndex] = '- **' + flagName + ':** ' + flagValue
          }
          s.raw = s.lines.join('\n')
          const out = joinDoc(doc.preamble, doc.sections)
          try {
            await withWriteDiagnosis(
              async () => fs.writeText(await fs.resolve(path), out, undefined, undefined, policy),
              { policy, operation: 'campaign document write' },
            )
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            return 'dnd_campaign_update failed. Backend error: ' + message
          }
          return oldValue === null
            ? `Flag ${flagName} set to ${flagValue} (it did not exist before).`
            : `Flag ${flagName}: ${oldValue} -> ${flagValue}.`
        })
      }

      if (sectionName === '') {
        return 'dnd_campaign_update: op "' + op + '" needs a `section` — the ## heading to edit. Nothing was written.'
      }
      if (op === 'set-section' && body.trim() === '') {
        return 'dnd_campaign_update: op "set-section" needs `body` — the new section content. Nothing was written.'
      }
      if (op === 'append' && text.trim() === '') {
        return 'dnd_campaign_update: op "append" needs `text` — the lines to add. Nothing was written.'
      }
      if (op === 'remove' && match === '') {
        return 'dnd_campaign_update: op "remove" needs `match` — the substring whose lines are removed. Nothing was written.'
      }

      return withDocLock(`${located.campaign}/${fileArg}.md`, async () => {
        const docText = await readTextOrUndefined(fs, path)
        if (docText === undefined) {
          return `No ${fileArg}.md in campaign ${located.campaign}. Nothing was written.`
        }
        const doc = splitDoc(docText)
        const headings = doc.sections.map((s) => s.heading)
        let idx = findDocSection(doc.sections, sectionName)

        if (idx === -1) {
          if (op !== 'set-section' || args.create !== true) {
            return `No section "${sectionName}" in ${fileArg}.md. Sections: ${headings.join('; ') || 'none'}. `
              + 'Pass create:true with op "set-section" to add a new one. Nothing was written.'
          }
          doc.sections.push({ heading: sectionName, lines: ['## ' + sectionName], raw: '## ' + sectionName + '\n' })
          idx = doc.sections.length - 1
          doc.sections[idx].raw = '## ' + sectionName + '\n\n' + body.trim() + '\n'
          const out = joinDoc(doc.preamble, doc.sections)
          try {
            await withWriteDiagnosis(
              async () => fs.writeText(await fs.resolve(path), out, undefined, undefined, policy),
              { policy, operation: 'campaign document write' },
            )
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            return 'dnd_campaign_update failed. Backend error: ' + message
          }
          return `Created section "${sectionName}" in ${fileArg}.md and wrote the content.`
        }

        const s = doc.sections[idx]
        let note = ''
        let changed = false
        if (op === 'set-section') {
          const nextRaw = '## ' + s.heading + '\n\n' + body.trim() + '\n'
          if (nextRaw === s.raw) {
            return 'No change: "' + s.heading + '" already contains exactly that content. Nothing was written.'
          }
          s.raw = nextRaw
          s.lines = nextRaw.split('\n')
          note = `Section "${s.heading}" replaced.`
          changed = true
        } else if (op === 'append') {
          const lines = text.replace(/\r\n/g, '\n').split('\n')
          s.raw = s.raw.replace(/\n*$/, '\n') + lines.join('\n') + '\n'
          s.lines = s.raw.split('\n')
          note = `Appended ${lines.length} line(s) to "${s.heading}".`
          changed = true
        } else if (op === 'remove') {
          const before = s.lines.length
          s.lines = s.lines.filter((l, i) => i === 0 || !l.includes(match))
          const dropped = before - s.lines.length
          if (dropped === 0) {
            const sample = s.lines.slice(1, 6).join('\n')
            return 'No line in "' + s.heading + '" contains "' + match + '". '
              + (sample !== '' ? 'Section starts:\n' + sample : 'The section is empty.') + ' Nothing was written.'
          }
          s.raw = s.lines.join('\n') + '\n'
          note = `Removed ${dropped} line(s) from "${s.heading}".`
          changed = true
        }

        if (!changed) return 'Nothing was written.'

        // Reassemble and self-check BEFORE writing: the section must still be
        // locatable and the preamble byte-identical, or the write is refused —
        // a corrupted campaign document is worse than a stale one.
        const out = joinDoc(doc.preamble, doc.sections)
        const check = splitDoc(out)
        if (findDocSection(check.sections, sectionName) === -1) {
          return 'dnd_campaign_update refused: the edit would not leave "' + sectionName + '" locatable. Nothing was written.'
        }
        if (check.preamble !== doc.preamble) {
          return 'dnd_campaign_update refused: the edit would change the file preamble (frontmatter/title). Nothing was written.'
        }

        try {
          await withWriteDiagnosis(
            async () => fs.writeText(await fs.resolve(path), out, undefined, undefined, policy),
            { policy, operation: 'campaign document write' },
          )
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          return 'dnd_campaign_update failed. Backend error: ' + message
        }

        if (fileArg === 'state' && (op === 'append' && findDocSection(doc.sections, 'Recent Events') !== -1)) {
          const calendar = await readCalendar(fs, located.dir)
          const worldTime = formatWorldTime(calendar)
          if (worldTime !== null) note += ' (world time: ' + worldTime + ')'
        }
        return note
      })
    },
  }

  return [status, create, update]
}

/**
 * The scaffold, as (relative path, text) pairs in write order.
 *
 * The state.md shape follows the format real campaigns converged on: YAML
 * frontmatter for identity (campaign/title/ruleset), the `**Ruleset:**` line
 * the ruleset resolver reads, and `## ` sections — the six the read tools
 * expect plus the three real campaigns kept adding by hand (Campaign Arc,
 * Pinned Facts, DM Style Notes). A scaffold that omits them just teaches the
 * model to append them by hand.
 *
 * @param options - name, title, ruleset, description.
 */
export function scaffoldFiles({ name, title, ruleset, description, calendarYear, calendarHour }) {
  const dir = `campaigns/${name}`
  const premise = description !== '' ? `- ${description}\n` : ''
  const state = [
    '---',
    `campaign: ${name}`,
    `title: ${title}`,
    `ruleset: ${ruleset}`,
    '---',
    '',
    `# ${title}`,
    '',
    `**Ruleset:** ${ruleset}`,
    '',
    ...STATE_SECTIONS.map(([heading, body]) => `## ${heading}\n\n${body}`),
  ].join('\n')
  // A default calendar ships with the scaffold: dnd_calendar refuses to invent
  // one, and character worldTime stamps derive from it, so a campaign without
  // calendar.json is a campaign whose every clock is silently dead. The
  // Calendar of Harptos is the Forgotten Realms default; 1492 DR is the
  // conventional campaign year. Adjust in place when the table differs.
  const year = Number(calendarYear) > 0 ? Math.floor(Number(calendarYear)) : 1492
  const hour = Number(calendarHour) >= 0 && Number(calendarHour) <= 23 ? Math.floor(Number(calendarHour)) : 8
  const calendar = JSON.stringify({
    day: 1,
    month: 1,
    year,
    hour,
    month_length: 30,
    months: ['Hammer', 'Alturiak', 'Ches', 'Tarsakh', 'Mirtul', 'Kythorn',
      'Flamerule', 'Eleasis', 'Eleint', 'Marpenoth', 'Uktar', 'Nightal'],
    day_names: [],
    events: [],
  }, null, 2) + '\n'
  return [
    [`${dir}/state.md`, state],
    [`${dir}/calendar.json`, calendar],
    [`${dir}/arc.md`, `# ${title} — Arc\n\n## Campaign Arc\n\n- **Act:** 1\n- **Beat:** setup\n- **Next change:** \n`],
    [`${dir}/world.md`, `# ${title} — World\n\n## World State\n\n- \n`],
    [`${dir}/npcs.md`, `# ${title} — NPCs\n\n## NPCs\n\n- \n`],
    [`${dir}/session-log.md`, `# ${title} — Session Log\n\n## Recent Events\n\n${premise}`],
  ]
}

/**
 * Split a campaign document into its PREAMBLE (frontmatter, `# title`,
 * `**Ruleset:**` line — everything before the first `## ` heading) and its
 * `## ` sections. The preamble is carried opaquely: every op below reassembles
 * the file as preamble + sections, so frontmatter survives byte-for-byte no
 * matter which section changed.
 */
function splitDoc(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const preambleLines = []
  while (i < lines.length && !/^##\s/.test(lines[i])) {
    preambleLines.push(lines[i])
    i += 1
  }
  const sections = []
  let current = null
  for (; i < lines.length; i += 1) {
    const m = lines[i].match(/^##\s+(.*)$/)
    if (m !== null) {
      current = { heading: m[1].trim(), lines: [lines[i]] }
      sections.push(current)
    } else if (current !== null) {
      current.lines.push(lines[i])
    }
  }
  const withRaw = sections.map((s) => ({ heading: s.heading, lines: s.lines, raw: s.lines.join('\n') }))
  return { preamble: preambleLines.join('\n'), sections: withRaw }
}

/** Reassemble preamble + sections. Always newline-terminated. */
function joinDoc(preamble, sections) {
  const pre = preamble.replace(/\n*$/, '')
  const body = sections.map((s) => s.raw.replace(/\n*$/, '\n')).join('\n')
  return (pre !== '' ? pre + '\n\n' : '') + body
}

/** Case-insensitive section lookup; -1 when absent. */
function findDocSection(sections, name) {
  const wanted = String(name).trim().toLowerCase()
  return sections.findIndex((s) => s.heading.toLowerCase() === wanted)
}

/** Per-file write chain, same pattern as track.mjs's character lock. */
const docChains = new Map()
async function withDocLock(key, work) {
  const prior = docChains.get(key) ?? Promise.resolve()
  const run = prior.then(work, work)
  const link = run.then(() => undefined, () => undefined)
  docChains.set(key, link)
  try {
    return await run
  } finally {
    if (docChains.get(key) === link) docChains.delete(key)
  }
}
