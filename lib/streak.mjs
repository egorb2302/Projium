import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

const gitIn = repo => async args => {
  try {
    return (await run('git', args, { cwd: repo, env: ENV, timeout: 120e3, windowsHide: true })).stdout.trim()
  } catch (e) {
    throw new Error(`git ${args[0]}: ${e?.killed ? 'timed out' : typeof e?.code === 'number' ? `exit ${e.code}` : 'did not start'}`)
  }
}

const DAILY = /^Daily log \d{4}-\d{2}-\d{2}$/

const failedText = {
  en: (name, day, why) => `Daily commit to ${name} for ${day} failed 3 times; retrying every 15 minutes. Reason: ${why}`,
  ru: (name, day, why) => `GitHub серия: сегодня (${day}) коммит в ${name} не ушёл, 3 попытки. Дальше пробую раз в 15 минут. Причина: ${why}`,
}

export const createStreak = ({ repo, atMinutes, notify, clock = () => Date.now(), offsetMin = -new Date().getTimezoneOffset(), branch = 'main', file = 'daily.log', lang = 'en' }) => {
  const git = gitIn(repo)
  const local = now => new Date(now + offsetMin * 60e3)
  const dayOf = now => local(now).toISOString().slice(0, 10)
  const minutesOf = now => local(now).getUTCHours() * 60 + local(now).getUTCMinutes()
  let done = null
  let inFlight = null
  const failures = new Map()

  const onlyDailyCommits = async () => {
    const subjects = (await git(['log', '--format=%s', 'FETCH_HEAD..HEAD'])).split('\n').filter(Boolean)
    const files = (await git(['diff', '--name-only', 'FETCH_HEAD', 'HEAD'])).split('\n').filter(Boolean)
    return subjects.every(s => DAILY.test(s)) && files.every(f => f === file)
  }

  const commitToday = async day => {
    if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])) !== branch) throw new Error(`the streak repo is not on ${branch}`)
    if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('the streak repo has uncommitted changes')
    await git(['pull', '--rebase', '--quiet', 'origin', branch])
    if (!(await onlyDailyCommits())) throw new Error(`the streak repo has local commits besides ${file}`)
    const log = path.join(repo, file)
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
    if (!text.split('\n').includes(day)) {
      fs.writeFileSync(log, `${text}${day}\n`)
      await git(['add', '--', file])
      await git(['commit', '--quiet', '-m', `Daily log ${day}`])
    }
    if (!(await onlyDailyCommits())) throw new Error(`the streak repo has local commits besides ${file}`)
    await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`])
  }

  const tick = async () => {
    const now = clock()
    const day = dayOf(now)
    if (inFlight || done === day || minutesOf(now) < atMinutes || !fs.existsSync(path.join(repo, '.git'))) return
    const f = failures.get(day) ?? { n: 0, last: 0 }
    if (f.last && now - f.last < 15 * 60e3) return
    inFlight = commitToday(day)
    try {
      await inFlight
      done = day
      failures.clear()
    } catch (e) {
      failures.set(day, { n: f.n + 1, last: now })
      console.error(new Date(now).toISOString(), 'streak failed', e.message)
      if (f.n + 1 === 3 && notify) await notify((failedText[lang] ?? failedText.en)(path.basename(repo), day, e.message)).catch(() => {})
    } finally {
      inFlight = null
    }
  }

  return { tick }
}
