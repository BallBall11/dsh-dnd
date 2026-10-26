# dsh-dnd

Domain language for dsh-dnd — a bundle that runs a D&D 5e campaign through the
DeepSeek Harness: Host tools for the DM (the agent) and a Client panel for the
table. Two rules underlie most of the language: every number has exactly one
home, and a refused write changes nothing.

## Language

### Character model

**Character**:
A player character or NPC the bundle tracks, stored as exactly two files — a
State File and a Sheet. Every number lives in one of them, never both.
_Avoid_: PC, sheet (the sheet is one half, not the whole)

**State File**:
The authoritative, structured half of a character (`<name>.state.json`):
abilities, HP, AC, skills, spell slots, spells, equipment, purse, conditions,
XP. The numbers live here and nowhere else.
_Avoid_: state (bare), JSON file

**Sheet**:
The narrative half of a character (`<name>.md`): frontmatter, the generated
summary, and the player's own prose. Its narrative is never parsed into fields
and never reformatted.
_Avoid_: prose file, markdown file

**Legacy Layout**:
The pre-split arrangement in which a sheet carried its structured sections
inline. It still reads — state is derived from the sheet on read — but
migration to the two-file model is an explicit write, never a side effect of
reading.
_Avoid_: legacy sheet, old format

**Generated Summary**:
The auto-generated summary block inside a sheet, regenerated on every write.
The narrative around it is the player's and is never touched.

**Card**:
The human-readable rendering of a character or enemy, as opposed to raw JSON.
_Avoid_: sheet (a card is a view, not a file)

**Party**:
All the characters of one campaign, readable in a single call.

### Money

**Purse**:
A character's money as one integer of copper pieces. Denominations exist only
at the edges — parsed on input, produced for display — and affordability is
judged on the total, so 800 cp can pay a 15 cp cost with no copper pieces on
hand.
_Avoid_: coin, currency, wallet, money

**Denomination**:
A money unit (gp / sp / cp) that appears only when parsing input or formatting
display; it is never a stored field.

### Time

**World Clock**:
The in-world time of a campaign (the `worldTime` stamp), kept in its calendar.
One campaign has exactly one world clock, and it never runs backwards.
_Avoid_: clock (bare), game time

**Real Clock**:
The real-world date (the `updated` stamp) written on every write alongside the
world clock. The two clocks are independent: advancing one does not move the
other.
_Avoid_: wall clock, timestamp (bare)

**Calendar**:
The campaign-level record that keeps the world clock. Advancing it is a write;
asking it the time is a read that changes nothing.
_Avoid_: clock (the clock is the time; the calendar is the record)

### Write path

**Read Tool**:
A tool that never writes. The panel can poll read tools freely, because a call
that asks a question must not change the answer.
_Avoid_: pure tool

**Write Tool**:
A tool that mutates state. It applies the caller's intent as stated — a DM
saying "take 5 damage" twice means 10 — unless an idempotency key says
otherwise.
_Avoid_: mutation tool

**Refused Write**:
A rejected change that leaves every file exactly as it was: an unaffordable
purchase is refused rather than recorded as debt, a negative advance of time is
refused. A refusal is a judgement, not an error.
_Avoid_: failed write, rejected write

**Validation Finding**:
A problem in the data, reported explicitly to the tool output and the panel
instead of silently clamped away. A plausible number that is not true is the
failure this design refuses to ship.
_Avoid_: error, warning

**Idempotency Key**:
An optional, caller-chosen key that makes a repeated write a no-op reported as
a duplicate, so a retry cannot double-charge.
_Avoid_: dedupe key, request id

**Plan**:
A computed preview of a write, shown before anything is applied; the write
happens only when the caller confirms.

**Business Judgement**:
The decision about whether a request makes sense — can this be afforded, is
this level-up justified — made at the tool layer where the DM sees it. The
write layer's validation is only a backstop for states that cannot exist.

### SRD data

**Ruleset**:
One of the two supported editions of the SRD: 2014 or 2024. Every lookup and
every character names its ruleset.
_Avoid_: edition, version

**Statblock**:
A structured SRD monster entry — HP, AC, attacks, abilities — from which
enemies are generated.
_Avoid_: monster entry

**Curated Entry**:
A hand-maintained SRD addition beyond the upstream datasets, always labelled
curated in lookup output.
_Avoid_: supplemental, custom entry

**Rename Map**:
The official 2014→2024 name conversion, used as a fallback so a query that
misses under one ruleset can resolve under the other.
_Avoid_: alias table

### Campaign & play

**Campaign**:
The top-level container: characters, the campaign state, the calendar, and the
markdown corpus, all under one directory.
_Avoid_: save, world

**Active Campaign**:
The one campaign the tools currently operate on, chosen by the active-campaign
marker. Every tool resolves "the campaign" through it.
_Avoid_: current campaign, selected campaign

**Campaign State**:
The campaign-wide shared document (`state.md`): current situation, active
quests, open threads, live state flags, world state, recent events.
_Avoid_: state file (that belongs to a character)

**Corpus**:
The set of campaign-level markdown files — state, world, npcs, arc, session
log, source. Search it before reading whole files.

**Note**:
A dated entry appended to the session log — loot handed out, a plot hook
planted, a recap, or freeform notes — dated with the world clock.
_Avoid_: journal entry, log entry

**Arc**:
The campaign's story structure of acts and beats, tracked so the tools can
report where the story stands.

**Encounter**:
The active fight: its turn order, its death saves, and its elapsed effects
persist across calls until it ends.
_Avoid_: combat, battle

**Combatant**:
A participant in the initiative order — a PC or an NPC.
_Avoid_: fighter, participant

**Roll Mode**:
Who rolls initiative: `players` (a PC's player rolls; the tool never does) or
`dm`/`auto` (the tool rolls everything). A campaign sets a default; a call may
override it.
_Avoid_: dice mode

**Enemy**:
A hostile character card generated from an SRD statblock. Multiple enemies are
independent cards, never one group HP pool.
_Avoid_: monster, mob, NPC (an NPC need not be hostile)

**Effect**:
A timed condition or buff on a character, with a duration that ticks against
the world clock; at most one of them can require concentration.
_Avoid_: buff, spell effect

### Platform

**Bundle**:
The installable package: the Host tool families plus the Client panel, mounted
into the harness web profile.
_Avoid_: plugin, mod

**Host**:
The harness process that runs the tools and serves the routes.
_Avoid_: server, backend

**Panel**:
The Client-side character panel. It renders what the Host sends and formats
almost nothing itself, so there is no second place to drift.
_Avoid_: UI, dashboard, client

**Session Workspace**:
The calling session's working directory, from which every data root is
resolved at call time. No machine-specific path is ever baked into the
production surface.
_Avoid_: cwd, data root
