import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { autostartPlan } from '../lib/autostart.mjs'
import { instanceId } from '../lib/config.mjs'

const PLATFORMS = ['darwin', 'linux', 'win32']
const NAME = "projium test & 'q' %h $HOME"

const twice = (s, ch) => s.split(ch).join(ch + ch)
const shq = s => `"${s.replace(/[\\"$`]/g, '\\$&')}"`
const unit = s => `"${twice(s, '%').replace(/[\\"]/g, '\\$&')}"`
const unxml = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n])

const setup = (t, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-autostart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const here = path.join(dir, NAME)
  const projects = path.join(dir, 'vault')
  fs.mkdirSync(here, { recursive: true })
  fs.mkdirSync(projects)
  const file = path.join(here, 'tracker.config.json')
  fs.writeFileSync(file, JSON.stringify({ projectsDir: projects, ...extra }))
  const env = { PATH: '/opt/homebrew/bin:/usr/bin:/tools & more', APPDATA: path.join(dir, "Roaming 'x' \u2019y") }
  const base = { file, home: path.join(dir, 'home'), node: path.join(dir, 'node bin', 'node'), env }
  return { dir, here, projects, file, base, id: instanceId(projects) }
}

test('darwin: a launchd agent with escaped XML, a crash-only restart and logs in the data dir', t => {
  const { here, base, id } = setup(t)
  const plan = autostartPlan(here, { ...base, platform: 'darwin' })
  assert.equal(plan.ok, true)
  assert.equal(plan.platform, 'darwin')
  assert.equal(plan.kind, 'launchd')
  assert.equal(plan.label, `io.projium.${id}`)
  assert.equal(plan.file, path.join(base.home, 'Library', 'LaunchAgents', `io.projium.${id}.plist`))
  const strings = [...plan.content.matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1])
  for (const s of strings) assert.doesNotMatch(s, /<|&(?!(amp|lt|gt|quot|apos);)/, `raw XML characters in ${s}`)
  assert.ok(plan.content.includes('&amp;') && plan.content.includes('&apos;'))
  const values = strings.map(unxml)
  const logs = { out: path.join(here, 'data', 'server.out.log'), err: path.join(here, 'data', 'server.err.log') }
  assert.deepEqual(plan.logs, logs)
  for (const v of [plan.label, base.node, '--no-warnings', path.join(here, 'server.mjs'), here, logs.out, logs.err, base.env.PATH]) assert.ok(values.includes(v), `missing ${v}`)
  assert.match(plan.content, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plan.content, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
  assert.match(plan.content, /<key>StandardOutPath<\/key>\s*<string>[^<]*server\.out\.log<\/string>/)
  assert.doesNotMatch(plan.content, /TRACKER_CONFIG/)
  assert.ok(plan.enable.includes(`launchctl bootstrap gui/$(id -u) ${shq(plan.file)}`))
  assert.ok(plan.enable.includes(`mkdir -p ${shq(path.join(here, 'data'))}`))
  assert.deepEqual(plan.disable, [`launchctl bootout gui/$(id -u) ${shq(plan.file)}`, `rm ${shq(plan.file)}`])
  assert.deepEqual(plan.check, [`launchctl print gui/$(id -u)/io.projium.${id}`])
  assert.ok(plan.notes.some(n => n.includes('npm run --silent stop') && n.includes('next login')))
  assert.ok(plan.notes.some(n => n.includes('npm run --silent stop first')))
  const noPath = autostartPlan(here, { ...base, platform: 'darwin', env: {} })
  assert.doesNotMatch(noPath.content, /EnvironmentVariables/)
})

test('linux: a systemd user unit with quoted ExecStart, systemd-quoted Environment and append: logs', t => {
  const { here, base, id } = setup(t)
  const plan = autostartPlan(here, { ...base, platform: 'linux' })
  const name = `projium-${id}.service`
  assert.equal(plan.ok, true)
  assert.equal(plan.kind, 'systemd')
  assert.equal(plan.label, name)
  assert.equal(plan.file, path.join(base.home, '.config', 'systemd', 'user', name))
  const lines = plan.content.split('\n')
  const server = path.join(here, 'server.mjs')
  assert.ok(lines.includes('[Unit]') && lines.includes('After=network-online.target'))
  assert.ok(lines.includes('Type=simple') && lines.includes('Restart=on-failure'))
  assert.ok(lines.includes(`WorkingDirectory=${twice(here, '%')}`), 'a percent sign in a path is doubled')
  assert.ok(lines.includes(`ExecStart=${unit(base.node)} --no-warnings ${unit(twice(server, '$'))}`), 'paths are quoted, % and $ doubled')
  assert.ok(lines.includes(`Environment=${unit(`PATH=${base.env.PATH}`)}`))
  assert.ok(lines.includes(`StandardOutput=append:${twice(path.join(here, 'data', 'server.out.log'), '%')}`))
  assert.ok(lines.includes(`StandardError=append:${twice(path.join(here, 'data', 'server.err.log'), '%')}`))
  assert.ok(lines.includes('WantedBy=default.target'))
  assert.doesNotMatch(plan.content, /TRACKER_CONFIG/)
  assert.ok(plan.enable.includes('systemctl --user daemon-reload') && plan.enable.includes(`systemctl --user enable --now ${name}`))
  assert.deepEqual(plan.disable, [`systemctl --user disable --now ${name}`, `rm ${shq(plan.file)}`, 'systemctl --user daemon-reload'])
  assert.deepEqual(plan.check, [`systemctl --user status ${name}`])
  assert.ok(plan.notes.some(n => n.includes('loginctl enable-linger $USER')))
  assert.ok(plan.notes.some(n => n.includes('npm run --silent stop first')))
  assert.ok(plan.notes.some(n => n.includes('npm run --silent stop') && n.includes('next login')))
  const odd = autostartPlan(here, { ...base, platform: 'linux', node: '/opt/my "node"\\bin/node', env: { PATH: '/a b:"c"\\d' } })
  assert.ok(odd.content.includes('ExecStart="/opt/my \\"node\\"\\\\bin/node" --no-warnings'))
  assert.ok(odd.content.includes('Environment="PATH=/a b:\\"c\\"\\\\d"'))
  const xdg = path.join(base.home, 'cfg')
  assert.equal(autostartPlan(here, { ...base, platform: 'linux', env: { XDG_CONFIG_HOME: xdg } }).file, path.join(xdg, 'systemd', 'user', name))
  assert.equal(autostartPlan(here, { ...base, platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' } }).file, plan.file)
})

test('win32: a Startup shortcut created by one PowerShell command with doubled single quotes', t => {
  const { here, base, id } = setup(t)
  const plan = autostartPlan(here, { ...base, platform: 'win32' })
  const w = path.win32
  const file = w.join(base.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `Projium ${id}.lnk`)
  const q = s => s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')
  assert.equal(plan.ok, true)
  assert.equal(plan.kind, 'startup-shortcut')
  assert.equal(plan.file, file)
  assert.equal(plan.content, null)
  assert.ok(file.includes("'") && file.includes('\u2019') && here.includes("'"))
  assert.equal(plan.enable.length, 1)
  const cmd = plan.enable[0]
  assert.ok(cmd.includes(`CreateShortcut('${q(file)}')`))
  assert.ok(cmd.includes("$s.TargetPath = 'wscript.exe'"))
  assert.ok(cmd.includes(`$s.Arguments = '"${q(w.join(w.normalize(here), 'autostart.vbs'))}"'`))
  assert.ok(cmd.includes(`$s.WorkingDirectory = '${q(w.normalize(here))}'`))
  assert.ok(cmd.endsWith('$s.Save()'))
  assert.deepEqual(plan.disable, [`Remove-Item -LiteralPath '${q(file)}'`])
  assert.deepEqual(plan.check, [`Test-Path -LiteralPath '${q(file)}'`])
  assert.deepEqual(plan.logs, { out: w.join(w.normalize(here), 'data', 'out.log'), err: w.join(w.normalize(here), 'data', 'err.log') })
  assert.ok(plan.notes.some(n => n.includes('npm run --silent stop') && n.includes('next login')))
  assert.ok(plan.notes.some(n => n.includes('data\\out.log')))
})

test('an unknown platform gives ok false and nothing to run', t => {
  const { here, base } = setup(t)
  const plan = autostartPlan(here, { ...base, platform: 'plan9' })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /plan9/)
  assert.equal(plan.file, null)
  assert.deepEqual([plan.enable, plan.disable, plan.check], [[], [], []])
})

test('two projects folders never share a label or an entry file', t => {
  const a = setup(t)
  const b = setup(t)
  assert.notEqual(a.id, b.id)
  for (const platform of PLATFORMS) {
    const pa = autostartPlan(a.here, { ...a.base, platform })
    const pb = autostartPlan(b.here, { ...b.base, platform, home: a.base.home, env: a.base.env })
    assert.ok(pa.label.includes(a.id) && pb.label.includes(b.id), platform)
    assert.notEqual(pa.label, pb.label, platform)
    assert.notEqual(pa.file, pb.file, platform)
  }
})

test('a config file outside the default place is passed as TRACKER_CONFIG on darwin and linux and refused on win32', t => {
  const { dir, here, projects, base } = setup(t)
  const other = path.join(dir, "other & 'cfg'.json")
  fs.writeFileSync(other, JSON.stringify({ projectsDir: projects }))
  const opts = { ...base, file: other }
  const mac = autostartPlan(here, { ...opts, platform: 'darwin' })
  assert.ok([...mac.content.matchAll(/<string>(.*?)<\/string>/g)].map(m => unxml(m[1])).includes(other))
  assert.match(mac.content, /<key>TRACKER_CONFIG<\/key>/)
  const lin = autostartPlan(here, { ...opts, platform: 'linux' })
  assert.ok(lin.content.split('\n').includes(`Environment=${unit(`TRACKER_CONFIG=${other}`)}`))
  const win = autostartPlan(here, { ...opts, platform: 'win32' })
  assert.equal(win.ok, false)
  assert.match(win.error, /TRACKER_CONFIG/)
  assert.deepEqual(win.enable, [])
  assert.equal(mac.label, autostartPlan(here, { ...base, platform: 'darwin' }).label, 'the same projects folder keeps one label whatever the config file')
  const sameFile = autostartPlan(here, { ...base, file: path.join(here, '.', 'tracker.config.json'), platform: 'linux' })
  assert.doesNotMatch(sameFile.content, /TRACKER_CONFIG/)
})

test('digest.env names are reported, not copied', t => {
  const { here, base } = setup(t, { digest: { command: ['send.mjs'], env: ['MY_DIGEST_KEY'] } })
  for (const platform of ['darwin', 'linux']) {
    const plan = autostartPlan(here, { ...base, platform })
    assert.ok(plan.notes.some(n => n.includes('MY_DIGEST_KEY')), platform)
    assert.ok(!plan.content.includes('MY_DIGEST_KEY'), platform)
  }
})

test('the script prints the plan as JSON, exits 1 for a bad platform and writes nothing', t => {
  const { dir, file } = setup(t)
  const script = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'scripts', 'autostart.mjs')
  const before = fs.readdirSync(dir).sort()
  const run = platform => spawnSync(process.execPath, ['--no-warnings', script, `--platform=${platform}`], { encoding: 'utf8', env: { ...process.env, TRACKER_CONFIG: file } })
  const ok = run('linux')
  assert.equal(ok.status, 0, ok.stderr)
  const plan = JSON.parse(ok.stdout)
  assert.equal(plan.ok, true)
  assert.equal(plan.kind, 'systemd')
  assert.match(plan.content, /^ExecStart=/m)
  assert.ok(ok.stdout.startsWith('{\n  "ok": true'), 'two-space indent')
  const bad = run('plan9')
  assert.equal(bad.status, 1)
  assert.equal(JSON.parse(bad.stdout).ok, false)
  assert.deepEqual(fs.readdirSync(dir).sort(), before)
})
