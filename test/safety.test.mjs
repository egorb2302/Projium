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

const fid = (store, name) => store.load(name).fileId

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
  store.saveField('A', 'stage', 'review', 'development', fid(store, 'A'))
  store.saveField('A', 'next_step', 'send invoice', 'call client', fid(store, 'A'))
  store.saveField('A', 'spec_at', '2026-10-02T11:00', '2026-10-01T10:00', fid(store, 'A'))
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
    assert.throws(() => store.saveField(name, 'next_step', 'x', store.load(name).fields.next_step, fid(store, name)), /not a plain one-line value/, name)
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
  store.saveField('A', 'spec_at', '2026-10-02T09:15', '2026-10-01T10:00', fid(store, 'A'))
  assert.match(fs.readFileSync(file, 'utf8'), /^started: 2026-10-02 09:15:00$/m)
})

test('a mapped date field keeps a bare date, and a zoned seconds time stays a YAML timestamp', t => {
  const dir = temp(t)
  const file = path.join(dir, 'A.md')
  put(file, '---\nstatus: in progress\naccepted:\nstarted: 2026-10-21T08:00:00.000Z\n---\n')
  const store = createStore(dir, { ...FLAT, fields: { ...FLAT.fields, accepted_at: 'accepted' } })
  store.saveField('A', 'accepted_at', '2026-10-22', '', fid(store, 'A'))
  assert.match(fs.readFileSync(file, 'utf8'), /^accepted: 2026-10-22$/m)
  store.saveField('A', 'spec_at', '2026-10-22T09:15', '2026-10-21T08:00:00.000Z', fid(store, 'A'))
  assert.match(fs.readFileSync(file, 'utf8'), /^started: 2026-10-22T09:15:00$/m)
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

test('a quoted time with seconds stays quoted, so YAML never reads it as a UTC timestamp', t => {
  const dir = temp(t)
  const file = path.join(dir, 'A.md')
  put(file, '---\nstatus: in progress\nstarted: "2026-10-01 10:00:45"\nnext: "call"\n---\n')
  const store = createStore(dir, FLAT)
  store.saveField('A', 'spec_at', '2026-10-02T09:15', '2026-10-01T10:00', fid(store, 'A'))
  assert.match(fs.readFileSync(file, 'utf8'), /^started: "2026-10-02 09:15:00"$/m)
  store.saveField('A', 'next_step', '2026-10-22 09:00:00', 'call', fid(store, 'A'))
  assert.match(fs.readFileSync(file, 'utf8'), /^next: "2026-10-22 09:00:00"$/m)
})

test('frontmatter with explicit or anchored keys, an indented first key or a value over several lines is not edited', t => {
  const dir = temp(t)
  const cases = {
    explicit: '---\nstatus: in progress\n? next\n: call\n---\n',
    anchored: '---\nstatus: in progress\n&k next: call\n---\n',
    indented: '---\n  status: in progress\n  next: call\n---\n',
    flowmap: '---\nstatus: in progress\nmeta: {a: 1,\nnext: 2}\n---\n',
    quoted: '---\nstatus: in progress\nnote: "first line\n  second"\n---\n',
    anchorquote: '---\nstatus: in progress\nnote: &n "first\nnext: x"\n---\n',
    tagquote: "---\nstatus: in progress\nnote: !!str 'first\nnext: x'\n---\n",
    anchorflow: '---\nstatus: in progress\ntags: &t [a,\nnext: b]\n---\n',
    tagflow: '---\nstatus: in progress\nm: !!map {a: 1,\nnext: b}\n---\n',
    quotedflow: '---\nstatus: in progress\ntags: [a, "b]\nnext: x"]\n---\n',
    nextquote: '---\nstatus: in progress\nnote:\n  "first\nnext: x"\n---\n',
    nextflow: '---\nstatus: in progress\ntags:\n  [a,\nnext: b]\n---\n',
    itemquote: '---\nstatus: in progress\ntags:\n  - "first\nnext: x"\n---\n',
    itemflow: '---\nstatus: in progress\ntags:\n- [a,\nnext: b]\n---\n',
    tagnext: "---\nstatus: in progress\nnote: !!str\n  'first\nnext: x'\n---\n",
    anchornext: '---\nstatus: in progress\nnote: &a\n  {a: 1,\nnext: b}\n---\n',
    nestedquote: '---\nstatus: in progress\nmeta:\n  owner: "first\nnext: x"\n---\n',
    spacedkey: '---\nstatus: in progress\nmy tags: [a,\nnext: b]\n---\n',
    flowtag: '---\nstatus: in progress\ntags: [!!str "foo]\nnext: x"]\n---\n',
    flowanchor: '---\nstatus: in progress\ntags: [a, &x "b]\nnext: x"]\n---\n',
    itemblock: '---\nstatus: in progress\nlist:\n  - body: |\n      text\n    other: [a,\nnext: b]\n---\n',
    itemblockquote: '---\nstatus: in progress\nlist:\n  - body: |\n      text\n    other: "first\nnext: x"\n---\n',
    explicitnested: '---\nstatus: in progress\nmeta:\n  ? k\n  : "first\nnext: x"\n---\n',
  }
  for (const [name, text] of Object.entries(cases)) put(path.join(dir, `${name}.md`), text)
  const store = createStore(dir, { ...FLAT, filter: { type: 'never' } })
  const plain = createStore(dir, { layout: 'flat', fields: { next_step: 'next', stage: 'status' }, stages: { 'in progress': 'development' } })
  for (const name of Object.keys(cases)) {
    const card = plain.loadFile(name, path.join(dir, `${name}.md`))
    assert.ok(card.locked.includes('next_step') && card.locked.includes('stage'), `${name} is locked`)
    assert.throws(() => plain.saveField(name, 'next_step', 'x', card.fields.next_step ?? '', card.fileId), /Projium does not edit|no card/, name)
    assert.equal(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'), cases[name], `${name} unchanged`)
  }
  assert.deepEqual(store.list(), [])
})

test('repo folders that normalize the same are not guessed, and Report is not a Repo line', t => {
  const dir = temp(t)
  for (const d of ['acme-shop', 'acme_shop', 'solo']) fs.mkdirSync(path.join(dir, d, '.git'), { recursive: true })
  assert.equal(repoOf(dir, 'Acme Shop', ''), null, 'two candidates: no guess')
  assert.equal(repoOf(dir, 'acme_shop', ''), path.join(dir, 'acme_shop'), 'an exact name still wins')
  assert.equal(repoOf(dir, 'Clients/Solo', ''), null, 'names by path are not matched loosely')
  assert.equal(repoOf(dir, 'X', `Report: \`${path.join(dir, 'solo')}\``), null)
  assert.equal(repoOf(dir, 'X', `**Repo:** \`${path.join(dir, 'solo')}\``), path.join(dir, 'solo'))
})

test('a title comes from the first heading of the body, not frontmatter comments or code', t => {
  const dir = temp(t)
  put(path.join(dir, 'a.md'), '---\n# a comment\nstage: fixes\n---\n\n```\n# not a title\n```\n\n# Real title\n')
  put(path.join(dir, 'b.md'), '---\nstage: fixes\n---\n\n# ..\n')
  assert.deepEqual(createStore(dir, { layout: 'flat', name: 'title' }).list().map(c => c.name).sort(), ['Real title', 'b'])
})

test('a write that moves the note out of the filter still returns the written card', t => {
  const dir = temp(t)
  put(path.join(dir, 'A.md'), '---\nstatus: in progress\n---\n')
  const store = createStore(dir, { ...FLAT, filter: { status: 'in progress' } })
  const after = store.saveField('A', 'stage', 'done', 'development', fid(store, 'A'))
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
  assert.throws(() => store.saveField('A', 'site', 'https://other.example.com', '', fid(store, 'A')), /turned off/)
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

test('a title equal to the path name of a renamed duplicate does not hide a card', t => {
  const dir = temp(t)
  put(path.join(dir, 'Foo.md'), '---\nstage: fixes\n---\n\n# Dup\n')
  put(path.join(dir, 'Sub', 'Bar.md'), '---\nstage: fixes\n---\n\n# Dup\n')
  put(path.join(dir, 'c.md'), '---\nstage: review\n---\n\n# Foo\n')
  const store = createStore(dir, { layout: 'flat', recursive: true, name: 'title' })
  assert.deepEqual(store.list().map(c => c.name).sort(), ['Foo', 'Sub/Bar', 'c'])
  assert.equal(store.load('Foo').file, path.join(dir, 'Foo.md'))
  assert.equal(store.load('c').file, path.join(dir, 'c.md'))
})

test('survey advises the recursive flat layout when every note sits two folders deep', t => {
  const dir = temp(t)
  put(path.join(dir, 'Clients', 'Acme', 'Project.md'), '---\nstatus: live\n---\n')
  put(path.join(dir, 'Clients', 'Nebula', 'Project.md'), '---\nstatus: live\n---\n')
  assert.equal(survey(dir).layoutHint, 'flat-recursive')
})
