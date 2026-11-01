import os from 'node:os'
import path from 'node:path'
import { loadConfig, configPath, instanceId } from './config.mjs'

const PLATFORMS = ['darwin', 'linux', 'win32']

const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const PS_QUOTE = /['‘’‚‛]/g
const CONTROL = /[\x00-\x1f\x7f]/

const xml = s => String(s).replace(/[&<>"']/g, c => XML[c])
const sh = s => `'${s.replace(/'/g, "'\\''")}'`
const ps = s => `'${s.replace(PS_QUOTE, '$&$&')}'`
const spec = s => s.replace(/%/g, '%%')
const quoted = s => `"${spec(s).replace(/[\\"]/g, '\\$&')}"`
const execArg = s => quoted(s.replace(/\$/g, '$$$$'))

const STOP = 'npm run --silent stop stops the server for this session; the autostart entry starts it again at the next login. To remove the entry, run the disable commands.'

const STOP_FIRST = 'Enabling starts the server at once. Run npm run --silent stop first if a server is already running: a second one exits because the port is taken, and the crash-restart policy would keep retrying.'

const fail = (platform, error) => ({ ok: false, platform, error, kind: null, label: null, file: null, content: null, enable: [], disable: [], check: [], logs: null, notes: [] })

const envVars = x => [...(x.env.PATH ? [['PATH', x.env.PATH]] : []), ...(x.custom ? [['TRACKER_CONFIG', x.custom]] : [])]

const digestNote = x =>
  x.digestEnv.length
    ? [`digest.env and watch list ${x.digestEnv.join(', ')}: this entry sets only PATH${x.custom ? ' and TRACKER_CONFIG' : ''} and does not copy those values (they may be secrets). If the digest command or the watch RPC needs them, add them to the entry's environment, with the owner's yes.`]
    : []

const darwin = x => {
  const label = `io.projium.${x.id}`
  const file = path.join(x.home, 'Library', 'LaunchAgents', `${label}.plist`)
  const logs = { out: path.join(x.dataDir, 'server.out.log'), err: path.join(x.dataDir, 'server.err.log') }
  const vars = envVars(x)
  const environment = vars.length
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${vars.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')}\n  </dict>`
    : ''
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(x.node)}</string>
    <string>--no-warnings</string>
    <string>${xml(path.join(x.here, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(x.here)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logs.err)}</string>${environment}
</dict>
</plist>
`
  return {
    ok: true,
    platform: 'darwin',
    kind: 'launchd',
    label,
    file,
    content,
    enable: [`mkdir -p ${sh(x.dataDir)}`, `launchctl bootstrap gui/$(id -u) ${sh(file)}`],
    disable: [`launchctl bootout gui/$(id -u) ${sh(file)}`, `rm ${sh(file)}`],
    check: [`launchctl print gui/$(id -u)/${label}`],
    logs,
    notes: [
      STOP,
      STOP_FIRST,
      `Create ${path.dirname(file)} if it is missing. The plist pins node to ${x.node}; after switching or upgrading node, run this helper again and replace the entry (disable, write the file, enable).`,
      'launchctl bootstrap fails if the label is already loaded: to replace an entry, run disable first. The gui domain exists while the owner is logged in at the desktop (launchctl(1)); from a plain SSH session without one, bootstrap may fail, then ask the owner to run it in Terminal.',
      'launchd restarts the server only after a crash (non-zero exit), not after a clean stop.',
      ...digestNote(x),
    ],
  }
}

const linux = x => {
  const label = `projium-${x.id}.service`
  const config = x.env.XDG_CONFIG_HOME && path.isAbsolute(x.env.XDG_CONFIG_HOME) ? x.env.XDG_CONFIG_HOME : path.join(x.home, '.config')
  const file = path.join(config, 'systemd', 'user', label)
  const logs = { out: path.join(x.dataDir, 'server.out.log'), err: path.join(x.dataDir, 'server.err.log') }
  const content = `${[
    '[Unit]',
    'Description=Projium dashboard server',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${spec(x.here)}`,
    `ExecStart=${execArg(x.node)} --no-warnings ${execArg(path.join(x.here, 'server.mjs'))}`,
    'Restart=on-failure',
    ...envVars(x).map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`),
    `StandardOutput=append:${spec(logs.out)}`,
    `StandardError=append:${spec(logs.err)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n')}\n`
  return {
    ok: true,
    platform: 'linux',
    kind: 'systemd',
    label,
    file,
    content,
    enable: [`mkdir -p ${sh(x.dataDir)}`, 'systemctl --user daemon-reload', `systemctl --user enable --now ${label}`],
    disable: [`systemctl --user disable --now ${label}`, `rm ${sh(file)}`, 'systemctl --user daemon-reload'],
    check: [`systemctl --user status ${label}`],
    logs,
    notes: [
      STOP,
      STOP_FIRST,
      `Create ${path.dirname(file)} if it is missing. The unit pins node to ${x.node}; after switching or upgrading node, run this helper again and rewrite the unit.`,
      `After rewriting the unit of a running service: systemctl --user daemon-reload, then systemctl --user restart ${label}.`,
      'A user service runs only while the owner has a login session. loginctl enable-linger $USER keeps it running without one (and starts it at boot); run that only if the owner says yes.',
      'systemd restarts the server only after a crash (Restart=on-failure), not after a clean stop. StandardOutput=append: needs systemd 240 or newer.',
      ...digestNote(x),
    ],
  }
}

const win32 = x => {
  if (x.custom) return fail('win32', `autostart.vbs starts the server with the default config ${path.win32.join(x.here, 'tracker.config.json')} and cannot pass TRACKER_CONFIG; this setup uses ${x.custom}. Move the settings into the default config file, or start the server another way`)
  const w = path.win32
  const appData = x.env.APPDATA || w.join(x.home, 'AppData', 'Roaming')
  const label = `Projium ${x.id}`
  const file = w.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${label}.lnk`)
  const dir = w.normalize(x.here)
  const vbs = w.join(dir, 'autostart.vbs')
  return {
    ok: true,
    platform: 'win32',
    kind: 'startup-shortcut',
    label,
    file,
    content: null,
    enable: [`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(file)}); $s.TargetPath = 'wscript.exe'; $s.Arguments = ${ps(`"${vbs}"`)}; $s.WorkingDirectory = ${ps(dir)}; $s.Save()`],
    disable: [`Remove-Item -LiteralPath ${ps(file)}`],
    check: [`Test-Path -LiteralPath ${ps(file)}`],
    logs: { out: w.join(dir, 'data', 'out.log'), err: w.join(dir, 'data', 'err.log') },
    notes: [
      STOP,
      'Run each command in Windows PowerShell. The shortcut runs autostart.vbs hidden at login; autostart.vbs starts node from PATH with the default config and logs to data\\out.log and data\\err.log.',
    ],
  }
}

export const autostartPlan = (here, opts = {}) => {
  const platform = opts.platform ?? process.platform
  if (!PLATFORMS.includes(platform)) return fail(platform, `autostart supports ${PLATFORMS.join(', ')}; got ${platform}`)
  const file = opts.file ?? configPath(here)
  const c = loadConfig(here, file)
  const x = {
    here,
    home: opts.home ?? os.homedir(),
    node: opts.node ?? process.execPath,
    env: opts.env ?? process.env,
    id: instanceId(c.projectsDir),
    custom: path.relative(path.resolve(file), path.resolve(here, 'tracker.config.json')) === '' ? null : path.resolve(file),
    dataDir: path.dirname(c.dbFile),
    digestEnv: [...c.digest.env, ...(c.watch?.env ?? [])],
  }
  if ([x.here, x.home, x.node, x.dataDir, x.custom ?? '', x.env.PATH ?? '', x.env.APPDATA ?? '', x.env.XDG_CONFIG_HOME ?? ''].some(v => CONTROL.test(v)))
    return fail(platform, 'a path or PATH contains a control character (such as a line break); autostart entries cannot hold it safely')
  const plan = { darwin, linux, win32 }[platform](x)
  if (plan.ok && platform !== process.platform) plan.notes.unshift(`Preview for ${platform}, computed on ${process.platform}: paths come from this machine and are not valid there. Run the helper on the target machine before applying anything.`)
  return plan
}
