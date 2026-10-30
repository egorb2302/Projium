import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const none = () => false

const clip = (s, n = 140) => {
  const t = String(s).replace(/`/g, '')
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

export const localDay = (now = Date.now(), offset = 0) => new Date(now + offset * 60e3).toISOString().slice(0, 10)
export const localMinutes = (now = Date.now(), offset = 0) => {
  const d = new Date(now + offset * 60e3)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const parseAt = at => {
  const m = String(at ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export const isDue = (now, atMinutes, lastDay, offset = 0) => localMinutes(now, offset) >= atMinutes && lastDay !== localDay(now, offset)

const WORDS = {
  en: {
    title: day => `Tracker digest for ${day}`,
    lateDone: 'Due dates in closed projects:',
    more: n => `- and ${n} more`,
    broken: 'Cards that cannot be read:',
    ignored: names => `Ignored, not tracked: ${names}`,
    active: n => `In progress: ${n}`,
    next: 'Next',
    down: 'Site is down',
    uptime: u => `Site over 24 h: ${u}% of checks ok`,
    audit: 'Audit',
    updates: 'Updates',
    tasks: n => `Tasks: ${n} open`,
    panel: 'Dashboard',
    due: (d, late, today) => ` (due ${d}${late ? ', overdue' : today ? ', today' : ''})`,
    stale: (n, sha, dirty) => `audit is stale: ${[n ? `${n} commit(s) after ${sha}` : '', dirty ? `${dirty} uncommitted file(s)` : ''].filter(Boolean).join(', ')}`,
    noAuditCommit: 'no audit with a commit',
    auditUnknown: sha => `audit commit ${sha} is not in the repo`,
    gitDown: 'git did not answer, audit freshness unknown',
    loose: s => `site flags without an update number: ${s}`,
    states: [['on', 'on in prod'], ['partly', 'partly on'], ['merged', 'merged into main'], ['off', 'off'], ['branch', 'on branches'], ['unknown', 'state unknown']],
  },
  ru: {
    title: day => `Трекер, сводка на ${day}`,
    lateDone: 'Сроки в закрытых проектах:',
    more: n => `- и ещё ${n}`,
    broken: 'Карточки не читаются:',
    ignored: names => `Остановлены, не трогаем: ${names}`,
    active: n => `В работе: ${n}`,
    next: 'Дальше',
    down: 'Сайт не отвечает',
    uptime: u => `Сайт за сутки: ${u}% проверок ок`,
    audit: 'Аудит',
    updates: 'Апдейты',
    tasks: n => `Задачи: ${n} открыто`,
    panel: 'Панель',
    due: (d, late, today) => ` (до ${d}${late ? ', просрочено' : today ? ', сегодня' : ''})`,
    stale: (n, sha, dirty) => `аудит устарел: ${[n ? `${n} коммит(ов) после ${sha}` : '', dirty ? `${dirty} файл(ов) не закоммичено` : ''].filter(Boolean).join(', ')}`,
    noAuditCommit: 'аудита с коммитом нет',
    auditUnknown: sha => `коммита аудита ${sha} нет в репо`,
    gitDown: 'git не ответил, свежесть аудита неизвестна',
    loose: s => `флаги сайта без номера апдейта: ${s}`,
    states: [['on', 'включено на проде'], ['partly', 'включено частично'], ['merged', 'влито в main'], ['off', 'выключено'], ['branch', 'на ветках'], ['unknown', 'состояние неизвестно']],
  },
}

const siteDown = h => h?.last && (h.last.code == null || h.last.code >= 400)

const auditLine = (f, w) => {
  if (!f || f.state === 'no-repo') return null
  if (f.state === 'changed-after') return w.stale(Math.max(f.sinceLocal ?? 0, f.sinceOrigin ?? 0, f.behindAudit ?? 0), f.commit, f.dirty)
  if (f.state === 'no-audit-commit') return w.noAuditCommit
  if (f.state === 'audit-commit-unknown') return w.auditUnknown(f.commit)
  if (f.state === 'git-unavailable') return w.gitDown
  return null
}

const countWords = (entries, w) => {
  const c = {}
  for (const e of entries) c[e.state] = (c[e.state] ?? 0) + 1
  return w.states.filter(([k]) => c[k]).map(([k, s]) => `${c[k]} ${s}`).join(', ')
}

const updatesLine = (status, w) => {
  const all = status?.entries ?? []
  const numbered = countWords(all.filter(e => e.n != null), w)
  const loose = countWords(all.filter(e => e.n == null), w)
  return [numbered, loose ? w.loose(loose) : ''].filter(Boolean).join('; ')
}

const taskLine = (t, today, w) => `${clip(t.text)}${t.due ? w.due(t.due, t.due < today, t.due === today) : ''}${t.p ? ` ${t.p}` : ''}`

const byUrgency = today => (a, b) => {
  const rank = t => (t.due && t.due <= today ? 0 : t.p === 'p1' ? 1 : t.due ? 2 : 3)
  return rank(a) - rank(b) || (a.due || '9').localeCompare(b.due || '9') || (a.p || 'p9').localeCompare(b.p || 'p9')
}

export const buildDigest = (projects, now = Date.now(), { offset = 0, lang = 'en', ignored = none, url = 'http://127.0.0.1:3210' } = {}) => {
  const w = WORDS[lang] ?? WORDS.en
  const today = localDay(now, offset)
  const cards = projects.filter(p => !p.error)
  const skip = p => p.ignored === true || ignored(p.name)
  const stopped = cards.filter(skip)
  const live = cards.filter(p => !skip(p))
  const active = live.filter(p => p.fields.stage !== 'done')
  const out = [w.title(today)]

  const late = live
    .filter(p => p.fields.stage === 'done')
    .flatMap(p => p.tasks.filter(t => !t.done && t.due && t.due <= today).map(t => `- ${p.name}: ${taskLine(t, today, w)}`))
  if (late.length) out.push('', w.lateDone, ...late.slice(0, 10), ...(late.length > 10 ? [w.more(late.length - 10)] : []))

  const broken = projects.filter(p => p.error).map(p => (ignored(p.name) ? `- ${p.name}` : `- ${p.name}: ${clip(p.error)}`))
  if (broken.length) out.push('', w.broken, ...broken)

  const halted = stopped.filter(p => p.fields.stage !== 'done')
  if (halted.length) out.push('', w.ignored(halted.map(p => p.name).join(', ')))

  out.push('', w.active(active.length))
  for (const p of active) {
    const open = p.tasks.filter(t => !t.done).sort(byUrgency(today))
    out.push('', `${p.name}: ${p.fields.stage}`)
    if (p.fields.next_step) out.push(`${w.next}: ${clip(p.fields.next_step)}`)
    if (siteDown(p.health)) out.push(`${w.down}: ${p.health.last.code ?? p.health.last.error}`)
    else if (p.health?.uptime24 != null && p.health.uptime24 < 100) out.push(w.uptime(p.health.uptime24))
    const audit = auditLine(p.repoInfo?.freshness, w)
    if (audit) out.push(`${w.audit}: ${audit}`)
    const ups = updatesLine(p.prodUpdates, w)
    if (ups) out.push(`${w.updates}: ${ups}`)
    if (open.length) {
      out.push(w.tasks(open.length))
      for (const t of open.slice(0, 3)) out.push(`- ${taskLine(t, today, w)}`)
      if (open.length > 3) out.push(w.more(open.length - 3))
    }
  }

  out.push('', `${w.panel}: ${url}`)
  const text = out.join('\n')
  if (text.length <= 4000) return text
  const cut = text.slice(0, 3990)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…`
}

export const commandSender = command => async text => {
  const [bin, ...args] = command
  try {
    await run(bin === 'node' ? process.execPath : bin, [...args, text], { timeout: 60e3, windowsHide: true })
  } catch (e) {
    throw new Error(`digest command: ${e?.killed ? 'timed out' : typeof e?.code === 'number' ? `exit ${e.code}` : 'did not start'}`)
  }
}

export const telegramSender = ({ token, chatId }) => async text => {
  let res
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(30e3),
    })
  } catch (e) {
    throw new Error(`telegram: ${String(e?.cause?.code ?? e?.name ?? 'request failed').slice(0, 80)}`)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`telegram: HTTP ${res.status}${body?.description ? ` ${String(body.description).slice(0, 200)}` : ''}`)
  }
}

export const digestSender = digest => (digest.command ? commandSender(digest.command) : digest.telegram ? telegramSender(digest.telegram) : null)
