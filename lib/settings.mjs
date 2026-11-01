import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, readJson, readEnv, parseOffset, formatOffset, expandHome } from './config.mjs'
import { saveConfig } from './init.mjs'
import { hashOf } from './card.mjs'
import { Conflict } from './store.mjs'

const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v)
const read = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export const envFileOf = file => path.join(path.dirname(path.resolve(file)), '.env.local')
export const settingsHash = file => hashOf(`${read(file)}\n--\n${read(envFileOf(file))}`)

const dirState = p => {
  try {
    return fs.statSync(p).isDirectory() ? 'ok' : 'not a folder'
  } catch {
    return 'missing'
  }
}

const TARGET_FORM = ['name', 'kind', 'project', 'url', 'certDays', 'field', 'maxAgeMin', 'chain', 'address', 'min', 'unit', 'rpc', 'rpcEnv']
const TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/
const CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/

export const settingsView = (here, file, startHash = null) => {
  const exists = fs.existsSync(file)
  let raw = {}
  let c = null
  let error = null
  try {
    raw = exists ? readJson(file) : {}
    c = loadConfig(here, file)
  } catch (e) {
    error = String(e?.message ?? e)
  }
  const own = readEnv(envFileOf(file))
  const hash = settingsHash(file)
  const dir = p => ({ path: p, state: dirState(p) })
  return {
    file,
    exists,
    hash,
    restart: startHash != null && startHash !== hash,
    error,
    values: {
      projectsDir: raw.projectsDir ?? '',
      reposDir: raw.reposDir ?? '',
      transcriptsDir: raw.transcriptsDir ?? '',
      port: raw.port ?? '',
      utcOffset: raw.utcOffset ?? '',
      digestAt: raw.digest?.at ?? '',
      digestLang: raw.digest?.lang ?? '',
      digestCommand: raw.digest?.command ?? null,
    },
    effective: c && {
      projectsDir: dir(c.projectsDir),
      reposDir: dir(c.reposDir),
      transcriptsDir: dir(c.transcriptsDir),
      port: c.port,
      utcOffset: formatOffset(c.utcOffset),
      digestAt: c.digest.at,
      digestLang: c.digest.lang,
      channel: c.digest.command ? 'command' : c.digest.telegram ? 'telegram' : 'none',
      layout: c.cards.layout,
    },
    computerOffset: formatOffset(-new Date().getTimezoneOffset()),
    telegram: { set: Boolean(c?.digest.telegram), here: Boolean(own.TELEGRAM_BOT_TOKEN || own.TELEGRAM_CHAT_ID) },
    portFromEnv: Boolean(process.env.PORT || readEnv(path.join(here, '.env.local')).PORT || own.PORT),
    envFile: envFileOf(file),
    restartCommand: here.split(path.sep).includes('node_modules') ? 'npx github:egorb2302/Projium restart' : 'node bin/projium.mjs restart',
    watch: (Array.isArray(raw.watch?.targets) ? raw.watch.targets : []).filter(isObject).map(({ rpc, ...t }) => (rpc == null ? t : { ...t, rpcSet: true })),
  }
}

const line = (v, what) => {
  if (typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new Error(`${what} must be one line of text`)
  return v.trim()
}

const formTarget = (raw, where) => {
  if (!isObject(raw)) throw new Error(`${where} must be an object`)
  const out = {}
  for (const k of TARGET_FORM) {
    const v = raw[k]
    if (v == null || v === '') continue
    out[k] = typeof v === 'string' ? line(v, `${where}.${k}`) : v
  }
  for (const k of ['certDays', 'maxAgeMin', 'min']) if (typeof out[k] === 'string') out[k] = Number(out[k])
  return out
}

const watchOps = (targets, ops) => {
  const list = targets.map(t => ({ ...t }))
  const at = name => list.findIndex(t => isObject(t) && String(t.name ?? '').toLowerCase() === String(name ?? '').toLowerCase())
  for (const [i, op] of ops.entries()) {
    const where = `watch[${i}]`
    if (!isObject(op)) throw new Error(`${where} must be an object`)
    if (op.op === 'remove') {
      const j = at(op.name)
      if (j < 0) throw new Error(`no watch target named ${op.name}`)
      list.splice(j, 1)
    } else if (op.op === 'add') list.push(formTarget(op.target, `${where}.target`))
    else if (op.op === 'update') {
      const j = at(op.name)
      if (j < 0) throw new Error(`no watch target named ${op.name}`)
      const next = formTarget(op.target, `${where}.target`)
      const old = list[j]
      const kept = old.kind === next.kind ? Object.fromEntries(Object.entries(old).filter(([k]) => !TARGET_FORM.includes(k) || k === 'rpc' || k === 'rpcEnv')) : {}
      if (old.kind === next.kind && next.rpc == null && old.rpc != null) kept.rpc = old.rpc
      if (next.rpcEnv == null) delete kept.rpcEnv
      list[j] = { ...kept, ...next }
    } else throw new Error(`${where}.op must be add, update or remove`)
  }
  return list
}

const writeEnv = (file, changes) => {
  const text = read(file)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let lines = text ? text.split(/\r?\n/) : []
  if (lines.at(-1) === '') lines.pop()
  for (const [k, v] of Object.entries(changes)) {
    const own = l => l.startsWith(`${k}=`)
    if (v == null) lines = lines.filter(l => !own(l))
    else if (lines.some(own)) {
      lines[lines.findIndex(own)] = `${k}=${v}`
      lines = lines.filter((l, i) => !own(l) || i === lines.findIndex(own))
    } else lines.push(`${k}=${v}`)
  }
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, lines.length ? `${lines.join(eol)}${eol}` : '', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export const applySettings = (here, file, body = {}) => {
  if (body.hash !== settingsHash(file)) throw new Conflict('the settings changed since this page read them; reload the page', null)
  const exists = fs.existsSync(file)
  const raw = exists ? readJson(file) : {}
  const next = structuredClone(raw)
  const base = path.dirname(path.resolve(file))
  const s = isObject(body.set) ? body.set : {}
  for (const k of ['projectsDir', 'reposDir', 'transcriptsDir']) {
    if (!(k in s)) continue
    const v = line(s[k], k).replace(/^(["'])(.*)\1$/, '$2').replace(/\\/g, '/')
    if (!v) {
      if (k === 'projectsDir') throw new Error('the projects folder cannot be empty')
      delete next[k]
      continue
    }
    const state = dirState(path.resolve(base, expandHome(v)))
    if (state !== 'ok' && k !== 'transcriptsDir') throw new Error(`${k === 'projectsDir' ? 'projects' : 'repos'} folder ${state}: ${path.resolve(base, expandHome(v))}`)
    next[k] = v
  }
  if ('port' in s) {
    if (s.port === '' || s.port == null) delete next.port
    else {
      const n = Number(s.port)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port must be a number from 1 to 65535')
      next.port = n
    }
  }
  if ('utcOffset' in s) {
    const v = line(s.utcOffset ?? '', 'utcOffset')
    if (!v) delete next.utcOffset
    else next.utcOffset = v === 'local' ? v : formatOffset(parseOffset(v))
  }
  if (['digestAt', 'digestLang', 'digestCommand'].some(k => k in s)) {
    const digest = isObject(raw.digest) ? { ...raw.digest } : {}
    if ('digestAt' in s) {
      const v = line(s.digestAt ?? '', 'digestAt')
      if (v) digest.at = v
      else delete digest.at
    }
    if ('digestLang' in s) {
      const v = line(s.digestLang ?? '', 'digestLang')
      if (v) digest.lang = v
      else delete digest.lang
    }
    if ('digestCommand' in s) {
      if (s.digestCommand == null) delete digest.command
      else digest.command = s.digestCommand
    }
    if (Object.keys(digest).length) next.digest = digest
    else delete next.digest
  }
  if (body.watch != null) {
    if (!Array.isArray(body.watch)) throw new Error('watch must be a list of changes')
    const watch = isObject(raw.watch) ? { ...raw.watch } : {}
    watch.targets = watchOps(Array.isArray(watch.targets) ? watch.targets : [], body.watch)
    if (!watch.targets.length) delete watch.targets
    if (Object.keys(watch).length) next.watch = watch
    else delete next.watch
  }
  let tg = null
  if (body.telegram !== undefined) {
    if (body.telegram === null) tg = { TELEGRAM_BOT_TOKEN: null, TELEGRAM_CHAT_ID: null }
    else {
      const token = line(body.telegram?.token ?? '', 'token')
      const chat = line(body.telegram?.chatId ?? '', 'chat id')
      if (!TOKEN.test(token)) throw new Error('the bot token looks wrong: it is digits, a colon and a long code, as BotFather gives it')
      if (!CHAT.test(chat)) throw new Error('the chat id must be a number (like 123456789 or -100123456789) or @channelname')
      tg = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat }
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(raw)
  if (changed && !exists && !next.projectsDir) throw new Error('set the projects folder first: without it Projium shows the demo projects')
  const backup = changed ? saveConfig(here, file, !exists && base === path.resolve(here) ? { $schema: './tracker.config.schema.json', ...next } : next) : null
  if (tg) writeEnv(envFileOf(file), tg)
  return { backup }
}
