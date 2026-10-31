import http from 'node:http'
import { loadConfig } from './config.mjs'
import { whoIsOn } from './control.mjs'
import { diagnose } from './doctor.mjs'
import { STAGES, EDITABLE } from './card.mjs'

export const MODERN = '2026-07-28'
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const SUPPORTED = [MODERN, ...LEGACY]
const VERSION_META = 'io.modelcontextprotocol/protocolVersion'

const INSTRUCTIONS = [
  "Projium tracks the owner's projects from their own Markdown notes: stage, next step, tasks, milestone times, repo audit freshness and site uptime.",
  'Read with list_projects and get_project. Before any write, call get_project and pass its fileId plus the values exactly as you read them (expected); on a conflict, read again instead of retrying blindly.',
  "Writes go into the owner's notes, in their own keys and words. Change only what the owner asked for.",
].join(' ')

const text = description => ({ type: 'string', description })
const name = { type: 'string', description: 'Project name exactly as list_projects returns it', minLength: 1 }
const fileId = text('fileId from get_project. Writes are refused when the name now points at another note')
const due = { type: 'string', description: 'Due date YYYY-MM-DD, or "" for none', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' }
const priority = { type: 'string', description: 'p1, p2, p3, or "" for none', enum: ['', 'p1', 'p2', 'p3'] }
const seen = {
  type: 'object',
  description: 'The task exactly as get_project returned it',
  properties: { done: { type: 'boolean' }, text: { type: 'string' }, due: { type: 'string' }, p: { type: 'string' } },
  required: ['done', 'text', 'due', 'p'],
}
const taskId = { type: 'string', description: 'Task id like t-a1b2 from get_project', pattern: '^t-[a-z0-9]{4}$' }
const input = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const READ = { readOnlyHint: true, openWorldHint: false }

export const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Every project card with its stage, next step, open tasks, earliest due date, site state, audit freshness and readiness. Ignored projects are left out unless include_ignored is true.',
    inputSchema: input({ stage: { type: 'string', enum: STAGES, description: 'Only projects in this stage' }, include_ignored: { type: 'boolean' } }),
    annotations: READ,
  },
  {
    name: 'get_project',
    title: 'Get a project',
    description: 'One project in full: fields, tasks with ids, updates, timeline, locked fields, repo and audit info, prod update flags, uptime, build time split, and the fileId that writes need.',
    inputSchema: input({ name }, ['name']),
    annotations: READ,
  },
  {
    name: 'set_field',
    title: 'Set a card field',
    description: `Writes one field into the project's note. key is one of ${EDITABLE.join(', ')}. Dates are YYYY-MM-DD, times YYYY-MM-DDTHH:MM in the owner's zone, stage one of ${STAGES.join(', ')}, site https://domain; "" clears a field. Refused when the field changed since expected was read, or is locked.`,
    inputSchema: input({ name, key: { type: 'string', enum: EDITABLE }, value: { type: 'string' }, expected: text('The current value as get_project returned it ("" when the field is empty or missing)'), fileId }, ['name', 'key', 'value', 'expected', 'fileId']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_task',
    title: 'Add a task',
    description: "Adds an open task to the project's task section (created when missing) and gives it an id.",
    inputSchema: input({ name, text: text('One line, without "^" or " · "'), due, p: priority, fileId }, ['name', 'text', 'fileId']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'toggle_task',
    title: 'Check or uncheck a task',
    description: 'Flips a task between open and done. Refused when the task changed since it was read.',
    inputSchema: input({ name, id: taskId, expected: seen, fileId }, ['name', 'id', 'expected', 'fileId']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'edit_task',
    title: 'Edit a task',
    description: 'Changes the text, due date or priority of a task; fields you leave out stay as they are. Refused when the task changed since it was read.',
    inputSchema: input({ name, id: taskId, expected: seen, text: text('New text, one line'), due, p: priority, fileId }, ['name', 'id', 'expected', 'fileId']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'refresh_project',
    title: 'Recheck a project',
    description: 'Re-reads git, the readiness audit, the live site config and the build time for one project, then returns it like get_project.',
    inputSchema: input({ name }, ['name']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'digest_preview',
    title: 'Preview the digest',
    description: 'The daily digest text as it would be sent now, with its time and whether sending is on. Sends nothing.',
    inputSchema: input(),
    annotations: READ,
  },
  {
    name: 'doctor',
    title: 'Check the setup',
    description: 'The Projium doctor report: config, every card and why it is shown or skipped, problems, hints and whether the server runs.',
    inputSchema: input(),
    annotations: READ,
  },
]

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

const mismatch = (schema, value, at) => {
  if (schema.type && typeOf(value) !== schema.type) return `${at} must be a ${schema.type}`
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at} has the wrong format`
  if (schema.minLength && value.length < schema.minLength) return `${at} must not be empty`
  if (schema.type !== 'object') return null
  for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) return `${at}.${k} is required`
  for (const [k, v] of Object.entries(value)) {
    const sub = Object.hasOwn(schema.properties ?? {}, k) ? schema.properties[k] : null
    if (!sub) {
      if (schema.additionalProperties === false) return `${at}.${k} is not a known argument`
      continue
    }
    const problem = mismatch(sub, v, `${at}.${k}`)
    if (problem) return problem
  }
  return null
}

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data })
const fail = (message, data) => ({ content: [{ type: 'text', text: message }], ...(data ? { structuredContent: data } : {}), isError: true })

const answer = r => {
  if (r.status === 200) return ok(r.json)
  if (r.status === 409)
    return fail(`Conflict: ${r.json?.error}. Current value: ${JSON.stringify(r.json?.current ?? null)}. Read the project again; send the change again with expected set to the current value only if the owner still wants it.`, { conflict: true, error: r.json?.error ?? null, current: r.json?.current ?? null })
  return fail(`Projium refused: ${r.json?.error ?? `HTTP ${r.status}`}`)
}

const siteDown = h => Boolean(h?.last && (h.last.code == null || h.last.code >= 400))

const summary = p => {
  if (p.error) return { name: p.name, error: p.error }
  const open = p.tasks.filter(t => !t.done)
  const dues = open.map(t => t.due).filter(Boolean).sort()
  const ready = p.repoInfo?.readiness
  return {
    name: p.name,
    stage: p.fields.stage ?? null,
    next_step: p.fields.next_step ?? null,
    open_tasks: open.length,
    next_due: dues[0] ?? null,
    site: p.fields.site ? { url: p.fields.site, down: siteDown(p.health), uptime24: p.health?.uptime24 ?? null } : null,
    audit: p.repoInfo?.freshness?.state ?? null,
    readiness: ready?.total ? `${ready.proven}/${ready.total}` : null,
    ignored: p.ignored === true,
  }
}

const projectPath = n => `/api/projects/${encodeURIComponent(n).replace(/\./g, '%2E')}`

const runners = api => ({
  list_projects: async a => {
    const r = await api.call('GET', '/api/projects')
    if (r.status !== 200) return answer(r)
    const projects = r.json.filter(p => (a.include_ignored || p.ignored !== true) && (!a.stage || p.fields?.stage === a.stage)).map(summary)
    return ok({ url: api.url(), projects })
  },
  get_project: async a => {
    const r = await api.call('GET', projectPath(a.name))
    if (r.status === 200 && r.json?.health) delete r.json.health.history
    return answer(r)
  },
  set_field: async a => answer(await api.call('POST', `${projectPath(a.name)}/field`, { key: a.key, value: a.value, expected: a.expected, fileId: a.fileId })),
  add_task: async a => answer(await api.call('POST', `${projectPath(a.name)}/task`, { op: 'add', task: { text: a.text, due: a.due ?? '', p: a.p ?? '' }, fileId: a.fileId })),
  toggle_task: async a => answer(await api.call('POST', `${projectPath(a.name)}/task`, { op: 'toggle', id: a.id, expected: a.expected, fileId: a.fileId })),
  edit_task: async a => {
    const task = Object.fromEntries(['text', 'due', 'p'].filter(k => Object.hasOwn(a, k)).map(k => [k, a[k]]))
    if (!Object.keys(task).length) return fail('Give at least one of text, due or p to change')
    return answer(await api.call('POST', `${projectPath(a.name)}/task`, { op: 'edit', id: a.id, expected: a.expected, task, fileId: a.fileId }))
  },
  refresh_project: async a => answer(await api.call('POST', `${projectPath(a.name)}/refresh`, {}, 120e3)),
  digest_preview: async () => {
    const r = await api.call('GET', '/api/digest')
    return r.status === 200 ? ok({ text: r.json.text, at: r.json.at, enabled: r.json.enabled }) : answer(r)
  },
  doctor: async () => ok(await api.doctor()),
})

export const createMcp = ({ api, version }) => {
  const tools = new Map(TOOLS.map(t => [t.name, t]))
  const run = runners(api)
  const serverInfo = { name: 'projium', title: 'Projium', version }
  const capabilities = { tools: { listChanged: false } }
  const result = (id, r) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...r } })
  const error = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

  const validId = id => typeof id === 'string' || Number.isInteger(id)

  const one = async msg => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, -32600, 'Invalid Request')
    if (!('method' in msg)) return null
    if (msg.jsonrpc !== '2.0') return error(validId(msg.id) ? msg.id : null, -32600, 'Invalid Request')
    if (!('id' in msg)) return null
    const { id, method } = msg
    if (!validId(id)) return error(null, -32600, 'Invalid Request: id must be a string or an integer')
    const params = msg.params ?? {}
    if (typeof method !== 'string' || typeof params !== 'object' || Array.isArray(params)) return error(id, -32600, 'Invalid Request')
    const asked = params._meta?.[VERSION_META]
    if (asked !== undefined && !SUPPORTED.includes(asked)) return error(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: asked })
    if (method === 'initialize') return result(id, { protocolVersion: LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0], capabilities, serverInfo, instructions: INSTRUCTIONS })
    if (method === 'server/discover') return result(id, { supportedVersions: SUPPORTED, capabilities, serverInfo, instructions: INSTRUCTIONS })
    if (method === 'ping') return result(id, {})
    if (method === 'tools/list') return result(id, { tools: TOOLS })
    if (method !== 'tools/call') return error(id, -32601, `Method not found: ${method}`)
    const tool = tools.get(params.name)
    if (!tool) return error(id, -32602, `Unknown tool: ${params.name}`)
    const args = params.arguments ?? {}
    const problem = mismatch(tool.inputSchema, args, 'arguments')
    if (problem) return result(id, fail(problem))
    try {
      return result(id, await run[tool.name](args))
    } catch (e) {
      return result(id, fail(String(e?.message ?? e)))
    }
  }

  return async msg => {
    if (!Array.isArray(msg)) return one(msg)
    if (!msg.length) return error(null, -32600, 'Invalid Request: empty batch')
    const replies = (await Promise.all(msg.map(one))).filter(Boolean)
    return replies.length ? replies : null
  }
}

const request = (port, method, p, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const headers = { host: `127.0.0.1:${port}`, ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false, timeout: timeoutMs }, res => {
      let s = ''
      res.setEncoding('utf8')
      res.on('data', c => (s += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(s) })
        } catch {
          resolve({ status: res.statusCode, json: null })
        }
      })
      res.on('close', () => {
        if (!res.complete) reject(new Error('Projium closed the connection before it answered in full; check the project before writing again'))
      })
    })
    req.on('timeout', () => req.destroy(new Error(`Projium did not answer within ${timeoutMs / 1000} s`)))
    req.on('error', reject)
    req.end(data)
  })

export const localApi = (here, { file } = {}) => {
  const config = () => loadConfig(here, file)
  return {
    url: () => `http://127.0.0.1:${config().port}`,
    call: async (method, p, body, timeoutMs = 30e3) => {
      const c = config()
      const url = `http://127.0.0.1:${c.port}`
      if (!c.port) throw new Error('Projium needs a fixed port in tracker.config.json for the MCP server')
      const on = await whoIsOn(c.port, c.projectsDir, 3000)
      if (!on.sameInstance) {
        if (!on.running) throw new Error(`Projium is not running at ${url}. Start it with npm run --silent start:bg in ${here}`)
        throw new Error(`port ${c.port} is used by ${on.projium ? 'a Projium for another projects folder' : 'another program'}; check port in tracker.config.json`)
      }
      return request(c.port, method, p, body, timeoutMs)
    },
    doctor: () => diagnose(here, { file }),
  }
}
