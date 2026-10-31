import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { loadConfig, instanceId } from './config.mjs'

const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|TEMP|TMP|TMPDIR|LANG|LC_[A-Z]+|TZ|USER|USERNAME|LOGNAME|SHELL|XDG_[A-Z_]+|SSH_AUTH_SOCK|GIT_SSH_COMMAND|PORT|TRACKER_CONFIG|DIGEST_AT|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)$/i

export const serverEnv = (env, extra = {}, keep = []) => {
  const names = new Set(keep.map(k => k.toUpperCase()))
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEEP.test(k) || names.has(k.toUpperCase()))), ...extra }
}

const call = (port, method, p, timeoutMs) =>
  new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: timeoutMs, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, res => {
      let s = ''
      res.setEncoding('utf8')
      res.on('data', c => (s += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(s) })
        } catch {
          resolve({ status: res.statusCode, json: null })
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end(method === 'POST' ? '{}' : undefined)
  })

export const whoIsOn = async (port, projectsDir, timeoutMs = 8000) => {
  const r = await call(port, 'GET', '/api/meta', timeoutMs)
  if (!r) return { running: false, projium: false, sameInstance: false, legacy: false }
  if (r.status === 200 && r.json?.app === 'projium') return { running: true, projium: true, sameInstance: r.json.instance === instanceId(projectsDir), legacy: false, version: r.json.version }
  const old = r.status === 404 ? await call(port, 'GET', '/api/digest', timeoutMs) : null
  const legacy = old?.status === 200 && typeof old.json?.text === 'string' && 'at' in old.json
  return { running: true, projium: legacy, sameInstance: false, legacy }
}

const LEGACY = port => `an older Projium without /api/meta runs on port ${port}. If it is an earlier run of this same folder and the owner agrees, stop that node server.mjs process by its PID and run npm run --silent start:bg again; otherwise set another port in tracker.config.json`

const wait = ms => new Promise(r => setTimeout(r, ms))

const ownVersion = here => JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version

export const startBackground = async (here, { file, waitMs = 20000 } = {}) => {
  const c = loadConfig(here, file)
  const url = `http://127.0.0.1:${c.port}`
  if (!c.port) return { ok: false, url, error: 'start:bg needs a fixed port; set port in tracker.config.json' }
  const on = await whoIsOn(c.port, c.projectsDir, 3000)
  if (on.sameInstance) {
    const version = ownVersion(here)
    return on.version === version ? { ok: true, url, already: true } : { ok: true, url, already: true, note: `the running server is version ${on.version}, this folder has ${version}; run npm run --silent stop, then npm run --silent start:bg` }
  }
  if (on.legacy) return { ok: false, url, error: LEGACY(c.port) }
  if (on.running) return { ok: false, url, error: on.projium ? `another Projium with a different projectsDir runs on port ${c.port}; stop it or change port` : `port ${c.port} is used by another program; set port in tracker.config.json` }
  const dataDir = path.dirname(c.dbFile)
  fs.mkdirSync(dataDir, { recursive: true })
  const out = fs.openSync(path.join(dataDir, 'server.out.log'), 'a')
  const err = fs.openSync(path.join(dataDir, 'server.err.log'), 'a')
  let child
  try {
    child = spawn(process.execPath, ['--no-warnings', path.join(here, 'server.mjs')], {
      cwd: here,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      env: serverEnv(process.env, file ? { TRACKER_CONFIG: file } : {}, c.digest.env),
    })
  } finally {
    fs.closeSync(out)
    fs.closeSync(err)
  }
  let failed = null
  child.once('error', e => (failed = `the server did not start: ${e?.code ?? e?.message}`))
  child.once('exit', (code, signal) => (failed = `the server exited (${signal ?? `code ${code}`}); see ${path.join(dataDir, 'server.err.log')}`))
  child.unref()
  for (const t0 = Date.now(); Date.now() - t0 < waitMs; await wait(300)) {
    if (failed) return { ok: false, url, error: failed }
    if ((await whoIsOn(c.port, c.projectsDir, 2000)).sameInstance) return { ok: true, url, pid: child.pid, logs: dataDir }
  }
  try {
    process.kill(child.pid)
  } catch {}
  return { ok: false, url, error: `the server did not answer within ${waitMs / 1000} s and was stopped; see ${path.join(dataDir, 'server.err.log')}` }
}

export const stopServer = async (here, { file, waitMs = 10000 } = {}) => {
  const c = loadConfig(here, file)
  const url = `http://127.0.0.1:${c.port}`
  const on = await whoIsOn(c.port, c.projectsDir, 3000)
  if (!on.running) return { ok: true, url, stopped: false, note: 'nothing runs on this port' }
  if (on.legacy) return { ok: false, url, error: LEGACY(c.port) }
  if (!on.sameInstance) return { ok: false, url, error: on.projium ? 'the Projium on this port uses another projects folder; not stopping it' : 'another program uses this port; not stopping it' }
  const r = await call(c.port, 'POST', '/api/shutdown', 5000)
  if (r && r.status !== 200) return { ok: false, url, error: 'the server refused to stop' }
  for (const t0 = Date.now(); Date.now() - t0 < waitMs; await wait(200)) if (!(await whoIsOn(c.port, c.projectsDir, 1000)).running) return { ok: true, url, stopped: true }
  return { ok: false, url, error: 'the server is still answering' }
}
