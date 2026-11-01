import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { settingsView, applySettings, settingsHash, envFileOf } from '../lib/settings.mjs'
import { saveConfig } from '../lib/init.mjs'
import { loadConfig } from '../lib/config.mjs'
import { Conflict } from '../lib/store.mjs'
import { createApp } from '../server.mjs'

const rm = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
const temp = (t, manual = false) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-set-'))
  if (!manual) t.after(() => rm(dir))
  return dir
}

const TOKEN = '123456789:AAHfakeTokenForTests_abcdefghijklmno'

const fixture = (t, extra = {}, manual = false) => {
  const here = temp(t, manual)
  const conf = path.join(here, 'conf')
  for (const d of ['notes', 'notes2', 'repos']) fs.mkdirSync(path.join(here, d))
  fs.mkdirSync(conf)
  const file = path.join(conf, 'tracker.config.json')
  const config = {
    projectsDir: '../notes',
    reposDir: '../repos',
    ignore: ['old'],
    cards: { layout: 'flat' },
    digest: { at: '09:00', lang: 'en', env: ['X_TOKEN'] },
    watch: {
      every: 10,
      targets: [
        { name: 'shop', kind: 'site', url: 'https://shop.example', certDays: 7 },
        { name: 'gas', kind: 'balance', chain: 'evm', address: `0x${'a'.repeat(40)}`, min: 0.1, rpc: 'https://rpc.example/secret-key', failAfter: 3 },
      ],
    },
    ...extra,
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return { here, file, config }
}

test('the settings view shows what the file says, where folders resolve, and hides RPC URLs and tokens', t => {
  const { here, file } = fixture(t)
  fs.writeFileSync(envFileOf(file), `PORT=4000\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\n`)
  const v = settingsView(here, file, settingsHash(file))
  assert.equal(v.values.projectsDir, '../notes')
  assert.equal(v.effective.projectsDir.path, path.join(here, 'notes'))
  assert.equal(v.effective.projectsDir.state, 'ok')
  assert.equal(v.effective.layout, 'flat')
  assert.equal(v.effective.channel, 'telegram')
  assert.deepEqual(v.telegram, { set: true, here: true })
  assert.equal(v.portFromEnv, true)
  assert.equal(v.restart, false)
  const gas = v.watch.find(x => x.name === 'gas')
  assert.equal(gas.rpcSet, true)
  assert.equal('rpc' in gas, false)
  assert.ok(!JSON.stringify(v).includes('secret-key'))
  assert.ok(!JSON.stringify(v).includes(TOKEN))
})

test('a settings save changes only the given keys, keeps the rest, and backs up the old file', t => {
  const { here, file, config } = fixture(t)
  const r = applySettings(here, file, { hash: settingsHash(file), set: { projectsDir: '"../notes2"', utcOffset: '-05:00', digestLang: 'ru', port: '3333' } })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.projectsDir, '../notes2')
  assert.equal(saved.utcOffset, '-05:00')
  assert.equal(saved.port, 3333)
  assert.deepEqual(saved.digest, { at: '09:00', lang: 'ru', env: ['X_TOKEN'] })
  assert.deepEqual(saved.ignore, ['old'])
  assert.deepEqual(saved.cards, { layout: 'flat' })
  assert.deepEqual(saved.watch, config.watch)
  assert.ok(r.backup && fs.existsSync(r.backup))
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), config)
  assert.equal(settingsView(here, file, 'old-hash').restart, true)
})

test('a settings save that does not validate writes nothing', t => {
  const { here, file } = fixture(t)
  const before = fs.readFileSync(file, 'utf8')
  const hash = settingsHash(file)
  for (const set of [{ projectsDir: '../missing' }, { projectsDir: '' }, { reposDir: 'nope' }, { utcOffset: 'MSK' }, { port: '70000' }, { digestAt: '25:00' }, { digestLang: 'de' }, { digestCommand: ['node', 3] }, { projectsDir: 'a\nb' }])
    assert.throws(() => applySettings(here, file, { hash, set }), Error, JSON.stringify(set))
  assert.throws(() => applySettings(here, file, { hash, watch: [{ op: 'add', target: { name: 'local', kind: 'site', url: 'ftp://x' } }] }), /http/)
  assert.throws(() => applySettings(here, file, { hash, watch: [{ op: 'add', target: { name: 'shop', kind: 'site', url: 'https://other.example' } }] }), /two targets/)
  assert.throws(() => applySettings(here, file, { hash, telegram: { token: 'abc', chatId: '1' } }), /bot token/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tracker.config.json'])
})

test('a settings save is refused when the file changed since it was read', t => {
  const { here, file } = fixture(t)
  const hash = settingsHash(file)
  fs.appendFileSync(file, ' ')
  assert.throws(() => applySettings(here, file, { hash, set: { digestLang: 'ru' } }), e => e instanceof Conflict)
  assert.throws(() => applySettings(here, file, { set: { digestLang: 'ru' } }), e => e instanceof Conflict)
})

test('watch targets are added, edited in place keeping fields the form does not show, and removed', t => {
  const { here, file } = fixture(t)
  applySettings(here, file, { hash: settingsHash(file), watch: [{ op: 'add', target: { name: 'beat', kind: 'heartbeat', url: 'https://api.example/health', field: 'lastRunAt', maxAgeMin: '15', project: '' } }] })
  let w = JSON.parse(fs.readFileSync(file, 'utf8')).watch
  assert.deepEqual(w.targets[2], { name: 'beat', kind: 'heartbeat', url: 'https://api.example/health', field: 'lastRunAt', maxAgeMin: 15 })
  applySettings(here, file, { hash: settingsHash(file), watch: [{ op: 'update', name: 'gas', target: { name: 'gas', kind: 'balance', chain: 'evm', address: `0x${'b'.repeat(40)}`, min: '0.2', rpc: '' } }] })
  w = JSON.parse(fs.readFileSync(file, 'utf8')).watch
  assert.deepEqual(w.targets[1], { failAfter: 3, rpc: 'https://rpc.example/secret-key', name: 'gas', kind: 'balance', chain: 'evm', address: `0x${'b'.repeat(40)}`, min: 0.2 })
  applySettings(here, file, { hash: settingsHash(file), watch: [{ op: 'update', name: 'shop', target: { name: 'shop', kind: 'heartbeat', url: 'https://shop.example/api', field: 'at', maxAgeMin: 5 } }] })
  w = JSON.parse(fs.readFileSync(file, 'utf8')).watch
  assert.deepEqual(w.targets[0], { name: 'shop', kind: 'heartbeat', url: 'https://shop.example/api', field: 'at', maxAgeMin: 5 })
  applySettings(here, file, { hash: settingsHash(file), watch: [{ op: 'remove', name: 'shop' }, { op: 'remove', name: 'gas' }, { op: 'remove', name: 'beat' }] })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).watch, { every: 10 })
  assert.throws(() => applySettings(here, file, { hash: settingsHash(file), watch: [{ op: 'remove', name: 'nope' }] }), /no watch target/)
})

test('Telegram credentials go only into .env.local next to the config, keeping its other lines', t => {
  const { here, file } = fixture(t)
  const env = envFileOf(file)
  fs.writeFileSync(env, 'PORT=4000\r\nTELEGRAM_CHAT_ID=1\r\n')
  const before = fs.readFileSync(file, 'utf8')
  applySettings(here, file, { hash: settingsHash(file), telegram: { token: TOKEN, chatId: '-1001234567890' } })
  assert.equal(fs.readFileSync(env, 'utf8'), `PORT=4000\r\nTELEGRAM_CHAT_ID=-1001234567890\r\nTELEGRAM_BOT_TOKEN=${TOKEN}\r\n`)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(loadConfig(here, file).digest.telegram, { token: TOKEN, chatId: '-1001234567890' })
  applySettings(here, file, { hash: settingsHash(file), telegram: null })
  assert.equal(fs.readFileSync(env, 'utf8'), 'PORT=4000\r\n')
  assert.equal(loadConfig(here, file).digest.telegram, null)
})

test('a config in another folder reads .env.local next to it', t => {
  const { here, file } = fixture(t)
  fs.writeFileSync(path.join(here, '.env.local'), 'TELEGRAM_CHAT_ID=1\n')
  fs.writeFileSync(envFileOf(file), `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=2\n`)
  assert.deepEqual(loadConfig(here, file).digest.telegram, { token: TOKEN, chatId: '2' })
})

test('settings create the first config when there is none, but only with a projects folder', t => {
  const here = temp(t)
  fs.mkdirSync(path.join(here, 'notes'))
  const file = path.join(here, 'tracker.config.json')
  assert.throws(() => applySettings(here, file, { hash: settingsHash(file), set: { digestLang: 'ru' } }), /projects folder/)
  assert.equal(fs.existsSync(file), false)
  applySettings(here, file, { hash: settingsHash(file), set: { projectsDir: 'notes' } })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { $schema: './tracker.config.schema.json', projectsDir: 'notes' })
})

test('saves keep the 10 newest timestamped backups and never touch other backups', t => {
  const here = temp(t)
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, '{}\n')
  fs.writeFileSync(`${file}.bak-0.8.0`, 'manual')
  for (let i = 0; i < 12; i++) fs.writeFileSync(`${file}.bak-20260101T0000${String(i).padStart(2, '0')}`, String(i))
  saveConfig(here, file, { port: 3999 })
  const left = fs.readdirSync(here).filter(n => n.includes('.bak-')).sort()
  assert.equal(left.length, 11)
  assert.ok(left.includes('tracker.config.json.bak-0.8.0'))
  assert.ok(!left.includes('tracker.config.json.bak-20260101T000000'))
  assert.ok(!left.includes('tracker.config.json.bak-20260101T000002'))
  assert.ok(left.includes('tracker.config.json.bak-20260101T000011'))
})

test('the settings API reads, writes with the hash, and flags a restart', async t => {
  const { here, file } = fixture(t, {}, true)
  const app = createApp({ projectsRoot: path.join(here, 'notes'), reposRoot: path.join(here, 'repos'), dbFile: path.join(here, 'db', 't.db'), port: 0, checkHealth: false, configFile: file })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    rm(here)
  })
  const call = (method, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, method, path: '/api/settings', headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }))
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  const first = await call('GET')
  assert.equal(first.status, 200)
  assert.equal(first.json.restart, false)
  assert.equal((await call('POST', { hash: 'stale', set: { digestLang: 'ru' } })).status, 409)
  const saved = await call('POST', { hash: first.json.hash, set: { digestLang: 'ru' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.restart, true)
  assert.equal(saved.json.values.digestLang, 'ru')
  assert.ok(saved.json.backup)
  assert.equal((await call('POST', { hash: saved.json.hash, set: { projectsDir: '../missing' } })).status, 400)
})

test('the settings API is off when the server has no config file path', async t => {
  const here = temp(t, true)
  fs.mkdirSync(path.join(here, 'notes'))
  const app = createApp({ projectsRoot: path.join(here, 'notes'), reposRoot: here, dbFile: path.join(here, 'db', 't.db'), port: 0, checkHealth: false })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    rm(here)
  })
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`)
  assert.equal(res.status, 404)
})
