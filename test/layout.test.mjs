import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createStore, Conflict } from '../lib/store.mjs'
import { cardsConfig, loadConfig } from '../lib/config.mjs'
import { createApp } from '../server.mjs'
import { survey } from '../lib/survey.mjs'
import { diagnose } from '../lib/doctor.mjs'
import { fileURLToPath } from 'node:url'

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-layout-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const ACME = `---
type: client-project
tags: [project, client]
status: in progress
client: Acme
started: 2026-10-20 09:30
first_deploy: 2026-10-22
next: "checkout page"
---

# Acme Shop

Body text that must never change.

## Todo

- [ ] Checkout page
- [x] Product grid · p2 ^t-ab12
`

const OWNER = {
  layout: 'flat',
  filter: { type: 'client-project' },
  fields: { stage: 'status', spec_at: 'started', first_push_at: 'first_deploy', next_step: 'next' },
  stages: { 'in progress': 'development', 'waiting for client review': 'review', shipped: 'done' },
  sections: { tasks: 'Todo' },
}

const diffLines = (a, b) => {
  const x = a.split('\n')
  const y = b.split('\n')
  return y.filter((l, i) => l !== x[i]).length + Math.abs(x.length - y.length)
}

test('flat layout reads one note per project, filtered by frontmatter, with mapped fields and owner words', t => {
  const dir = temp(t)
  put(path.join(dir, 'Acme Shop.md'), ACME)
  put(path.join(dir, 'Nebula Wallet.md'), '---\ntype: client-project\nstatus: Waiting for client review\nstarted: 2026-10-27\n---\n')
  put(path.join(dir, 'Inbox.md'), '# Inbox\n\n- call\n')
  put(path.join(dir, 'Old.md'), '---\ntype: client-project\nstatus: shipped\n---\n')
  put(path.join(dir, 'Odd.md'), '---\ntype: client-project\nstatus: paused for now\n---\n')
  const store = createStore(dir, OWNER)
  const cards = Object.fromEntries(store.list().map(c => [c.name, c]))
  assert.deepEqual(Object.keys(cards).sort(), ['Acme Shop', 'Nebula Wallet', 'Odd', 'Old'])
  assert.equal(store.scan().filteredOut, 1)
  const acme = cards['Acme Shop']
  assert.equal(acme.fields.stage, 'development')
  assert.equal(acme.fields.status, 'in progress', 'the owner wording stays visible as status')
  assert.equal(acme.fields.spec_at, '2026-10-20T09:30')
  assert.equal(acme.fields.first_push_at, '2026-10-22T00:00')
  assert.equal(acme.fields.next_step, 'checkout page')
  assert.deepEqual(acme.fieldKeys, { stage: 'status', spec_at: 'started', first_push_at: 'first_deploy', next_step: 'next' })
  assert.deepEqual(acme.tasks.map(x => [x.text, x.readonly ?? false]), [['Checkout page', true], ['Product grid', false]])
  assert.equal(cards['Nebula Wallet'].fields.stage, 'review', 'owner words match case-insensitively')
  assert.equal(cards.Old.fields.stage, 'done')
  assert.equal(cards.Odd.fields.stage, 'paused for now', 'an unmapped owner word is shown as is')
  assert.equal(acme.readinessFile, null, 'flat layout has no shared readiness file unless the name has {name}')
  assert.equal(createStore(dir, { ...OWNER, readinessFile: '{name} readiness.md' }).load('Acme Shop').readinessFile, path.join(dir, 'Acme Shop readiness.md'))
})

test('a filtered note without a stage counts as development; without a filter it needs one', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\ntags:\n  - project\n---\n')
  put(path.join(dir, 'B.md'), '---\ntags: [#project]\n---\n')
  put(path.join(dir, 'C.md'), '---\ntags: [idea]\n---\n')
  const filtered = createStore(dir, { layout: 'flat', filter: { tags: 'project' } })
  assert.deepEqual(filtered.list().map(c => [c.name, c.fields.stage]).sort(), [['A', 'development'], ['B', 'development']])
  assert.deepEqual(createStore(dir, { layout: 'flat' }).list(), [])
})

test('recursive flat layout skips hidden folders, node_modules and links, and names duplicates by path', t => {
  const dir = temp(t)
  put(path.join(dir, 'Clients', 'Acme', 'Notes.md'), '---\nstage: fixes\n---\n')
  put(path.join(dir, 'Clients', 'Beta', 'Notes.md'), '---\nstage: review\n---\n')
  put(path.join(dir, 'Clients', 'Beta', 'Beta.md'), '---\nstage: done\n---\n')
  put(path.join(dir, '.obsidian', 'Hidden.md'), '---\nstage: fixes\n---\n')
  put(path.join(dir, 'node_modules', 'x', 'Pkg.md'), '---\nstage: fixes\n---\n')
  put(path.join(dir, '..', `${path.basename(dir)}-outside`, 'Leak.md'), '---\nstage: fixes\n---\n')
  t.after(() => fs.rmSync(path.join(dir, '..', `${path.basename(dir)}-outside`), { recursive: true, force: true }))
  fs.symlinkSync(path.join(dir, '..', `${path.basename(dir)}-outside`), path.join(dir, 'linked'), 'junction')
  const store = createStore(dir, { layout: 'flat', recursive: true })
  assert.deepEqual(store.list().map(c => c.name).sort(), ['Beta', 'Clients/Acme/Notes', 'Clients/Beta/Notes'])
  assert.equal(store.load('Clients/Acme/Notes').fields.stage, 'fixes')
  assert.throws(() => store.load('Leak'), /no card for Leak/)
  assert.throws(() => store.load('../x'), /no card/)
  assert.deepEqual(createStore(dir, { layout: 'flat' }).list(), [], 'without recursive only the top folder is read')
})

test('writing a mapped field changes exactly that line, in the owner key and wording', t => {
  const dir = temp(t)
  const file = path.join(dir, 'Acme Shop.md')
  put(file, ACME)
  const store = createStore(dir, OWNER)

  const reviewed = store.saveField('Acme Shop', 'stage', 'review', 'development')
  assert.equal(reviewed.fields.stage, 'review')
  let text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^status: waiting for client review$/m, 'owner wording, unquoted like before')
  assert.doesNotMatch(text, /^stage:/m, 'no Projium key is added')
  assert.equal(diffLines(ACME, text), 1)

  store.saveField('Acme Shop', 'stage', 'fixes', 'review')
  assert.match(fs.readFileSync(file, 'utf8'), /^status: fixes$/m, 'a stage with no owner word is written as the Projium word')

  store.saveField('Acme Shop', 'spec_at', '2026-10-21T10:15', '2026-10-20T09:30')
  assert.match(fs.readFileSync(file, 'utf8'), /^started: 2026-10-21 10:15$/m, 'the owner time format is kept')
  store.saveField('Acme Shop', 'first_push_at', '2026-10-23T00:00', '2026-10-22T00:00')
  assert.match(fs.readFileSync(file, 'utf8'), /^first_deploy: 2026-10-23$/m, 'a date-only field stays date-only at midnight')
  store.saveField('Acme Shop', 'first_push_at', '2026-10-23T18:40', '2026-10-23T00:00')
  assert.match(fs.readFileSync(file, 'utf8'), /^first_deploy: 2026-10-23T18:40$/m)
  store.saveField('Acme Shop', 'next_step', 'ship the cart', 'checkout page')
  assert.match(fs.readFileSync(file, 'utf8'), /^next: "ship the cart"$/m, 'a quoted value stays quoted')

  text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('Body text that must never change.\n\n## Todo\n\n- [ ] Checkout page\n'), 'the body is untouched')
  assert.equal(text.split('\n').length, ACME.split('\n').length)

  fs.writeFileSync(file, text.replace('status: fixes', 'status: shipped'))
  assert.throws(() => store.saveField('Acme Shop', 'stage', 'review', 'fixes'), e => e instanceof Conflict && e.current === 'done')
  assert.match(fs.readFileSync(file, 'utf8'), /^status: shipped$/m, 'a conflicting write changes nothing')
})

test('tasks go to the owner heading, and an unmapped field can still be added', t => {
  const dir = temp(t)
  const file = path.join(dir, 'Acme Shop.md')
  put(file, ACME)
  const store = createStore(dir, OWNER)
  const added = store.saveTask('Acme Shop', { op: 'add', task: { text: 'Payment webhooks', due: '2026-11-08', p: 'p1' } })
  assert.equal(added.tasks.length, 3)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /## Todo\n\n- \[ \] Checkout page\n- \[x\] Product grid · p2 \^t-ab12\n- \[ \] Payment webhooks · due 2026-11-08 · p1 \^t-[a-z0-9]{4}\n/)
  assert.doesNotMatch(text, /## Tasks/)
  const toggled = store.saveTask('Acme Shop', { op: 'toggle', id: 't-ab12', expected: { done: true, text: 'Product grid', due: '', p: 'p2' } })
  assert.equal(toggled.tasks.find(x => x.id === 't-ab12').done, false)
  const withSite = store.saveField('Acme Shop', 'accepted_by', 'Acme', '')
  assert.equal(withSite.fields.accepted_by, 'Acme')
  assert.match(fs.readFileSync(file, 'utf8'), /^accepted_by: "Acme"$/m)
})

test('the API serves flat mapped cards without local paths and writes through the mapping', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-layout-'))
  const projects = path.join(dir, 'vault', 'Clients')
  put(path.join(projects, 'Acme Shop.md'), ACME.replace('client: Acme', 'client: Acme\npreview: "shot.png"'))
  put(path.join(projects, 'shot.png'), 'png')
  const app = createApp({ projectsRoot: projects, reposRoot: dir, dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, cards: OWNER })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve({ status: res.statusCode, text: s, json: JSON.parse(s) }))
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  const one = await call('GET', `/api/projects/${encodeURIComponent('Acme Shop')}`)
  assert.equal(one.status, 200)
  assert.equal(one.json.fields.stage, 'development')
  assert.equal(one.json.preview, '/vault/shot.png')
  assert.equal(one.json.fieldKeys.stage, 'status')
  assert.ok(!one.text.includes(dir.replace(/\\/g, '\\\\')), 'no local paths, including the readiness file path')
  assert.equal(one.json.readinessFile, undefined)
  const w = await call('POST', `/api/projects/${encodeURIComponent('Acme Shop')}/field`, { key: 'stage', value: 'done', expected: 'development' })
  assert.equal(w.status, 200)
  assert.match(fs.readFileSync(path.join(projects, 'Acme Shop.md'), 'utf8'), /^status: shipped$/m)
})

test('survey lists frontmatter keys, their kinds and short value lists, and hides secret-looking keys', t => {
  const dir = temp(t)
  put(path.join(dir, 'Acme Shop.md'), ACME.replace('client: Acme', 'client: Acme\napi_key: "sk-SURVEY-SECRET"'))
  put(path.join(dir, 'Nebula.md'), '---\ntype: client-project\nstatus: shipped\nstarted: 2026-10-27\n---\n\n## Next\n\n- [ ] a\n- [ ] b\n')
  put(path.join(dir, 'Sub', 'Deep.md'), '---\ntype: idea\n---\n')
  const s = survey(dir)
  assert.equal(s.notes, 3)
  assert.equal(s.layoutHint, 'flat')
  const key = k => s.keys.find(x => x.key === k)
  assert.deepEqual(key('status').values.map(v => v.value).sort(), ['in progress', 'shipped'])
  assert.deepEqual(key('type').values.find(v => v.value === 'client-project').count, 2)
  assert.deepEqual(Object.keys(key('started').kinds).sort(), ['date YYYY-MM-DD', 'datetime YYYY-MM-DD HH:MM'])
  assert.equal(key('api_key').values, undefined)
  assert.ok(!JSON.stringify(s).includes('SURVEY-SECRET'))
  assert.deepEqual(s.checkboxHeadings.map(h => h.heading).sort(), ['Next', 'Todo'])
  assert.equal(survey(dir, { recursive: false }).notes, 2)
})

test('the doctor reads a flat mapped setup and points at unmapped owner words', async t => {
  const dir = temp(t)
  const projects = path.join(dir, 'Clients')
  put(path.join(projects, 'Acme Shop.md'), ACME)
  put(path.join(projects, 'Paused.md'), '---\ntype: client-project\nstatus: on hold\n---\n')
  put(path.join(projects, 'Inbox.md'), '# Inbox\n')
  fs.mkdirSync(path.join(dir, 'code'))
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: path.join(dir, 'code'), cards: OWNER }))
  const r = await diagnose(path.dirname(path.dirname(fileURLToPath(import.meta.url))), { file, probe: async () => ({ running: false }) })
  assert.equal(r.ok, true, JSON.stringify(r.problems))
  assert.equal(r.filteredOut, 1)
  assert.deepEqual(r.looseNotes, [])
  const by = Object.fromEntries(r.cards.map(c => [c.name, c]))
  assert.equal(by['Acme Shop'].file, 'Acme Shop.md')
  assert.match(by.Paused.warnings.join('\n'), /status: "on hold" is not a Projium stage; add it to cards\.stages/)
  assert.match(by['Acme Shop'].warnings.join('\n'), /1 task\(s\) without a \^t-xxxx id/)
  assert.doesNotMatch(by['Acme Shop'].warnings.join('\n'), /outside the ## Todo/)
  assert.match(r.hints.join('\n'), /1 note\(s\) do not match cards\.filter/)
})

test('the cards config is checked before anything is read', t => {
  const bad = (cards, reason) => assert.throws(() => cardsConfig(cards), reason)
  bad({ layout: 'tree' }, /cards\.layout/)
  bad({ recursive: true }, /recursive works only with cards\.layout "flat"/)
  bad({ layout: 'flat', recursive: 'yes' }, /recursive must be true or false/)
  bad({ filter: {} }, /cards\.filter must be an object/)
  bad({ filter: { type: 3 } }, /cards\.filter\.type/)
  bad({ fields: { status: 'state' } }, /only these fields can be mapped/)
  bad({ fields: { stage: 'my status' } }, /must be a frontmatter key/)
  bad({ fields: { spec_at: 'stage' } }, /itself a Projium field/)
  bad({ fields: { spec_at: 'started', mainnet_at: 'started' } }, /maps two fields to started/)
  bad({ stages: { live: 'launched' } }, /cards\.stages\["live"\] must be one of/)
  bad({ sections: { tasks: '## Todo' } }, /cards\.sections\.tasks/)
  assert.deepEqual(cardsConfig(undefined).layout, 'folder')
  assert.deepEqual(cardsConfig({ fields: { stage: 'stage' } }).fields, { stage: 'stage' })
  const dir = temp(t)
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ cards: { layout: 'flat', sort: 'x', sections: { todo: 'Todo' } } }))
  assert.deepEqual(loadConfig(dir, file).unknownKeys, ['cards.sort', 'cards.sections.todo'])
})
