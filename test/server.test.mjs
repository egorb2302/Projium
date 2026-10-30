import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createApp, previewPath, publicError } from '../server.mjs'

test('a preview is found from an Obsidian link, a path inside the projects folder or a bare file name', () => {
  const root = path.join('vault', 'Projects')
  assert.equal(previewPath('[[notes/Projects/alpha/preview.png]]', root, 'alpha'), 'alpha/preview.png')
  assert.equal(previewPath('![[Projects/alpha/shot.webp|cover]]', root, 'alpha'), 'alpha/shot.webp')
  assert.equal(previewPath('alpha/preview.jpg', root, 'alpha'), 'alpha/preview.jpg')
  assert.equal(previewPath('preview.png', root, 'alpha'), 'alpha/preview.png')
  assert.equal(previewPath('[[MyProjects/alpha/preview.png]]', root, 'alpha'), 'MyProjects/alpha/preview.png')
  assert.equal(previewPath('preview.svg', root, 'alpha'), null)
  assert.equal(previewPath('', root, 'alpha'), null)
})

const CARD = [
  '---',
  'title: demo',
  'status: active',
  'stage: fixes',
  'next_step: "first"',
  'accepted_at:',
  '---',
  '',
  '# demo',
  '',
  '## Tasks',
  '',
  '- [ ] Ship it · p1 ^t-aaaa',
  '',
  '## Program',
  '',
  'body',
  '',
].join('\n')

const setup = async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  const file = path.join(projects, 'demo', 'demo.md')
  fs.writeFileSync(file, CARD)
  fs.writeFileSync(path.join(projects, 'demo', 'preview.png'), 'png')
  fs.writeFileSync(path.join(dir, 'secret.png'), 'no')
  const a = createApp({ projectsRoot: projects, reposRoot: path.join(dir, 'repos'), dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false })
  const port = await a.start()
  t.after(async () => {
    await a.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const call = (method, p, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(s)
          } catch {}
          resolve({ status: res.statusCode, json, text: s })
        })
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  return { file, call, port }
}

test('acceptance: an external edit and a dashboard edit never overwrite each other', async t => {
  const { file, call } = await setup(t)
  const seen = (await call('GET', '/api/projects/demo')).json
  assert.equal(seen.fields.next_step, 'first')

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: paused by the owner'))
  const ok = await call('POST', '/api/projects/demo/field', { key: 'next_step', value: 'second', expected: seen.fields.next_step })
  assert.equal(ok.status, 200)
  const after = fs.readFileSync(file, 'utf8')
  assert.match(after, /status: paused by the owner/)
  assert.match(after, /next_step: "second"/)

  fs.writeFileSync(file, after.replace('next_step: "second"', 'next_step: "typed in Obsidian"'))
  const external = fs.readFileSync(file, 'utf8')
  const clash = await call('POST', '/api/projects/demo/field', { key: 'next_step', value: 'third', expected: 'second' })
  assert.equal(clash.status, 409)
  assert.equal(clash.json.current, 'typed in Obsidian')
  assert.equal(fs.readFileSync(file, 'utf8'), external)

  const over = await call('POST', '/api/projects/demo/field', { key: 'next_step', value: 'third', expected: clash.json.current })
  assert.equal(over.status, 200)
  assert.match(fs.readFileSync(file, 'utf8'), /next_step: "third"/)
})

test('acceptance: a task edited in Obsidian is not overwritten by a stale toggle', async t => {
  const { file, call } = await setup(t)
  const task = (await call('GET', '/api/projects/demo')).json.tasks[0]
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Ship it · p1', 'Ship it today · p1'))
  const before = fs.readFileSync(file, 'utf8')
  const r = await call('POST', '/api/projects/demo/task', { op: 'toggle', id: task.id, expected: task })
  assert.equal(r.status, 409)
  assert.equal(fs.readFileSync(file, 'utf8'), before)

  const fresh = (await call('GET', '/api/projects/demo')).json.tasks[0]
  const ok = await call('POST', '/api/projects/demo/task', { op: 'toggle', id: fresh.id, expected: fresh })
  assert.equal(ok.status, 200)
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] Ship it today · p1 \^t-aaaa/)

  const added = await call('POST', '/api/projects/demo/task', { op: 'add', task: { text: 'Next thing', due: '2026-11-01', p: 'p2' } })
  assert.equal(added.status, 200)
  assert.equal(added.json.tasks.length, 2)
  assert.match(fs.readFileSync(file, 'utf8'), /- \[ \] Next thing · due 2026-11-01 · p2 \^t-[a-z0-9]{4}\n/)
})

test('rejects bad values, foreign hosts and origins, and paths outside the projects folder', async t => {
  const { call, port } = await setup(t)
  assert.equal((await call('POST', '/api/projects/demo/field', { key: 'stage', value: 'shipped', expected: 'fixes' })).status, 400)
  assert.equal((await call('POST', '/api/projects/demo/field', { key: 'status', value: 'x', expected: 'active' })).status, 400)
  assert.equal((await call('GET', '/api/projects', undefined, { host: `evil.example:${port}` })).status, 403)
  assert.equal((await call('POST', '/api/projects/demo/field', { key: 'next_step', value: 'x', expected: 'first' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('POST', '/api/projects/demo/field', undefined, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await call('GET', '/vault/demo/preview.png')).status, 200)
  assert.equal((await call('GET', '/vault/..%2Fsecret.png')).status, 404)
  assert.equal((await call('GET', '/vault/demo/demo.md')).status, 404)
  assert.equal((await call('GET', '/api/projects/..%2F..%2Fx')).status, 400)
})

test('the API shows only known card fields, no absolute repo path, and fs errors by code only', async t => {
  const { file, call } = await setup(t)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: active', 'status: active\nprivate_api_key: "sk-SECRET-1"'))
  const one = await call('GET', '/api/projects/demo')
  const all = await call('GET', '/api/projects')
  for (const r of [one, all]) {
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('SECRET'), 'unknown frontmatter never reaches the API')
    assert.ok(!r.text.includes(os.tmpdir().replace(/\\/g, '\\\\')), 'no local paths in the API')
  }
  assert.equal(one.json.fields.status, 'active')
  assert.equal(one.json.fields.next_step, 'first')
  assert.equal(publicError(Object.assign(new Error(`EACCES: permission denied, open 'C:\\Users\\me\\x.md'`), { code: 'EACCES' })), 'EACCES')
  assert.equal(publicError(new Error('stage must be one of development')), 'stage must be one of development')
})

test('links that lead out of the projects folder are not followed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-link-'))
  const projects = path.join(dir, 'projects')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(outside, 'leak'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  fs.writeFileSync(path.join(projects, 'demo', 'demo.md'), CARD)
  fs.writeFileSync(path.join(outside, 'leak', 'shot.png'), 'transcript-bytes')
  fs.writeFileSync(path.join(outside, 'leak', 'leak.md'), '---\nstage: fixes\nnext_step: "LEAKED-CARD"\n---\n')
  fs.symlinkSync(path.join(outside, 'leak'), path.join(projects, 'demo', 'pics'), 'junction')
  fs.symlinkSync(path.join(outside, 'leak'), path.join(projects, 'leak'), 'junction')
  const a = createApp({ projectsRoot: projects, reposRoot: path.join(dir, 'repos'), dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false })
  const port = await a.start()
  t.after(async () => {
    await a.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
    let s = ''
    res.on('data', c => (s += c))
    res.on('end', () => resolve({ status: res.statusCode, text: s }))
  }).on('error', reject))
  assert.equal((await get('/vault/demo/pics/shot.png')).status, 404)
  const list = await get('/api/projects')
  assert.ok(!list.text.includes('LEAKED-CARD'))
  assert.equal((await get('/api/projects/leak')).status, 400)
})

test('meta names the app and instance; shutdown works only when the server is given a handler; a busy port fails clearly', async t => {
  const { call, port } = await setup(t)
  const meta = await call('GET', '/api/meta')
  assert.equal(meta.json.app, 'projium')
  assert.match(meta.json.instance, /^[0-9a-f]{12}$/)
  assert.ok(!meta.text.includes(os.tmpdir().replace(/\\/g, '\\\\')), 'no local path in meta')
  assert.equal((await call('POST', '/api/shutdown', {})).status, 404)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-busy-'))
  fs.mkdirSync(path.join(dir, 'p'))
  let stopped = 0
  const b = createApp({ projectsRoot: path.join(dir, 'p'), reposRoot: dir, dbFile: path.join(dir, 'db', 't.db'), port, checkHealth: false })
  await assert.rejects(b.start(), e => e.code === 'EADDRINUSE' && /port \d+ is already in use/.test(e.message))
  b.db.close()
  const c = createApp({ projectsRoot: path.join(dir, 'p'), reposRoot: dir, dbFile: path.join(dir, 'db', 'c.db'), port: 0, checkHealth: false, onShutdown: () => stopped++ })
  const cport = await c.start()
  t.after(async () => {
    await c.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const shut = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: cport, method: 'POST', path: '/api/shutdown', headers: { host: `127.0.0.1:${cport}`, 'content-type': 'application/json', origin: 'https://evil.example' } }, res => (res.resume(), resolve(res.statusCode)))
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(shut, 403, 'a web page cannot stop it')
  const ok = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: cport, method: 'POST', path: '/api/shutdown', headers: { host: `127.0.0.1:${cport}`, 'content-type': 'application/json' } }, res => (res.resume(), resolve(res.statusCode)))
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(ok, 200)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(stopped, 1)
})

test('a manual digest send without a channel is refused', async t => {
  const { call } = await setup(t)
  const r = await call('POST', '/api/digest/send', {})
  assert.equal(r.status, 409)
  assert.equal((await call('GET', '/api/digest')).json.enabled, false)
})
