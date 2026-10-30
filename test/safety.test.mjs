import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, Conflict } from '../lib/store.mjs'
import { cardsConfig } from '../lib/config.mjs'
import { readFields } from '../lib/card.mjs'
import { repoOf } from '../lib/repo.mjs'
import { survey } from '../lib/survey.mjs'

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-safety-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const FLAT = { layout: 'flat', fields: { stage: 'status', next_step: 'next', spec_at: 'started' }, stages: { 'in progress': 'development' } }

test('a key written with spaces, tabs or quotes is read and rewritten in place, never duplicated', t => {
  const dir = temp(t)
  const file = path.join(dir, 'A.md')
  put(file, '---\nstatus : in progress\n"next": "call client"\nstarted\t: 2026-10-01 10:00\n---\n\nbody\n')
  const store = createStore(dir, FLAT)
  const a = store.load('A')
  assert.equal(a.fields.stage, 'development')
  assert.equal(a.fields.next_step, 'call client')
  assert.equal(a.fields.spec_at, '2026-10-01T10:00')
  store.saveField('A', 'stage', 'review', 'development')
  store.saveField('A', 'next_step', 'send invoice', 'call client')
  store.saveField('A', 'spec_at', '2026-10-02T11:00', '2026-10-01T10:00')
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text, '---\nstatus: review\nnext: "send invoice"\nstarted: 2026-10-02 11:00\n---\n\nbody\n')
  assert.equal((text.match(/^status/gm) ?? []).length, 1)
})

test('anchors, aliases, tags and flow values are locked, not overwritten', t => {
  const dir = temp(t)
  const cases = {
    anchor: '---\nstatus: in progress\nnext: &n call\nother: *n\n---\n',
    tag: '---\nstatus: in progress\nnext: !!str call\n---\n',
    flow: '---\nstatus: [in progress]\n---\n',
    map: '---\nstatus: in progress\nnext: {a: 1}\n---\n',
  }
  for (const [name, text] of Object.entries(cases)) put(path.join(dir, `${name}.md`), text)
  const store = createStore(dir, { ...FLAT, filter: { status: ['in progress', '[in progress]'] } })
  for (const name of ['anchor', 'tag', 'map']) {
    assert.ok(store.load(name).locked.includes('next_step'), name)
    assert.throws(() => store.saveField(name, 'next_step', 'x', store.load(name).fields.next_step), /not a plain one-line value/, name)
    assert.equal(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'), cases[name], `${name} unchanged`)
  }
  assert.ok(store.load('flow').locked.includes('stage'))
})

test('a zero-indent list is read as a list, so filters match it', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\ntype:\n- client-project\n- web\nstatus: in progress\n---\n')
  assert.deepEqual(readFields(fs.readFileSync(path.join(dir, 'A.md'), 'utf8')).type, ['client-project', 'web'])
  assert.deepEqual(createStore(dir, { ...FLAT, filter: { type: 'client-project' } }).list().map(c => c.name), ['A'])
})

test('seconds in an owner time are kept on write', t => {
  const dir = temp(t)
  const file = path.join(dir, 'A.md')
  put(file, '---\nstatus: in progress\nstarted: 2026-10-01 10:00:45\n---\n')
  const store = createStore(dir, FLAT)
  assert.equal(store.load('A').fields.spec_at, '2026-10-01T10:00')
  store.saveField('A', 'spec_at', '2026-10-02T09:15', '2026-10-01T10:00')
  assert.match(fs.readFileSync(file, 'utf8'), /^started: 2026-10-02 09:15:00$/m)
})

test('a name that now points at another note refuses writes from a stale page', t => {
  const dir = temp(t)
  const nested = path.join(dir, 'Clients', 'Acme.md')
  put(nested, '---\nstage: fixes\n---\n')
  const store = createStore(dir, { layout: 'flat', recursive: true })
  const seen = store.load('Acme')
  put(path.join(dir, 'Acme.md'), '---\nstage: fixes\n---\n')
  assert.deepEqual(store.list().map(c => c.name).sort(), ['Acme', 'Clients/Acme'], 'the next list renames the nested note by path')
  assert.throws(() => store.saveTask('Acme', { op: 'add', task: { text: 'x' } }, seen.fileId), e => e instanceof Conflict && /refers to another note/.test(e.message))
  assert.throws(() => store.saveField('Acme', 'stage', 'done', 'fixes', seen.fileId), e => e instanceof Conflict)
  assert.equal(fs.readFileSync(path.join(dir, 'Acme.md'), 'utf8'), '---\nstage: fixes\n---\n')
  assert.equal(fs.readFileSync(nested, 'utf8'), '---\nstage: fixes\n---\n')
  const fresh = store.load('Clients/Acme')
  assert.equal(fresh.fileId, seen.fileId)
  assert.equal(store.saveField('Clients/Acme', 'stage', 'done', 'fixes', fresh.fileId).fields.stage, 'done')
})

test('a write that moves the note out of the filter still returns the written card', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\nstatus: in progress\n---\n')
  const store = createStore(dir, { ...FLAT, filter: { status: 'in progress' } })
  const after = store.saveField('A', 'stage', 'done', 'development')
  assert.equal(after.fields.stage, 'done')
  assert.match(fs.readFileSync(path.join(dir, 'A.md'), 'utf8'), /^status: done$/m)
  assert.deepEqual(store.list(), [])
})

test('a field set to null is not read and not written', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\nstatus: in progress\nsite: https://example.com\n---\n')
  const store = createStore(dir, { ...FLAT, fields: { ...FLAT.fields, site: null } })
  const a = store.load('A')
  assert.equal(a.fields.site, undefined)
  assert.ok(a.locked.includes('site'))
  assert.throws(() => store.saveField('A', 'site', 'https://other.example.com', ''), /turned off/)
})

test('a flat card can be named by its folder or its title', t => {
  const dir = temp(t)
  put(path.join(dir, 'Kestrel', 'kestrel-notes.md'), '---\nstage: review\n---\n\n# Kestrel booking\n')
  put(path.join(dir, 'Loose.md'), '---\nstage: fixes\n---\n\n# Loose title\n')
  assert.deepEqual(createStore(dir, { layout: 'flat', recursive: true, name: 'folder' }).list().map(c => c.name).sort(), ['Kestrel', 'Loose'])
  assert.deepEqual(createStore(dir, { layout: 'flat', recursive: true, name: 'title' }).list().map(c => c.name).sort(), ['Kestrel booking', 'Loose title'])
})

test('repos come from the note, cards.repos, a Repo line or a loosely matching folder', t => {
  const dir = temp(t)
  for (const d of ['acme-shop', 'nebula', 'lumen-site']) fs.mkdirSync(path.join(dir, d, '.git'), { recursive: true })
  assert.equal(repoOf(dir, 'Acme Shop', ''), path.join(dir, 'acme-shop'), 'spaces and case are ignored')
  assert.equal(repoOf(dir, 'ACME_shop', ''), path.join(dir, 'acme-shop'))
  assert.equal(repoOf(dir, 'Nebula Wallet', ''), null)
  assert.equal(repoOf(dir, 'Nebula Wallet', '', undefined, 'nebula'), path.join(dir, 'nebula'), 'cards.repos hint')
  assert.equal(repoOf(dir, 'Old', '', undefined, 'none'), null)
  const forward = path.join(dir, 'lumen-site').replace(/\\/g, '/')
  assert.equal(repoOf(dir, 'Lumen', `Repo: \`${forward}\``), path.resolve(forward), 'a forward-slash path in a Repo line')
  assert.equal(repoOf(dir, 'Lumen', '---\nrepo: nebula\n---\n', undefined, 'acme-shop'), path.join(dir, 'nebula'), 'the note wins over the config')
})

test('the cards config rejects confusing stage words, reserved targets and bad repos or names', () => {
  const bad = (cards, reason) => assert.throws(() => cardsConfig(cards), reason)
  bad({ stages: { done: 'review' } }, /maps the Projium stage name done to review/)
  bad({ stages: { Development: 'fixes' } }, /maps the Projium stage name development/)
  bad({ fields: { site: 'repo' } }, /which Projium reads for itself/)
  bad({ fields: { stage: null } }, /stage cannot be turned off/)
  bad({ repos: { A: 3 } }, /cards\.repos\["A"\]/)
  bad({ name: 'heading' }, /cards\.name must be/)
  bad({ name: 'folder' }, /cards\.name works only with cards\.layout "flat"/)
  assert.deepEqual(cardsConfig({ stages: { done: 'done', Shipped: 'done' } }).stages, { done: 'done', Shipped: 'done' })
  assert.equal(cardsConfig({ layout: 'flat', fields: { site: null } }).fields.site, null)
})

test('a folder card with an unsupported folder name shows as an error row', t => {
  const dir = temp(t)
  put(path.join(dir, 'a&b', 'a&b.md'), '---\nstage: fixes\n---\n')
  put(path.join(dir, 'ok', 'ok.md'), '---\nstage: fixes\n---\n')
  const rows = createStore(dir).list()
  assert.deepEqual(rows.map(r => [r.name, Boolean(r.error)]).sort(), [['a&b', true], ['ok', false]])
})

test('survey marks heading levels and hides token-looking values', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\nwebhook: abcdEFGH1234567890abcdEFGH\nstatus: live\n---\n\n### Todo\n\n- [ ] a\n\n## Next\n\n- [ ] b\n')
  const s = survey(dir)
  assert.equal(s.keys.find(k => k.key === 'webhook').values, undefined)
  assert.ok(!JSON.stringify(s).includes('abcdEFGH'))
  assert.deepEqual(s.checkboxHeadings.map(h => [h.heading, h.level, h.usable]).sort(), [['Next', 2, true], ['Todo', 3, false]])
})
