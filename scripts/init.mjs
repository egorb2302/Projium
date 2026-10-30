import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeConfig } from '../lib/init.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
try {
  const r = writeConfig(here, process.argv.slice(2))
  console.log(JSON.stringify({ ok: true, ...r, next: 'npm run doctor' }, null, 2))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2))
  process.exitCode = 1
}
