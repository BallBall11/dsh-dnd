# Changelog

All notable changes to `dsh-dnd` are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versioning adheres to
[SemVer](https://semver.org/).

## [0.4.1] — 2026-10-05

### Fixed

- **`dnd_rest` short rests rolled every Hit Die as 0.** The tool's die
  callback received the die's SIDES (e.g. `10`) but parsed it as a die
  string, building `"1" + 10 = "110"`, which `parseDice` rejects — every
  face fell back to 0 and short rests healed only the CON modifier, a
  systematic under-heal that looked plausible. The face now goes through
  `1d<sides>`; an unusable spec throws instead of healing for free, and the
  suite asserts every reported face is within 1..sides.
- **`dnd_loot` accepts fractional CR literals ("1/4", "1/2", "1/8").** It
  used to demand `0.25` while its sibling `dnd_encounter_difficulty` asks
  for `"1/4"` — one concept, two formats. A shared `parseCr` answers both;
  bare numbers still pass.

## [0.4.0] — 2026-10-05

### Added

- **Six GM tool gaps closed** (plan: `docs/harness/GAP-TOOLS-PLAN.md`), aimed
  at an agent that plays the DM end to end:
  - `dnd_rest` — a short or long rest settled in one call, for one character
    or the whole party (`party: true`). Hit Dice are rolled by the tool with
    per-die detail; long-rest healing follows the campaign ruleset (2014 half,
    2024 full); spell slots, HD recovery and death saves reset together.
    Conditions are reported, never removed; timed effects are left to
    `dnd_effect` (cross-store, not atomic). Multi-die-type (multiclass) HD is
    refused in v1 rather than approximated.
  - `dnd_enemy_create` — hostile cards straight from an SRD statblock:
    `fromSrd` + `count` writes Prefix-1..N with accurate AC/HP/scores/CR, the
    attack prose landing verbatim in the narrative. Shares the character
    write path and `kind: 'enemy'` tag; only the tool surface is separate.
  - Enemy section in the panel: `GET /dnd/characters?include=enemies` adds
    hostile cards with REAL hp, AC and live conditions (the videogame view
    the players plan with); the default response is unchanged.
  - `dnd_attack` gained `target`: on a hit the rolled damage LANDS through
    the shared write path (one call = roll + blood), with `damageType`,
    `resistance` and `vulnerability`; an enemy at 0 HP is marked dead.
  - `dnd_encounter_difficulty` — the DMG method (threshold sums + monster
    count multiplier) rated 简单/中等/困难/致命, party levels read from the
    campaign's PCs; `dnd_loot` rolls CR-banded coin from the new
    `data/tables.json` (with `_meta`).
  - `dnd_note` — dated `loot`/`hook`/`recap`/`freeform` entries appended to
    the campaign's `session-log.md` under a per-campaign lock, deduplicated
    by tail fingerprint, searchable through `dnd_campaign_search`; it never
    touches `state.md`.
  - `dnd_level_up` — the advancement step `dnd_xp_add` deliberately leaves
    out. The default call plans from the class table of the campaign's
    ruleset dataset (HP gain by average or roll, proficiency bonus, full
    spell-slot totals with expended counts carried over, the level's
    features) and writes nothing; `confirm: true` applies through the shared
    write path once XP reaches the threshold (`force: true` is an explicit
    DM ruling). Ability score improvements and spell preparation are
    reported as the player's choices, never filled in.

### Changed

- **Damage consumes temporary HP first.** `dnd_track`'s `hp` damage used to
  drain `hp.current` directly while temp HP sat unspent — a character
  silently tougher than the rules allow. Both that path and `dnd_attack`'s
  new target mode now route through the shared rules in `apply-damage.mjs`.
- The GM preset's tool roster text covers the new tools and the panel's
  enemy section.

- **The panel's Chinese terminology is calibrated against 5etools-cn.** The
  EN→CN display map now follows the community site's own curated glossary
  (tjliqy/5etools-cn @ cn2.0, 47829 terms), resolved per category: spells
  from its `spell` table, weapon mastery from `itemMastery`, damage types
  from `variantrule` (强酸/寒冷/暗蚀), and the weapon-property set guarded
  against the glossary's bulk-category "Light"→光线 artifact. ~370 names
  changed (e.g. 引导神力, 荒野形态, 恶言相加, 魔契师, 顺劈→横扫), and the
  spell map grew to ~650 entries via the glossary's spell table.
  `scripts/calibrate-i18n.mjs` is the repeatable calibration pass; the
  glossary itself is not vendored.

### Added

- **The panel renders a full character sheet, in Chinese.** Three gaps closed
  at once. (1) Equipment: the panel now lists equipped weapons and armor with
  what they DO — damage dice, weapon properties, and under the 2024 rules the
  weapon's mastery property (the special action it grants), from a new
  `GET /dnd/meta` display index. (2) Class features: a sheet whose Features &
  Traits was never filled in now still shows the features the class table
  grants at the character's level (per ruleset, from the datasets), beside the
  sheet's own hand-written entries, which the Host now extracts from the
  narrative and ships per character. (3) Spells: each cantrip/prepared/book
  entry is a card with its Chinese name, ring/school, and the Host-parsed
  combat line (dice + damage type + save, e.g. "8d6 火焰 · DEX豁免"). A new
  `data/i18n-zh.json` (~350 spells plus abilities, skills, conditions, weapons,
  armor, mastery and common class features) backs the Chinese labels; a term
  the map lacks renders in English rather than breaking.

### Fixed

- **`dnd_attack` parses compound damage expressions.** `damage: "1d4+3+1d6"`
  — sneak attack's base-plus-extra-dice shape — used to hit and then report
  "(unparseable damage expression)", forcing the DM to split the roll across
  two `dnd_roll` calls. Damage now accepts any chain of dice and constant
  terms joined by +/- (per-term keep-highest/lowest still works); on a
  critical hit every dice term doubles while constants stay flat.
- **`dnd_track` reports overflow damage on the way to 0.** The clamp to 0 was
  correct, but discarding the overflow threw away exactly the number the
  massive-damage instant-death rule reads. The change line now states the
  overflow and judges it against HP max ("Overflow damage: 7 >= HP max 5 —
  INSTANT DEATH", or "< HP max N, no massive-damage death").

### Changed

- **`dnd_character_create` follows the campaign's declared ruleset.** The
  tool hardcoded ruleset 2014, so a wizard created in a campaign whose
  state.md declares `**Ruleset**: 2024` was born a spellbook caster (3
  cantrips, no prepared-spells line) instead of a prepared one — a
  structural difference, not cosmetics, since the 2024 caster model changes
  spell capacity on the player's panel. The tool now reads the active
  campaign's `**Ruleset**` frontmatter line and pulls the class skeleton
  (hit die, saves, spellcasting, class table) from the matching dataset,
  defaulting to 2014 when the campaign is silent; the ruleset used is echoed
  in the reply either way.

### Changed

- **2014→2024 renames resolve automatically.** Wired the official
  "Converting to SRD 5.2.1" guide's rename table in as
  `data/srd-2024-renames.json` (CC-BY-4.0): a 2024 lookup under an old SRD
  5.1 name ("goblin", "feeblemind") finds the renamed entry and says so
  ("renamed in SRD 5.2.1"), a 2014 lookup under a new name resolves back
  ("befuddlement" → Feeblemind), and stat blocks omitted from 5.2.1
  (Lizardfolk, Duergar, Drow, ...) report the guide's recommended
  replacement instead of a bare miss. Also audited the SRD 5.2.1 full text
  for fillable prose: classes open directly with their trait tables and
  backgrounds are mechanics-only in the SRD, so the remaining thin spots in
  `srd-2024.json` reflect the source, not omissions.

### Changed

- **2024 dataset gaps closed where the upstream allows.** An audit of
  `srd-2024.json` against its source (5e-bits `src/2024/en`, SRD 5.2,
  CC-BY-4.0) found: species/subspecies traits carried only name stubs with no
  text — `refresh-2024-srd.mjs` now joins `Traits.json` by index and fills all
  82 descriptions, failing loudly if any stub has no upstream match. And a
  2024 `class` lookup used to return an empty body (the upstream carries no
  class prose): the lookup now renders the structured class card instead —
  hit die, saves, training, spellcasting block, subclasses and the full
  20-level table. Remaining gaps are upstream limits, not omissions here:
  class prose, background prose and monster lore text simply do not exist in
  the 5e-bits 2024 source; backgrounds number 4 and feats 17 because that is
  the full set the SRD 5.2 covers.

### Changed

- **Data files renamed and the lookup's data flow made explicit.**
  `dnd5e_srd.json` → `srd-2014.json`, `dnd5e_srd_2024.json` →
  `srd-2024.json`, `dnd5e_srd_full.json` → `srd-2014-fulltext.json`,
  `dnd5e_supplemental.json` → `supplemental.json` — the old names left it
  unclear which file belonged to which ruleset. `dnd_srd_lookup` takes a
  `ruleset` argument again ("2014" default, "2024" supported): 2014 keeps its
  full-text class route and supplemental merge; 2024 is searched as-is from
  `srd-2024.json`, including its structured `classes` array. The wiring is
  documented in code and README, and a gap it exposed was closed:
  `supplemental.json` was never actually read by any tool. It is now merged
  into the lookup's scored scan, with curated entries labelled
  `(category · curated)` so SRD and supplement stay distinguishable. A missing
  supplemental file is reported as the broken install it is, not a silent
  no-op.

### Changed

- **Cards now carry a kind, and the panel lists PCs only.** A field session
  created a hostile statblock with `dnd_character_create` and it appeared in
  the player's panel beside the party: the tool stamped every card `pc` and
  nothing consumed the tag. `dnd_character_create` now takes
  `kind: "pc" | "npc" | "enemy"` (default `pc`, always the first frontmatter
  tag), and `GET /dnd/characters` excludes any card whose tags omit `pc` —
  counted in `counts.excludedNonPC`, still readable via `dnd_character_get`
  and trackable via `dnd_track`. Cards written before this existed have no
  tags and keep counting as PCs. The GM preset's persona now requires the
  kind on every create.

### Changed

- **The panel lays the party out in columns** — one column per character,
  separated by a hairline, the overlay widening with the party size (min
  360 px, capped at the viewport) — instead of a single vertical stack.
  Spell lists get clearer item separation: chips gain a hairline border and
  wider gaps.

### Added

- **The complete 2014 SRD ships with the bundle** (`data/dnd5e_srd_full.json`,
  from https://github.com/BTMorton/dnd-5e-srd, OGL/CC-BY-4.0), and
  `dnd_srd_lookup` gains a `class` category over it: `query=bard
  category=class` returns the whole class document — hit points,
  proficiencies, starting equipment, the 20-level table (proficiency bonus,
  features, spells known, per-level spell slots) and every feature in prose.
  A bare class-name query under ruleset 2014 routes to the class document
  first, so "fighter" finds the class rather than feature fragments. The
  structured per-class skeleton (`classes` in `dnd5e_srd.json` — hit die,
  saves, spellcasting ability and the level table) feeds
  `dnd_character_create`, which now picks the skeleton matching the
  campaign's ruleset and AUTO-FILLS spell slots from the class table when the
  caller passes none.

### Changed

- **2014 is the only active ruleset; 2024 content is completed from its
  authoritative source instead.** `dnd_srd_lookup` loses its `ruleset`
  override and the campaign `**Ruleset:**` header is no longer consulted —
  every query serves 2014. The 2024 dataset file stays in `data/` unused, for
  a future re-activation. The 2024-only `dnd_mastery` tool is removed from
  the roster (weapon mastery does not exist in 2014).
- The 2024 dataset's class content is rebuilt from the authoritative
  structured source (5e-bits/5e-database `src/2024/en`, SRD 5.2 CC-BY-4.0 —
  the same upstream the dataset was built from), via the committed
  `scripts/refresh-2024-srd.mjs`:
    - `classes`: the full 20-level table per class (proficiency bonus,
      feature names, cantrips known, prepared/known spells, per-level spell
      slots, class-specific values such as the Bardic Inspiration die), the
      spellcasting block, subclass names, and starting-equipment options —
      replacing the seven-field hand skeleton. `dnd_character_create` auto
      spell-slot fill now uses the real 2024 progression (a 5th-level Bard
      gets 4/3/2).
    - `features`: the stale 2014-worded descriptions are replaced with the
      232 true 2024 features, each carrying its level.

### Fixed

- **The panel now serves the live session workspace, not the process
  fallback.** The HTTP routes carry no session, so `activeCampaignDir` used to
  resolve against the process-level root — on a machine with two workspaces
  the panel kept showing the OTHER workspace's campaign while looking
  perfectly healthy. Routes now resolve the root from the session store's
  `list()` (the most recently opened live session's `header.cwd`); when
  several workspaces are live the response says so, and when no session can
  be resolved the fallback is announced in the payload instead of hidden.
- The panel polls `GET /dnd/characters` every 10 s while open, so numbers
  written by `dnd_*` tools appear without a manual close + reopen. The poll
  timer is unref'd under node: the old behavior kept `verify-client` alive
  forever, which hung `npm run check` with a zombie verify process per run.

### Added

- **`dnd_panel_status`** — a read-only verifier for the panel's data pipeline:
  it reports the resolved data root, the active campaign and every character's
  headline numbers, and flags a mismatch between the calling session's
  workspace and the root the panel is serving. Deliberately a READ of the same
  pipeline (no snapshot copy to drift), because "which workspace is the panel
  showing?" is a question the panel itself cannot answer.
- **The no-machine-paths convention is enforced**: `scripts/audit-paths.mjs`
  runs in `npm run check` and fails on any drive-letter path committed in
  `src/`, `cordis.patch.yml` or `README.md`. test/ and scripts/ are exempt —
  their Windows-looking literals are synthetic fixtures remapped into temp
  trees with leak guards.


### Changed

- **The workspace-root global `characters/` roster is removed.** When the
  active campaign had no `characters/` directory, `dnd_character_get` used to
  fall back to reading sheets from `<workspace>/characters/` — a character
  with two possible homes is a drift vector, and a campaign is the scope of
  its own party. Every character now lives only in
  `campaigns/<campaign>/characters/`; an empty directory is a true empty
  party, and `dnd_character_create` has been the only writer since it landed.

### Fixed

- **`dnd_character_create` no longer accepts an `abilities` object it cannot
  understand.** Ability keys are normalized case-insensitively (`str` and
  `STR` are the same score — the field report showed lowercase keys landing
  as silent 10s with every derived modifier at +0 and no warning). A key that
  is still unrecognized, or a value that is not a number, now refuses the
  WHOLE create: a plausible card with wrong numbers is the one failure this
  bundle never ships. Genuinely omitted scores still default to 10 by choice.
- The same silent-loss class is closed for skills: an unknown skill name now
  produces a WARNING naming the skipped entry and the accepted names, instead
  of vanishing.
- The generated summary block no longer splices the literal text
  "(Mage Armor undefined)" onto every card whose state merely lacks the
  `mageArmorAc` field (a hand-built state carries `undefined`, not `null`);
  the create tool also writes the field explicitly, and an absent HP object
  renders as `—` rather than `undefined/undefined`.

### Added

- **`dnd_character_create`** closes the empty-campaign gap that stalled a real
  session's opening turns: with no characters on disk, `dnd_character_get`
  answered "No character sheets found" and the GM had to guess the sheet
  format. The new tool takes structured fields (name, race, class, level,
  abilities, hp, ac, skills, spells, spell slots, equipment, currency,
  narrative), derives every derivable number (ability modifiers, proficiency
  bonus, skill and save bonuses, spell DC/attack, initiative, copper totals,
  hit die), and writes the card through the same validated `writeCharacter`
  path as `dnd_track` — so a created card is parseable by construction.
  `template: true` returns the canonical sheet format instead of writing.
  `dnd_character_get` now points at the tool (and the template) when the party
  is empty rather than leaving the format to be guessed.
- The 2024 SRD dataset gains a `classes` array (all twelve classes: hit die,
  primary ability, proficient saves, armor/weapon training, spellcasting
  ability), and `dnd_srd_lookup` accepts the `class`, `species`/`race`,
  `background` and `feat` categories. The create tool defaults hit die, saves
  and spellcasting ability from the class skeleton when the DM does not pass
  them.

### Changed

- **The campaign data root now follows the DSH session's workspace** instead of
  the hard-coded `D:/DND`. Every `dnd_*` tool resolves its root from the calling
  session's `header.cwd` at execute time; when no session takes part (HTTP
  routes, unit tests), the fallback chain is the `DND_ROOT` or `DSH_CWD` env
  var, then the historical `D:/DND` literal. The GM preset's persona no longer
  names `D:/DND` either — it speaks of "the session workspace". The bundle is
  now portable across machines and workspace layouts. The SRD `data/` directory
  was already package-relative and is unaffected.

### Changed

- **The character panel's "攻击" list is gone.** The sheet parser's weapon
  table was neither complete (no unarmed strikes, no spell attacks) nor
  actionable, so `attacks` is dropped from the state model entirely:
  `splitSheet` no longer extracts it, `state-schema` no longer normalizes or
  validates it, `dnd_character_get` no longer reports it, and the panel
  replaces the list with the character's actual castable surface —
  戏法 / 已准备 / 法术书, straight from `spells`. An existing `.state.json`
  that still carries an `attacks` key loses it on the next write; the sheet's
  own `## Attacks` markdown is preserved as narrative prose.

## [0.3.0] — 2026-09-2x

### Added

- **The `dnd-gm` agent preset is now declared by the bundle** (`preset-dnd-gm`
  row of `@deepseek-ai/dsh-agent-preset`), making `dsh-dnd` a single unified
  install: Host tools, Client character panel AND the D&D Game Master preset.

### Removed

- Nothing runs any more. The preset previously lived as a user-authored
  directory at `$DSH_HOME/.agent-presets/dnd-gm/` (`agent.cordis.yml` +
  `preset.yml`), read by the legacy `@deepseek-ai/dsh-agent-presets`
  directory loader. dsh 0.1.7 replaced that loader with the declarative
  `@deepseek-ai/dsh-agent-preset-registry` plus bundle-declared `preset-*`
  rows, so nothing reads the legacy directory any more and `dnd-gm` fell off
  the roster while its files stayed on disk. The bundle declaration restores
  it; the legacy directory is now dead weight and can be deleted.
- The preset's old `./dnd-host.mjs` row is not carried over: the dnd tools are
  the host-plane `dnd` bundle row, mounted for every session already.

## [0.2.0] — 2026-09-17

A rewrite, not an increment. v0.1.0 could not load at all: its Client half used
`host.call` / `harness.handle`, which need a `pluginId` + `pluginRunId` that only
dynamic plugins have, so a bundle could never have worked. The character sheet
was also one file trying to be two things at once, and `state.md` and `alice.md`
disagreed about a spell slot with no rule for which won.

### Added

- **Character model split into two files** with one authoritative copy of every
  fact: `characters/<name>.state.json` holds the structured state (abilities,
  HP, AC, skills, attacks, spell slots, spells, equipment, currency) and
  `characters/<name>.md` holds the frontmatter, a generated summary block, and
  the narrative prose. The narrative is never machine-parsed into fields.
- **Money as a single copper integer.** Gold, silver and copper are presentation,
  produced when a value is shown and parsed when one is entered. Three fields
  always admit an intermediate state: `8 gp 0 sp 0 cp` minus `15 cp` is
  `8 gp 0 sp -15 cp`, which is arithmetically 785 and physically meaningless.
  With one field the bad state cannot be constructed.
- **Dual clocks.** Every write stamps `updated` (real date) and `worldTime`
  (in-world, read from `calendar.json`). They move independently, so recording
  one cannot reconstruct the other.
- **HTTP routes** `GET /dnd/characters` and `GET /dnd/health`, mounted through
  `ctx.inject(['webServer'])` + `ctx.effect()` so the disposers belong to the
  webServer fiber.
- **Write tools**:
  - `dnd_track` — HP (delta or absolute, clamped to 0..max and reported),
    temporary HP (does not stack, per the rules), spell slots by level, XP,
    conditions, and named consumables.
  - `dnd_spend` — spends coin, judging affordability on the TOTAL so 800 cp can
    pay a 15 cp cost with no copper pieces. An unaffordable spend is refused;
    nothing is written and no debt is recorded.
  - `dnd_xp_add` — awards XP and reports the distance to the next level. It
    deliberately does NOT level the character up: advancement rewrites HP,
    slots, proficiencies and features, which is a rules decision.
- **Idempotency by caller-supplied key.** A repeated call with the same `key` is
  a no-op, so a retry cannot double-charge. Without a key every call applies,
  which is the right default — "take 5 damage" twice means 10.
- **The character panel**, replacing the placeholder: HP bar, six abilities with
  modifiers, AC, initiative and speed, spell save DC, coin, spell slots,
  proficiencies, attacks, and any validation findings rendered explicitly.
- `dnd_mastery` (2024 weapon mastery properties) and `dnd_dc` (DC ladder and
  passive scores).
- Install scripts `scripts/install.ps1` and `scripts/install.sh`.

### Changed

- Tool count 11 → 14.
- The D&D skill at `.agents/skills/dnd/` is **reference only**. v0.1.0 described
  the plugin as an accelerator layered over the skill's Python scripts and
  designed around mutual exclusion with them. The plugin no longer calls them,
  so there is no second writer and nothing to exclude.
- `dsh_srd_lookup` and `dnd_campaign_search` now reject a missing `query`.
  Previously `String(undefined)` became the non-empty string `"undefined"` and
  the tool searched for it, answering `No match for "undefined"` — which reads
  exactly like a legitimate miss. An empty query was worse: it matches every
  line, so a whitespace-only search returned "30+ matches" and looked like it
  had worked.
- `dnd_track` refuses a call that names no change. It has no required fields
  (every change is optional), so an empty call previously fell through and
  stamped both clocks on a character nothing had happened to.

### Fixed

- **Routes silently never mounted.** `ctx.get('webServer')` with `ctx.effect()`
  on the outer context registered nothing: `register()` returned a disposer and
  reported success, and the route answered 404 with an empty body. Now mounted
  from a scoped context, and `mountRoutes` throws with the fix in the message.
- **New state fields were dropped on write.** `normalizeState` keeps only the
  fields in its order list, so `conditions` and `appliedKeys` disappeared while
  the tool reported success — the idempotency key vanished on every write, which
  would have made every retry double-apply.
- **`conditions` was `undefined` for an unaffected character**, so reading
  `.length` would have thrown in the panel.
- **Spell-slot sign inverted.** `used` counts expended slots, so expending must
  raise it; the first implementation moved it the other way and still looked
  plausible.
- Saving throw separators, `**Currency:**` parsed as an inventory item, and
  proficient saves losing their modifier (`+5*` → `NaN`) — all found by parsing
  the real `alice.md`.
- Empty frontmatter destroying the document, and the generated summary block
  being absorbed into the narrative on every write (which nested a copy each
  time).

### Notes

- No security layer. The deployment binds `127.0.0.1` by default, this is a
  single-user local plugin, and if LAN exposure were ever wanted the fix belongs
  to the bind address rather than to each route.
- The Client half declares no theme tokens of its own; the earlier dusk-skin
  override was removed. The panel renders with the host's own tokens.

## [0.1.0] — 2026-09-04

### Added
- Initial bundle: `dsh-dnd` npm package (Host tool suite + Client panel, no skin).
- Host tools, split into five cohesive modules:
  - `dnd-core` — `dnd_roll`, `dnd_srd_lookup`, `dnd_campaign_state` (moved from dnd-host.mjs).
  - `dnd-mechanics` — `dnd_check`, `dnd_attack`, `dnd_save` (pure table resolution).
  - `dnd-sheet` — `dnd_character_get`, `dnd_campaign_search` (read-only) + `dnd.characters` panel feed.
  - `dnd-xp` — `dnd_xp_add` (CR→XP, level-up write-back).
  - `dnd-track` — `dnd_track` (HP/temp/inspiration/death-saves first cut).
- Client panel: panel-oriented registry, character panel only, no theme skin.
- Install via `dsh plugin --profile web add dsh-dnd` (or local `link:`).

### Known broken
- The Client half could not load: it used `host.call` / `harness.handle`, which
  a bundle cannot use. The panel never appeared.
