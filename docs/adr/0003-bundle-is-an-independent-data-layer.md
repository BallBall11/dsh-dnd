# The bundle is an independent data layer

`dsh-dnd` is a standalone D&D data layer: structured state (its own JSON files
under the campaign), narrative prose, and a presentation layer (the Panel and
the summary tools). The installed `.agents/skills/dnd/` skill is reference
material only — its data-format definitions are adopted, its scripts are never
called, and there is no second writer to fence against. The bundle owns its
numbers end to end.

## Considered Options

Acting as a native accelerator for the skill's Python scripts, with a write
mutex against them — rejected: two writers over one set of files need
coordination for no capability the bundle does not already have, and the skill
was later deleted outright. An independent layer with no rival writer makes
the mutex a non-question.

## Consequences

Every number the tools read or write lives in the bundle's own formats.
Removing the skill must not affect the bundle: the SRD datasets ship inside
the package (ADR-0005), and nothing resolves through the workspace's skill
directories.
