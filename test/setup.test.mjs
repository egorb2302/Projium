import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { defaultConfigFile, obsidianVaults, noteFolders, repoFolders, guessStage, propose, runSetup, lineReader, filterHint } from '../lib/setup.mjs'
import { survey } from '../lib/survey.mjs'
import { instanceId } from '../lib/config.mjs'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-setup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const world = t => {
  const home = temp(t)
  const vault = path.join(home, 'Vault')
  write(path.join(vault, 'Work', 'Clients', 'Acme Shop.md'), '---\ntype: client-project\nstatus: in progress\nsite: https://acme.example\n---\n# Acme Shop\n\n## Todo\n\n- [ ] one\n- [ ] two\n')
  write(path.join(vault, 'Work', 'Clients', 'Beta.md'), '---\ntype: client-project\nstatus: waiting for client review\n---\n# Beta\n')
  write(path.join(vault, 'Work', 'Clients', 'Gamma.md'), '---\ntype: client-project\nstatus: shipped\n---\n# Gamma\n')
  write(path.join(vault, 'Daily', '2026-11-01.md'), '# day\n')
  write(path.join(vault, 'Inbox.md'), '---\ntags: inbox\n---\n')
  for (const r of ['acme-shop', 'beta']) fs.mkdirSync(path.join(home, 'code', r, '.git'), { recursive: true })
  write(path.join(home, 'AppData', 'Roaming', 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: { a: { path: vault, ts: 1 }, gone: { path: path.join(home, 'nope') } } }))
  return { home, vault, env: { APPDATA: path.join(home, 'AppData', 'Roaming') } }
}

const scripted = answers => {
  const out = []
  return { out, io: { say: s => out.push(s), ask: async q => (out.push(q), answers.shift() ?? '') } }
}

test('Obsidian vaults are read from obsidian.json on Windows, macOS and Linux', t => {
  const home = temp(t)
  const vault = path.join(home, 'V')
  fs.mkdirSync(vault)
  const json = JSON.stringify({ vaults: { x: { path: vault }, y: { path: path.join(home, 'missing') } } })
  write(path.join(home, 'win', 'obsidian', 'obsidian.json'), json)
  write(path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), json)
  write(path.join(home, '.config', 'obsidian', 'obsidian.json'), json)
  assert.deepEqual(obsidianVaults({ home, env: { APPDATA: path.join(home, 'win') }, platform: 'win32' }), [vault])
  assert.deepEqual(obsidianVaults({ home, env: {}, platform: 'darwin' }), [vault])
  assert.deepEqual(obsidianVaults({ home, env: {}, platform: 'linux' }), [vault])
  assert.deepEqual(obsidianVaults({ home: path.join(home, 'none'), env: {}, platform: 'linux' }), [])
})

test('note folders with project notes rank first, and folders with repos are counted', t => {
  const { home, vault } = world(t)
  const found = noteFolders([vault])
  assert.equal(found[0].dir, path.join(vault, 'Work', 'Clients'))
  assert.deepEqual([found[0].notes, found[0].withStatus], [3, 3])
  assert.ok(!found.some(f => f.dir.endsWith('Daily')))
  assert.deepEqual(repoFolders([], { home }), [{ dir: path.join(home, 'code'), repos: 2 }])
})

test('stage words are guessed into Projium stages', () => {
  const cases = { 'in progress': 'development', active: 'development', live: 'development', 'waiting for client review': 'review', 'on hold': 'review', 'fixing bugs': 'fixes', shipped: 'done', Closed: 'done', 'Готов': 'done', 'на ревью': 'review', правки: 'fixes', review: 'review', done: 'done' }
  for (const [w, s] of Object.entries(cases)) assert.equal(guessStage(w), s, w)
})

test('the proposal maps the owner fields from a survey and leaves Projium cards alone', t => {
  const { vault } = world(t)
  const p = propose(survey(path.join(vault, 'Work')))
  assert.deepEqual(p.cards, {
    layout: 'flat',
    recursive: true,
    fields: { stage: 'status', site: null },
    stages: { 'in progress': 'development', 'waiting for client review': 'review', shipped: 'done' },
    sections: { tasks: 'Todo' },
  })
  assert.equal(p.sites, 1)
  assert.deepEqual(propose(survey(path.join(repo, 'demo', 'projects'))).cards, {})
})

test('setup stops with a hint instead of asking forever when stdin has ended', async t => {
  const home = temp(t)
  const here = temp(t)
  const input = Readable.from([])
  const output = { isTTY: false, written: 0, write() {
    this.written++
  } }
  const io = lineReader(input, output)
  await new Promise(r => setTimeout(r, 50))
  await assert.rejects(runSetup({ here, file: path.join(here, 'c.json'), io, home, env: {}, platform: 'linux', port: 3299 }), /no folder given; pass --notes/)
  assert.ok(output.written < 50, String(output.written))
  assert.equal(fs.existsSync(path.join(here, 'c.json')), false)
})

test('a mixed notes folder gets a filter on the key its project notes share', async t => {
  const home = temp(t)
  const here = temp(t)
  const notes = path.join(home, 'Notes')
  for (const n of ['Acme', 'Beta', 'Gamma']) write(path.join(notes, `${n}.md`), `---\ntype: client-project\nstatus: active\n---\n# ${n}\n`)
  write(path.join(notes, '2026-11-01.md'), '---\nstatus: draft\n---\n# day\n')
  write(path.join(notes, '2026-11-02.md'), '---\nproject: Acme\n---\n# day 2\n')
  write(path.join(notes, 'Ideas.md'), '---\ntags: inbox\n---\n# ideas\n')
  assert.deepEqual(filterHint(notes, 'status', false), { key: 'type', value: 'client-project', n: 3, out: 2 })
  const r = await runSetup({ here, file: path.join(here, 'c.json'), io: { yes: true, say: () => {}, ask: async () => '' }, notes, home, env: {}, platform: 'linux', port: 3299 })
  assert.deepEqual(r.config.cards.filter, { type: 'client-project' })
  assert.equal(r.projects, 3)
  write(path.join(notes, 'Contact.md'), '---\ntype: Client-Project\n---\n# a contact, not a project\n')
  assert.equal(filterHint(notes, 'status', false), null)
})

test('setup takes the next port when the same notes folder is served for another config', async t => {
  const home = temp(t)
  const here = temp(t)
  const notes = path.join(home, 'Projects')
  fs.mkdirSync(notes)
  const file = path.join(here, 'c.json')
  const asked = []
  const probe = async port => (asked.push(port), port === 3210 ? { running: true, projium: true, sameInstance: true, config: 'another-config' } : { running: false })
  const r = await runSetup({ here, file, io: { yes: true, say: () => {}, ask: async () => '' }, notes, home, env: {}, platform: 'linux', probe })
  assert.equal(r.config.port, 3211)
  assert.deepEqual(asked, [3210, 3211])
  const mine = async port => (port === 3210 ? { running: true, projium: true, sameInstance: false, config: instanceId(file) } : { running: false })
  const again = await runSetup({ here, file, io: { yes: true, say: () => {}, ask: async () => 'y' }, notes, home, env: {}, platform: 'linux', probe: mine })
  assert.equal(again.config.port, 3210)
})

test('the filter hint gives up on a folder too big to read whole', async t => {
  const notes = path.join(temp(t), 'Vault')
  fs.mkdirSync(notes)
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(notes, `n${i}.md`), i < 3 ? '---\ntype: client\nstatus: active\n---\n' : i === 3 ? '---\nstatus: draft\n---\n' : '')
  assert.equal(filterHint(notes, 'status', false), null)
})

test('the proposal skips headings and status words the config would refuse', () => {
  const p = propose({
    notes: 3,
    layoutHint: 'flat',
    keys: [{ key: 'status', notes: 3, values: [{ value: ' ', count: 1 }, { value: 'live', count: 2 }] }],
    checkboxHeadings: [{ heading: 'Todo #2', level: 2, checkboxes: 5, usable: true }, { heading: 'Next', level: 2, checkboxes: 3, usable: true }],
  })
  assert.deepEqual(p.cards.stages, { live: 'development' })
  assert.deepEqual(p.cards.sections, { tasks: 'Next' })
})

test('the config file lives in a clone, or in ~/.projium when Projium runs from npx', t => {
  const home = temp(t)
  const zip = path.join(home, 'Projium-main')
  fs.mkdirSync(zip)
  assert.equal(defaultConfigFile(zip, { env: {}, home }), path.join(zip, 'tracker.config.json'))
  const clone = path.join(home, 'Projium')
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
  const npx = path.join(home, 'npm-cache', '_npx', 'abc', 'node_modules', 'projium')
  fs.mkdirSync(npx, { recursive: true })
  assert.equal(defaultConfigFile(clone, { env: {}, home }), path.join(clone, 'tracker.config.json'))
  assert.equal(defaultConfigFile(npx, { env: {}, home }), path.join(home, '.projium', 'tracker.config.json'))
  assert.equal(defaultConfigFile(npx, { env: { TRACKER_CONFIG: path.join(home, 'x.json') }, home }), path.join(home, 'x.json'))
})

test('setup walks the owner through notes, repos and zone, and writes a config that shows their projects', async t => {
  const { home, vault, env } = world(t)
  const here = temp(t)
  const file = path.join(home, '.projium', 'tracker.config.json')
  const { io, out } = scripted(['', 'n', 'review', '', 'done', 'y', '', '+05:30'])
  const r = await runSetup({ here, file, io, home, env, platform: 'win32', port: 3299, lang: 'ru-RU' })
  assert.equal(r.projects, 3)
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(c.projectsDir, path.join(vault, 'Work', 'Clients').replace(/\\/g, '/'))
  assert.equal(c.reposDir, path.join(home, 'code').replace(/\\/g, '/'))
  assert.equal(c.dbFile, 'data/tracker.db')
  assert.equal(c.port, 3299)
  assert.equal(c.utcOffset, '+05:30')
  assert.deepEqual(c.digest, { at: '10:00', lang: 'ru' })
  assert.deepEqual(c.cards, { layout: 'flat', fields: { stage: 'status' }, stages: { 'in progress': 'review', 'waiting for client review': 'review', shipped: 'done' }, sections: { tasks: 'Todo' } })
  assert.equal(c.$schema, undefined)
  assert.ok(out.some(l => /Projium shows 3 project\(s\): Acme Shop, Beta, Gamma/.test(l)))
  for (const f of ['Acme Shop', 'Beta', 'Gamma']) assert.match(fs.readFileSync(path.join(vault, 'Work', 'Clients', `${f}.md`), 'utf8'), /^---\ntype: client-project/)
})

test('setup keeps an existing config unless the owner says to replace it, and backs up the old one', async t => {
  const { home, vault, env } = world(t)
  const here = temp(t)
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, '{"port": 3210}\n')
  const kept = await runSetup({ here, file, io: scripted(['']).io, home, env, platform: 'win32', port: 3299 })
  assert.equal(kept.kept, true)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"port": 3210}\n')
  const r = await runSetup({ here, file, io: scripted(['y', path.join(vault, 'Work', 'Clients')]).io, home, env, platform: 'win32', port: 3299 })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).$schema, './tracker.config.schema.json')
  assert.equal(fs.readFileSync(r.backup, 'utf8'), '{"port": 3210}\n')
})

test('setup on an empty notes folder offers to create the first card', async t => {
  const home = temp(t)
  const here = temp(t)
  const notes = path.join(home, 'Projects')
  fs.mkdirSync(notes)
  const file = path.join(here, 'tracker.config.json')
  const { io, out } = scripted(['', '', 'My first site'])
  const r = await runSetup({ here, file, io, notes, home, env: {}, platform: 'linux', port: 3299 })
  assert.equal(r.projects, 1, out.join('\n'))
  assert.match(fs.readFileSync(path.join(notes, 'My first site', 'My first site.md'), 'utf8'), /^---\nstage: development\n/)
})

const cli = (args, { input = '', env = {} } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(repo, 'bin', 'projium.mjs'), ...args], { env: { ...process.env, TRACKER_CONFIG: '', ...env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('error', reject)
    child.on('close', code => resolve({ code, out }))
    child.stdin.end(input)
  })

test('the projium command sets up from flags without questions and explains its usage', async t => {
  const { home, vault } = world(t)
  const file = path.join(home, 'conf', 'tracker.config.json')
  const notes = path.join(vault, 'Work', 'Clients')
  const r = await cli(['setup', '--notes', notes, '--repos', path.join(home, 'code'), '--port', '3298', '--yes', '--no-start', '--config', file], { env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') } })
  assert.equal(r.code, 0, r.out)
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(c.projectsDir, notes.replace(/\\/g, '/'))
  assert.equal(c.port, 3298)
  assert.equal(c.cards.fields.site, null)
  assert.match(r.out, /Projium shows 3 project\(s\)/)
  assert.match(r.out, /Start it with: node bin\/projium\.mjs start/)
  assert.doesNotMatch(r.out, /Port 3210 is taken/)
  const help = await cli(['--help', '--config', file])
  assert.equal(help.code, 0)
  assert.match(help.out, /Usage: node bin\/projium\.mjs \[command\]/)
  assert.equal((await cli(['frobnicate', '--config', file])).code, 1)
  const none = await cli(['start', '--config', path.join(home, 'none.json')])
  assert.equal(none.code, 1)
  assert.match(none.out, /No config at .* yet\. Run node bin\/projium\.mjs setup/)
  const bad = await cli(['setup', '--yes', '--no-start', '--notes', path.join(home, 'missing'), '--port', '3298', '--config', path.join(home, 'other.json')])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /Setup stopped: folder not found/)
})

test('the projium command resolves relative paths from the folder npm was run in', async t => {
  const { home } = world(t)
  const r = await cli(['setup', '--notes', path.join('Vault', 'Work', 'Clients'), '--repos', 'code', '--port', '3296', '--yes', '--no-start', '--config', path.join('conf', 'c.json')], { env: { INIT_CWD: home, HOME: home, USERPROFILE: home } })
  assert.equal(r.code, 0, r.out)
  const c = JSON.parse(fs.readFileSync(path.join(home, 'conf', 'c.json'), 'utf8'))
  assert.equal(c.projectsDir, path.join(home, 'Vault', 'Work', 'Clients').replace(/\\/g, '/'))
  assert.equal(c.reposDir, path.join(home, 'code').replace(/\\/g, '/'))
})

test('the projium command answers setup questions read from a pipe', async t => {
  const { home, vault } = world(t)
  const file = path.join(home, 'conf', 'tracker.config.json')
  const r = await cli(['setup', '--no-start', '--port', '3297', '--config', file], { input: `${path.join(vault, 'Work', 'Clients')}\n\n\n\n`, env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'AppData', 'Roaming') } })
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cards.sections.tasks, 'Todo')
})
