import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createMcp, localApi, TOOLS, SUPPORTED } from '../lib/mcp.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
const api = localApi(here)
const handle = createMcp({ api, version })

const registration = () => {
  const script = path.join(here, 'scripts', 'mcp.mjs')
  const args = ['--no-warnings', script]
  const env = Object.fromEntries(['TRACKER_CONFIG', 'PORT'].filter(k => process.env[k]).map(k => [k, k === 'TRACKER_CONFIG' ? path.resolve(process.env[k]) : process.env[k]]))
  const q = s => `"${s}"`
  const flags = Object.entries(env).map(([k, v]) => `--env ${q(`${k}=${v}`)} `).join('')
  const toml = s => JSON.stringify(s)
  return {
    claudeCode: `claude mcp add ${flags}--transport stdio --scope user projium -- ${q(process.execPath)} --no-warnings ${q(script)}`,
    codex: `codex mcp add ${flags}projium -- ${q(process.execPath)} --no-warnings ${q(script)}`,
    codexToml: [
      '[mcp_servers.projium]',
      `command = ${toml(process.execPath)}`,
      `args = [${args.map(toml).join(', ')}]`,
      ...(Object.keys(env).length ? [`env = { ${Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`] : []),
    ].join('\n'),
    json: { mcpServers: { projium: { type: 'stdio', command: process.execPath, args, ...(Object.keys(env).length ? { env } : {}) } } },
  }
}

if (process.argv.includes('--check')) {
  let report
  try {
    const r = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })).result
    report = {
      ok: !r.isError,
      url: api.url(),
      protocolVersions: SUPPORTED,
      tools: TOOLS.map(t => t.name),
      ...(r.isError ? { error: r.content[0].text } : { projects: r.structuredContent.projects.length }),
      register: registration(),
    }
  } catch (e) {
    report = { ok: false, error: String(e?.message ?? e) }
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
