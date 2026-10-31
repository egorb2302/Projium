import fs from 'node:fs'
import path from 'node:path'
import {
  hashOf, readFields, readTasks, updateLines, timelineRows, validate, setField, lockedFields,
  replaceTask, addTask, formatTask, toggleLine, newTaskId, normalizeTime, timeStyle, inTimeStyle, listValue,
  STAGES, TIME_FIELDS,
} from './card.mjs'

export class Conflict extends Error {
  constructor(message, current) {
    super(message)
    this.current = current
  }
}

export const NAME = /^[\p{L}\p{N} ._()-]+$/u

export const publicError = e => (typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code) ? e.code : String(e?.message ?? e))

const sameExcept = (a, b, key) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete(key)
  return [...keys].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

const titleOf = text => {
  const lines = text.split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }
  let fence = false
  for (; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence
    else if (!fence) {
      const m = lines[i].match(/^# +(.+?)\s*#*\s*$/)
      if (m && !/^\.{1,2}$/.test(m[1].trim())) return m[1].trim()
    }
  }
  return null
}

const MAX_FILES = 20000
const MAX_DEPTH = 12
const lower = s => String(s).trim().replace(/^#/, '').toLowerCase()

export const createStore = (root, { layout = 'folder', recursive = false, filter = null, fields: fieldMap = {}, stages = {}, sections = {}, repos = {}, name: nameFrom = 'file', readinessFile = 'READINESS.md' } = {}) => {
  const heading = { tasks: sections.tasks ?? 'Tasks', updates: sections.updates ?? 'Updates', timeline: sections.timeline ?? 'Timeline' }
  const off = new Set(Object.entries(fieldMap).filter(([, v]) => v === null).map(([k]) => k))
  const keyOf = k => (off.has(k) ? null : fieldMap[k] ?? k)
  const repoHints = new Map(Object.entries(repos).map(([k, v]) => [k.toLowerCase(), v]))
  const fileIdOf = file => hashOf(path.relative(root, file).replace(/\\/g, '/').toLowerCase()).slice(0, 12)
  const stageWords = new Map(Object.entries(stages).map(([k, v]) => [lower(k), v]))
  const filterRules = filter ? Object.entries(filter).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(lower)]) : []

  const stageIn = v => (typeof v !== 'string' || STAGES.includes(v) ? v : stageWords.get(lower(v)) ?? v)
  const stageOut = (stage, existing) => {
    if (typeof existing === 'string' && existing && stageIn(existing) === stage) return existing
    return Object.entries(stages).find(([, v]) => v === stage)?.[0] ?? stage
  }

  const mapFields = raw => {
    const out = { ...raw }
    for (const [pf, ok] of Object.entries(fieldMap)) {
      if (ok === pf) continue
      delete out[pf]
      if (ok !== null && Object.hasOwn(raw, ok)) out[pf] = raw[ok]
    }
    if (typeof out.stage === 'string') out.stage = stageIn(out.stage)
    for (const k of TIME_FIELDS) if (typeof out[k] === 'string' && out[k]) out[k] = normalizeTime(out[k])
    if (!out.stage && (out.project || filterRules.length)) out.stage = 'development'
    return out
  }

  const metaCache = new Map()
  const metaOf = file => {
    const st = fs.statSync(file)
    const hit = metaCache.get(file)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit
    const text = fs.readFileSync(file, 'utf8')
    const meta = { mtime: st.mtimeMs, size: st.size, fields: readFields(text), title: titleOf(text) }
    metaCache.set(file, meta)
    return meta
  }

  const nameOf = c => {
    if (nameFrom === 'folder') return path.dirname(c.file) === root ? c.name : path.basename(path.dirname(c.file))
    if (nameFrom === 'title') return metaOf(c.file).title?.replace(/[\\/]/g, '-') || c.name
    return c.name
  }

  const matches = file => {
    if (!filterRules.length) return true
    const f = metaOf(file).fields
    return filterRules.every(([k, wants]) => {
      const have = listValue(f[k]).map(lower)
      return wants.some(w => have.includes(w))
    })
  }

  const scan = () => {
    const found = []
    const skipped = []
    let filteredOut = 0
    let truncated = false
    const entries = dir => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return []
      }
    }
    if (layout === 'folder') {
      for (const d of entries(root)) {
        if (d.name.startsWith('.')) continue
        if (d.isSymbolicLink()) {
          skipped.push({ name: d.name, file: null, reason: 'the folder is a link (symlink or junction); Projium only reads real folders inside projectsDir' })
          continue
        }
        if (!d.isDirectory()) continue
        if (!NAME.test(d.name)) {
          skipped.push({ name: d.name, file: null, card: fs.existsSync(path.join(root, d.name, `${d.name}.md`)), reason: 'folder name has characters other than letters, digits, space and . _ ( ) -; rename the folder or use cards.layout "flat"' })
          continue
        }
        const file = path.join(root, d.name, `${d.name}.md`)
        if (!fs.existsSync(file)) {
          const other = entries(path.join(root, d.name)).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).length
          skipped.push({ name: d.name, file: null, reason: `no ${d.name}/${d.name}.md${other ? ` (the folder has ${other} other .md file(s); the card file must be named like its folder, or use cards.layout "flat")` : ''}` })
          continue
        }
        found.push({ name: d.name, file })
      }
    } else {
      const walk = (dir, depth) => {
        for (const e of entries(dir)) {
          if (found.length >= MAX_FILES) {
            truncated = true
            return
          }
          if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue
          const p = path.join(dir, e.name)
          if (e.isDirectory()) {
            if (recursive && depth < MAX_DEPTH) walk(p, depth + 1)
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) found.push({ name: e.name.slice(0, -3), file: p })
        }
      }
      walk(root, 0)
    }
    const kept = []
    const outside = []
    for (const c of found) {
      try {
        if (matches(c.file)) kept.push({ ...c, name: nameOf(c) })
        else {
          filteredOut++
          if (outside.length < 20) outside.push(path.relative(root, c.file).replace(/\\/g, '/'))
        }
      } catch (e) {
        skipped.push({ name: c.name, file: c.file, reason: publicError(e) })
      }
    }
    const seen = new Set(found.map(c => c.file))
    for (const f of metaCache.keys()) if (!seen.has(f)) metaCache.delete(f)
    const byName = new Map()
    for (const c of kept) byName.set(c.name.toLowerCase(), (byName.get(c.name.toLowerCase()) ?? 0) + 1)
    const cards = new Map()
    for (const c of kept) {
      const name = byName.get(c.name.toLowerCase()) > 1 ? path.relative(root, c.file).replace(/\\/g, '/').slice(0, -3) : c.name
      cards.set(name, c.file)
    }
    lastIndex = cards
    return { cards, skipped, filteredOut, outside, truncated }
  }

  let lastIndex = new Map()
  const inRoot = file => fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)
  const sameReal = file => {
    try {
      return fs.realpathSync(file).toLowerCase() === path.resolve(fs.realpathSync(root), path.relative(root, file)).toLowerCase()
    } catch {
      return false
    }
  }

  const cardPath = name => {
    if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('bad project name')
    let file = lastIndex.get(name)
    if (!file || !fs.existsSync(file) || !sameReal(file) || !matches(file)) file = scan().cards.get(name)
    if (!file) throw new Error(`no card for ${name}`)
    if (!inRoot(file)) throw new Error(`the card for ${name} links outside the projects folder`)
    return file
  }

  const readinessPath = file => {
    const base = path.basename(file, path.extname(file))
    if (readinessFile.includes('{name}')) return path.join(path.dirname(file), readinessFile.replaceAll('{name}', base))
    return layout === 'folder' ? path.join(path.dirname(file), readinessFile) : null
  }

  const fromText = (name, file, text) => ({
    name,
    file,
    fileId: fileIdOf(file),
    repoHint: repoHints.get(name.toLowerCase()) ?? null,
    readinessFile: readinessPath(file),
    hash: hashOf(text),
    fields: mapFields(readFields(text)),
    fieldKeys: Object.fromEntries(Object.entries(fieldMap).filter(([k, v]) => k !== v)),
    locked: lockedFields(text, keyOf),
    tasks: readTasks(text, heading.tasks).map(({ line, ...t }) => t),
    updates: updateLines(text, heading.updates),
    timeline: timelineRows(text, heading.timeline),
    text,
  })

  const load = name => {
    const file = cardPath(name)
    return fromText(name, file, fs.readFileSync(file, 'utf8'))
  }

  const loadFile = (name, file) => {
    if (!inRoot(file)) throw new Error(`the card for ${name} links outside the projects folder`)
    return fromText(name, file, fs.readFileSync(file, 'utf8'))
  }

  const list = () => {
    const out = []
    const s = scan()
    for (const [name, file] of s.cards) {
      try {
        const card = loadFile(name, file)
        if (card.fields.stage) out.push(card)
      } catch (e) {
        out.push({ name, error: publicError(e) })
      }
    }
    for (const k of s.skipped) if (k.card) out.push({ name: k.name, error: k.reason })
    return out
  }

  const write = (file, before, after) => {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tracker-tmp`)
    try {
      fs.writeFileSync(tmp, after)
      if (fs.readFileSync(file, 'utf8') !== before) return false
      fs.renameSync(tmp, file)
      return true
    } catch {
      return false
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  const mutate = (name, change, fileId) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) pause(100 * attempt)
      if (fileId == null && layout === 'flat') throw new Error('writes need the fileId from the card with cards.layout "flat"; reload the page')
      const file = cardPath(name)
      if (fileId != null && fileIdOf(file) !== fileId) throw new Conflict(`${name} now refers to another note; reload the page`, null)
      const before = fs.readFileSync(file, 'utf8')
      const after = change(before)
      if (after === before) return fromText(name, file, before)
      if (write(file, before, after)) return fromText(name, file, after)
    }
    throw new Error('could not write the card (it keeps changing or is locked); try again')
  }

  const saveField = (name, key, value, expected, fileId) => {
    const err = validate(key, value)
    if (err) throw new Error(err)
    const ok = keyOf(key)
    if (ok === null) throw new Error(`${key} is turned off in cards.fields`)
    return mutate(name, text => {
      const before = readFields(text)
      const cur = mapFields(before)[key] ?? ''
      if (cur !== (expected ?? '')) throw new Conflict(`${key} was changed outside the dashboard`, cur)
      const ownerValue = value === '' ? '' : key === 'stage' ? stageOut(value, before[ok]) : TIME_FIELDS.includes(key) ? inTimeStyle(value, timeStyle(before[ok])) : value
      const after = setField(text, ok, ownerValue)
      const read = readFields(after)
      const added = Object.hasOwn(before, ok) ? 0 : 1
      if ((read[ok] ?? '') !== ownerValue || !sameExcept(before, read, ok) || after.split('\n').length !== text.split('\n').length + added || (mapFields(read)[key] ?? '') !== value)
        throw new Error(`refused: writing ${key} would change more than that field`)
      return after
    }, fileId)
  }

  const saveTask = (name, op, fileId) =>
    mutate(name, text => {
      if (op.op === 'add') return addTask(text, { ...op.task, id: newTaskId(text), done: false }, heading.tasks)
      const r = replaceTask(
        text,
        op.id,
        cur => {
          const seen = op.expected ?? {}
          if (cur.done !== seen.done || cur.text !== seen.text || cur.due !== (seen.due ?? '') || cur.p !== (seen.p ?? ''))
            throw new Conflict('the task was changed outside the dashboard', { ...cur, line: undefined })
          if (op.op === 'toggle') return toggleLine(cur.line)
          if (op.op === 'edit') return formatTask({ ...cur, ...op.task, id: cur.id, done: cur.done })
          throw new Error(`unknown task op ${op.op}`)
        },
        heading.tasks,
      )
      if (!r) throw new Conflict('the task is gone from the card', null)
      return r.text
    }, fileId)

  return { list, load, loadFile, saveField, saveTask, cardPath, scan, heading }
}
