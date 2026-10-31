import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { autostartPlan } from '../lib/autostart.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const flag = process.argv.find(a => a.startsWith('--platform='))
let plan
try {
  plan = autostartPlan(here, flag ? { platform: flag.slice('--platform='.length) } : {})
} catch (e) {
  plan = { ok: false, error: e.message }
}
console.log(JSON.stringify(plan, null, 2))
process.exitCode = plan.ok ? 0 : 1
