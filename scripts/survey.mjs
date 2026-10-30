import path from 'node:path'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { survey } from '../lib/survey.mjs'
import { loadConfig, expandHome } from '../lib/config.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
try {
  const { values: v } = parseArgs({ args: process.argv.slice(2), options: { dir: { type: 'string' }, 'no-recursive': { type: 'boolean', default: false } }, strict: true })
  const dir = v.dir ? path.resolve(process.env.INIT_CWD || process.cwd(), expandHome(v.dir)) : loadConfig(here).projectsDir
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`folder not found: ${dir}`)
  console.log(JSON.stringify({ ok: true, ...survey(dir, { recursive: !v['no-recursive'] }) }, null, 2))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2))
  process.exitCode = 1
}
