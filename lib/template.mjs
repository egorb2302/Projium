import fs from 'node:fs'
import { formatValue, EDITABLE } from './card.mjs'

const DOC = new URL('../docs/card-template.md', import.meta.url)

export const readTemplate = () => {
  const m = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n').match(/```markdown\n([\s\S]*?)\n```/)
  if (!m) throw new Error('docs/card-template.md has no markdown block')
  return `${m[1]}\n`
}

const SECTIONS = { Tasks: 'tasks', Updates: 'updates', Timeline: 'timeline' }

export const cardText = (template, { name, keyOf = k => k, stageWord = 'development', values = {}, filter = null, heading = {} }) => {
  const lines = template.split('\n')
  const end = lines.indexOf('---', 1)
  if (lines[0] !== '---' || end < 0) throw new Error('the card template has no frontmatter')
  const wanted = Object.fromEntries(Object.entries(filter ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))
  const owners = new Set(EDITABLE.map(keyOf).filter(Boolean))
  const used = new Set()
  const front = []
  const emit = (key, value) => {
    if (used.has(key)) return
    used.add(key)
    front.push(`${key}:${value ? ` ${value}` : ''}`)
  }
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/)
    if (!m) continue
    const k = m[1]
    if (EDITABLE.includes(k)) {
      const key = keyOf(k)
      if (!key) continue
      const given = values[k]
      emit(key, k === 'stage' ? formatValue(stageWord, true) : given ? formatValue(given, true) : Object.hasOwn(wanted, key) ? formatValue(wanted[key], true) : m[2].trim())
    } else if (!owners.has(k)) emit(k, Object.hasOwn(wanted, k) ? formatValue(wanted[k], true) : m[2].trim())
  }
  for (const [k, v] of Object.entries(wanted)) emit(k, formatValue(v, true))
  const body = []
  const rest = lines.slice(end + 1)
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i]
    if (line.startsWith('Source note:')) {
      if (rest[i + 1] === '') i++
      continue
    }
    if (line === '# name') body.push(`# ${name}`)
    else if (/^## (Tasks|Updates|Timeline)$/.test(line)) body.push(`## ${heading[SECTIONS[line.slice(3)]] ?? line.slice(3)}`)
    else body.push(line)
  }
  return ['---', ...front, '---', ...body].join('\n')
}
