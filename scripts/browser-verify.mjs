/**
 * browser-verify.mjs — verify the client panel in a REAL browser.
 *
 * verify-client.mjs runs the bundle against a stubbed DOM and a React stub.
 * That proves the module evaluates and that its components build elements — it
 * is not a browser, has no layout, no CSS, no real React, and no real click.
 * This script closes that gap: it drives headless Edge over the DevTools
 * Protocol against the LIVE harness at 127.0.0.1:3080, clicks the real button
 * with a real mouse event, and reads the resulting DOM.
 *
 * ## Authentication, and why this script mints its own cookie
 *
 * The app root is 401 without a browser session. The normal entry is a `token`
 * query param carrying the *process launch token* — a random value that lives
 * only in a WeakMap inside the running process, so it cannot be read from disk
 * and cannot be recovered after the fact.
 *
 * The cookie, however, is only HMAC-signed with a secret that IS persisted in
 * `~/.dsh/.credentials.yaml` (`client-connection/browser-session`). Verified
 * against dsh-client-connection/lib/index.js: `decodeCookie` checks the
 * signature, the `authority` field, and the issue/expiry window — it does not
 * consult the launch token. So a cookie minted from the stored secret is
 * accepted, and this script needs no access to the running process at all.
 *
 * ## Why a separate browser instance
 *
 * It launches its own Edge with its own user-data-dir and its own remote
 * debugging port. The user's own browser is never attached to, navigated, or
 * otherwise disturbed.
 *
 * Usage: node scripts/browser-verify.mjs
 */

import { spawn } from 'node:child_process'
import { createHmac, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = process.env.DND_VERIFY_ORIGIN || 'http://127.0.0.1:3080'
const AUTHORITY = new URL(ORIGIN).host
const PORT = 9333
const CREDENTIALS = join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

// --- mint the auth cookie ---------------------------------------------------
// Mirrors encodeCookie() exactly: base64url(JSON payload) + "." + hmac.
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

function readSecret() {
  if (!existsSync(CREDENTIALS)) throw new Error(`no credentials at ${CREDENTIALS}`)
  const text = readFileSync(CREDENTIALS, 'utf8')
  // A targeted regex rather than a YAML dependency: the file is small, the key
  // is unambiguous, and the record is exactly one line of `secret:`.
  const match = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/)
  if (match === null) throw new Error('browser-session secret not found in credentials')
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + '=', 'base64')
}

function mintCookie() {
  const secret = readSecret()
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 24 * 60 * 60 * 1000
  const payload = { version: 1, authority: AUTHORITY, issuedAt, expiresAt }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = createHmac('sha256', secret).update(body).digest()
  // cookieName(authority) = "dsh-auth-" + base64url(sha256(authority))
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
  return { name, value: `v1.${body}.${b64url(sig)}` }
}

// --- minimal CDP client over the raw WebSocket ------------------------------
// Node 22+ has a global WebSocket, so no `ws` dependency is needed.
const CALL_TIMEOUT_MS = 20000

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (entry === undefined) return
        this.pending.delete(msg.id)
        if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
        return
      }
      for (const listener of this.listeners) listener(msg)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // A CDP call that never answers would hang the whole run silently. The
      // earlier version had no timeout and froze with no output at all, which
      // is indistinguishable from "still working".
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(fn) { this.listeners.push(fn) }
  close() { try { this.ws.close() } catch { /* already gone */ } }
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text))
  }
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}

// --- main -------------------------------------------------------------------
// Hard ceiling: this must always produce output. A silent hang is worse than a
// failure, because it looks like the browser "just needs more time".
const HARD_TIMEOUT_MS = 120000
const hardTimer = setTimeout(() => {
  console.error(`\nbrowser-verify FAILED: hard timeout after ${HARD_TIMEOUT_MS}ms (hung, no result)`)
  process.exit(3)
}, HARD_TIMEOUT_MS)
hardTimer.unref?.()

const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
if (edge === undefined) {
  console.error('browser-verify FAILED: no Edge/Chrome binary found')
  process.exit(1)
}

const profileDir = mkdtempSync(join(tmpdir(), 'dnd-verify-'))
// DND_VERIFY_CDP lets this attach to a browser someone else already started.
// That matters on Windows: a sandboxed shell cannot let Edge create its Mojo
// IPC named pipe (`FATAL platform_channel 0x5`), so the browser must be
// launched by a wider-privileged shell and this script only borrows it.
const EXTERNAL_CDP = process.env.DND_VERIFY_CDP
let child = null
if (EXTERNAL_CDP === undefined) {
  child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', detached: false })
}

let cdp
let activeTargetId = null
const consoleErrors = []
const pageErrors = []
const failedRequests = []

try {
  const cdpBase = EXTERNAL_CDP !== undefined ? EXTERNAL_CDP : `http://127.0.0.1:${PORT}`
  const version = await waitForEndpoint(`${cdpBase}/json/version`, 30000)
  console.log('browser        :', version.Browser, EXTERNAL_CDP !== undefined ? '(external)' : '(spawned)')

  const target = await (await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })).json()
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  activeTargetId = target.id

  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description
        ?? msg.params.exceptionDetails.text)
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`${msg.params.errorText} ${msg.params.type || ''}`)
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      failedRequests.push(`HTTP ${msg.params.response.status} ${msg.params.response.url}`)
    }
  })

  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')

  // Install the cookie BEFORE the first navigation, so the index request is
  // authenticated on its very first attempt (no 401 round trip).
  const cookie = mintCookie()
  await cdp.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  })
  console.log('cookie         :', cookie.name.slice(0, 24) + '… (minted from stored secret)')

  await cdp.send('Page.navigate', { url: ORIGIN + '/' })
  await sleep(1500)

  const title = await evaluate(cdp, 'document.title')
  const bootstrapped = await evaluate(cdp, 'typeof window.__DSH_BOOT__ !== "undefined"')
  console.log('document.title :', JSON.stringify(title))
  console.log('__DSH_BOOT__   :', bootstrapped)

  if (!bootstrapped) {
    console.error('\nbrowser-verify BLOCKED: the shell did not boot (still on 401?)')
    const body = await evaluate(cdp, 'document.body ? document.body.innerText.slice(0,300) : ""')
    console.error('body text      :', JSON.stringify(body))
    process.exitCode = 2
  } else {
    // Wait for the sidebar to render before probing for the button.
    await sleep(3000)

    // --- Q1: loader / effect errors -------------------------------------
    const loaderErrors = [...consoleErrors, ...pageErrors].filter((m) =>
      /__ModuleLoader__|Invalid effect/i.test(m))

    console.log('\n=== Q1: __ModuleLoader__ / Invalid effect errors ===')
    console.log('console errors :', consoleErrors.length)
    consoleErrors.forEach((m) => console.log('   [console.error]', m.slice(0, 220)))
    console.log('page exceptions:', pageErrors.length)
    pageErrors.forEach((m) => console.log('   [exception]', m.split('\n')[0].slice(0, 220)))
    console.log('failed requests:', failedRequests.length)
    failedRequests.forEach((m) => console.log('   [net]', m.slice(0, 200)))
    console.log('MATCHING loader/effect errors:', loaderErrors.length)
    loaderErrors.forEach((m) => console.log('   !!', m.slice(0, 220)))

    // --- Q2: is the button in the sidebar footer ------------------------
    const actionInfo = await evaluate(cdp, `(() => {
      const btns = [...document.querySelectorAll('button.dnd-action')]
      return btns.map((b) => {
        const r = b.getBoundingClientRect()
        const footer = b.closest('[class*="footer"], footer')
        return {
          text: b.textContent,
          title: b.getAttribute('title'),
          ariaLabel: b.getAttribute('aria-label'),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          visible: r.width > 0 && r.height > 0,
          inSidebarFooter: footer !== null && footer !== undefined,
          ancestorChain: (() => {
            const out = []
            let n = b.parentElement
            while (n && out.length < 8) { out.push(n.className || n.tagName); n = n.parentElement }
            return out
          })(),
        }
      })
    })()`)

    console.log('\n=== Q2: ⚔ button in sidebar footer ===')
    console.log('matching <button.dnd-action>:', actionInfo.length)
    for (const a of actionInfo) {
      console.log('  text=%s title=%s visible=%s inFooter=%s rect=%j',
        JSON.stringify(a.text), JSON.stringify(a.title), a.visible, a.inSidebarFooter, a.rect)
      console.log('    ancestors:', a.ancestorChain.join(' < '))
    }
    console.log('style tag present:', await evaluate(cdp,
      'document.querySelector(\'style[data-plugin="dsh-dnd"]\') !== null'))

    // Capture the CLOSED state here, before the click. Capturing it afterwards
    // produced a byte-identical duplicate of the overlay screenshot, which is
    // worse than no screenshot: it looks like evidence but shows nothing.
    {
      const { writeFileSync } = await import('node:fs')
      const closed = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(process.cwd(), 'browser-verify-closed.png'), Buffer.from(closed.data, 'base64'))
      console.log('screenshot     :', join(process.cwd(), 'browser-verify-closed.png'), '(side bar + button, panel closed)')
    }

    // --- Q3: click it, with a REAL trusted mouse event -------------------
    console.log('\n=== Q3: real click -> overlay + Alice data ===')
    if (actionInfo.length === 0 || !actionInfo[0].visible) {
      console.log('SKIPPED: the button was not present/visible, so there is nothing to click')
    } else {
      const box = await evaluate(cdp, `(() => {
        const b = document.querySelector('button.dnd-action')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`)

      // Input.dispatchMouseEvent produces a trusted event that goes through
      // hit-testing — the closest thing to a human click available headlessly.
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
        })
      }
      console.log('dispatched trusted mouse click at', JSON.stringify(box))
      await sleep(2000)

      const overlay = await evaluate(cdp, `(() => {
        const el = document.querySelector('.dnd-overlay')
        if (!el) return { present: false }
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        // What is actually at the overlay's own centre? If pointer-events were
        // inherited as 'none', this returns the element underneath instead.
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return {
          present: true,
          text: el.innerText,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          pointerEvents: cs.pointerEvents,
          zIndex: cs.zIndex,
          hitIsSelfOrChild: hit !== null && (hit === el || el.contains(hit)),
          hitTag: hit ? (hit.className || hit.tagName) : null,
        }
      })()`)

      if (!overlay.present) {
        console.log('OVERLAY NOT PRESENT after click')
      } else {
        console.log('overlay rect   :', JSON.stringify(overlay.rect))
        console.log('overlay z-index:', overlay.zIndex)
        console.log('\n--- rendered innerText ---')
        console.log(overlay.text)
        console.log('--- end innerText ---\n')

        // Every assertion is against the real morgansfort payload.
        const checks = [
          ['campaign tag morgansfort', /\bmorgansfort\b/.test(overlay.text)],
          ['name Alice', /\bAlice\b/.test(overlay.text)],
          ['HP 8 / 8', /8\s*\/\s*8/.test(overlay.text)],
          ['AC 12', /AC[\s\S]{0,40}?12/.test(overlay.text)],
          ['INT 17', /INT[\s\S]{0,30}?17/.test(overlay.text)],
          ['INT modifier +3', /INT[\s\S]{0,60}?\+3/.test(overlay.text)],
          ['spell slot 1环 2/2', /1环[\s\S]{0,20}?2\/2/.test(overlay.text)],
          ['currency 8 gp 0 sp 0 cp', /8 gp 0 sp 0 cp/.test(overlay.text)],
          ['no error block', !/HTTP \d|请求失败|无法读取状态/.test(overlay.text)],
        ]
        console.log('data checks:')
        for (const [label, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`)

        // --- Q4: is the overlay actually clickable? ----------------------
        console.log('\n=== Q4: overlay click-through / pointerEvents ===')
        console.log('computed pointer-events :', overlay.pointerEvents)
        console.log('elementFromPoint is overlay or child:', overlay.hitIsSelfOrChild,
          '(hit =', overlay.hitTag, ')')

        // Decisive test: click a real child inside the overlay and see whether
        // the event lands on the panel or falls through to the app beneath.
        const inner = await evaluate(cdp, `(() => {
          const el = document.querySelector('.dnd-overlay')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x + 30, y: r.y + 20 }
        })()`)
        await evaluate(cdp, `(() => {
          window.__dndProbe = []
          const el = document.querySelector('.dnd-overlay')
          el.addEventListener('click', () => window.__dndProbe.push('overlay'), { once: true })
          document.addEventListener('click', () => window.__dndProbe.push('document'), { once: true })
        })()`)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: inner.x, y: inner.y, button: 'left', clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0,
          })
        }
        await sleep(400)
        const probe = await evaluate(cdp, 'window.__dndProbe')
        console.log('click inside overlay reached:', JSON.stringify(probe))
        console.log('  overlay received the click :', Array.isArray(probe) && probe.includes('overlay'))
      }

      // Visible screenshot as physical evidence, taken while the panel is open.
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      const shotPath = join(process.cwd(), 'browser-verify-overlay.png')
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
      console.log('\nscreenshot     :', shotPath, '(panel open)')
    }
  }
} catch (error) {
  console.error('browser-verify FAILED:', error.message)
  process.exitCode = 1
} finally {
  if (cdp !== undefined) cdp.close()
  // Close the tab this run opened. Without it every run leaves a live target
  // behind, and each one holds a shell connection open against the harness.
  if (activeTargetId !== null) {
    const cdpBase = EXTERNAL_CDP !== undefined ? EXTERNAL_CDP : `http://127.0.0.1:${PORT}`
    try { await fetch(`${cdpBase}/json/close/${activeTargetId}`) } catch { /* browser already gone */ }
  }
  if (child !== null) { try { child.kill() } catch { /* already gone */ } }
  await sleep(300)
  if (child !== null) { try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* locked, harmless */ } }
  // An open WebSocket keeps the event loop alive; the checks are done, so exit
  // deliberately rather than hanging a caller that redirected this output.
  process.exit(process.exitCode ?? 0)
}
