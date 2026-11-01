const ZONE_RE = /^([+-])(\d\d):(\d\d)$/

export const todayIn = (zone, now = Date.now()) => {
  const m = ZONE_RE.exec(zone ?? '')
  const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60e3 : -new Date(now).getTimezoneOffset() * 60e3
  return new Date(now + off).toISOString().slice(0, 10)
}

export const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5)

const PRIO = { p1: 0, p2: 1, p3: 2 }

export const taskState = (x, today) => (x.done || !x.due ? '' : x.due < today ? 'over' : dayDiff(today, x.due) <= 2 ? 'soon' : '')

const taskRank = (x, today) => [x.done ? 1 : 0, taskState(x, today) === 'over' ? 0 : 1, PRIO[x.p] ?? 3, x.due || '9999']

export const sortTasks = (list, today) =>
  [...list].sort((a, b) => {
    const ra = taskRank(a, today)
    const rb = taskRank(b, today)
    const i = ra.findIndex((v, k) => v !== rb[k])
    return i < 0 ? 0 : ra[i] < rb[i] ? -1 : 1
  })

export const topTask = (p, now) => {
  const today = todayIn(p.zone, now)
  return sortTasks(p.tasks.filter(x => !x.done), today).find(x => taskState(x, today) || x.p === 'p1') ?? null
}

export const targetState = t => {
  if (t.signals.some(s => s.status === 'open')) return 'open'
  if (t.signals.every(s => s.result == null)) return 'wait'
  if (t.signals.every(s => s.result == null || s.result === 'skip')) return 'skip'
  return 'ok'
}

export const watchSummary = (targets, now = Date.now()) => {
  const out = { ok: 0, open: 0, wait: 0, skip: 0, muted: 0 }
  for (const t of targets) {
    out[targetState(t)]++
    if (t.mutedUntil != null && t.mutedUntil > now) out.muted++
  }
  return out
}

export const signalData = (p, now) => {
  if (p.ignored) return []
  const today = todayIn(p.zone, now)
  const open = p.tasks.filter(x => !x.done)
  const live = p.fields.stage !== 'done'
  const over = open.filter(x => taskState(x, today) === 'over').length
  const soon = open.filter(x => taskState(x, today) === 'soon').length
  const p1 = live ? open.filter(x => x.p === 'p1' && taskState(x, today) !== 'over').length : 0
  const last = p.health?.last
  const down = live && p.fields.site && last && !(last.code != null && last.code < 400)
  const f = p.repoInfo?.freshness ?? {}
  const behind = Math.max(f.sinceLocal ?? 0, f.sinceOrigin ?? 0)
  const stale = live && f.state === 'changed-after'
  const incidents = p.watch?.open ?? 0
  return [
    incidents && { kind: 'incident', tone: 'bad', w: 100 * incidents, n: incidents },
    down && { kind: 'down', tone: 'bad', w: 100, n: 1 },
    over && { kind: 'over', tone: 'bad', w: 30 * over, n: over },
    p1 && { kind: 'p1', tone: 'warn', w: 10 * p1, n: p1 },
    soon && { kind: 'soon', tone: 'warn', w: 8 * soon, n: soon },
    stale && { kind: 'stale', tone: 'off', w: 1, n: behind },
  ].filter(Boolean)
}
