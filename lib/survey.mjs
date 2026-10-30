import fs from 'node:fs'
import path from 'node:path'
import { readFields, listValue } from './card.mjs'

const SECRET = /key|token|secret|pass|auth|cookie|session|private|seed|mnemonic|credential/i
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
  for (const file of notes) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(dir, file).split(path.sep)
    if (rel.length === 1) topNotes++
    if (rel.length === 2 && rel[1].toLowerCase() === `${rel[0].toLowerCase()}.md`) folderCards++
    for (const [k, v] of Object.entries(readFields(text))) {
      const e = keys.get(k) ?? { key: k, notes: 0, kinds: new Map(), values: new Map() }
      e.notes++
      const kind = kindOf(v)
      e.kinds.set(kind, (e.kinds.get(kind) ?? 0) + 1)
      for (const x of kind === 'list' ? listValue(v) : [String(v)]) if (x && x.length <= MAX_VALUE) e.values.set(x, (e.values.get(x) ?? 0) + 1)
      keys.set(k, e)
    }
    let current = null
    for (const line of text.split(/\r?\n/)) {
      const h = line.match(/^#{1,3} (.+?)\s*$/)
      if (h) current = h[1]
      else if (current && /^- \[[ xX]\] /.test(line)) headings.set(current, (headings.get(current) ?? 0) + 1)
    }
  }
  return {
    dir,
    notes: notes.length,
    truncated,
    layoutHint: folderCards > topNotes ? 'folder' : 'flat',
    folderCards,
    topLevelNotes: topNotes,
    keys: [...keys.values()]
      .sort((a, b) => b.notes - a.notes)
      .map(e => {
        const secret = SECRET.test(e.key)
        const values = [...e.values.entries()].sort((a, b) => b[1] - a[1])
        const showValues = !secret && values.length <= MAX_DISTINCT && [...e.kinds.keys()].some(k => k === 'text' || k === 'list')
        return {
          key: e.key,
          notes: e.notes,
          kinds: Object.fromEntries(e.kinds),
          ...(showValues ? { values: values.map(([value, count]) => ({ value, count })) } : { distinct: values.length, valuesHidden: secret ? 'key looks secret' : 'too many distinct values or not text' }),
        }
      }),
    checkboxHeadings: [...headings.entries()].sort((a, b) => b[1] - a[1]).map(([heading, checkboxes]) => ({ heading, checkboxes })),
  }
}
