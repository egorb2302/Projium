import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { loadConfig, instanceId } from './config.mjs'

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
  if (!r) return { running: false, projium: false, sameInstance: false }
  const projium = r.status === 200 && r.json?.app === 'projium'
  return { running: true, projium, sameInstance: projium && r.json.instance === instanceId(projectsDir), version: projium ? r.json.version : null }
}

const wait = ms => new Promise(r => setTimeout(r, ms))

export const startBackground = async (here, { file, waitMs = 20000 } = {}) => {
  const c = loadConfig(here, file)
  const on = await whoIsOn(c.port, c.projectsDir, 3000)
  const url = `http://127.0.0.1:${c.port}`
  if (on.sameInstance) return { ok: true, url, already: true }
  if (on.running) return { ok: false, url, error: on.projium ? `another Projium with a different projectsDir runs on port ${c.port}; stop it or change port` : `port ${c.port} is used by another program; set port in tracker.config.json` }
  const dataDir = path.dirname(c.dbFile)
  fs.mkdirSync(dataDir, { recursive: true })
  const out = fs.openSync(path.join(dataDir, 'server.out.log'), 'a')
  const err = fs.openSync(path.join(dataDir, 'server.err.log'), 'a')
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, 'server.mjs')], {
    cwd: here,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: { ...process.env, ...(file ? { TRACKER_CONFIG: file } : {}) },
  })
  child.unref()
  fs.closeSync(out)
  fs.closeSync(err)
  let exited = null
  child.once('exit', code => (exited = code))
  for (const t0 = Date.now(); Date.now() - t0 < waitMs; await wait(300)) {
    if (exited != null) return { ok: false, url, error: `the server exited with code ${exited}; see ${path.join(dataDir, 'server.err.log')}` }
    if ((await whoIsOn(c.port, c.projectsDir, 2000)).sameInstance) return { ok: true, url, pid: child.pid, logs: dataDir }
  }
  return { ok: false, url, pid: child.pid, error: `the server did not answer within ${waitMs / 1000} s; see ${path.join(dataDir, 'server.err.log')}` }
}

export const stopServer = async (here, { file, waitMs = 10000 } = {}) => {
  const c = loadConfig(here, file)
  const url = `http://127.0.0.1:${c.port}`
  const on = await whoIsOn(c.port, c.projectsDir, 3000)
  if (!on.running) return { ok: true, url, stopped: false, note: 'nothing runs on this port' }
  if (!on.sameInstance) return { ok: false, url, error: on.projium ? 'the Projium on this port uses another projectsDir; not stopping it' : 'another program uses this port; not stopping it' }
  const r = await call(c.port, 'POST', '/api/shutdown', 5000)
  if (r?.status !== 200) return { ok: false, url, error: 'the server refused to stop' }
  for (const t0 = Date.now(); Date.now() - t0 < waitMs; await wait(200)) if (!(await whoIsOn(c.port, c.projectsDir, 1000)).running) return { ok: true, url, stopped: true }
  return { ok: false, url, error: 'the server is still answering' }
}
