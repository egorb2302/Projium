import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, ignoreTest, formatOffset } from './config.mjs'
import { createStore, NAME, publicError } from './store.mjs'
import { readFields, validate, mixedEndings, EDITABLE, STAGES } from './card.mjs'
import { repoOf, declaredRepos, noRepo } from './repo.mjs'
import { transcriptDirs, sessionFiles } from './timesplit.mjs'
import { whoIsOn } from './control.mjs'

const dirState = p => {
  try {
    return fs.statSync(p).isDirectory() ? 'ok' : 'not a folder'
  } catch {
    return 'missing'
  }
}

const checkCard = (c, store, name, transcriptsOk) => {
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
  if (mixedEndings(loaded.text)) card.warnings.push('the card mixes CRLF and LF line endings; dashboard writes to it will fail until it is saved with one kind')
  if (loaded.locked.length) card.warnings.push(`read-only in the dashboard (not a plain one-line value): ${loaded.locked.join(', ')}`)
  const loose = loaded.tasks.filter(t => t.readonly).length
  if (loose) card.warnings.push(`${loose} task(s) without a ^t-xxxx id are read-only in the dashboard`)
  const outside = (loaded.text.match(/^- \[[ xX]\] /gm) ?? []).length - loaded.tasks.length
  if (outside > 0) card.warnings.push(`${outside} checkbox line(s) outside the ## Tasks section are not shown as tasks`)
  const ignored = ignoreTest(c.ignore)
  const isIgnored = ignored(name) || declaredRepos(c.reposDir, name, loaded.text).some(p => ignored(p))
  const none = noRepo(loaded.text)
  const repo = isIgnored || none ? null : repoOf(c.reposDir, name, loaded.text, ignored)
  if (!repo && !isIgnored && !none) card.warnings.push(`no git repo found: set repo in the frontmatter (or repo: none for a project without code), or clone it as ${path.join(c.reposDir, name)}`)
  const transcripts = repo && transcriptsOk ? transcriptDirs(c.transcriptsDir, repo, ignored).flatMap(sessionFiles).length : 0
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

export const diagnose = async (here, { file, probe = whoIsOn } = {}) => {
  const out = { ok: false, node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 24 }, config: null, cards: [], looseNotes: [], summary: null, server: null, problems: [], hints: [] }
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
  if (!c.file) out.problems.push('no tracker.config.json: the demo projects are shown; run npm run --silent init -- --projects <folder> --repos <folder>')
  if (c.unknownKeys.length) out.problems.push(`config: unknown keys are ignored: ${c.unknownKeys.join(', ')}`)
  for (const [key, p] of [['projectsDir', c.projectsDir], ['reposDir', c.reposDir], ['transcriptsDir', c.transcriptsDir]]) out.config[`${key}State`] = dirState(p)
  if (out.config.projectsDirState !== 'ok') out.problems.push(`projectsDir ${out.config.projectsDirState}: ${c.projectsDir}`)
  if (out.config.reposDirState !== 'ok') out.problems.push(`reposDir ${out.config.reposDirState}: ${c.reposDir}`)
  const transcriptsOk = out.config.transcriptsDirState === 'ok'
  if (!transcriptsOk) out.hints.push(`transcriptsDir ${out.config.transcriptsDirState}: ${c.transcriptsDir}; the time split stays empty (pass --transcripts to init if Claude Code keeps them elsewhere)`)
  if (out.config.projectsDirState === 'ok') {
    const store = createStore(c.projectsDir)
    for (const d of fs.readdirSync(c.projectsDir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      if (d.isFile() && d.name.toLowerCase().endsWith('.md')) out.looseNotes.push(d.name)
      else if (d.isSymbolicLink()) out.cards.push({ name: d.name, file: null, status: 'skipped', reason: 'the folder is a link (symlink or junction); Projium only reads real folders inside projectsDir', warnings: [] })
      else if (d.isDirectory())
        try {
          out.cards.push(checkCard(c, store, d.name, transcriptsOk))
        } catch (e) {
          out.cards.push({ name: d.name, file: `${d.name}/${d.name}.md`, status: 'error', reason: publicError(e), warnings: [] })
        }
    }
    if (out.looseNotes.length) out.hints.push(`${out.looseNotes.length} .md file(s) sit directly in projectsDir and are not read (${out.looseNotes.slice(0, 10).join(', ')}${out.looseNotes.length > 10 ? ', ...' : ''}); each project needs its own folder <name>/<name>.md`)
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
  if (out.summary.errors) out.problems.push(`${out.summary.errors} card(s) could not be read; see cards[].reason`)
  if (out.summary.skipped) out.hints.push(`${out.summary.skipped} folder(s) in projectsDir are skipped; fine if they are not projects, see cards[].reason`)
  if (out.summary.ok && out.config.reposDirState === 'ok' && !out.summary.withRepo) out.hints.push('no card is matched to a git repo; check reposDir and the repo fields')
  const on = await probe(c.port, c.projectsDir)
  out.server = { url: `http://127.0.0.1:${c.port}`, running: Boolean(on.sameInstance), portBusy: Boolean(on.running && !on.sameInstance), legacy: Boolean(on.legacy), version: on.version ?? null }
  if (on.legacy) out.hints.push(`port ${c.port} answers with an older Projium that has no /api/meta; stop its node server.mjs process by hand (or restart it from this folder's code), then npm run --silent start:bg`)
  else if (out.server.portBusy) out.hints.push(on.projium ? `port ${c.port} answers with another Projium (different projects folder)` : `port ${c.port} is used by another program; set port in the config before starting`)
  out.ok = out.problems.length === 0 && out.summary.ok > 0
  return out
}
