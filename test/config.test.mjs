import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, parseOffset, formatOffset, ignoreTest } from '../lib/config.mjs'

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('offsets parse from +HH:MM and print back', () => {
  assert.equal(parseOffset('+03:00'), 180)
  assert.equal(parseOffset('-05:30'), -330)
  assert.equal(parseOffset('local'), -new Date().getTimezoneOffset())
  assert.throws(() => parseOffset('MSK'), /utcOffset/)
  assert.throws(() => parseOffset('+15:00'), /utcOffset/)
  assert.equal(formatOffset(180), '+03:00')
  assert.equal(formatOffset(-330), '-05:30')
  assert.equal(formatOffset(0), '+00:00')
})

test('ignore words match case-insensitively as plain text, never as patterns', () => {
  const ignored = ignoreTest(['Secret', 'a.b'])
  assert.equal(ignored('my-secret-app'), true)
  assert.equal(ignored('a.b'), true)
  assert.equal(ignored('axb'), false)
  assert.equal(ignoreTest([])('anything'), false)
  assert.equal(ignoreTest(undefined)('anything'), false)
})

test('with no config file the demo projects are shown and no digest channel is set', t => {
  const dir = temp(t)
  const c = loadConfig(dir, path.join(dir, 'tracker.config.json'))
  assert.equal(c.file, null)
  assert.equal(c.projectsDir, path.join(dir, 'demo', 'projects'))
  assert.equal(c.transcriptsDir, path.join(os.homedir(), '.claude', 'projects'))
  assert.equal(c.digest.command, null)
  assert.equal(c.streak, null)
  assert.equal(c.readinessFile, 'READINESS.md')
})

test('config paths resolve from the config file folder, ~ from home, and .env.local fills the secrets', t => {
  const dir = temp(t)
  const file = path.join(dir, 'conf', 'tracker.config.json')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({ projectsDir: '../vault/Projects', transcriptsDir: '~/t', utcOffset: '+03:00', ignore: ['x'], digest: { lang: 'ru', command: ['node', '~/send.mjs', '--text'] }, streak: { repo: 'streak' } }))
  fs.writeFileSync(path.join(dir, '.env.local'), 'PORT=4001\nTELEGRAM_BOT_TOKEN="123:abc"\nTELEGRAM_CHAT_ID=42\n')
  const keep = { PORT: process.env.PORT, T: process.env.TELEGRAM_BOT_TOKEN, C: process.env.TELEGRAM_CHAT_ID }
  delete process.env.PORT
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  try {
    const c = loadConfig(dir, file)
    assert.equal(c.projectsDir, path.join(dir, 'vault', 'Projects'))
    assert.equal(c.transcriptsDir, path.join(os.homedir(), 't'))
    assert.equal(c.port, 4001)
    assert.equal(c.utcOffset, 180)
    assert.deepEqual(c.digest.command, ['node', path.join(os.homedir(), 'send.mjs'), '--text'])
    assert.deepEqual(c.digest.telegram, { token: '123:abc', chatId: '42' })
    assert.equal(c.digest.lang, 'ru')
    assert.equal(c.streak.repo, path.join(dir, 'conf', 'streak'))
  } finally {
    for (const [k, v] of [['PORT', keep.PORT], ['TELEGRAM_BOT_TOKEN', keep.T], ['TELEGRAM_CHAT_ID', keep.C]]) if (v !== undefined) process.env[k] = v
  }
})

test('a bad config is refused at start with a readable reason', t => {
  const dir = temp(t)
  const file = path.join(dir, 'tracker.config.json')
  const bad = (value, reason) => {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    assert.throws(() => loadConfig(dir, file), reason)
  }
  bad({ digest: { command: 'node send.mjs' } }, /digest.command/)
  bad({ digest: { lang: 'de' } }, /digest.lang/)
  bad({ ignore: 'secret' }, /ignore must be an array/)
  bad({ reviewAgents: [1] }, /reviewAgents must be an array/)
  bad({ port: 'abc' }, /port must be a number/)
  bad({ readinessFile: '../x.md' }, /readinessFile/)
  bad({ digest: { at: '25:00' } }, /digest\.at must be HH:MM/)
  bad({ digest: { env: 'SLACK_BOT_TOKEN' } }, /digest\.env must be an array/)
  bad('null', /must hold a JSON object/)
  bad('[1]', /must hold a JSON object/)
  bad('{bad', /tracker\.config\.json is not valid JSON/)
})

test('an empty PORT in the environment counts as unset', t => {
  const dir = temp(t)
  const keep = process.env.PORT
  process.env.PORT = ''
  try {
    assert.equal(loadConfig(dir, path.join(dir, 'none.json')).port, 3210)
  } finally {
    if (keep === undefined) delete process.env.PORT
    else process.env.PORT = keep
  }
})
