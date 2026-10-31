import fs from 'node:fs'
import path from 'node:path'
import { readFields, listValue } from './card.mjs'

const SECRET = /key|token|secret|pass|pwd|auth|bearer|jwt|api|otp|pin|cookie|session|private|seed|mnemonic|credential|signature|cert/i
const TOKENISH = /^(?=.*\d)[A-Za-z0-9_\-+/=.]{20,}$/
const MAX_NOTES = 5000
const MAX_DEPTH = 8
const MAX_DISTINCT = 15
const MAX_VALUE = 60

const kindOf = v => {
  if (typeof v !== 'string') return 'list'
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return /T/.test(s) ? 'datetime YYYY-MM-DDTHH:MM' : 'datetime YYYY-MM-DD HH:MM'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date YYYY-MM-DD'
  if (/^https?:\/\//i.test(s)) return 'url'
  if (/^\[.*\]$/.test(s)) return 'list'
  return 'text'
}

export const survey = (dir, { recursive = true } = {}) => {
  const notes = []
  let truncated = false
  const walk = (d, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (notes.length >= MAX_NOTES) {
        truncated = true
        return
      }
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.isSymbolicLink()) continue
      const p = path.join(d, e.name)
      if (e.isDirectory() && recursive && depth < MAX_DEPTH) walk(p, depth + 1)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) notes.push(p)
    }
  }
  walk(dir, 0)
  const keys = new Map()
  const headings = new Map()
  let folderCards = 0
  let topNotes = 0
  let nested = 0
  const noFrontmatter = []
  const folderMismatch = []
  const folders = new Map()
  for (const file of notes) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(dir, file).split(path.sep)
    if (rel.length === 1) topNotes++
    else nested++
    if (rel.length === 2) folders.set(rel[0], [...(folders.get(rel[0]) ?? []), rel[1]])
    if (rel.length === 2 && rel[1].toLowerCase() === `${rel[0].toLowerCase()}.md`) folderCards++
    const fields = readFields(text)
    if (!Object.keys(fields).length) noFrontmatter.push(rel.join('/'))
    for (const [k, v] of Object.entries(fields)) {
      const e = keys.get(k) ?? { key: k, notes: 0, kinds: new Map(), values: new Map() }
      e.notes++
      const kind = kindOf(v)
      e.kinds.set(kind, (e.kinds.get(kind) ?? 0) + 1)
      for (const x of kind === 'list' ? listValue(v) : [String(v)]) if (x && x.length <= MAX_VALUE) e.values.set(x, (e.values.get(x) ?? 0) + 1)
      keys.set(k, e)
    }
    let current = null
    for (const line of text.split(/\r?\n/)) {
      const h = line.match(/^(#{1,3}) (.+?)\s*$/)
      if (h) current = `${h[1]} ${h[2]}`
      else if (current && /^- \[[ xX]\] /.test(line)) headings.set(current, (headings.get(current) ?? 0) + 1)
    }
  }
  for (const [folder, files] of folders) if (!files.some(f => f.toLowerCase() === `${folder.toLowerCase()}.md`)) folderMismatch.push(`${folder}/${files[0]}`)
  const layoutHint = folderCards && !folderMismatch.length && !topNotes ? 'folder' : nested ? 'flat-recursive' : 'flat'
  return {
    dir,
    notes: notes.length,
    truncated,
    layoutHint,
    layoutAdvice: {
      folder: 'cards.layout "folder": every project is <name>/<name>.md',
      'flat-recursive': 'cards.layout "flat" with "recursive": true, plus a cards.filter to keep only project notes; consider cards.name "folder" when each project folder holds one main note',
      flat: 'cards.layout "flat", plus a cards.filter if other notes sit in the same folder',
    }[layoutHint],
    folderCards,
    folderMismatch: folderMismatch.slice(0, 20),
    topLevelNotes: topNotes,
    notesWithoutFrontmatter: noFrontmatter.length,
    withoutFrontmatter: noFrontmatter.slice(0, 20),
    keys: [...keys.values()]
      .sort((a, b) => b.notes - a.notes)
      .map(e => {
        const values = [...e.values.entries()].sort((a, b) => b[1] - a[1])
        const secret = SECRET.test(e.key) || values.some(([v]) => TOKENISH.test(v))
        const showValues = !secret && values.length <= MAX_DISTINCT && [...e.kinds.keys()].some(k => k === 'text' || k === 'list')
        return {
          key: e.key,
          notes: e.notes,
          kinds: Object.fromEntries(e.kinds),
          ...(showValues ? { values: values.map(([value, count]) => ({ value, count })) } : { distinct: values.length, valuesHidden: secret ? 'key looks secret' : 'too many distinct values or not text' }),
        }
      }),
    checkboxHeadings: [...headings.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([h, checkboxes]) => {
        const [, level, heading] = h.match(/^(#+) (.*)$/)
        return { heading, level: level.length, checkboxes, usable: level.length === 2 }
      }),
  }
}
