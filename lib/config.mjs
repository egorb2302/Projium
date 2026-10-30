import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EDITABLE, STAGES } from './card.mjs'

const home = p => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p)

export const parseOffset = s => {
  if (s == null || s === 'local') return -new Date().getTimezoneOffset()
  const m = String(s).match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) throw new Error(`utcOffset must be +HH:MM, -HH:MM or "local", got ${s}`)
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export const instanceId = projectsDir => {
  const p = path.resolve(projectsDir)
  return crypto.createHash('sha256').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 12)
}

export const expandHome = p => home(p)

export const formatOffset =min => `${min < 0 ? '-' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`

export const ignoreTest = list => {
  const words = (list ?? []).map(String).filter(Boolean)
  if (!words.length) return () => false
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
  return s => re.test(String(s ?? ''))
}

const readEnv = file => {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*?)\s*$/gm)) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  return out
}

const words = (v, key) => {
  if (v == null) return null
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new Error(`${key} must be an array of strings`)
  return v
}

const readJson = file => {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`)
  return raw
}

const KNOWN = {
  '': ['$schema', 'projectsDir', 'reposDir', 'transcriptsDir', 'dbFile', 'port', 'utcOffset', 'readinessFile', 'ignore', 'reviewAgents', 'digest', 'streak', 'cards'],
  digest: ['at', 'lang', 'command', 'env'],
  streak: ['repo', 'branch', 'file'],
  cards: ['layout', 'recursive', 'filter', 'fields', 'stages', 'sections'],
}

const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v)

const unknownKeys = raw => [
  ...Object.keys(raw).filter(k => !KNOWN[''].includes(k)),
  ...['digest', 'streak', 'cards'].flatMap(s => (isObject(raw[s]) ? Object.keys(raw[s]).filter(k => !KNOWN[s].includes(k)).map(k => `${s}.${k}`) : [])),
  ...(isObject(raw.cards?.sections) ? Object.keys(raw.cards.sections).filter(k => !['tasks', 'updates', 'timeline'].includes(k)).map(k => `cards.sections.${k}`) : []),
]

const OWNER_KEY = /^[A-Za-z_][\w-]*$/

export const cardsConfig = raw => {
  if (raw == null) return { layout: 'folder', recursive: false, filter: null, fields: {}, stages: {}, sections: {} }
  if (!isObject(raw)) throw new Error('cards must be an object')
  const layout = raw.layout ?? 'folder'
  if (!['folder', 'flat'].includes(layout)) throw new Error(`cards.layout must be "folder" or "flat", got ${layout}`)
  if (raw.recursive != null && typeof raw.recursive !== 'boolean') throw new Error('cards.recursive must be true or false')
  if (raw.recursive && layout !== 'flat') throw new Error('cards.recursive works only with cards.layout "flat"')
  const filter = raw.filter ?? null
  if (filter != null) {
    if (!isObject(filter) || !Object.keys(filter).length) throw new Error('cards.filter must be an object like { "type": "project" }')
    for (const [k, v] of Object.entries(filter))
      if (!OWNER_KEY.test(k) || !(typeof v === 'string' || (Array.isArray(v) && v.length && v.every(x => typeof x === 'string'))))
        throw new Error(`cards.filter.${k} must be a string or a list of strings, keyed by a frontmatter key`)
  }
  const fields = raw.fields ?? {}
  if (!isObject(fields)) throw new Error('cards.fields must be an object like { "stage": "status" }')
  const used = new Set()
  for (const [k, v] of Object.entries(fields)) {
    if (!EDITABLE.includes(k)) throw new Error(`cards.fields.${k}: only these fields can be mapped: ${EDITABLE.join(', ')}`)
    if (typeof v !== 'string' || !OWNER_KEY.test(v)) throw new Error(`cards.fields.${k} must be a frontmatter key (letters, digits, _ and -), got ${JSON.stringify(v)}`)
    if (EDITABLE.includes(v) && v !== k) throw new Error(`cards.fields.${k} points at ${v}, which is itself a Projium field; map ${v} too or pick another key`)
    if (used.has(v)) throw new Error(`cards.fields maps two fields to ${v}`)
    used.add(v)
  }
  const stages = raw.stages ?? {}
  if (!isObject(stages)) throw new Error('cards.stages must be an object like { "in progress": "development" }')
  for (const [k, v] of Object.entries(stages))
    if (!k.trim() || !STAGES.includes(v)) throw new Error(`cards.stages["${k}"] must be one of ${STAGES.join(', ')}`)
  const sections = raw.sections ?? {}
  if (!isObject(sections)) throw new Error('cards.sections must be an object like { "tasks": "Todo" }')
  for (const [k, v] of Object.entries(sections))
    if (typeof v !== 'string' || !v.trim() || /[\r\n#]/.test(v)) throw new Error(`cards.sections.${k} must be a heading text without # and line breaks`)
  return { layout, recursive: Boolean(raw.recursive), filter, fields, stages, sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.trim()])) }
}

export const configPath = here => process.env.TRACKER_CONFIG || path.join(here, 'tracker.config.json')

export const loadConfig = (here, file = configPath(here)) => {
  const raw = fs.existsSync(file) ? readJson(file) : {}
  const base = path.dirname(path.resolve(file))
  const env = Object.fromEntries(Object.entries({ ...readEnv(path.join(here, '.env.local')), ...process.env }).filter(([, v]) => v !== ''))
  const dir = (v, fallback) => path.resolve(base, home(v ?? fallback))
  const digest = raw.digest ?? {}
  const offset = parseOffset(raw.utcOffset)
  const lang = digest.lang ?? 'en'
  if (!['en', 'ru'].includes(lang)) throw new Error(`digest.lang must be en or ru, got ${lang}`)
  const command = digest.command ?? null
  if (command != null && (!Array.isArray(command) || !command.length || !command.every(x => typeof x === 'string')))
    throw new Error('digest.command must be an array of strings, e.g. ["node", "send.mjs", "--text"]')
  const port = Number(env.PORT ?? raw.port ?? 3210)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be a number from 0 to 65535, got ${env.PORT ?? raw.port}`)
  const digestAt = env.DIGEST_AT ?? digest.at ?? '10:00'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(digestAt))) throw new Error(`digest.at must be HH:MM from 00:00 to 23:59, got ${digestAt}`)
  const readinessFile = raw.readinessFile ?? 'READINESS.md'
  if (typeof readinessFile !== 'string' || !/^[^\\/]+\.md$/i.test(readinessFile)) throw new Error('readinessFile must be a .md file name without folders')
  return {
    file: fs.existsSync(file) ? file : null,
    unknownKeys: unknownKeys(raw),
    projectsDir: dir(raw.projectsDir, path.join(here, 'demo', 'projects')),
    reposDir: dir(raw.reposDir, path.join(here, 'demo', 'repos')),
    transcriptsDir: dir(raw.transcriptsDir, '~/.claude/projects'),
    dbFile: dir(raw.dbFile, path.join(here, 'data', 'tracker.db')),
    port,
    utcOffset: offset,
    readinessFile,
    ignore: words(raw.ignore, 'ignore') ?? [],
    reviewAgents: words(raw.reviewAgents, 'reviewAgents') ?? ['code-reviewer'],
    digest: {
      at: digestAt,
      lang,
      command: command && command.map(home),
      env: words(digest.env, 'digest.env') ?? [],
      telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null,
    },
    streak: raw.streak?.repo ? { repo: dir(raw.streak.repo), branch: raw.streak.branch ?? 'main', file: raw.streak.file ?? 'daily.log' } : null,
    cards: cardsConfig(raw.cards),
  }
}
