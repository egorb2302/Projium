import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createStore, Conflict, cardName } from '../lib/store.mjs'
import { readTemplate, cardText } from '../lib/template.mjs'
import { uncardedRepos } from '../lib/repo.mjs'
import { cardsConfig } from '../lib/config.mjs'
import { createApp } from '../server.mjs'

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-new-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

test('the card template is read from docs/card-template.md and filled in Projium names', () => {
  const tpl = readTemplate()
  assert.match(tpl, /^---\nstage: development\n/)
  const text = cardText(tpl, { name: 'Acme Shop', values: { next_step: 'Call the client: Friday' } })
  assert.match(text, /^---\nstage: development\nstatus: ""\nnext_step: "Call the client: Friday"\nrepo: ""\n/)
  assert.match(text, /\n# Acme Shop\n\n## Tasks\n\n## Updates\n\n## Timeline\n/)
  assert.ok(!text.includes('Source note'))
  assert.ok(!text.includes('# name'))
})

test('a card in the owner layout uses their keys, stage words, filter and headings', () => {
  const c = cardsConfig({ layout: 'flat', filter: { type: 'client-project' }, fields: { stage: 'status', spec_at: 'started', site: null }, stages: { 'in progress': 'development', waiting: 'review' }, sections: { tasks: 'Todo' } })
  const keyOf = k => (c.fields[k] === null ? null : c.fields[k] ?? k)
  const text = cardText(readTemplate(), { name: 'Beta', keyOf, stageWord: 'waiting', filter: c.filter, heading: { tasks: 'Todo' } })
  const front = text.split('---')[1]
  assert.match(front, /^status: waiting$/m)
  assert.equal(front.match(/^status:/gm).length, 1)
  assert.match(front, /^started:$/m)
  assert.match(front, /^type: client-project$/m)
  assert.ok(!/^site:/m.test(front))
  assert.match(text, /\n## Todo\n/)
})

test('project names that are not safe file names are refused', () => {
  for (const bad of ['', '  ', '../evil', 'a/b', 'a\\b', 'con', 'NUL.txt', '.hidden', 'trailing.', 'x:y', 'q?', 'x'.repeat(121)]) assert.throws(() => cardName(bad), /project name/, bad)
  assert.equal(cardName('  Acme Shop (v2)  '), 'Acme Shop (v2)')
  assert.equal(cardName('Проект 1'), 'Проект 1')
})

test('create writes <name>/<name>.md in the folder layout and never overwrites a note', t => {
  const root = temp(t)
  const store = createStore(root)
  const card = store.create('Acme', { stage: 'review', next_step: 'Send mocks' })
  assert.equal(card.name, 'Acme')
  assert.equal(card.fields.stage, 'review')
  assert.equal(card.fields.next_step, 'Send mocks')
  const file = path.join(root, 'Acme', 'Acme.md')
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => store.create('acme'), e => e instanceof Conflict)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  fs.mkdirSync(path.join(root, 'Notes'))
  fs.writeFileSync(path.join(root, 'Notes', 'Notes.md'), 'no frontmatter, mine\n')
  assert.throws(() => store.create('Notes'), e => e instanceof Conflict)
  assert.equal(fs.readFileSync(path.join(root, 'Notes', 'Notes.md'), 'utf8'), 'no frontmatter, mine\n')
  fs.mkdirSync(path.join(root, 'Kept'))
  fs.writeFileSync(path.join(root, 'Kept', 'other.md'), 'x')
  assert.equal(store.create('Kept').name, 'Kept')
  assert.equal(fs.readFileSync(path.join(root, 'Kept', 'other.md'), 'utf8'), 'x')
  fs.mkdirSync(path.join(root, 'lower'))
  assert.throws(() => store.create('Lower'), e => e instanceof Conflict && /folder named lower/.test(e.message))
  assert.deepEqual(fs.readdirSync(path.join(root, 'lower')), [])
  assert.throws(() => store.create('Bad', { stage: 'shipped' }), /stage must be/)
  assert.throws(() => store.create('Bad', { next_step: 'two\nlines' }), /one line/)
  assert.equal(fs.existsSync(path.join(root, 'Bad')), false)
})

test('create in a flat layout with a filter and mapped fields shows up as a project at once', t => {
  const root = temp(t)
  fs.writeFileSync(path.join(root, 'Old.md'), '---\ntype: client-project\nstatus: in progress\n---\n# Old\n')
  fs.writeFileSync(path.join(root, 'Diary.md'), '# not a project\n')
  const c = cardsConfig({ layout: 'flat', filter: { type: ['client-project', 'retainer'] }, fields: { stage: 'status', site: null }, stages: { 'in progress': 'development', 'waiting for review': 'review' }, sections: { tasks: 'Todo' } })
  const store = createStore(root, c)
  const card = store.create('New Client', { stage: 'review' })
  assert.equal(card.fields.stage, 'review')
  assert.equal(card.fields.status, 'waiting for review')
  const text = fs.readFileSync(path.join(root, 'New Client.md'), 'utf8')
  assert.match(text, /^type: client-project$/m)
  assert.match(text, /\n## Todo\n/)
  assert.deepEqual(store.list().map(x => x.name).sort(), ['New Client', 'Old'])
  assert.throws(() => store.create('Diary'), e => e instanceof Conflict)
  assert.equal(fs.readFileSync(path.join(root, 'Diary.md'), 'utf8'), '# not a project\n')
  const titled = createStore(root, cardsConfig({ layout: 'flat', name: 'title', filter: { type: 'client-project' }, fields: { stage: 'status' } }))
  assert.equal(titled.create('Gamma').name, 'Gamma')
})

test('create refuses a project folder that links outside the projects folder', t => {
  const dir = temp(t)
  const root = path.join(dir, 'projects')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(root, 'Evil'), 'junction')
  assert.throws(() => createStore(root).create('Evil'), /outside the projects folder/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

const git = dir => {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
}

test('repos without a card are listed by folder name; matched, declared, ignored and plain folders are not', t => {
  const dir = temp(t)
  const repos = path.join(dir, 'repos')
  for (const r of ['acme-shop', 'beta', 'gamma', 'secret-x', 'declared-one']) git(path.join(repos, r))
  fs.mkdirSync(path.join(repos, 'not-a-repo'))
  const cards = [
    { name: 'Acme Shop', text: '---\nstage: development\n---\n', repoHint: null },
    { name: 'Other', text: '---\nstage: development\nrepo: declared-one\n---\n', repoHint: null },
    { name: 'Hinted', text: '---\nstage: done\n---\n', repoHint: 'gamma' },
  ]
  const names = uncardedRepos(repos, cards, s => /secret/i.test(s)).map(r => r.name)
  assert.deepEqual(names, ['beta'])
  assert.deepEqual(uncardedRepos(path.join(dir, 'missing'), cards), [])
})

test('repos without a card include repos linked into the repos folder, but not links to plain folders or nowhere', t => {
  const dir = temp(t)
  const repos = path.join(dir, 'repos')
  const ssd = path.join(dir, 'ssd')
  git(path.join(repos, 'here'))
  git(path.join(ssd, 'moved'))
  fs.mkdirSync(path.join(ssd, 'plain'))
  fs.symlinkSync(path.join(ssd, 'moved'), path.join(repos, 'moved'), 'junction')
  fs.symlinkSync(path.join(ssd, 'plain'), path.join(repos, 'plain'), 'junction')
  fs.symlinkSync(path.join(ssd, 'gone'), path.join(repos, 'gone'), 'junction')
  assert.deepEqual(uncardedRepos(repos, []).map(r => r.name).sort(), ['here', 'moved'])
  const cards = [{ name: 'Moved', text: '---\nstage: development\n---\n', repoHint: null }]
  assert.deepEqual(uncardedRepos(repos, cards).map(r => r.name), ['here'])
})

const serve = async (t, opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-new-'))
  const projects = path.join(dir, 'projects')
  const repos = path.join(dir, 'repos')
  fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(projects, 'alpha', 'alpha.md'), '---\nstage: development\n---\n# alpha\n')
  for (const r of ['alpha', 'beta', 'gamma', 'bad name!']) git(path.join(repos, r))
  const app = createApp({ projectsRoot: projects, reposRoot: repos, dbFile: path.join(dir, 'db', 't.db'), port: 0, checkHealth: false, ...opts })
  const port = await app.start()
  t.after(async () => {
    await app.stop()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
        let s = ''
        res.on('data', c => (s += c))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || 'null') }))
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  return { dir, projects, call }
}

test('POST /api/projects creates a card and answers 409 for a name that exists', async t => {
  const { projects, call } = await serve(t)
  const r = await call('POST', '/api/projects', { name: 'Nova', stage: 'fixes', next_step: 'Fix the header' })
  assert.equal(r.status, 200)
  assert.equal(r.json.name, 'Nova')
  assert.equal(r.json.fields.stage, 'fixes')
  assert.ok(fs.existsSync(path.join(projects, 'Nova', 'Nova.md')))
  assert.equal((await call('POST', '/api/projects', { name: 'nova' })).status, 409)
  assert.equal((await call('POST', '/api/projects', { name: '../up' })).status, 400)
  assert.equal((await call('POST', '/api/projects', { name: 'Elsewhere', instance: 'nope' })).status, 421)
  assert.equal(fs.existsSync(path.join(projects, 'Elsewhere')), false)
})

test('GET /api/repos lists repos without a card and POST /api/repos/cards creates only those', async t => {
  const { projects, call } = await serve(t, { ignore: ['gamma'] })
  const list = await call('GET', '/api/repos')
  assert.equal(list.json.layout, 'folder')
  assert.deepEqual(list.json.repos.map(r => r.name).sort(), ['bad name!', 'beta'])
  const r = await call('POST', '/api/repos/cards', { repos: ['beta', 'alpha', 'gamma', 'bad name!', '../x'] })
  assert.deepEqual(r.json.created, ['beta'])
  assert.deepEqual(r.json.failed.map(f => f.name), ['alpha', 'gamma', 'bad name!', '../x'])
  assert.match(r.json.failed[2].error, /project name/)
  assert.ok(fs.existsSync(path.join(projects, 'beta', 'beta.md')))
  assert.equal(fs.existsSync(path.join(projects, 'gamma')), false)
  assert.deepEqual((await call('GET', '/api/repos')).json.repos.map(r => r.name), ['bad name!'])
  assert.equal((await call('POST', '/api/repos/cards', { repos: [] })).status, 400)
})
