import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import dns from 'node:dns'
import { execFileSync } from 'node:child_process'
import { fetchConfig, updateStatus } from '../lib/prod.mjs'
import { checkSite } from '../lib/health.mjs'
import { isPrivate } from '../lib/net.mjs'
import { releasePlan, updateBranches } from '../lib/repo.mjs'
import { buildDigest } from '../lib/digest.mjs'
import { createApp } from '../server.mjs'

const serve = async (t, routes) => {
  const server = http.createServer((req, res) => {
    const r = routes[req.url] ?? [404, '{}']
    if (typeof r === 'function') return r(res)
    res.writeHead(r[0], { 'content-type': 'application/json', ...(r[2] ?? {}) })
    res.end(r[1])
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })
  return `http://127.0.0.1:${server.address().port}`
}

const plain = o => JSON.parse(JSON.stringify(o))
const cfg = (top, features = {}) => ({ ok: true, ts: 7, top, features })

test('the site config keeps booleans from the top level and from features, and nothing else', async t => {
  const base = await serve(t, { '/api/config': [200, JSON.stringify({ samsungWalletPayouts: true, leaderboard: false, privyAppId: 'abc', features: { dynamicBaskets: false, proofOfReserves: true, label: 'x' } })] })
  const c = await fetchConfig(base, 5000, 42, dns.lookup)
  assert.deepEqual(plain(c), { ok: true, ts: 42, top: { samsungwalletpayouts: true, leaderboard: false }, features: { dynamicBaskets: false, proofOfReserves: true } })
  assert.ok(!JSON.stringify(c).includes('abc'))
})

test('a redirect, an error status, bad JSON, a non-object or a huge body read as unknown', async t => {
  const routed = await serve(t, {
    '/r/api/config': [302, '{}', { location: 'https://example.com/' }],
    '/e/api/config': [500, '{}'],
    '/j/api/config': [200, 'not json'],
    '/a/api/config': [200, '[true]'],
    '/b/api/config': [200, JSON.stringify({ pad: 'x'.repeat(600e3) })],
    '/s/api/config': res => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'x'.repeat(64e3)
      for (let i = 0; i < 12; i++) res.write(chunk)
      res.end()
    },
  })
  const get = p => fetchConfig(`${routed}${p}`, 15000, Date.now(), dns.lookup)
  assert.equal((await get('/r')).error, 'HTTP 302')
  assert.equal((await get('/e')).error, 'HTTP 500')
  assert.equal((await get('/j')).ok, false)
  assert.equal((await get('/a')).error, 'config is not an object')
  assert.equal((await get('/b')).error, 'config too large')
  assert.equal((await get('/s')).error, 'config too large', 'a streamed body is cut at the cap')
  assert.equal((await get('/missing')).error, 'HTTP 404')
})

test('site checks never reach a private or loopback address, by literal or by DNS', async t => {
  let hits = 0
  const base = await serve(t, { '/api/config': res => (hits++, res.end('{}')), '/': res => (hits++, res.end('ok')) })
  const port = new URL(base).port
  assert.equal((await fetchConfig(base)).error, 'EPRIVATE')
  assert.equal((await fetchConfig(`http://localhost:${port}`)).error, 'EPRIVATE')
  assert.equal((await fetchConfig(`http://[::1]:${port}`)).error, 'EPRIVATE')
  assert.equal((await checkSite(`http://localhost:${port}/`)).error, 'EPRIVATE')
  assert.equal(hits, 0)
  assert.equal((await checkSite(`${base}/`, 5000, dns.lookup)).code, 200)
  for (const a of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::7f00:1', 'fec0::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivate(a), true, a)
  for (const a of ['1.1.1.1', '93.184.216.34', '2606:4700::1111']) assert.equal(isPrivate(a), false, a)
})

test('an uptime check does not read the body of a huge page', async t => {
  let wrote = 0
  const base = await serve(t, {
    '/': res => {
      res.writeHead(200)
      const pump = () => {
        while (wrote < 50e6 && res.write('x'.repeat(64e3))) wrote += 64e3
        if (wrote < 50e6) res.once('drain', pump)
        else res.end()
      }
      pump()
    },
  })
  const r = await checkSite(`${base}/`, 5000, dns.lookup)
  assert.equal(r.code, 200)
  assert.ok(wrote < 50e6, `stopped early, wrote ${wrote}`)
})

test('release state: flags matched by name, branches by origin/main, loose site flags listed, no config means unknown', () => {
  const config = cfg({ samsungwalletpayouts: true, claimwithaddress: false, alerts: true, leaderboard: true }, { proof: false, dynamicBaskets: false, leaderboard: false })
  const plan = [
    { n: 1, flags: ['SAMSUNG_WALLET_PAYOUTS'] },
    { n: 2, flags: ['CLAIM_WITH_ADDRESS'] },
    { n: 3, flags: ['FEATURE_ALERTS', 'FEATURE_PROOF'] },
    { n: 4, flags: ['NOT_EXPOSED'] },
    { n: 8, flags: ['LEADERBOARD'] },
    { n: 9, flags: ['CONSTRUCTOR', 'TOSTRING'] },
  ]
  const branches = [
    { n: 2, branch: 'update-2-x', sha: 'aaaaaaa', inMain: false },
    { n: 5, branch: 'update-5-y', sha: 'bbbbbbb', inMain: true },
    { n: 6, branch: 'update-6-z', sha: 'ccccccc', inMain: false },
    { n: 7, branch: 'update-7-w', sha: 'ddddddd', inMain: null },
  ]
  const s = updateStatus({ plan, branches, config })
  assert.deepEqual(s.entries.map(e => [e.n, e.state]), [[1, 'on'], [2, 'off'], [3, 'partly'], [4, 'unknown'], [5, 'merged'], [6, 'branch'], [7, 'unknown'], [8, 'off'], [9, 'unknown'], [null, 'off']])
  assert.equal(s.entries[1].branch.name, 'update-2-x')
  assert.deepEqual(s.entries[8].flags.map(f => f.prod), [null, null], 'prototype names are never flags')
  assert.equal(s.entries.at(-1).flags[0].name, 'dynamicBaskets')
  assert.equal(s.checkedAt, 7)

  const none = updateStatus({ plan, branches: [], config: undefined })
  assert.ok(none.entries.every(e => e.state === 'unknown'))
  const failed = updateStatus({ plan, branches: [], config: { ok: false, ts: 9, error: 'HTTP 502' } })
  assert.equal(failed.configError, 'HTTP 502')
  assert.ok(failed.entries.every(e => e.state === 'unknown'))
})

test('the release plan and update branches are read from the repo; no origin/main means unknown', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-repo-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', windowsHide: true }).trim()
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'a')
  git('branch', 'update-1-merged')
  git('commit', '-q', '--allow-empty', '-m', 'b')
  assert.deepEqual((await updateBranches(repo)).map(b => b.inMain), [null])
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-q', '-b', 'update-2-open')
  git('commit', '-q', '--allow-empty', '-m', 'c')
  git('branch', 'updates-misc')
  git('checkout', '-q', 'main')

  assert.deepEqual((await updateBranches(repo)).map(b => [b.n, b.branch, b.inMain]), [[1, 'update-1-merged', true], [2, 'update-2-open', false]])
  assert.deepEqual(releasePlan(repo), [])
  fs.mkdirSync(path.join(repo, '.local'))
  fs.writeFileSync(path.join(repo, '.local', 'release.json'), JSON.stringify({ updates: { 2: { FEATURE_X: '1', 'bad key': '1' }, x: { Y: '1' }, 3: 'no' }, ca: { TOKEN_MINT: '' } }))
  assert.deepEqual(releasePlan(repo), [{ n: 2, flags: ['FEATURE_X'] }])
  fs.writeFileSync(path.join(repo, '.local', 'release.json'), '{bad')
  assert.deepEqual(releasePlan(repo), [])
})

test('the digest counts update states per active project, loose site flags apart', () => {
  const prodUpdates = { entries: [{ n: 1, state: 'on' }, { n: 2, state: 'off' }, { n: 3, state: 'off' }, { n: 4, state: 'branch' }, { n: 5, state: 'unknown' }, { n: null, state: 'off' }] }
  const text = buildDigest([{ name: 'a', fields: { stage: 'fixes' }, tasks: [], prodUpdates }], Date.parse('2026-10-24T07:00:00Z'), { lang: 'ru' })
  assert.match(text, /Апдейты: 1 включено на проде, 2 выключено, 1 на ветках, 1 состояние неизвестно; флаги сайта без номера апдейта: 1 выключено/)
})

test('a prod state is shown only while the site is watched, unchanged and read within 25 minutes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-prod-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  const file = path.join(projects, 'demo', 'demo.md')
  fs.writeFileSync(file, ['---', 'stage: fixes', 'site: "https://demo.example.com"', '---', ''].join('\n'))
  let now = Date.parse('2026-10-24T07:00:00Z')
  const app = createApp({
    projectsRoot: projects,
    reposRoot: path.join(dir, 'repos'),
    dbFile: path.join(dir, 'db', 't.db'),
    port: 0,
    checkHealth: false,
    clock: () => now,
    probeSite: async () => ({ code: 200, ms: 1, error: null }),
    readConfig: async () => cfg({}, { alpha: true }),
  })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const get = () =>
    new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/api/projects/demo', headers: { host: `127.0.0.1:${port}` } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve(JSON.parse(s).prodUpdates))
      }).on('error', reject))

  assert.deepEqual((await get()).entries, [], 'nothing before the first read')
  await app.healthTick()
  assert.deepEqual((await get()).entries.map(e => [e.flags[0].name, e.state]), [['alpha', 'on']])

  now += 26 * 60e3
  assert.deepEqual((await get()).entries, [], 'a stale read is not shown')
  await app.healthTick()
  assert.equal((await get()).entries.length, 1)

  fs.writeFileSync(file, ['---', 'stage: fixes', 'site: "https://other.example.com"', '---', ''].join('\n'))
  assert.deepEqual((await get()).entries, [], 'a read of another site is not shown')
  await app.healthTick()
  assert.equal((await get()).entries.length, 1)

  fs.writeFileSync(file, ['---', 'stage: done', 'site: "https://other.example.com"', '---', ''].join('\n'))
  assert.deepEqual((await get()).entries, [], 'a done project shows no prod state')
})

test('an ignored project site is never probed, on the tick or on Recheck', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ign-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'secret-app'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  fs.writeFileSync(path.join(projects, 'secret-app', 'secret-app.md'), ['---', 'stage: fixes', 'site: "https://secret.example.com"', '---', ''].join('\n'))
  let probes = 0
  const app = createApp({
    projectsRoot: projects, reposRoot: path.join(dir, 'repos'), dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, ignore: ['secret', 'private-clients'],
    probeSite: async () => (probes++, { code: 200, ms: 1, error: null }),
    readConfig: async () => (probes++, cfg({})),
  })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(projects, 'shop'))
  fs.writeFileSync(path.join(projects, 'shop', 'shop.md'), ['---', 'stage: fixes', 'site: "https://shop.example.com"', 'repo: "private-clients/shop"', 'next_step: "HIDDEN-STEP"', '---', ''].join('\n'))
  await app.healthTick()
  const shop = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/digest', headers: { host: `127.0.0.1:${port}` } }, res => {
    let s = ''
    res.on('data', c => (s += c))
    res.on('end', () => resolve(JSON.parse(s).text))
  }).on('error', reject))
  assert.ok(!shop.includes('HIDDEN-STEP'), 'a project ignored by its repo path stays out of the digest')
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/projects/secret-app/refresh', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, res => (res.resume(), resolve(res.statusCode)))
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(status, 200)
  assert.equal(probes, 0)
})
