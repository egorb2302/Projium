import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startBackground, openCommand } from '../lib/control.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let r
let inner = null
try {
  inner = process.env.PROJIUM_START ? JSON.parse(process.env.PROJIUM_START) : null
  r = inner ? await startBackground(inner.here, { file: inner.file ?? undefined, waitMs: inner.waitMs, breakaway: false }) : await startBackground(here)
} catch (e) {
  r = { ok: false, error: String(e?.message ?? e) }
}
process.exitCode = r.ok ? 0 : 1
if (inner) fs.writeFileSync(inner.result, JSON.stringify(r))
else {
  console.log(JSON.stringify(r, null, 2))
  if (r.ok && process.argv.includes('--open')) {
    const [cmd, args] = openCommand(r.url)
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
  }
}
