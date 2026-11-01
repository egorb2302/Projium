import { request } from './net.mjs'
import { alertText } from '../public/watch-text.js'

export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
export const KINDS = ['site', 'heartbeat', 'balance']

const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ADDRESS = { solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, evm: /^0x[0-9a-fA-F]{40}$/ }
const TARGET_KEYS = {
  '': ['name', 'kind', 'project', 'failAfter', 'recoverAfter'],
  site: ['url', 'certDays'],
  heartbeat: ['url', 'field', 'maxAgeMin', 'activeWhen', 'max'],
  balance: ['chain', 'address', 'min', 'unit', 'rpc', 'rpcEnv'],
}
export const WATCH_KEYS = ['every', 'failAfter', 'recoverAfter', 'lang', 'command', 'env', 'rpc', 'targets']

const httpUrl = (v, where) => {
  let u
  try {
    u = new URL(String(v))
  } catch {}
  if (typeof v !== 'string' || !u || !['http:', 'https:'].includes(u.protocol)) throw new Error(`${where} must be an http:// or https:// URL`)
  return v
}

const count = (v, where, fallback) => {
  if (v == null) return fallback
  if (!Number.isInteger(v) || v < 1 || v > 100) throw new Error(`${where} must be a whole number from 1 to 100`)
  return v
}

const envName = (v, where) => {
  if (v == null) return null
  if (typeof v !== 'string' || !ENV_NAME.test(v)) throw new Error(`${where} must be an environment variable name like SOLANA_RPC_URL`)
  return v
}

const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: false })

const target = (raw, i, top, env) => {
  const at = `watch.targets[${i}]`
  if (!isObject(raw)) throw new Error(`${at} must be an object`)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > 64 || /[\r\n]/.test(name)) throw new Error(`${at}.name must be a one-line name of 1 to 64 characters`)
  const where = `watch target "${name}"`
  if (!KINDS.includes(raw.kind)) throw new Error(`${where}: kind must be one of ${KINDS.join(', ')}`)
  if (raw.project != null && (typeof raw.project !== 'string' || !raw.project.trim())) throw new Error(`${where}: project must be a project name`)
  const t = { name, kind: raw.kind, project: raw.project?.trim() ?? null, failAfter: count(raw.failAfter, `${where}: failAfter`, top.failAfter), recoverAfter: count(raw.recoverAfter, `${where}: recoverAfter`, top.recoverAfter) }
  if (raw.kind === 'site') {
    t.url = httpUrl(raw.url, `${where}: url`)
    const certDays = raw.certDays ?? 14
    if (!Number.isInteger(certDays) || certDays < 0 || certDays > 365) throw new Error(`${where}: certDays must be a whole number of days from 0 to 365 (0 turns the certificate check off)`)
    t.certDays = t.url.startsWith('https:') ? certDays : 0
  } else if (raw.kind === 'heartbeat') {
    t.url = httpUrl(raw.url, `${where}: url`)
    if (raw.field == null && raw.max == null) throw new Error(`${where}: set field (the time of the last beat) or max (numbers that must stay low), or both`)
    if (raw.field != null) {
      if (typeof raw.field !== 'string' || !/^[\w-]+(\.[\w-]+)*$/.test(raw.field)) throw new Error(`${where}: field must be a key of the JSON answer, like lastCycleAt or keeper.lastRun`)
      if (typeof raw.maxAgeMin !== 'number' || !(raw.maxAgeMin > 0)) throw new Error(`${where}: maxAgeMin (minutes since the last beat before it counts as stale) is required with field`)
    }
    t.field = raw.field ?? null
    t.maxAgeMin = raw.field != null ? raw.maxAgeMin : null
    if (raw.activeWhen != null && (!isObject(raw.activeWhen) || !Object.values(raw.activeWhen).every(v => ['string', 'number', 'boolean'].includes(typeof v))))
      throw new Error(`${where}: activeWhen must map JSON keys to values, like { "payoutsLive": true }`)
    if (raw.max != null && (!isObject(raw.max) || !Object.values(raw.max).every(v => typeof v === 'number' && Number.isFinite(v))))
      throw new Error(`${where}: max must map JSON keys to numbers, like { "stuckOps": 0 }`)
    t.activeWhen = raw.activeWhen ?? null
    t.max = raw.max ?? null
  } else {
    const chain = raw.chain ?? 'solana'
    if (!['solana', 'evm'].includes(chain)) throw new Error(`${where}: chain must be solana or evm`)
    if (typeof raw.address !== 'string' || !ADDRESS[chain].test(raw.address)) throw new Error(`${where}: address must be a public ${chain === 'solana' ? 'Solana address (base58)' : 'EVM address (0x and 40 hex digits)'}`)
    if (typeof raw.min !== 'number' || !(raw.min >= 0)) throw new Error(`${where}: min must be the balance to alert below, like 0.05`)
    if (raw.unit != null && (typeof raw.unit !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(raw.unit))) throw new Error(`${where}: unit must be a short coin name like ETH`)
    const rpcEnv = envName(raw.rpcEnv, `${where}: rpcEnv`)
    const rpc = raw.rpc == null ? null : httpUrl(raw.rpc, `${where}: rpc`)
    if (chain === 'evm' && !rpc && !rpcEnv) throw new Error(`${where}: an evm balance needs rpc (a JSON-RPC URL) or rpcEnv (the variable that holds it)`)
    Object.assign(t, { chain, address: raw.address, min: raw.min, unit: raw.unit ?? (chain === 'solana' ? 'SOL' : 'ETH'), rpcEnv })
    const own = rpcEnv && env[rpcEnv] ? ['env', env[rpcEnv]] : rpc ? ['config', rpc] : null
    const shared = chain === 'solana' ? (top.solanaEnv && env[top.solanaEnv] ? ['env', env[top.solanaEnv]] : top.solana ? ['config', top.solana] : ['public', SOLANA_RPC]) : null
    const [from, url] = own ?? shared ?? ['missing', null]
    t.rpcFrom = from
    t.rpcMissing = from === 'missing' || (rpcEnv && !env[rpcEnv]) ? rpcEnv : chain === 'solana' && !own && top.solanaEnv && !env[top.solanaEnv] ? top.solanaEnv : null
    hidden(t, 'rpcUrl', url)
  }
  return t
}

export const watchConfig = (raw, env = {}) => {
  if (raw == null) return null
  if (!isObject(raw)) throw new Error('watch must be an object')
  const every = raw.every ?? 5
  if (typeof every !== 'number' || !(every >= 1 && every <= 1440)) throw new Error('watch.every must be minutes between checks, from 1 to 1440')
  const lang = raw.lang ?? null
  if (lang != null && !['en', 'ru'].includes(lang)) throw new Error(`watch.lang must be en or ru, got ${lang}`)
  const command = raw.command ?? null
  if (command != null && (!Array.isArray(command) || !command.length || !command.every(x => typeof x === 'string')))
    throw new Error('watch.command must be an array of strings, e.g. ["node", "send.mjs", "--text"]')
  if (raw.env != null && (!Array.isArray(raw.env) || !raw.env.every(x => typeof x === 'string' && ENV_NAME.test(x)))) throw new Error('watch.env must be a list of environment variable names')
  const rpc = raw.rpc ?? {}
  if (!isObject(rpc)) throw new Error('watch.rpc must be an object like { "solana": "https://...", "solanaEnv": "SOLANA_RPC_URL" }')
  const top = {
    failAfter: count(raw.failAfter, 'watch.failAfter', 2),
    recoverAfter: count(raw.recoverAfter, 'watch.recoverAfter', 2),
    solana: rpc.solana == null ? null : httpUrl(rpc.solana, 'watch.rpc.solana'),
    solanaEnv: envName(rpc.solanaEnv, 'watch.rpc.solanaEnv'),
  }
  if (raw.targets != null && !Array.isArray(raw.targets)) throw new Error('watch.targets must be a list')
  const targets = (raw.targets ?? []).map((x, i) => target(x, i, top, env))
  const seen = new Set()
  for (const t of targets) {
    if (seen.has(t.name.toLowerCase())) throw new Error(`watch: two targets are named "${t.name}"`)
    seen.add(t.name.toLowerCase())
  }
  return {
    every,
    failAfter: top.failAfter,
    recoverAfter: top.recoverAfter,
    lang,
    command,
    env: [...new Set([...(raw.env ?? []), ...[top.solanaEnv, ...targets.map(t => t.rpcEnv)].filter(Boolean)])],
    targets,
  }
}

export const watchUnknownKeys = raw => {
  if (!isObject(raw)) return []
  const out = Object.keys(raw).filter(k => !WATCH_KEYS.includes(k)).map(k => `watch.${k}`)
  if (isObject(raw.rpc)) out.push(...Object.keys(raw.rpc).filter(k => !['solana', 'solanaEnv'].includes(k)).map(k => `watch.rpc.${k}`))
  if (Array.isArray(raw.targets))
    raw.targets.forEach((t, i) => {
      if (isObject(t)) out.push(...Object.keys(t).filter(k => !TARGET_KEYS[''].includes(k) && !(TARGET_KEYS[t.kind] ?? []).includes(k)).map(k => `watch.targets[${i}].${k}`))
    })
  return out
}

export const signalsOf = t => (t.kind === 'site' ? (t.certDays ? ['up', 'cert'] : ['up']) : t.kind === 'heartbeat' ? ['beat'] : ['balance'])

export const step = (state, result, { failAfter, recoverAfter }) => {
  const s = { status: state?.status ?? 'ok', fails: state?.fails ?? 0, oks: state?.oks ?? 0 }
  if (result === 'fail') {
    const fails = s.fails + 1
    return s.status === 'ok' && fails >= failAfter ? { status: 'open', fails, oks: 0, event: 'open' } : { ...s, fails, oks: 0, event: null }
  }
  if (result === 'ok') {
    const oks = s.oks + 1
    return s.status === 'open' && oks >= recoverAfter ? { status: 'ok', fails: 0, oks, event: 'close' } : { ...s, fails: 0, oks, event: null }
  }
  return { ...s, event: null }
}

const errCode = e => (e?.code === 'ABORT_ERR' || e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e?.code ?? e?.name ?? 'error').slice(0, 40))

const pick = (obj, path) => path.split('.').reduce((o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined), obj)

const beatTime = v => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const at = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
    return Number.isFinite(at) && at > 0 ? (at < 1e11 ? at * 1000 : at) : null
  }
  return null
}

const day = ms => new Date(ms).toISOString().slice(0, 10)

const probeSite = async (t, { get, now }) => {
  const cert = t.certDays > 0
  try {
    const r = await get(t.url, { peer: cert, headers: { 'user-agent': 'projium-watch/1', accept: '*/*' } })
    const out = [{ signal: 'up', result: r.status < 400 ? 'ok' : 'fail', detail: [{ k: 'http', status: r.status }] }]
    if (cert) {
      if (r.certExpires == null) out.push({ signal: 'cert', result: 'skip', detail: [{ k: 'nocert' }] })
      else {
        const days = Math.floor((r.certExpires - now) / 864e5)
        out.push({ signal: 'cert', result: days < t.certDays ? 'fail' : 'ok', detail: [{ k: 'cert', date: day(r.certExpires), days }] })
      }
    }
    return { answered: true, signals: out }
  } catch (e) {
    return { answered: false, signals: [{ signal: 'up', result: 'fail', detail: [{ k: 'net', code: errCode(e) }] }, ...(cert ? [{ signal: 'cert', result: 'skip', detail: [{ k: 'nocert' }] }] : [])] }
  }
}

const probeBeat = async (t, { get, now }) => {
  let r
  try {
    r = await get(t.url, { maxBytes: 512e3, headers: { 'user-agent': 'projium-watch/1', accept: 'application/json' } })
  } catch (e) {
    return { answered: false, signals: [{ signal: 'beat', result: 'fail', detail: [{ k: 'net', code: errCode(e) }] }] }
  }
  const one = (result, detail) => ({ answered: true, signals: [{ signal: 'beat', result, detail }] })
  if (r.status !== 200) return one('fail', [{ k: 'http', status: r.status }])
  let j
  try {
    j = JSON.parse(r.body)
  } catch {}
  if (!isObject(j)) return one('fail', [{ k: 'json' }])
  const bad = []
  const good = []
  if (t.field) {
    const off = Object.entries(t.activeWhen ?? {}).find(([k, v]) => pick(j, k) !== v)
    if (off) good.push({ k: 'paused', key: off[0], value: String(pick(j, off[0]) ?? null) })
    else {
      const at = beatTime(pick(j, t.field))
      if (at == null) bad.push({ k: 'nobeat', field: t.field })
      else {
        const ref = Date.parse(r.headers?.date ?? '')
        const age = Math.max(0, Math.round(((Number.isFinite(ref) ? ref : now) - at) / 60e3))
        ;(age > t.maxAgeMin ? bad : good).push({ k: 'beat', age, max: t.maxAgeMin })
      }
    }
  }
  for (const [k, max] of Object.entries(t.max ?? {})) {
    const v = pick(j, k)
    if (typeof v !== 'number' || !Number.isFinite(v)) bad.push({ k: 'nolimit', key: k })
    else if (v > max) bad.push({ k: 'limit', key: k, value: v, max })
  }
  return bad.length ? one('fail', bad) : one('ok', good.length ? good : [{ k: 'http', status: 200 }])
}

const probeBalance = async (t, { get }) => {
  const one = (answered, result, detail) => ({ answered, signals: [{ signal: 'balance', result, detail }] })
  if (!t.rpcUrl) return one(false, 'skip', [{ k: 'norpc', env: t.rpcMissing ?? 'rpc' }])
  const body = JSON.stringify(t.chain === 'solana'
    ? { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [t.address, { commitment: 'confirmed' }] }
    : { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [t.address, 'latest'] })
  let r
  try {
    r = await get(t.rpcUrl, { method: 'POST', body, maxBytes: 64e3, headers: { 'user-agent': 'projium-watch/1', 'content-type': 'application/json', accept: 'application/json' } })
  } catch (e) {
    return one(false, 'skip', [{ k: 'rpc', code: errCode(e) }])
  }
  if (r.status !== 200) return one(true, 'skip', [{ k: 'rpc', code: `HTTP ${r.status}` }])
  let j
  try {
    j = JSON.parse(r.body)
  } catch {}
  if (j?.error) return one(true, 'skip', [{ k: 'rpc', code: String(Number.isInteger(j.error.code) ? j.error.code : 'error') }])
  let value = null
  try {
    value = t.chain === 'solana' ? (Number.isSafeInteger(j?.result?.value) ? j.result.value / 1e9 : null) : /^0x[0-9a-f]+$/i.test(j?.result ?? '') ? Number(BigInt(j.result)) / 1e18 : null
  } catch {}
  if (value == null) return one(true, 'skip', [{ k: 'rpc', code: 'bad answer' }])
  return one(true, value < t.min ? 'fail' : 'ok', [{ k: 'balance', value, min: t.min, unit: t.unit }])
}

const PROBES = { site: probeSite, heartbeat: probeBeat, balance: probeBalance }

const hostOf = t => {
  try {
    return new URL(t.kind === 'balance' ? t.rpcUrl : t.url).host
  } catch {
    return null
  }
}

const parse = s => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export const createWatch = ({ db, config, notify = null, clock = () => Date.now(), get = request, lang = 'en', link = () => null, log = (...a) => console.error(new Date().toISOString(), ...a) }) => {
  const targets = config?.targets ?? []
  const byName = new Map(targets.map(t => [t.name, t]))
  const stateOf = db.prepare('select * from watch_state where key = ?')
  const saveState = db.prepare('insert into watch_state (key, target, signal, status, fails, oks, ts, result, detail, since, incident) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(key) do update set status = excluded.status, fails = excluded.fails, oks = excluded.oks, ts = excluded.ts, result = excluded.result, detail = excluded.detail, since = excluded.since, incident = excluded.incident')
  const openIncident = db.prepare('insert into watch_incidents (target, signal, project, opened_at, first_detail, last_detail, muted) values (?, ?, ?, ?, ?, ?, ?)')
  const touchIncident = db.prepare('update watch_incidents set last_detail = ? where id = ?')
  const closeIncident = db.prepare('update watch_incidents set closed_at = ?, last_detail = ?, end_reason = ? where id = ? and closed_at is null')
  const muteRow = db.prepare('select until from watch_mutes where target = ?')
  let lastTick = null
  let running = null

  const mutedUntil = (name, now = clock()) => {
    const u = muteRow.get(name)?.until
    return u != null && u > now ? u : null
  }

  const runChecks = async now => {
    const runs = await Promise.all(targets.map(async t => {
      const r = await PROBES[t.kind](t, { get, now }).catch(() => ({ answered: false, signals: signalsOf(t).map(signal => ({ signal, result: 'skip', detail: [{ k: 'error' }] })) }))
      return { t, ...r }
    }))
    const hosts = new Set(runs.map(r => hostOf(r.t)).filter(Boolean))
    const offline = runs.length > 0 && hosts.size >= 2 && runs.every(r => !r.answered)
    if (offline) {
      log('watch: no target answered; the network looks down, nothing is counted this round')
      for (const r of runs) r.signals = r.signals.map(s => ({ ...s, result: 'skip' }))
    }
    return { runs, offline }
  }

  const record = (t, s, now) => {
    const key = JSON.stringify([t.name, s.signal])
    const prev = stateOf.get(key)
    const next = step(prev, s.result, t)
    const detail = JSON.stringify(s.detail)
    let incident = prev?.incident ?? null
    if (next.event === 'open') incident = Number(openIncident.run(t.name, s.signal, t.project, now, detail, detail, mutedUntil(t.name, now) ? 1 : 0).lastInsertRowid)
    else if (next.event === 'close') {
      closeIncident.run(now, detail, 'recovered', incident)
      incident = null
    } else if (incident != null && s.result === 'fail') touchIncident.run(detail, incident)
    const since = !prev || prev.status !== next.status ? now : prev.since
    saveState.run(key, t.name, s.signal, next.status, next.fails, next.oks, now, s.result, detail, since, incident)
    return key
  }

  const sweep = (keys, now) => {
    for (const row of db.prepare('select key, incident from watch_state').all())
      if (!keys.has(row.key)) {
        if (row.incident != null) db.prepare("update watch_incidents set closed_at = ?, end_reason = 'removed', close_sent = 1 where id = ? and closed_at is null").run(now, row.incident)
        db.prepare('delete from watch_state where key = ?').run(row.key)
      }
    db.prepare("update watch_incidents set closed_at = ?, end_reason = 'removed', close_sent = 1 where closed_at is null and id not in (select incident from watch_state where incident is not null)").run(now)
    db.prepare('delete from watch_incidents where closed_at is not null and closed_at < ?').run(now - 365 * 864e5)
    db.prepare('delete from watch_mutes where until <= ?').run(now)
  }

  const flush = async now => {
    if (!notify) return 0
    const silent = name => mutedUntil(name, now) != null
    const opens = db.prepare('select * from watch_incidents where closed_at is null and open_sent = 0 order by opened_at').all().filter(r => !silent(r.target))
    const closes = db.prepare('select * from watch_incidents where closed_at is not null and open_sent = 1 and close_sent = 0 and closed_at >= ? order by closed_at').all(now - 864e5).filter(r => !silent(r.target))
    const events = [
      ...opens.map(r => ({ kind: 'open', id: r.id, target: r.target, signal: r.signal, project: r.project, detail: parse(r.last_detail), openedAt: r.opened_at })),
      ...closes.map(r => ({ kind: 'close', id: r.id, target: r.target, signal: r.signal, project: r.project, detail: parse(r.last_detail), openedAt: r.opened_at, closedAt: r.closed_at })),
    ]
    if (!events.length) return 0
    try {
      await notify(alertText(events, { lang, link }))
    } catch (e) {
      log('watch alert failed', String(e?.message ?? e).slice(0, 200))
      return 0
    }
    const sentOpen = db.prepare('update watch_incidents set open_sent = 1 where id = ?')
    const sentClose = db.prepare('update watch_incidents set close_sent = 1 where id = ?')
    for (const e of events) (e.kind === 'open' ? sentOpen : sentClose).run(e.id)
    return events.length
  }

  const tick = () => {
    if (running) return running
    running = (async () => {
      const now = clock()
      const { runs, offline } = await runChecks(now)
      const keys = new Set()
      db.exec('begin')
      try {
        for (const r of runs) for (const s of r.signals) keys.add(record(r.t, s, now))
        sweep(keys, now)
        db.exec('commit')
      } catch (e) {
        db.exec('rollback')
        throw e
      }
      const sent = await flush(now)
      lastTick = { at: now, ms: clock() - now, offline }
      return { ...lastTick, sent }
    })().finally(() => (running = null))
    return running
  }

  const mute = (name, until) => {
    if (!byName.has(name)) throw Object.assign(new Error(`no watch target named ${name}`), { status: 404 })
    if (until == null) return db.prepare('delete from watch_mutes where target = ?').run(name)
    const now = clock()
    if (!Number.isFinite(until) || until <= now || until > now + 30 * 864e5) throw new Error('until must be a time in the next 30 days, in epoch milliseconds')
    db.prepare('insert into watch_mutes (target, until, ts) values (?, ?, ?) on conflict(target) do update set until = excluded.until, ts = excluded.ts').run(name, Math.round(until), now)
  }

  const incidentView = r => ({
    id: r.id, target: r.target, signal: r.signal, project: r.project, openedAt: r.opened_at, closedAt: r.closed_at,
    firstDetail: parse(r.first_detail), lastDetail: parse(r.last_detail), openSent: Boolean(r.open_sent), closeSent: Boolean(r.close_sent), muted: Boolean(r.muted), end: r.end_reason,
  })

  const targetView = t => {
    const states = new Map(db.prepare('select * from watch_state where target = ?').all(t.name).map(r => [r.signal, r]))
    return {
      name: t.name, kind: t.kind, project: t.project,
      url: t.url ?? null, address: t.address ?? null, chain: t.chain ?? null, unit: t.unit ?? null, min: t.min ?? null,
      certDays: t.certDays ?? null, field: t.field ?? null, maxAgeMin: t.maxAgeMin ?? null, activeWhen: t.activeWhen ?? null, max: t.max ?? null,
      rpc: t.kind === 'balance' ? t.rpcFrom : null,
      mutedUntil: mutedUntil(t.name),
      signals: signalsOf(t).map(signal => {
        const s = states.get(signal)
        return { signal, status: s?.status ?? 'ok', result: s?.result ?? null, detail: parse(s?.detail), ts: s?.ts ?? null, since: s?.since ?? null, incident: s?.incident ?? null }
      }),
    }
  }

  const status = ({ limit = 100 } = {}) => ({
    enabled: targets.length > 0,
    every: config?.every ?? null,
    failAfter: config?.failAfter ?? null,
    recoverAfter: config?.recoverAfter ?? null,
    notify: Boolean(notify),
    lastTick,
    targets: targets.map(targetView),
    incidents: db.prepare('select * from watch_incidents order by closed_at is not null, coalesce(closed_at, opened_at) desc limit ?').all(limit).map(incidentView),
  })

  const forProject = name => {
    const own = targets.filter(t => t.project === name)
    if (!own.length) return null
    const views = own.map(targetView)
    return { open: views.reduce((n, v) => n + v.signals.filter(s => s.status === 'open').length, 0), targets: views }
  }

  return { tick, status, mute, forProject, mutedUntil, targets }
}
