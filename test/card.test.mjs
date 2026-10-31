import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFields, setField, readTasks, addTask, replaceTask, formatTask, validate, timelineRows, updateLines, lockedFields, toggleLine, writeKeepsYaml } from '../lib/card.mjs'
import { execFileSync } from 'node:child_process'
import { auditedCommit, repoOf, ogImage, freshness } from '../lib/repo.mjs'
import { createStore } from '../lib/store.mjs'
import { ignoreTest } from '../lib/config.mjs'

const CARD = [
  '---',
  'search: skip # historical',
  'title: demo',
  'status: offline since 2026-10-23 (stub)',
  'stage: done',
  'next_step: "Alex\'s check: say \\"go\\""',
  'spec_at: 2026-10-20T17:29',
  'accepted_at:',
  'tags:',
  '  - extract',
  '  - проект',
  '---',
  '',
  '# demo',
  '',
  '## Tasks',
  '',
  '- [ ] Real launch on mainnet · p1 ^t-4qm7',
  '- [x] Tests · due 2026-10-30 · p2 ^t-k2x9',
  '',
  '## Updates',
  '',
  'All flags off.',
  '',
  '- u1 agent · released 02:22 ^u-1',
  '',
  '## Timeline',
  '',
  '| Milestone | Time | Source | Accuracy |',
  '|---|---|---|---|',
  '| Spec received | 2026-10-20 17:29 | transcript | exact |',
  '',
  '## Program',
  '',
  'text',
  '',
].join('\n')

test('reads flat fields, quoted values, comments and lists', () => {
  const f = readFields(CARD)
  assert.equal(f.search, 'skip')
  assert.equal(f.next_step, 'Alex\'s check: say "go"')
  assert.equal(f.spec_at, '2026-10-20T17:29')
  assert.equal(f.accepted_at, '')
  assert.deepEqual(f.tags, ['extract', 'проект'])
})

test('setField changes one line only and keeps CRLF', () => {
  const crlf = CARD.replace(/\n/g, '\r\n')
  const out = setField(crlf, 'next_step', 'Ship: then rest')
  const a = crlf.split('\r\n')
  const b = out.split('\r\n')
  assert.equal(a.length, b.length)
  assert.deepEqual(b.filter((l, i) => l !== a[i]), ['next_step: "Ship: then rest"'])
  assert.equal(readFields(out).next_step, 'Ship: then rest')
  assert.ok(!out.replace(/\r\n/g, '').includes('\n'))
})

test('setField inserts a missing field at the end of the frontmatter and clears with an empty value', () => {
  const out = setField(CARD, 'site', 'https://example.app')
  const lines = out.split('\n')
  assert.equal(lines[lines.indexOf('  - проект') + 1], 'site: "https://example.app"')
  assert.equal(lines[lines.indexOf('  - проект') + 2], '---')
  assert.equal(readFields(setField(out, 'spec_at', '')).spec_at, '')
  assert.ok(setField(out, 'spec_at', '').includes('\nspec_at:\n'))
})

test('validate rejects bad values', () => {
  assert.match(validate('stage', 'shipped'), /stage must be/)
  assert.match(validate('spec_at', '2026-10-20 17:29'), /YYYY-MM-DDTHH:MM/)
  assert.match(validate('accepted_at', '20.10.2026'), /YYYY-MM-DD/)
  assert.match(validate('status', 'x'), /not editable/)
  assert.match(validate('next_step', 'a\nb'), /one line/)
  assert.equal(validate('accepted_at', ''), null)
  assert.equal(validate('site', 'https://launchpad.example.com'), null)
})

test('tasks parse, edit and add without touching other lines', () => {
  const tasks = readTasks(CARD)
  assert.deepEqual(tasks.map(t => [t.id, t.done, t.due, t.p]), [['t-4qm7', false, '', 'p1'], ['t-k2x9', true, '2026-10-30', 'p2']])
  const r = replaceTask(CARD, 't-4qm7', cur => formatTask({ ...cur, done: true }))
  assert.ok(r.text.includes('- [x] Real launch on mainnet · p1 ^t-4qm7'))
  assert.equal(r.text.split('\n').length, CARD.split('\n').length)
  const added = addTask(CARD, { id: 't-zzzz', text: 'New one', due: '', p: 'p3' })
  const lines = added.split('\n')
  assert.equal(lines[lines.indexOf('- [x] Tests · due 2026-10-30 · p2 ^t-k2x9') + 1], '- [ ] New one · p3 ^t-zzzz')
  assert.throws(() => formatTask({ id: 't-aaaa', text: 'bad ^ caret' }), /one line/)
})

test('addTask into a section that only has a note', () => {
  const card = CARD.replace(/- \[ \] Real.*\n- \[x\] Tests.*\n/, 'None open: offline.\n')
  const out = addTask(card, { id: 't-aaaa', text: 'Pay out', p: 'p2' })
  assert.match(out, /None open: offline\.\n\n- \[ \] Pay out · p2 \^t-aaaa\n/)
  assert.deepEqual(readTasks(out).map(t => t.id), ['t-aaaa'])
})

test('timeline rows and update lines', () => {
  assert.deepEqual(timelineRows(CARD), [['Spec received', '2026-10-20 17:29', 'transcript', 'exact']])
  assert.deepEqual(updateLines(CARD), [{ text: 'All flags off.', item: false, id: '' }, { text: 'u1 agent · released 02:22', item: true, id: 'u-1' }])
})

test('audited commit: field first, then HEAD, then a single commit mention', () => {
  assert.deepEqual(auditedCommit('---\naudit_commit: abc1234\n---\nHEAD `def5678`'), { sha: 'abc1234', source: 'audit_commit' })
  assert.deepEqual(auditedCommit('---\n---\nAudit on HEAD `def5678`'), { sha: 'def5678', source: 'HEAD in text' })
  assert.deepEqual(auditedCommit('---\n---\nкоммит `f17f98a`'), { sha: 'f17f98a', source: 'commit in text' })
  assert.equal(auditedCommit('---\n---\nmain `2d71e27` commit `053bbb9` commit `1111111`'), null)
  assert.equal(auditedCommit('---\n---\nmain `2d71e27`, commit `053bbb9`'), null)
})

const fm = body => `---\ntitle: x\nstatus: active\nstage: fixes\n${body}\n---\n\n# x\n`

test('multi-line, block and unbalanced values are refused, never half-rewritten', () => {
  const folded = fm('next_step: >-\n  folded\n  text')
  assert.throws(() => setField(folded, 'next_step', 'new'), /edit it in Obsidian/)
  assert.ok(lockedFields(folded).includes('next_step'))
  const continued = fm('next_step: "a long\n  continued"')
  assert.throws(() => setField(continued, 'next_step', 'new'), /edit it in Obsidian/)
  const unbalanced = fm('next_step: "open quote')
  assert.throws(() => setField(unbalanced, 'next_step', 'new'), /edit it in Obsidian/)
  const status = fm('accepted_by: x').replace('status: active', 'status: >-\n  long status')
  const out = setField(status, 'site', 'https://example.app')
  assert.deepEqual(readFields(out).site, 'https://example.app')
  assert.match(out, /status: >-\n  long status\n/)
})

test('values that continue after a blank line or with an unindented list are refused', () => {
  const blank = fm('next_step: foo\n\n  bar\nstage2: x')
  assert.throws(() => setField(blank, 'next_step', 'new'), /spans several lines/)
  const listed = fm('site:\n- a\n- b')
  assert.throws(() => setField(listed, 'site', 'https://x.com'), /spans several lines/)
  const fine = fm('next_step: foo\n\n# a comment\naccepted_by: x')
  assert.equal(readFields(setField(fine, 'next_step', 'new')).next_step, 'new')
})

test('Unicode line separators lock a field and keep a task visible', () => {
  const ls = String.fromCharCode(0x2028)
  const card = `${fm(`next_step: a${ls}b`)}\n## Tasks\n\n- [ ] one${ls}two ^t-cccc\n`
  assert.equal(readFields(card).next_step, `a${ls}b`)
  assert.ok(lockedFields(card).includes('next_step'))
  assert.throws(() => setField(card, 'next_step', 'x'), /edit it in Obsidian/)
  assert.deepEqual(readTasks(card).map(t => t.id), ['t-cccc'])
})

test('an empty value with a comment reads as empty and keeps the comment', () => {
  const card = fm('accepted_by: # fill later')
  assert.equal(readFields(card).accepted_by, '')
  assert.match(setField(card, 'accepted_by', 'Kirill'), /accepted_by: "Kirill" # fill later\n/)
})

test('duplicate keys and mixed line endings are refused', () => {
  assert.throws(() => setField(fm('next_step: a\nnext_step: b'), 'next_step', 'c'), /appears twice/)
  assert.throws(() => setField(fm('next_step: a').replace('title: x\n', 'title: x\r\n'), 'next_step', 'c'), /mixes line endings/)
})

test('comments survive an edit and quotes inside comments do not break reading', () => {
  const card = fm("accepted_by: 'Alex' # the client")
  assert.equal(readFields(card).accepted_by, 'Alex')
  const out = setField(card, 'accepted_by', 'Kirill')
  assert.match(out, /accepted_by: "Kirill" # the client\n/)
})

test('a quoted value that starts with a bracket or a brace does not lock the card', () => {
  const card = fm('next_step: "[WIP] call"\nsource: "[[Call]] notes"\nmeta: \'{draft\'')
  assert.deepEqual(lockedFields(card), [])
  const out = setField(card, 'next_step', 'ship')
  assert.match(out, /^next_step: "ship"$/m)
  assert.equal(readFields(out).source, '[[Call]] notes')
  assert.deepEqual(lockedFields(fm('aliases: [Bob\'s Shop, web]\nmeta: {owner: Bob\'s}\nsizes: [5" screen]')), [])
  assert.deepEqual(lockedFields(fm('note: >-\n  "quoted start\n  in folded\nlist:\n  - |\n    "open\n  - b')), [])
  assert.deepEqual(lockedFields(fm('description: This is a long\n  "quoted" phrase continues\n  [WIP] continues\n  \'90s style')), [])
  assert.deepEqual(lockedFields(fm('list:\n  - body: |\n      "open\n    other: fine\naliases: [&a Bob\'s, *a]\nnote: |2\n   text')), [])
  assert.deepEqual(lockedFields(fm('Due date: 2026-10-01')), [])
  assert.match(setField(fm('next_step: a\nDue date: 2026-10-01'), 'next_step', 'b'), /^next_step: b\nDue date: 2026-10-01$/m)
})

test('a seconds time goes into a plain text field quoted unless the old value was a plain seconds time', () => {
  assert.match(setField(fm('next_step: call'), 'next_step', '2026-10-22 09:00:00'), /^next_step: "2026-10-22 09:00:00"$/m)
  assert.match(setField(fm('next_step: call'), 'next_step', '2026-10-22T09:00:00'), /^next_step: "2026-10-22T09:00:00"$/m)
  assert.match(setField(fm('next_step: 2026-10-21 08:00:00'), 'next_step', '2026-10-22 09:00:00'), /^next_step: 2026-10-22 09:00:00$/m)
  assert.match(setField(fm('next_step: "2026-10-21 08:00:00"'), 'next_step', '2026-10-22 09:00:00'), /^next_step: "2026-10-22 09:00:00"$/m)
  assert.match(setField(fm('next_step: 2026-10-21 08:00:00.5'), 'next_step', '2026-10-22 09:00:00'), /^next_step: 2026-10-22 09:00:00$/m)
  assert.match(setField(fm('first_push_at: 2026-10-21T08:00:00.000Z'), 'first_push_at', '2026-10-22T09:00:00'), /^first_push_at: 2026-10-22T09:00:00$/m)
})

test('the YAML check refuses a write that changes another key, breaks the YAML or turns text into a date', () => {
  const before = fm('next_step: call\nnote: "a\n  b"')
  const write = v => before.replace('next_step: call', `next_step: ${v}`)
  assert.equal(writeKeepsYaml(before, write('ship'), 'next_step', 'ship'), true)
  assert.equal(writeKeepsYaml(before, before.replace('"a', '"z'), 'next_step', 'call'), false)
  assert.equal(writeKeepsYaml(before, write('"ship'), 'next_step', 'ship'), false)
  assert.equal(writeKeepsYaml(before, write('2026-10-22'), 'next_step', '2026-10-22'), false)
  assert.equal(writeKeepsYaml(before, write('2026-10-22'), 'next_step', '2026-10-22', true), true)
  assert.equal(writeKeepsYaml(before, write('2026-10-22 09:15:00'), 'next_step', '2026-10-22 09:15:00', true), true)
  assert.equal(writeKeepsYaml(before, write(''), 'next_step', ''), true)
  assert.equal(writeKeepsYaml(fm('next_step: 0'), fm('next_step: 1'), 'next_step', '1'), true)
  assert.equal(writeKeepsYaml(fm('next_step: x'), fm('next_step: 1'), 'next_step', '1'), false)
})

test('a number or boolean keeps its type when replaced by another one', () => {
  assert.match(setField(fm('next_step: 0'), 'next_step', '1'), /^next_step: 1$/m)
  assert.match(setField(fm('next_step: false'), 'next_step', 'true'), /^next_step: true$/m)
  assert.match(setField(fm('next_step: 0'), 'next_step', 'call'), /^next_step: call$/m)
  assert.match(setField(fm('next_step: false'), 'next_step', 'yes'), /^next_step: "yes"$/m)
  for (const typed of ['007', '0x10', '1_000', '+5', '1e3', '1.50']) assert.match(setField(fm('next_step: 0'), 'next_step', typed), new RegExp(`^next_step: "${typed.replace(/[+.]/g, '\\$&')}"$`, 'm'), `${typed} stays the text that was typed`)
  assert.match(setField(fm('next_step: false'), 'next_step', 'True'), /^next_step: "True"$/m)
  assert.equal(writeKeepsYaml(fm('next_step: 0'), fm('next_step: 007'), 'next_step', '007'), false)
})

test('keys that YAML reads as true, false or null do not lock the card', () => {
  assert.deepEqual(lockedFields(fm('True: yes\nNull: x\nFALSE: 1')), [])
  assert.match(setField(fm('True: yes\nnext_step: a'), 'next_step', 'b'), /^next_step: b$/m)
})

test('the YAML check is fast and safe on alias trees and cycles', () => {
  const levels = ['a0: &a0 [1, 1]', ...Array.from({ length: 11 }, (_, i) => `a${i + 1}: &a${i + 1} [*a${i}, *a${i}, *a${i}, *a${i}]`)]
  const tree = fm(`next_step: call\n${levels.join('\n')}`)
  const t0 = Date.now()
  assert.equal(writeKeepsYaml(tree, tree.replace('next_step: call', 'next_step: ship'), 'next_step', 'ship'), true)
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`)
  const loop = fm('next_step: call\nloop: &l [1, *l]')
  assert.equal(writeKeepsYaml(loop, loop.replace('next_step: call', 'next_step: ship'), 'next_step', 'ship'), true)
})

test('a date keeps the YAML type of the value it replaces', () => {
  assert.match(setField(fm('next_step: call'), 'next_step', '2026-10-22'), /^next_step: "2026-10-22"$/m)
  assert.match(setField(fm('next_step: 2026-10-21'), 'next_step', '2026-10-22'), /^next_step: 2026-10-22$/m)
  assert.match(setField(fm('handed_over_at: "2026-10-21"'), 'handed_over_at', '2026-10-22'), /^handed_over_at: "2026-10-22"$/m)
  assert.match(setField(fm('handed_over_at:'), 'handed_over_at', '2026-10-22'), /^handed_over_at: 2026-10-22$/m)
  assert.match(setField(fm('x: 1'), 'accepted_at', '2026-10-22'), /^accepted_at: 2026-10-22$/m)
})

test('BOM is kept and the frontmatter is still found', () => {
  const card = `﻿${fm('next_step: a')}`
  const out = setField(card, 'next_step', 'b')
  assert.ok(out.startsWith('﻿---'))
  assert.equal(readFields(out).next_step, 'b')
})

test('toggle flips only the checkbox; tasks without an id are read-only', () => {
  const line = '- [X] Pay · later  · p1 ^t-aaaa'
  assert.equal(toggleLine(line), '- [ ] Pay · later  · p1 ^t-aaaa')
  const card = `${fm('x: 1')}\n## Tasks\n\n- [ ] No id here\n- [ ] Pay · later ^t-bbbb\n`
  const tasks = readTasks(card)
  assert.deepEqual(tasks.map(t => [t.id, t.readonly ?? false, t.text]), [['', true, 'No id here'], ['t-bbbb', false, 'Pay · later']])
  assert.throws(() => replaceTask(card.replace('^t-bbbb', '^t-bbbb\n- [ ] Again ^t-bbbb'), 't-bbbb', toggleLine), /appears twice/)
})

test('site must be a public https domain; Unicode line separators are refused', () => {
  assert.match(validate('site', 'https://127.0.0.1'), /public domain/)
  assert.match(validate('site', 'https://localhost.local'), /public domain|site must be/)
  assert.match(validate('site', 'javascript:alert(1)'), /site must be/)
  assert.match(validate('site', 'https://0x7f.0.0.1'), /public domain/)
  assert.ok(validate('site', 'https://localhost.?.a'))
  assert.ok(validate('site', 'https://router.lan'))
  assert.equal(validate('site', 'https://shop.example.org/'), null)
  assert.match(validate('site', 'https://a.b@localhost'), /site must be|public domain/)
  assert.match(validate('next_step', 'a b'), /one line/)
})

test('ignored projects are never mapped to a repo, whatever the card says', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-repo-'))
  const ignored = ignoreTest(['secretapp', 'Frozen'])
  for (const d of ['secretapp', 'Frozen', 'frozen-v2', 'demo', 'other']) fs.mkdirSync(path.join(dir, d, '.git'), { recursive: true })
  assert.equal(repoOf(dir, 'frozen-v2', '', ignored), null)
  assert.equal(repoOf(dir, 'demo', `Repo: \`${path.join(dir, 'frozen-v2')}\``, ignored), path.join(dir, 'demo'))
  assert.equal(repoOf(dir, 'secretapp', '', ignored), null)
  assert.equal(repoOf(dir, 'Frozen rebuild', '', ignored), null)
  assert.equal(repoOf(dir, 'demo', `Repo: \`${path.join(dir, 'secretapp')}\``, ignored), path.join(dir, 'demo'))
  assert.equal(repoOf(dir, 'demo', '---\nrepo: "secretapp"\n---\n', ignored), path.join(dir, 'demo'))
  assert.equal(repoOf(dir, 'demo', '', ignored), path.join(dir, 'demo'))
  assert.equal(repoOf(dir, 'secretapp', ''), path.join(dir, 'secretapp'), 'nothing is ignored by default')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a repo comes from the repo field first, then a Repo line with an absolute path, then the folder name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-repo-'))
  for (const d of ['demo', 'other', 'third']) fs.mkdirSync(path.join(dir, d, '.git'), { recursive: true })
  assert.equal(repoOf(dir, 'demo', '---\nrepo: "other"\n---\n'), path.join(dir, 'other'))
  assert.equal(repoOf(dir, 'demo', `---\nrepo: "${path.join(dir, 'third').replace(/\\/g, '\\\\')}"\n---\n`), path.join(dir, 'third'))
  assert.equal(repoOf(dir, 'demo', '---\nrepo: "missing"\n---\n'), path.join(dir, 'demo'))
  assert.equal(repoOf(dir, 'demo', `Repo: \`${path.join(dir, 'other')}\``), path.join(dir, 'other'))
  assert.equal(repoOf(path.join(dir, 'nope'), 'demo', ''), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('audit freshness flags commits after the audit, a HEAD rolled back behind it, and untracked files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-fresh-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
  try {
    g('init', '--quiet', '-b', 'main')
    g('config', 'user.name', 'test')
    g('config', 'user.email', 'test@example.com')
    const commit = n => {
      fs.writeFileSync(path.join(dir, 'f.txt'), `${n}\n`)
      g('add', '.')
      g('commit', '--quiet', '-m', `c${n}`)
      return g('rev-parse', '--short=7', 'HEAD')
    }
    const a = commit(1)
    const b = commit(2)
    assert.equal((await freshness(dir, b)).state, 'current')
    commit(3)
    assert.deepEqual([(await freshness(dir, b)).state, (await freshness(dir, b)).sinceLocal], ['changed-after', 1])
    g('reset', '--quiet', '--hard', a)
    const back = await freshness(dir, b)
    assert.deepEqual([back.state, back.behindAudit], ['changed-after', 1])
    g('reset', '--quiet', '--hard', b)
    fs.writeFileSync(path.join(dir, 'new-source.js'), 'x')
    const untracked = await freshness(dir, b)
    assert.deepEqual([untracked.state, untracked.dirty], ['changed-after', 1])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('og image: public folders up to two levels deep, plain og.* first, never node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-og-'))
  const put = rel => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), 'x')
  }
  assert.equal(ogImage(dir), null)
  put('node_modules/pkg/public/og.png')
  put('packages/web/public/logo.png')
  assert.equal(ogImage(dir), null)
  put('packages/web/public/og-demo.png')
  assert.equal(ogImage(dir), path.join(dir, 'packages', 'web', 'public', 'og-demo.png'))
  put('packages/web/public/og.jpg')
  assert.equal(ogImage(dir), path.join(dir, 'packages', 'web', 'public', 'og.jpg'))
  assert.equal(ogImage(null), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('store lists a fresh build card that has only the project header as development', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-store-'))
  fs.mkdirSync(path.join(dir, 'fresh'))
  fs.mkdirSync(path.join(dir, 'note'))
  fs.writeFileSync(path.join(dir, 'fresh', 'fresh.md'), '---\nproject: fresh\npipeline_revision: 2026-10-21\n---\n\n# fresh\n')
  fs.writeFileSync(path.join(dir, 'note', 'note.md'), '---\ntitle: note\n---\n\n# note\n')
  const store = createStore(dir)
  assert.deepEqual(store.list().map(c => [c.name, c.fields.stage]), [['fresh', 'development']])
  assert.equal(store.saveField('fresh', 'stage', 'review', 'development').fields.stage, 'review')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('store refuses a write that would change anything but the field, and skips broken folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-store-'))
  fs.mkdirSync(path.join(dir, 'demo'))
  fs.mkdirSync(path.join(dir, 'Проект (старый)'))
  fs.mkdirSync(path.join(dir, 'bad'))
  fs.writeFileSync(path.join(dir, 'demo', 'demo.md'), fm('next_step: >-\n  folded'))
  fs.writeFileSync(path.join(dir, 'Проект (старый)', 'Проект (старый).md'), fm('next_step: a'))
  const store = createStore(dir)
  assert.deepEqual(store.list().map(c => c.name).sort(), ['demo', 'Проект (старый)'].sort())
  assert.throws(() => store.saveField('demo', 'next_step', 'x', '>-'), /edit it in Obsidian/)
  assert.equal(store.saveField('Проект (старый)', 'next_step', 'b', 'a').fields.next_step, 'b')
  fs.rmSync(dir, { recursive: true, force: true })
})
