import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startBackground, stopServer } from '../lib/control.mjs'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const notice = (title, text) => console.log(`::notice title=${title}::${String(text).replace(/%/g, '%25').replace(/[\r\n]+/g, ' ').slice(0, 900)}`)
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

let t0 = Date.now()
const plain = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 120000 })
notice('powershell start', `${Date.now() - t0} ms, exit ${plain.status}, version ${plain.stdout.trim()}`)

t0 = Date.now()
const typed = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'public static class ProbeType { public static int One() { return 1; } }'; [ProbeType]::One()"], { encoding: 'utf8', timeout: 120000 })
notice('Add-Type compile', `${Date.now() - t0} ms, exit ${typed.status}, out ${typed.stdout.trim()} err ${(typed.stderr ?? '').trim().slice(0, 300)}`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projium-probe-'))
const projects = path.join(dir, 'projects')
fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true })
fs.writeFileSync(path.join(projects, 'alpha', 'alpha.md'), '---\nstage: fixes\n---\n')
const file = path.join(dir, 'tracker.config.json')
fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: dir, transcriptsDir: path.join(dir, 't'), dbFile: path.join(dir, 'data', 'db.sqlite'), port: 3391 }))
process.env.PORT = '3391'

for (const breakaway of [true, false]) {
  t0 = Date.now()
  const r = await startBackground(repo, { file, waitMs: 60000, breakaway })
  notice(`start:bg breakaway=${breakaway}`, `${Date.now() - t0} ms ${JSON.stringify(r)}`)
  const s = await stopServer(repo, { file })
  notice(`stop breakaway=${breakaway}`, JSON.stringify(s))
  const errLog = path.join(dir, 'data', 'server.err.log')
  if (fs.existsSync(errLog)) notice(`server.err.log breakaway=${breakaway}`, fs.readFileSync(errLog, 'utf8').slice(-800) || 'empty')
}
const job = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class J { [DllImport(\"kernel32.dll\")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); }'; $r = $false; [void][J]::IsProcessInJob([J]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$r); $r"], { encoding: 'utf8', timeout: 120000 })
notice('runner job', `in a job: ${job.stdout.trim()} ${(job.stderr ?? '').trim().slice(0, 200)}`)
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
