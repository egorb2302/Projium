import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createMcp, localApi, TOOLS, SUPPORTED } from '../lib/mcp.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
const api = localApi(here)
const handle = createMcp({ api, version })

if (process.argv.includes('--check')) {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })
  const res = r.result
  const report = {
    ok: !res.isError,
    url: api.url,
    protocolVersions: SUPPORTED,
    tools: TOOLS.map(t => t.name),
    ...(res.isError ? { error: res.content[0].text } : { projects: res.structuredContent.projects.length }),
    register: {
      claudeCode: `claude mcp add --transport stdio --scope user projium -- "${process.execPath}" --no-warnings "${path.join(here, 'scripts', 'mcp.mjs')}"`,
      json: { mcpServers: { projium: { type: 'stdio', command: process.execPath, args: ['--no-warnings', path.join(here, 'scripts', 'mcp.mjs')] } } },
    },
  }
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
} else {
  const write = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const pending = new Set()
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line.replace(/^﻿/, ''))
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const job = handle(msg)
      .then(reply => reply && write(reply))
      .catch(e => {
        console.error('projium mcp:', String(e?.message ?? e))
        if (msg && typeof msg === 'object' && 'id' in msg) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } })
      })
      .finally(() => pending.delete(job))
    pending.add(job)
  })
  rl.on('close', () => Promise.allSettled([...pending]))
}
