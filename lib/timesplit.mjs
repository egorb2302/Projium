import fs from 'node:fs'
import path from 'node:path'

export const PAUSE_MS = 3 * 3600e3
const BIG_LINE = 256e3
const TS = /"timestamp":"([^"]+)"/
const none = () => false

export const encodeDir = repo => repo.replace(/[^A-Za-z0-9]/g, '-')

const spellings = repo => {
  const out = [encodeDir(repo).toLowerCase()]
  try {
    const real = encodeDir(fs.realpathSync.native(repo)).toLowerCase()
    if (!out.includes(real)) out.push(real)
  } catch {}
  return out
}

export const transcriptDirs = (root, repo, ignored = none) => {
  if (!repo || ignored(repo) || !fs.existsSync(root)) return []
  const encs = spellings(repo)
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(d => {
      if (!d.isDirectory()) return false
      const n = d.name.toLowerCase()
      return encs.some(enc => n === enc || (n.startsWith(`${enc}-`) && /^-(-claude-worktrees-|wt-)/.test(n.slice(enc.length))))
    })
    .map(d => path.join(root, d.name))
}

export const sessionFiles = dir => {
  const out = []
  const list = p => {
    try {
      return fs.readdirSync(p, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const e of list(dir)) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ kind: 'session', file: path.join(dir, e.name) })
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name, 'subagents')
    for (const f of list(sub)) if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ kind: 'agent', file: path.join(sub, f.name) })
  }
  return out
}

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => String(x.text ?? '')).join('\n') : '')

export const isHuman = j => {
  if (j.origin && typeof j.origin === 'object') return j.origin.kind === 'human'
  if (j.isMeta || j.isCompactSummary) return false
  const c = j.message?.content
  if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return false
  const s = textOf(c).trimStart()
  const hasImage = Array.isArray(c) && c.some(x => x?.type === 'image')
  if (!s) return hasImage
  return !s.startsWith('<') && !s.startsWith('This session is being continued')
}

const isCodex = it => (it?.name === 'Bash' || it?.name === 'PowerShell') && /\bcodex\s+exec\b/.test(String(it.input?.command ?? ''))

export const sessionIntervals = async lines => {
  const events = []
  const codex = []
  const pending = new Map()
  const background = new Map()
  for await (const line of lines) {
    if (!line.includes('"timestamp"')) continue
    if (line.length > BIG_LINE) {
      if (line.includes('"isSidechain":true')) continue
      const ts = Date.parse(line.match(TS)?.[1])
      if (Number.isFinite(ts)) events.push([ts, line.includes('"origin":{"kind":"human"')])
      continue
    }
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain) continue
    const ts = Date.parse(j.timestamp)
    if (!Number.isFinite(ts)) continue
    const c = j.message?.content
    if (j.type === 'assistant') {
      events.push([ts, false])
      if (Array.isArray(c)) for (const it of c) if (it?.type === 'tool_use' && isCodex(it)) pending.set(it.id, ts)
    } else if (j.type === 'user') {
      const results = Array.isArray(c) ? c.filter(x => x?.type === 'tool_result') : []
      if (results.length) {
        events.push([ts, false])
        for (const r of results) {
          if (!pending.has(r.tool_use_id)) continue
          const start = pending.get(r.tool_use_id)
          pending.delete(r.tool_use_id)
          const bg = j.toolUseResult?.backgroundTaskId
          if (bg) background.set(String(bg), start)
          else if (ts - start <= PAUSE_MS) codex.push([start, ts, 'r'])
        }
        continue
      }
      const human = isHuman(j)
      events.push([ts, human])
      if (!human && background.size)
        for (const m of textOf(c).matchAll(/<task-id>([\w-]+)<\/task-id>/g))
          if (background.has(m[1])) {
            const start = background.get(m[1])
            background.delete(m[1])
            if (ts - start <= PAUSE_MS) codex.push([start, ts, 'r'])
          }
    } else if (j.type === 'system') events.push([ts, false])
  }
  events.sort((a, b) => a[0] - b[0])
  const out = events.length > 1 && events.at(-1)[0] > events[0][0] ? [[events[0][0], events.at(-1)[0], 'c']] : []
  for (let i = 1; i < events.length; i++) {
    const [a] = events[i - 1]
    const [b, human] = events[i]
    if (b <= a || b - a > PAUSE_MS) continue
    const k = human ? 'q' : 'w'
    const last = out.at(-1)
    if (last && last[2] === k && last[1] === a) last[1] = b
    else out.push([a, b, k])
  }
  return [...out, ...codex]
}

export const agentInterval = async (lines, agentType, reviewers = new Set(['code-reviewer'])) => {
  const times = []
  for await (const line of lines) {
    const ts = Date.parse(line.match(TS)?.[1])
    if (Number.isFinite(ts)) times.push(ts)
  }
  times.sort((a, b) => a - b)
  const k = reviewers.has(agentType) ? 'r' : 'w'
  const out = []
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]
    const b = times[i]
    if (b <= a || b - a > PAUSE_MS) continue
    const last = out.at(-1)
    if (last && last[1] === a) last[1] = b
    else out.push([a, b, k])
  }
  return out
}

async function* readLines(file) {
  let pending = []
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    if (!chunk.includes('\n')) {
      pending.push(chunk)
      continue
    }
    const parts = chunk.split('\n')
    parts[0] = pending.join('') + parts[0]
    pending = [parts.pop()]
    for (const p of parts) yield p.endsWith('\r') ? p.slice(0, -1) : p
  }
  const rest = pending.join('')
  if (rest) yield rest
}

export const fileIntervals = async ({ kind, file }, reviewers) => {
  if (kind === 'agent') {
    let type = ''
    try {
      type = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? ''
    } catch {}
    return agentInterval(readLines(file), type, reviewers)
  }
  return sessionIntervals(readLines(file))
}

export const split = (intervals, from, to) => {
  const out = { review: 0, work: 0, waiting: 0, pause: 0, missing: 0, total: Math.max(0, to - from), hasData: false }
  if (!(to > from)) return out
  const marks = []
  for (const [s, e, k] of intervals) {
    const a = Math.max(s, from)
    const b = Math.min(e, to)
    if (b > a) marks.push([a, k, 1], [b, k, -1])
  }
  marks.sort((x, y) => x[0] - y[0])
  out.hasData = marks.length > 0
  const open = { r: 0, w: 0, q: 0, c: 0 }
  let prev = from
  const add = (a, b) => {
    if (b <= a) return
    const k = open.r ? 'review' : open.w ? 'work' : open.q ? 'waiting' : open.c ? 'pause' : 'missing'
    out[k] += b - a
  }
  for (const [t, k, d] of marks) {
    add(prev, t)
    open[k] += d
    prev = t
  }
  add(prev, to)
  return out
}

const RELEASED = '.desktop-released.json'

export const releasedSessions = dir => {
  let names = []
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith(RELEASED))
  } catch {
    return []
  }
  return names.map(n => {
    let at = NaN
    try {
      at = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).releasedAt)
    } catch {}
    return { file: path.join(dir, `${n.slice(0, -RELEASED.length)}.jsonl`), at }
  })
}

const repoKey = repo => (process.platform === 'win32' ? path.resolve(repo).toLowerCase() : path.resolve(repo))

export const createTimeCache = ({ ignored = none, reviewers, persist = null } = {}) => {
  const sig = [...(reviewers ?? [])].sort().join(',')
  const files = new Map()
  const byRepo = new Map()
  const stored = new Map()
  const inflight = new Map()
  const scan = async (root, repo) => {
    const key = repoKey(repo)
    if (persist && !stored.has(key)) {
      const saved = persist.rows(key).map(r => ({ ...r, file: path.resolve(root, r.file) }))
      for (const r of saved) if (!files.has(r.file)) files.set(r.file, r)
      stored.set(key, new Set(saved.map(r => r.file)))
      byRepo.set(key, new Set(saved.map(r => r.file)))
    }
    const dirs = transcriptDirs(root, repo, ignored)
    const list = dirs.flatMap(sessionFiles)
    const present = new Set(list.map(f => f.file))
    if (!persist) for (const f of byRepo.get(key) ?? []) if (!present.has(f)) files.delete(f)
    const known = new Set([...(persist ? byRepo.get(key) ?? [] : []), ...present])
    byRepo.set(key, known)
    const fresh = new Map()
    for (const f of list) {
      let st
      try {
        st = fs.statSync(f.file)
      } catch {
        continue
      }
      const hit = files.get(f.file)
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.sig === sig) {
        if (persist && !stored.get(key).has(f.file)) fresh.set(f.file, hit)
        continue
      }
      const got = await fileIntervals(f, reviewers).catch(() => null)
      if (got) fresh.set(f.file, { file: f.file, kind: f.kind, size: st.size, mtime: st.mtimeMs, sig, intervals: got })
    }
    let saved = !persist
    if (persist && fresh.size)
      try {
        persist.saveAll(key, [...fresh.values()].map(r => ({ ...r, file: path.relative(root, r.file) })))
        saved = true
      } catch {}
    if (saved)
      for (const [f, r] of fresh) {
        files.set(f, r)
        stored.get(key)?.add(f)
      }
    const rows = [...known].map(f => fresh.get(f) ?? files.get(f)).filter(Boolean)
    return {
      intervals: rows.flatMap(r => r.intervals),
      sessions: rows.filter(r => r.kind === 'session').length,
      agents: rows.filter(r => r.kind === 'agent').length,
      kept: rows.filter(r => !present.has(r.file) && r.kind === 'session').length,
      lostAt: dirs.flatMap(releasedSessions).filter(m => !files.has(m.file) && !fresh.has(m.file)).map(m => m.at),
    }
  }
  const collect = (root, repo) => {
    const key = repoKey(repo)
    if (!inflight.has(key)) inflight.set(key, scan(root, repo).finally(() => inflight.delete(key)))
    return inflight.get(key)
  }
  return { collect }
}

export const cardTime = (s, offset = 0) => {
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s ?? '') ? Date.parse(`${s}:00Z`) - offset * 60e3 : NaN
  return Number.isFinite(t) ? t : null
}

export const projectSplit = (intervals, fields, offset = 0) => {
  const spec = cardTime(fields.spec_at, offset)
  const push = cardTime(fields.first_push_at, offset)
  const main = cardTime(fields.mainnet_at, offset)
  const phases = {}
  if (spec != null && push != null) phases.toFirstPush = split(intervals, spec, push)
  if (push != null && main != null) phases.toMainnet = split(intervals, push, main)
  if (spec != null && main != null) phases.total = split(intervals, spec, main)
  return phases
}
