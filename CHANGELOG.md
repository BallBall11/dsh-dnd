# Changelog

All notable changes to `dsh-dnd` are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versioning adheres to
[SemVer](https://semver.org/).

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
