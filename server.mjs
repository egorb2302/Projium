import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, Conflict, publicError } from './lib/store.mjs'
import { validate, EDITABLE } from './lib/card.mjs'
import { repoOf, declaredRepos, readiness, freshness, updateFlags, releasePlan, updateBranches, ogImage, uncardedRepos } from './lib/repo.mjs'
import { fetchConfig, updateStatus } from './lib/prod.mjs'
import { createTimeCache, projectSplit, cardTime } from './lib/timesplit.mjs'
import { openDb, checkSite, recordHealth, healthSummary, pruneHealth } from './lib/health.mjs'
import { buildDigest, digestSender, commandSender, isDue, parseAt, localDay } from './lib/digest.mjs'
import { createWatch } from './lib/watch.mjs'
import { request } from './lib/net.mjs'
import { createStreak } from './lib/streak.mjs'
import { loadConfig, ignoreTest, formatOffset, instanceId, configPath } from './lib/config.mjs'
import { settingsView, applySettings, settingsHash, restartKey } from './lib/settings.mjs'
import { pageData, renderPage, writePages, manifestFor, exportedSlugs, CSP, SHOW, SAFE } from './lib/share.mjs'
import { writeRun, clearRun, runFile } from './lib/control.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' }

const SHOWN_FIELDS = ['status', ...EDITABLE]

const VERSION = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version

export { publicError }

export const within = (root, file) => {
  try {
    const real = fs.realpathSync(file)
    return real.startsWith(fs.realpathSync(root) + path.sep) && fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

export const previewPath = (value, projectsRoot, cardDir) => {
  const raw = String(value ?? '').trim().replace(/^!?\[\[/, '').replace(/(\|[^\]]*)?\]\]$/, '').replace(/\\/g, '/')
  if (!/\.(png|jpe?g|webp)$/i.test(raw)) return null
  const marker = `${path.basename(projectsRoot)}/`
  const at = raw.lastIndexOf(marker)
  if (at >= 0 && (at === 0 || raw[at - 1] === '/')) return raw.slice(at + marker.length)
  return raw.includes('/') || !cardDir ? raw : `${cardDir}/${raw}`
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
  cards = {},
  reviewAgents = ['code-reviewer'],
  watch = null,
  sendAlert = null,
  watchLang = null,
  watchGet = request,
  onShutdown = null,
  configFile = null,
  share: shareOpt = null,
} = {}) => {
  const startKey = configFile ? restartKey(configFile) : null
  const digestMinutes = parseAt(digestAt)
  if (digestMinutes == null) throw new Error(`digest time must be HH:MM, got ${digestAt}`)
  const ignored = ignoreTest(ignore)
  const streak = streakOpts && createStreak({ ...streakOpts, atMinutes: digestMinutes, notify: sendDigest, clock, offsetMin: utcOffset, lang: digestLang })
  const store = createStore(projectsRoot, { ...cards, readinessFile })
  const db = openDb(dbFile)
  const repoCache = new Map()
  const prodCache = new Map()
  const timeRows = db.prepare('select file, kind, size, mtime, sig, intervals from transcript_intervals where repo = ?')
  const saveTime = db.prepare('insert into transcript_intervals (repo, file, kind, size, mtime, sig, intervals) values (?, ?, ?, ?, ?, ?, ?) on conflict(repo, file) do update set kind = excluded.kind, size = excluded.size, mtime = excluded.mtime, sig = excluded.sig, intervals = excluded.intervals')
  const timeCache = createTimeCache({
    ignored,
    reviewers: new Set(reviewAgents),
    persist: {
      rows: repo => timeRows.all(repo).map(r => ({ ...r, intervals: JSON.parse(r.intervals) })),
      saveAll: (repo, rows) => {
        db.exec('begin')
        try {
          for (const r of rows) saveTime.run(repo, r.file, r.kind, r.size, r.mtime, r.sig, JSON.stringify(r.intervals))
          db.exec('commit')
        } catch (e) {
          db.exec('rollback')
          throw e
        }
      },
    },
  })
  const timeByCard = new Map()
  const watcher = createWatch({
    db,
    config: watch,
    notify: sendAlert,
    clock,
    get: watchGet,
    lang: watchLang ?? digestLang,
    link: e => `http://127.0.0.1:${bound}/#/${e.project && store.list().some(c => c.name === e.project) ? `p/${encodeURIComponent(e.project)}` : 'watch'}`,
  })

  const shareSettings = () => (configFile ? loadConfig(here, configFile).share ?? { dir: path.join(path.dirname(path.resolve(configFile)), 'share'), every: 0, projects: [] } : shareOpt)
  let lastShare = null
  const sharePage = async (p, now = clock()) => {
    const v = await view(store.load(p.name), true)
    const health = db.prepare('select ts, code from health where project = ? and ts >= ? order by ts').all(p.name, now - 30 * 864e5)
    const incidents = db.prepare("select signal, opened_at, closed_at from watch_incidents where project = ? and signal != 'balance' and opened_at >= ? order by opened_at desc limit 30").all(p.name, now - 90 * 864e5).map(r => ({ signal: r.signal, openedAt: r.opened_at, closedAt: r.closed_at }))
    return renderPage(pageData({ card: v, show: p.show, title: p.title, lang: p.lang ?? digestLang, now, health, incidents }))
  }
  const shareManifest = dir => manifestFor(path.dirname(dbFile), dir)
  const runExport = async () => {
    const s = shareSettings()
    if (!s) return { dir: null, written: [], removed: [], failed: [] }
    const pages = []
    const failed = []
    for (const p of s.projects)
      try {
        pages.push({ name: p.name, slug: p.slug, html: await sharePage(p) })
      } catch (e) {
        failed.push({ name: p.name, slug: p.slug, error: publicError(e) })
      }
    const r = writePages(s.dir, pages, { keep: failed.map(f => f.slug), manifest: shareManifest(s.dir) })
    lastShare = clock()
    return { dir: s.dir, written: r.written, removed: r.removed, failed: [...failed, ...r.skipped] }
  }
  let shareQueue = Promise.resolve()
  const queued = job => {
    const next = shareQueue.catch(() => {}).then(job)
    shareQueue = next
    return next
  }
  const exportShare = () => queued(runExport)
  const clearShareDir = dir => {
    const manifest = shareManifest(dir)
    if (exportedSlugs(manifest).length) writePages(dir, [], { manifest })
  }
  const shareTick = async () => {
    let s
    try {
      s = shareSettings()
    } catch {
      return
    }
    if (!s?.every || (lastShare != null && clock() - lastShare < s.every * 60e3)) return
    await exportShare().catch(e => console.error(new Date().toISOString(), 'share export failed', String(e?.message ?? e).slice(0, 200)))
  }

  const isIgnored = card => ignored(card.name) || [repoOf(reposRoot, card.name, card.text, undefined, card.repoHint), ...declaredRepos(reposRoot, card.name, card.text, card.repoHint)].some(p => p && ignored(p))

  const previewUrl = card => {
    const rel = previewPath(card.fields.preview, projectsRoot, path.relative(projectsRoot, path.dirname(card.file)).replace(/\\/g, '/'))
    return rel && within(projectsRoot, path.resolve(projectsRoot, rel)) ? `/vault/${rel.split('/').map(encodeURIComponent).join('/')}` : null
  }

  const repoLoads = new Map()
  const loadRepoInfo = card => {
    if (!repoLoads.has(card.name))
      repoLoads.set(card.name, (async () => {
        const repo = repoOf(reposRoot, card.name, card.text, ignored, card.repoHint)
        const ready = card.readinessFile && within(projectsRoot, card.readinessFile) ? readiness(path.dirname(card.readinessFile), path.basename(card.readinessFile)) : null
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
    const { text, file, fields, readinessFile: _readiness, repoHint: _hint, ...rest } = card
    const info = await repoInfo(card)
    return {
      ...rest,
      fields: Object.fromEntries(SHOWN_FIELDS.filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]])),
      timeSplit: timeView(card),
      prodUpdates: updateStatus({ plan: info.updates?.plan, branches: info.updates?.branches, config: liveConfig(card) }),
      preview: previewUrl(card) ?? (info.og ? `/og/${encodeURIComponent(card.name)}` : null),
      repoInfo: { ...info, repo: info.repo ? path.basename(info.repo) : null, og: undefined },
      health: detail ? h : { ...h, history: undefined },
      watch: watchView(card.name, detail),
      zone: formatOffset(utcOffset),
      ignored: isIgnored(card),
    }
  }

  const watchView = (name, detail) => {
    const w = watcher.forProject(name)
    return w && (detail ? w : { open: w.open, targets: w.targets.length })
  }

  const timeView = card => {
    const t = timeByCard.get(card.name)
    if (!t) return null
    const key = [card.fields.spec_at, card.fields.first_push_at, card.fields.mainnet_at].join('|')
    if (t.key !== key) {
      t.key = key
      t.phases = projectSplit(t.intervals, card.fields, utcOffset)
    }
    const start = Math.min(...[card.fields.spec_at, card.fields.first_push_at].map(v => cardTime(v, utcOffset)).filter(v => v != null))
    return { sessions: t.sessions, agents: t.agents, kept: t.kept, lost: t.lostAt.filter(at => !(at < start)).length, at: t.at, phases: t.phases }
  }

  const refreshTime = async card => {
    const repo = repoOf(reposRoot, card.name, card.text, ignored, card.repoHint)
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

  const probeable = card => !card.error && !isIgnored(card) && card.fields.site && !validate('site', card.fields.site)
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

  const watchTick = () => watcher.tick().catch(e => console.error(new Date().toISOString(), 'watch failed', String(e?.message ?? e).slice(0, 200)))

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
    if (failed.n >= 10 || (failed.last && now - failed.last < 15 * 60e3 * 2 ** Math.min(failed.n - 1, 3))) return
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
      if (parts[0] === 'api' && parts[1] === 'meta' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, { app: 'projium', version: VERSION, instance: instanceId(projectsRoot), config: configFile ? instanceId(configFile) : null })
      if (parts[0] === 'api' && parts[1] === 'shutdown' && req.method === 'POST' && parts.length === 2) {
        const body = await readBody(req)
        if (!onShutdown) return send(res, 404, { error: 'not found' })
        if ((body.instance !== undefined && body.instance !== instanceId(projectsRoot)) || (body.config !== undefined && body.config !== (configFile ? instanceId(configFile) : null)))
          return send(res, 409, { error: 'this Projium serves another projects folder or config; not stopping' })
        res.once('finish', () => setImmediate(onShutdown))
        return send(res, 200, { stopping: true })
      }
      if (parts[0] === 'api' && parts[1] === 'digest' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, { text: await digestText(clock()), at: digestAt, enabled: Boolean(sendDigest), lastAuto: lastDigest('auto'), lastManual: lastDigest('manual') })
      if (parts[0] === 'api' && parts[1] === 'digest' && parts[2] === 'send' && req.method === 'POST' && parts.length === 3) {
        await readBody(req)
        if (!sendDigest) return send(res, 409, { error: 'no digest channel configured' })
        const sending = deliverDigest('manual')
        if (!sending) return send(res, 409, { error: 'a digest is being sent right now' })
        return send(res, 200, { text: await sending })
      }
      if (parts[0] === 'api' && parts[1] === 'watch' && req.method === 'GET' && parts.length === 2) return send(res, 200, watcher.status())
      if (parts[0] === 'api' && parts[1] === 'watch' && parts[2] === 'mute' && req.method === 'POST' && parts.length === 3) {
        const body = await readBody(req)
        watcher.mute(String(body.target ?? ''), body.until ?? null)
        return send(res, 200, watcher.status())
      }
      if (parts[0] === 'api' && parts[1] === 'watch' && parts[2] === 'check' && req.method === 'POST' && parts.length === 3) {
        await readBody(req)
        if (!watcher.targets.length) return send(res, 409, { error: 'no watch targets configured' })
        await watcher.tick()
        return send(res, 200, watcher.status())
      }
      if (parts[0] === 'api' && parts[1] === 'settings' && parts.length === 2) {
        if (!configFile) return send(res, 404, { error: 'settings are not available in this run' })
        if (req.method === 'GET') return send(res, 200, settingsView(here, configFile, startKey))
        if (req.method === 'POST') {
          const body = await readBody(req)
          const touchesShare = body.share != null || Object.hasOwn(body.set ?? {}, 'shareDir')
          let oldDir = null
          if (touchesShare)
            try {
              oldDir = shareSettings()?.dir ?? null
            } catch {}
          const r = applySettings(here, configFile, body, { names: store.list().filter(c => !c.error).map(c => c.name) })
          let share
          if (touchesShare)
            try {
              const s = shareSettings()
              const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
              const moved = oldDir && s && !same(path.resolve(oldDir), path.resolve(s.dir)) && exportedSlugs(shareManifest(oldDir)).length > 0
              if (moved) await queued(() => clearShareDir(oldDir))
              if (s && (moved || exportedSlugs(shareManifest(s.dir)).length)) {
                const x = await exportShare()
                share = { removed: x.removed, failed: x.failed }
              }
            } catch (e) {
              console.error(new Date().toISOString(), 'share export failed', String(e?.message ?? e).slice(0, 200))
              share = { error: publicError(e) }
            }
          return send(res, 200, { ...settingsView(here, configFile, startKey), backup: r.backup, share })
        }
      }
      if (parts[0] === 'api' && parts[1] === 'share' && req.method === 'GET' && parts.length === 2) {
        const s = shareSettings()
        const fileOf = p => path.join(s.dir, p.slug, 'index.html')
        const at = p => {
          try {
            return fs.statSync(fileOf(p)).mtimeMs
          } catch {
            return null
          }
        }
        return send(res, 200, { enabled: Boolean(configFile || shareOpt), hash: configFile ? settingsHash(configFile) : null, dir: s?.dir ?? null, every: s?.every ?? 0, lastExport: lastShare, show: SHOW, safe: SAFE, projects: (s?.projects ?? []).map(p => ({ ...p, file: fileOf(p), exported: at(p) })) })
      }
      if (parts[0] === 'api' && parts[1] === 'share' && parts[2] === 'export' && req.method === 'POST' && parts.length === 3) {
        await readBody(req)
        return send(res, 200, await exportShare())
      }
      if (parts[0] === 'share' && parts.length === 2 && req.method === 'GET') {
        const p = shareSettings()?.projects.find(x => x.slug === parts[1])
        if (!p) return send(res, 404, { error: 'no shared page with that name' })
        res.writeHead(200, { ...SECURITY, 'content-security-policy': CSP, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(await sharePage(p))
      }
      if (parts[0] === 'api' && parts[1] === 'repos' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, { layout: cards.layout ?? 'folder', repos: uncardedRepos(reposRoot, store.list().filter(c => !c.error), ignored) })
      if (parts[0] === 'api' && parts[1] === 'repos' && parts[2] === 'cards' && req.method === 'POST' && parts.length === 3) {
        const body = await readBody(req)
        if (body.instance !== undefined && body.instance !== instanceId(projectsRoot)) return send(res, 421, { error: 'this Projium serves another projects folder; nothing was written' })
        const names = Array.isArray(body.repos) ? body.repos : []
        if (!names.length || names.length > 200 || !names.every(n => typeof n === 'string')) return send(res, 400, { error: 'repos must be a list of 1 to 200 repo folder names' })
        const open = new Set(uncardedRepos(reposRoot, store.list().filter(c => !c.error), ignored).map(r => r.name))
        const created = []
        const failed = []
        for (const name of names) {
          if (!open.has(name)) {
            failed.push({ name, error: 'not a repo without a card in the repos folder' })
            continue
          }
          try {
            created.push(store.create(name, { stage: body.stage }).name)
          } catch (e) {
            failed.push({ name, error: publicError(e) })
          }
        }
        return send(res, 200, { created, failed })
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && req.method === 'POST' && parts.length === 2) {
        const body = await readBody(req)
        if (body.instance !== undefined && body.instance !== instanceId(projectsRoot)) return send(res, 421, { error: 'this Projium serves another projects folder; nothing was written' })
        return send(res, 200, await view(store.create(body.name, { stage: body.stage, next_step: body.next_step }), true))
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && req.method === 'GET' && parts.length === 2)
        return send(res, 200, await Promise.all(store.list().map(c => (c.error ? c : view(c)))))
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && req.method === 'GET' && parts.length === 3)
        return send(res, 200, await view(store.load(parts[2]), true))
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2] && req.method === 'POST') {
        const body = await readBody(req)
        if (body.instance !== undefined && body.instance !== instanceId(projectsRoot)) return send(res, 421, { error: 'this Projium serves another projects folder; nothing was written' })
        if (parts[3] === 'field') return send(res, 200, await view(store.saveField(parts[2], body.key, body.value, body.expected, body.fileId), true))
        if (parts[3] === 'task') return send(res, 200, await view(store.saveTask(parts[2], body, body.fileId), true))
        if (parts[3] === 'update') return send(res, 200, await view(store.saveUpdate(parts[2], body, body.fileId), true))
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
      if (e?.status === 404) return send(res, 404, { error: e.message })
      return send(res, 400, { error: publicError(e) })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => send(res, 500, { error: publicError(e) }))
  })

  let timer
  let digestTimer
  let timeTimer
  let watchTimer
  const start = () =>
    new Promise((resolve, reject) => {
      const failed = e =>
        reject(e?.code === 'EADDRINUSE' ? Object.assign(new Error(`port ${port} is already in use; set port in tracker.config.json (or PORT in .env.local), or run npm run --silent stop if it is another Projium`), { code: 'EADDRINUSE' }) : e)
      server.once('error', failed)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed)
        bound = server.address().port
        if (checkHealth) {
          warmRepos().catch(() => {})
          healthTick().catch(() => {})
          timer = setInterval(() => healthTick().catch(() => {}), 10 * 60e3)
          digestTimer = setInterval(() => {
            digestTick().catch(() => {})
            streak?.tick().catch(() => {})
            shareTick().catch(() => {})
          }, 60e3)
          setTimeout(() => timeTick().catch(() => {}), 5e3).unref()
          timeTimer = setInterval(() => timeTick().catch(() => {}), 60 * 60e3)
          if (watcher.targets.length) {
            setTimeout(() => watchTick(), 15e3).unref()
            watchTimer = setInterval(watchTick, watch.every * 60e3)
          }
        }
        resolve(server.address().port)
      })
    })
  const stop = () =>
    new Promise(resolve => {
      clearInterval(timer)
      clearInterval(digestTimer)
      clearInterval(timeTimer)
      clearInterval(watchTimer)
      server.closeAllConnections()
      server.close(() => {
        db.close()
        resolve()
      })
    })
  return { start, stop, store, db, digestTick, healthTick, timeTick, watchTick: () => watcher.tick(), watcher, shareTick, exportShare, queueShare: queued }
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
    cards: c.cards,
    reviewAgents: c.reviewAgents,
    digestAt: c.digest.at,
    digestLang: c.digest.lang,
    sendDigest: digestSender(c.digest),
    watch: c.watch,
    watchLang: c.watch?.lang,
    sendAlert: c.watch?.command ? commandSender(c.watch.command, 'alert command') : digestSender(c.digest),
    streak: c.streak,
    configFile: c.file ?? configPath(here),
    onShutdown: () => app.stop().finally(() => {
      clearRun(c)
      process.exit(0)
    }),
  })
  if (c.unknownKeys.length) console.error(`config: unknown keys ignored: ${c.unknownKeys.join(', ')} (run npm run --silent doctor)`)
  const port = await app.start().catch(e => {
    console.error(`projium: ${e?.message ?? e}`)
    process.exit(1)
  })
  try {
    writeRun(c, port, c.file ?? configPath(here))
  } catch (e) {
    console.error(`projium: could not write ${runFile(c)}: ${e?.code ?? e?.message}`)
  }
  console.log(`projium: http://127.0.0.1:${port} (${c.file ? `config ${c.file}` : 'no config file, showing the demo projects'})`)
}
