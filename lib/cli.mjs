import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { defaultConfigFile, runSetup, lineReader } from './setup.mjs'
import { startBackground, stopServer, openCommand } from './control.mjs'
import { diagnose } from './doctor.mjs'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version
const viaNpx = here.split(path.sep).includes('node_modules')
const me = viaNpx ? 'npx github:egorb2302/Projium' : 'node bin/projium.mjs'

const help = file => `Projium ${version}: a local dashboard over your Markdown project notes.

Usage: ${me} [command] [options]

  (no command)   start the dashboard and open it; runs setup first when there is no config yet
  setup          find your notes and repos, write the config, start the dashboard
  start          start the dashboard in the background and open it
  stop           stop it
  restart        stop and start it again, for example after a change on the Settings page
  doctor         check the setup (prints a JSON report)

Options:
  --notes <folder>   setup: the folder with your project notes
  --repos <folder>   setup: the folder where you clone project repos
  --port <number>    setup: the port (default 3210, or the next free one)
  --yes              setup: take every suggestion without asking
  --no-start         setup: write the config only
  --no-open          do not open the browser
  --config <file>    the config file (now: ${file})
`

const open = url => {
  const [cmd, args] = openCommand(url)
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
}

const start = async (file, { openIt, say }) => {
  const r = await startBackground(here, { file })
  if (!r.ok) {
    say(`Could not start: ${r.error}`)
    return 1
  }
  say(r.already ? `Projium already runs at ${r.url}${r.note ? ` (an older version; run ${me} restart)` : ''}` : `Projium runs at ${r.url}`)
  say(`Stop it with: ${me} stop`)
  if (openIt) open(r.url)
  return 0
}

export const run = async (argv, { input = process.stdin, output = process.stdout } = {}) => {
  const say = s => output.write(`${s}\n`)
  let v
  let positionals
  try {
    ;({ values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        notes: { type: 'string' },
        repos: { type: 'string' },
        port: { type: 'string' },
        config: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'no-start': { type: 'boolean', default: false },
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
    }))
  } catch (e) {
    say(`${e.message}\nRun ${me} --help`)
    return 1
  }
  const cwd = process.env.INIT_CWD || process.cwd()
  const file = v.config ? path.resolve(cwd, v.config) : defaultConfigFile(here)
  const cmd = positionals[0] ?? (fs.existsSync(file) ? 'start' : 'setup')
  if (v.version || v.help || cmd === 'help') {
    say(v.version ? version : help(file))
    return 0
  }
  if (positionals.length > 1 || !['setup', 'start', 'stop', 'restart', 'doctor'].includes(cmd)) {
    say(`Unknown command: ${positionals.join(' ')}\nRun ${me} --help`)
    return 1
  }
  const openIt = !v['no-open']
  try {
    if (cmd === 'doctor') {
      const report = await diagnose(here, { file })
      say(JSON.stringify(report, null, 2))
      return report.ok ? 0 : 1
    }
    if (cmd === 'stop' || cmd === 'restart') {
      const r = await stopServer(here, { file })
      if (!r.ok) {
        say(`Could not stop: ${r.error}`)
        return 1
      }
      say(r.stopped ? 'Stopped.' : 'It was not running.')
      if (cmd === 'stop') return 0
      return start(file, { openIt: false, say })
    }
    if (cmd === 'start') {
      if (!fs.existsSync(file)) {
        say(`No config at ${file} yet. Run ${me} setup`)
        return 1
      }
      return start(file, { openIt, say })
    }
    const port = v.port == null ? null : Number(v.port)
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('--port must be a number from 1 to 65535')
    const io = v.yes ? { yes: true, say, ask: q => (output.write(`${q}\n`), Promise.resolve('')) } : lineReader(input, output)
    let r
    try {
      r = await runSetup({ here, file, io, notes: v.notes ?? null, repos: v.repos ?? null, port, cwd })
    } finally {
      io.close?.()
    }
    if (r.kept) say('Kept the current config.')
    if (v['no-start']) {
      say(`\nStart it with: ${me} start`)
      return 0
    }
    say('')
    if (!r.kept) {
      const stopped = await stopServer(here, { file }).catch(() => null)
      if (stopped?.stopped) say('Stopped the dashboard that ran with the old settings.')
    }
    const code = await start(file, { openIt, say })
    if (!code) say('Change folders, the time zone, the digest or Launch Watch later on its Settings page (key 4).')
    return code
  } catch (e) {
    say(`${cmd === 'setup' ? 'Setup stopped' : 'Failed'}: ${e?.message ?? e}`)
    return 1
  }
}
