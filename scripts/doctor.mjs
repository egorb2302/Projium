import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose } from '../lib/doctor.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const report = await diagnose(here)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
