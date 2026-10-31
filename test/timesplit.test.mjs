import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { sessionIntervals, agentInterval, split, transcriptDirs, encodeDir, projectSplit, cardTime, isHuman, fileIntervals, createTimeCache } from '../lib/timesplit.mjs'
import { ignoreTest } from '../lib/config.mjs'
import { createApp } from '../server.mjs'

const T0 = Date.parse('2026-10-20T10:00:00Z')
const at = min => new Date(T0 + min * 60e3).toISOString()
const L = o => JSON.stringify(o)
const human = (min, text = 'go') => L({ type: 'user', timestamp: at(min), origin: { kind: 'human' }, message: { content: text } })
const legacyHuman = (min, text = 'go') => L({ type: 'user', timestamp: at(min), message: { content: text } })
const notify = (min, text) => L({ type: 'user', timestamp: at(min), origin: { kind: 'task-notification' }, message: { content: text } })
const asst = (min, content = [{ type: 'text', text: 'ok' }]) => L({ type: 'assistant', timestamp: at(min), message: { content } })
const result = (min, id, extra = {}) => L({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }, ...extra })
const codexUse = (min, id, bg = false) => asst(min, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'codex exec -p review --sandbox read-only -o x.md "brief"', run_in_background: bg } }])
const min = ms => ms / 60e3

test('a session is work while Claude acts, waiting until the human writes, and nothing across a gap over 3 hours', async () => {
  const iv = await sessionIntervals([
    human(0),
    asst(1),
    result(2, 'a'),
    asst(10),
    human(40, 'next'),
    asst(41),
    L({ type: 'assistant', timestamp: at(45), isSidechain: true, message: { content: [] } }),
    legacyHuman(300),
    asst(305),
    notify(320, '<task-notification><task-id>zzz</task-id></task-notification>'),
    asst(321),
    'not json',
    L({ type: 'user', timestamp: at(330), isMeta: true, message: { content: 'meta' } }),
  ])
  assert.deepEqual(iv.map(([s, e, k]) => [min(s - T0), min(e - T0), k]), [
    [0, 330, 'c'],
    [0, 10, 'w'],
    [10, 40, 'q'],
    [40, 41, 'w'],
    [300, 330, 'w'],
  ])
})

test('Codex runs count as review, in the foreground and in the background until their notification', async () => {
  const iv = await sessionIntervals([
    human(0),
    codexUse(1, 'c1'),
    result(9, 'c1'),
    codexUse(10, 'c2', true),
    result(10, 'c2', { toolUseResult: { backgroundTaskId: 'bg42' } }),
    asst(11),
    notify(30, 'done <task-id>bg42</task-id>'),
    asst(31),
  ])
  const review = iv.filter(x => x[2] === 'r').map(([s, e]) => [min(s - T0), min(e - T0)])
  assert.deepEqual(review, [[1, 9], [10, 30]])
})

test('human messages are told from notifications, commands, summaries and tool results', () => {
  assert.equal(isHuman({ origin: { kind: 'human' }, message: { content: '<pasted_content>x</pasted_content>' } }), true)
  assert.equal(isHuman({ origin: { kind: 'task-notification' }, message: { content: 'x' } }), false)
  assert.equal(isHuman({ message: { content: 'plain words' } }), true)
  assert.equal(isHuman({ message: { content: '<command-name>/compact</command-name>' } }), false)
  assert.equal(isHuman({ isCompactSummary: true, message: { content: 'summary' } }), false)
  assert.equal(isHuman({ message: { content: 'This session is being continued from a previous conversation' } }), false)
  assert.equal(isHuman({ message: { content: [{ type: 'image' }] } }), true)
  assert.equal(isHuman({ message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }), false)
})

test('reviewer subagents count as review, other agents as work, split at gaps over 3 hours', async () => {
  const lines = [L({ timestamp: at(5) }), 'garbage', L({ timestamp: at(25) })]
  assert.deepEqual((await agentInterval(lines, 'code-reviewer')).map(x => x[2]), ['r'])
  assert.deepEqual((await agentInterval(lines, 'general-purpose')).map(x => [min(x[0] - T0), min(x[1] - T0), x[2]]), [[5, 25, 'w']])
  assert.deepEqual((await agentInterval(lines, 'my-auditor', new Set(['my-auditor']))).map(x => x[2]), ['r'])
  assert.deepEqual((await agentInterval(lines, 'code-reviewer', new Set(['my-auditor']))).map(x => x[2]), ['w'])
  assert.deepEqual(await agentInterval([L({ timestamp: at(5) })], 'code-reviewer'), [])
  const night = [at(0), at(20), at(600), at(630)].map(t => L({ timestamp: t }))
  assert.deepEqual((await agentInterval(night, 'code-reviewer')).map(x => [min(x[0] - T0), min(x[1] - T0)]), [[0, 20], [600, 630]])
})

test('a Codex run longer than 3 hours, a PowerShell Codex run and a huge human line are handled', async () => {
  const ps = asst(1, [{ type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'codex exec -p review x' } }])
  const huge = L({ type: 'user', timestamp: at(400), origin: { kind: 'human' }, message: { content: [{ type: 'image', source: { data: 'A'.repeat(300e3) } }] } })
  const iv = await sessionIntervals([
    human(0),
    ps,
    result(5, 'p1'),
    codexUse(10, 'c2', true),
    result(10, 'c2', { toolUseResult: { backgroundTaskId: 'late' } }),
    asst(11),
    notify(300, '<task-id>late</task-id>'),
    asst(301),
    huge,
    asst(401),
  ])
  assert.deepEqual(iv.filter(x => x[2] === 'r').map(([s, e]) => [min(s - T0), min(e - T0)]), [[1, 5]])
  assert.deepEqual(iv.filter(x => x[2] === 'q').map(([s, e]) => [min(s - T0), min(e - T0)]), [[301, 400]])
})

test('a missing transcript fails the read instead of hanging, and the cache reuses unchanged files once at a time', async t => {
  await assert.rejects(fileIntervals({ kind: 'session', file: path.join(os.tmpdir(), 'no-such-transcript.jsonl') }))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = 'D:\\r\\demo'
  const d = path.join(root, encodeDir(repo))
  fs.mkdirSync(d)
  const f = path.join(d, 's.jsonl')
  fs.writeFileSync(f, [human(0), asst(10)].join('\n'))
  const cache = createTimeCache()
  const [a, b] = [cache.collect(root, repo), cache.collect(root, repo)]
  assert.equal(a, b, 'one scan in flight per repo')
  assert.equal((await a).intervals.length, 2)
  fs.appendFileSync(f, `\n${asst(20)}`)
  const again = await cache.collect(root, repo)
  assert.equal(Math.max(...again.intervals.map(x => x[1])), T0 + 20 * 60e3, 'a grown file is read again')
  fs.rmSync(f)
  assert.equal((await cache.collect(root, repo)).intervals.length, 0)

  const long = path.join(d, 'long.jsonl')
  const big = L({ type: 'user', timestamp: at(30), origin: { kind: 'human' }, message: { content: [{ type: 'image', source: { data: 'A'.repeat(2e6) } }] } })
  fs.writeFileSync(long, [asst(29), big, asst(31)].join('\r\n'))
  const lines = (await cache.collect(root, repo)).intervals.filter(x => x[2] !== 'c').map(([s, e, k]) => [min(s - T0), min(e - T0), k])
  assert.deepEqual(lines, [[29, 30, 'q'], [30, 31, 'w']], 'a 2 MB line spanning many chunks is read whole, with CRLF endings')
})

test('split: review beats work beats waiting, clipped to the window; a pause needs a transcript, the rest is missing', () => {
  const ms = m => T0 + m * 60e3
  const s = split([[ms(0), ms(160), 'c'], [ms(0), ms(60), 'w'], [ms(30), ms(90), 'r'], [ms(80), ms(120), 'q'], [ms(200), ms(400), 'w']], ms(10), ms(240))
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? min(v) : v])), { review: 60, work: 60, waiting: 30, pause: 40, missing: 40, total: 230, hasData: true })
  assert.equal(split([], ms(0), ms(10)).hasData, false)
  assert.equal(split([[ms(0), ms(5), 'w']], ms(10), ms(20)).hasData, false)
})

test('card times follow the configured UTC offset and phases need both ends', () => {
  assert.equal(cardTime('2026-10-20T13:00', 180), T0)
  assert.equal(cardTime('2026-10-20T10:00'), T0)
  assert.equal(cardTime('2026-10-20T05:00', -300), T0)
  assert.equal(cardTime('2026-10-20', 180), null)
  assert.equal(cardTime('2026-13-45T25:00', 180), null)
  const p = projectSplit([], { spec_at: '2026-10-20T13:00', first_push_at: '2026-10-20T15:00' }, 180)
  assert.deepEqual(Object.keys(p), ['toFirstPush'])
  assert.equal(p.toFirstPush.total, 2 * 3600e3)
})

test('transcript folders: the repo and its worktrees, never a longer name or an ignored project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-tr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = 'D:\\Users\\X Y\\repos\\plat'
  const enc = encodeDir(repo)
  assert.equal(enc, 'D--Users-X-Y-repos-plat')
  for (const d of [enc, `${enc}--claude-worktrees-brave-x`, `${enc}-wt-upd`, `${enc}form`, `${enc}-other`, 'D--Users-X-Y-repos-private-app']) fs.mkdirSync(path.join(root, d))
  assert.deepEqual(transcriptDirs(root, repo).map(d => path.basename(d)).sort(), [enc, `${enc}--claude-worktrees-brave-x`, `${enc}-wt-upd`].sort())
  assert.equal(transcriptDirs(root, 'D:\\Users\\X Y\\repos\\private-app').length, 1)
  assert.deepEqual(transcriptDirs(root, 'D:\\Users\\X Y\\repos\\private-app', ignoreTest(['PRIVATE'])), [])
  assert.deepEqual(transcriptDirs(root, null), [])
})

test('the server collects transcripts per project and shows the split without any message text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-time-'))
  const projects = path.join(dir, 'projects')
  const repos = path.join(dir, 'repos')
  const transcripts = path.join(dir, 'transcripts')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(repos, 'demo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'demo', 'demo.md'), ['---', 'stage: done', 'spec_at: 2026-10-20T13:00', 'first_push_at: 2026-10-20T15:00', '---', ''].join('\n'))
  const sdir = path.join(transcripts, encodeDir(path.join(repos, 'demo')))
  fs.mkdirSync(path.join(sdir, 'sess', 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(sdir, 'sess.jsonl'), [human(0, 'SECRET-KEY-123'), asst(30), human(60), asst(90)].join('\n'))
  fs.writeFileSync(path.join(sdir, 'sess', 'subagents', 'agent-1.jsonl'), [L({ timestamp: at(90) }), L({ timestamp: at(100) })].join('\n'))
  fs.writeFileSync(path.join(sdir, 'sess', 'subagents', 'agent-1.meta.json'), L({ agentType: 'code-reviewer' }))
  const app = createApp({ projectsRoot: projects, reposRoot: repos, dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, transcriptsRoot: transcripts, utcOffset: 180 })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await app.timeTick()
  const body = await new Promise((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/api/projects/demo', headers: { host: `127.0.0.1:${port}` } }, res => {
      let s = ''
      res.on('data', c => (s += c))
      res.on('end', () => resolve(s))
    }).on('error', reject))
  assert.ok(!body.includes('SECRET-KEY-123'))
  const ts = JSON.parse(body).timeSplit
  assert.equal(ts.sessions, 1)
  assert.equal(ts.agents, 1)
  const p = ts.phases.toFirstPush
  assert.deepEqual([p.work, p.waiting, p.review, p.pause, p.missing].map(min), [60, 30, 10, 0, 20])
})

test('build time survives a deleted transcript and a restart, without any message text in the database', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-keep-'))
  const projects = path.join(dir, 'projects')
  const repos = path.join(dir, 'repos')
  const transcripts = path.join(dir, 'transcripts')
  const dbFile = path.join(dir, 'db', 't.db')
  fs.mkdirSync(path.join(projects, 'demo'), { recursive: true })
  fs.mkdirSync(path.join(repos, 'demo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'demo', 'demo.md'), ['---', 'stage: done', 'spec_at: 2026-10-20T13:00', 'first_push_at: 2026-10-20T15:00', '---', ''].join('\n'))
  const sdir = path.join(transcripts, encodeDir(path.join(repos, 'demo')))
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, 'sess.jsonl'), [human(0, 'SECRET-KEY-123'), asst(30), human(60), asst(90)].join('\n'))
  let app = null
  t.after(async () => {
    await app?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const split = async () => {
    app = createApp({ projectsRoot: projects, reposRoot: repos, dbFile, port: 0, checkHealth: false, transcriptsRoot: transcripts, utcOffset: 180 })
    const port = await app.start()
    await app.timeTick()
    const body = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/api/projects/demo', headers: { host: `127.0.0.1:${port}` } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve(JSON.parse(s).timeSplit))
      }).on('error', reject))
    await app.stop()
    app = null
    return body
  }
  const before = await split()
  assert.equal(before.phases.toFirstPush.work, 60 * 60e3)
  assert.deepEqual([before.kept, before.lost], [0, 0])
  fs.rmSync(path.join(sdir, 'sess.jsonl'))
  fs.writeFileSync(path.join(sdir, 'sess.desktop-released.json'), L({ v: 1, releasedAt: at(200), reason: 'delete' }))
  fs.writeFileSync(path.join(sdir, 'gone.desktop-released.json'), L({ v: 1, releasedAt: at(200), reason: 'delete' }))
  const after = await split()
  assert.deepEqual(after.phases, before.phases, 'the deleted transcript still counts after a restart')
  assert.deepEqual([after.sessions, after.kept, after.lost], [1, 1, 1], 'one kept, one deleted before Projium read it')
  assert.ok(!fs.readFileSync(dbFile).includes('SECRET-KEY-123'), 'only times and kinds are stored')
})
