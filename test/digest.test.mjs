import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { buildDigest, isDue, localDay, parseAt, commandSender, digestSender } from '../lib/digest.mjs'
import { ignoreTest } from '../lib/config.mjs'
import { createApp } from '../server.mjs'

const at = iso => Date.parse(iso)
const RU = { offset: 180, lang: 'ru', ignored: ignoreTest(['paused', 'frozen']) }
const APP_RU = { utcOffset: 180, digestLang: 'ru', ignore: ['paused', 'frozen'] }

test('days and the send time follow the configured UTC offset', () => {
  assert.equal(localDay(at('2026-10-24T20:59:00Z'), 180), '2026-10-24')
  assert.equal(localDay(at('2026-10-24T21:00:00Z'), 180), '2026-10-25')
  assert.equal(localDay(at('2026-10-24T21:00:00Z')), '2026-10-24')
  assert.equal(localDay(at('2026-10-25T03:00:00Z'), -300), '2026-10-24')
  assert.equal(parseAt('10:00'), 600)
  assert.equal(parseAt('24:00'), null)
  assert.equal(parseAt('9:00'), null)
  assert.equal(isDue(at('2026-10-24T06:59:00Z'), 600, null, 180), false)
  assert.equal(isDue(at('2026-10-24T07:00:00Z'), 600, null, 180), true)
  assert.equal(isDue(at('2026-10-24T07:00:00Z'), 600, '2026-10-24', 180), false)
  assert.equal(isDue(at('2026-10-24T15:00:00Z'), 600, '2026-10-23', 180), true)
  assert.equal(isDue(at('2026-10-24T07:00:00Z'), 600, null), false)
})

test('the digest speaks English by default and shows ignored projects by name only', () => {
  const text = buildDigest(
    [card('alpha', 'fixes', { fields: { next_step: 'ship' }, tasks: [{ text: 'late one', done: false, due: '2026-10-20', p: 'p2' }] }), card('paused-app', 'fixes', { fields: { next_step: 'hidden' } })],
    at('2026-10-24T07:00:00Z'),
    { ignored: ignoreTest(['paused']), url: 'http://127.0.0.1:4000' },
  )
  assert.match(text, /^Tracker digest for 2026-10-24\n/)
  assert.match(text, /Ignored, not tracked: paused-app\n/)
  assert.match(text, /In progress: 1\n\nalpha: fixes\nNext: ship\nTasks: 1 open\n- late one \(due 2026-10-20, overdue\) p2/)
  assert.doesNotMatch(text, /hidden/)
  assert.match(text, /Dashboard: http:\/\/127\.0\.0\.1:4000$/)
})

test('a HEAD rolled back behind the audit is named as such in the digest', () => {
  const text = buildDigest([card('alpha', 'fixes', { repoInfo: { freshness: { state: 'changed-after', commit: 'abc1234', sinceLocal: 0, behindAudit: 2, sinceOrigin: 0, dirty: 0 } } })], at('2026-10-24T07:00:00Z'))
  assert.match(text, /Audit: audit is stale: HEAD is 2 commit\(s\) behind abc1234\n/)
})

test('a digest command gets the text as its last argument and its failure names only the exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-cmd-'))
  try {
    const out = path.join(dir, 'out.txt')
    const script = path.join(dir, 'send.mjs')
    fs.writeFileSync(script, "import fs from 'node:fs'\nconst [, , file, text] = process.argv\nif (text === 'boom') process.exit(3)\nfs.writeFileSync(file, text)\n")
    await commandSender(['node', script, out])('hello\nworld')
    assert.equal(fs.readFileSync(out, 'utf8'), 'hello\nworld')
    await digestSender({ command: ['node', script, out], telegram: { token: 't', chatId: 'c' } })('command wins over telegram')
    assert.equal(fs.readFileSync(out, 'utf8'), 'command wins over telegram')
    assert.equal(digestSender({ command: null, telegram: null }), null)
    fs.writeFileSync(script, "process.stderr.write('token=SECRET-XYZ ' + process.env.PATH)\nprocess.exit(3)\n")
    await assert.rejects(commandSender(['node', script, out])('x'), e => e.message === 'digest command: exit 3')
    await assert.rejects(commandSender([path.join(dir, 'missing.exe')])('x'), e => e.message === 'digest command: did not start')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const card = (name, stage, extra = {}) => ({ name, fields: { stage, next_step: '', ...extra.fields }, tasks: extra.tasks ?? [], health: extra.health ?? null, repoInfo: extra.repoInfo ?? null })

test('the digest shows active projects with overdue tasks, a down site and a stale audit, and skips closed ones', () => {
  const text = buildDigest(
    [
      card('alpha', 'fixes', {
        fields: { next_step: 'wait for the CA' },
        tasks: [
          { text: 'later', done: false, due: '', p: 'p3' },
          { text: 'late one', done: false, due: '2026-10-20', p: 'p2' },
          { text: 'finished', done: true, due: '2026-10-01', p: 'p1' },
        ],
        health: { last: { code: 502 }, uptime24: 80 },
        repoInfo: { freshness: { state: 'changed-after', commit: 'abc1234', sinceLocal: 3, sinceOrigin: 5, dirty: 0 } },
      }),
      card('beta', 'done', { tasks: [{ text: 'old debt', done: false, due: '2026-10-22', p: '' }, { text: 'no date', done: false, due: '', p: 'p1' }] }),
      card('gamma', 'done'),
      card('frozen rebuild', 'done'),
      card('paused-app', 'fixes', { fields: { next_step: 'Stopped' }, tasks: [{ text: 'stale', done: false, due: '2026-10-01', p: 'p1' }] }),
      { name: 'broken', error: 'bad frontmatter' },
      card('delta', 'review', { tasks: [{ text: `\`code\` ${'x'.repeat(200)}`, done: false, due: '', p: '' }] }),
    ],
    at('2026-10-24T07:00:00Z'),
    RU,
  )
  assert.match(text, /сводка на 2026-10-24/)
  assert.match(text, /В работе: 2/)
  assert.doesNotMatch(text, /paused-app: |stale|Stopped/)
  assert.match(text, /Остановлены, не трогаем: paused-app\n/)
  assert.match(text, /- code x{100,}…\n/)
  assert.ok(text.split('\n').every(l => l.length <= 160))
  assert.match(text, /alpha: fixes\nДальше: wait for the CA\nСайт не отвечает: 502\nАудит: аудит устарел: 5 коммит\(ов\) после abc1234/)
  assert.match(text, /Задачи: 2 открыто\n- late one \(до 2026-10-20, просрочено\) p2\n- later p3/)
  assert.doesNotMatch(text, /finished/)
  assert.match(text, /Сроки в закрытых проектах:\n- beta: old debt \(до 2026-10-22, просрочено\)/)
  assert.doesNotMatch(text, /no date|gamma/)
  assert.match(text, /- broken: bad frontmatter/)
  assert.ok(text.indexOf('Сроки в закрытых') < text.indexOf('В работе'), 'short urgent sections come first')
})

test('the digest labels tasks due today, counts the rest, handles dirty-only audits, hides stopped errors and cuts on a line', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e'].map(text => ({ text, done: false, due: '', p: '' }))
  tasks[4].due = '2026-10-24'
  const text = buildDigest(
    [
      card('alpha', 'review', { tasks, repoInfo: { freshness: { state: 'changed-after', commit: 'abc1234', sinceLocal: 0, sinceOrigin: 0, dirty: 2 } } }),
      { name: 'paused-app', error: 'secret-ish detail' },
    ],
    at('2026-10-24T07:00:00Z'),
    RU,
  )
  assert.match(text, /Задачи: 5 открыто\n- e \(до 2026-10-24, сегодня\)\n- a\n- b\n- и ещё 2/)
  assert.match(text, /Аудит: аудит устарел: 2 файл\(ов\) не закоммичено\n/)
  assert.match(text, /Карточки не читаются:\n- paused-app\n/)
  assert.doesNotMatch(text, /secret-ish/)

  const debts = buildDigest([card('old', 'done', { tasks: Array.from({ length: 14 }, (_, i) => ({ text: `d${i}`, done: false, due: '2026-10-01', p: '' })) })], at('2026-10-24T07:00:00Z'), RU)
  assert.match(debts, /- old: d9 \(до 2026-10-01, просрочено\)\n- и ещё 4\n/)

  const many = Array.from({ length: 60 }, (_, i) => card(`p${i}`, 'fixes', { fields: { next_step: 'x'.repeat(120) } }))
  const long = buildDigest(many, at('2026-10-24T07:00:00Z'), RU)
  assert.ok(long.length <= 4000)
  assert.ok(long.endsWith('\n…'))
  assert.ok(long.split('\n').slice(0, -1).every(l => l === '' || /^(Трекер, сводка на 2026-10-24|В работе: 60|p\d+: fixes|Дальше: x+)$/.test(l)), 'no line is cut in the middle')
})

const CARD = ['---', 'stage: fixes', 'next_step: "ship"', '---', '', '## Tasks', '', '- [ ] Ship it · due 2026-10-23 · p1 ^t-aaaa', ''].join('\n')

const post = (port, p) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, res => {
      let s = ''
      res.on('data', c => (s += c))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }))
    })
    req.on('error', reject)
    req.end('{}')
  })

test('the scheduled digest goes out once a local day after the set time, retries after a failure, and a manual send does not suppress it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-digest-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  fs.writeFileSync(path.join(projects, 'demo', 'demo.md'), CARD)
  let now = at('2026-10-24T06:30:00Z')
  const sent = []
  let fail = false
  const app = createApp({
    projectsRoot: projects,
    reposRoot: path.join(dir, 'repos'),
    dbFile: path.join(dir, 'db', 't.db'),
    port: 0,
    checkHealth: false,
    digestAt: '10:00',
    ...APP_RU,
    clock: () => now,
    sendDigest: async text => {
      if (fail) throw new Error('telegram down')
      sent.push(text)
    },
  })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const manual = await post(port, '/api/digest/send')
  assert.equal(manual.status, 200)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /demo: fixes\nДальше: ship/)
  assert.match(sent[0], /Ship it \(до 2026-10-23, просрочено\) p1/)

  await app.digestTick()
  assert.equal(sent.length, 1, 'not before 10:00 local')

  now = at('2026-10-24T07:01:00Z')
  fail = true
  const errors = []
  const log = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    await app.digestTick()
  } finally {
    console.error = log
  }
  assert.equal(sent.length, 1)
  assert.match(errors.join('\n'), /digest failed telegram down/)

  fail = false
  now = at('2026-10-24T07:05:00Z')
  await app.digestTick()
  assert.equal(sent.length, 1, 'waits 15 minutes after a failure')

  now = at('2026-10-24T07:17:00Z')
  await app.digestTick()
  assert.equal(sent.length, 2, 'the morning digest still goes out after a manual one')

  now = at('2026-10-24T12:00:00Z')
  await app.digestTick()
  assert.equal(sent.length, 2, 'once a day')

  now = at('2026-10-25T07:00:00Z')
  await app.digestTick()
  assert.equal(sent.length, 3, 'next day')
})

const quiet = async fn => {
  const log = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = log
  }
}

const tempProjects = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-digest-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'repos'))
  fs.writeFileSync(path.join(projects, 'demo', 'demo.md'), CARD)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const make = opts => createApp({ projectsRoot: projects, reposRoot: path.join(dir, 'repos'), dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, digestAt: '10:00', ...APP_RU, ...opts })
  return { projects, make }
}

test('a failing auto digest retries with growing waits, the wait survives a restart, and it stops after ten tries a day', async t => {
  const { make } = tempProjects(t)
  let now = at('2026-10-24T07:00:00Z')
  let calls = 0
  const opts = { clock: () => now, sendDigest: async () => (calls++, Promise.reject(new Error('down'))) }
  let app = make(opts)
  await quiet(async () => {
    await app.digestTick()
    now += 16 * 60e3
    await app.digestTick()
  })
  assert.equal(calls, 2, 'the first retry comes after 15 minutes')
  app.db.close()
  app = make(opts)
  await quiet(async () => {
    await app.digestTick()
    now += 16 * 60e3
    await app.digestTick()
    assert.equal(calls, 2, 'the second wait is 30 minutes, also after a restart')
    now += 16 * 60e3
    await app.digestTick()
    assert.equal(calls, 3)
    now += 61 * 60e3
    await app.digestTick()
    assert.equal(calls, 4, 'then an hour')
    for (let i = 0; i < 8; i++) {
      now += 121 * 60e3
      await app.digestTick()
    }
  })
  assert.equal(calls, 10, 'then every two hours, ten tries a day at most')
  now = at('2026-10-25T07:00:00Z')
  await quiet(() => app.digestTick())
  assert.equal(calls, 11, 'tries again the next day')
  app.db.close()
})

test('only one digest is sent at a time, and an unreadable project does not stop it', async t => {
  const { projects, make } = tempProjects(t)
  fs.mkdirSync(path.join(projects, 'demo', 'READINESS.md'))
  fs.mkdirSync(path.join(projects, 'broken', 'broken.md'), { recursive: true })
  let release
  const sent = []
  const app = make({
    clock: () => at('2026-10-24T07:00:00Z'),
    sendDigest: text => new Promise(r => (release = () => (sent.push(text), r()))),
  })
  const port = await app.start()
  try {
    const first = app.digestTick()
    const second = app.digestTick()
    await new Promise(r => setTimeout(r, 50))
    const manual = await post(port, '/api/digest/send')
    assert.equal(manual.status, 409)
    release()
    await Promise.all([first, second])
    assert.equal(sent.length, 1)
    assert.match(sent[0], /Карточки не читаются:\n- broken: EISDIR\n/)
    assert.match(sent[0], /demo: fixes\n/, 'a readiness path that is not a file is skipped')
  } finally {
    release?.()
    await app.stop()
  }
})
