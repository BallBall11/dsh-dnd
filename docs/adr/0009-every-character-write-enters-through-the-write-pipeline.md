# Every character write enters through the write pipeline

A character write is not `writeCharacter` alone. Six promises make it legal:
resolve the right character, serialize per character, honour the caller's
idempotency key, stamp both clocks, translate sandbox refusals, and thread the
calling session's policy into the platform write. They are enforced behind one
interface — the Write Pipeline — and a tool contributes only a thin argument
parser and a mutate function. The rules arithmetic stays in the pure modules
and flows through `mutate`.

The seam earned its keep before it was named: rest, level-up and the attack
target already entered through it, and the one writer that bypassed the
pipeline's clock handling — the narrative editor, fetching the campaign
calendar by its own path computation — stamped `worldTime: null` over the
world clock on every call.

## Considered Options

Letting each tool family assemble its own write from resolver, lock, ledger,
calendar and diagnosis helpers — rejected: the invariants then live by
discipline, and the discipline failed at least once per invariant. Four
hand-copied lock chains, four idempotency dialects with hand-mirrored cap
constants, five resolver copies that had already drifted three ways, and a
calendar path computed three ways, one of them wrong.

## Consequences

A new write tool is thin by construction, and a change to any of the six
promises is made once and tested once: the concurrency scenario and the
execute()-level clock suite pin this interface. The pipeline guarantees
single-character atomicity; multi-character composite writes are a recorded
boundary, not an accident — they need their own design and their own ticket
before any tool attempts one. The effects family shares the mechanisms but
keeps its own encounter-file queue and ledger instances (ADR-0007), because
different files need different queues.
