/**
 * tools/session-scope.mjs — resolving a WRITE's sandbox policy from the session
 * that issued the tool call.
 *
 * ## The defect this exists to fix
 *
 * Every `dnd_*` write tool was refused with
 *
 *     cannot write "D:\\DND\\campaigns\\<campaign>\\characters\\alice.state.json":
 *     file access denied under workspace-write mode
 *
 * and the character was never written. Reads and dice worked, so the session
 * looked healthy right up to the point where nothing had been saved.
 *
 * The cause is not the mode and not the path. It is that the write asked
 * `fs-sandbox` to check a target WITHOUT a policy, and the fallback policy is
 * built from the harness process's own cwd:
 *
 *     fs.writeText(target, content)          // no 5th argument
 *       -> checkedTarget(target, undefined)  // dsh-fs-sandbox:153
 *       -> sandboxPolicy.resolve()           // :154 — called with NO argument
 *       -> session === undefined             // dsh-sandbox-policy:141
 *       -> workspaceRoot = this.workspaceRoot  // :145 — the process cwd fallback
 *       -> isPathUnder("D:\\DND\\campaigns\\...", "C:\\Users\\Ming") === false
 *       -> FS_SANDBOX_DENIED
 *
 * The SESSION's cwd was always correct (`D:\\DND`). It simply never took part
 * in the decision, because `resolve()` never received the session.
 *
 * ## Why passing a resolved policy is NOT the fix
 *
 * The obvious repair — call `ctx.sandboxPolicy.resolve()` and hand the result to
 * `writeText` — was measured and does NOT work. The bundle's Context has no
 * session scope, so an argument-less `resolve()` still answers
 * `{ sessionId: null, workspaceRoot: "C:\\Users\\Ming" }` and the write is still
 * refused. Copying the wrong policy down the call stack just moves it.
 *
 * `resolve()` has to RECEIVE the session. That is what this module supplies.
 *
 * ## Where the session comes from
 *
 * `ToolDefinition.execute(args, exec)` receives a `ToolRunContext` whose
 * `exec.agent` is "the agent on whose behalf the call runs (set by the agent
 * loop)". `Agent.id` is a `SessionId`, and `ctx.sessions.get(id)` returns the
 * live `Session` — whose `header.cwd` is the session workspace root that OUGHT
 * to be the write boundary.
 *
 * All fourteen tools in this bundle were written `async execute(args)`, so that
 * second argument was being discarded at every call site. This module is the one
 * place that picks it back up, so each family does not have to.
 *
 * The platform intends exactly this: `sandboxPolicy`'s own contract says tool
 * layers "call resolve for each execution so a session's mode log and immutable
 * cwd travel together to every enforcing capability".
 *
 * ## FAIL CLOSED
 *
 * When no session can be resolved this returns `undefined`, and `undefined` as
 * the 5th argument to `writeText` reproduces the pre-existing platform path
 * exactly — `resolve()` with no session, judged against the process cwd. That
 * is the RIGHT degradation:
 *
 *   - it never widens the mode; `workspace-write` stays `workspace-write`
 *   - it never invents a root; there is no guessed cwd
 *   - it never silently succeeds somewhere unexpected — a path outside the
 *     process root is still refused, exactly as before
 *
 * The alternative, defaulting to `danger-full-access` or to a hard-coded
 * a hard-coded workspace, would trade a visible refusal for an invisible bypass. This bundle
 * is invoked with no agent in plenty of legitimate places (unit tests calling
 * `execute(args)` directly, for one), so the degraded path must be safe rather
 * than merely unlikely.
 */

/**
 * Resolve the session a tool call runs on behalf of.
 *
 * @param ctx - the host context.
 * @param exec - the `ToolRunContext` a tool's `execute(args, exec)` received,
 *   or undefined when the tool was called without one.
 * @returns the live Session, or undefined when it cannot be determined.
 */
export function sessionOf(ctx, exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return undefined

  // `sessions` is a soft dependency on purpose. Declaring it in `inject` would
  // make the whole bundle's mount wait on a service that only exists to scope
  // writes; a headless or partially-booted host must still get its tools.
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined

  const id = agent.id
  if (id === undefined || id === null) return undefined

  // Returns undefined for a session that is not live. That is a real answer,
  // not an error: it means "no scope available", which fails closed.
  return sessions.get(id)
}

/**
 * Resolve the per-execution sandbox policy a WRITE must be judged against.
 *
 * @param ctx - the host context.
 * @param exec - the `ToolRunContext`, or undefined.
 * @returns a `SandboxExecutionPolicy` carrying the session's cwd, or undefined
 *   when no session is available (the caller then omits the argument entirely,
 *   preserving the platform's process-cwd fallback).
 */
export function writePolicyFor(ctx, exec) {
  const session = sessionOf(ctx, exec)
  if (session === undefined) return undefined

  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined || typeof sandboxPolicy.resolve !== 'function') return undefined

  // The request carries the SESSION, not a mode. Passing the session is what
  // lets resolve() read `session.header.cwd` and the session's own logged
  // mode — so an approved narrow mode stays narrow, and the boundary is the
  // session's workspace rather than the process's.
  return sandboxPolicy.resolve({ session })
}
