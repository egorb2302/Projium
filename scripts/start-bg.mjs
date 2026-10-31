import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startBackground, openCommand } from '../lib/control.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
try {
  const r = await startBackground(here)
  console.log(JSON.stringify(r, null, 2))
  process.exitCode = r.ok ? 0 : 1
  if (r.ok && process.argv.includes('--open')) {
    const [cmd, args] = openCommand(r.url)
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2))
  process.exitCode = 1
}
