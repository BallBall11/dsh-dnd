# A character is two files

A character's structured state lives in `<name>.state.json` and its narrative
lives in `<name>.md`, and neither duplicates the other, so they cannot drift
apart — which is the failure this design exists to prevent. A pre-split sheet
that keeps structured sections inline still reads (state is derived from the
sheet on read), but migration is an explicit write: reading never rewrites.

## Considered Options

One file with structured sections inline (the legacy layout) — rejected
because prose and numbers then duplicate each other and always drift.

## Consequences

Every character write stamps both clocks on the sheet; showing one character
always means reading two files.
