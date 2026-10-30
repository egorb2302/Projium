import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose } from '../lib/doctor.mjs'
import { writeConfig } from '../lib/init.mjs'
import { loadConfig } from '../lib/config.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const down = async () => false

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-doctor-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('with no config the doctor shows the demo cards but is not ok', async () => {
  const r = await diagnose(repoRoot, { file: path.join(os.tmpdir(), 'no-such-tracker-config.json'), probe: down })
  assert.equal(r.ok, false)
  assert.equal(r.config.file, null)
  assert.equal(r.summary.ok, 4)
  assert.match(r.problems.join('\n'), /no tracker\.config\.json/)
  assert.equal(r.server.running, false)
})

test('the doctor says why each folder is skipped and flags config typos', async t => {
  const dir = temp(t)
  const projects = path.join(dir, 'vault', 'Projects')
  const repos = path.join(dir, 'code')
  fs.mkdirSync(path.join(repos, 'alpha', '.git'), { recursive: true })
  put(path.join(projects, 'alpha', 'alpha.md'), '---\nstage: fixes\napi_key: "sk-NEVER-SHOWN"\n---\n\n## Tasks\n\n- [ ] ok task · p1 ^t-aaaa\n- [ ] loose task\n')
  put(path.join(projects, 'beta', 'notes.md'), '---\nstage: review\n---\n')
  put(path.join(projects, 'gamma', 'gamma.md'), '# gamma\n\nno frontmatter\n')
  put(path.join(projects, 'delta', 'delta.md'), '---\nstatus: active\n---\n')
  put(path.join(projects, 'eps', 'eps.md'), '---\nstage: in-progress\nspec_at: yesterday\n---\n')
  put(path.join(projects, 'a#b', 'a#b.md'), '---\nstage: fixes\n---\n')
  put(path.join(projects, 'flat-note.md'), '---\nstage: fixes\n---\n')
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: repos, projectDir: 'typo', digest: { when: '9:00' } }))

  const r = await diagnose(repoRoot, { file, probe: down })
  assert.equal(r.ok, false)
  assert.deepEqual(r.config.unknownKeys, ['projectDir', 'digest.when'])
  const by = Object.fromEntries(r.cards.map(c => [c.name, c]))
  assert.equal(by.alpha.status, 'ok')
  assert.equal(by.alpha.repo, path.join(repos, 'alpha'))
  assert.match(by.alpha.warnings.join('\n'), /1 task\(s\) without a \^t-xxxx id/)
  assert.equal(by.beta.status, 'skipped')
  assert.match(by.beta.reason, /no beta\/beta\.md \(the folder has 1 other \.md file/)
  assert.match(by.gamma.reason, /no YAML frontmatter/)
  assert.match(by.delta.reason, /no stage field/)
  assert.equal(by.eps.status, 'ok')
  assert.match(by.eps.warnings.join('\n'), /stage: stage must be one of/)
  assert.match(by.eps.warnings.join('\n'), /spec_at: time must be/)
  assert.match(by.eps.warnings.join('\n'), /no git repo found/)
  assert.equal(by['a#b'].status, 'skipped')
  assert.equal(r.looseNotes, 1)
  assert.match(r.problems.join('\n'), /1 \.md file\(s\) sit directly in projectsDir/)
  assert.ok(!JSON.stringify(r).includes('NEVER-SHOWN'), 'card values outside the known fields are never printed')

  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: repos }))
  const fixed = await diagnose(repoRoot, { file, probe: async () => true })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.server.running, true)
  assert.equal(fixed.summary.ok, 2)
})

test('a broken config or a missing projects folder is reported, not thrown', async t => {
  const dir = temp(t)
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, '{bad')
  const broken = await diagnose(repoRoot, { file, probe: down })
  assert.equal(broken.ok, false)
  assert.match(broken.problems[0], /config: .*not valid JSON/)
  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'nope'), reposDir: dir }))
  const missing = await diagnose(repoRoot, { file, probe: down })
  assert.equal(missing.ok, false)
  assert.match(missing.problems.join('\n'), /projectsDir missing/)
})

test('init writes a config that loads, refuses to overwrite and rejects bad input', t => {
  const dir = temp(t)
  const projects = path.join(dir, 'Projects')
  fs.mkdirSync(projects)
  const file = path.join(dir, 'conf', 'tracker.config.json')
  const r = writeConfig(repoRoot, ['--projects', projects, '--repos', path.join(dir, 'code'), '--offset=-05:30', '--lang', 'ru', '--ignore', 'old, secret', '--config', file])
  assert.equal(r.written, file)
  const c = loadConfig(repoRoot, file)
  assert.equal(c.projectsDir, projects)
  assert.equal(c.utcOffset, -330)
  assert.deepEqual(c.ignore, ['old', 'secret'])
  assert.equal(c.digest.lang, 'ru')
  assert.deepEqual(c.unknownKeys, [])
  assert.equal(r.config.$schema, undefined, 'no schema link outside the Projium folder')
  assert.throws(() => writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', file]), /already exists/)
  writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', file, '--force'])
  assert.throws(() => writeConfig(repoRoot, ['--repos', dir, '--config', path.join(dir, 'x.json')]), /--projects and --repos are required/)
  assert.throws(() => writeConfig(repoRoot, ['--projects', path.join(dir, 'nope'), '--repos', dir, '--config', path.join(dir, 'x.json')]), /projects folder not found/)
  assert.throws(() => writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--offset', 'MSK', '--config', path.join(dir, 'x.json')]), /utcOffset/)
  assert.throws(() => writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--lang', 'de', '--config', path.join(dir, 'y.json')]), /digest.lang/)
  assert.throws(() => writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--bogus', '--config', path.join(dir, 'z.json')]), /bogus/)
  assert.ok(!fs.existsSync(path.join(dir, 'y.json')), 'a rejected config is not left behind')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'conf')), ['tracker.config.json'], 'no temp files left')
})
