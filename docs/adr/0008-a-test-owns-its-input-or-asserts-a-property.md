# A test owns its input or asserts a property — never both

Every test is either a parser test or an invariant test, and the two demand
opposite input ownership. A parser test owns its input: frozen fixtures in
`test/fixtures/`, pinned by digest, asserting concrete values. An invariant
test may read the live campaign but may only assert properties — bytes
unchanged, a shape that holds for any input — never a snapshot of one
campaign's current values. The incident that set the rule: five suites went
red when the plugin legally migrated a character the tests had been reading.
Not a regression — the tests' input had changed shape.

## Considered Options

Snapshotting live campaign values for concreteness — rejected: any legal
change to the campaign (a migration, a purchase, a wound) would then count
as breaking the build. Skipping assertions when a fixture is missing —
rejected: a suite that silently skips stays green while asserting nothing.

## Consequences

Enforced by `npm run test:ownership` (`scripts/audit-test-ownership.mjs`) as
part of `npm run check`: every live-data reference must be classified, via
the shared read-only helper (`test/support/live-data.mjs`) or an allowlist
entry with a stated reason. The operational rules — fixture hardening,
property-assertion patterns, the helper's surface — live in
`docs/agents/test-data-ownership.md`.
