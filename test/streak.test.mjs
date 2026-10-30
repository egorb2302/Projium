import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createStreak } from '../lib/streak.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-streak-'))
  const origin = path.join(dir, 'origin.git')
  const repo = path.join(dir, 'clone')
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  git(dir, 'clone', '--quiet', origin, repo)
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'index.html'), 'site\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'site')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')
  return { dir, origin, repo }
}

const at = iso => Date.parse(iso)

test('streak commits one line a day after the hour, pushes it and never doubles a day', async () => {
  const { dir, origin, repo } = setup()
  let now = at('2026-10-27T06:59:00Z')
  const streak = createStreak({ repo, atMinutes: 600, offsetMin: 180, notify: async () => assert.fail('no alert expected'), clock: () => now })
  try {
    await streak.tick()
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '1')
    now = at('2026-10-27T07:00:00Z')
    await streak.tick()
    await streak.tick()
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '2')
    assert.equal(git(origin, 'show', 'main:daily.log'), '2026-10-27')
    assert.equal(git(origin, 'log', '-1', '--format=%s', 'main'), 'Daily log 2026-10-27')

    const fresh = createStreak({ repo, atMinutes: 600, offsetMin: 180, notify: async () => assert.fail('no alert expected'), clock: () => now })
    await fresh.tick()
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '2')

    now = at('2026-10-28T09:00:00Z')
    await streak.tick()
    assert.equal(git(origin, 'show', 'main:daily.log'), '2026-10-27\n2026-10-28')

    const east = createStreak({ repo, atMinutes: 600, offsetMin: 240, notify: async () => assert.fail('no alert expected'), clock: () => now })
    now = at('2026-10-29T06:30:00Z')
    await streak.tick()
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '3')
    await east.tick()
    assert.equal(git(origin, 'show', 'main:daily.log'), '2026-10-27\n2026-10-28\n2026-10-29')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed push is retried every 15 minutes and alerts once on the third failure, then lands', async () => {
  const { dir, origin, repo } = setup()
  const moved = `${origin}-away`
  fs.renameSync(origin, moved)
  let now = at('2026-10-27T08:00:00Z')
  const alerts = []
  const streak = createStreak({ repo, atMinutes: 600, offsetMin: 180, notify: async t => alerts.push(t), clock: () => now })
  try {
    await streak.tick()
    await streak.tick()
    for (let i = 0; i < 3; i++) {
      now += 15 * 60e3
      await streak.tick()
    }
    assert.equal(alerts.length, 1)
    assert.match(alerts[0], /2026-10-27/)
    fs.renameSync(moved, origin)
    now += 15 * 60e3
    await streak.tick()
    assert.equal(git(origin, 'show', 'main:daily.log'), '2026-10-27')
    assert.equal(git(origin, 'rev-list', '--count', 'main'), '2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
