/**
 * tools/write-probe.mjs — the startup WRITE self-check (T6).
 *
 * ## The failure this exists to make loud
 *
 * The defect that motivated this whole task board was not "writes fail". It was
 * that writes failed while **everything else worked**: four read tools and six
 * dice tools were perfectly healthy, and only the write tools were refused. A
 * session therefore LOOKED healthy. A DM could run a whole evening — rolling,
 * reading sheets, narrating — and discover at the end that nothing had been
 * saved.
 *
 * The bug report called this the worst failure shape, and it is: the failure is
 * silent, adjacent, and discovered far from its cause.
 *
 * ## What this does
 *
 * At mount time, and only when a campaign is active, it performs one HARMLESS
 * write probe and, if the write is refused, says so — once through the logger,
 * and again as a notice the first write tool can surface.
 *
 * ## Why the probe writes ONE STABLE path and overwrites it
 *
 * The fs service contract exposes \`resolve / processPath / fileUrl / contains /
 * stat / lstat / readText / streamText / readBytes / readByteRange / listDir /
 * writeText / editText\` — and **no delete method of any kind**. A probe that
 * created a uniquely-named file per run would therefore leave litter in the
 * campaign directory forever, because nothing in this bundle can remove it.
 *
 * So the probe writes a SINGLE fixed path, \`.dnd-write-probe.tmp\`, and
 * overwrites it on every mount. This is self-limiting: repeated mounts converge
 * on one file rather than accumulating. The file is a dotfile with a
 * probe-specific name, is never read by any other part of the bundle, and is
 * not campaign data.
 *
 * The contract also gives a better property than cleanup: \`writeText\` is
 * specified as **atomic**. Overwriting the same path cannot leave a torn file
 * even if the process dies mid-probe.
 *
 * It never opens a character file, never rewrites \`state.md\`, and never
 * touches \`alice.state.json\` — the acceptance criteria call that out
 * explicitly, because a self-check that corrupts what it checks is worse than
 * the bug.
 *
 * ## Why a refusal does NOT block the mount
 *
 * The probe reports; it does not gate. A refused write path means the write
 * tools are broken, but reads and dice are not, and taking the whole bundle
 * down would turn a partial failure into a total one. This mirrors the
 * per-family isolation in index.mjs. The criterion "探测失败时插件仍然挂载" is
 * exactly this.
 *
 * ## Why the probe result is CACHED
 *
 * Probing on every write would be wasteful, and the answer is about the
 * MOUNT-TIME policy, not about any particular later call. \`undefined\` means
 * "not probed yet", which is honestly different from "probed and fine".
 */

import { isSandboxDenial, describeWriteRefusal } from './write-errors.mjs'
import { activeCampaignDir } from './shared.mjs'

/** One probe's outcome. */
export const PROBE_OK = 'ok'
export const PROBE_REFUSED = 'refused'
export const PROBE_SKIPPED = 'skipped'

/**
 * The one path the probe writes. Fixed, not unique-per-run: see the header on
 * why this bundle cannot delete it again.
 */
export const PROBE_FILENAME = '.dnd-write-probe.tmp'

/**
 * Perform one harmless write probe in a campaign directory.
 *
 * @param fs - the host fs service.
 * @param campaignDir - absolute path to the ACTIVE campaign directory.
 * @param options - \`{ sandboxPolicy, now }\`. \`sandboxPolicy\` is the policy to
 *   probe WITH; at mount time no session call is in flight, so it is normally
 *   undefined, and that is meaningful: it probes the same fallback a
 *   session-less write would use.
 * @returns \`{ status, path?, error?, message? }\`. Never throws.
 */
export async function probeWrite(fs, campaignDir, options = {}) {
  if (fs === undefined) return { status: PROBE_SKIPPED, message: 'no fs service' }
  if (typeof campaignDir !== 'string' || campaignDir === '') {
    return { status: PROBE_SKIPPED, message: 'no campaign directory' }
  }

  const path = campaignDir + '/' + PROBE_FILENAME
  const payload = 'dsh-dnd startup write probe — safe to delete. '
    + 'Technique check: if the bundle can write here at all, this file is overwritten each mount.\n'

  try {
    const target = await fs.resolve(path)
    await fs.writeText(target, payload, undefined, undefined, options.sandboxPolicy)
  } catch (error) {
    if (isSandboxDenial(error)) {
      return {
        status: PROBE_REFUSED,
        path,
        error,
        message: describeWriteRefusal(error, { policy: options.sandboxPolicy, operation: 'startup write probe' }),
      }
    }
    // A non-sandbox failure (no such directory, disk error) is reported as
    // skipped rather than refused: it is not the defect this probe hunts, and
    // claiming it is would send a DM chasing the wrong thing.
    return { status: PROBE_SKIPPED, path, error, message: 'probe could not run: ' + (error?.message ?? error) }
  }

  return { status: PROBE_OK, path }
}


/**
 * Run the write self-check ONCE, against a REAL session's policy (T6).
 *
 * ## Why this happens on the first write and not at mount
 *
 * A mount-time probe has no session, so it could only test the platform's
 * process-cwd fallback. Every real write carries its caller's session policy
 * (session-scope.mjs), so a mount probe measures a configuration that no tool
 * call ever uses — and would therefore report a FALSE FAILURE on a healthy
 * host. Worse, it would fire on every boot, and a warning that is always wrong
 * is one nobody reads.
 *
 * Running it on the first write gives it the caller's actual policy, so its
 * verdict is about the path writes really take.
 *
 * ## Why it is fire-and-forget and cannot fail the call
 *
 * The check is diagnostic. It must never block, delay, or fail a write the DM
 * asked for. It runs detached and every failure inside it is swallowed into the
 * published state.
 *
 * @param ctx - the host context.
 * @param options - \`{ policy, fs, campaignDir }\`. \`policy\` is the calling
 *   session's resolved policy, which is exactly what the write itself will use.
 * @returns a promise resolving to the probe result, or undefined when the check
 *   has already run (it runs at most once per mount).
 */
export async function runWriteSelfCheck(ctx, options = {}) {
  const state = publishedProbeState
  if (state === undefined) return undefined
  // At most once per mount. A repeat would re-write the probe file on every
  // single tool call for no additional information.
  if (state.last !== undefined) return state.last

  const fs = options.fs ?? ctx?.get?.('fs')
  if (fs === undefined) {
    state.set({ status: PROBE_SKIPPED, message: 'no fs service' })
    return state.last
  }

  // Everything below is diagnostic and must never propagate. A self-check that
  // can throw into a DM's write call is worse than no self-check.
  try {
    // An EXPLICIT campaignDir is authoritative, including when it is ''. Only a
    // genuinely omitted option falls back to looking one up. Treating '' as
    // "look it up" is what let a test reach the live campaign: the caller said
    // "no campaign here" and the code went and found a real one instead.
    const supplied = Object.prototype.hasOwnProperty.call(options, 'campaignDir')
    let campaignDir = supplied ? options.campaignDir : undefined
    if (!supplied) {
      const located = await activeCampaignDir(fs, options.session)
      if (located?.error !== undefined) {
        state.set({ status: PROBE_SKIPPED, message: located.error })
        return state.last
      }
      campaignDir = located?.dir
    }
    if (typeof campaignDir !== 'string' || campaignDir === '') {
      state.set({ status: PROBE_SKIPPED, message: 'no active campaign' })
      return state.last
    }

    const result = await probeWrite(fs, campaignDir, { sandboxPolicy: options.policy })
    state.set(result)
    if (result.status === PROBE_REFUSED) {
      const logger = ctx?.get?.('logger')
      if (logger !== undefined && typeof logger.warn === 'function') {
        logger.warn('[dsh-dnd] write self-check FAILED: reads and dice will work, '
          + 'but nothing may be saved.')
        logger.warn('[dsh-dnd] ' + (result.message ?? ''))
      }
    }
    return result
  } catch (error) {
    const result = { status: PROBE_SKIPPED, message: 'self-check could not run: ' + (error?.message ?? error) }
    state.set(result)
    return result
  }
}

/**
 * The probe state the host publishes at mount, for tool families to read.
 *
 * A module-level singleton rather than a context property because the Cordis
 * Context exposes only \`get / on / provide / effect\` — there is no \`set\` to
 * hang an ad-hoc value on, and \`provide\` would register a fake SERVICE that
 * other plugins could then depend on. This bundle is a single mounted instance,
 * so one module-level slot is accurate rather than a shortcut.
 */
let publishedProbeState

/**
 * Publish the mount's probe state.
 * @param state - the state built by \`createProbeState\`.
 */
export function setWriteProbeState(state) { publishedProbeState = state }

/**
 * Read the mount's probe state, if a mount has published one.
 *
 * Returns undefined in unit tests and any context where \`apply\` never ran —
 * which callers must treat as "no warning to show", not as "writes are fine".
 * @returns the published probe state, or undefined.
 */
export function writeProbeState() { return publishedProbeState }

/**
 * Build the probe state the host shares with the tool families.
 *
 * @returns \`{ last, set(result), clear(), note() }\`. \`note()\` returns the
 *   paragraph a write tool should prepend to its output when the path is
 *   known-broken, or undefined when there is nothing to say.
 */
export function createProbeState() {
  let last
  return {
    get last() { return last },
    set(result) { last = result },
    clear() { last = undefined },
    /**
     * The advisory note for a write tool, or undefined.
     *
     * Deliberately worded as a WARNING, not an error: the tool has not tried
     * its own write yet, and the probe's verdict is about the mount-time
     * fallback policy, not about this specific call's session-scoped policy.
     * Overstating it would make a working session look broken.
     */
    note() {
      if (last === undefined || last.status !== PROBE_REFUSED) return undefined
      return 'WARNING: the startup write self-check was REFUSED for this campaign, '
        + 'so writes may silently not be saved even though reads and dice work.\n'
        + (last.message ?? '')
    },
  }
}
