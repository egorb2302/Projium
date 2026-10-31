import crypto from 'node:crypto'
import { load } from './vendor/js-yaml.mjs'

export const STAGES = ['development', 'review', 'fixes', 'done']
export const DATE_FIELDS = ['handed_over_at', 'accepted_at']
export const TIME_FIELDS = ['spec_at', 'design_pick_at', 'first_push_at', 'mainnet_at']
export const TEXT_FIELDS = ['accepted_by', 'next_step', 'site']
export const EDITABLE = ['stage', ...DATE_FIELDS, ...TIME_FIELDS, ...TEXT_FIELDS]

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const TASK = /^- \[( |x|X)\] ([^\r\n]*?)(?: · due (\d{4}-\d{2}-\d{2}))?(?: · (p[123]))? \^(t-[a-z0-9]{4})\s*$/
const LOOSE_TASK = /^- \[( |x|X)\] ([^\r\n]*)$/
const KEY = /^(["']?)([A-Za-z_][\w-]*)\1[ \t]*:([^\r\n]*)$/
const keyLine = line => {
  const m = line.match(KEY)
  return m ? { key: m[2], rest: m[3] } : null
}
const BREAKS = new RegExp(`[\\r\\n${String.fromCharCode(0x85, 0x2028, 0x2029)}]`)

export const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

export const mixedEndings = text => text.includes('\r\n') && /(^|[^\r])\n/.test(text)
const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n')

const frontRange = lines => {
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end > 0 ? { start: 1, end, exact: /^﻿?---[ \t]*$/.test(lines[0]) && /^---[ \t]*$/.test(lines[end]) } : null
}

export const scanValue = raw => {
  const s = raw.trim()
  const q = s[0]
  if (q === '"' || q === "'") {
    let i = 1
    for (; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') i++
      else if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") i++
        else break
      }
    }
    if (i >= s.length) return { value: s, ok: false, comment: '' }
    const rest = s.slice(i + 1)
    const comment = rest.match(/^\s+#.*$/)?.[0] ?? ''
    if (rest && !comment) return { value: s, ok: false, comment: '' }
    let value
    if (q === '"') {
      try {
        value = JSON.parse(s.slice(0, i + 1))
      } catch {
        return { value: s.slice(1, i), ok: false, comment }
      }
    } else value = s.slice(1, i).replace(/''/g, "'")
    return { value, ok: true, comment }
  }
  if (/^[|>]/.test(s)) return { value: s, ok: false, comment: '' }
  if (s.startsWith('#')) return { value: '', ok: true, comment: ` ${s}` }
  const comment = s.match(/\s+#.*$/)?.[0] ?? ''
  return { value: comment ? s.slice(0, -comment.length) : s, ok: true, comment }
}

export const parseValue = raw => scanValue(raw).value

const SPACE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
const SECONDS_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/
const YAML_STAMP = /^\d{4}-\d\d?-\d\d?(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?$/
const PLAIN = /^[\p{L}][\p{L}\p{N} ._()/,'-]*[\p{L}\p{N}.)]$|^[\p{L}]$/u
const RESERVED = /^(true|false|yes|no|on|off|null|y|n)$/i

export const formatValue = (v, plainOk = false, dateOk = false) => {
  if (v === '' || v == null) return ''
  if (DATE.test(v) || SECONDS_TIME.test(v)) return dateOk ? v : JSON.stringify(v)
  if (TIME.test(v) || SPACE_TIME.test(v) || STAGES.includes(v)) return v
  if (plainOk && PLAIN.test(v) && !RESERVED.test(v)) return v
  return JSON.stringify(v)
}

export const normalizeTime = v => {
  const s = typeof v === 'string' ? v.trim() : v
  if (typeof s !== 'string') return v
  if (TIME.test(s)) return s
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/)
  if (m) return `${m[1]}T${m[2]}`
  if (DATE.test(s)) return `${s}T00:00`
  return v
}

export const timeStyle = raw => {
  const s = typeof raw === 'string' ? raw.trim() : ''
  const m = s.match(/^\d{4}-\d{2}-\d{2}([ T])\d{2}:\d{2}(:\d{2})?/)
  if (m) return `${m[1] === ' ' ? 'space' : 'T'}${m[2] ? '-seconds' : ''}`
  return DATE.test(s) ? 'date' : 'T'
}

export const inTimeStyle = (value, style) => {
  if (!TIME.test(value)) return value
  if (style === 'date') return value.endsWith('T00:00') ? value.slice(0, 10) : value
  const base = style.startsWith('space') ? value.replace('T', ' ') : value
  return style.endsWith('-seconds') ? `${base}:00` : base
}

export const listValue = v => {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== 'string') return []
  const s = v.trim()
  if (s.startsWith('[') && s.endsWith(']'))
    return s
      .slice(1, -1)
      .split(',')
      .map(x => x.trim().replace(/^(["'])(.*)\1$/, '$2'))
      .filter(Boolean)
  return s ? [s] : []
}

export const readFields = text => {
  const lines = text.split(/\r?\n/)
  const r = frontRange(lines)
  const out = {}
  if (!r) return out
  let list = null
  for (let i = r.start; i < r.end; i++) {
    const line = lines[i]
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && list) {
      out[list].push(parseValue(item[1]))
      continue
    }
    const m = keyLine(line)
    if (!m) continue
    const v = m.rest.trim()
    if (v === '' && /^\s*-\s/.test(lines[i + 1] ?? '')) {
      list = m.key
      out[list] = []
      continue
    }
    list = null
    out[m.key] = parseValue(m.rest)
  }
  return out
}

export const validate = (key, value) => {
  if (!EDITABLE.includes(key)) return `field ${key} is not editable`
  if (typeof value !== 'string') return 'value must be a string'
  if (BREAKS.test(value)) return 'value must be one line'
  if (value === '') return key === 'stage' ? 'stage cannot be empty' : null
  if (key === 'stage' && !STAGES.includes(value)) return `stage must be one of ${STAGES.join(', ')}`
  if (DATE_FIELDS.includes(key) && !DATE.test(value)) return 'date must be YYYY-MM-DD'
  if (TIME_FIELDS.includes(key) && !TIME.test(value)) return 'time must be YYYY-MM-DDTHH:MM'
  if (key === 'site') {
    const m = value.match(/^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?$/i)
    if (!m) return 'site must be https://domain'
    let host
    try {
      host = new URL(value).hostname.replace(/\.$/, '')
    } catch {
      return 'site must be https://domain'
    }
    if (/^[\d.]+$/.test(host) || host.includes(':') || /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) return 'site must be a public domain'
  }
  return null
}

const ANY_KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|(?!-\s)[^\s"'[\]{},#&*!|>%@`][^:]*?)[ \t]*:(?=\s|$)/

const yamlOf = (lines, r) => {
  try {
    const data = load(lines.slice(r.start, r.end).join('\n'))
    if (data == null) return {}
    return typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

const scalar = s => {
  try {
    return load(s)
  } catch {
    return undefined
  }
}

const structureError = (lines, r) => {
  if (!r.exact) return 'Projium does not edit this frontmatter: a "---" line in it is indented, so other tools may end it elsewhere; edit it in Obsidian'
  const data = yamlOf(lines, r)
  if (!data) return 'Projium does not edit this frontmatter: it is not valid YAML or not a list of keys; edit it in Obsidian'
  const read = lines.slice(r.start, r.end).flatMap(l => {
    const m = l.match(KEY)
    if (!m) return []
    const v = m[1] ? m[2] : scalar(m[2])
    return [v === null || typeof v === 'boolean' ? String(v) : m[2]]
  })
  const parsed = Object.keys(data).filter(k => /^[A-Za-z_][\w-]*$/.test(k))
  if (parsed.some(k => !read.includes(k)) || read.some(k => !Object.hasOwn(data, k)))
    return 'Projium does not edit this frontmatter: a key sits inside another value or is written in a form Projium does not read (a value spread over lines, explicit or anchored keys); edit it in Obsidian'
  return null
}

const sameData = (a, b, seen = new Map()) => {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (seen.get(a)?.has(b)) return true
    if (!seen.has(a)) seen.set(a, new Set())
    seen.get(a).add(b)
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameData(a[k], b[k], seen))
  }
  return Object.is(a, b)
}

const frontData = text => {
  const lines = text.split(/\r?\n/)
  const r = frontRange(lines)
  return r ? yamlOf(lines, r) : {}
}

export const frontText = text => {
  const lines = text.split(/\r?\n/)
  if (!frontRange(lines)) return ''
  const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l))
  return lines.slice(0, end < 0 ? lines.length : end + 1).join('\n')
}

const keepsKind = (old, value) => {
  const v = scalar(value)
  return ['number', 'boolean'].includes(typeof old) && typeof v === typeof old && String(v) === value
}

export const writeKeepsYaml = (before, after, key, value, dateOk = false) => {
  const a = frontData(before)
  const b = frontData(after)
  if (!a || !b) return false
  try {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== key && (Object.hasOwn(a, k) !== Object.hasOwn(b, k) || !sameData(a[k], b[k]))) return false
  } catch {
    return false
  }
  const v = b[key]
  if (value === '') return v === null || v === ''
  if (typeof v === 'string') return v === value
  if (typeof v === 'number' || typeof v === 'boolean') return keepsKind(a[key], value) && Object.is(v, scalar(value))
  return v instanceof Date && (dateOk || a[key] instanceof Date) && v.getTime() === Date.parse(DATE.test(value) ? value : `${value.replace(' ', 'T')}Z`)
}

const fieldAt = (lines, r, key) => {
  const at = []
  for (let i = r.start; i < r.end; i++) if (keyLine(lines[i])?.key === key) at.push(i)
  if (at.length > 1) throw new Error(`${key} appears twice in the frontmatter; fix it in Obsidian`)
  if (!at.length) return -1
  const i = at[0]
  const raw = keyLine(lines[i]).rest
  if (BREAKS.test(raw) || !scanValue(raw).ok || /^[&*![{]/.test(raw.trim())) throw new Error(`${key} is not a plain one-line value; edit it in Obsidian`)
  let j = i + 1
  while (j < r.end && !lines[j].trim()) j++
  if (j < r.end && !ANY_KEY.test(lines[j]) && !lines[j].startsWith('#')) throw new Error(`${key} spans several lines; edit it in Obsidian`)
  return i
}

export const setField = (text, key, value, timeField = DATE_FIELDS.includes(key) || TIME_FIELDS.includes(key)) => {
  if (mixedEndings(text)) throw new Error('the card mixes line endings; save it once in Obsidian first')
  const eol = eolOf(text)
  const lines = text.split(/\r?\n/)
  const r = frontRange(lines)
  if (!r) throw new Error('card has no frontmatter')
  const at = fieldAt(lines, r, key)
  const broken = structureError(lines, r)
  if (broken) throw new Error(broken)
  const old = at >= 0 ? keyLine(lines[at]).rest.trim() : ''
  const scanned = scanValue(old)
  const comment = at >= 0 ? scanned.comment : ''
  const quoted = /^["']/.test(old)
  const plainOk = scanned.value !== '' && !quoted
  const dateOk = !quoted && (timeField || DATE.test(scanned.value) || YAML_STAMP.test(scanned.value))
  const formatted = plainOk && keepsKind(scalar(scanned.value), value) ? value : formatValue(value, plainOk, dateOk)
  const line = `${key}:${value === '' ? '' : ' '}${formatted}${comment}`
  if (at >= 0) lines[at] = line
  else lines.splice(r.end, 0, line)
  return lines.join(eol)
}

export const lockedFields = (text, keyOf = k => k) => {
  const lines = text.split(/\r?\n/)
  const r = frontRange(lines)
  if (!r || structureError(lines, r)) return [...EDITABLE]
  return EDITABLE.filter(k => {
    if (keyOf(k) == null) return true
    try {
      fieldAt(lines, r, keyOf(k))
      return false
    } catch {
      return true
    }
  })
}

const sectionRange = (lines, heading) => {
  const want = `## ${heading}`.toLowerCase()
  const start = lines.findIndex(l => l.trim().toLowerCase() === want)
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l))
  if (end < 0) end = lines.length
  return { start, end }
}

export const section = (text, heading) => {
  const lines = text.split(/\r?\n/)
  const r = sectionRange(lines, heading)
  return r ? lines.slice(r.start + 1, r.end).join('\n').trim() : null
}

export const parseTask = line => {
  const m = line.match(TASK)
  if (m) return { id: m[5], done: m[1] !== ' ', text: m[2], due: m[3] ?? '', p: m[4] ?? '', line }
  const l = line.match(LOOSE_TASK)
  return l ? { id: '', done: l[1] !== ' ', text: l[2], due: '', p: '', line, readonly: true } : null
}

export const readTasks = (text, heading = 'Tasks') => {
  const body = section(text, heading)
  if (body == null) return []
  return body.split('\n').map(parseTask).filter(Boolean)
}

export const formatTask = t => {
  const text = String(t.text ?? '').trim()
  if (!text || (BREAKS.test(text) || text.includes('^')) || text.includes(' · ')) throw new Error('task text must be one line without "^" or " · "')
  if (t.due && !DATE.test(t.due)) throw new Error('due must be YYYY-MM-DD')
  if (t.p && !/^p[123]$/.test(t.p)) throw new Error('priority must be p1, p2 or p3')
  if (!/^t-[a-z0-9]{4}$/.test(t.id)) throw new Error('bad task id')
  return `- [${t.done ? 'x' : ' '}] ${text}${t.due ? ` · due ${t.due}` : ''}${t.p ? ` · ${t.p}` : ''} ^${t.id}`
}

export const toggleLine = line => line.replace(/^- \[([ xX])\]/, (_, c) => `- [${c === ' ' ? 'x' : ' '}]`)

export const newTaskId = text => {
  const used = new Set([...text.matchAll(/\^(t-[a-z0-9]{4})/g)].map(m => m[1]))
  for (;;) {
    const id = `t-${crypto.randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4)}`
    if (!used.has(id)) return id
  }
}

export const replaceTask = (text, id, build, heading = 'Tasks') => {
  if (mixedEndings(text)) throw new Error('the card mixes line endings; save it once in Obsidian first')
  const eol = eolOf(text)
  const lines = text.split(/\r?\n/)
  const r = sectionRange(lines, heading)
  const hits = r ? lines.map((l, i) => (i > r.start && i < r.end && parseTask(l)?.id === id ? i : -1)).filter(i => i >= 0) : []
  if (hits.length > 1) throw new Error(`task ${id} appears twice; fix it in Obsidian`)
  if (!hits.length) return null
  const cur = parseTask(lines[hits[0]])
  lines[hits[0]] = build(cur)
  return { text: lines.join(eol), before: cur }
}

export const addTask = (text, task, heading = 'Tasks') => {
  if (mixedEndings(text)) throw new Error('the card mixes line endings; save it once in Obsidian first')
  const eol = eolOf(text)
  const lines = text.split(/\r?\n/)
  let r = sectionRange(lines, heading)
  if (!r) {
    const first = lines.findIndex((l, i) => i > (frontRange(lines)?.end ?? 0) && /^## /.test(l))
    const at = first < 0 ? lines.length : first
    lines.splice(at, 0, `## ${heading}`, '', '')
    r = { start: at, end: at + 2 }
  }
  let last = -1
  for (let i = r.start + 1; i < r.end; i++) if (/^- \[[ xX]\] /.test(lines[i])) last = i
  const line = formatTask(task)
  if (last >= 0) lines.splice(last + 1, 0, line)
  else {
    let at = r.end
    while (at - 1 > r.start && lines[at - 1].trim() === '') at--
    lines.splice(at, 0, '', line)
  }
  return lines.join(eol)
}

export const timelineRows = (text, heading = 'Timeline') => {
  const body = section(text, heading)
  if (!body) return []
  return body
    .split('\n')
    .filter(l => l.startsWith('|') && !/^\|\s*-/.test(l))
    .slice(1)
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()))
}

export const updateLines = (text, heading = 'Updates') => {
  const body = section(text, heading)
  if (body == null) return []
  return body
    .split('\n')
    .filter(l => l.trim())
    .map(l => ({ text: l.replace(/^- /, '').replace(/\s*\^[\w-]+\s*$/, ''), item: l.startsWith('- '), id: l.match(/\^([\w-]+)\s*$/)?.[1] ?? '' }))
}
