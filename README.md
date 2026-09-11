# dsh-dnd

D&D for DSH — a **release bundle** for the DeepSeek Harness web profile: a cohesive
family of native Host tool plugins plus a panel-oriented Client character panel.

- **No theme skin.** The earlier dusk-skin token override was removed on purpose;
  the panel renders with the host's own theme tokens.
- **Panel-oriented.** A small panel registry ships only the character panel today;
  future panels (spellbook, inventory, combat log, …) are appended to that registry
  without touching the Host modules.

```
dsh plugin --profile web add dsh-dnd        # published / registry
dsh plugin --profile web add link:D:/DND/dsh-dnd-bundle   # local / git (no registry)
```

That one command reconciles `dsh.profile.bundles`, appends the bundle to the stack,
and mounts both the Host tools and the Client panel on next boot — no manual
`cordis.patch.yml` edits, matching how other DSH web plugins install.

---

## Install

### Option A — published (registry)

```bash
# latest
dsh plugin --profile web add dsh-dnd
# pinned
dsh plugin --profile web add dsh-dnd@0.1.0
```

### Option B — local git checkout (no registry)

```bash
# built bundle is git-versioned; install straight from the working tree
dsh plugin --profile web add link:D:/DND/dsh-dnd-bundle
```

> If `D:/DND` is not writable at install time, copy the repo somewhere stable and
> point `link:` at that copy.

### Option C — helper script (idempotent, Windows / POSIX)

```powershell
# local link install
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# pinned registry version and restart the web profile
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Version 1.0.0 -Restart
```

```bash
./scripts/install.sh            # local link install
./scripts/install.sh 1.0.0      # pinned registry version
```

### After install

1. Restart the `web` profile: `pm2 restart dsh-web` (or restart the profile service).
2. **Remove any stale manual mount row.** If the profile's own `cordis.patch.yml`
   (or the old `dnd-host` install) still mounts D&D plugin rows by hand, delete
   them — otherwise the tools/panel double-mount.
3. Verify: the Host tools (`dnd_roll`, `dnd_check`, `dnd_attack`, `dnd_save`,
   `dnd_character_get`, `dnd_campaign_search`, `dnd_xp_add`, `dnd_track`) appear in
   the tool list, and the ⚔ 角色 button opens the character panel.
4. Uninstall anytime: `dsh plugin --profile web remove dsh-dnd`.

---

## What it ships

### Host tool modules (each a cohesive plugin row, consumed from the host registries)

| File | Tools | Notes |
|---|---|---|
| `lib/host/dnd-core.mjs` | `dnd_roll`, `dnd_srd_lookup`, `dnd_campaign_state` | bootstrap/reference, moved from the old dnd-host.mjs |
| `lib/host/dnd-mechanics.mjs` | `dnd_check`, `dnd_attack`, `dnd_save` | pure d20 table resolution (adv/dis, nat20/1, crit) |
| `lib/host/dnd-sheet.mjs` | `dnd_character_get`, `dnd_campaign_search` | read-only; also feeds the panel (`dnd.characters`) |
| `lib/host/dnd-xp.mjs` | `dnd_xp_add` | CR→XP, level-up write-back for character sheets |
| `lib/host/dnd-track.mjs` | `dnd_track` | HP damage/heal, temp HP, inspiration, death saves (first cut) |

The modules are **not** a mega-plugin: each owns one domain, fails alone, and can be
disabled independently (set `disabled: true` on the row in `cordis.patch.yml`).

### Client module

```text
src/client/panel.js  ->  lib/client.js   (dsh.client, platform: web)
```

A panel registry (`PANELS`) with a single character-panel entry: a
`sidebar.footer.action` toggle ("⚔ 角色") that opens a floating `shell.overlay`
card. It is fed by the Host `dnd.characters` handler. The pkg-3 footer-layout fix
(vertical stacking under the shell badge, non-clipping glyph) is retained.

---

## Build & dev

```bash
npm run build     # copies src/host + src/client into lib/ (no transpile needed)
npm run watch     # rebuild lib/ on src/ change
npm test          # parser regression suite
```

The published package is the `lib/` output plus `cordis.patch.yml` (git-ignored
until `build` runs). Host modules and the Client panel are plain ESM — no TS/JSX.

---

## Design notes

- **Plane rule.** The Host modules consume `fs` and `tools` from the **host**
  registries, so they sit as plain rows outside any `isolate` realm. The Client
  panel is delivered by `dsh.client` (persistent, no per-session `cordis_run`).
- **Data stays live.** The Host reads only leaf fields and returns compact plain
  JSON; nothing serializes Cordis/DSH live objects.
- **RPC channel.** The panel's `host.call('dnd.characters')` is wired through
  `harness.handle` when present. If your profile exposes RPC differently, adjust
  `lib/host/dnd-sheet.mjs`'s `dnd.characters` handler to your host's channel.
- **Skill remains authoritative.** `dice.py`/`xp.py`/`tracker.py`/`calendar.py`
  in the D&D skill are the fallback for full stateful bookkeeping; these tools are
  the lightweight native path for the common table operations.

---

## Releasing & versioning (git)

This repository is a git-managed release source. The published bundle is the
`lib/` build + manifest above; bump the version for each release.

```bash
npm run build
npm version patch            # or minor / major — tags v0.1.x, updates version + CHANGELOG
git push --tags              # publish to origin
npm publish                  # optional — only if publishing to a public registry
```

- Host tool behavior that is only additive → `patch`.
- Adding a tool/module without breaking existing ones → `minor`.
- Breaking change (e.g. renaming a tool) → `major`.

Local-only teams can skip `npm publish` entirely and install pinned git tags:

```bash
dsh plugin --profile web add link:D:/DND/dsh-dnd-bundle
```

## Adding a panel (future)

Append an entry to `PANELS` in `lib/client.js`:

```js
{
  id: 'dnd-spellbook-panel',
  actionId: 'dnd-spellbook-action',
  label: () => '法术',
  renderAction: (props) => React.createElement(SpellbookAction, props),
  renderOverlay: () => React.createElement(SpellbookOverlay, null),
}
```

and add the matching Host data handler. No skin, no Host rewrite.

---

## License

MIT
