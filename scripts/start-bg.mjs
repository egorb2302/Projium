import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackground } from '../lib/control.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
try {
  const r = await startBackground(here)
  console.log(JSON.stringify(r, null, 2))
  process.exitCode = r.ok ? 0 : 1
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2))
  process.exitCode = 1
}
