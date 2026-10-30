import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = p => (p === '~' || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p)

export const parseOffset = s => {
  if (s == null || s === 'local') return -new Date().getTimezoneOffset()
  const m = String(s).match(/^([+-])(\d{2}):(\d{2})$/)
  if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) throw new Error(`utcOffset must be +HH:MM, -HH:MM or "local", got ${s}`)
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export const formatOffset = min => `${min < 0 ? '-' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`

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
  '': ['$schema', 'projectsDir', 'reposDir', 'transcriptsDir', 'dbFile', 'port', 'utcOffset', 'readinessFile', 'ignore', 'reviewAgents', 'digest', 'streak'],
  digest: ['at', 'lang', 'command'],
  streak: ['repo', 'branch', 'file'],
}

const unknownKeys = raw => [
  ...Object.keys(raw).filter(k => !KNOWN[''].includes(k)),
  ...['digest', 'streak'].flatMap(s => (raw[s] && typeof raw[s] === 'object' && !Array.isArray(raw[s]) ? Object.keys(raw[s]).filter(k => !KNOWN[s].includes(k)).map(k => `${s}.${k}`) : [])),
]

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
      at: env.DIGEST_AT ?? digest.at ?? '10:00',
      lang,
      command: command && command.map(home),
      telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null,
    },
    streak: raw.streak?.repo ? { repo: dir(raw.streak.repo), branch: raw.streak.branch ?? 'main', file: raw.streak.file ?? 'daily.log' } : null,
  }
}
