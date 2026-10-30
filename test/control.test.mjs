import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { startBackground, stopServer, whoIsOn } from '../lib/control.mjs'

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
  assert.match(refused.error, /another projectsDir/)
  assert.equal((await whoIsOn(port, projects)).sameInstance, true, 'a stop with another config leaves the server running')

  const stopped = await stopServer(repoRoot, { file })
  assert.deepEqual([stopped.ok, stopped.stopped], [true, true])
  assert.equal((await whoIsOn(port, projects)).running, false)
  pid = null
  assert.equal((await stopServer(repoRoot, { file })).stopped, false)
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
