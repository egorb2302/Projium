import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const SHOW = ['stage', 'progress', 'updates', 'uptime', 'incidents', 'status', 'next_step', 'tasks']
export const SAFE = ['stage', 'progress', 'updates', 'uptime', 'incidents']
const PROJECT_KEYS = ['show', 'title', 'lang', 'slug']
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v)

export const slugOf = name => {
  const s = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return s || `p-${crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 8)}`
}

export const newSlug = name => `${slugOf(name).slice(0, 40)}-${crypto.randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(6, '0').slice(0, 6)}`

export const shareUnknownKeys = raw => {
  if (!isObject(raw)) return []
  const out = Object.keys(raw).filter(k => !['dir', 'every', 'projects'].includes(k)).map(k => `share.${k}`)
  if (isObject(raw.projects))
    for (const [name, p] of Object.entries(raw.projects)) if (isObject(p)) out.push(...Object.keys(p).filter(k => !PROJECT_KEYS.includes(k)).map(k => `share.projects["${name}"].${k}`))
  return out
}

export const shareConfig = (raw, resolveDir) => {
  if (raw == null) return null
  if (!isObject(raw)) throw new Error('share must be an object like { "projects": { "Acme": { "show": ["stage", "updates"] } } }')
  if (raw.dir != null && (typeof raw.dir !== 'string' || !raw.dir.trim())) throw new Error('share.dir must be a folder path')
  const every = raw.every ?? 0
  if (typeof every !== 'number' || !(every >= 0 && every <= 1440)) throw new Error('share.every must be minutes from 0 (export only on demand) to 1440')
  const projects = raw.projects ?? {}
  if (!isObject(projects)) throw new Error('share.projects must map project names to { "show": [...] }')
  const seen = new Map()
  const list = Object.entries(projects).map(([name, p]) => {
    const where = `share.projects["${name}"]`
    if (!isObject(p)) throw new Error(`${where} must be an object like { "show": ["stage", "updates"] }`)
    const show = p.show ?? SAFE
    if (!Array.isArray(show) || !show.every(k => SHOW.includes(k))) throw new Error(`${where}.show must list some of ${SHOW.join(', ')}`)
    if (p.title != null && (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80 || /[\r\n]/.test(p.title))) throw new Error(`${where}.title must be one line of up to 80 characters`)
    if (p.lang != null && !['en', 'ru'].includes(p.lang)) throw new Error(`${where}.lang must be en or ru`)
    if (p.slug != null && (typeof p.slug !== 'string' || !SLUG.test(p.slug))) throw new Error(`${where}.slug must be lowercase letters, digits and dashes, up to 64`)
    const slug = p.slug ?? slugOf(name)
    if (seen.has(slug)) throw new Error(`share: ${seen.get(slug)} and ${name} would both be exported as ${slug}; set a slug for one of them`)
    seen.set(slug, name)
    return { name, show: [...new Set(show)], title: p.title?.trim() ?? null, lang: p.lang ?? null, slug }
  })
  return { dir: resolveDir(raw.dir ?? 'share'), every, projects: list }
}

const WORDS = {
  en: {
    locale: 'en-GB',
    titleSuffix: 'status',
    stage: { development: 'In development', review: 'In review', fixes: 'Fixing review notes', done: 'Done' },
    progress: 'Progress',
    readiness: (a, b) => `${a} of ${b} acceptance checks passed`,
    updatesDone: (a, b) => `${a} of ${b} updates done`,
    next: 'Next step',
    updates: 'Updates',
    noUpdates: 'No updates planned yet',
    tasks: 'Open tasks',
    noTasks: 'No open tasks',
    due: d => `due ${d}`,
    uptime: 'Uptime',
    siteChecks: (p7, p30) => `${p7 == null ? '' : `${p7}% over 7 days`}${p7 != null && p30 != null ? ', ' : ''}${p30 == null ? '' : `${p30}% over 30 days`}`,
    days30: 'Last 30 days, one bar a day',
    kinds: { site: 'Site', heartbeat: 'Background job' },
    states: { ok: 'Operational', warn: 'Degraded', down: 'Incident', unknown: 'No data yet' },
    certOk: d => `certificate valid until ${d}`,
    noUptime: 'Nothing is monitored yet',
    incidents: 'Incidents',
    noIncidents: 'No incidents in the last 90 days',
    signal: { up: 'Site unreachable', cert: 'Certificate problem', beat: 'Background job late' },
    lasted: d => `resolved after ${d}`,
    ongoing: 'ongoing',
    updated: at => `Updated ${at}`,
    by: 'Status page made with',
    desc: (t, stage) => `${t}${stage ? `, ${stage.toLowerCase()}` : ''}: progress, updates and uptime`,
    min: 'min',
    h: 'h',
    d: 'd',
  },
  ru: {
    locale: 'ru-RU',
    titleSuffix: 'статус',
    stage: { development: 'В разработке', review: 'На проверке', fixes: 'Правки после проверки', done: 'Готов' },
    progress: 'Прогресс',
    readiness: (a, b) => `Пройдено ${a} из ${b} проверок приёмки`,
    updatesDone: (a, b) => `Готово ${a} из ${b} апдейтов`,
    next: 'Следующий шаг',
    updates: 'Апдейты',
    noUpdates: 'Апдейты пока не запланированы',
    tasks: 'Открытые задачи',
    noTasks: 'Открытых задач нет',
    due: d => `до ${d}`,
    uptime: 'Доступность',
    siteChecks: (p7, p30) => `${p7 == null ? '' : `${p7}% за 7 дней`}${p7 != null && p30 != null ? ', ' : ''}${p30 == null ? '' : `${p30}% за 30 дней`}`,
    days30: 'Последние 30 дней, полоса на день',
    kinds: { site: 'Сайт', heartbeat: 'Фоновая задача' },
    states: { ok: 'Работает', warn: 'Есть сбои', down: 'Сбой', unknown: 'Данных пока нет' },
    certOk: d => `сертификат действует до ${d}`,
    noUptime: 'Пока ничего не мониторится',
    incidents: 'Инциденты',
    noIncidents: 'За последние 90 дней инцидентов не было',
    signal: { up: 'Сайт недоступен', cert: 'Проблема с сертификатом', beat: 'Фоновая задача опаздывает' },
    lasted: d => `устранено за ${d}`,
    ongoing: 'продолжается',
    updated: at => `Обновлено ${at}`,
    by: 'Страница статуса сделана в',
    desc: (t, stage) => `${t}${stage ? `, ${stage.toLowerCase()}` : ''}: прогресс, апдейты и доступность`,
    min: 'мин',
    h: 'ч',
    d: 'д',
  },
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const linkText = target => {
  const [note, ...rest] = target.split(/[#^]/)
  return note.split('/').pop().replace(/\.md$/i, '').trim() || (rest.filter(x => x.trim()).pop() ?? '').trim()
}

const plain = s =>
  String(s ?? '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, (_, target) => linkText(target))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s*\^[\w-]+\s*$/, '')

const rich = s => plain(s).split('`').map((part, i) => (i % 2 ? `<code>${esc(part)}</code>` : esc(part))).join('')

const offsetOf = zone => {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(zone ?? '')
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

const when = (ts, zone, w, time = true) =>
  new Date(ts + offsetOf(zone) * 60e3).toLocaleString(w.locale, { day: 'numeric', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'UTC' })

const duration = (ms, w) => {
  const m = Math.max(1, Math.round(ms / 60e3))
  if (m < 60) return `${m} ${w.min}`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} ${w.h} ${m % 60} ${w.min}` : `${h} ${w.h}`
  return `${Math.floor(h / 24)} ${w.d}${h % 24 ? ` ${h % 24} ${w.h}` : ''}`
}

const pct = rows => (rows.length ? Math.floor((rows.filter(r => r.code != null && r.code < 400).length / rows.length) * 1000) / 10 : null)

export const pageData = ({ card, show, title = null, lang = 'en', now = Date.now(), health = [], incidents = [] }) => {
  const on = k => show.includes(k)
  const r = card.repoInfo?.readiness
  const items = (card.updates ?? []).filter(u => u.item)
  const DAY = 864e5
  const offset = offsetOf(card.zone) * 60e3
  const today = Math.floor((now + offset) / DAY)
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = today - 29 + i
    const rows = health.filter(x => Math.floor((x.ts + offset) / DAY) === d)
    return rows.length ? (rows.every(x => x.code != null && x.code < 400) ? 'ok' : rows.some(x => x.code != null && x.code < 400) ? 'part' : 'down') : 'none'
  })
  const targets = (card.watch?.targets ?? []).filter(t => t.kind === 'site' || t.kind === 'heartbeat').map(t => {
    const open = t.signals.some(s => s.status === 'open')
    const known = t.signals.some(s => s.result === 'ok' || s.result === 'fail')
    const cert = t.signals.find(s => s.signal === 'cert' && s.result === 'ok')?.detail?.find(p => p.k === 'cert')
    const failing = t.signals.some(s => s.result === 'fail')
    return { name: t.name, kind: t.kind, state: open ? 'down' : failing ? 'warn' : known ? 'ok' : 'unknown', certUntil: cert?.date ?? null }
  })
  return {
    title: title || card.name,
    lang: WORDS[lang] ? lang : 'en',
    zone: card.zone ?? '+00:00',
    now,
    stage: on('stage') ? card.fields?.stage ?? null : null,
    status: on('status') ? card.fields?.status ?? null : null,
    next: on('next_step') ? card.fields?.next_step ?? null : null,
    progress: on('progress') ? (r?.total ? { kind: 'readiness', done: r.proven ?? 0, total: r.total } : items.length ? { kind: 'updates', done: items.filter(u => u.done).length, total: items.length } : null) : null,
    updates: on('updates') ? items.map(u => ({ text: u.text, done: Boolean(u.done) })) : null,
    tasks: on('tasks') ? (card.tasks ?? []).filter(x => !x.done).map(x => ({ text: x.text, due: x.due || null })) : null,
    uptime: on('uptime') ? { p7: pct(health.filter(x => x.ts >= now - 7 * DAY)), p30: pct(health), days: health.length ? days : null, targets } : null,
    incidents: on('incidents') ? incidents.filter(i => i.signal !== 'balance').map(i => ({ signal: i.signal, openedAt: i.openedAt, closedAt: i.closedAt ?? null })) : null,
  }
}

const FONTS = [
  ['Inter Tight', 'inter-tight-latin-wght-normal', '100 900', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
  ['Inter Tight', 'inter-tight-cyrillic-wght-normal', '100 900', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal', '400', 'U+0000-00FF, U+2000-206F, U+2212'],
  ['IBM Plex Mono', 'ibm-plex-mono-latin-500-normal', '500 600', 'U+0000-00FF, U+2000-206F, U+2212'],
  ['IBM Plex Mono', 'ibm-plex-mono-cyrillic-400-normal', '400', 'U+0400-045F'],
]

let fontCss = null
const fonts = () =>
  (fontCss ??= FONTS.map(([family, file, weight, range]) => {
    const data = fs.readFileSync(new URL(`../public/fonts/${file}.woff2`, import.meta.url)).toString('base64')
    return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:${weight};font-display:swap;unicode-range:${range}}`
  }).join(''))

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23000'/%3E%3Crect x='8' y='9' width='16' height='3' rx='1.5' fill='%2350d2c1'/%3E%3Crect x='8' y='15' width='11' height='3' rx='1.5' fill='%23ededed'/%3E%3Crect x='8' y='21' width='7' height='3' rx='1.5' fill='%23ededed' opacity='.5'/%3E%3C/svg%3E"

const META_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'"
export const CSP = `${META_CSP}; frame-ancestors 'none'`

const CSS = `:root{--bg:#000;--panel:#0a0a0a;--panel-2:#111;--line:#1f1f1f;--line-2:#2e2e2e;--text:#ededed;--muted:#a1a1a1;--dim:#6b6b6b;--accent:#50d2c1;--ok:#3ecf8e;--warn:#f5a524;--bad:#f2617a;--blue:#52a8ff;--violet:#a78bfa;--sans:"Inter Tight","Segoe UI",system-ui,-apple-system,sans-serif;--mono:"IBM Plex Mono",Consolas,ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}
html{scrollbar-width:thin;scrollbar-color:var(--accent) transparent}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--accent);border-radius:4px}
::selection{background:rgba(80,210,193,.3)}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
#pl{position:fixed;inset:0;z-index:9;display:grid;place-items:center;background:var(--bg);animation:pl-out .35s cubic-bezier(.2,0,0,1) .5s forwards}
#pl .mark{display:grid;gap:7px;width:56px}#pl .mark i{display:block;height:7px;border-radius:4px;background:var(--text);transform-origin:left;animation:mark 1.1s cubic-bezier(.2,0,0,1) infinite}
#pl .mark i:nth-child(1){background:var(--accent)}#pl .mark i:nth-child(2){width:70%;animation-delay:.12s}#pl .mark i:nth-child(3){width:45%;opacity:.5;animation-delay:.24s}
@keyframes mark{0%,100%{transform:scaleX(.15)}50%{transform:scaleX(1)}}@keyframes pl-out{to{opacity:0;visibility:hidden}}
.wrap{max-width:920px;margin:0 auto;padding:0 24px}
.top{border-bottom:1px solid var(--line)}.top .wrap{display:flex;align-items:center;gap:10px;height:56px}
.logo{display:grid;gap:3px;width:22px;padding:4px;border-radius:6px;background:var(--panel-2);border:1px solid var(--line-2)}.logo i{display:block;height:2px;border-radius:2px;background:var(--text)}.logo i:nth-child(1){background:var(--accent)}.logo i:nth-child(2){width:70%}.logo i:nth-child(3){width:45%;opacity:.5}
.top b{font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top .upd{margin-left:auto;color:var(--dim);font:12px var(--mono);white-space:nowrap}
.hero{padding:44px 0 28px}
h1{margin:0;font-size:44px;line-height:1.08;font-weight:600;letter-spacing:-.035em;overflow-wrap:anywhere}
.line{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px;color:var(--muted)}
.stage{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-radius:999px;font-size:13.5px;font-weight:500;border:1px solid var(--line-2);background:var(--panel-2)}
.stage::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.stage.development{color:var(--blue);background:rgba(82,168,255,.1);border-color:rgba(82,168,255,.25)}.stage.review{color:var(--warn);background:rgba(245,165,36,.1);border-color:rgba(245,165,36,.25)}.stage.fixes{color:var(--violet);background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.25)}.stage.done{color:var(--ok);background:rgba(62,207,142,.1);border-color:rgba(62,207,142,.25)}
.meter{margin-top:28px;padding:18px 20px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.meter-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;color:var(--muted);font-size:14px}.meter-top b{font:500 28px/1 var(--mono);color:var(--text);letter-spacing:-.03em}
.track{height:8px;border-radius:4px;background:var(--panel-2);overflow:hidden}.track i{display:block;height:100%;border-radius:4px;background:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;padding-bottom:24px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 18px 18px}.panel.wide{grid-column:1/-1}
h2{margin:0 -18px 14px;padding:13px 18px;font-size:14px;font-weight:600;border-bottom:1px solid var(--line);letter-spacing:-.005em}
p{margin:0}.muted{color:var(--muted)}.small{font-size:13px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.upd li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;align-items:start;font-size:14px}
.box{width:16px;height:16px;margin-top:2px;border-radius:4px;border:1px solid #444;display:grid;place-items:center}
.done .box{background:var(--accent);border-color:var(--accent)}.done .box::before{content:"";width:8px;height:5px;border:2px solid #02231e;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
.done span:last-child{color:var(--dim)}
.tasks li{font-size:14px}.tasks .due{margin-left:8px;color:var(--muted);font:12px var(--mono);white-space:nowrap}
code{font:12.5px var(--mono);background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:0 4px;overflow-wrap:anywhere}
.bars{display:grid;grid-template-columns:repeat(30,minmax(0,1fr));gap:3px;height:34px;margin:6px 0 8px}.bars i{border-radius:2px;background:var(--line-2)}.bars i.ok{background:var(--ok)}.bars i.part{background:var(--warn)}.bars i.down{background:var(--bad)}
.tgt{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line);font-size:14px}.tgt:first-of-type{border-top:0}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dim)}.dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(62,207,142,.15)}.dot.down{background:var(--bad);box-shadow:0 0 0 3px rgba(242,97,122,.2)}.dot.warn{background:var(--warn);box-shadow:0 0 0 3px rgba(245,165,36,.18)}
.tgt b{font-weight:500}.tgt .st{margin-left:auto;color:var(--muted);white-space:nowrap}.tgt .st.down{color:var(--bad)}.tgt .st.warn{color:var(--warn)}.tgt .st.ok{color:var(--ok)}
.inc li{display:grid;gap:2px;font-size:14px;padding-bottom:10px;border-bottom:1px solid var(--line)}.inc li:last-child{border-bottom:0;padding-bottom:0}.inc .when{color:var(--muted);font:12.5px var(--mono)}.inc .live{color:var(--bad)}
footer{border-top:1px solid var(--line);padding:20px 0 40px;color:var(--dim);font-size:13px}footer a{color:var(--muted)}footer a:hover{color:var(--text)}
@media (max-width:760px){.wrap{padding:0 16px}.hero{padding:32px 0 22px}h1{font-size:32px}.grid{grid-template-columns:1fr}.top .upd{display:none}.meter-top b{font-size:24px}}
@media (prefers-reduced-motion:reduce){#pl{display:none}#pl .mark i{animation:none}}`

export const renderPage = d => {
  const w = WORDS[d.lang] ?? WORDS.en
  const stageText = d.stage ? w.stage[d.stage] ?? d.stage : null
  const updated = w.updated(`${when(d.now, d.zone, w)} UTC${d.zone}`)
  const panel = (title, body, wide = false) => `<section class="panel${wide ? ' wide' : ''}"><h2>${esc(title)}</h2>${body}</section>`
  const p = d.progress
  const panels = []
  if (d.next) panels.push(panel(w.next, `<p>${rich(d.next)}</p>`))
  if (d.updates) panels.push(panel(w.updates, d.updates.length ? `<ul class="upd">${d.updates.map(u => `<li${u.done ? ' class="done"' : ''}><span class="box" aria-hidden="true"></span><span>${rich(u.text)}</span></li>`).join('')}</ul>` : `<p class="muted small">${esc(w.noUpdates)}</p>`))
  if (d.tasks) panels.push(panel(w.tasks, d.tasks.length ? `<ul class="tasks">${d.tasks.map(x => `<li>${rich(x.text)}${x.due ? `<span class="due">${esc(w.due(when(Date.parse(`${x.due}T00:00:00Z`), '+00:00', w, false)))}</span>` : ''}</li>`).join('')}</ul>` : `<p class="muted small">${esc(w.noTasks)}</p>`))
  if (d.uptime) {
    const u = d.uptime
    const parts = []
    if (u.days) parts.push(`<p class="small">${esc(w.siteChecks(u.p7, u.p30))}</p><div class="bars" role="img" aria-label="${esc(w.days30)}">${u.days.map(x => `<i class="${x}"></i>`).join('')}</div><p class="muted small">${esc(w.days30)}</p>`)
    for (const t of u.targets)
      parts.push(`<div class="tgt"><span class="dot ${t.state}"></span><span><b>${esc(t.name)}</b> <span class="muted small">· ${esc(w.kinds[t.kind])}${t.certUntil && t.state === 'ok' && /^\d{4}-\d{2}-\d{2}$/.test(t.certUntil) ? ` · ${esc(w.certOk(when(Date.parse(`${t.certUntil}T00:00:00Z`), '+00:00', w, false)))}` : ''}</span></span><span class="st ${t.state}">${esc(w.states[t.state])}</span></div>`)
    panels.push(panel(w.uptime, parts.join('') || `<p class="muted small">${esc(w.noUptime)}</p>`))
  }
  if (d.incidents)
    panels.push(panel(w.incidents, d.incidents.length
      ? `<ul class="inc">${d.incidents.map(i => `<li><span>${esc(w.signal[i.signal] ?? i.signal)}</span><span class="when">${esc(when(i.openedAt, d.zone, w))} · ${i.closedAt == null ? `<span class="live">${esc(w.ongoing)}</span>` : esc(w.lasted(duration(i.closedAt - i.openedAt, w)))}</span></li>`).join('')}</ul>`
      : `<p class="muted small">${esc(w.noIncidents)}</p>`))
  if (panels.length % 2) panels[panels.length - 1] = panels.at(-1).replace('<section class="panel"', '<section class="panel wide"')
  const desc = w.desc(d.title, stageText)
  return `<!doctype html>
<html lang="${d.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${META_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${esc(d.title)} · ${esc(w.titleSuffix)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(d.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(d.title)}">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" href="${ICON}">
<style>${fonts()}
${CSS}</style>
</head>
<body>
<div id="pl" aria-hidden="true"><div class="mark"><i></i><i></i><i></i></div></div>
<header class="top"><div class="wrap"><span class="logo" aria-hidden="true"><i></i><i></i><i></i></span><b>${esc(d.title)}</b><span class="upd">${esc(updated)}</span></div></header>
<main class="wrap">
<section class="hero">
<h1>${esc(d.title)}</h1>
${stageText || d.status ? `<div class="line">${stageText ? `<span class="stage ${esc(d.stage)}">${esc(stageText)}</span>` : ''}${d.status ? `<span>${rich(d.status)}</span>` : ''}</div>` : ''}
${p ? `<div class="meter"><div class="meter-top"><span>${esc(p.kind === 'readiness' ? w.readiness(p.done, p.total) : w.updatesDone(p.done, p.total))}</span><b>${Math.round((p.done / p.total) * 100)}%</b></div><div class="track"><i style="width:${Math.min(100, (p.done / p.total) * 100).toFixed(1)}%"></i></div></div>` : ''}
</section>
${panels.length ? `<div class="grid">${panels.join('')}</div>` : ''}
</main>
<footer><div class="wrap">${esc(updated)} · ${esc(w.by)} <a href="https://github.com/egorb2302/Projium" rel="noopener noreferrer">Projium</a></div></footer>
</body>
</html>
`
}

const SLUG_DIR = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

const plainDir = p => {
  try {
    const st = fs.lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink() ? 'dir' : 'other'
  } catch {
    return 'none'
  }
}

export const manifestFor = (dataDir, dir) => {
  const p = path.resolve(dir)
  return path.join(dataDir, `share-${crypto.createHash('sha256').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 12)}.json`)
}

export const exportedSlugs = manifest => {
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).slugs.filter(s => typeof s === 'string' && SLUG_DIR.test(s))
  } catch {
    return []
  }
}

const ROOT_PAGE = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="robots" content="noindex, nofollow">\n<title>Status pages</title>\n</head>\n<body></body>\n</html>\n'

export const writePages = (dir, pages, { keep = [], manifest }) => {
  const before = exportedSlugs(manifest)
  if (!pages.length && !before.length) return { written: [], removed: [], skipped: [] }
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  const written = []
  const skipped = []
  for (const p of pages) {
    const sub = path.join(dir, p.slug)
    const file = path.join(sub, 'index.html')
    const kind = plainDir(sub)
    if (kind === 'other') {
      skipped.push({ name: p.name, slug: p.slug, error: `${sub} is not a plain folder; nothing was written` })
      continue
    }
    if (kind === 'dir' && !before.includes(p.slug) && fs.existsSync(file)) {
      skipped.push({ name: p.name, slug: p.slug, error: `${file} was not written by Projium; nothing was written` })
      continue
    }
    fs.mkdirSync(sub, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    try {
      fs.writeFileSync(tmp, p.html)
      fs.renameSync(tmp, file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    written.push({ name: p.name, slug: p.slug, file })
  }
  for (const [name, text] of [['robots.txt', 'User-agent: *\nDisallow: /\n'], ['index.html', ROOT_PAGE]]) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, text)
  }
  const removed = []
  const kept = before.filter(s => keep.includes(s))
  for (const s of before)
    if (!pages.some(p => p.slug === s) && !kept.includes(s)) {
      if (plainDir(path.join(dir, s)) !== 'dir') continue
      fs.rmSync(path.join(dir, s, 'index.html'), { force: true })
      try {
        fs.rmdirSync(path.join(dir, s))
      } catch {}
      removed.push(s)
    }
  fs.writeFileSync(manifest, `${JSON.stringify({ slugs: [...new Set([...written.map(p => p.slug), ...kept])] }, null, 2)}\n`)
  return { written, removed, skipped }
}
