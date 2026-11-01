import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, configPath, formatOffset, parseOffset, expandHome } from './config.mjs'

export const USAGE = 'npm run --silent init -- --projects <folder> --repos <folder> [--transcripts <folder>] [--offset=+03:00 (keep the = form; required for negative offsets like --offset=-05:00)] [--readiness READINESS.md] [--lang en|ru] [--port 3210] [--ignore word1,word2] [--layout folder|flat] [--recursive] [--filter key=value]... [--field stage=status]... [--stage "in progress=development"]... [--tasks-heading Todo] [--name file|folder|title] [--repo "Project=repo-folder"]... [--field-off site]... [--force]'

const slash = p => p.replace(/\\/g, '/')

const folder = (value, flag, base) => {
  const p = path.resolve(base, expandHome(value))
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`${flag} folder not found: ${p}`)
  return p
}

export const writeConfig = (here, argv, base = process.env.INIT_CWD || process.cwd()) => {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      projects: { type: 'string' },
      repos: { type: 'string' },
      transcripts: { type: 'string' },
      offset: { type: 'string' },
      readiness: { type: 'string' },
      lang: { type: 'string' },
      port: { type: 'string' },
      ignore: { type: 'string' },
      config: { type: 'string' },
      force: { type: 'boolean', default: false },
      layout: { type: 'string' },
      recursive: { type: 'boolean', default: false },
      filter: { type: 'string', multiple: true },
      field: { type: 'string', multiple: true },
      stage: { type: 'string', multiple: true },
      'tasks-heading': { type: 'string' },
      repo: { type: 'string', multiple: true },
      'field-off': { type: 'string', multiple: true },
      name: { type: 'string' },
    },
    strict: true,
  })
  const pairs = (list, flag) =>
    (list ?? []).map(s => {
      const at = s.lastIndexOf('=')
      if (at <= 0 || at === s.length - 1) throw new Error(`${flag} takes key=value, got ${s}`)
      return [s.slice(0, at).trim(), s.slice(at + 1).trim()]
    })
  const filter = {}
  for (const [k, val] of pairs(v.filter, '--filter')) filter[k] = k in filter ? [].concat(filter[k], val) : val
  const cards = {
    ...(v.layout ? { layout: v.layout } : {}),
    ...(v.recursive ? { recursive: true } : {}),
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(v.field?.length || v['field-off']?.length ? { fields: { ...Object.fromEntries(pairs(v.field, '--field')), ...Object.fromEntries((v['field-off'] ?? []).map(k => [k.trim(), null])) } } : {}),
    ...(v.stage?.length ? { stages: Object.fromEntries(pairs(v.stage, '--stage')) } : {}),
    ...(v['tasks-heading'] ? { sections: { tasks: v['tasks-heading'] } } : {}),
    ...(v.repo?.length ? { repos: Object.fromEntries(pairs(v.repo, '--repo')) } : {}),
    ...(v.name ? { name: v.name } : {}),
  }
  if (!v.projects || !v.repos) throw new Error(`--projects and --repos are required. Usage: ${USAGE}`)
  const file = path.resolve(base, v.config ?? configPath(here))
  if (fs.existsSync(file) && !v.force)
    throw new Error(`${file} already exists. Run npm run --silent doctor to check it, and edit it by hand; --force replaces it with only the flags given here (the old file is kept as ${path.basename(file)}.bak-<time>)`)
  const port = v.port == null ? 3210 : Number(v.port)
  if (!/^\d+$/.test(v.port ?? '3210') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a number from 1 to 65535, got ${v.port}`)
  const config = {
    ...(path.dirname(file) === path.resolve(here) ? { $schema: './tracker.config.schema.json' } : {}),
    projectsDir: slash(folder(v.projects, '--projects', base)),
    reposDir: slash(folder(v.repos, '--repos', base)),
    ...(v.transcripts ? { transcriptsDir: slash(folder(v.transcripts, '--transcripts', base)) } : {}),
    port,
    utcOffset: formatOffset(parseOffset(v.offset ?? 'local')),
    readinessFile: v.readiness ?? 'READINESS.md',
    ignore: v.ignore ? v.ignore.split(',').map(s => s.trim()).filter(Boolean) : [],
    digest: { at: '10:00', lang: v.lang ?? 'en' },
    ...(Object.keys(cards).length ? { cards } : {}),
  }
  return { written: file, backup: saveConfig(here, file, config), config }
}

export const KEEP_BACKUPS = 10
const STAMPED = /\.bak-\d{8}T\d{6}(-\d+)?$/

export const saveConfig = (here, file, config, { keep = KEEP_BACKUPS } = {}) => {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  let backup = null
  try {
    loadConfig(here, tmp)
    if (fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
      backup = `${file}.bak-${stamp}`
      for (let n = 2; fs.existsSync(backup); n++) backup = `${file}.bak-${stamp}-${n}`
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
    }
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  const base = path.basename(file)
  const order = n => n.replace(STAMPED, (_, s = '') => `${n.match(/\.bak-(\d{8}T\d{6})/)[1]}-${(s.slice(1) || '1').padStart(6, '0')}`)
  const old = fs.readdirSync(path.dirname(file))
    .filter(n => n.startsWith(`${base}.bak-`) && STAMPED.test(n))
    .sort((a, b) => order(b).localeCompare(order(a)))
  for (const n of old.slice(keep)) fs.rmSync(path.join(path.dirname(file), n), { force: true })
  return backup
}
