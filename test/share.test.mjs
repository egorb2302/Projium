import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { shareConfig, shareUnknownKeys, pageData, renderPage, writePages, manifestFor, exportedSlugs, slugOf, newSlug, SAFE, SHOW } from '../lib/share.mjs'
import { createApp } from '../server.mjs'
import { diagnose } from '../lib/doctor.mjs'

const rm = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
const temp = (t, manual = false) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-share-'))
  if (!manual) t.after(() => rm(dir))
  return dir
}

const SECRET_CARD = [
  '---',
  'stage: review',
  'status: "SECRET-STATUS client is late paying"',
  'next_step: "SECRET-NEXT call the lawyer"',
  'api_key: SECRET-KEY-123',
  'repo: secret-repo-folder',
  'site: https://acme.example',
  '---',
  '',
  '# Acme',
  '',
  '## Tasks',
  '',
  '- [ ] SECRET-TASK fix the invoice · due 2026-11-05 · p1 ^t-aaaa',
  '- [x] done task SECRET-DONE ^t-bbbb',
  '',
  '## Updates',
  '',
  '- [x] u1 Landing page with `waitlist` ^u-1',
  '- [ ] u2 Referral links',
  '- u3 [[Specs/u3|Leaderboard]]',
  '',
].join('\n')

test('share config lists projects with a safe default and validates every key', () => {
  const c = shareConfig({ every: 30, projects: { Acme: {}, 'Beta Shop': { show: ['stage', 'next_step'], title: 'Beta', lang: 'ru', slug: 'beta-x1' } } }, d => `/base/${d}`)
  assert.equal(c.dir, '/base/share')
  assert.equal(c.every, 30)
  assert.deepEqual(c.projects[0], { name: 'Acme', show: SAFE, title: null, lang: null, slug: 'acme' })
  assert.deepEqual(c.projects[1], { name: 'Beta Shop', show: ['stage', 'next_step'], title: 'Beta', lang: 'ru', slug: 'beta-x1' })
  assert.equal(shareConfig(null, d => d), null)
  for (const bad of [[], { every: -1 }, { every: 2000 }, { projects: [] }, { projects: { A: { show: ['secrets'] } } }, { projects: { A: { lang: 'de' } } }, { projects: { A: { slug: 'Bad Slug' } } }, { projects: { A: { title: 'x\ny' } } }, { projects: { 'a b': {}, 'a-b': {} } }, { dir: '' }])
    assert.throws(() => shareConfig(bad, d => d), Error, JSON.stringify(bad))
  assert.deepEqual(shareUnknownKeys({ dirr: 1, projects: { A: { shw: [] } } }), ['share.dirr', 'share.projects["A"].shw'])
  assert.equal(slugOf('Проект'), slugOf('Проект'))
  assert.match(slugOf('Проект'), /^p-[0-9a-f]{8}$/)
  assert.match(newSlug('Acme Shop'), /^acme-shop-[a-z0-9]{6}$/)
  assert.notEqual(newSlug('Acme'), newSlug('Acme'))
})

const cardView = () => {
  return {
    name: 'Acme',
    zone: '+03:00',
    fields: { stage: 'review', status: 'SECRET-STATUS client is late paying', next_step: 'SECRET-NEXT call the lawyer', site: 'https://acme.example' },
    tasks: [{ id: 't-aaaa', done: false, text: 'SECRET-TASK fix the invoice', due: '2026-11-05', p: 'p1' }, { id: 't-bbbb', done: true, text: 'done task SECRET-DONE', due: '', p: '' }],
    updates: [{ text: 'u1 Landing page with `waitlist`', item: true, done: true, id: 'u-1', at: 0 }, { text: 'u2 Referral links', item: true, done: false, id: '', at: 1 }, { text: 'u3 [[Specs/u3|Leaderboard]]', item: true, done: false, id: '', at: 2 }],
    repoInfo: { repo: 'secret-repo-folder', readiness: { proven: 12, total: 26 } },
    fileId: 'SECRET-FILEID',
    watch: {
      open: 0,
      targets: [
        { name: 'acme-site', kind: 'site', signals: [{ signal: 'up', status: 'ok', result: 'ok' }, { signal: 'cert', status: 'ok', result: 'ok', detail: [{ k: 'cert', date: '2027-01-20', days: 80 }] }] },
        { name: 'treasury', kind: 'balance', address: 'SECRETADDRESS', signals: [{ signal: 'balance', status: 'open', result: 'fail', detail: [{ k: 'balance', value: 0.01, min: 0.05, unit: 'SOL' }] }] },
      ],
    },
  }
}

test('a client page shows only the allowed parts, and never tasks, next step, status, paths or balances by default', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')
  const health = [{ ts: now - 3600e3, code: 200 }, { ts: now - 2 * 864e5, code: 502 }, { ts: now - 2 * 864e5 + 600e3, code: 200 }]
  const incidents = [{ signal: 'up', openedAt: now - 2 * 864e5, closedAt: now - 2 * 864e5 + 1800e3 }, { signal: 'balance', openedAt: now - 3600e3, closedAt: null }]
  const page = renderPage(pageData({ card: cardView(), show: SAFE, now, health, incidents }))
  const html = page.replace(/<style>[\s\S]*?<\/style>/, '')
  for (const secret of ['SECRET', 'secret-repo', 'treasury', 'acme.example', 'Specs/u3', 'p1', 'invoice']) assert.ok(!html.includes(secret), secret)
  assert.match(html, /12 of 26 acceptance checks passed/)
  assert.match(html, /In review/)
  assert.match(html, /<code>waitlist<\/code>/)
  assert.match(html, /Leaderboard/)
  assert.match(html, /acme-site/)
  assert.match(html, /<span class="st ok">Operational/)
  const failing = cardView()
  failing.watch.targets[0].signals[0] = { signal: 'up', status: 'ok', result: 'fail' }
  assert.match(renderPage(pageData({ card: failing, show: ['uptime'], now })), /<span class="st warn">Degraded/)
  assert.match(html, /certificate valid until 20 Jan 2027/)
  assert.match(html, /Site unreachable/)
  assert.match(html, /resolved after 30 min/)
  assert.match(html, /Updated 1 Nov 2026, 15:00 UTC\+03:00/)
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/)
  assert.match(html, /<meta property="og:title" content="Acme">/)
  assert.match(html, /<meta property="og:description" content="Acme, in review: progress, updates and uptime">/)
  assert.match(html, /<title>Acme · status<\/title>/)
  assert.ok(!/eyebrow|Project status/.test(html))
  assert.ok(!/<script/i.test(html))
  const all = renderPage(pageData({ card: cardView(), show: SHOW, now, health, incidents })).replace(/<style>[\s\S]*?<\/style>/, '')
  assert.match(all, /SECRET-STATUS/)
  assert.match(all, /SECRET-NEXT/)
  assert.match(all, /SECRET-TASK/)
  assert.ok(!all.includes('SECRET-DONE'))
  assert.ok(!all.includes('SECRET-KEY'))
  assert.ok(!all.includes('SECRET-FILEID'))
  assert.ok(!all.includes('SECRETADDRESS'))
})

test('a client page escapes what it prints and falls back to update counts', () => {
  const card = { ...cardView(), repoInfo: {}, name: '<img src=x onerror=alert(1)>' }
  const html = renderPage(pageData({ card, show: ['progress', 'updates'], title: null, lang: 'ru', now: Date.now() }))
  assert.ok(!html.includes('<img src=x'))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /Готово 1 из 3 апдейтов/)
  assert.match(html, /<html lang="ru">/)
  assert.ok(!html.includes('Uptime'))
})

test('a client page shows only the name of a linked note, never its path', () => {
  const card = { ...cardView(), updates: [{ item: true, done: false, text: 'u1 per [[Clients/Acme/Contract 2026]] and [[Acme#Pricing]], see ![[Specs/flow.md]] and [[#Scope]] and [[Old/x|the brief]]' }] }
  const html = renderPage(pageData({ card, show: ['updates'], now: Date.now() })).replace(/<style>[\s\S]*?<\/style>/, '')
  assert.match(html, /u1 per Contract 2026 and Acme, see flow and Scope and the brief/)
  for (const leak of ['Clients/', 'Pricing', 'Specs/', '[[', 'Old/']) assert.ok(!html.includes(leak), leak)
})

test('export writes one folder per page, robots and an empty root page, and removes only pages it wrote before', t => {
  const root = temp(t)
  const dir = path.join(root, 'share')
  const manifest = path.join(root, 'data', 'share-x.json')
  fs.mkdirSync(path.join(dir, 'mine'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mine', 'index.html'), 'owner file')
  const r1 = writePages(dir, [{ name: 'A', slug: 'a-1', html: 'A' }, { name: 'B', slug: 'b-1', html: 'B' }], { manifest })
  assert.deepEqual(r1.written.map(x => x.slug), ['a-1', 'b-1'])
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n')
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow">\n<title>Status pages<\/title>\n<\/head>\n<body><\/body>/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a-1', 'b-1', 'index.html', 'mine', 'robots.txt'])
  assert.deepEqual(exportedSlugs(manifest), ['a-1', 'b-1'])
  fs.writeFileSync(manifest, JSON.stringify({ slugs: ['a-1', 'b-1', '../mine', 'mine/..'] }))
  const r2 = writePages(dir, [{ name: 'A', slug: 'a-1', html: 'A2' }], { manifest })
  assert.deepEqual(r2.removed, ['b-1'])
  assert.equal(fs.existsSync(path.join(dir, 'b-1')), false)
  assert.equal(fs.readFileSync(path.join(dir, 'mine', 'index.html'), 'utf8'), 'owner file')
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A2')
  writePages(dir, [], { keep: ['a-1'], manifest })
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A2')
  assert.notEqual(manifestFor(path.join(root, 'data'), dir), manifestFor(path.join(root, 'data'), path.join(root, 'other')))
})

test('export never overwrites a page file it did not write, nor writes through a linked folder', t => {
  const root = temp(t)
  const dir = path.join(root, 'share')
  const manifest = path.join(root, 'm.json')
  fs.mkdirSync(path.join(dir, 'theirs-1'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'theirs-1', 'index.html'), 'owner page')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(dir, 'linked-1'), 'junction')
  const r = writePages(dir, [{ name: 'A', slug: 'theirs-1', html: 'A' }, { name: 'B', slug: 'linked-1', html: 'B' }, { name: 'C', slug: 'c-1', html: 'C' }], { manifest })
  assert.deepEqual(r.written.map(x => x.slug), ['c-1'])
  assert.deepEqual(r.skipped.map(x => x.slug), ['theirs-1', 'linked-1'])
  assert.equal(fs.readFileSync(path.join(dir, 'theirs-1', 'index.html'), 'utf8'), 'owner page')
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.writeFileSync(manifest, JSON.stringify({ slugs: ['c-1', 'linked-1'] }))
  fs.writeFileSync(path.join(outside, 'index.html'), 'outside page')
  writePages(dir, [], { manifest })
  assert.equal(fs.readFileSync(path.join(outside, 'index.html'), 'utf8'), 'outside page')
  assert.equal(fs.existsSync(path.join(dir, 'c-1')), false)
})

test('an export with nothing shared and nothing written before creates no folder', t => {
  const root = temp(t)
  const dir = path.join(root, 'share')
  assert.deepEqual(writePages(dir, [], { manifest: path.join(root, 'm.json') }), { written: [], removed: [], skipped: [] })
  assert.equal(fs.existsSync(dir), false)
})

const serve = async (t, share, clock = () => Date.now()) => {
  const here = temp(t, true)
  const projects = path.join(here, 'projects')
  fs.mkdirSync(path.join(projects, 'Acme'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'Acme', 'Acme.md'), SECRET_CARD)
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: 'projects', reposDir: '.', share }))
  const app = createApp({ projectsRoot: projects, reposRoot: here, dbFile: path.join(here, 'db', 't.db'), port: 0, checkHealth: false, configFile: file, clock })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    rm(here)
  })
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(s)
          } catch {}
          resolve({ status: res.statusCode, json, text: s, headers: res.headers })
        })
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  return { here, file, call, app }
}

test('the share API lists pages, exports them and previews one with its own CSP', async t => {
  const { here, call } = await serve(t, { projects: { Acme: { slug: 'acme-k2' } } })
  const info = (await call('GET', '/api/share')).json
  assert.equal(info.enabled, true)
  assert.equal(info.dir, path.join(here, 'share'))
  assert.deepEqual(info.projects.map(p => [p.name, p.slug, p.exported]), [['Acme', 'acme-k2', null]])
  const r = (await call('POST', '/api/share/export', {})).json
  assert.deepEqual(r.written.map(x => x.slug), ['acme-k2'])
  const html = fs.readFileSync(path.join(here, 'share', 'acme-k2', 'index.html'), 'utf8')
  assert.ok(!html.includes('SECRET'))
  assert.ok(!html.includes(here))
  assert.deepEqual(fs.readdirSync(path.join(here, 'share')).sort(), ['acme-k2', 'index.html', 'robots.txt'])
  assert.deepEqual(exportedSlugs(manifestFor(path.join(here, 'db'), path.join(here, 'share'))), ['acme-k2'])
  const preview = await call('GET', '/share/acme-k2')
  assert.equal(preview.status, 200)
  assert.match(preview.headers['content-type'], /text\/html/)
  assert.match(preview.headers['content-security-policy'], /font-src data:/)
  assert.ok(!preview.text.includes('SECRET'))
  assert.equal((await call('GET', '/share/nope')).status, 404)
  assert.ok((await call('GET', '/api/share')).json.projects[0].exported)
})

test('doctor lists the shared projects and names those without a card', async t => {
  const here = temp(t)
  fs.mkdirSync(path.join(here, 'projects', 'Acme'), { recursive: true })
  fs.writeFileSync(path.join(here, 'projects', 'Acme', 'Acme.md'), '---\nstage: review\n---\n')
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: 'projects', reposDir: '.', share: { projects: { Acme: {}, Gone: {} } } }))
  const r = await diagnose(here, { file, probe: async () => ({ running: false }) })
  assert.deepEqual(r.config.share, { projects: ['Acme', 'Gone'], dir: path.join(here, 'share'), every: 0 })
  assert.ok(r.hints.some(h => /share lists project\(s\) with no card: Gone/.test(h)))
  assert.ok(r.hints.some(h => /address of Acme, Gone is the project name/.test(h)))
})

test('pages are exported on the timer set by share.every, and not before it is due', async t => {
  let now = Date.now()
  const { here, app } = await serve(t, { every: 30, projects: { Acme: { slug: 'acme-t1' } } }, () => now)
  const page = path.join(here, 'share', 'acme-t1', 'index.html')
  await app.shareTick()
  assert.ok(fs.existsSync(page))
  fs.rmSync(page)
  now += 29 * 60e3
  await app.shareTick()
  assert.equal(fs.existsSync(page), false)
  now += 2 * 60e3
  await app.shareTick()
  assert.ok(fs.existsSync(page))
})

test('stopping the last shared page deletes its file at once, and so does moving the folder', async t => {
  const { here, file, call } = await serve(t, { projects: { Acme: { slug: 'acme-z9' } } })
  await call('POST', '/api/share/export', {})
  const page = path.join(here, 'share', 'acme-z9', 'index.html')
  assert.ok(fs.existsSync(page))
  let s = (await call('GET', '/api/settings')).json
  await call('POST', '/api/settings', { hash: s.hash, share: [{ op: 'remove', project: 'Acme' }] })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).share, undefined)
  assert.equal(fs.existsSync(page), false)
  s = (await call('GET', '/api/settings')).json
  await call('POST', '/api/settings', { hash: s.hash, share: [{ op: 'set', project: 'Acme' }] })
  await call('POST', '/api/share/export', {})
  const slug = JSON.parse(fs.readFileSync(file, 'utf8')).share.projects.Acme.slug
  assert.ok(fs.existsSync(path.join(here, 'share', slug, 'index.html')))
  s = (await call('GET', '/api/settings')).json
  await call('POST', '/api/settings', { hash: s.hash, set: { shareDir: 'pages' } })
  assert.equal(fs.existsSync(path.join(here, 'share', slug)), false)
  assert.ok(fs.existsSync(path.join(here, 'pages', slug, 'index.html')))
})

test('changing what a page shows rewrites an exported page at once and keeps a hand-set address', async t => {
  const { here, file, call } = await serve(t, { projects: { Acme: {} } })
  await call('POST', '/api/share/export', {})
  const page = path.join(here, 'share', 'acme', 'index.html')
  assert.match(fs.readFileSync(page, 'utf8'), /In review/)
  const s = (await call('GET', '/api/settings')).json
  await call('POST', '/api/settings', { hash: s.hash, share: [{ op: 'set', project: 'Acme', show: ['updates'] }] })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).share.projects.Acme, { slug: 'acme', show: ['updates'] })
  assert.ok(!fs.readFileSync(page, 'utf8').includes('In review'))
})

test('balance incidents do not push site incidents off the page', async t => {
  const { here, call, app } = await serve(t, { projects: { Acme: { slug: 'acme-b1' } } })
  const now = Date.now()
  const add = app.db.prepare('insert into watch_incidents (target, signal, project, opened_at, closed_at) values (?, ?, ?, ?, ?)')
  add.run('shop', 'up', 'Acme', now - 20 * 864e5, now - 20 * 864e5 + 600e3)
  for (let i = 0; i < 40; i++) add.run('wallet', 'balance', 'Acme', now - i * 36e5, now - i * 36e5 + 60e3)
  await call('POST', '/api/share/export', {})
  const html = fs.readFileSync(path.join(here, 'share', 'acme-b1', 'index.html'), 'utf8')
  assert.match(html, /Site unreachable/)
  assert.ok(!html.includes('No incidents in the last 90 days'))
})

test('an export asked for while another runs starts again after it, with the newest settings', async t => {
  let midway = null
  const clock = () => {
    if (midway) {
      midway()
      midway = null
    }
    return Date.now()
  }
  const { here, file, app } = await serve(t, { projects: { Acme: { slug: 'acme-q1' } } }, clock)
  const page = path.join(here, 'share', 'acme-q1', 'index.html')
  midway = () => {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    cfg.share.projects.Acme.show = ['updates']
    fs.writeFileSync(file, JSON.stringify(cfg))
  }
  const first = app.exportShare()
  const second = app.exportShare()
  await first
  assert.match(fs.readFileSync(page, 'utf8'), /In review/)
  await second
  assert.ok(!fs.readFileSync(page, 'utf8').includes('In review'))
})

test('moving the folder clears the old one only after an export that already runs', async t => {
  const { here, file, call, app } = await serve(t, { projects: { Acme: { slug: 'acme-m2' } } })
  await call('POST', '/api/share/export', {})
  const old = path.join(here, 'share', 'acme-m2', 'index.html')
  let open
  const running = app.queueShare(() => new Promise(r => (open = r)))
  const s = (await call('GET', '/api/settings')).json
  const moved = call('POST', '/api/settings', { hash: s.hash, set: { shareDir: 'pages' } })
  const dirOf = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).share?.dir
    } catch {
      return null
    }
  }
  while (dirOf() !== 'pages') await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 50))
  assert.ok(fs.existsSync(old))
  open()
  await running
  assert.equal((await moved).status, 200)
  assert.equal(fs.existsSync(path.join(here, 'share', 'acme-m2')), false)
  assert.ok(fs.existsSync(path.join(here, 'pages', 'acme-m2', 'index.html')))
})

test('a share change reports pages the export folder could not take', async t => {
  const { here, call } = await serve(t, { projects: { Acme: { slug: 'acme-f1' } } })
  await call('POST', '/api/share/export', {})
  fs.mkdirSync(path.join(here, 'pages', 'acme-f1'), { recursive: true })
  fs.writeFileSync(path.join(here, 'pages', 'acme-f1', 'index.html'), 'theirs')
  const s = (await call('GET', '/api/settings')).json
  const r = await call('POST', '/api/settings', { hash: s.hash, set: { shareDir: 'pages' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.share.failed.map(f => f.slug), ['acme-f1'])
  assert.match(r.json.share.failed[0].error, /not written by Projium/)
  assert.equal(fs.readFileSync(path.join(here, 'pages', 'acme-f1', 'index.html'), 'utf8'), 'theirs')
})

test('sharing a project from its page writes the config with a random slug and needs no restart', async t => {
  const { file, call } = await serve(t, undefined)
  const s = (await call('GET', '/api/settings')).json
  assert.equal(s.restart, false)
  const set = await call('POST', '/api/settings', { hash: s.hash, share: [{ op: 'set', project: 'Acme', show: ['stage', 'updates'], title: 'Acme for the client', lang: 'ru' }] })
  assert.equal(set.status, 200)
  assert.equal(set.json.restart, false)
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')).share.projects.Acme
  assert.match(cfg.slug, /^acme-[a-z0-9]{6}$/)
  assert.deepEqual([cfg.show, cfg.title, cfg.lang], [['stage', 'updates'], 'Acme for the client', 'ru'])
  const again = await call('POST', '/api/settings', { hash: set.json.hash, share: [{ op: 'set', project: 'Acme', show: SAFE, title: '', lang: '' }] })
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).share.projects.Acme
  assert.equal(kept.slug, cfg.slug)
  assert.deepEqual(kept, { slug: cfg.slug, show: SAFE })
  assert.equal((await call('POST', '/api/settings', { hash: again.json.hash, share: [{ op: 'set', project: 'Nobody', show: SAFE }] })).status, 400)
  await call('POST', '/api/settings', { hash: (await call('GET', '/api/settings')).json.hash, share: [{ op: 'remove', project: 'Acme' }] })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).share, undefined)
})
