import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFields } from './card.mjs'
import { expandHome } from './config.mjs'

const run = promisify(execFile)
const none = () => false

const repoField = cardText => {
  const field = readFields(cardText).repo
  return typeof field === 'string' && field.trim() ? field.trim() : null
}

export const noRepo = (cardText, hint = null) => (repoField(cardText) ?? hint)?.toLowerCase() === 'none'

const fieldPath = (reposRoot, field) => path.resolve(reposRoot, expandHome(field))

const REPO_LINE = /(?:\bRepo\b|Код ребилда)[^`\n]{0,512}`((?:[A-Za-z]:[\\/]|\/|~[\\/])[^`\n]{1,512})`/
const BARE = /^(?:[A-Za-z]:[\\/]?|[\\/]+|~[\\/]?)$/

const START = String.raw`(?:[A-Za-z]:[\\/]|\/|~[\\/])`
const PATH = `(${START}[^\\s\`'"<>|,;)\\]]+)`
const LINE_PATH = new RegExp(String.raw`^[ \t>*-]*(?:\*\*)?(?:repo|repository|code|git)(?:\*\*)?[ \t]*[:：](?:\*\*)?[ \t]*(?:\*\*)?["'“]?(` + START + String.raw`[^\s` + '`' + String.raw`<>|][^\r\n` + '`' + String.raw`<>|]{0,511})`, 'gim')
const PROSE_PATH = new RegExp(String.raw`\b(?:repo|repository|code)[ \t]+(?:is[ \t]+)?(?:in|at|lives in)[ \t]+` + PATH, 'gi')
const NAME_LINE = /^[ \t>*-]*(?:\*\*)?(?:repo|repository)(?:\*\*)?[ \t]*[:：](?:\*\*)?[ \t]*`?([A-Za-z0-9][\w.-]*)`?[ \t]*$/gim

const TRAILING = new Set([' ', '\t', '"', "'", '”', '*', '.', ':', ',', ';'])
const trimPath = p => {
  let end = p.length
  while (end > 0 && TRAILING.has(p[end - 1])) end--
  return p.slice(0, end).trim()
}

const repoLines = (cardText, reposRoot = null) => {
  const out = []
  const m = cardText.match(REPO_LINE)
  if (m) out.push(path.resolve(expandHome(m[1])))
  const add = p => p && !BARE.test(p) && out.push(path.resolve(expandHome(p)))
  for (const x of cardText.matchAll(LINE_PATH)) {
    const whole = trimPath(x[1])
    const first = trimPath(x[1].split(/\s/)[0])
    if (whole !== first && fs.existsSync(path.resolve(expandHome(whole)))) add(whole)
    add(first)
  }
  if (reposRoot) for (const x of cardText.matchAll(NAME_LINE)) if (x[1].toLowerCase() !== 'none') out.push(path.join(reposRoot, x[1]))
  return [...new Set(out)]
}

const MID_PATH = new RegExp(String.raw`(?:^|[\s(])(?:repo|repository|code)[ \t]*[:：][ \t]*` + PATH, 'gim')
const URL_NAME = /\b(?:repo|repository|code|git)[ \t]*[:：][ \t]*<?https?:\/\/[^\s/<>]+\/[^\s/<>]+\/([A-Za-z0-9][\w.-]*?)(?:\.git)?(?=[\s/#?>)]|$)/gim

const proseLines = (cardText, reposRoot = null) => [
  ...[...cardText.matchAll(PROSE_PATH), ...cardText.matchAll(MID_PATH)].map(x => trimPath(x[1])).filter(p => p && !BARE.test(p)).map(p => path.resolve(expandHome(p))),
  ...(reposRoot ? [...cardText.matchAll(URL_NAME)].map(x => path.join(reposRoot, x[1])) : []),
]

export const looseName = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')

export const declaredRepos = (reposRoot, name, cardText, hint = null) => {
  const field = repoField(cardText)
  return [
    field && !noRepo(cardText) ? fieldPath(reposRoot, field) : null,
    hint && hint.toLowerCase() !== 'none' ? fieldPath(reposRoot, hint) : null,
    ...repoLines(cardText, reposRoot),
    path.join(reposRoot, name),
  ].filter(Boolean)
}

export const repoOf = (reposRoot, name, cardText, ignored = none, hint = null, prose = true) => {
  if (ignored(name) || noRepo(cardText, hint)) return null
  const pick = p => (p && !ignored(p) && fs.existsSync(path.join(p, '.git')) ? p : null)
  const field = repoField(cardText)
  for (const p of [field && fieldPath(reposRoot, field), hint && fieldPath(reposRoot, hint), ...repoLines(cardText, reposRoot)]) if (pick(p)) return p
  let dirs
  try {
    dirs = fs.readdirSync(reposRoot)
  } catch {
    dirs = []
  }
  const exact = dirs.find(d => d.toLowerCase() === name.toLowerCase())
  if (exact && pick(path.join(reposRoot, exact))) return path.join(reposRoot, exact)
  if (prose) for (const p of proseLines(cardText, reposRoot)) if (pick(p)) return p
  if (exact || !dirs.length) return null
  if (name.includes('/') || !looseName(name)) return null
  const loose = dirs.filter(d => looseName(d) === looseName(name)).map(d => pick(path.join(reposRoot, d))).filter(Boolean)
  return loose.length === 1 ? loose[0] : null
}

const linkedDir = p => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const realOf = p => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

export const uncardedRepos = (reposRoot, cards, ignored = none) => {
  let dirs
  try {
    dirs = fs.readdirSync(reposRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const key = p => (realOf(path.resolve(p)) ?? path.resolve(p)).toLowerCase()
  const used = new Set()
  for (const c of cards) {
    const found = repoOf(reposRoot, c.name, c.text, none, c.repoHint)
    for (const p of [found, ...declaredRepos(reposRoot, c.name, c.text, c.repoHint)]) if (p) used.add(key(p))
  }
  return dirs
    .filter(d => (d.isDirectory() || (d.isSymbolicLink() && linkedDir(path.join(reposRoot, d.name)))) && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map(d => {
      const dir = path.join(reposRoot, d.name)
      return { name: d.name, dir, real: realOf(dir) ?? dir }
    })
    .filter(r => !ignored(r.name) && !ignored(r.dir) && !ignored(r.real) && !used.has(r.real.toLowerCase()) && fs.existsSync(path.join(r.dir, '.git')))
    .map(r => {
      let active = null
      try {
        active = fs.statSync(path.join(r.dir, '.git')).mtimeMs
      } catch {}
      return { name: r.name, active }
    })
    .sort((a, b) => (b.active ?? 0) - (a.active ?? 0) || a.name.localeCompare(b.name))
}

const MISSING = Symbol('missing')

const git = async (repo, args) => {
  try {
    const { stdout } = await run('git', ['--no-optional-locks', '-C', repo, ...args], { timeout: 8000, windowsHide: true })
    return stdout.trim()
  } catch (e) {
    return e?.code === 1 && args.includes('--verify') ? MISSING : null
  }
}

export const auditedCommit = readinessText => {
  const field = readFields(readinessText).audit_commit
  if (/^[0-9a-f]{7,40}$/.test(field ?? '')) return { sha: field, source: 'audit_commit' }
  const head = readinessText.split(/\r?\n/).slice(0, 40).join('\n')
  const h = head.match(/HEAD\s+`([0-9a-f]{7,40})`/)?.[1]
  if (h) return { sha: h, source: 'HEAD in text' }
  const named = [...new Set([...head.matchAll(/(?:коммит|commit)\s+`([0-9a-f]{7,40})`/gi)].map(m => m[1]))]
  const every = new Set([...head.matchAll(/`([0-9a-f]{7,40})`/g)].map(m => m[1]))
  return named.length === 1 && every.size === 1 ? { sha: named[0], source: 'commit in text' } : null
}

export const readiness = (cardDir, name = 'READINESS.md') => {
  const file = path.join(cardDir, name)
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const f = readFields(text)
  const score = text.match(/Ready:\s*(\d+)\s+of\s+(\d+)/i)
  const c = auditedCommit(text)
  return {
    audit: f.audit ?? '',
    commit: c?.sha ?? null,
    commitSource: c?.source ?? null,
    proven: score ? Number(score[1]) : null,
    total: score ? Number(score[2]) : null,
  }
}

export const freshness = async (repo, commit) => {
  if (!repo) return { state: 'no-repo' }
  const head = await git(repo, ['rev-parse', '--short=7', 'HEAD'])
  const originRaw = await git(repo, ['rev-parse', '--verify', '--quiet', '--short=7', 'refs/remotes/origin/main'])
  const dirty = await git(repo, ['status', '--porcelain'])
  const origin = originRaw === MISSING ? null : originRaw
  const out = { head, origin, dirty: dirty == null ? null : dirty.split('\n').filter(Boolean).length }
  if (head == null || dirty == null || originRaw == null) return { ...out, commit, state: 'git-unavailable' }
  if (!commit) return { ...out, state: 'no-audit-commit' }
  const known = await git(repo, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
  if (known == null) return { ...out, commit, state: 'git-unavailable' }
  if (known === MISSING) return { ...out, commit, state: 'audit-commit-unknown' }
  const ahead = await git(repo, ['rev-list', '--count', `${commit}..HEAD`])
  const behind = await git(repo, ['rev-list', '--count', `HEAD..${commit}`])
  const aheadOrigin = origin ? await git(repo, ['rev-list', '--count', `${commit}..origin/main`]) : null
  if (ahead == null || behind == null || (origin && aheadOrigin == null)) return { ...out, commit, state: 'git-unavailable' }
  const local = Number(ahead)
  const remote = aheadOrigin == null ? null : Number(aheadOrigin)
  const changed = local > 0 || Number(behind) > 0 || (remote ?? 0) > 0 || (out.dirty ?? 0) > 0
  return { ...out, commit, sinceLocal: local, behindAudit: Number(behind), sinceOrigin: remote, state: changed ? 'changed-after' : 'current' }
}

export const releasePlan = repo => {
  if (!repo) return []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repo, '.local', 'release.json'), 'utf8'))
    return Object.entries(j?.updates ?? {})
      .filter(([n, v]) => /^\d+$/.test(n) && v && typeof v === 'object' && !Array.isArray(v))
      .map(([n, v]) => ({ n: Number(n), flags: Object.keys(v).filter(k => /^[A-Z][A-Z0-9_]*$/.test(k)) }))
  } catch {
    return []
  }
}

const isAncestor = async (repo, sha) => {
  try {
    await run('git', ['--no-optional-locks', '-C', repo, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], { timeout: 8000, windowsHide: true })
    return true
  } catch (e) {
    return e?.code === 1 ? false : null
  }
}

export const updateBranches = async repo => {
  if (!repo) return []
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname:short=7)', 'refs/heads/update-*'])
  if (out == null) return null
  const list = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [branch, sha] = line.split(' ')
    const n = branch.match(/^update-(\d+)(?:-|$)/)?.[1]
    if (n) list.push({ n: Number(n), branch, sha, inMain: await isAncestor(repo, sha) })
  }
  return list
}

const OG = /^og([-_.][\w.-]*)?\.(png|jpe?g|webp)$/i

const subdirs = dir => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !/^(\.|node_modules$|dist$|build$|out$)/.test(e.name)).map(e => path.join(dir, e.name))
  } catch {
    return []
  }
}

export const ogImage = repo => {
  if (!repo) return null
  const top = subdirs(repo)
  const found = []
  for (const d of [repo, ...top, ...top.flatMap(subdirs)])
    try {
      const pub = path.join(d, 'public')
      for (const f of fs.readdirSync(pub)) if (OG.test(f)) found.push(path.join(pub, f))
    } catch {}
  return found.sort((a, b) => /^og\./i.test(path.basename(b)) - /^og\./i.test(path.basename(a)) || a.length - b.length)[0] ?? null
}

export const updateFlags = repo => {
  if (!repo) return null
  const names = new Set()
  for (const f of ['.env.example', 'README-updates.md']) {
    const p = path.join(repo, f)
    if (!fs.existsSync(p)) continue
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bFEATURE_[A-Z0-9_]+\b/g)) names.add(m[0])
  }
  const readmes = fs.existsSync(repo) ? fs.readdirSync(repo).filter(f => /^UPDATE-\d+/i.test(f) || f === 'README-updates.md') : []
  return { flags: [...names].sort(), readmes }
}
