import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createMcp, TOOLS, LEGACY, MODERN } from '../lib/mcp.mjs'
import { createApp } from '../server.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const fakeApi = responses => {
  const calls = []
  return {
    calls,
    url: 'http://127.0.0.1:1',
    call: async (method, p, body) => {
      calls.push({ method, p, body })
      return responses[`${method} ${p}`] ?? { status: 404, json: { error: 'not found' } }
    },
    doctor: async () => ({ ok: true }),
  }
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })

test('the MCP server speaks both the initialize era and the 2026-07-28 stateless era', async () => {
  const mcp = createMcp({ api: fakeApi({}), version: '9.9.9' })
  const init = await mcp(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  assert.equal(init.result.serverInfo.version, '9.9.9')
  assert.ok(init.result.instructions.includes('fileId'))
  assert.equal((await mcp(rpc(2, 'initialize', { protocolVersion: '2031-01-01' }))).result.protocolVersion, LEGACY[0], 'an unknown version gets the newest initialize-era one')
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const meta = v => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v } })
  const discover = await mcp(rpc(3, 'server/discover', meta(MODERN)))
  assert.ok(discover.result.supportedVersions.includes(MODERN))
  assert.equal(discover.result.resultType, 'complete')
  const bad = await mcp(rpc(4, 'tools/list', meta('1999-01-01')))
  assert.equal(bad.error.code, -32022)
  assert.equal(bad.error.data.requested, '1999-01-01')
  assert.equal((await mcp(rpc(5, 'resources/list'))).error.code, -32601)
  assert.equal((await mcp(rpc(6, 'tools/call', { name: 'nope', arguments: {} }))).error.code, -32602)
  assert.equal((await mcp([rpc(7, 'ping')])).error.code, -32600)
  assert.deepEqual((await mcp(rpc(8, 'ping'))).result, { resultType: 'complete' })
  const list = await mcp(rpc(9, 'tools/list', meta(MODERN)))
  assert.deepEqual(list.result.tools.map(t => t.name), TOOLS.map(t => t.name))
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object', t.name)
})

test('tool arguments are checked before any call, and a conflict comes back as a tool error with the current value', async () => {
  const api = fakeApi({ 'POST /api/projects/Clients%2FAcme/field': { status: 409, json: { error: 'next_step was changed outside the dashboard', current: 'call Bob' } } })
  const mcp = createMcp({ api, version: '1' })
  const call = async (name, args) => (await mcp(rpc(1, 'tools/call', { name, arguments: args }))).result
  assert.match((await call('set_field', { name: 'x', key: 'next_step', value: 'v', expected: '' })).content[0].text, /fileId is required/)
  assert.match((await call('set_field', { name: 'x', key: 'secret', value: 'v', expected: '', fileId: 'f' })).content[0].text, /key must be one of/)
  assert.match((await call('toggle_task', { name: 'x', id: 't-12', expected: { done: false, text: 'a', due: '', p: '' }, fileId: 'f' })).content[0].text, /wrong format/)
  assert.match((await call('add_task', { name: 'x', text: 'a', fileId: 'f', extra: 1 })).content[0].text, /not a known argument/)
  assert.match((await call('edit_task', { name: 'x', id: 't-1234', expected: { done: false, text: 'a', due: '', p: '' }, fileId: 'f' })).content[0].text, /at least one of text, due or p/)
  assert.equal(api.calls.length, 0)
  const conflict = await call('set_field', { name: 'Clients/Acme', key: 'next_step', value: 'ship', expected: 'call', fileId: 'f' })
  assert.equal(conflict.isError, true)
  assert.deepEqual(conflict.structuredContent, { conflict: true, error: 'next_step was changed outside the dashboard', current: 'call Bob' })
  assert.deepEqual(api.calls, [{ method: 'POST', p: '/api/projects/Clients%2FAcme/field', body: { key: 'next_step', value: 'ship', expected: 'call', fileId: 'f' } }])
})

const CARD = '---\nstage: fixes\nnext_step: call the client\nsite: https://example.com\n---\n\n# Alpha\n\n## Tasks\n\n- [ ] Write the brief · due 2026-11-02 · p1 ^t-aaaa\n'

const lines = child => {
  const rl = readline.createInterface({ input: child.stdout })
  const waiting = new Map()
  rl.on('line', l => {
    const msg = JSON.parse(l)
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  })
  let id = 0
  return (method, params) =>
    new Promise(resolve => {
      id++
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify(rpc(id, method, params))}\n`)
    })
}

test('an agent reads and writes a project through the MCP server over stdio', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mcp-'))
  const projects = path.join(dir, 'projects')
  fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true })
  const card = path.join(projects, 'alpha', 'alpha.md')
  fs.writeFileSync(card, CARD)
  let app = createApp({ projectsRoot: projects, reposRoot: dir, dbFile: path.join(dir, 'data', 't.db'), port: 0, checkHealth: false, transcriptsRoot: path.join(dir, 't') })
  const port = await app.start()
  const config = path.join(dir, 'tracker.config.json')
  fs.writeFileSync(config, JSON.stringify({ projectsDir: projects, reposDir: dir, transcriptsDir: path.join(dir, 't'), port }))
  const child = spawn(process.execPath, ['--no-warnings', path.join(repoRoot, 'scripts', 'mcp.mjs')], { env: { ...process.env, TRACKER_CONFIG: config, PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(async () => {
    child.kill()
    await app?.stop().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const send = lines(child)
  const call = async (name, args) => (await send('tools/call', { name, arguments: args })).result

  assert.equal((await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.protocolVersion, '2025-11-25')
  const listed = await call('list_projects', {})
  assert.deepEqual(listed.structuredContent.projects.map(p => [p.name, p.stage, p.open_tasks, p.next_due]), [['alpha', 'fixes', 1, '2026-11-02']])
  const got = (await call('get_project', { name: 'alpha' })).structuredContent
  assert.equal(got.fields.next_step, 'call the client')
  assert.equal(got.health.history, undefined)

  const set = await call('set_field', { name: 'alpha', key: 'next_step', value: 'send the brief', expected: 'call the client', fileId: got.fileId })
  assert.equal(set.isError, undefined)
  assert.match(fs.readFileSync(card, 'utf8'), /^next_step: send the brief$/m)
  const stale = await call('set_field', { name: 'alpha', key: 'next_step', value: 'other', expected: 'call the client', fileId: got.fileId })
  assert.equal(stale.structuredContent.current, 'send the brief')

  const added = (await call('add_task', { name: 'alpha', text: 'Book the call', p: 'p2', fileId: got.fileId })).structuredContent
  const task = added.tasks.find(x => x.text === 'Book the call')
  assert.match(task.id, /^t-[a-z0-9]{4}$/)
  const toggled = (await call('toggle_task', { name: 'alpha', id: 't-aaaa', expected: { done: false, text: 'Write the brief', due: '2026-11-02', p: 'p1' }, fileId: got.fileId })).structuredContent
  assert.equal(toggled.tasks.find(x => x.id === 't-aaaa').done, true)
  await call('edit_task', { name: 'alpha', id: task.id, expected: { done: false, text: 'Book the call', due: '', p: 'p2' }, due: '2026-11-05', fileId: got.fileId })
  assert.match(fs.readFileSync(card, 'utf8'), new RegExp(`^- \\[ \\] Book the call · due 2026-11-05 · p2 \\^${task.id}$`, 'm'))
  assert.match((await call('digest_preview', {})).structuredContent.text, /alpha/)

  await app.stop()
  app = null
  const down = await call('list_projects', {})
  assert.equal(down.isError, true)
  assert.match(down.content[0].text, /not running/)
})
