import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, ignoreTest, formatOffset } from './config.mjs'
import { createStore, publicError } from './store.mjs'
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

const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/')

const checkCard = (c, store, name, file, transcriptsOk) => {
  const card = { name, file: rel(c.projectsDir, file), status: 'ok', reason: null, warnings: [] }
  const stageKey = c.cards.fields.stage ?? 'stage'
  const tasksHeading = store.heading.tasks
  let loaded
  try {
    loaded = store.load(name)
  } catch (e) {
    return { ...card, status: 'error', reason: publicError(e) }
  }
  const raw = readFields(loaded.text)
  if (!Object.keys(raw).length && !c.cards.filter) return { ...card, status: 'skipped', reason: `no YAML frontmatter; add a --- block with at least ${stageKey}: development` }
  if (!loaded.fields.stage) return { ...card, status: 'skipped', reason: `no ${stageKey} field in the frontmatter; add ${stageKey}: ${STAGES.join(' | ')}, map another key with cards.fields.stage, or set cards.filter so matching notes count as projects` }
  for (const key of EDITABLE) {
    const v = loaded.fields[key]
    if (v == null || v === '') continue
    const owner = c.cards.fields[key] ?? key
    const err = typeof v === 'string' ? validate(key, v) : `${key} must be a single value`
    if (err && key === 'stage') card.warnings.push(`${owner}: "${v}" is not a Projium stage; add it to cards.stages, like { "${v}": "development" }`)
    else if (err) card.warnings.push(`${owner}${owner !== key ? ` (${key})` : ''}: ${err}`)
  }
  if (mixedEndings(loaded.text)) card.warnings.push('the card mixes CRLF and LF line endings; dashboard writes to it will fail until it is saved with one kind')
  if (loaded.locked.length) card.warnings.push(`read-only in the dashboard (not a plain one-line value): ${loaded.locked.join(', ')}`)
  const loose = loaded.tasks.filter(t => t.readonly).length
  if (loose) card.warnings.push(`${loose} task(s) without a ^t-xxxx id are read-only in the dashboard`)
  const outside = (loaded.text.match(/^- \[[ xX]\] /gm) ?? []).length - loaded.tasks.length
  if (outside > 0) card.warnings.push(`${outside} checkbox line(s) outside the ## ${tasksHeading} section are not shown as tasks${tasksHeading === 'Tasks' ? '; set cards.sections.tasks if the owner uses another heading' : ''}`)
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
    readiness: Boolean(loaded.readinessFile && fs.existsSync(loaded.readinessFile)),
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
  out.config.cards = { layout: c.cards.layout, recursive: c.cards.recursive, filter: c.cards.filter, fields: c.cards.fields, stages: c.cards.stages, sections: c.cards.sections }
  out.filteredOut = 0
  if (out.config.projectsDirState === 'ok') {
    const store = createStore(c.projectsDir, { ...c.cards, readinessFile: c.readinessFile })
    const scan = store.scan()
    out.filteredOut = scan.filteredOut
    for (const s of scan.skipped) out.cards.push({ name: s.name, file: s.file ? rel(c.projectsDir, s.file) : null, status: 'skipped', reason: s.reason, warnings: [] })
    for (const [name, file] of scan.cards)
      try {
        out.cards.push(checkCard(c, store, name, file, transcriptsOk))
      } catch (e) {
        out.cards.push({ name, file: rel(c.projectsDir, file), status: 'error', reason: publicError(e), warnings: [] })
      }
    if (scan.truncated) out.hints.push('projectsDir holds more than 20000 notes; only the first 20000 were read. Point projectsDir at a narrower folder')
    if (c.cards.layout === 'folder')
      for (const d of fs.readdirSync(c.projectsDir, { withFileTypes: true })) if (!d.name.startsWith('.') && d.isFile() && d.name.toLowerCase().endsWith('.md')) out.looseNotes.push(d.name)
    if (out.looseNotes.length) out.hints.push(`${out.looseNotes.length} .md file(s) sit directly in projectsDir and are not read (${out.looseNotes.slice(0, 10).join(', ')}${out.looseNotes.length > 10 ? ', ...' : ''}); with cards.layout "folder" each project needs its own folder <name>/<name>.md, or switch to cards.layout "flat"`)
    if (scan.filteredOut) out.hints.push(`${scan.filteredOut} note(s) do not match cards.filter and are not shown`)
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
  if (out.summary.skipped) out.hints.push(`${out.summary.skipped} folder(s) or note(s) in projectsDir are skipped; fine if they are not projects, see cards[].reason`)
  if (out.summary.ok && out.config.reposDirState === 'ok' && !out.summary.withRepo) out.hints.push('no card is matched to a git repo; check reposDir and the repo fields')
  const on = await probe(c.port, c.projectsDir)
  out.server = { url: `http://127.0.0.1:${c.port}`, running: Boolean(on.sameInstance), portBusy: Boolean(on.running && !on.sameInstance), legacy: Boolean(on.legacy), version: on.version ?? null }
  if (on.legacy) out.hints.push(`port ${c.port} answers with an older Projium that has no /api/meta; stop its node server.mjs process by hand (or restart it from this folder's code), then npm run --silent start:bg`)
  else if (out.server.portBusy) out.hints.push(on.projium ? `port ${c.port} answers with another Projium (different projects folder)` : `port ${c.port} is used by another program; set port in the config before starting`)
  out.ok = out.problems.length === 0 && out.summary.ok > 0
  return out
}
