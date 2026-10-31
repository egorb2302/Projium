import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { startBackground, stopServer, whoIsOn, serverEnv, openCommand } from '../lib/control.mjs'

test('an older Projium without /api/meta is recognized and neither started over nor stopped', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-legacy-'))
  const old = http.createServer((req, res) => {
    if (req.url === '/api/digest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: 'digest', at: '10:00', lastAuto: null }))
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise(r => old.listen(0, '127.0.0.1', r))
  const port = old.address().port
  const keepPort = process.env.PORT
  process.env.PORT = String(port)
  t.after(() => {
    if (keepPort === undefined) delete process.env.PORT
    else process.env.PORT = keepPort
    old.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dir, 'p'))
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'p'), reposDir: dir }))
  const on = await whoIsOn(port, path.join(dir, 'p'))
  assert.deepEqual([on.running, on.legacy, on.sameInstance], [true, true, false])
  assert.match((await startBackground(repoRoot, { file })).error, /older Projium without \/api\/meta/)
  assert.match((await stopServer(repoRoot, { file })).error, /older Projium/)
  process.env.PORT = '0'
  assert.match((await startBackground(repoRoot, { file })).error, /needs a fixed port/)
})

test('the background server gets only the environment it needs', () => {
  const env = serverEnv({ PATH: '/bin', Path: 'x', USERPROFILE: 'u', TELEGRAM_BOT_TOKEN: 't', OPENAI_API_KEY: 'sk-x', npm_config_cache: 'c', AWS_SECRET_ACCESS_KEY: 's' }, { TRACKER_CONFIG: 'f' })
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'Path', 'TELEGRAM_BOT_TOKEN', 'TRACKER_CONFIG', 'USERPROFILE'])
  const withDigest = serverEnv({ PATH: '/bin', SLACK_BOT_TOKEN: 'xoxb', OPENAI_API_KEY: 'sk-x' }, {}, ['slack_bot_token'])
  assert.deepEqual(Object.keys(withDigest).sort(), ['PATH', 'SLACK_BOT_TOKEN'], 'variables named in digest.env pass through')
})

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const freePort = () =>
  new Promise(resolve => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

test('start:bg starts a detached server once, stop stops only that server', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-control-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'alpha', 'alpha.md'), '---\nstage: fixes\n---\n')
  const port = await freePort()
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: dir, transcriptsDir: path.join(dir, 't'), dbFile: path.join(dir, 'data', 'db.sqlite'), port }))
  const keepPort = process.env.PORT
  process.env.PORT = String(port)
  let pid = null
  t.after(() => {
    if (keepPort === undefined) delete process.env.PORT
    else process.env.PORT = keepPort
    if (pid)
      try {
        process.kill(pid)
      } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const started = await startBackground(repoRoot, { file })
  pid = started.pid
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal((await whoIsOn(port, projects)).sameInstance, true)
  assert.equal((await startBackground(repoRoot, { file })).already, true, 'a second start does not spawn another server')

  const foreign = path.join(dir, 'foreign.json')
  fs.mkdirSync(path.join(dir, 'other'))
  fs.writeFileSync(foreign, JSON.stringify({ projectsDir: path.join(dir, 'other'), reposDir: dir, port }))
  const refused = await stopServer(repoRoot, { file: foreign })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /another projects folder/)
  assert.equal((await whoIsOn(port, projects)).sameInstance, true, 'a stop with another config leaves the server running')

  const stopped = await stopServer(repoRoot, { file })
  assert.deepEqual([stopped.ok, stopped.stopped], [true, true])
  assert.equal((await whoIsOn(port, projects)).running, false)
  pid = null
  assert.equal((await stopServer(repoRoot, { file })).stopped, false)
})

const fakeInstall = async (t, serverCode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-fake-'))
  fs.mkdirSync(path.join(dir, 'p'))
  fs.writeFileSync(path.join(dir, 'server.mjs'), serverCode)
  const port = await freePort()
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'p'), reposDir: dir, port }))
  const keepPort = process.env.PORT
  process.env.PORT = String(port)
  t.after(() => {
    if (keepPort === undefined) delete process.env.PORT
    else process.env.PORT = keepPort
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, file }
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('start:bg reports a server that exits at once, with its exit code', async t => {
  const { dir, file } = await fakeInstall(t, 'process.exit(3)\n')
  const r = await startBackground(dir, { file, waitMs: 10000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /exited \(code 3\)/)
})

test('start:bg stops a server that never answers instead of leaving it behind', async t => {
  const { dir, file } = await fakeInstall(t, "import fs from 'node:fs'\nfs.writeFileSync('pid.txt', String(process.pid))\nsetInterval(() => {}, 1e6)\n")
  const r = await startBackground(dir, { file, waitMs: 1500 })
  assert.equal(r.ok, false)
  assert.match(r.error, /did not answer within 1\.5 s and was stopped/)
  const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'))
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise(res => setTimeout(res, 100))
  assert.equal(alive(pid), false, 'no orphan server is left')
})

test('--open uses the platform opener', () => {
  const url = 'http://127.0.0.1:3310'
  assert.deepEqual(openCommand(url, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', url]])
  assert.deepEqual(openCommand(url, 'darwin'), ['open', [url]])
  assert.deepEqual(openCommand(url, 'linux'), ['xdg-open', [url]])
})

test('start:bg refuses a port another program uses', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-control-'))
  const other = http.createServer((req, res) => res.end('hello'))
  await new Promise(r => other.listen(0, '127.0.0.1', r))
  t.after(() => {
    other.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'tracker.config.json')
  fs.mkdirSync(path.join(dir, 'p'))
  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'p'), reposDir: dir, port: other.address().port }))
  const keepPort = process.env.PORT
  process.env.PORT = String(other.address().port)
  try {
    const r = await startBackground(repoRoot, { file })
    assert.equal(r.ok, false)
    assert.match(r.error, /used by another program/)
  } finally {
    if (keepPort === undefined) delete process.env.PORT
    else process.env.PORT = keepPort
  }
})
