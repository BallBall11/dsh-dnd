// watch.mjs — rebuild lib/ whenever src/ changes. Lightweight dev loop.
import { watch } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..'
async function build() {
  try { execSync('node ' + path.join(root, 'scripts/build.mjs'), { stdio: 'inherit' }) }
  catch (e) { console.error('build failed', e.message) }
}
await build()
console.log('watching src/ …')
const watcher = watch(path.join(root, 'src'), { recursive: true })
for await (const ev of watcher) { await build() }
