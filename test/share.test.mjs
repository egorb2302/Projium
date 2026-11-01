import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { shareConfig, shareUnknownKeys, pageData, renderPage, writePages, slugOf, newSlug, SAFE, SHOW } from '../lib/share.mjs'
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

test('export writes one folder per page, a robots file and removes only pages it wrote before', t => {
  const dir = path.join(temp(t), 'share')
  fs.mkdirSync(path.join(dir, 'mine'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mine', 'index.html'), 'owner file')
  const r1 = writePages(dir, [{ name: 'A', slug: 'a-1', html: 'A' }, { name: 'B', slug: 'b-1', html: 'B' }])
  assert.deepEqual(r1.written.map(x => x.slug), ['a-1', 'b-1'])
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow: /\n')
  fs.writeFileSync(path.join(dir, 'manifest-tamper'), '')
  const m = path.join(dir, '.projium-share.json')
  fs.writeFileSync(m, JSON.stringify({ slugs: ['a-1', 'b-1', '../mine', 'mine/..'] }))
  const r2 = writePages(dir, [{ name: 'A', slug: 'a-1', html: 'A2' }])
  assert.deepEqual(r2.removed, ['b-1'])
  assert.equal(fs.existsSync(path.join(dir, 'b-1')), false)
  assert.equal(fs.readFileSync(path.join(dir, 'mine', 'index.html'), 'utf8'), 'owner file')
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A2')
  writePages(dir, [], ['a-1'])
  assert.equal(fs.readFileSync(path.join(dir, 'a-1', 'index.html'), 'utf8'), 'A2')
})

const serve = async (t, share) => {
  const here = temp(t, true)
  const projects = path.join(here, 'projects')
  fs.mkdirSync(path.join(projects, 'Acme'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'Acme', 'Acme.md'), SECRET_CARD)
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: 'projects', reposDir: '.', share }))
  const app = createApp({ projectsRoot: projects, reposRoot: here, dbFile: path.join(here, 'db', 't.db'), port: 0, checkHealth: false, configFile: file })
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
})

test('pages are exported on the timer set by share.every, and not before it is due', async t => {
  const { here, app } = await serve(t, { every: 30, projects: { Acme: { slug: 'acme-t1' } } })
  const page = path.join(here, 'share', 'acme-t1', 'index.html')
  await app.shareTick()
  assert.ok(fs.existsSync(page))
  fs.rmSync(page)
  await app.shareTick()
  assert.equal(fs.existsSync(page), false)
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
