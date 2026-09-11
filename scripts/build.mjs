// build.mjs — assemble lib/ from src/ for the published bundle.
// Host modules are plain ESM .mjs (copy verbatim). The Client panel is plain JS
// ESM (copy verbatim to lib/client.js). No transpile/bundle step required.
import { mkdir, rm, copyFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..'
const srcHost = path.join(root, 'src/host')
const srcClient = path.join(root, 'src/client')
const libHost = path.join(root, 'lib/host')
const libClient = path.join(root, 'lib/client')
const lib = path.join(root, 'lib')

await rm(lib, { recursive: true, force: true })
await mkdir(libHost, { recursive: true })
await mkdir(libClient, { recursive: true })

for (const file of await readdir(srcHost)) {
  if (file.endsWith('.mjs')) await copyFile(path.join(srcHost, file), path.join(libHost, file))
  console.log('host ->', 'lib/host/' + file)
}

const clientFiles = (await readdir(srcClient)).filter((f) => f.endsWith('.js'))
for (const file of clientFiles) {
  await copyFile(path.join(srcClient, file), path.join(libClient, file))
  console.log('client ->', 'lib/client/' + file)
}
// Convenience alias: the package exports "./client" pointing at lib/client.js.
await copyFile(path.join(libClient, clientFiles[0]), path.join(lib, 'client.js'))
console.log('client alias -> lib/client.js')

console.log('build OK')
