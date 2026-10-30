import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, configPath, formatOffset, parseOffset, expandHome } from './config.mjs'

export const USAGE = 'npm run --silent init -- --projects <folder> --repos <folder> [--transcripts <folder>] [--offset=+03:00 (keep the = form; required for negative offsets like --offset=-05:00)] [--readiness READINESS.md] [--lang en|ru] [--port 3210] [--ignore word1,word2] [--force]'

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
    },
    strict: true,
  })
  if (!v.projects || !v.repos) throw new Error(`--projects and --repos are required. Usage: ${USAGE}`)
  const file = path.resolve(base, v.config ?? configPath(here))
  if (fs.existsSync(file) && !v.force)
    throw new Error(`${file} already exists. Run npm run --silent doctor to check it, and edit it by hand; --force replaces it with only the flags given here (the old file is kept as ${path.basename(file)}.bak)`)
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
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  let backup = null
  try {
    loadConfig(here, tmp)
    if (fs.existsSync(file)) {
      backup = `${file}.bak`
      fs.copyFileSync(file, backup)
    }
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return { written: file, backup, config }
}
