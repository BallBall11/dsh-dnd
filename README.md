# dsh-dnd

D&D for DSH — a bundle for the DeepSeek Harness **web** profile: twenty-one native
Host tools plus a Client character panel, backed by a two-file character model.

Every number in a character has exactly one home. The structured state lives in
`characters/<name>.state.json`; the narrative prose lives in
`characters/<name>.md`. Neither file duplicates the other, so they cannot drift
apart — which is the failure this design exists to prevent.

## Conventions

- **No machine-specific paths in the production surface.** Every data root is
  resolved at call time: tools use the calling session's workspace
  (`session.header.cwd`); the HTTP routes use the most recently opened live
  session (`SessionStore.list()`); with no session in play the fallback chain
  is `DND_ROOT` / `DSH_CWD` env, then a legacy literal. `node
  scripts/audit-paths.mjs` (part of `npm run check`) fails on any drive-letter
  path committed under `src/`, `cordis.patch.yml` or this README.
- **The panel never falls back silently.** When the routes cannot resolve a
  session workspace, the response carries an explicit warning that the panel
  renders — plausible data from the wrong workspace is the one failure this
  bundle never ships.


## Install

```bash
# from the GitHub repository — the built bundle is committed
dsh plugin --profile web add git+https://github.com/BallBall11/dsh-dnd.git
dsh plugin --profile web add git+ssh://git@github.com/BallBall11/dsh-dnd.git   # SSH

# from a local git checkout (no registry needed)
dsh plugin --profile web add link:<path-to-a-local-checkout>

# from a registry, once published
dsh plugin --profile web add dsh-dnd
dsh plugin --profile web add dsh-dnd@0.3.0     # pinned
```

That single command runs pnpm inside the profile, reconciles
`dsh.profile.bundles`, and mounts both the Host tools and the Client panel on
the next boot — no manual `cordis.patch.yml` edits.

Then **restart the web profile**. `dsh plugin add` installs; it does not hot-load.
The bundle's route mounting and panel registration both take effect at process
start, so a running harness will not see them until it restarts.

Verify after restarting:

```bash
# the routes are up (expect JSON, not a 404 with an empty body)
curl http://127.0.0.1:3080/dnd/characters

# the tools are registered — look for dnd_roll, dnd_track, dnd_spend ...
```

In the GUI, a ⚔ button appears in the sidebar footer; it opens the character
panel.

Remove it again with:

```bash
dsh plugin --profile web remove dsh-dnd
```

### Helper scripts

`scripts/install.ps1` and `scripts/install.sh` wrap the same command.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1            # local link
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Version 0.2.0
```

```bash
./scripts/install.sh          # local link
./scripts/install.sh 0.2.0    # pinned registry version
```

`-DryRun` prints the commands without running them.

> **Upgrading from v0.1.0:** that version could not load its Client half at all,
> and it may have left a hand-written `dnd-host` mount row in the profile's
> `cordis.patch.yml`. Remove that row, or the tools will double-mount.

## What it provides

### Character model

A character is **two files**:

```
campaigns/<campaign>/characters/alice.state.json   structured state — authoritative
campaigns/<campaign>/characters/alice.md           frontmatter + summary + prose
```

The `.state.json` holds abilities, HP, AC, skills, spell slots, spells,
equipment, currency, conditions and XP. The `.md` holds the YAML frontmatter
(who the file belongs to, both clocks), a generated summary block fenced by
`<!-- dsh-dnd:generated -->` markers, and the narrative — the player's own
description and history, which is never parsed into fields and never reformatted.

A sheet written before this split (structured sections inline in the `.md`) still
reads: the state is derived from the sheet on read, and `needsMigration` reports
that no state file exists. Reading never rewrites — migration is an explicit
write.

**Money is one integer.** A purse is a copper total (`currency: 785`), never
three fields. Denominations exist only at the edges: parsed on input, produced
for display. Three fields always admit an intermediate state, and
`8 gp 0 sp 0 cp` minus `15 cp` becoming `8 gp 0 sp -15 cp` is arithmetically 785
and physically meaningless. Affordability is judged on the total, so 800 cp can
pay a 15 cp cost with no copper pieces.

**Both clocks are stamped on every write**: `updated` (real date) and
`worldTime` (in-world, from the campaign's `calendar.json`).

### Host tools (14)

| Tool | Purpose |
|---|---|
| `dnd_roll` | Any dice expression: `2d6+3`, `4d6kh3`, advantage/disadvantage |
| `dnd_check` | Ability or skill check vs a DC |
| `dnd_attack` | Attack vs AC, with crit damage on a natural 20 |
| `dnd_save` | Saving throw vs a DC (also death saves) |
| `dnd_dc` | The DC ladder, and passive scores |
| `dnd_mastery` | 2024 weapon mastery properties (Cleave, Topple, Vex, …) |
| `dnd_srd_lookup` | Bundled 5e SRD entry by name and category |
| `dnd_campaign_state` | The active campaign's `state.md`, in whole or by section |
| `dnd_campaign_search` | Full-text search of the campaign corpus — use before reading whole files |
| `dnd_arc_status` | Where the campaign arc currently stands |
| `dnd_character_get` | Read one character or the whole party, as JSON or a card |
| `dnd_track` | **Write** HP, temp HP, spell slots, XP, conditions, consumables |
| `dnd_spend` | **Write** coin out of the purse |
| `dnd_xp_add` | **Write** an XP award |

The eleven read tools are pure. The three write tools live in their own module
(`lib/host/tools/track.mjs`) so the write path can be read and tested on its own.

**Business judgement happens at the tool layer.** `dnd_spend` decides whether a
purchase is affordable and tells the DM the shortfall; the write layer's
validation is only a backstop for a state that cannot exist. A decision made
only at the write layer would be invisible — the tool would report success while
the numbers did not move.

**A refused write changes nothing.** An unaffordable purchase is refused rather
than recorded as a debt, and validation reports problems without repairing them:
silently clamping a negative purse to zero would show the DM a plausible number
that is not true.

**Idempotency is keyed.** Pass `key` and a repeated call is a no-op, so a retry
cannot double-charge. Without a key every call applies, which is the correct
default — a DM saying "take 5 damage" twice means 10.

### Client panel

A character panel registered into two slots: a `sidebar.footer.action` toggle
(⚔) and a `shell.overlay` card. It shows HP with a coloured band, the six
abilities with modifiers, AC, initiative and speed, spell save DC, coin, spell
slots, proficiencies, spells — and any validation findings, rendered explicitly
rather than hidden, because a DM reading a plausible number that is not true is
the failure this whole design is aimed at.

Data arrives over `GET /dnd/characters`. It is **not** `host.call`: that path
needs a `pluginId` and `pluginRunId` which only dynamic Cordis plugins have, so
a bundle can never use it. That mistake is what made v0.1.0 unloadable.

The panel renders what the Host sends and formats almost nothing itself — money
arrives pre-formatted and findings arrive as strings, because recomputing either
in the browser would give two places to drift.

**No theme skin.** The panel uses the host's own tokens
(`--dsw-alias-bg-layer-1`, `--dsw-alias-label-primary`, …).

## Build & development

```bash
npm run build      # assemble lib/ from src/
npm run watch      # rebuild on change
npm test           # 12 unit and contract suites
npm run verify     # evaluate lib/client.js headlessly, as the loader does
npm run test:writes # drive the write tools against campaigns/stage2-test
npm run check      # all of the above
```

`lib/` is committed. A `link:` install needs no build step, and `lib/` is what
pnpm resolves.

Source layout:

```
src/host/index.mjs          coordinator: mounts every tool family and the routes
src/host/routes.mjs         GET /dnd/characters, GET /dnd/health
src/host/tools/*.mjs        one module per domain, each exporting buildTools(ctx)
src/client/index.js         factory-body entry (no ESM: it is pasted into the loader)
src/client/panels/*.js      one file per panel
```

`src/client/**` is **not** an ES module. It is pasted inside
`window.__ModuleLoader__.load({ id, factory })`, so it may not use `import` or
`export` and may only `require('react')`. `scripts/build.mjs` enforces this at
build time.

### Testing notes

- The Client half is verified **behaviourally**: `scripts/verify-client.mjs`
  stubs a DOM and a React, runs the built bundle, and walks the rendered element
  tree — so a render bug fails the build rather than blanking a panel.
- Refusal tests compare **file hashes**, not re-read values. "The file must not
  change" is a claim about bytes; re-reading through the same parser would agree
  with itself.
- All write tests run in the throwaway `campaigns/stage2-test`. The active
  campaign marker is repointed for the run and restored in a `finally`, read and
  written as bytes.
- `test/tool-args.test.mjs` calls **every** tool with no arguments and asserts
  none of them reports a result computed from a missing value.

## Design notes

- **Plane rule.** The Host modules consume `fs` and `tools` from the host
  registries, so they mount as plain rows outside any `isolate` realm. `tools`
  is the only hard dependency; `fs` is read lazily per call, so a filesystem
  outage cannot take down the six pure dice tools.
- **`webServer` is reached through `ctx.inject(['webServer'], cb)`, never
  declared in `inject`.** Declaring it would make a headless run fail to mount
  the plugin's whole purpose. Registering from the scoped context is also
  load-bearing: `ctx.effect` on the outer context registers nothing, silently.
- **Reads never write.** The panel polls; if reading could write, every page
  view would be a filesystem mutation.
- **No security layer.** The deployment binds `127.0.0.1` by default, this is a
  single-user local plugin, and if LAN exposure were ever wanted the fix belongs
  to the bind address rather than to each route. The one retained protection is
  the `register()` disposer being owned by `ctx.effect`, because a duplicate
  `(kind, path)` throws on reload.
- **The `dnd` skill at `.agents/skills/dnd/` is reference only.** It documents
  the authoritative data formats, which this bundle follows, but the plugin does
  not call its scripts.

## Releasing

```bash
npm run check                     # must be green
# bump "version" in package.json and add a CHANGELOG entry
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push --tags
```

`lib/` is committed, so a release tag is directly installable with `link:`.
Additive tool behaviour is a `patch`; a new tool or panel is a `minor`; renaming
or removing a tool is a `major`.

## License

MIT
