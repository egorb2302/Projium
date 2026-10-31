import { t, getLang, setLang, fmtDate } from './i18n.js'

const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

const STAGES = ['development', 'review', 'fixes', 'done']
const FIELDS = [
  ['stage', 'stage'],
  ['next_step', 'text'],
  ['handed_over_at', 'date'],
  ['accepted_at', 'date'],
  ['accepted_by', 'text'],
  ['spec_at', 'time'],
  ['design_pick_at', 'time'],
  ['first_push_at', 'time'],
  ['mainnet_at', 'time'],
  ['site', 'text'],
]

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'style') el.style.cssText = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue
    if (kid instanceof Node) el.append(kid)
    else if (tag !== 'option' && String(kid).includes('→')) el.append(...lab(kid))
    else el.append(String(kid))
  }
  return el
}

const render = (...kids) => app.replaceChildren(...kids.flat().filter(k => k != null && k !== false))

const lab = text => String(text).split('→').flatMap((part, i) => (i ? [h('span', { class: 'arr', role: 'img', 'aria-label': '→' }), part.trimStart()] : [part.trimEnd()]))

const rich = text => String(text ?? '').split('`').map((part, i) => (i % 2 ? h('code', {}, part) : part))

const toast = (msg, bad = false) => {
  toastEl.textContent = msg
  toastEl.className = `show${bad ? ' bad' : ''}`
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (toastEl.className = ''), 3200)
}

const progressEl = document.getElementById('progress')
let inflight = 0
let progressTimer
const busy = d => {
  inflight += d
  clearTimeout(progressTimer)
  if (inflight > 0) progressTimer = setTimeout(() => progressEl.classList.add('on'), 100)
  else progressEl.classList.remove('on')
}

const api = async (url, body) => {
  busy(1)
  let res
  try {
    res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  } finally {
    busy(-1)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`)
    err.status = res.status
    err.current = data.current
    throw err
  }
  return data
}

const hours = (a, b) => {
  const v = a && b ? (Date.parse(b) - Date.parse(a)) / 36e5 : NaN
  return Number.isFinite(v) ? v : null
}
const safeSite = s => (/^https:\/\/[^\s"'<>]+$/.test(s ?? '') ? s : null)
const fmtH = v => (v == null ? t('noData') : v >= 48 ? `${(v / 24).toFixed(1)} ${t('d')}` : `${v.toFixed(1)} ${t('h')}`)
const median = xs => {
  const s = xs.filter(x => x != null).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const durations = f => ({
  design: hours(f.spec_at, f.design_pick_at),
  push: hours(f.spec_at, f.first_push_at),
  mainnet: hours(f.first_push_at, f.mainnet_at),
  total: hours(f.spec_at, f.mainnet_at),
})

const stageName = s => t('stage')[s] ?? s
const stageChip = s => h('span', { class: `stage ${s}` }, stageName(s))
const cover = p => (p.preview ? h('div', { class: 'cover', style: `background-image:url("${p.preview}")`, role: 'img', 'aria-label': t('preview', p.name) }) : h('div', { class: 'cover none' }, t('noPreview')))
const healthDot = p => {
  const last = p.health?.last
  if (!p.fields.site || !last) return null
  const ok = last.code != null && last.code < 400
  return h('span', { class: `dot ${ok ? 'ok' : 'bad'}`, title: ok ? t('up', last.ms) : t('down', last.error ?? last.code) })
}
const projectLink = p => h('a', { href: `#/p/${encodeURIComponent(p.name)}` }, p.name)

let filter = 'open'
let seq = 0

const skCard = () => h('div', { class: 'sk-card' }, h('b'), h('i'), h('i'), h('i'))
const skPanel = lines => h('div', { class: 'sk-panel' }, h('b'), Array.from({ length: lines }, () => h('i')))
const skeleton = page =>
  page === 'project'
    ? [h('div', { class: 'sk-head' }, h('div', {}, h('i', { class: 'sk-title' }), h('i'), h('div', { class: 'sk-strip' })), h('b', { class: 'sk-cover' })),
      h('div', { class: 'cols' }, h('div', {}, skPanel(8), skPanel(4)), h('div', {}, skPanel(3), skPanel(6)))]
    : page === 'time'
      ? [h('div', { class: 'sk-strip sk-kpis' }), skPanel(9), skPanel(12)]
      : [h('div', { class: 'sk-bar' }, h('i'), h('i'), h('i')), h('div', { class: 'grid' }, skCard(), skCard(), skCard(), skCard())]

const renderList = async n => {
  const all = await api('/api/projects')
  if (n !== seq) return
  const broken = all.filter(p => p.error)
  const projects = all.filter(p => !p.error)
  projects.sort((a, b) => (b.fields.spec_at || b.fields.first_push_at || '').localeCompare(a.fields.spec_at || a.fields.first_push_at || ''))
  const shown = projects.filter(p => filter === 'all' || (filter === 'done' ? p.fields.stage === 'done' : p.fields.stage !== 'done'))
  render(
    h('div', { class: 'bar' },
      ['open', 'done', 'all'].map(k => h('button', { class: `chip${filter === k ? ' on' : ''}`, onclick: () => ((filter = k), renderList(seq)) }, t('filters')[k])),
      h('span', { class: 'count' }, t('countOf', shown.length, projects.length))),
    broken.length ? h('p', { class: 'muted small' }, t('couldNotRead', broken.map(b => `${b.name} (${b.error})`).join(', '))) : null,
    h('div', { class: 'grid' }, shown.map(p => {
      const d = durations(p.fields)
      const open = p.tasks.filter(x => !x.done).length
      return h('a', { class: 'card', href: `#/p/${encodeURIComponent(p.name)}` },
        cover(p),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-head' }, healthDot(p), h('h3', {}, p.name), stageChip(p.fields.stage)),
          h('div', { class: 'status' }, p.fields.status ?? ''),
          p.fields.next_step ? h('div', { class: 'next' }, rich(p.fields.next_step)) : null,
          h('div', { class: 'stats' },
            h('span', {}, t('cardPush'), h('b', { class: d.push == null ? 'nil' : '' }, d.push == null ? t('nil') : fmtH(d.push))),
            h('span', {}, t('cardMainnet'), h('b', { class: d.total == null ? 'nil' : '' }, d.total == null ? t('nil') : fmtH(d.total))),
            h('span', {}, t('cardTasks'), h('b', {}, open)))))
    })))
}

const freshnessText = info => {
  const f = info.freshness ?? {}
  const r = info.readiness
  if (!info.repo) return t('noRepo')
  const from = r?.commitSource && r.commitSource !== 'audit_commit' ? t('takenFrom', r.commitSource) : ''
  if (f.state === 'git-unavailable') return t('gitDown')
  if (f.state === 'no-audit-commit') return r ? t('noAuditCommit') : t('noReadiness')
  if (f.state === 'audit-commit-unknown') return t('auditUnknown', f.commit)
  if (f.state === 'current') return t('auditCurrent', f.commit, from)
  const parts = []
  if (f.sinceLocal) parts.push(t('commitsLocal', f.sinceLocal))
  if (f.behindAudit) parts.push(t('commitsBehind', f.behindAudit))
  if (f.sinceOrigin) parts.push(t('commitsOrigin', f.sinceOrigin))
  if (f.dirty) parts.push(t('dirtyFiles', f.dirty))
  return t('auditChanged', f.commit, from, parts.join(', '))
}

const fieldRow = (p, [key, kind], rerender) => {
  const value = p.fields[key] ?? ''
  const id = `f-${key}`
  const input = kind === 'stage'
    ? h('select', { id }, STAGES.map(s => h('option', { value: s, selected: s === value }, stageName(s))))
    : h('input', { id, value, type: kind === 'date' ? 'date' : kind === 'time' ? 'datetime-local' : 'text', lang: t('locale') })
  const owner = p.fieldKeys?.[key]
  const row = h('div', { class: 'field' }, h('label', { for: id, title: owner ? t('ownerKey', owner) : null }, t('fields')[key], owner ? h('span', { class: 'muted' }, ` · ${owner}`) : null), input)
  if (p.locked?.includes(key)) {
    input.disabled = true
    input.title = t('locked')
    return row
  }
  let expected = value
  const save = async (val, exp) => {
    if (val === exp) return
    try {
      const next = await api(`/api/projects/${encodeURIComponent(p.name)}/field`, { key, value: val, expected: exp, fileId: p.fileId })
      expected = next.fields[key] ?? ''
      input.classList.remove('err')
      input.classList.add('saved')
      setTimeout(() => input.classList.remove('saved'), 1200)
      row.querySelector('.conflict')?.remove()
      rerender(next, key)
    } catch (e) {
      input.classList.add('err')
      if (e.status === 409 && e.current === null) {
        toast(t('reloaded', e.message), true)
        route()
      } else if (e.status === 409) {
        row.querySelector('.conflict')?.remove()
        const theirs = e.current ?? ''
        row.append(h('div', { class: 'conflict' },
          h('div', {}, t('changedMeanwhile'), h('b', {}, theirs || t('empty'))),
          h('div', { class: 'row' },
            h('button', { onclick: () => route() }, t('keepTheirs')),
            h('button', { class: 'primary', onclick: () => save(input.value, theirs) }, t('writeMine')))))
      } else toast(e.message, true)
    }
  }
  input.addEventListener('change', () => save(input.value, expected))
  return row
}

const taskList = (p, rerender) => {
  const url = `/api/projects/${encodeURIComponent(p.name)}/task`
  const send = async body => {
    try {
      rerender(await api(url, { ...body, fileId: p.fileId }))
    } catch (e) {
      toast(e.status === 409 ? t('reloaded', e.message) : e.message, true)
      if (e.status === 409) route()
    }
  }
  const expected = x => ({ done: x.done, text: x.text, due: x.due, p: x.p })
  const items = p.tasks.map(task => {
    const li = h('li', { class: `task${task.done ? ' done' : ''}` })
    if (task.readonly) {
      li.append(h('input', { type: 'checkbox', checked: task.done, disabled: true, 'aria-label': task.text }), h('div', {}, h('div', { class: 't-text' }, rich(task.text)), h('div', { class: 'muted small' }, t('noTaskId'))), h('span'))
      return li
    }
    const view = () => li.replaceChildren(
      h('input', { type: 'checkbox', checked: task.done, 'aria-label': t('doneLabel', task.text), onchange: () => send({ op: 'toggle', id: task.id, expected: expected(task) }) }),
      h('div', {}, h('div', { class: 't-text' }, rich(task.text)), h('div', { class: 't-meta' }, task.p ? h('span', { class: `prio ${task.p}` }, task.p) : null, task.due ? h('span', { class: 'due' }, t('due', task.due)) : null)),
      h('button', { onclick: edit }, t('edit')))
    const edit = () => {
      const text = h('input', { value: task.text, 'aria-label': t('taskText') })
      const due = h('input', { type: 'date', value: task.due, 'aria-label': t('dueDate'), lang: t('locale') })
      const pr = h('select', { 'aria-label': t('priority') }, ['', 'p1', 'p2', 'p3'].map(x => h('option', { value: x, selected: x === task.p }, x || t('none'))))
      li.replaceChildren(h('span'), h('div', { class: 'edit' }, text, due, pr,
        h('button', { class: 'primary', onclick: () => send({ op: 'edit', id: task.id, expected: expected(task), task: { text: text.value, due: due.value, p: pr.value } }) }, t('save')),
        h('button', { onclick: view }, t('cancel'))), h('span'))
    }
    view()
    return li
  })
  const text = h('input', { placeholder: t('newTask'), 'aria-label': t('newTask') })
  const due = h('input', { type: 'date', 'aria-label': t('dueDate'), lang: t('locale') })
  const pr = h('select', { 'aria-label': t('priority') }, ['p2', 'p1', 'p3', ''].map(x => h('option', { value: x }, x || t('none'))))
  const add = () => text.value.trim() && send({ op: 'add', task: { text: text.value, due: due.value, p: pr.value } })
  text.addEventListener('keydown', e => e.key === 'Enter' && add())
  return h('div', {},
    items.length ? h('ul', { class: 'tasks' }, items) : h('p', { class: 'muted small' }, t('noTasks')),
    h('div', { class: 'add' }, text, due, pr, h('button', { class: 'primary', onclick: add }, t('add'))))
}

const PROD_TONES = { on: 'ok', off: 'off', partly: 'warn', merged: 'ok', branch: 'off', unknown: 'warn' }

const prodPanel = p => {
  const s = p.prodUpdates ?? { entries: [] }
  const flags = p.repoInfo?.updates?.flags ?? []
  const live = p.fields.site && p.fields.stage !== 'done'
  if (!s.entries.length)
    return h('p', { class: 'muted small' }, live && !s.checkedAt ? t('configStale') : flags.length ? t('flagsNoPlan', flags.join(', ')) : t('noFlags'))
  const when = s.configError ? t('configFailed', fmtDate(s.checkedAt), s.configError) : s.checkedAt ? t('configRead', fmtDate(s.checkedAt)) : live ? t('configStale') : t('noLiveSite')
  return h('div', {},
    h('h3', { class: 'sub' }, t('releaseState')),
    h('ul', { class: 'prod' }, s.entries.map(e => {
      const state = PROD_TONES[e.state] ? e.state : 'unknown'
      const what = e.n == null ? e.flags[0].name : t('update', e.n)
      const detail = [
        e.n != null && e.flags.length ? e.flags.map(f => `${f.name}: ${f.prod == null ? t('notInConfig') : f.prod ? t('on') : t('off')}`).join(', ') : null,
        e.branch ? `${t('branch', e.branch.name, e.branch.sha)}${e.branch.inMain == null ? t('mainCheckFailed') : e.branch.inMain ? t('inMain') : t('notInMain')}` : null,
      ].filter(Boolean).join('; ')
      return h('li', {}, h('span', { class: `pill ${PROD_TONES[state]}` }, t('prod')[state]), ' ', h('b', {}, what), detail ? h('span', { class: 'muted small' }, ` ${detail}`) : null)
    })),
    h('p', { class: 'muted small' }, t('branchNote', when)))
}

const spark = hist => h('div', { class: 'spark', 'aria-hidden': 'true' },
  hist.slice(-80).map(x => h('i', { class: x.ok ? '' : 'bad', style: `height:${x.ok ? Math.max(4, Math.min(26, 26 - x.ms / 120)) : 26}px`, title: fmtDate(x.ts) })))

const renderProject = async (name, n) => {
  let p = await api(`/api/projects/${encodeURIComponent(name)}`)
  if (n !== seq) return
  const draw = (next, keepFocus) => {
    p = next
    const focusId = keepFocus ? `f-${keepFocus}` : null
    const f = p.fields
    const d = durations(f)
    const info = p.repoInfo ?? {}
    const r = info.readiness
    render(
      h('div', { class: 'page-head' },
        h('div', {},
          h('p', { class: 'small' }, h('a', { href: '#/' }, t('allProjects'))),
          h('h1', {}, p.name),
          h('p', {}, stageChip(f.stage), ' ', h('span', { class: 'status' }, f.status ?? '')),
          f.site ? h('p', { class: 'small' }, healthDot(p), ' ', safeSite(f.site) ? h('a', { href: safeSite(f.site), target: '_blank', rel: 'noreferrer noopener' }, f.site) : f.site,
            p.health?.uptime24 != null ? h('span', { class: 'muted' }, t('uptime', p.health.uptime24, p.health.checks24)) : null) : null,
          p.health?.history?.length ? spark(p.health.history) : null,
          h('div', { class: 'stats', style: 'margin-top:12px' },
            h('span', {}, t('specToDesign'), h('b', {}, fmtH(d.design))),
            h('span', {}, t('specToFirstPush'), h('b', {}, fmtH(d.push))),
            h('span', {}, t('firstPushToMainnet'), h('b', {}, fmtH(d.mainnet))),
            h('span', {}, t('specToMainnet'), h('b', {}, fmtH(d.total))))),
        cover(p)),
      h('div', { class: 'cols' },
        h('div', {},
          h('section', { class: 'panel' }, h('h2', {}, t('cardFields')), h('div', { class: 'fields' }, FIELDS.map(x => fieldRow(p, x, draw))),
            h('p', { class: 'muted small' }, t('fieldsNote', p.zone ?? '+00:00'))),
          h('section', { class: 'panel' }, h('h2', {}, t('tasks')), taskList(p, draw))),
        h('div', {},
          h('section', { class: 'panel' }, h('h2', {}, t('audit')),
            r ? h('p', { class: 'small' }, t('readiness', r.proven ?? '?', r.total ?? '?', r.audit || t('undated'))) : null,
            h('p', { class: 'small' }, freshnessText(info)),
            info.freshness?.head ? h('p', { class: 'muted small' }, t('headLine', info.freshness.head, info.freshness.origin ?? t('none'))) : null,
            h('button', {
              onclick: async e => {
                const b = e.currentTarget
                b.disabled = true
                b.classList.add('loading')
                b.textContent = t('checking')
                try {
                  draw(await api(`/api/projects/${encodeURIComponent(p.name)}/refresh`, {}))
                } catch (err) {
                  toast(err.message, true)
                  b.disabled = false
                  b.classList.remove('loading')
                  b.textContent = t('recheck')
                }
              },
            }, t('recheck'))),
          h('section', { class: 'panel' }, h('h2', {}, t('updates')),
            p.updates.length ? h('ul', { class: 'lines' }, p.updates.map(u => (u.item ? h('li', {}, rich(u.text)) : h('p', { class: 'muted small' }, rich(u.text))))) : h('p', { class: 'muted small' }, t('noUpdates')),
            prodPanel(p)),
          h('section', { class: 'panel' }, h('h2', {}, t('timeline')),
            p.timeline.length ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, t('timelineCols').map(x => h('th', {}, x)))),
              h('tbody', {}, p.timeline.map(row => h('tr', {}, row.slice(0, 4).map(c => h('td', {}, rich(c)))))))) : h('p', { class: 'muted small' }, t('noTimeline'))))))
    if (focusId) document.getElementById(focusId)?.focus()
  }
  draw(p)
}

const SPLIT = [['work', 'sp-work'], ['review', 'sp-review'], ['waiting', 'sp-wait'], ['pause', 'sp-pause'], ['missing', 'sp-missing']]
const PHASES = ['total', 'toFirstPush', 'toMainnet']

const lostRow = p => (p.timeSplit?.lost ? [h('tr', { class: 'sub' }, h('td', {}, ''), h('td', { colspan: SPLIT.length + 3, class: 'muted small' }, t('lostSessions', p.timeSplit.lost)))] : [])

const splitPanel = projects => {
  const rows = projects.map(p => ({ p, ph: p.timeSplit?.phases ?? {} })).filter(r => PHASES.some(k => r.ph[k]))
  const h1 = ms => fmtH(ms / 36e5)
  const label = k => t('split')[k]
  return h('section', { class: 'panel' }, h('h2', {}, t('whereTime')),
    h('div', { class: 'legend' }, SPLIT.map(([k, cls]) => h('span', {}, h('i', { class: cls }), label(k)))),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('project')), h('th', {}, t('phase')), h('th', { class: 'split-col' }, ''), SPLIT.map(([k]) => h('th', { class: 'num' }, label(k))), h('th', { class: 'num' }, t('wallClock')))),
      h('tbody', {}, rows.flatMap(({ p, ph }) => [...(!Object.values(ph).some(s => s.hasData)
        ? [h('tr', {}, h('td', {}, projectLink(p)), h('td', { colspan: SPLIT.length + 3, class: 'muted small' }, t('noTranscripts')))]
        : PHASES.filter(k => ph[k]).map((k, i) => {
          const s = ph[k]
          const tr = h('tr', { class: i ? 'sub' : '' }, h('td', {}, i ? '' : projectLink(p)), h('td', { class: 'muted' }, t('phases')[k]))
          if (!s.hasData) {
            tr.append(h('td', { colspan: SPLIT.length + 2, class: 'muted small' }, t('noTranscriptPhase', fmtH(s.total / 36e5))))
            return tr
          }
          tr.append(
            h('td', { class: 'split-col' }, h('div', { class: 'bar-track', title: SPLIT.map(([key]) => `${label(key)} ${h1(s[key])}`).join(', ') },
              SPLIT.map(([key, cls]) => h('span', { class: cls, style: `width:${(s[key] / s.total) * 100}%` })))),
            ...SPLIT.map(([key]) => (s[key] < 3 * 60e3 ? h('td', { class: 'num zero' }, '·') : h('td', { class: 'num' }, h1(s[key])))),
            h('td', { class: 'num' }, h1(s.total)))
          return tr
        })), ...lostRow(p)])))),
    h('p', { class: 'muted small' }, t('splitNote')))
}

const renderTime = async n => {
  const all = await api('/api/projects')
  if (n !== seq) return
  const projects = all.filter(p => !p.error).map(p => ({ ...p, d: durations(p.fields) }))
  const withTotal = projects.filter(p => p.d.total != null).sort((a, b) => a.d.total - b.d.total)
  const max = Math.max(...withTotal.map(p => p.d.total), 1)
  const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, fmtH(v)), h('div', { class: 'l' }, l))
  render(
    h('div', { class: 'kpis' },
      kpi(median(projects.map(p => p.d.design)), t('medianDesign')),
      kpi(median(projects.map(p => p.d.push)), t('medianPush')),
      kpi(median(projects.map(p => p.d.mainnet)), t('medianMainnet')),
      kpi(median(projects.map(p => p.d.total)), t('medianTotal'))),
    h('section', { class: 'panel' }, h('h2', {}, t('wallTitle')),
      h('div', { class: 'legend' },
        h('span', {}, h('i', { class: 'seg-a' }), t('legendA')),
        h('span', {}, h('i', { class: 'seg-b' }), t('legendB')),
        h('span', {}, h('i', { class: 'seg-c' }), t('legendC'))),
      h('div', { class: 'bars' }, withTotal.map(p => {
        const a = p.d.design ?? 0
        const b = (p.d.push ?? 0) - a
        const c = p.d.mainnet ?? 0
        const w = x => `width:${Math.max(0, (x / max) * 100)}%`
        return h('div', { class: 'bar-row' },
          projectLink(p),
          h('div', { class: 'bar-track', title: `${fmtH(a)} + ${fmtH(b)} + ${fmtH(c)}` }, h('span', { class: 'seg-a', style: w(a) }), h('span', { class: 'seg-b', style: w(b) }), h('span', { class: 'seg-c', style: w(c) })),
          h('span', { class: 'num' }, fmtH(p.d.total)))
      }))),
    splitPanel(projects),
    h('section', { class: 'panel' }, h('h2', {}, t('allProjectsTitle')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, t('allCols').map(x => h('th', {}, x)), t('allNumCols').map(x => h('th', { class: 'num' }, x)))),
        h('tbody', {}, projects.sort((a, b) => (b.fields.spec_at || '').localeCompare(a.fields.spec_at || '')).map(p => h('tr', {},
          h('td', {}, projectLink(p)),
          h('td', {}, stageChip(p.fields.stage)),
          ['spec_at', 'first_push_at', 'mainnet_at'].map(k => h('td', {}, (p.fields[k] || '').replace('T', ' '))),
          [p.d.design, p.d.push, p.d.mainnet, p.d.total].map(v => h('td', { class: 'num' }, v == null ? '' : fmtH(v)))))))),
      h('p', { class: 'muted small' }, t('allNote'))))
}

const chrome = page => {
  document.documentElement.lang = getLang()
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('on', a.dataset.nav === page)
    a.firstChild.textContent = `${a.dataset.nav === 'time' ? t('navTime') : t('navProjects')} `
  }
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()))
}

const route = async () => {
  const hash = location.hash || '#/'
  const page = hash.startsWith('#/p/') ? 'project' : hash === '#/time' ? 'time' : 'list'
  chrome(page)
  document.getElementById('path').textContent = page === 'project' ? decodeURIComponent(hash.slice(4)) : page === 'time' ? t('navTime') : t('navProjects')
  const n = ++seq
  const first = app.getAttribute('aria-busy') === 'true' && page === 'list'
  const slow = first ? null : setTimeout(() => n === seq && (render(skeleton(page)), app.setAttribute('aria-busy', 'true')), 150)
  try {
    if (page === 'project') await renderProject(decodeURIComponent(hash.slice(4)), n)
    else if (page === 'time') await renderTime(n)
    else await renderList(n)
  } catch (e) {
    if (n === seq) render(h('p', { class: 'muted' }, t('couldNotLoad', e.message)))
  } finally {
    clearTimeout(slow)
    if (n === seq) app.removeAttribute('aria-busy')
    if (n === seq) bootDone()
  }
}

const preloader = document.getElementById('preloader')
const bootDone = () => {
  if (!preloader.isConnected || preloader.classList.contains('done')) return
  document.fonts.ready.then(() => {
    preloader.classList.add('done')
    setTimeout(() => preloader.remove(), 400)
  })
}
setTimeout(bootDone, 6000)

const sb = document.getElementById('sb')
const thumb = sb.firstElementChild
let sbHide
const sbUpdate = () => {
  const { scrollHeight, clientHeight } = document.documentElement
  if (scrollHeight <= clientHeight + 1) return sb.classList.add('none')
  sb.classList.remove('none')
  const size = Math.max(32, (clientHeight / scrollHeight) * clientHeight)
  thumb.style.height = `${size}px`
  thumb.style.top = `${(window.scrollY / (scrollHeight - clientHeight)) * (clientHeight - size)}px`
}
const sbShow = () => {
  sb.classList.add('on')
  clearTimeout(sbHide)
  sbHide = setTimeout(() => sb.classList.remove('on'), 900)
}
window.addEventListener('scroll', () => (sbUpdate(), sbShow()), { passive: true })
window.addEventListener('resize', sbUpdate)
new ResizeObserver(sbUpdate).observe(document.body)
thumb.addEventListener('pointerdown', e => {
  e.preventDefault()
  sb.classList.add('drag')
  thumb.setPointerCapture(e.pointerId)
  const startY = e.clientY
  const startTop = window.scrollY
  const move = ev => {
    const { scrollHeight, clientHeight } = document.documentElement
    window.scrollTo(0, startTop + (ev.clientY - startY) * ((scrollHeight - clientHeight) / (clientHeight - thumb.offsetHeight)))
  }
  const up = () => {
    sb.classList.remove('drag')
    thumb.removeEventListener('pointermove', move)
    thumb.removeEventListener('pointerup', up)
    sbShow()
  }
  thumb.addEventListener('pointermove', move)
  thumb.addEventListener('pointerup', up)
})
sb.addEventListener('pointerdown', e => {
  if (e.target !== sb) return
  const { scrollHeight, clientHeight } = document.documentElement
  window.scrollTo({ top: (e.clientY / clientHeight) * (scrollHeight - clientHeight), behavior: 'smooth' })
})

for (const b of document.querySelectorAll('[data-lang]'))
  b.addEventListener('click', () => {
    if (b.dataset.lang === getLang()) return
    setLang(b.dataset.lang)
    route()
  })

window.addEventListener('hashchange', route)
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea')) return
  if (e.key === '1') location.hash = '#/'
  if (e.key === '2') location.hash = '#/time'
})
route()
