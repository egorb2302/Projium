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
const down = async () => ({ running: false, projium: false, sameInstance: false })

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-doctor-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const withEnv = async (vars, fn) => {
  const keep = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('with no config the doctor shows the demo cards but is not ok', async () => {
  const r = await diagnose(repoRoot, { file: path.join(os.tmpdir(), 'no-such-tracker-config.json'), probe: down })
  assert.equal(r.ok, false)
  assert.equal(r.config.file, null)
  assert.equal(r.summary.ok, 4)
  assert.match(r.problems.join('\n'), /no tracker\.config\.json/)
  assert.equal(r.server.running, false)
})

test('the doctor says why each folder is skipped, flags config typos and never prints secrets', async t => {
  const dir = temp(t)
  const projects = path.join(dir, 'vault', 'Projects')
  const repos = path.join(dir, 'code')
  fs.mkdirSync(path.join(repos, 'alpha', '.git'), { recursive: true })
  put(path.join(projects, 'alpha', 'alpha.md'), '---\nstage: fixes\napi_key: "sk-NEVER-SHOWN"\n---\n\n## Tasks\n\n- [ ] ok task · p1 ^t-aaaa\n- [ ] loose task\n')
  put(path.join(projects, 'beta', 'notes.md'), '---\nstage: review\n---\n')
  put(path.join(projects, 'gamma', 'gamma.md'), '# gamma\n\nno frontmatter\n')
  put(path.join(projects, 'delta', 'delta.md'), '---\nstatus: active\n---\n')
  put(path.join(projects, 'eps', 'eps.md'), '---\nstage: in-progress\nspec_at: yesterday\n---\n')
  put(path.join(projects, 'zeta', 'zeta.md'), '---\nstage: done\nrepo: none\n---\r\n\n## Next\n\n- [ ] not a task\n- [x] old\n\n## Tasks\n\n- [ ] real · p2 ^t-zzzz\n')
  put(path.join(projects, 'a#b', 'a#b.md'), '---\nstage: fixes\n---\n')
  put(path.join(projects, 'flat-note.md'), '---\nstage: fixes\n---\n')
  put(path.join(dir, 'elsewhere', 'linked', 'linked.md'), '---\nstage: fixes\n---\n')
  fs.symlinkSync(path.join(dir, 'elsewhere', 'linked'), path.join(projects, 'linked'), 'junction')
  const file = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: repos, projectDir: 'typo', digest: { when: '9:00' } }))

  const r = await withEnv({ TELEGRAM_BOT_TOKEN: '123:SECRET-TG-TOKEN', TELEGRAM_CHAT_ID: '42' }, () => diagnose(repoRoot, { file, probe: down }))
  assert.equal(r.ok, false)
  assert.equal(r.config.digest.channel, 'telegram')
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
  assert.match(by.eps.warnings.join('\n'), /stage: "in-progress" is not a Projium stage; add it to cards\.stages/)
  assert.match(by.eps.warnings.join('\n'), /spec_at: time must be/)
  assert.match(by.eps.warnings.join('\n'), /no git repo found/)
  assert.doesNotMatch(by.zeta.warnings.join('\n'), /no git repo found/, 'repo: none means no repo by design')
  assert.match(by.zeta.warnings.join('\n'), /mixes CRLF and LF/)
  assert.match(by.zeta.warnings.join('\n'), /2 checkbox line\(s\) outside the ## Tasks section/)
  assert.doesNotMatch(by.alpha.warnings.join('\n'), /outside the ## Tasks/)
  assert.equal(by['a#b'].status, 'skipped')
  assert.equal(by.linked.status, 'skipped')
  assert.match(by.linked.reason, /is a link/)
  assert.deepEqual(r.looseNotes, ['flat-note.md'])
  assert.match(r.hints.join('\n'), /1 \.md file\(s\) sit directly in projectsDir and are not read \(flat-note\.md\)/)
  const text = JSON.stringify(r)
  assert.ok(!text.includes('NEVER-SHOWN'), 'card values outside the known fields are never printed')
  assert.ok(!text.includes('SECRET-TG'), 'the Telegram token is never printed')

  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, reposDir: repos }))
  const fixed = await diagnose(repoRoot, { file, probe: async () => ({ running: true, projium: true, sameInstance: true, version: '9.9.9' }) })
  assert.deepEqual(fixed.problems, [])
  assert.equal(fixed.ok, true)
  assert.equal(fixed.server.running, true)
  assert.equal(fixed.summary.ok, 3)

  const other = await diagnose(repoRoot, { file, probe: async () => ({ running: true, projium: false, sameInstance: false }) })
  assert.equal(other.server.running, false)
  assert.equal(other.server.portBusy, true)
  assert.match(other.hints.join('\n'), /used by another program/)
})

test('a broken config, a missing folder or a transcripts path that is a file are reported, not thrown', async t => {
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

  put(path.join(dir, 'p', 'alpha', 'alpha.md'), '---\nstage: fixes\n---\n')
  fs.mkdirSync(path.join(dir, 'code', 'alpha', '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'transcripts-file'), 'x')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'p'), reposDir: path.join(dir, 'code-missing'), transcriptsDir: path.join(dir, 'transcripts-file') }))
  const repos = await diagnose(repoRoot, { file, probe: down })
  assert.equal(repos.ok, false)
  assert.match(repos.problems.join('\n'), /reposDir missing/)
  assert.match(repos.hints.join('\n'), /transcriptsDir not a folder/)

  fs.writeFileSync(file, JSON.stringify({ projectsDir: path.join(dir, 'p'), reposDir: path.join(dir, 'code'), transcriptsDir: path.join(dir, 'transcripts-file') }))
  const fine = await diagnose(repoRoot, { file, probe: down })
  assert.equal(fine.ok, true, 'a missing transcripts folder only disables the time split')
  assert.equal(fine.cards[0].repo, path.join(dir, 'code', 'alpha'))
})

test('init writes a config that loads, keeps a backup on --force and rejects bad input', t => {
  const dir = temp(t)
  const projects = path.join(dir, 'Projects')
  fs.mkdirSync(projects)
  fs.mkdirSync(path.join(dir, 'code'))
  const file = path.join(dir, 'conf', 'tracker.config.json')
  const r = writeConfig(repoRoot, ['--projects', 'Projects', '--repos', 'code', '--offset=-05:30', '--lang', 'ru', '--ignore', 'old, secret', '--config', file], dir)
  assert.equal(r.written, file)
  const c = loadConfig(repoRoot, file)
  assert.equal(c.projectsDir, projects, 'relative paths resolve from where the command was run')
  assert.equal(c.utcOffset, -330)
  assert.deepEqual(c.ignore, ['old', 'secret'])
  assert.equal(c.digest.lang, 'ru')
  assert.deepEqual(c.unknownKeys, [])
  assert.equal(r.config.$schema, undefined, 'no schema link outside the Projium folder')
  assert.throws(() => writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', file], dir), /already exists\. Run npm run --silent doctor/)
  const custom = { ...JSON.parse(fs.readFileSync(file, 'utf8')), streak: { repo: 'x' } }
  fs.writeFileSync(file, JSON.stringify(custom))
  const forced = writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', file, '--force'], dir)
  assert.match(forced.backup, /tracker\.config\.json\.bak-\d{8}T\d{6}/)
  assert.deepEqual(JSON.parse(fs.readFileSync(forced.backup, 'utf8')).streak, { repo: 'x' })
  const again = writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', file, '--force', '--port', '3999'], dir)
  assert.notEqual(again.backup, forced.backup)
  assert.deepEqual(JSON.parse(fs.readFileSync(forced.backup, 'utf8')).streak, { repo: 'x' }, 'a second --force never overwrites the first backup')
  const bad = (args, reason) => assert.throws(() => writeConfig(repoRoot, [...args, '--config', path.join(dir, 'x.json')], dir), reason)
  bad(['--repos', dir], /--projects and --repos are required/)
  bad(['--projects', path.join(dir, 'nope'), '--repos', dir], /--projects folder not found/)
  bad(['--projects', projects, '--repos', path.join(dir, 'nope')], /--repos folder not found/)
  bad(['--projects', projects, '--repos', dir, '--offset', 'MSK'], /utcOffset/)
  bad(['--projects', projects, '--repos', dir, '--lang', 'de'], /digest.lang/)
  bad(['--projects', projects, '--repos', dir, '--port', 'abc'], /--port must be a number/)
  bad(['--projects', projects, '--repos', dir, '--port', '70000'], /--port must be a number/)
  bad(['--projects', projects, '--repos', dir, '--bogus'], /bogus/)
  assert.ok(!fs.existsSync(path.join(dir, 'x.json')), 'a rejected config is not left behind')
  assert.equal(fs.readdirSync(path.join(dir, 'conf')).filter(f => f.includes('.tmp-')).length, 0, 'no temp files left')
  assert.equal(fs.readdirSync(path.join(dir, 'conf')).length, 3)
  const mapped = writeConfig(repoRoot, ['--projects', projects, '--repos', dir, '--config', path.join(dir, 'mapped.json'), '--layout', 'flat', '--recursive', '--filter', 'type=client-project', '--filter', 'type=project', '--field', 'stage=status', '--field', 'spec_at=started', '--stage', 'in progress=development', '--stage', 'a=b=review', '--tasks-heading', 'Todo'], dir)
  assert.deepEqual(mapped.config.cards, { layout: 'flat', recursive: true, filter: { type: ['client-project', 'project'] }, fields: { stage: 'status', spec_at: 'started' }, stages: { 'in progress': 'development', 'a=b': 'review' }, sections: { tasks: 'Todo' } })
  assert.deepEqual(loadConfig(repoRoot, path.join(dir, 'mapped.json')).cards.fields, { stage: 'status', spec_at: 'started' })
  bad(['--projects', projects, '--repos', dir, '--field', 'stage'], /--field takes key=value/)
  bad(['--projects', projects, '--repos', dir, '--stage', 'live=launched'], /cards\.stages\["live"\] must be one of/)
  bad(['--projects', projects, '--repos', dir, '--layout', 'tree'], /cards\.layout/)
  const rel = path.relative(os.homedir(), projects)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    const viaHome = writeConfig(repoRoot, ['--projects', `~/${rel.replace(/\\/g, '/')}`, '--repos', dir, '--config', path.join(dir, 'home.json')], dir)
    assert.equal(path.resolve(viaHome.config.projectsDir), projects, '~ expands to the home folder')
  }
})
