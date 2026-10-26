# SRD datasets ship inside the bundle

The SRD datasets are read-only reference data published with the bundle
(`data/`), resolved from the package itself. A lookup table that ships with
the plugin is the plugin's dependency: it belongs wherever the bundle goes,
not in a workspace directory that any cleanup can take away — which had
already happened once, when the installed skill was deleted and lookups
began reporting a missing dataset.

## Considered Options

Pointing the tools at a workspace path outside the bundle — rejected: it
kept the dependency in whatever directory the workspace happened to have, so
moving or cleaning that directory would reproduce the same defect. The root
cause was not a wrong path but wrong ownership.

## Consequences

The dataset path is exempt from test root remapping: tests must exercise the
published artifact, not a copy (see `docs/agents/test-data-ownership.md`,
"code root is not data root"). Refreshing a dataset is an explicit build-time
act (`scripts/refresh-2024-srd.mjs`), never a workspace edit.
