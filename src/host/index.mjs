/**
 * Host entry — the node half of the bundle.
 *
 * Plain ESM (this half really is a module; only the client half is a factory).
 * The row in cordis.patch.yml names the *package*, and node resolves this file
 * through `exports["."]` in package.json.
 *
 * Stage 0 keeps this deliberately thin: one trivial tool, so we can confirm the
 * host half mounts and registers without any business logic muddying the
 * signal. The real tool families land in stage 1.
 *
 * Services arrive through the host registries — `tools` here — never through a
 * realm. Cordis `inject` is the hard-dependency declaration: the fiber waits
 * for `tools` to exist rather than reading an undefined ctx property.
 */

export const name = 'dnd-host'
export const inject = ['tools']

/** One registered tool is enough to prove the host half mounted. */
const SMOKE_TOOL = {
  name: 'dnd_ping',
  description: 'Health check for the dsh-dnd host half. Returns the loaded version and the active campaign marker, if any. Stage-0 placeholder; real tools land in the next release.',
  parameters: {
    type: 'object',
    properties: {},
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute() {
    return 'dsh-dnd host half is mounted (stage 0).'
  },
}

/**
 * Mount the host half.
 * @param ctx - host context; `tools` is injected above, `fs` is optional.
 */
export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('dsh-dnd: tools service unavailable')

  const dispose = tools.register(SMOKE_TOOL)

  // Return a real disposer so the registration is fiber-owned and is removed
  // on stop/update. (Returning a bare object here is the same `Invalid effect`
  // trap the client half hit in v0.1.0.)
  return () => { if (typeof dispose === 'function') dispose() }
}
