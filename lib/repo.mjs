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

export const noRepo = cardText => repoField(cardText)?.toLowerCase() === 'none'

const fieldPath = (reposRoot, field) => path.resolve(reposRoot, expandHome(field))

export const declaredRepos = (reposRoot, name, cardText) => {
  const field = repoField(cardText)
  const named = cardText.match(/(?:Repo|Код ребилда)[^`\n]*`((?:[A-Za-z]:\\|\/)[^`]+)`/)
  return [field && !noRepo(cardText) ? fieldPath(reposRoot, field) : null, named?.[1] ?? null, path.join(reposRoot, name)].filter(Boolean)
}

export const repoOf = (reposRoot, name, cardText, ignored = none) => {
  if (ignored(name) || noRepo(cardText)) return null
  const pick = p => (p && !ignored(p) && fs.existsSync(path.join(p, '.git')) ? p : null)
  const field = repoField(cardText)
  if (field) {
    const p = fieldPath(reposRoot, field)
    if (pick(p)) return p
  }
  const named = cardText.match(/(?:Repo|Код ребилда)[^`\n]*`((?:[A-Za-z]:\\|\/)[^`]+)`/)
  if (named && pick(named[1])) return named[1]
  let dirs
  try {
    dirs = fs.readdirSync(reposRoot)
  } catch {
    return null
  }
  const dir = dirs.find(d => d.toLowerCase() === name.toLowerCase())
  return dir ? pick(path.join(reposRoot, dir)) : null
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
