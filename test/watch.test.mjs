import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openDb } from '../lib/health.mjs'
import { watchConfig, watchUnknownKeys, step, createWatch, SOLANA_RPC } from '../lib/watch.mjs'
import { request, certExpiry } from '../lib/net.mjs'
import { alertText, detailText, durationText } from '../public/watch-text.js'

const MIN = 60e3
const TREASURY = '11111111111111111111111111111111'
const EVM = '0x00000000219ab540356cBB839Cbe05303d7705Fa'

const tempDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-watch-'))
  const db = openDb(path.join(dir, 'w.db'))
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return db
}

const netError = code => Object.assign(new Error(code), { code })

const rig = (t, raw, { env = {}, routes = {}, notify = true, lang = 'ru' } = {}) => {
  const db = tempDb(t)
  let now = Date.parse('2026-11-01T12:00:00Z')
  const sent = []
  const calls = []
  const get = async (url, opts = {}) => {
    calls.push({ url, ...opts })
    const r = routes[url]
    if (!r) throw netError('ENOTFOUND')
    const v = typeof r === 'function' ? r(opts, now) : r
    if (v instanceof Error) throw v
    return { headers: {}, ...v }
  }
  const make = cfg => createWatch({ db, config: watchConfig(cfg, env), notify: notify ? async text => void sent.push(text) : null, clock: () => now, get, lang, link: e => `http://127.0.0.1:3210/#/${e.project ? `p/${e.project}` : 'watch'}`, log: () => {} })
  const w = make(raw)
  return { db, w, sent, calls, make, routes, at: () => now, advance: ms => (now += ms) }
}

const site = (name, url, extra = {}) => ({ name, kind: 'site', url, certDays: 0, ...extra })

test('the state machine opens after failAfter failures in a row, ignores skips and closes after recoverAfter good checks', () => {
  const opts = { failAfter: 2, recoverAfter: 3 }
  let s = step(null, 'fail', opts)
  assert.deepEqual(s, { status: 'ok', fails: 1, oks: 0, event: null })
  s = step(s, 'ok', opts)
  assert.equal(s.fails, 0, 'a good check breaks the run of failures')
  s = step(step(s, 'fail', opts), 'skip', opts)
  assert.equal(s.fails, 1, 'a skip neither counts nor resets')
  s = step(s, 'fail', opts)
  assert.equal(s.event, 'open')
  assert.equal(s.status, 'open')
  s = step(s, 'fail', opts)
  assert.equal(s.event, null, 'no second open while it stays open')
  s = step(step(s, 'ok', opts), 'ok', opts)
  assert.equal(s.status, 'open')
  s = step(s, 'fail', opts)
  assert.equal(s.oks, 0, 'a failure resets the recovery count')
  s = step(step(step(s, 'ok', opts), 'ok', opts), 'ok', opts)
  assert.equal(s.event, 'close')
  assert.equal(s.status, 'ok')
  assert.equal(step(null, 'fail', { failAfter: 1, recoverAfter: 1 }).event, 'open')
})

test('the watch config fills defaults, resolves the RPC from an env name without exposing it, and names what is wrong', () => {
  const c = watchConfig({
    rpc: { solanaEnv: 'SOLANA_RPC_URL' },
    targets: [
      { name: 'shop', kind: 'site', url: 'https://shop.example', project: 'Shop' },
      { name: 'plain', kind: 'site', url: 'http://plain.example' },
      { name: 'treasury', kind: 'balance', address: TREASURY, min: 0.05 },
      { name: 'gas', kind: 'balance', chain: 'evm', address: EVM, min: 0.01, rpcEnv: 'EVM_RPC', unit: 'BNB' },
    ],
  }, { SOLANA_RPC_URL: 'https://rpc.example/?api-key=SECRET-KEY', EVM_RPC: 'https://bsc.example/SECRET-2' })
  assert.equal(c.every, 5)
  assert.equal(c.failAfter, 2)
  assert.equal(c.recoverAfter, 2)
  assert.deepEqual(c.env.sort(), ['EVM_RPC', 'SOLANA_RPC_URL'])
  const [shop, plain, treasury, gas] = c.targets
  assert.equal(shop.certDays, 14)
  assert.equal(shop.project, 'Shop')
  assert.equal(plain.certDays, 0, 'no certificate check without https')
  assert.equal(treasury.rpcFrom, 'env')
  assert.equal(treasury.unit, 'SOL')
  assert.equal(gas.unit, 'BNB')
  assert.equal(gas.rpcFrom, 'env')
  assert.ok(!JSON.stringify(c).includes('SECRET'), 'the RPC URL from the environment is never serialized')
  assert.ok(!Object.keys(treasury).includes('rpcUrl'))

  const pub = watchConfig({ rpc: { solanaEnv: 'SOLANA_RPC_URL' }, targets: [{ name: 't', kind: 'balance', address: TREASURY, min: 1 }] }, {})
  assert.equal(pub.targets[0].rpcFrom, 'public')
  assert.equal(pub.targets[0].rpcUrl, SOLANA_RPC)
  assert.equal(pub.targets[0].rpcMissing, 'SOLANA_RPC_URL')
  const noEvm = watchConfig({ targets: [{ name: 'g', kind: 'balance', chain: 'evm', address: EVM, min: 1, rpcEnv: 'EVM_RPC' }] }, {})
  assert.equal(noEvm.targets[0].rpcFrom, 'missing')
  assert.equal(noEvm.targets[0].rpcUrl, null)

  assert.equal(watchConfig(null), null)
  const bad = [
    [{ every: 0 }, /watch.every/],
    [{ targets: [{ kind: 'site', url: 'https://a.example' }] }, /name/],
    [{ targets: [{ name: 'a', kind: 'ping', url: 'https://a.example' }] }, /kind must be one of site, heartbeat, balance/],
    [{ targets: [{ name: 'a', kind: 'site', url: 'ftp://a.example' }] }, /url must be an http/],
    [{ targets: [{ name: 'a', kind: 'site', url: 'https://a.example' }, { name: 'A', kind: 'site', url: 'https://b.example' }] }, /two targets are named/],
    [{ targets: [{ name: 'a', kind: 'balance', address: 'nope', min: 1 }] }, /public Solana address/],
    [{ targets: [{ name: 'a', kind: 'balance', address: TREASURY }] }, /min must be/],
    [{ targets: [{ name: 'a', kind: 'balance', chain: 'evm', address: EVM, min: 1 }] }, /needs rpc/],
    [{ targets: [{ name: 'a', kind: 'heartbeat', url: 'https://a.example/h' }] }, /set field/],
    [{ targets: [{ name: 'a', kind: 'heartbeat', url: 'https://a.example/h', field: 'lastCycleAt' }] }, /maxAgeMin/],
    [{ targets: [{ name: 'a', kind: 'heartbeat', url: 'https://a.example/h', max: { stuckOps: '0' } }] }, /max must map/],
    [{ failAfter: 0 }, /failAfter/],
    [{ rpc: { solanaEnv: 'bad name' } }, /environment variable name/],
  ]
  for (const [raw, re] of bad) assert.throws(() => watchConfig(raw, {}), re, JSON.stringify(raw))
  assert.deepEqual(watchUnknownKeys({ evry: 5, rpc: { url: 'x' }, targets: [{ name: 'a', kind: 'balance', minSol: 1, min: 1 }] }), ['watch.evry', 'watch.rpc.url', 'watch.targets[0].minSol'])
})

test('a site that goes down sends one message when the incident opens, none while it stays open, and one on recovery', async t => {
  const r = rig(t, { failAfter: 2, recoverAfter: 2, targets: [site('shop', 'https://shop.example', { project: 'Shop' })] })
  r.routes['https://shop.example'] = { status: 200 }
  await r.w.tick()
  r.routes['https://shop.example'] = { status: 502 }
  r.advance(5 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 0, 'one failure is not an incident yet')
  r.advance(5 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1)
  assert.match(r.sent[0], /^Сбой: shop · сайт\nHTTP 502\nhttp:\/\/127\.0\.0\.1:3210\/#\/p\/Shop$/)
  for (let i = 0; i < 4; i++) {
    r.advance(5 * MIN)
    await r.w.tick()
  }
  assert.equal(r.sent.length, 1, 'no repeats while the incident is open')
  r.routes['https://shop.example'] = { status: 200 }
  r.advance(5 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1, 'one good check does not close it')
  r.advance(5 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 2)
  assert.match(r.sent[1], /^Восстановлено: shop · сайт\nHTTP 200, длилось 30 мин\n/)
  const st = r.w.status()
  assert.equal(st.incidents.length, 1)
  assert.equal(st.incidents[0].closedAt - st.incidents[0].openedAt, 30 * MIN)
  assert.deepEqual([st.incidents[0].openSent, st.incidents[0].closeSent], [true, true])
  assert.equal(st.targets[0].signals[0].status, 'ok')
})

test('a muted target is still checked, its messages wait for the end of the mute, and one that recovered meanwhile sends nothing', async t => {
  const r = rig(t, { failAfter: 1, recoverAfter: 1, targets: [site('a', 'https://a.example'), site('b', 'https://b.example')] })
  r.routes['https://b.example'] = { status: 200 }
  r.w.mute('a', r.at() + 60 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 0)
  let inc = r.w.status().incidents[0]
  assert.equal(inc.muted, true)
  assert.equal(inc.closedAt, null)
  r.advance(61 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1, 'still down after the mute: the open message goes out now')
  assert.match(r.sent[0], /^Сбой: a · сайт\nнет ответа \(ENOTFOUND\)\nhttp:\/\/127\.0\.0\.1:3210\/#\/watch$/)

  r.w.mute('b', r.at() + 30 * MIN)
  r.routes['https://b.example'] = { status: 500 }
  r.advance(MIN)
  await r.w.tick()
  r.routes['https://b.example'] = { status: 200 }
  r.advance(MIN)
  await r.w.tick()
  r.advance(40 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1, 'b failed and recovered inside its mute: nothing was sent')
  inc = r.w.status().incidents.find(i => i.target === 'b')
  assert.ok(inc.closedAt)
  assert.equal(inc.openSent, false)

  r.w.mute('a', r.at() + 30 * MIN)
  assert.ok(r.w.status().targets[0].mutedUntil)
  r.w.mute('a', null)
  assert.equal(r.w.status().targets[0].mutedUntil, null)
  assert.throws(() => r.w.mute('nope', r.at() + MIN), /no watch target/)
  assert.throws(() => r.w.mute('a', r.at() - MIN), /next 30 days/)
  assert.throws(() => r.w.mute('a', r.at() + 31 * 864e5), /next 30 days/)
})

test('a heartbeat goes stale past maxAgeMin only while activeWhen matches, measured by the answer Date, and a limit fails at any time', async t => {
  const url = 'https://app.example/api/health'
  let body = {}
  let date = null
  const r = rig(t, {
    failAfter: 1,
    recoverAfter: 1,
    targets: [{ name: 'keeper', kind: 'heartbeat', url, project: 'app', field: 'lastCycleAt', maxAgeMin: 20, activeWhen: { payoutsLive: true }, max: { stuckOps: 0 } }],
  })
  r.routes[url] = (opts, now) => ({ status: 200, body: JSON.stringify(typeof body === 'function' ? body(now) : body), headers: date ? { date } : {} })
  body = now => ({ payoutsLive: true, lastCycleAt: now - 5 * MIN, stuckOps: 0 })
  await r.w.tick()
  assert.equal(r.w.status().targets[0].signals[0].result, 'ok')
  assert.equal(r.calls[0].maxBytes, 512e3)

  body = now => ({ payoutsLive: true, lastCycleAt: now - 25 * MIN, stuckOps: 0 })
  r.advance(MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1)
  assert.match(r.sent[0], /^Сбой: keeper · пульс\nпоследний пульс 25 мин назад \(порог 20\)\n/)

  body = now => ({ payoutsLive: false, lastCycleAt: now - 90 * MIN, stuckOps: 0 })
  r.advance(MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 2, 'payouts off: an old beat is fine, the incident recovers')
  assert.match(r.sent[1], /payoutsLive = false, возраст не проверяется/)

  body = { payoutsLive: false, lastCycleAt: null, stuckOps: 2 }
  r.advance(MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 3)
  assert.match(r.sent[2], /stuckOps = 2 \(максимум 0\)/)

  const at = r.at()
  body = { payoutsLive: true, lastCycleAt: Math.floor((at - 30 * MIN) / 1000), stuckOps: 0 }
  date = new Date(at - 25 * MIN).toUTCString()
  r.advance(MIN)
  await r.w.tick()
  const sig = r.w.status().targets[0].signals[0]
  assert.equal(sig.status, 'ok', 'seconds are read as a time, and the age is measured against the server Date')
  assert.deepEqual(sig.detail, [{ k: 'beat', age: 5, max: 20 }])

  date = null
  for (const [b, re] of [[{ payoutsLive: true, stuckOps: 0 }, /нет времени в lastCycleAt/], ['not json', /ответ не JSON/]]) {
    r.routes[url] = { status: 200, body: typeof b === 'string' ? b : JSON.stringify(b) }
    r.advance(MIN)
    await r.w.tick()
    assert.match(detailText(r.w.status().targets[0].signals[0].detail, 'ru'), re)
  }
  r.routes[url] = { status: 503, body: null }
  r.advance(MIN)
  await r.w.tick()
  assert.deepEqual(r.w.status().targets[0].signals[0].detail, [{ k: 'http', status: 503 }])
})

test('a wallet below min opens a low balance incident; an RPC error changes nothing; EVM balances are read from hex', async t => {
  let lamports = 346963169
  const r = rig(t, {
    failAfter: 1,
    recoverAfter: 1,
    targets: [
      { name: 'treasury', kind: 'balance', address: TREASURY, min: 0.05, project: 'stocksium' },
      { name: 'gas', kind: 'balance', chain: 'evm', address: EVM, min: 0.5, rpc: 'https://evm.example/' },
    ],
  }, { lang: 'en' })
  r.routes[SOLANA_RPC] = opts => {
    const q = JSON.parse(opts.body)
    assert.equal(opts.method, 'POST')
    assert.deepEqual([q.method, q.params[0]], ['getBalance', TREASURY])
    return lamports instanceof Error ? lamports : { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: lamports } }) }
  }
  r.routes['https://evm.example/'] = opts => {
    assert.equal(JSON.parse(opts.body).method, 'eth_getBalance')
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x6f05b59d3b20000' }) }
  }
  await r.w.tick()
  let st = r.w.status()
  assert.deepEqual(st.targets.map(x => x.signals[0].result), ['ok', 'ok'])
  assert.equal(detailText(st.targets[0].signals[0].detail, 'en'), '0.347 SOL (alert below 0.05)')
  assert.equal(detailText(st.targets[1].signals[0].detail, 'en'), '0.5 ETH (alert below 0.5)')

  lamports = 12e6
  r.advance(5 * MIN)
  await r.w.tick()
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0], 'Down: treasury · balance\n0.012 SOL (alert below 0.05)\nhttp://127.0.0.1:3210/#/p/stocksium')

  lamports = netError('ECONNRESET')
  r.advance(5 * MIN)
  await r.w.tick()
  st = r.w.status()
  assert.equal(st.targets[0].signals[0].status, 'open', 'an RPC error is unknown, not a recovery')
  assert.equal(st.targets[0].signals[0].result, 'skip')
  r.routes[SOLANA_RPC] = { status: 429, body: null }
  r.advance(5 * MIN)
  await r.w.tick()
  assert.deepEqual(r.w.status().targets[0].signals[0].detail, [{ k: 'rpc', code: 'HTTP 429' }])
  r.routes[SOLANA_RPC] = { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid key SECRET' } }) }
  r.advance(5 * MIN)
  await r.w.tick()
  assert.deepEqual(r.w.status().targets[0].signals[0].detail, [{ k: 'rpc', code: '-32602' }])
  assert.ok(!JSON.stringify(r.w.status()).includes('SECRET'), 'an RPC error message is never kept')
  assert.equal(r.sent.length, 1)
})

test('a certificate that expires within certDays opens its own incident while the site stays up', async t => {
  const r = rig(t, { failAfter: 1, recoverAfter: 1, targets: [{ name: 'shop', kind: 'site', url: 'https://shop.example', certDays: 14 }, site('other', 'https://other.example')] })
  r.routes['https://other.example'] = { status: 200 }
  r.routes['https://shop.example'] = (opts, now) => ({ status: 200, certExpires: now + 10 * 864e5 + 3600e3 })
  await r.w.tick()
  assert.equal(r.calls.find(c => c.url === 'https://shop.example').peer, true)
  const st = r.w.status()
  assert.deepEqual(st.targets[0].signals.map(s => [s.signal, s.status]), [['up', 'ok'], ['cert', 'open']])
  assert.match(r.sent[0], /^Сбой: shop · сертификат\nсертификат истекает 2026-11-11, через 10 д\n/)
  r.routes['https://shop.example'] = { status: 200, certExpires: null }
  r.advance(MIN)
  await r.w.tick()
  assert.equal(r.w.status().targets[0].signals[1].status, 'open', 'a certificate that could not be read is unknown')
})

test('a round where no target answers is treated as the network being down and counts nothing', async t => {
  const r = rig(t, { failAfter: 1, recoverAfter: 1, targets: [site('a', 'https://a.example'), site('b', 'https://b.example'), { name: 'w', kind: 'balance', address: TREASURY, min: 1 }] })
  const out = await r.w.tick()
  assert.equal(out.offline, true)
  assert.equal(r.sent.length, 0)
  assert.equal(r.w.status().incidents.length, 0)
  assert.equal(r.w.status().lastTick.offline, true)
  r.routes['https://b.example'] = { status: 200 }
  r.advance(MIN)
  assert.equal((await r.w.tick()).offline, false)
  assert.equal(r.sent.length, 1, 'with one site answering, the other one is down for real')

  const single = rig(t, { failAfter: 1, recoverAfter: 1, targets: [site('only', 'https://only.example')] })
  await single.w.tick()
  assert.equal(single.sent.length, 1, 'a single host cannot tell a network outage from its own')
})

test('a failed send is retried on the next round and goes out once; incidents that start together share one message', async t => {
  const db = tempDb(t)
  let now = Date.parse('2026-11-01T12:00:00Z')
  const texts = []
  let fail = true
  const w = createWatch({
    db,
    config: watchConfig({ failAfter: 1, recoverAfter: 1, targets: [site('a', 'https://a.example'), site('b', 'https://b.example'), site('c', 'https://c.example')] }),
    notify: async text => {
      if (fail) throw new Error('telegram: HTTP 502')
      texts.push(text)
    },
    clock: () => now,
    get: async url => (url === 'https://c.example' ? { status: 200, headers: {} } : { status: 500, headers: {} }),
    lang: 'en',
    log: () => {},
  })
  assert.equal((await w.tick()).sent, 0)
  assert.equal(w.status().incidents.filter(i => i.openSent).length, 0)
  fail = false
  now += 5 * MIN
  assert.equal((await w.tick()).sent, 2)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /^Down: a · site\nHTTP 500\n\nDown: b · site\nHTTP 500$/)
  now += 5 * MIN
  await w.tick()
  assert.equal(texts.length, 1)
})

test('a target dropped from the config closes its open incident without a message', async t => {
  const r = rig(t, { failAfter: 1, recoverAfter: 1, targets: [site('a', 'https://a.example'), site('b', 'https://b.example')] })
  r.routes['https://b.example'] = { status: 200 }
  await r.w.tick()
  assert.equal(r.sent.length, 1)
  const w2 = r.make({ failAfter: 1, recoverAfter: 1, targets: [site('b', 'https://b.example')] })
  r.advance(MIN)
  await w2.tick()
  assert.equal(r.sent.length, 1)
  const inc = w2.status().incidents[0]
  assert.equal(inc.end, 'removed')
  assert.ok(inc.closedAt)
  assert.equal(r.db.prepare("select count(*) n from watch_state where target = 'a'").get().n, 0)
})

test('only one round runs at a time, and the alert text is cut on a line under 4000 characters', async t => {
  let release
  let calls = 0
  const db = tempDb(t)
  const w = createWatch({ db, config: watchConfig({ targets: [site('a', 'https://a.example')] }), get: () => (calls++, new Promise(r => (release = () => r({ status: 200, headers: {} })))), log: () => {} })
  const one = w.tick()
  const two = w.tick()
  assert.equal(one, two)
  await new Promise(r => setImmediate(r))
  release()
  await one
  assert.equal(calls, 1)

  const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'open', target: `target-${i}`, signal: 'up', detail: [{ k: 'http', status: 500 }] }))
  const text = alertText(many, { lang: 'en', link: () => 'http://127.0.0.1:3210/#/watch' })
  assert.ok(text.length <= 4000)
  assert.ok(text.endsWith('\n…'))
  assert.equal(durationText(90 * MIN, 'en'), '1 h 30 min')
  assert.equal(durationText(50 * 3600e3, 'ru'), '2 д 2 ч')
})

test('request sends a POST body with its length and returns headers; the certificate end date is read from the socket', async t => {
  let got = null
  const server = http.createServer((req, res) => {
    let s = ''
    req.on('data', c => (s += c))
    req.on('end', () => {
      got = { method: req.method, length: req.headers['content-length'], body: s }
      res.writeHead(200, { 'content-type': 'application/json', date: 'Sun, 01 Nov 2026 12:00:00 GMT' })
      res.end('{"ok":true}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const local = (_host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : (typeof opts === 'function' ? opts : cb)(null, '127.0.0.1', 4))
  const r = await request(`http://rpc.test:${server.address().port}/`, { method: 'POST', body: '{"a":"ü"}', maxBytes: 1000, lookup: local, headers: { 'content-type': 'application/json' } })
  assert.deepEqual(got, { method: 'POST', length: '10', body: '{"a":"ü"}' })
  assert.equal(r.body, '{"ok":true}')
  assert.equal(r.headers.date, 'Sun, 01 Nov 2026 12:00:00 GMT')
  assert.equal(certExpiry({ getPeerCertificate: () => ({ valid_to: 'Jan 10 12:00:00 2027 GMT' }) }), Date.parse('2027-01-10T12:00:00Z'))
  assert.equal(certExpiry({ getPeerCertificate: () => ({}) }), null)
  assert.equal(certExpiry(null), null)
  await assert.rejects(request('http://127.0.0.1:9/'), /private address/)
})
