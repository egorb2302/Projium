import { t, getLang, setLang, fmtDate } from './i18n.js'
import { todayIn, taskState, sortTasks, topTask, signalData, targetState, watchSummary } from './logic.js'
import { detailText, signalName, durationText } from './watch-text.js'

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

const dayLabel = (d, year) => new Date(`${d}T00:00:00Z`).toLocaleDateString(t('locale'), { day: 'numeric', month: 'short', year: year ? 'numeric' : undefined, timeZone: 'UTC' })
const SIG_TEXT = { incident: 'sigIncident', down: 'sigDown', over: 'sigOverdue', p1: 'sigP1', soon: 'sigSoon', stale: 'sigStale' }
const signals = p => signalData(p).map(s => ({ ...s, text: t(SIG_TEXT[s.kind], s.n) }))
const sigChips = list => (list?.length ? h('div', { class: 'sigs' }, list.map(s => h('span', { class: `pill ${s.tone}${s.kind === 'p1' ? ' mono' : ''}` }, s.text))) : null)
const urgency = p => p.sig.reduce((a, s) => a + s.w, 0)
const stat = (label, value) => h('span', {}, h('small', {}, label), h('b', { class: value == null ? 'nil' : '' }, value == null ? t('nil') : String(value)))
const readyText = r => (r?.total ? `${r.proven ?? '?'}/${r.total}` : null)
const nil = () => h('span', { class: 'nil' }, t('nil'))

const pref = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const setPref = (k, v) => {
  try {
    localStorage.setItem(k, v)
  } catch {}
}

let filter = null
let query = ''
let view = pref('projium-view', 'cards') === 'table' ? 'table' : 'cards'
let sortBy = pref('projium-sort', 'urgent')
let doneOpen = false
let seq = 0

const recent = p => p.fields.spec_at || p.fields.first_push_at || ''
const SORTS = {
  urgent: (a, b) => urgency(b) - urgency(a) || recent(b).localeCompare(recent(a)),
  recent: (a, b) => recent(b).localeCompare(recent(a)),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
}

const skCard = () => h('div', { class: 'sk-card' }, h('b'), h('i'), h('i'), h('i'))
const skPanel = lines => h('div', { class: 'sk-panel' }, h('b'), Array.from({ length: lines }, () => h('i')))
const skeleton = page =>
  page === 'project'
    ? [h('div', { class: 'sk-head' }, h('div', {}, h('i', { class: 'sk-title' }), h('i'), h('div', { class: 'sk-strip' })), h('b', { class: 'sk-cover' })),
      h('div', { class: 'cols' }, h('div', {}, skPanel(8), skPanel(4)), h('div', {}, skPanel(3), skPanel(6)))]
    : page === 'time' || page === 'watch'
      ? [h('div', { class: 'sk-strip sk-kpis' }), skPanel(9), skPanel(12)]
      : [h('div', { class: 'sk-bar' }, h('i'), h('i'), h('i')), h('div', { class: 'grid' }, skCard(), skCard(), skCard(), skCard())]

const pageLink = p => `#/p/${encodeURIComponent(p.name)}`

const attention = projects => {
  const rows = projects
    .map(p => ({ p, s: p.sig.filter(x => x.tone !== 'off') }))
    .filter(r => r.s.length)
    .sort((a, b) => urgency(b.p) - urgency(a.p))
  if (!rows.length) return null
  return h('section', { class: 'panel attn' },
    h('h2', { class: 'row' }, h('span', {}, t('attention')), h('span', { class: 'n' }, rows.length)),
    rows.map(({ p, s }) => {
      const top = topTask(p)
      return h('a', { class: 'attn-row', href: pageLink(p) },
        h('span', { class: `dot ${s[0].tone}` }),
        h('b', {}, p.name),
        sigChips(s),
        h('span', { class: 'attn-task' }, top ? rich(top.text) : ''))
    }))
}

const card = p => {
  const d = durations(p.fields)
  return h('a', { class: 'card', href: pageLink(p) },
    cover(p),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-head' }, healthDot(p), h('h3', {}, p.name), stageChip(p.fields.stage)),
      p.fields.status ? h('div', { class: 'status' }, p.fields.status) : null,
      p.fields.next_step ? h('div', { class: 'next' }, rich(p.fields.next_step)) : null,
      sigChips(p.sig),
      h('div', { class: 'stats' },
        stat(t('cardTasks'), p.tasks.filter(x => !x.done).length),
        stat(t('cardReady'), readyText(p.repoInfo?.readiness)),
        stat(t('cardPush'), d.push == null ? null : fmtH(d.push)))))
}

const LIST_COLS = ['', '', 'c-next', '', 'num', 'num c-m', 'num c-m', 'num c-m', 'num c-m']
const listTable = shown => h('div', { class: 'panel flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'ptable' },
  h('thead', {}, h('tr', {}, t('listCols').map((x, i) => h('th', { class: LIST_COLS[i] || null }, x)))),
  h('tbody', {}, shown.map(p => {
    const d = durations(p.fields)
    const cells = [
      [h('div', { class: 'pname' }, healthDot(p), h('a', { href: pageLink(p) }, p.name)), p.fields.status ? h('div', { class: 'muted small' }, p.fields.status) : null],
      stageChip(p.fields.stage),
      h('div', { class: 'clip', title: p.fields.next_step ?? '' }, rich(p.fields.next_step ?? '')),
      sigChips(p.sig),
      p.tasks.filter(x => !x.done).length,
      readyText(p.repoInfo?.readiness) ?? nil(),
      p.health?.uptime24 != null ? `${p.health.uptime24}%` : nil(),
      d.push == null ? nil() : fmtH(d.push),
      d.total == null ? nil() : fmtH(d.total),
    ]
    return h('tr', { onclick: e => e.target.closest('a') || (location.hash = pageLink(p)) }, cells.map((c, i) => h('td', { class: LIST_COLS[i] || null }, c)))
  })))))

const renderList = async n => {
  const all = await api('/api/projects')
  if (n !== seq) return
  const broken = all.filter(p => p.error)
  const projects = all.filter(p => !p.error)
  for (const p of projects) p.sig = signals(p)
  let cur = filter ?? (projects.some(p => p.fields.stage !== 'done') ? 'open' : 'all')
  const body = h('div')
  const count = h('span', { class: 'count' })
  const paint = () => {
    const q = query.trim().toLowerCase()
    const shown = projects
      .filter(p => cur === 'all' || (cur === 'done' ? p.fields.stage === 'done' : p.fields.stage !== 'done'))
      .filter(p => !q || [p.name, p.fields.next_step, p.fields.status].some(v => String(v ?? '').toLowerCase().includes(q)))
      .sort(Object.hasOwn(SORTS, sortBy) ? SORTS[sortBy] : SORTS.urgent)
    count.textContent = t('countOf', shown.length, projects.length)
    body.replaceChildren(!shown.length ? h('p', { class: 'muted empty' }, t('noMatches')) : view === 'table' ? listTable(shown) : h('div', { class: 'grid' }, shown.map(card)))
  }
  const chips = ['open', 'done', 'all'].map(k => h('button', {
    class: `chip${cur === k ? ' on' : ''}`,
    onclick: e => {
      cur = filter = k
      for (const c of chips) c.classList.toggle('on', c === e.currentTarget)
      paint()
    },
  }, t('filters')[k]))
  const search = h('input', {
    id: 'search', type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), autocomplete: 'off', spellcheck: 'false',
    oninput: e => ((query = e.target.value), paint()),
    onkeydown: e => e.key === 'Escape' && ((e.target.value = ''), (query = ''), paint(), e.target.blur()),
  })
  const sorter = h('select', { class: 'sort', 'aria-label': t('sortLabel'), onchange: e => ((sortBy = e.target.value), setPref('projium-sort', sortBy), paint()) },
    Object.entries(t('sorts')).map(([k, v]) => h('option', { value: k, selected: k === sortBy }, v)))
  const VIEWS = ['cards', 'table']
  const views = VIEWS.map(k => h('button', {
    type: 'button', 'aria-pressed': String(view === k),
    onclick: () => {
      view = k
      setPref('projium-view', k)
      views.forEach((b, i) => b.setAttribute('aria-pressed', String(VIEWS[i] === view)))
      paint()
    },
  }, t('views')[k]))
  render(
    attention(projects),
    h('div', { class: 'bar' },
      h('div', { class: 'bar-l' }, chips, h('label', { class: 'search' }, search, h('kbd', {}, '/'))),
      h('div', { class: 'bar-r' }, count, sorter, h('div', { class: 'seg', role: 'group', 'aria-label': t('viewLabel') }, views))),
    broken.length ? h('p', { class: 'muted small' }, t('couldNotRead', broken.map(b => `${b.name} (${b.error})`).join(', '))) : null,
    body)
  paint()
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

const fmtValue = (kind, v) => {
  if (!v) return null
  if (kind !== 'date' && kind !== 'time') return v
  const [d, tm] = v.split(/[T ]/)
  return tm ? `${d} ${tm.slice(0, 5)}` : d
}

const fieldRow = (p, [key, kind], rerender) => {
  const value = p.fields[key] ?? ''
  const id = `f-${key}`
  const name = t('fields')[key]
  const options = value && !STAGES.includes(value) ? [value, ...STAGES] : STAGES
  const input = kind === 'stage'
    ? h('select', { 'aria-label': name }, options.map(s => h('option', { value: s, selected: s === value }, stageName(s))))
    : h('input', { value, 'aria-label': name, type: kind === 'date' ? 'date' : kind === 'time' ? 'datetime-local' : 'text', lang: t('locale') })
  const initial = input.value
  const shown = kind === 'stage' ? (value ? stageChip(value) : null) : fmtValue(kind, value)
  const plain = kind === 'stage' ? (value ? stageName(value) : '') : fmtValue(kind, value) ?? ''
  const locked = p.locked?.includes(key)
  const view = h('button', { type: 'button', class: `v v-${kind}`, id, 'aria-label': t('editField', name, plain || t('nil')), disabled: locked, title: locked ? t('locked') : null },
    shown == null ? nil() : kind === 'text' ? rich(shown) : shown)
  const owner = p.fieldKeys?.[key]
  const row = h('div', { class: 'field' }, h('span', { class: 'k', title: owner ? t('ownerKey', owner) : null }, name, owner ? h('span', { class: 'muted' }, ` · ${owner}`) : null), view)
  if (locked) return row
  let expected = value
  view.addEventListener('click', () => {
    row.replaceChild(input, view)
    input.focus()
  })
  input.addEventListener('blur', () => {
    if (input.value !== initial || row.querySelector('.conflict') || input.parentNode !== row) return
    input.classList.remove('err')
    row.replaceChild(view, input)
  })
  input.addEventListener('keydown', e => {
    if (e.key !== 'Escape' && !(e.key === 'Enter' && input.value === initial)) return
    e.preventDefault()
    input.value = initial
    input.blur()
    if (view.isConnected) view.focus()
  })
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

const writer = (p, what, rerender) => async body => {
  try {
    rerender(await api(`/api/projects/${encodeURIComponent(p.name)}/${what}`, { ...body, fileId: p.fileId }))
  } catch (e) {
    toast(e.status === 409 ? t('reloaded', e.message) : e.message, true)
    if (e.status === 409) route()
    else if (body.op !== 'edit' && body.op !== 'add') rerender(p)
  }
}

const updateList = (p, rerender) => {
  if (!p.updates.length) return h('p', { class: 'muted small' }, t('noUpdates'))
  const send = writer(p, 'update', rerender)
  return h('ul', { class: 'lines upd' }, p.updates.map(u => (u.item
    ? h('li', { class: `upd-item${u.done ? ' done' : ''}` },
      h('input', { type: 'checkbox', checked: u.done, 'aria-label': t('doneLabel', u.text), onchange: () => send({ at: u.at, done: !u.done, expected: { text: u.text, done: u.done, id: u.id } }) }),
      h('span', {}, rich(u.text)))
    : h('li', { class: 'upd-note muted small' }, rich(u.text)))))
}

const taskList = (p, rerender) => {
  const send = writer(p, 'task', rerender)
  const ref = x => (x.id ? { id: x.id } : { at: x.at })
  const expected = x => ({ done: x.done, text: x.text, due: x.due, p: x.p })
  const today = todayIn(p.zone)
  const meta = task => [
    task.p ? h('span', { class: `prio ${task.p}` }, task.p) : null,
    task.due ? h('span', { class: `due ${taskState(task, today)}`, title: task.due }, t('due', dayLabel(task.due, task.due.slice(0, 4) !== today.slice(0, 4)))) : null,
  ]
  const item = task => {
    const li = h('li', { class: `task${task.done ? ' done' : ''}` })
    const view = () => li.replaceChildren(
      h('input', { type: 'checkbox', checked: task.done, 'aria-label': t('doneLabel', task.text), onchange: () => send({ op: 'toggle', ...ref(task), expected: expected(task) }) }),
      h('div', { class: 't-body' }, h('span', { class: 't-text' }, rich(task.text)), meta(task)),
      h('button', { onclick: edit }, t('edit')))
    const edit = () => {
      const text = h('input', { value: task.text, 'aria-label': t('taskText') })
      const due = h('input', { type: 'date', value: task.due, 'aria-label': t('dueDate'), lang: t('locale') })
      const pr = h('select', { 'aria-label': t('priority') }, ['', 'p1', 'p2', 'p3'].map(x => h('option', { value: x, selected: x === task.p }, x || t('none'))))
      li.replaceChildren(h('span'), h('div', { class: 'edit' }, text, due, pr,
        h('button', { class: 'primary', onclick: () => send({ op: 'edit', ...ref(task), expected: expected(task), task: { text: text.value, due: due.value, p: pr.value } }) }, t('save')),
        h('button', { onclick: view }, t('cancel'))), h('span'))
    }
    view()
    return li
  }
  const open = sortTasks(p.tasks.filter(x => !x.done), today)
  const done = p.tasks.filter(x => x.done)
  const text = h('input', { placeholder: t('newTask'), 'aria-label': t('newTask') })
  const due = h('input', { type: 'date', 'aria-label': t('dueDate'), lang: t('locale') })
  const pr = h('select', { 'aria-label': t('priority') }, ['p2', 'p1', 'p3', ''].map(x => h('option', { value: x }, x || t('none'))))
  const add = () => text.value.trim() && send({ op: 'add', task: { text: text.value, due: due.value, p: pr.value } })
  text.addEventListener('keydown', e => e.key === 'Enter' && add())
  return h('div', {},
    open.length ? h('ul', { class: 'tasks' }, open.map(item)) : done.length ? null : h('p', { class: 'muted small' }, t('noTasks')),
    done.length ? h('details', { class: 'done-tasks', open: doneOpen, ontoggle: e => (doneOpen = e.currentTarget.open) }, h('summary', {}, t('doneTasks', done.length)), h('ul', { class: 'tasks' }, done.map(item))) : null,
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
  const tag = e => {
    const detail = [
      e.n != null && e.flags.length ? e.flags.map(f => `${f.name}: ${f.prod == null ? t('notInConfig') : f.prod ? t('on') : t('off')}`).join(', ') : null,
      e.branch ? `${t('branch', e.branch.name, e.branch.sha)}${e.branch.inMain == null ? t('mainCheckFailed') : e.branch.inMain ? t('inMain') : t('notInMain')}` : null,
    ].filter(Boolean).join('; ')
    return h('span', { class: 'tag', title: detail || null }, e.n == null ? e.flags[0].name : t('update', e.n))
  }
  const groups = Object.keys(PROD_TONES)
    .map(state => ({ state, items: s.entries.filter(e => (PROD_TONES[e.state] ? e.state : 'unknown') === state) }))
    .filter(g => g.items.length)
  return h('div', {},
    h('h3', { class: 'sub' }, t('releaseState')),
    h('div', { class: 'prod' }, groups.map(g => h('div', { class: 'prod-group' },
      h('span', { class: `pill ${PROD_TONES[g.state]}` }, `${t('prod')[g.state]} · ${g.items.length}`),
      h('div', { class: 'tags' }, g.items.map(tag))))),
    h('p', { class: 'muted small' }, t('branchNote', when)))
}

const auditBadge = info => {
  const f = info.freshness ?? {}
  if (f.state === 'current') return h('span', { class: 'pill ok' }, t('auditOk'))
  if (f.state === 'changed-after') return h('span', { class: 'pill warn' }, t('sigStale', Math.max(f.sinceLocal ?? 0, f.sinceOrigin ?? 0)))
  return h('span', { class: 'pill off' }, t('auditNone'))
}

const meter = r => (r?.total
  ? h('div', { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', {}, t('cardReady')), h('b', {}, `${r.proven ?? 0} / ${r.total}`)),
    h('div', { class: 'meter-track' }, h('i', { style: `width:${Math.min(100, ((r.proven ?? 0) / r.total) * 100)}%` })))
  : null)

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
          h('p', { class: 'head-line' }, stageChip(f.stage), f.status ? h('span', { class: 'status' }, f.status) : null, sigChips(signals(p))),
          f.site ? h('p', { class: 'small' }, healthDot(p), ' ', safeSite(f.site) ? h('a', { href: safeSite(f.site), target: '_blank', rel: 'noreferrer noopener' }, f.site) : f.site,
            p.health?.uptime24 != null ? h('span', { class: 'muted' }, t('uptime', p.health.uptime24, p.health.checks24)) : null) : null,
          p.health?.history?.length ? spark(p.health.history) : null,
          h('div', { class: 'stats' },
            stat(t('specToDesign'), d.design == null ? null : fmtH(d.design)),
            stat(t('specToFirstPush'), d.push == null ? null : fmtH(d.push)),
            stat(t('firstPushToMainnet'), d.mainnet == null ? null : fmtH(d.mainnet)),
            stat(t('specToMainnet'), d.total == null ? null : fmtH(d.total)))),
        cover(p)),
      h('div', { class: 'cols' },
        h('div', {},
          h('section', { class: 'panel' }, h('h2', {}, t('cardFields')), h('div', { class: 'fields' }, FIELDS.map(x => fieldRow(p, x, draw))),
            h('p', { class: 'muted small' }, t('fieldsNote', p.zone ?? '+00:00'))),
          h('section', { class: 'panel' }, h('h2', {}, t('tasks')), taskList(p, draw))),
        h('div', {},
          watchPanel(p),
          h('section', { class: 'panel' }, h('h2', { class: 'row' }, h('span', {}, t('audit')), auditBadge(info)),
            meter(r),
            r ? h('p', { class: 'small' }, t('auditAt', r.audit || t('undated'))) : null,
            h('p', { class: 'small muted' }, freshnessText(info)),
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
            updateList(p, draw),
            prodPanel(p)),
          h('section', { class: 'panel' }, h('h2', {}, t('timeline')),
            p.timeline.length ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, t('timelineCols').map(x => h('th', {}, x)))),
              h('tbody', {}, p.timeline.map(row => h('tr', {}, row.slice(0, 4).map(c => h('td', {}, rich(c)))))))) : h('p', { class: 'muted small' }, t('noTimeline'))))))
    const focused = focusId ? document.getElementById(focusId) : null
    if (focused) {
      focused.focus()
      focused.classList.add('saved')
      setTimeout(() => focused.classList.remove('saved'), 1200)
    }
  }
  draw(p)
}

const SPLIT = [['work', 'sp-work'], ['review', 'sp-review'], ['waiting', 'sp-wait'], ['pause', 'sp-pause'], ['missing', 'sp-missing']]
const PHASES = ['total', 'toFirstPush', 'toMainnet']

const splitPanel = projects => {
  const rows = projects.map(p => ({ p, ph: p.timeSplit?.phases ?? {} })).filter(r => PHASES.some(k => r.ph[k]))
  const withData = rows.filter(r => Object.values(r.ph).some(s => s.hasData))
  const without = rows.filter(r => !withData.includes(r))
  const h1 = ms => fmtH(ms / 36e5)
  const label = k => t('split')[k]
  return h('section', { class: 'panel' }, h('h2', {}, t('whereTime')),
    h('div', { class: 'legend' }, SPLIT.map(([k, cls]) => h('span', {}, h('i', { class: cls }), label(k)))),
    withData.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('project')), h('th', {}, t('phase')), h('th', { class: 'split-col' }, ''), SPLIT.map(([k]) => h('th', { class: 'num' }, label(k))), h('th', { class: 'num' }, t('wallClock')))),
      h('tbody', {}, withData.flatMap(({ p, ph }) =>
        PHASES.filter(k => ph[k]).map((k, i) => {
          const s = ph[k]
          const first = [projectLink(p), p.timeSplit?.lost ? h('div', { class: 'muted small' }, t('lostShort', p.timeSplit.lost)) : null]
          const tr = h('tr', { class: i ? 'sub' : '' }, h('td', {}, i ? '' : first), h('td', { class: 'muted' }, t('phases')[k]))
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
        }))))) : null,
    without.length ? h('p', { class: 'small nodata' }, t('noTranscriptsList'), without.flatMap((r, i) => [i ? ', ' : '', projectLink(r.p), r.p.timeSplit?.lost ? t('lostIn', r.p.timeSplit.lost) : ''])) : null,
    h('p', { class: 'muted small' }, t('splitNote')))
}

const NS = 'http://www.w3.org/2000/svg'
const sv = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v)
  el.append(...kids.flat(Infinity).filter(x => x != null))
  return el
}

const chartBox = (cls, draw) => {
  const box = h('div', { class: `chart ${cls}` })
  const tip = h('div', { class: 'tip', role: 'tooltip' })
  let width = 0
  const show = (target, ...kids) => {
    tip.replaceChildren(...kids)
    const b = box.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    tip.classList.add('on')
    const x = Math.min(Math.max(r.left + r.width / 2 - b.left - tip.offsetWidth / 2, 0), b.width - tip.offsetWidth)
    tip.style.transform = `translate(${x}px, ${r.top - b.top - tip.offsetHeight - 8}px)`
  }
  const hide = () => tip.classList.remove('on')
  new ResizeObserver(() => {
    if (!box.clientWidth || box.clientWidth === width) return
    width = box.clientWidth
    box.replaceChildren(draw(width, { show, hide }), tip)
  }).observe(box)
  return box
}

const hoverable = (el, tips, content) => {
  const on = () => (el.classList.add('hot'), tips.show(el, ...content()))
  const off = () => (el.classList.remove('hot'), tips.hide())
  el.addEventListener('pointerenter', on)
  el.addEventListener('pointerleave', off)
  el.addEventListener('focus', on)
  el.addEventListener('blur', off)
  return el
}

const TICKS_H = [0.5, 1, 3, 12, 24, 72, 168, 720, 2160]
const tickH = v => (v < 24 ? `${v} ${t('h')}` : `${v / 24} ${t('d')}`)
const DAY = 864e5
const dayText = ms => new Date(ms).toLocaleDateString(t('locale'), { day: 'numeric', month: 'short' })

const trendChart = rows => (width, tips) => {
  const H = width < 560 ? 230 : 280
  const m = { l: 52, r: 18, t: 22, b: 30 }
  const iw = width - m.l - m.r
  const ih = H - m.t - m.b
  const vals = rows.map(r => r.total)
  const lo = TICKS_H.filter(x => x <= Math.min(...vals) / 1.2).at(-1) ?? Math.min(...vals) / 1.2
  const hi = TICKS_H.find(x => x >= Math.max(...vals)) ?? Math.max(...vals)
  const y = v => m.t + ih - ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * ih
  const xs = rows.map(r => r.at)
  const pad = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.04, DAY)
  const x0 = Math.min(...xs) - pad
  const x1 = Math.max(...xs) + pad
  const x = v => m.l + ((v - x0) / (x1 - x0)) * iw
  const step = [1, 2, 3, 7, 14, 30, 60].map(d => d * DAY).find(s => (x1 - x0) / s <= iw / 84) ?? 90 * DAY
  const first = new Date(x0)
  first.setHours(0, 0, 0, 0)
  const dayTicks = []
  for (let d = first.getTime() + DAY; d < x1; d += step) dayTicks.push(d)
  const med = median(vals)
  const pts = rows.map(r => ({ ...r, cx: x(r.at), cy: y(r.total) }))
  const ends = width < 560 ? [] : [pts[0], pts.at(-1)].filter((p, i, a) => a.indexOf(p) === i)
  const label = p => {
    const right = p.cx < width / 2
    return sv('text', { x: p.cx + (right ? 12 : -12), y: p.cy - 10, 'text-anchor': right ? 'start' : 'end', class: 'lbl halo' },
      sv('tspan', { class: 'lbl-v' }, fmtH(p.total)), ` ${p.p.name}`)
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('')
  return sv('svg', { width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'group', 'aria-label': t('trendAria', rows.length, fmtH(med)) },
    sv('defs', {}, sv('linearGradient', { id: 'trend-wash', x1: 0, y1: 0, x2: 0, y2: 1 }, sv('stop', { offset: 0, class: 'wash-top' }), sv('stop', { offset: 1, class: 'wash-end' }))),
    TICKS_H.filter(v => v >= lo && v <= hi).map(v => [
      sv('line', { x1: m.l, x2: width - m.r, y1: y(v), y2: y(v), class: 'grid' }),
      sv('text', { x: m.l - 10, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, tickH(v))]),
    dayTicks.map(d => sv('text', { x: x(d), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, dayText(d))),
    med == null ? null : [
      sv('line', { x1: m.l, x2: width - m.r, y1: y(med), y2: y(med), class: 'median' }),
      sv('text', { x: width - m.r, y: y(med) - 6, 'text-anchor': 'end', class: 'tick halo' }, t('medianLine', fmtH(med)))],
    pts.length > 1 ? sv('path', { d: `${line}L${pts.at(-1).cx.toFixed(1)},${m.t + ih}L${pts[0].cx.toFixed(1)},${m.t + ih}Z`, class: 'wash' }) : null,
    sv('path', { d: line, class: 'trend' }),
    pts.map(p => hoverable(
      sv('a', { href: pageLink(p.p), class: 'pt', 'aria-label': `${p.p.name}: ${fmtH(p.total)}, ${dayText(p.at)}` },
        sv('circle', { cx: p.cx, cy: p.cy, r: 14, class: 'hit' }),
        sv('circle', { cx: p.cx, cy: p.cy, r: 5, class: 'dot' })),
      tips,
      () => [h('b', {}, fmtH(p.total)), h('span', {}, p.p.name), h('span', { class: 'muted' }, dayText(p.at))])),
    ends.map(label))
}

const PHASE_KEYS = ['a', 'b', 'c']
const phaseParts = d => {
  const a = d.design ?? 0
  const b = d.push == null ? 0 : Math.max(0, d.push - a)
  const c = Math.max(0, d.mainnet ?? 0)
  const parts = [['a', a], ['b', b], ['c', c]].filter(([, v]) => v > 0)
  const rest = d.total - parts.reduce((s, [, v]) => s + v, 0)
  if (d.push == null && rest > 0) parts.push(['x', rest])
  return parts.length ? parts : [['x', d.total]]
}

const phaseChart = rows => (width, tips) => {
  const narrow = width < 560
  const track = width - (narrow ? 100 : 160) - (narrow ? 56 : 72) - 28
  return h('div', { class: `ph-rows${narrow ? ' narrow' : ''}` }, rows.map(({ p, d }) => {
    const parts = phaseParts(d)
    const sum = parts.reduce((s, [, v]) => s + v, 0) || 1
    return h('div', { class: 'ph-row' },
      projectLink(p),
      h('div', { class: 'ph-track' }, parts.map(([k, v]) => {
        const share = v / sum
        const name = k === 'b' && d.design == null ? t('legendB0') : t(`legend${k.toUpperCase()}`)
        return hoverable(
          h('span', { class: `ph ph-${k}`, style: `flex-grow:${share}`, tabindex: '0', 'aria-label': `${p.name}, ${name}: ${fmtH(v)}` },
            share * track >= 44 ? `${Math.round(share * 100)}%` : null),
          tips,
          () => [h('b', {}, fmtH(v)), h('span', {}, name), h('span', { class: 'muted' }, `${Math.round(share * 100)}% · ${p.name}`)])
      })),
      h('span', { class: 'num' }, fmtH(d.total)))
  }))
}

const renderTime = async n => {
  const all = await api('/api/projects')
  if (n !== seq) return
  const projects = all.filter(p => !p.error).map(p => ({ ...p, d: durations(p.fields) }))
  const timed = projects.filter(p => p.d.total != null && Number.isFinite(Date.parse(p.fields.spec_at)))
  const untimed = projects.filter(p => !timed.includes(p))
  const trend = timed.map(p => ({ p, at: Date.parse(p.fields.spec_at), total: Math.max(p.d.total, 0.05) })).sort((a, b) => a.at - b.at)
  const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, fmtH(v)), h('div', { class: 'l' }, l))
  render(
    h('div', { class: 'kpis' },
      kpi(median(projects.map(p => p.d.design)), t('medianDesign')),
      kpi(median(projects.map(p => p.d.push)), t('medianPush')),
      kpi(median(projects.map(p => p.d.mainnet)), t('medianMainnet')),
      kpi(median(projects.map(p => p.d.total)), t('medianTotal'))),
    trend.length
      ? h('section', { class: 'panel' }, h('h2', {}, t('trendTitle')),
        chartBox('trend-chart', trendChart(trend)),
        h('p', { class: 'muted small' }, t('trendNote')))
      : null,
    trend.length
      ? h('section', { class: 'panel' }, h('h2', {}, t('phasesTitle')),
        h('div', { class: 'legend' }, [...PHASE_KEYS, ...(trend.some(r => phaseParts(r.p.d).some(([k]) => k === 'x')) ? ['x'] : [])]
          .map(k => h('span', {}, h('i', { class: `ph-${k}` }), t(`legend${k.toUpperCase()}`)))),
        chartBox('phase-chart', phaseChart([...trend].reverse().map(r => ({ p: r.p, d: r.p.d })))),
        untimed.length ? h('p', { class: 'small nodata' }, t('noTotalList'), untimed.flatMap((p, i) => [i ? ', ' : '', projectLink(p)])) : null)
      : null,
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

const lang = () => getLang()
const fmtShort = ts => new Date(ts).toLocaleString(t('locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const shortAddr = a => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? '')
const mutedNow = x => x.mutedUntil != null && x.mutedUntil > Date.now()
const sigTone = s => (s.status === 'open' ? 'bad' : s.result == null ? 'off' : s.result === 'ok' ? 'ok' : 'warn')
const STATE_TONE = { open: 'bad', ok: 'ok', wait: 'off', skip: 'warn' }
const STATE_TEXT = { open: 'stOpen', ok: 'stOk', wait: 'stWait', skip: 'stSkip' }

const signalLine = s => h('div', { class: 'wsig' },
  h('span', { class: `dot ${sigTone(s)}` }),
  h('span', { class: 'wsig-name' }, signalName(s.signal, lang())),
  h('span', { class: 'wsig-detail' }, s.result == null ? t('stWait') : detailText(s.detail, lang())),
  s.status === 'open' && s.since ? h('span', { class: 'muted small' }, t('sinceAt', fmtShort(s.since))) : null)

const watchPanel = p => {
  const w = p.watch
  if (!w?.targets?.length) return null
  return h('section', { class: 'panel' },
    h('h2', { class: 'row' }, h('span', {}, t('watchPanel')), w.open ? h('span', { class: 'pill bad' }, t('sigIncident', w.open)) : h('span', { class: 'pill ok' }, t('stOk'))),
    w.targets.map(x => h('div', { class: 'wtarget' },
      h('div', { class: 'wtarget-head' }, h('b', {}, x.name), mutedNow(x) ? h('span', { class: 'pill off' }, t('mutedTill', fmtShort(x.mutedUntil))) : null),
      x.signals.map(signalLine))),
    h('p', { class: 'small' }, h('a', { href: '#/watch' }, t('allTargets'))))
}

const ruleLines = x => {
  const link = (href, text) => (safeSite(href) ? h('a', { href, target: '_blank', rel: 'noreferrer noopener', class: 'mono' }, text) : h('span', { class: 'mono', title: href }, text))
  if (x.kind === 'site') return [link(x.url, x.url), x.certDays ? t('certRule', x.certDays) : null]
  if (x.kind === 'heartbeat')
    return [
      link(x.url, x.url),
      x.field ? t('beatRule', x.field, x.maxAgeMin) : null,
      x.activeWhen ? t('activeRule', Object.entries(x.activeWhen).map(([k, v]) => `${k} = ${v}`).join(', ')) : null,
      x.max ? t('maxRule', Object.entries(x.max).map(([k, v]) => `${k} ≤ ${v}`).join(', ')) : null,
    ]
  return [
    x.chain === 'solana' ? link(`https://solscan.io/account/${x.address}`, `${x.chain} ${shortAddr(x.address)}`) : h('span', { class: 'mono', title: x.address }, `${x.chain} ${shortAddr(x.address)}`),
    t('belowRule', x.min, x.unit),
    t('rpcFrom')[x.rpc] ?? x.rpc,
  ]
}

const renderWatch = async n => {
  const first = await api('/api/watch')
  if (n !== seq) return
  const draw = st => {
    if (n !== seq) return
    if (!st.enabled) return render(h('section', { class: 'panel' }, h('h2', {}, t('watchPanel')), h('p', { class: 'muted' }, t('watchOff'))))
    const sum = watchSummary(st.targets)
    const setMute = async (name, until) => {
      try {
        draw(await api('/api/watch/mute', { target: name, until }))
      } catch (e) {
        toast(e.message, true)
        route()
      }
    }
    const muteCell = x => (mutedNow(x)
      ? h('div', { class: 'wmute' }, h('span', { class: 'pill off' }, t('mutedTill', fmtShort(x.mutedUntil))), h('button', { onclick: () => setMute(x.name, null) }, t('unmute')))
      : h('select', { class: 'sort', 'aria-label': t('muteLabel', x.name), onchange: e => e.target.value && setMute(x.name, Date.now() + Number(e.target.value) * 60e3) },
        h('option', { value: '' }, t('muteFor')), t('mutePresets').map(([m, label]) => h('option', { value: String(m) }, label))))
    const check = h('button', {
      onclick: async e => {
        const b = e.currentTarget
        b.disabled = true
        b.classList.add('loading')
        b.textContent = t('checking')
        try {
          draw(await api('/api/watch/check', {}))
        } catch (err) {
          toast(err.message, true)
          b.disabled = false
          b.classList.remove('loading')
          b.textContent = t('checkNow')
        }
      },
    }, t('checkNow'))
    const unknown = sum.skip + sum.wait
    const pills = [
      h('span', { class: 'pill ok' }, t('watchOk', sum.ok)),
      sum.open ? h('span', { class: 'pill bad' }, t('watchOpen', sum.open)) : null,
      unknown ? h('span', { class: 'pill warn' }, t('watchUnknownN', unknown)) : null,
      sum.muted ? h('span', { class: 'pill off' }, t('watchMutedN', sum.muted)) : null,
    ]
    const incState = i => (i.closedAt == null
      ? h('span', { class: 'pill bad' }, t('incOpenFor', durationText(Date.now() - i.openedAt, lang())))
      : i.end === 'removed' ? h('span', { class: 'pill off' }, t('incRemoved')) : h('span', { class: 'pill ok' }, t('incClosed', durationText(i.closedAt - i.openedAt, lang()))))
    const sent = i => (i.openSent ? (i.closeSent && i.end !== 'removed' ? t('sentBoth') : t('sentOpen')) : i.muted ? t('sentMuted') : t('sentNone'))
    const projectOf = name => (name ? h('div', { class: 'muted small' }, h('a', { href: `#/p/${encodeURIComponent(name)}` }, name)) : null)
    const ruleCell = x => h('div', { class: 'wrule' }, h('span', {}, t('kinds')[x.kind] ?? x.kind), ruleLines(x).filter(Boolean).map(l => (l instanceof Node ? l : h('span', { class: 'muted small' }, l))))
    render(
      h('div', { class: 'bar' },
        h('div', { class: 'bar-l' }, pills),
        h('div', { class: 'bar-r' }, h('span', { class: 'count' }, [t('watchEvery', st.every), st.lastTick ? t('watchLast', fmtShort(st.lastTick.at)) : t('watchNever')].join(' · ')), check)),
      st.lastTick?.offline ? h('p', { class: 'muted small' }, t('watchOffline')) : null,
      st.notify ? null : h('p', { class: 'muted small' }, t('watchNoNotify')),
      h('section', { class: 'panel' }, h('h2', {}, t('watchTargets')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'wtable targets' },
          h('thead', {}, h('tr', {}, t('watchCols').map(x => h('th', {}, x)))),
          h('tbody', {}, st.targets.map(x => {
            const state = targetState(x)
            return h('tr', {},
              h('td', {}, h('div', { class: 'pname' }, h('span', { class: `dot ${STATE_TONE[state]}`, title: t(STATE_TEXT[state]) }), h('b', {}, x.name)), projectOf(x.project)),
              h('td', {}, ruleCell(x)),
              h('td', {}, x.signals.map(signalLine)),
              h('td', {}, muteCell(x)))
          })))),
        h('p', { class: 'muted small' }, t('watchNote', st.failAfter, st.recoverAfter))),
      h('section', { class: 'panel' }, h('h2', {}, t('watchIncidents')),
        st.incidents.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'wtable' },
          h('thead', {}, h('tr', {}, t('incCols').map(x => h('th', {}, x)))),
          h('tbody', {}, st.incidents.map(i => h('tr', {},
            h('td', { class: 'when' }, fmtShort(i.openedAt)),
            h('td', {}, h('b', {}, i.target), h('span', { class: 'muted' }, ` · ${signalName(i.signal, lang())}`), projectOf(i.project)),
            h('td', {}, incState(i)),
            h('td', { class: 'wsig-detail' }, detailText(i.lastDetail, lang())),
            h('td', { class: 'muted small' }, sent(i))))))) : h('p', { class: 'muted small' }, t('noIncidents'))))
  }
  draw(first)
}

const NAV = { list: 'navProjects', time: 'navTime', watch: 'navWatch' }

const chrome = page => {
  document.documentElement.lang = getLang()
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('on', a.dataset.nav === page)
    a.firstChild.textContent = `${t(NAV[a.dataset.nav] ?? 'navProjects')} `
  }
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()))
}

const route = async () => {
  const hash = location.hash || '#/'
  const page = hash.startsWith('#/p/') ? 'project' : hash === '#/time' ? 'time' : hash === '#/watch' ? 'watch' : 'list'
  chrome(page)
  document.getElementById('path').textContent = page === 'project' ? decodeURIComponent(hash.slice(4)) : t(NAV[page] ?? 'navProjects')
  const n = ++seq
  const first = app.getAttribute('aria-busy') === 'true' && page === 'list'
  const slow = first ? null : setTimeout(() => n === seq && (render(skeleton(page)), app.setAttribute('aria-busy', 'true')), 150)
  try {
    if (page === 'project') await renderProject(decodeURIComponent(hash.slice(4)), n)
    else if (page === 'time') await renderTime(n)
    else if (page === 'watch') await renderWatch(n)
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
  if (e.key === '3') location.hash = '#/watch'
  const search = document.getElementById('search')
  if (e.key === '/' && search) {
    e.preventDefault()
    search.focus()
  }
})
route()
