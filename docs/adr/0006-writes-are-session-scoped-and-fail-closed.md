# Writes are session-scoped and fail closed

Every write resolves its sandbox policy from the calling session at call
time (`sandboxPolicy.resolve({ session })`) and passes it to the platform's
`writeText` as the fifth argument. With no agent, session or policy service
the value is `undefined` — the platform then judges the write against the
process cwd and refuses, which is the intended degradation: stay refused
rather than widen. Reads never take a policy, so they cannot be fenced by
one.

## Considered Options

Passing a pre-resolved policy through the bundle Context — rejected: the
context has no session scope, so every caller would inherit whichever
session resolved first. Loosening the sandbox mode — rejected: the root
cause was a missing session scope, not an over-tight mode, and the mode was
never changed from `workspace-write`.

## Consequences

The positional `writeText(target, text, undefined, undefined, policy)` shape
is load-bearing at every write site: the policy is a required input of the
write interface, and `undefined` is a meaningful value that must be
forwarded as-is, never replaced with a default. The policy is resolved per
call, never at mount time — a call without an agent must not inherit the
previous caller's scope.
