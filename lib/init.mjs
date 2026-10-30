import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, configPath, formatOffset, parseOffset } from './config.mjs'

export const USAGE = 'npm run init -- --projects <folder> --repos <folder> [--transcripts <folder>] [--offset=+03:00 (use the = form, it is required for negative offsets like --offset=-05:00)] [--readiness READINESS.md] [--lang en|ru] [--port 3210] [--ignore word1,word2] [--force]'

const slash = p => p.replace(/\\/g, '/')

export const writeConfig = (here, argv) => {
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
  const file = path.resolve(v.config ?? configPath(here))
  if (fs.existsSync(file) && !v.force) throw new Error(`${file} already exists; pass --force to replace it`)
  const projectsDir = path.resolve(v.projects)
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) throw new Error(`projects folder not found: ${projectsDir}`)
  const config = {
    ...(path.dirname(file) === path.resolve(here) ? { $schema: './tracker.config.schema.json' } : {}),
    projectsDir: slash(projectsDir),
    reposDir: slash(path.resolve(v.repos)),
    ...(v.transcripts ? { transcriptsDir: slash(path.resolve(v.transcripts)) } : {}),
    port: v.port == null ? 3210 : Number(v.port),
    utcOffset: formatOffset(parseOffset(v.offset ?? 'local')),
    readinessFile: v.readiness ?? 'READINESS.md',
    ignore: v.ignore ? v.ignore.split(',').map(s => s.trim()).filter(Boolean) : [],
    digest: { at: '10:00', lang: v.lang ?? 'en' },
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  try {
    loadConfig(here, tmp)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return { written: file, config }
}
