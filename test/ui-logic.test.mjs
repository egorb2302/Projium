import test from 'node:test'
import assert from 'node:assert/strict'
import { todayIn, taskState, sortTasks, topTask, signalData, targetState, watchSummary, isActive, inFilter, defaultFilter } from '../public/logic.js'

const NOW = Date.UTC(2026, 10, 1, 9, 0)
const task = (id, extra = {}) => ({ id, done: false, text: id, due: '', p: '', ...extra })
const project = (extra = {}) => ({ zone: '+03:00', ignored: false, fields: { stage: 'development' }, tasks: [], health: null, repoInfo: null, ...extra })

test('today follows the owner zone, negative offsets and day boundaries included', () => {
  assert.equal(todayIn('+03:00', NOW), '2026-11-01')
  assert.equal(todayIn('-10:00', NOW), '2026-10-31')
  assert.equal(todayIn('+14:00', Date.UTC(2026, 10, 1, 12, 0)), '2026-11-02')
  assert.equal(todayIn('-05:30', Date.UTC(2026, 10, 1, 5, 29)), '2026-10-31')
})

test('a task is overdue before today and due soon from today to two days ahead', () => {
  const today = '2026-11-01'
  assert.equal(taskState(task('a', { due: '2026-10-31' }), today), 'over')
  assert.equal(taskState(task('a', { due: '2026-11-01' }), today), 'soon')
  assert.equal(taskState(task('a', { due: '2026-11-03' }), today), 'soon')
  assert.equal(taskState(task('a', { due: '2026-11-04' }), today), '')
  assert.equal(taskState(task('a', { due: '2026-10-01', done: true }), today), '')
  assert.equal(taskState(task('a'), today), '')
})

test('tasks sort by overdue, then priority, then due date, undated last', () => {
  const today = '2026-11-01'
  const list = [
    task('p2-late', { p: 'p2', due: '2026-11-20' }),
    task('none'),
    task('p1', { p: 'p1' }),
    task('p3-over', { p: 'p3', due: '2026-10-30' }),
    task('p2-early', { p: 'p2', due: '2026-11-05' }),
    task('p2-undated', { p: 'p2' }),
  ]
  assert.deepEqual(sortTasks(list, today).map(x => x.id), ['p3-over', 'p1', 'p2-early', 'p2-late', 'p2-undated', 'none'])
})

test('the most urgent task is the first one that is overdue, due soon or p1, not just the first in order', () => {
  const p = project({ tasks: [task('p2-undated', { p: 'p2' }), task('p3-tomorrow', { p: 'p3', due: '2026-11-02' })] })
  assert.equal(topTask(p, NOW)?.id, 'p3-tomorrow')
  assert.equal(topTask(project({ tasks: [task('p2', { p: 'p2' })] }), NOW), null)
})

test('signals: ignored projects get none; p1, a down site and a stale audit only while the project is in work', () => {
  const tasks = [task('over', { due: '2026-10-20' }), task('p1', { p: 'p1' }), task('soon', { due: '2026-11-02' })]
  const health = { last: { code: 503 }, down: true }
  const repoInfo = { freshness: { state: 'changed-after', sinceLocal: 4, sinceOrigin: 2 } }
  const live = signalData(project({ tasks, health, repoInfo, fields: { stage: 'fixes', site: 'https://a.example' } }), NOW)
  assert.deepEqual(live.map(s => [s.kind, s.n]), [['down', 1], ['over', 1], ['p1', 1], ['soon', 1], ['stale', 4]])
  const done = signalData(project({ tasks, health, repoInfo, fields: { stage: 'done', site: 'https://a.example' } }), NOW)
  assert.deepEqual(done.map(s => s.kind), ['over', 'soon'])
  assert.deepEqual(signalData(project({ tasks, ignored: true }), NOW), [])
  const up = signalData(project({ health: { last: { code: 200 } }, fields: { stage: 'fixes', site: 'https://a.example' } }), NOW)
  assert.deepEqual(up, [])
})

test('one failed check is not a down site: down needs the server flag set after two failed checks in a row', () => {
  const once = signalData(project({ health: { last: { code: null, error: 'ABORT_ERR' }, down: false }, fields: { stage: 'fixes', site: 'https://a.example' } }), NOW)
  assert.deepEqual(once, [])
  const twice = signalData(project({ health: { last: { code: null, error: 'ABORT_ERR' }, down: true }, fields: { stage: 'fixes', site: 'https://a.example' } }), NOW)
  assert.deepEqual(twice.map(s => s.kind), ['down'])
})

test('a project deadline shows while the project is in progress: passed is bad, the next two days are a warning', () => {
  const at = deadline => signalData(project({ fields: { stage: 'review', deadline } }), NOW).map(s => [s.kind, s.tone, s.n])
  assert.deepEqual(at('2026-10-25'), [['deadline', 'bad', -7]])
  assert.deepEqual(at('2026-11-01'), [['deadline', 'warn', 0]])
  assert.deepEqual(at('2026-11-03'), [['deadline', 'warn', 2]])
  assert.deepEqual(at('2026-11-04'), [])
  assert.deepEqual(at('soon'), [])
  assert.deepEqual(signalData(project({ fields: { stage: 'done', deadline: '2026-10-25' } }), NOW), [])
})

test('closed projects raise no signals at all and sit under their own filter, outside In progress', () => {
  const tasks = [task('over', { due: '2026-10-20' }), task('p1', { p: 'p1' })]
  const closed = project({ tasks, health: { last: { code: 503 }, down: true }, watch: { open: 3, targets: 4 }, fields: { stage: 'closed', site: 'https://a.example' } })
  assert.deepEqual(signalData(closed, NOW), [])
  const dev = project({ fields: { stage: 'development' } })
  const done = project({ fields: { stage: 'done' } })
  assert.deepEqual([dev, done, closed].map(isActive), [true, false, false])
  assert.deepEqual(['open', 'done', 'closed', 'all'].map(f => [dev, done, closed].filter(p => inFilter(p, f)).length), [1, 1, 1, 3])
  assert.equal(defaultFilter([done, closed]), 'all')
  assert.equal(defaultFilter([done, dev]), 'open')
})

test('an open watch incident is a signal at any stage, ahead of the rest; targets read as open, ok, unknown or not checked yet', () => {
  const done = signalData(project({ fields: { stage: 'done' }, watch: { open: 2, targets: 3 } }), NOW)
  assert.deepEqual(done.map(s => [s.kind, s.tone, s.n, s.w]), [['incident', 'bad', 2, 200]])
  assert.deepEqual(signalData(project({ fields: { stage: 'done' }, watch: { open: 0, targets: 3 } }), NOW), [])
  const sig = (status, result) => ({ status, result })
  const targets = [
    { signals: [sig('ok', 'ok'), sig('open', 'fail')], mutedUntil: NOW + 60e3 },
    { signals: [sig('ok', 'ok'), sig('ok', 'skip')], mutedUntil: NOW - 60e3 },
    { signals: [sig('ok', 'skip')], mutedUntil: null },
    { signals: [sig('ok', null)], mutedUntil: null },
    { signals: [sig('ok', 'fail')], mutedUntil: null },
    { signals: [sig('ok', null)], mutedUntil: null, paused: true },
  ]
  assert.deepEqual(targets.map(targetState), ['open', 'ok', 'skip', 'wait', 'ok', 'paused'])
  assert.deepEqual(watchSummary(targets, NOW), { ok: 2, open: 1, wait: 1, skip: 1, muted: 1, paused: 1 })
})
