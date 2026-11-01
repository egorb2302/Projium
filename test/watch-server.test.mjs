import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createApp } from '../server.mjs'
import { watchConfig } from '../lib/watch.mjs'
import { loadConfig } from '../lib/config.mjs'
import { diagnose } from '../lib/doctor.mjs'
import { commandSender } from '../lib/digest.mjs'
import { serverEnv } from '../lib/control.mjs'

const TREASURY = '11111111111111111111111111111111'

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-watchsrv-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const serve = async (t, opts) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-watchsrv-'))
  const projects = path.join(dir, 'projects')
  put(path.join(projects, 'shop', 'shop.md'), '---\nstage: done\nstatus: live shop\n---\n\n# shop\n')
  put(path.join(projects, 'blog', 'blog.md'), '---\nstage: development\n---\n\n# blog\n')
  fs.mkdirSync(path.join(dir, 'repos'))
  const app = createApp({ projectsRoot: projects, reposRoot: path.join(dir, 'repos'), dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, ...opts })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || 'null'), text: s }))
      })
      req.on('error', reject)
      req.end(data)
    })
  return { app, port, call }
}

test('watch targets are checked whatever the stage, show on the project, alert with a link and keep the RPC URL out of the API', async t => {
  const sent = []
  const config = watchConfig({
    failAfter: 1,
    recoverAfter: 1,
    rpc: { solanaEnv: 'TEST_SOLANA_RPC' },
    targets: [
      { name: 'shop-site', kind: 'site', url: 'https://shop.example', project: 'shop', certDays: 0 },
      { name: 'shop-treasury', kind: 'balance', address: TREASURY, min: 0.05, project: 'shop' },
      { name: 'orphan', kind: 'site', url: 'https://orphan.example', project: 'gone', certDays: 0 },
    ],
  }, { TEST_SOLANA_RPC: 'https://rpc.example/?api-key=TOP-SECRET' })
  const watchGet = async url => {
    if (url === 'https://shop.example') return { status: 503, headers: {} }
    if (url === 'https://orphan.example') return { status: 200, headers: {} }
    if (url.startsWith('https://rpc.example/')) return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 5e6 } }) }
    throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
  }
  const { call, port } = await serve(t, { watch: config, watchGet, sendAlert: async text => void sent.push(text), watchLang: 'ru' })

  let r = await call('GET', '/api/watch')
  assert.equal(r.status, 200)
  assert.equal(r.json.enabled, true)
  assert.equal(r.json.every, 5)
  assert.equal(r.json.notify, true)
  assert.deepEqual(r.json.targets.map(x => [x.name, x.signals[0].result]), [['shop-site', null], ['shop-treasury', null], ['orphan', null]])
  assert.equal(r.json.targets[1].rpc, 'env')

  r = await call('POST', '/api/watch/check', {})
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.targets.map(x => x.signals[0].status), ['open', 'open', 'ok'])
  assert.ok(!r.text.includes('TOP-SECRET'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0], `Сбой: shop-site · сайт\nHTTP 503\nhttp://127.0.0.1:${port}/#/p/shop\n\nСбой: shop-treasury · баланс\n0.005 SOL (порог 0.05)\nhttp://127.0.0.1:${port}/#/p/shop`)
  assert.ok(!sent[0].includes('TOP-SECRET'))

  const list = await call('GET', '/api/projects')
  const shop = list.json.find(p => p.name === 'shop')
  assert.equal(shop.fields.stage, 'done')
  assert.deepEqual(shop.watch, { open: 2, targets: 2 }, 'a done project is still watched')
  assert.equal(list.json.find(p => p.name === 'blog').watch, null)
  const one = await call('GET', '/api/projects/shop')
  assert.deepEqual(one.json.watch.targets.map(x => x.name), ['shop-site', 'shop-treasury'])
  assert.ok(!one.text.includes('TOP-SECRET'))

  assert.equal((await call('POST', '/api/watch/mute', { target: 'nope', until: Date.now() + 60e3 })).status, 404)
  assert.equal((await call('POST', '/api/watch/mute', { target: 'shop-site', until: Date.now() - 60e3 })).status, 400)
  assert.equal((await call('POST', '/api/watch/mute', { target: 'shop-site', until: 'tomorrow' })).status, 400)
  const until = Date.now() + 3600e3
  r = await call('POST', '/api/watch/mute', { target: 'shop-site', until })
  assert.equal(r.status, 200)
  assert.equal(r.json.targets[0].mutedUntil, Math.round(until))
  r = await call('POST', '/api/watch/mute', { target: 'shop-site', until: null })
  assert.equal(r.json.targets[0].mutedUntil, null)
})

test('without watch targets the API says so and a check is refused', async t => {
  const { call } = await serve(t, {})
  const r = await call('GET', '/api/watch')
  assert.equal(r.json.enabled, false)
  assert.deepEqual(r.json.targets, [])
  assert.equal((await call('POST', '/api/watch/check', {})).status, 409)
  assert.equal((await call('GET', '/api/projects')).json.every(p => p.watch === null), true)
})

test('the config reads the watch block, reports its unknown keys, and the doctor names the alert channel and a missing RPC variable', async t => {
  const dir = temp(t)
  const projects = path.join(dir, 'projects')
  put(path.join(projects, 'shop', 'shop.md'), '---\nstage: done\n---\n')
  fs.mkdirSync(path.join(dir, 'repos'))
  const file = path.join(dir, 'tracker.config.json')
  put(file, JSON.stringify({
    projectsDir: 'projects',
    reposDir: 'repos',
    cards: { repos: { shop: 'none' } },
    digest: { command: ['node', 'send.mjs', '--text'] },
    watch: {
      every: 10,
      rpc: { solanaEnv: 'PROJIUM_TEST_NO_SUCH_RPC' },
      targets: [
        { name: 'shop', kind: 'site', url: 'https://shop.example', project: 'shop' },
        { name: 'wallet', kind: 'balance', address: TREASURY, min: 0.1, project: 'nowhere', minSol: 1 },
      ],
    },
  }))
  const c = loadConfig(dir, file)
  assert.equal(c.watch.every, 10)
  assert.deepEqual(c.watch.env, ['PROJIUM_TEST_NO_SUCH_RPC'])
  assert.deepEqual(c.unknownKeys, ['watch.targets[1].minSol'])
  const env = serverEnv({ PATH: 'p', PROJIUM_TEST_NO_SUCH_RPC: 'https://x', OTHER: 'y' }, {}, c.watch.env)
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'PROJIUM_TEST_NO_SUCH_RPC'], 'start:bg passes the RPC variable to the server')
  const d = await diagnose(dir, { file, probe: async () => ({ running: false }) })
  assert.deepEqual(d.config.watch, { targets: 2, every: 10, failAfter: 2, recoverAfter: 2, channel: 'digest command', rpc: [{ target: 'wallet', from: 'public' }] })
  const hints = d.hints.join('\n')
  assert.match(hints, /watch target "wallet": PROJIUM_TEST_NO_SUCH_RPC is not set, so the public Solana RPC is used/)
  assert.match(hints, /watch targets name project\(s\) with no card: nowhere/)
  assert.match(d.problems.join('\n'), /unknown keys are ignored: watch\.targets\[1\]\.minSol/)

  assert.doesNotMatch(hints, /local or private address/)

  put(file, JSON.stringify({ projectsDir: 'projects', reposDir: 'repos', watch: { targets: [
    { name: 'keeper', kind: 'heartbeat', url: 'http://127.0.0.1:8080/health', max: { stuckOps: 0 } },
    { name: 'dev', kind: 'site', url: 'http://app.localhost:5173' },
    { name: 'lan', kind: 'site', url: 'http://[::1]:3000' },
    { name: 'pub', kind: 'site', url: 'https://8.8.8.8' },
  ] } }))
  const local = await diagnose(dir, { file, probe: async () => ({ running: false }) })
  assert.match(local.hints.join('\n'), /watch target\(s\) "keeper", "dev", "lan" point at a local or private address, which watch checks refuse \(EPRIVATE\)/)

  put(file, JSON.stringify({ projectsDir: 'projects', watch: { targets: [{ name: 'x', kind: 'balance', address: TREASURY }] } }))
  assert.throws(() => loadConfig(dir, file), /watch target "x": min must be/)
})

test('an alert command gets the text as its last argument and its failure is named as the alert command', async t => {
  const dir = temp(t)
  const script = path.join(dir, 'send.mjs')
  const out = path.join(dir, 'out.txt')
  fs.writeFileSync(script, "import fs from 'node:fs'\nconst [, , file, , text] = process.argv\nif (text === 'boom') process.exit(4)\nfs.writeFileSync(file, text)\n")
  const send = commandSender(['node', script, out, '--text'], 'alert command')
  await send('Сбой: shop · сайт')
  assert.equal(fs.readFileSync(out, 'utf8'), 'Сбой: shop · сайт')
  await assert.rejects(send('boom'), /^Error: alert command: exit 4$/)
})
