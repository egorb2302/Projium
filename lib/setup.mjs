import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { survey } from './survey.mjs'
import { readFields, listValue, STAGES } from './card.mjs'
import { loadConfig, formatOffset, expandHome } from './config.mjs'
import { saveConfig } from './init.mjs'
import { createStore, publicError } from './store.mjs'
import { whoIsOn } from './control.mjs'

const isDir = p => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const defaultConfigFile = (here, { env = process.env, home = os.homedir() } = {}) => {
  if (env.TRACKER_CONFIG) return path.resolve(env.TRACKER_CONFIG)
  const local = path.join(here, 'tracker.config.json')
  if (fs.existsSync(local) || !here.split(path.sep).includes('node_modules')) return local
  return path.join(home, '.projium', 'tracker.config.json')
}

export const obsidianVaults = ({ home = os.homedir(), env = process.env, platform = process.platform } = {}) => {
  const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || path.join(home, '.config')
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, 'obsidian', 'obsidian.json'), 'utf8'))
    return [...new Set(Object.values(j?.vaults ?? {}).map(v => v?.path).filter(p => typeof p === 'string' && isDir(p)))]
  } catch {
    return []
  }
}

const STATUS_KEYS = ['stage', 'status', 'state', 'phase']
const PROJECT_DIR = /proj|client|work|portfolio|career|проект|клиент|работ|заказ/i
const MAX_PEEK = 3000

const notesIn = (dir, depth = 6) => {
  const out = []
  const walk = (d, n) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_PEEK) return
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue
      const p = path.join(d, e.name)
      if (e.isDirectory() && n < depth) walk(p, n + 1)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p)
    }
  }
  walk(dir, 0)
  return out
}

const hasStatus = file => {
  try {
    const f = readFields(fs.readFileSync(file, 'utf8'))
    return STATUS_KEYS.some(k => typeof f[k] === 'string' && f[k].trim())
  } catch {
    return false
  }
}

export const noteFolders = roots => {
  const out = []
  for (const root of roots) {
    const notes = notesIn(root).map(file => ({ file, status: hasStatus(file) }))
    const stat = dir => {
      const own = notes.filter(n => n.file.startsWith(dir + path.sep))
      return { dir, notes: own.length, withStatus: own.filter(n => n.status).length }
    }
    out.push(stat(root))
    let subs = []
    try {
      subs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'))
    } catch {}
    for (const d of subs) {
      const p = path.join(root, d.name)
      const s = stat(p)
      if (PROJECT_DIR.test(d.name) || (s.withStatus >= 2 && s.withStatus * 2 >= s.notes)) out.push(s)
      if (PROJECT_DIR.test(d.name))
        try {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && PROJECT_DIR.test(e.name)) out.push(stat(path.join(p, e.name)))
        } catch {}
    }
  }
  const score = s => s.withStatus - 0.1 * (s.notes - s.withStatus)
  const seen = new Set()
  return out
    .filter(s => s.notes && !seen.has(s.dir.toLowerCase()) && seen.add(s.dir.toLowerCase()))
    .sort((a, b) => score(b) - score(a) || b.dir.length - a.dir.length)
}

const REPO_HOMES = ['code', 'Code', 'projects', 'Projects', 'src', 'dev', 'Developer', 'repos', 'git', 'GitHub', 'work', path.join('Documents', 'GitHub'), path.join('Documents', 'Projects'), path.join('source', 'repos'), 'Desktop']

export const repoFolders = (extra = [], { home = os.homedir() } = {}) => {
  const seen = new Set()
  const out = []
  for (const dir of [...extra, ...REPO_HOMES.map(d => path.join(home, d))]) {
    const key = path.resolve(dir).toLowerCase()
    if (seen.has(key) || !isDir(dir)) continue
    seen.add(key)
    let repos = 0
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git'))) repos++
    } catch {}
    if (repos) out.push({ dir: path.resolve(dir), repos })
  }
  return out.sort((a, b) => b.repos - a.repos)
}

const DONE = /done|shipped|complete|finish|closed|archiv|deliver|cancel|abandon|dropped|готов|сдан|закрыт|заверш|архив|отмен/i
const REVIEW = /review|wait|feedback|hold|pending|blocked|approv|ревью|ожида|пауз|соглас|провер/i
const FIXES = /fix|bug|revis|правк|исправ|доработ|баг/i

export const guessStage = word => {
  const w = String(word).trim().toLowerCase()
  if (STAGES.includes(w)) return w
  return DONE.test(w) ? 'done' : FIXES.test(w) ? 'fixes' : REVIEW.test(w) ? 'review' : 'development'
}

export const propose = s => {
  const keys = new Map(s.keys.map(k => [k.key, k]))
  const cards = {}
  if (s.notes && s.layoutHint !== 'folder') cards.layout = 'flat'
  if (s.notes && s.layoutHint === 'flat-recursive') cards.recursive = true
  const stageKey = keys.has('stage') ? 'stage' : STATUS_KEYS.filter(k => keys.has(k)).sort((a, b) => keys.get(b).notes - keys.get(a).notes)[0] ?? null
  const fields = {}
  if (stageKey && stageKey !== 'stage') fields.stage = stageKey
  const words = (stageKey && keys.get(stageKey).values?.map(v => v.value).filter(v => v.trim() && !STAGES.includes(v.trim().toLowerCase()))) ?? []
  const stages = Object.fromEntries(words.map(w => [w, guessStage(w)]))
  if (keys.has('site')) fields.site = null
  const top = s.checkboxHeadings.filter(h => h.usable && h.heading.trim() && !/[#\r\n]/.test(h.heading))[0]
  const tasks = top && top.checkboxes >= 2 && !s.checkboxHeadings.some(h => h.usable && h.heading.toLowerCase() === 'tasks') ? top.heading : null
  if (Object.keys(fields).length) cards.fields = fields
  if (Object.keys(stages).length) cards.stages = stages
  if (tasks) cards.sections = { tasks }
  return {
    cards,
    stageKey,
    hiddenStageWords: Boolean(stageKey && !keys.get(stageKey).values),
    sites: keys.get('site')?.notes ?? 0,
    tasks,
  }
}

const unquote = s => String(s ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')

const pick = async (io, title, options, describe, flag, cwd) => {
  if (io.yes && !options.length) throw new Error(`nothing found to pick from; pass ${flag} <folder>`)
  if (options.length) {
    io.say(title)
    options.forEach((o, i) => io.say(`  ${i + 1}) ${describe(o)}`))
  }
  for (let empty = 0; ; ) {
    const a = unquote(await io.ask(options.length ? `Type a number or a folder path [1]: ` : `${title}\n  Folder path: `))
    if (!a && options.length) return options[0].dir
    if (/^\d+$/.test(a) && options[Number(a) - 1]) return options[Number(a) - 1].dir
    const p = a && path.resolve(cwd, expandHome(a))
    if (p && isDir(p)) return p
    if (io.yes || io.ended?.() || (!a && ++empty >= 3)) throw new Error(a ? `folder not found: ${p}` : `no folder given; pass ${flag} <folder>`)
    io.say(a ? `  Not a folder: ${p}` : '  Type a folder path.')
  }
}

export const filterHint = (dir, stageKey, recursive) => {
  const notes = notesIn(dir, recursive ? 8 : 0).map(file => {
    try {
      return readFields(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  })
  const staged = notes.filter(f => typeof f[stageKey] === 'string' && f[stageKey].trim())
  let best = null
  for (const key of ['type', 'category', 'kind', 'tags', 'tag']) {
    const counts = new Map()
    for (const f of staged) for (const v of new Set(listValue(f[key]).map(s => s.trim().replace(/^#/, '')).filter(Boolean))) counts.set(v, (counts.get(v) ?? 0) + 1)
    for (const [value, n] of counts) if (n >= 2 && n >= 0.6 * staged.length && n < staged.length && (!best || n > best.n)) best = { key, value, n, out: staged.length - n }
  }
  return best
}

const yesNo = async (io, q, dflt) => {
  const a = (await io.ask(`${q} [${dflt ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
  return a ? a.startsWith('y') || a.startsWith('д') : dflt
}

const freePort = async (projectsDir, from = 3210, probe = whoIsOn) => {
  for (let p = from; p < from + 30; p++) {
    const on = await probe(p, projectsDir, 1500)
    if (!on.running || on.sameInstance) return p
  }
  return from
}

export const runSetup = async ({ here, file, io, notes = null, repos = null, port = null, cwd = process.cwd(), home = os.homedir(), env = process.env, platform = process.platform, probe = whoIsOn, lang = Intl.DateTimeFormat().resolvedOptions().locale }) => {
  io.say('Projium setup: a local dashboard over your project notes. Nothing in your notes is changed.\n')
  if (fs.existsSync(file) && !(await yesNo(io, `A config already exists at ${file}. Replace it? The current one is kept as a backup.`, false))) return { file, kept: true }

  io.say('Step 1 of 3. Where are your project notes?')
  const vaults = obsidianVaults({ home, env, platform })
  const notesDir = notes
    ? path.resolve(cwd, expandHome(notes))
    : await pick(io, vaults.length ? 'Found these note folders:' : 'No Obsidian vault found. Type the folder with your project notes (any folder of .md files).', noteFolders(vaults), o => `${o.dir}  (${o.notes} notes, ${o.withStatus} with a status)`, '--notes', cwd)
  if (!isDir(notesDir)) throw new Error(`folder not found: ${notesDir}`)
  const s = survey(notesDir)
  const plan = propose(s)
  io.say(`\n  ${s.notes} notes in ${notesDir}.`)
  io.say(plan.stageKey ? `  Projects are notes with a "${plan.stageKey}" field${plan.cards.layout === 'flat' ? '' : ', one folder per project (<name>/<name>.md)'}.` : '  No notes with a stage or status yet: start with an empty list and add projects from the dashboard.')
  const stages = plan.cards.stages ?? {}
  if (Object.keys(stages).length) {
    io.say('  Their words, read as Projium stages (development, review, fixes, done):')
    for (const [w, st] of Object.entries(stages)) io.say(`    ${w} -> ${st}`)
    if (!io.yes && !(await yesNo(io, '  Keep these?', true)))
      for (const w of Object.keys(stages)) {
        for (;;) {
          const a = (await io.ask(`    "${w}" is [${stages[w]}] (development, review, fixes, done): `)).trim().toLowerCase()
          if (!a) break
          if (STAGES.includes(a)) {
            stages[w] = a
            break
          }
        }
      }
  }
  if (plan.hiddenStageWords) io.say(`  The "${plan.stageKey}" field has many different values; map them later in tracker.config.json (cards.stages). npm run --silent doctor lists them.`)
  const hint = plan.stageKey && plan.cards.layout === 'flat' ? filterHint(notesDir, plan.stageKey, Boolean(plan.cards.recursive)) : null
  if (hint && (await yesNo(io, `  ${hint.out} note(s) with a "${plan.stageKey}" field have no "${hint.key}: ${hint.value}", like the other ${hint.n} (daily or reference notes?). Count only notes with ${hint.key}: ${hint.value} as projects?`, true)))
    plan.cards.filter = { [hint.key]: hint.value }
  if (plan.tasks) io.say(`  Tasks are read from the "## ${plan.tasks}" section.`)
  if (plan.sites && (await yesNo(io, `  ${plan.sites} note(s) have a site field. Check those sites every 10 minutes for uptime?`, false))) delete plan.cards.fields.site
  if (plan.cards.fields && !Object.keys(plan.cards.fields).length) delete plan.cards.fields

  io.say('\nStep 2 of 3. Where do you clone the project repos? (optional: Enter on an empty list skips it)')
  const found = repoFolders([path.dirname(notesDir)], { home })
  let reposDir = repos ? path.resolve(cwd, expandHome(repos)) : null
  if (!reposDir && found.length) reposDir = await pick(io, 'Found these folders with git repos:', found, o => `${o.dir}  (${o.repos} repos)`, '--repos', cwd)
  else if (!reposDir && !io.yes) {
    const a = unquote(await io.ask('  Folder path (Enter to skip): '))
    reposDir = a ? path.resolve(cwd, expandHome(a)) : null
  }
  if (reposDir && !isDir(reposDir)) throw new Error(`folder not found: ${reposDir}`)

  io.say('\nStep 3 of 3. Time zone and port')
  const offset = formatOffset(-new Date().getTimezoneOffset())
  let utcOffset = offset
  for (;;) {
    const a = (await io.ask(`  Times in your notes are in UTC${offset} (this computer's zone). Enter to keep, or type another like +03:00: `)).trim()
    if (!a) break
    if (/^[+-]\d{2}:\d{2}$/.test(a)) {
      utcOffset = a
      break
    }
    if (io.yes) break
  }
  const chosenPort = port ?? (await freePort(notesDir, 3210, probe))
  if (port == null && chosenPort !== 3210) io.say(`  Port 3210 is taken, using ${chosenPort}.`)
  const outside = path.dirname(path.resolve(file)) !== path.resolve(here)
  const config = {
    ...(outside ? {} : { $schema: './tracker.config.schema.json' }),
    projectsDir: notesDir.replace(/\\/g, '/'),
    ...(reposDir ? { reposDir: reposDir.replace(/\\/g, '/') } : {}),
    ...(outside ? { dbFile: 'data/tracker.db' } : {}),
    port: chosenPort,
    utcOffset,
    digest: { at: '10:00', lang: /^ru\b/i.test(lang) ? 'ru' : 'en' },
    ...(Object.keys(plan.cards).length ? { cards: plan.cards } : {}),
  }
  const backup = saveConfig(here, file, config)
  io.say(`\nSaved ${file}${backup ? ` (the old one is ${path.basename(backup)})` : ''}.`)
  const c = loadConfig(here, file)
  const store = createStore(c.projectsDir, { ...c.cards, readinessFile: c.readinessFile })
  let shown = store.list().filter(x => !x.error)
  io.say(`Projium shows ${shown.length} project(s)${shown.length ? `: ${shown.slice(0, 8).map(x => x.name).join(', ')}${shown.length > 8 ? ', ...' : ''}` : ''}.`)
  if (!shown.length && !io.yes) {
    const name = (await io.ask('Name of a first project to add a card for (Enter to skip): ')).trim()
    if (name)
      try {
        const card = store.create(name)
        io.say(`Created ${path.relative(c.projectsDir, card.file)} in your projects folder.`)
        shown = [card]
      } catch (e) {
        io.say(`Could not create it: ${publicError(e)}`)
      }
  }
  return { file, config, backup, projects: shown.length }
}

export const lineReader = (input, output) => {
  const queue = []
  const waiting = []
  let buf = ''
  let ended = false
  input.setEncoding?.('utf8')
  input.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (waiting.length) waiting.shift()(l)
      else queue.push(l)
    }
  })
  input.on('end', () => {
    ended = true
    if (buf) queue.push(buf)
    buf = ''
    while (waiting.length) waiting.shift()(queue.shift() ?? '')
  })
  return {
    ended: () => ended && !queue.length,
    say: s => output.write(`${s}\n`),
    ask: q => {
      output.write(q)
      if (queue.length) {
        const a = queue.shift()
        if (!output.isTTY) output.write(`${a}\n`)
        return Promise.resolve(a)
      }
      if (ended) {
        output.write('\n')
        return Promise.resolve('')
      }
      return new Promise(r => waiting.push(a => {
        if (!output.isTTY) output.write(`${a}\n`)
        r(a)
      }))
    },
    close: () => input.pause?.(),
  }
}
