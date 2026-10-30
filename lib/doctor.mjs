import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { loadConfig, ignoreTest, formatOffset } from './config.mjs'
import { createStore, NAME, publicError } from './store.mjs'
import { readFields, validate, EDITABLE, STAGES } from './card.mjs'
import { repoOf, declaredRepos } from './repo.mjs'
import { transcriptDirs, sessionFiles } from './timesplit.mjs'

const dirState = p => {
  try {
    return fs.statSync(p).isDirectory() ? 'ok' : 'not a folder'
  } catch {
    return 'missing'
  }
}

export const serverUp = port =>
  new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/digest', headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })

const checkCard = (c, store, name) => {
  const card = { name, file: `${name}/${name}.md`, status: 'ok', reason: null, warnings: [] }
  if (!NAME.test(name) || name.includes('..')) return { ...card, status: 'skipped', reason: 'folder name has characters other than letters, digits, space and . _ ( ) -' }
  const file = path.join(c.projectsDir, name, `${name}.md`)
  if (!fs.existsSync(file)) {
    let other = []
    try {
      other = fs.readdirSync(path.join(c.projectsDir, name)).filter(f => f.toLowerCase().endsWith('.md'))
    } catch {}
    return { ...card, status: 'skipped', reason: `no ${name}/${name}.md${other.length ? ` (the folder has ${other.length} other .md file(s); the card file must be named like its folder)` : ''}` }
  }
  let loaded
  try {
    loaded = store.load(name)
  } catch (e) {
    return { ...card, status: 'error', reason: publicError(e) }
  }
  const raw = readFields(loaded.text)
  if (!Object.keys(raw).length) return { ...card, status: 'skipped', reason: 'no YAML frontmatter; add a --- block with at least stage: development' }
  if (!loaded.fields.stage) return { ...card, status: 'skipped', reason: `no stage field in the frontmatter; add stage: ${STAGES.join(' | ')}` }
  for (const key of EDITABLE) {
    const v = loaded.fields[key]
    if (v == null || v === '') continue
    const err = typeof v === 'string' ? validate(key, v) : `${key} must be a single value`
    if (err) card.warnings.push(`${key}: ${err}`)
  }
  if (loaded.locked.length) card.warnings.push(`read-only in the dashboard (not a plain one-line value): ${loaded.locked.join(', ')}`)
  const loose = loaded.tasks.filter(t => t.readonly).length
  if (loose) card.warnings.push(`${loose} task(s) without a ^t-xxxx id are read-only in the dashboard`)
  const ignored = ignoreTest(c.ignore)
  const isIgnored = ignored(name) || declaredRepos(c.reposDir, name, loaded.text).some(p => ignored(p))
  const repo = isIgnored ? null : repoOf(c.reposDir, name, loaded.text, ignored)
  if (!repo && !isIgnored) card.warnings.push(`no git repo found: set repo in the frontmatter, or clone it as ${path.join(c.reposDir, name)}`)
  const transcripts = repo ? transcriptDirs(c.transcriptsDir, repo, ignored).flatMap(sessionFiles).length : 0
  return {
    ...card,
    stage: loaded.fields.stage,
    ignored: isIgnored,
    repo,
    transcripts,
    readiness: fs.existsSync(path.join(c.projectsDir, name, c.readinessFile)),
    site: Boolean(loaded.fields.site),
    tasks: loaded.tasks.length,
  }
}

export const diagnose = async (here, { file, probe = serverUp } = {}) => {
  const out = { ok: false, node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 24 }, config: null, cards: [], looseNotes: 0, summary: null, server: null, problems: [] }
  if (!out.node.ok) out.problems.push(`Node ${process.versions.node} is too old; install Node 24 or newer`)
  let c
  try {
    c = loadConfig(here, file)
  } catch (e) {
    out.config = { ok: false, error: String(e?.message ?? e) }
    out.problems.push(`config: ${out.config.error}`)
    return out
  }
  out.config = {
    ok: !c.unknownKeys.length,
    file: c.file,
    unknownKeys: c.unknownKeys,
    projectsDir: c.projectsDir,
    reposDir: c.reposDir,
    transcriptsDir: c.transcriptsDir,
    port: c.port,
    utcOffset: formatOffset(c.utcOffset),
    readinessFile: c.readinessFile,
    ignore: c.ignore,
    reviewAgents: c.reviewAgents,
    digest: { at: c.digest.at, lang: c.digest.lang, channel: c.digest.command ? 'command' : c.digest.telegram ? 'telegram' : 'none' },
    streak: Boolean(c.streak),
  }
  if (!c.file) out.problems.push('no tracker.config.json: the demo projects are shown; run npm run init -- --projects <folder> --repos <folder>')
  if (c.unknownKeys.length) out.problems.push(`config: unknown keys are ignored: ${c.unknownKeys.join(', ')}`)
  for (const [key, p] of [['projectsDir', c.projectsDir], ['reposDir', c.reposDir], ['transcriptsDir', c.transcriptsDir]]) {
    const s = dirState(p)
    out.config[`${key}State`] = s
    if (s !== 'ok' && key === 'projectsDir') out.problems.push(`projectsDir ${s}: ${p}`)
  }
  if (out.config.projectsDirState === 'ok') {
    const store = createStore(c.projectsDir)
    for (const d of fs.readdirSync(c.projectsDir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.looseNotes++
      if (d.isDirectory()) out.cards.push(checkCard(c, store, d.name))
    }
    if (out.looseNotes) out.problems.push(`${out.looseNotes} .md file(s) sit directly in projectsDir and are not read; each project needs its own folder <name>/<name>.md`)
  }
  const count = s => out.cards.filter(x => x.status === s).length
  out.summary = {
    folders: out.cards.length,
    ok: count('ok'),
    skipped: count('skipped'),
    errors: count('error'),
    withWarnings: out.cards.filter(x => x.warnings.length).length,
    withRepo: out.cards.filter(x => x.repo).length,
    withTranscripts: out.cards.filter(x => x.transcripts).length,
  }
  if (out.config.projectsDirState === 'ok' && !out.summary.ok) out.problems.push('no project cards are shown; see cards[].reason')
  out.server = { url: `http://127.0.0.1:${c.port}`, running: await probe(c.port) }
  out.ok = out.node.ok && Boolean(c.file) && out.config.ok && out.config.projectsDirState === 'ok' && out.summary.ok > 0 && out.summary.errors === 0
  return out
}
