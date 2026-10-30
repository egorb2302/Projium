import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, Conflict } from './lib/store.mjs'
import { validate, EDITABLE } from './lib/card.mjs'
import { repoOf, readiness, freshness, updateFlags, releasePlan, updateBranches, ogImage } from './lib/repo.mjs'
import { fetchConfig, updateStatus } from './lib/prod.mjs'
import { createTimeCache, projectSplit } from './lib/timesplit.mjs'
import { openDb, checkSite, recordHealth, healthSummary, pruneHealth } from './lib/health.mjs'
import { buildDigest, digestSender, isDue, parseAt, localDay } from './lib/digest.mjs'
import { createStreak } from './lib/streak.mjs'
import { loadConfig, ignoreTest, formatOffset } from './lib/config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }

const SHOWN_FIELDS = ['status', ...EDITABLE]

export const publicError = e => (typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code) ? e.code : String(e?.message ?? e))

export const within = (root, file) => {
  try {
    const real = fs.realpathSync(file)
    return real.startsWith(fs.realpathSync(root) + path.sep) && fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

export const previewPath = (value, projectsRoot, cardName) => {
  const raw = String(value ?? '').trim().replace(/^!?\[\[/, '').replace(/(\|[^\]]*)?\]\]$/, '').replace(/\\/g, '/')
  if (!/\.(png|jpe?g|webp)$/i.test(raw)) return null
  const marker = `${path.basename(projectsRoot)}/`
  const at = raw.lastIndexOf(marker)
  if (at >= 0 && (at === 0 || raw[at - 1] === '/')) return raw.slice(at + marker.length)
  return raw.includes('/') ? raw : `${cardName}/${raw}`
}

export const createApp = ({
  projectsRoot = path.join(here, 'demo', 'projects'),
  reposRoot = path.join(here, 'demo', 'repos'),
  dbFile = path.join(here, 'data', 'tracker.db'),
  port = 3210,
  checkHealth = true,
  readConfig = fetchConfig,
  probeSite = checkSite,
  transcriptsRoot = path.join(here, 'demo', 'transcripts'),
  digestAt = '10:00',
  digestLang = 'en',
  sendDigest = null,
  clock = () => Date.now(),
  streak: streakOpts = null,
  utcOffset = 0,
  ignore = [],
  readinessFile = 'READINESS.md',
  reviewAgents = ['code-reviewer'],
} = {}) => {
  const digestMinutes = parseAt(digestAt)
  if (digestMinutes == null) throw new Error(`digest time must be HH:MM, got ${digestAt}`)
  const ignored = ignoreTest(ignore)
  const streak = streakOpts && createStreak({ ...streakOpts, atMinutes: digestMinutes, notify: sendDigest, clock, offsetMin: utcOffset, lang: digestLang })
  const store = createStore(projectsRoot)
  const db = openDb(dbFile)
  const repoCache = new Map()
  const prodCache = new Map()
  const timeCache = createTimeCache({ ignored, reviewers: new Set(reviewAgents) })
  const timeByCard = new Map()

  const previewUrl = card => {
    const rel = previewPath(card.fields.preview, projectsRoot, card.name)
    return rel && within(projectsRoot, path.resolve(projectsRoot, rel)) ? `/vault/${rel.split('/').map(encodeURIComponent).join('/')}` : null
  }

  const repoLoads = new Map()
  const loadRepoInfo = card => {
    if (!repoLoads.has(card.name))
      repoLoads.set(card.name, (async () => {
        const repo = repoOf(reposRoot, card.name, card.text, ignored)
        const ready = within(projectsRoot, path.join(path.dirname(card.file), readinessFile)) ? readiness(path.dirname(card.file), readinessFile) : null
        const info = { repo, og: ogImage(repo), readiness: ready, freshness: await freshness(repo, ready?.commit), updates: { ...updateFlags(repo), plan: releasePlan(repo), branches: await updateBranches(repo) } }
        repoCache.set(card.name, { ts: Date.now(), ttl: info.freshness.state === 'git-unavailable' ? 60e3 : 5 * 60e3, info })
        return info
      })().finally(() => repoLoads.delete(card.name)))
    return repoLoads.get(card.name)
  }

  const repoInfo = async (card, force = false) => {
    const hit = repoCache.get(card.name)
    if (hit && !force) {
      if (Date.now() - hit.ts >= hit.ttl) loadRepoInfo(card).catch(() => {})
      return hit.info
    }
    return loadRepoInfo(card)
  }

  const warmRepos = async () => {
    for (const card of store.list()) if (!card.error) await loadRepoInfo(card).catch(() => {})
  }

  const view = async (card, detail = false) => {
    const h = healthSummary(db, card.name)
    const { text, file, fields, ...rest } = card
    const info = await repoInfo(card)
    return {
      ...rest,
      fields: Object.fromEntries(SHOWN_FIELDS.filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]])),
      timeSplit: timeView(card),
      prodUpdates: updateStatus({ plan: info.updates?.plan, branches: info.updates?.branches, config: liveConfig(card) }),
      preview: previewUrl(card) ?? (info.og ? `/og/${encodeURIComponent(card.name)}` : null),
      repoInfo: { ...info, repo: info.repo ? path.basename(info.repo) : null, og: undefined },
      health: detail ? h : { ...h, history: undefined },
      zone: formatOffset(utcOffset),
    }
  }

  const timeView = card => {
    const t = timeByCard.get(card.name)
    if (!t) return null
    const key = [card.fields.spec_at, card.fields.first_push_at, card.fields.mainnet_at].join('|')
    if (t.key !== key) {
      t.key = key
      t.phases = projectSplit(t.intervals, card.fields, utcOffset)
    }
    return { sessions: t.sessions, agents: t.agents, at: t.at, phases: t.phases }
  }

  const refreshTime = async card => {
    const repo = repoOf(reposRoot, card.name, card.text, ignored)
    if (!repo) return timeByCard.delete(card.name)
    const started = clock()
    const got = await timeCache.collect(transcriptsRoot, repo)
    if ((timeByCard.get(card.name)?.at ?? -Infinity) <= started) timeByCard.set(card.name, { ...got, at: started })
  }

  let timeBusy = false
  const timeTick = async () => {
    if (timeBusy) return
    timeBusy = true
    try {
      for (const card of store.list()) {
        if (card.error) continue
        try {
          await refreshTime(card)
        } catch (e) {
          console.error(new Date().toISOString(), 'time split failed for', card.name, String(e?.code ?? e?.name ?? 'error'))
        }
      }
    } finally {
      timeBusy = false
    }
  }

  const probeable = card => !card.error && !ignored(card.name) && card.fields.site && !validate('site', card.fields.site)
  const watched = card => probeable(card) && card.fields.stage !== 'done'
  const checkProd = async card => {
    const [health, config] = await Promise.all([probeSite(card.fields.site), readConfig(card.fields.site)])
    recordHealth(db, card.name, health)
    prodCache.set(card.name, { ...config, site: card.fields.site, ts: clock() })
  }

  const liveConfig = card => {
    const c = prodCache.get(card.name)
    if (!c || !watched(card) || c.site !== card.fields.site || clock() - c.ts > 25 * 60e3) return undefined
    return c
  }

  const healthTick = async () => {
    for (const card of store.list()) {
      if (watched(card)) await checkProd(card)
      else prodCache.delete(card.name)
    }
    pruneHealth(db)
  }

  const lastDigest = kind => db.prepare('select day, ts from digest_sent where kind = ? order by ts desc limit 1').get(kind) ?? null
  const failuresOn = day => db.prepare("select count(*) n, max(ts) last from digest_sent where kind = 'auto-failed' and day = ?").get(day)
  const logDigest = (day, ts, kind) => db.prepare('insert into digest_sent (day, ts, kind) values (?, ?, ?)').run(day, ts, kind)

  const digestText = async now => {
    const projects = []
    for (const c of store.list()) {
      if (c.error) projects.push(c)
      else
        try {
          projects.push(await view(c))
        } catch (e) {
          projects.push({ name: c.name, error: publicError(e) })
        }
    }
    return buildDigest(projects, now, { offset: utcOffset, lang: digestLang, ignored, url: `http://127.0.0.1:${bound}` })
  }

  let digestInFlight = null
  const deliverDigest = kind => {
    if (digestInFlight) return null
    const now = clock()
    digestInFlight = (async () => {
      try {
        await healthTick().catch(() => {})
        const text = await digestText(now)
        await sendDigest(text)
        logDigest(localDay(now, utcOffset), clock(), kind)
        return text
      } catch (e) {
        if (kind === 'auto') logDigest(localDay(now, utcOffset), clock(), 'auto-failed')
        throw e
      } finally {
        digestInFlight = null
      }
    })()
    return digestInFlight
  }

  const digestTick = async () => {
    const now = clock()
    if (!sendDigest || digestInFlight || !isDue(now, digestMinutes, lastDigest('auto')?.day, utcOffset)) return
    const failed = failuresOn(localDay(now, utcOffset))
    if (failed.n >= 3 || (failed.last && now - failed.last < 15 * 60e3)) return
    try {
      await deliverDigest('auto')
    } catch (e) {
      console.error(new Date(now).toISOString(), 'digest failed', String(e?.message ?? e).slice(0, 300))
    }
  }

  const SECURITY = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
  }

  const send = (res, code, body) => {
    if (res.headersSent) return res.end()
    res.writeHead(code, { ...SECURITY, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const sendFile = (res, file, type, cache) => {
    const stream = fs.createReadStream(file)
    stream.on('error', () => send(res, 404, { error: 'not found' }))
    stream.once('open', () => {
      res.writeHead(200, { ...SECURITY, 'content-type': type, 'cache-control': cache })
      stream.pipe(res)
    })
  }

  const readBody = req =>
    new Promise((resolve, reject) => {
      let s = ''
      req.setEncoding('utf8')
      req.on('error', reject)
      req.on('aborted', () => reject(new Error('aborted')))
      req.on('data', c => {
        s += c
        if (s.length > 64e3) {
          reject(new Error('body too large'))
          req.destroy()
        }
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(s || '{}'))
        } catch {
          reject(new Error('bad json'))
        }
      })
    })

  let bound = port
  const localHost = h => new RegExp(`^(127\\.0\\.0\\.1|localhost):${bound}$`).test(h ?? '')

  const handle = async (req, res) => {
    if (!localHost(req.headers.host)) return send(res, 403, { error: 'bad host' })
    const url = new URL(req.url, `http://${req.headers.host}`)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (req.method === 'POST') {
      const origin = req.headers.origin
      if (origin && !localHost(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'bad origin' })
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'json only' })
    }

    try {
      if (parts[0] === 'api' && parts[1] === 'digest' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, { text: await digestText(clock()), at: digestAt, enabled: Boolean(sendDigest), lastAuto: lastDigest('auto'), lastManual: lastDigest('manual') })
      if (parts[0] === 'api' && parts[1] === 'digest' && parts[2] === 'send' && req.method === 'POST' && parts.length === 3) {
        await readBody(req)
        if (!sendDigest) return send(res, 409, { error: 'no digest channel configured' })
        const sending = deliverDigest('manual')
        if (!sending) return send(res, 409, { error: 'a digest is being sent right now' })
        return send(res, 200, { text: await sending })
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, await Promise.all(store.list().map(c => (c.error ? c : view(c)))))
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && req.method === 'GET' && parts.length === 3)
        return send(res, 200, await view(store.load(parts[2]), true))
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && req.method === 'POST') {
        const body = await readBody(req)
        if (parts[3] === 'field') return send(res, 200, await view(store.saveField(parts[2], body.key, body.value, body.expected), true))
        if (parts[3] === 'task') return send(res, 200, await view(store.saveTask(parts[2], body), true))
        if (parts[3] === 'refresh') {
          const card = store.load(parts[2])
          await repoInfo(card, true)
          if (probeable(card)) await checkProd(card)
          await refreshTime(card).catch(() => {})
          return send(res, 200, await view(card, true))
        }
      }
      if (parts[0] === 'vault' && req.method === 'GET') {
        const rel = parts.slice(1).join('/')
        const file = within(projectsRoot, path.resolve(projectsRoot, rel))
        if (!file || !/\.(png|jpe?g|webp)$/i.test(file)) return send(res, 404, { error: 'not found' })
        return sendFile(res, file, TYPES[path.extname(file).toLowerCase()], 'max-age=300')
      }
      if (parts[0] === 'og' && parts.length === 2 && req.method === 'GET') {
        const info = repoCache.get(parts[1])?.info
        const og = info?.og && info.repo && within(info.repo, info.og)
        if (!og) return send(res, 404, { error: 'not found' })
        return sendFile(res, og, TYPES[path.extname(og).toLowerCase()], 'max-age=300')
      }
      if (req.method === 'GET' && parts[0] !== 'api') {
        const pub = path.join(here, 'public')
        const file = within(pub, path.resolve(pub, parts.length ? parts.join('/') : 'index.html')) || path.join(pub, 'index.html')
        return sendFile(res, file, TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'no-cache')
      }
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      if (e instanceof Conflict) return send(res, 409, { error: e.message, current: e.current })
      return send(res, 400, { error: publicError(e) })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => send(res, 500, { error: publicError(e) }))
  })

  let timer
  let digestTimer
  let timeTimer
  const start = () =>
    new Promise(resolve => {
      server.listen(port, '127.0.0.1', () => {
        bound = server.address().port
        if (checkHealth) {
          warmRepos().catch(() => {})
          healthTick().catch(() => {})
          timer = setInterval(() => healthTick().catch(() => {}), 10 * 60e3)
          digestTimer = setInterval(() => {
            digestTick().catch(() => {})
            streak?.tick().catch(() => {})
          }, 60e3)
          setTimeout(() => timeTick().catch(() => {}), 5e3).unref()
          timeTimer = setInterval(() => timeTick().catch(() => {}), 60 * 60e3)
        }
        resolve(server.address().port)
      })
    })
  const stop = () =>
    new Promise(resolve => {
      clearInterval(timer)
      clearInterval(digestTimer)
      clearInterval(timeTimer)
      server.close(() => {
        db.close()
        resolve()
      })
    })
  return { start, stop, store, db, digestTick, healthTick, timeTick }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('uncaughtException', e => console.error(new Date().toISOString(), 'uncaught', e?.stack ?? e))
  process.on('unhandledRejection', e => console.error(new Date().toISOString(), 'unhandled', e?.stack ?? e))
  const c = loadConfig(here)
  const app = createApp({
    projectsRoot: c.projectsDir,
    reposRoot: c.reposDir,
    transcriptsRoot: c.transcriptsDir,
    dbFile: c.dbFile,
    port: c.port,
    utcOffset: c.utcOffset,
    ignore: c.ignore,
    readinessFile: c.readinessFile,
    reviewAgents: c.reviewAgents,
    digestAt: c.digest.at,
    digestLang: c.digest.lang,
    sendDigest: digestSender(c.digest),
    streak: c.streak,
  })
  const port = await app.start()
  console.log(`tracker: http://127.0.0.1:${port} (${c.file ? `config ${c.file}` : 'no config file, showing the demo projects'})`)
}
