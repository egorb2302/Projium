import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { request, publicOnly } from './net.mjs'

export const openDb = file => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    create table if not exists health (project text not null, ts integer not null, code integer, ms integer, error text);
    create index if not exists health_project_ts on health(project, ts);
    create table if not exists digest_sent (day text not null, ts integer not null, kind text not null);
  `)
  return db
}

export const checkSite = async (url, timeoutMs = 15000, lookup = publicOnly) => {
  const t0 = Date.now()
  try {
    const res = await request(url, { timeoutMs, lookup, headers: { 'user-agent': 'projium/1', accept: '*/*' } })
    return { code: res.status, ms: Date.now() - t0, error: null }
  } catch (e) {
    return { code: null, ms: Date.now() - t0, error: String(e?.code ?? e?.name ?? 'error').slice(0, 80) }
  }
}

export const recordHealth = (db, project, r, ts = Date.now()) =>
  db.prepare('insert into health (project, ts, code, ms, error) values (?, ?, ?, ?, ?)').run(project, ts, r.code, r.ms, r.error)

export const healthSummary = (db, project, now = Date.now()) => {
  const rows = db.prepare('select ts, code, ms, error from health where project = ? and ts >= ? order by ts').all(project, now - 7 * 864e5)
  const day = rows.filter(r => r.ts >= now - 864e5)
  const ok = r => r.code != null && r.code < 400
  return {
    last: rows.at(-1) ?? null,
    uptime24: day.length ? Math.round((day.filter(ok).length / day.length) * 1000) / 10 : null,
    checks24: day.length,
    history: rows.map(r => ({ ts: r.ts, ok: ok(r), ms: r.ms })),
  }
}

export const pruneHealth = (db, now = Date.now()) => db.prepare('delete from health where ts < ?').run(now - 30 * 864e5)
