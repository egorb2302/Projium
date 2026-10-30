import { request, publicOnly } from './net.mjs'

export const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')

const MAX_BYTES = 512e3

const booleans = obj => {
  const out = Object.create(null)
  let n = 0
  for (const [k, v] of Object.entries(obj))
    if (typeof v === 'boolean' && k.length <= 64 && n < 100) {
      out[k] = v
      n++
    }
  return out
}

const byNorm = obj => {
  const out = Object.create(null)
  for (const [k, v] of Object.entries(obj)) out[norm(k)] = v
  return out
}

export const fetchConfig = async (site, timeoutMs = 15000, now = Date.now(), lookup = publicOnly) => {
  try {
    const res = await request(`${site.replace(/\/$/, '')}/api/config`, { timeoutMs, lookup, maxBytes: MAX_BYTES, headers: { 'user-agent': 'projium/1', accept: 'application/json' } })
    if (res.status !== 200) return { ok: false, ts: now, error: `HTTP ${res.status}` }
    const j = JSON.parse(res.body)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, ts: now, error: 'config is not an object' }
    const features = j.features && typeof j.features === 'object' && !Array.isArray(j.features) ? booleans(j.features) : Object.create(null)
    return { ok: true, ts: now, top: byNorm(booleans(j)), features }
  } catch (e) {
    return { ok: false, ts: now, error: e?.message === 'too large' ? 'config too large' : String(e?.code ?? e?.name ?? 'error').slice(0, 80) }
  }
}

const flagValue = (config, name) => {
  if (!config?.ok) return null
  const feat = byNorm(config.features)
  const full = norm(name)
  const short = norm(name.replace(/^FEATURE_/i, ''))
  const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined)
  return own(feat, short) ?? own(feat, full) ?? own(config.top, short) ?? own(config.top, full) ?? null
}

const combine = vals => {
  if (vals.some(v => v == null)) return 'unknown'
  if (vals.every(v => v === true)) return 'on'
  if (vals.every(v => v === false)) return 'off'
  return 'partly'
}

export const updateStatus = ({ plan, branches, config }) => {
  const byN = new Map()
  const entry = n => {
    if (!byN.has(n)) byN.set(n, { n, flags: [], branch: null, state: 'unknown' })
    return byN.get(n)
  }
  for (const u of plan ?? []) for (const name of u.flags) entry(u.n).flags.push({ name, prod: flagValue(config, name) })
  for (const b of branches ?? []) entry(b.n).branch = { name: b.branch, sha: b.sha, inMain: b.inMain }
  const covered = new Set([...byN.values()].flatMap(e => e.flags.map(f => norm(f.name.replace(/^FEATURE_/i, '')))))
  const loose = config?.ok ? Object.entries(config.features).filter(([k]) => !covered.has(norm(k))).map(([k, v]) => ({ n: null, flags: [{ name: k, prod: v }], branch: null, state: v ? 'on' : 'off' })) : []
  for (const e of byN.values()) {
    if (e.flags.length) e.state = combine(e.flags.map(f => f.prod))
    else if (e.branch) e.state = e.branch.inMain == null ? 'unknown' : e.branch.inMain ? 'merged' : 'branch'
  }
  const entries = [...[...byN.values()].sort((a, b) => a.n - b.n), ...loose]
  return { entries, checkedAt: config?.ts ?? null, configError: config && !config.ok ? config.error : null }
}
