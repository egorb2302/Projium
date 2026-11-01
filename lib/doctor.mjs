import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, ignoreTest, formatOffset } from './config.mjs'
import { createStore, publicError } from './store.mjs'
import { readFields, validate, mixedEndings, section, EDITABLE, STAGES } from './card.mjs'
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
    loaded = store.loadFile(name, file)
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
  const locked = loaded.locked.filter(k => c.cards.fields[k] !== null)
  if (locked.length) card.warnings.push(`read-only in the dashboard (not a plain one-line value): ${locked.join(', ')}`)
  const boxes = s => (s?.match(/^- \[[ xX]\] /gm) ?? []).length
  const outside = boxes(loaded.text) - loaded.tasks.length - boxes(section(loaded.text, store.heading.updates))
  if (outside > 0) card.warnings.push(`${outside} checkbox line(s) outside the ## ${tasksHeading} section are not shown as tasks${tasksHeading === 'Tasks' ? '; set cards.sections.tasks if the owner uses another heading' : ''}`)
  const ignored = ignoreTest(c.ignore)
  const hint = loaded.repoHint
  const isIgnored = ignored(name) || declaredRepos(c.reposDir, name, loaded.text, hint).some(p => ignored(p))
  const none = noRepo(loaded.text, hint)
  const repo = isIgnored || none ? null : repoOf(c.reposDir, name, loaded.text, ignored, hint)
  if (!repo && !isIgnored && !none)
    card.warnings.push(`no git repo found for "${name}": add "${name}": "<repo folder in reposDir>" (or "none") to cards.repos, or a repo: key to the note`)
  const transcripts = repo && transcriptsOk ? transcriptDirs(c.transcriptsDir, repo, ignored).flatMap(sessionFiles).length : 0
  const f = loaded.fields
  if (transcripts && !((f.spec_at && f.first_push_at) || (f.first_push_at && f.mainnet_at) || (f.spec_at && f.mainnet_at)))
    card.warnings.push('has Claude Code transcripts, but the time split needs two milestone times (spec_at and first_push_at, or first_push_at and mainnet_at)')
  const fieldsFrom = Object.fromEntries(EDITABLE.filter(k => loaded.fields[k] != null && loaded.fields[k] !== '').map(k => [k, c.cards.fields[k] ?? k]))
  return {
    ...card,
    fieldsFrom,
    stage: loaded.fields.stage,
    ignored: isIgnored,
    repo,
    transcripts,
    readiness: Boolean(loaded.readinessFile && fs.existsSync(loaded.readinessFile)),
    site: Boolean(loaded.fields.site),
    tasks: loaded.tasks.length,
  }
}

export const diagnose = async (here, { file, probe = whoIsOn, verbose = false } = {}) => {
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
  if (!c.file) out.problems.push('no tracker.config.json: the demo projects are shown; run npm run --silent init -- --projects <folder> --repos <folder> --offset=+HH:MM (see AGENTS.md step 4)')
  if (c.unknownKeys.length) out.problems.push(`config: unknown keys are ignored: ${c.unknownKeys.join(', ')}`)
  for (const [key, p] of [['projectsDir', c.projectsDir], ['reposDir', c.reposDir], ['transcriptsDir', c.transcriptsDir]]) out.config[`${key}State`] = dirState(p)
  if (out.config.projectsDirState !== 'ok') out.problems.push(`projectsDir ${out.config.projectsDirState}: ${c.projectsDir}`)
  if (out.config.reposDirState !== 'ok') out.problems.push(`reposDir ${out.config.reposDirState}: ${c.reposDir}`)
  const transcriptsOk = out.config.transcriptsDirState === 'ok'
  if (!transcriptsOk) out.hints.push(`transcriptsDir ${out.config.transcriptsDirState}: ${c.transcriptsDir}; the time split stays empty (pass --transcripts to init if Claude Code keeps them elsewhere)`)
  out.config.cards = c.cards
  out.filteredOut = 0
  out.filteredOutNotes = []
  const filterKeys = Object.keys(c.cards.filter ?? {})
  const onFilter = Object.entries(c.cards.fields).filter(([, v]) => filterKeys.includes(v)).map(([k]) => k)
  if (onFilter.length) out.hints.push(`cards.fields maps ${onFilter.join(', ')} onto a cards.filter key; setting it from the dashboard can move a note out of the filter`)
  if (out.config.projectsDirState === 'ok') {
    const store = createStore(c.projectsDir, { ...c.cards, readinessFile: c.readinessFile })
    const scan = store.scan()
    out.filteredOut = scan.filteredOut
    if (verbose) out.filteredOutNotes = scan.outside
    else delete out.filteredOutNotes
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
    if (scan.filteredOut)
      out.hints.push(`${scan.filteredOut} note(s) do not match cards.filter and are not shown${verbose ? ` (${scan.outside.slice(0, 5).join(', ')}${scan.filteredOut > 5 ? ', ...' : ''}; up to 20 in filteredOutNotes)` : '; run npm run --silent doctor -- --verbose to list up to 20 of them'}`)
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
  const noRepoCards = out.cards.filter(x => x.status === 'ok' && !x.repo && x.warnings.some(w => w.startsWith('no git repo found'))).map(x => x.name)
  if (noRepoCards.length && out.config.reposDirState === 'ok')
    out.hints.push(`${noRepoCards.length} project(s) have no repo: ${noRepoCards.slice(0, 10).join(', ')}. Names are matched to folders in reposDir ignoring case, spaces and punctuation; for other names add them to cards.repos, like { "${noRepoCards[0]}": "repo-folder" }, or "none" for projects without code`)
  const siteCards = out.cards.filter(x => x.site).map(x => x.name)
  if (siteCards.length)
    out.hints.push(`${siteCards.length} project(s) have a site (${siteCards.slice(0, 5).join(', ')}) read from the ${c.cards.fields.site ?? 'site'} key: Projium checks it and its /api/config every 10 minutes while the stage is not done; set cards.fields.site to null to turn that off`)
  const on = await probe(c.port, c.projectsDir)
  out.server = { url: `http://127.0.0.1:${c.port}`, running: Boolean(on.sameInstance), portBusy: Boolean(on.running && !on.sameInstance), legacy: Boolean(on.legacy), version: on.version ?? null }
  if (on.legacy) out.hints.push(`port ${c.port} answers with an older Projium that has no /api/meta. If it is an earlier run of this same folder and the owner agrees, stop that node server.mjs process by its PID, then npm run --silent start:bg; otherwise set another port`)
  else if (out.server.portBusy) out.hints.push(on.projium ? `port ${c.port} answers with another Projium (different projects folder)` : `port ${c.port} is used by another program; set port in the config before starting`)
  out.ok = out.problems.length === 0 && out.summary.ok > 0
  return out
}
