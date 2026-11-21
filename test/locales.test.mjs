import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LANGS, CODES, pickLang } from '../public/locales/index.js'
import { LOCALES, words, langError } from '../lib/locales.mjs'
import { buildDigest } from '../lib/digest.mjs'
import { pageData, renderPage } from '../lib/share.mjs'
import { alertText, detailText, signalName, durationText } from '../public/watch-text.js'

const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'locales')
const en = (await import(pathToFileURL(path.join(dir, 'en.js')).href)).default
const SECTIONS = ['ui', 'watch', 'digest', 'share']

const PART = { status: 200, code: 'ETIMEDOUT', date: '2026-12-01', days: 9, age: 31, max: 20, field: 'lastCycleAt', min: 0.05, key: 'payoutsLive', value: 0.012, unit: 'SOL', env: 'SOLANA_RPC_URL' }
const ARGSETS = [[], [2, 3, 4, 5], [1, 1, 1, 1], [0, 0, 0, 0], [21, 21, 21, 21], ['x', 'y', 'z', 'w'], [PART], ['2026-11-20', true, false], ['2026-11-20', false, true], [-3], [12, 'abc1234', 2, 1], [null, 40]]

const argsFor = fn => ARGSETS.filter(a => {
  try {
    return typeof fn(...a) === 'string'
  } catch {
    return false
  }
})

const walk = (ref, got, where, problems) => {
  if (typeof ref === 'function') {
    if (typeof got !== 'function') return problems.push(`${where}: expected a function`)
    for (const a of argsFor(ref)) {
      let out
      try {
        out = got(...a)
      } catch (e) {
        problems.push(`${where}(${a.map(x => JSON.stringify(x)).join(', ')}) throws: ${e.message}`)
        continue
      }
      if (typeof out !== 'string') problems.push(`${where}(${a.map(x => JSON.stringify(x)).join(', ')}) returns ${typeof out}, not a string`)
      else if (/undefined|\[object Object\]|NaN/.test(out) && !/undefined|\[object Object\]|NaN/.test(ref(...a))) problems.push(`${where}(${a.map(x => JSON.stringify(x)).join(', ')}) prints ${JSON.stringify(out)}`)
    }
    return
  }
  if (Array.isArray(ref)) {
    if (!Array.isArray(got) || got.length !== ref.length) return problems.push(`${where}: expected an array of ${ref.length}`)
    ref.forEach((r, i) => {
      if (Array.isArray(r) && typeof r[0] === 'string' && Array.isArray(got[i]) && r.length === 2 && typeof r[1] !== 'object' && !/^\d/.test(String(r[0])) && got[i][0] !== r[0] && where.endsWith('states'))
        problems.push(`${where}[${i}]: key ${JSON.stringify(got[i][0])} should stay ${JSON.stringify(r[0])}`)
      walk(r, got[i], `${where}[${i}]`, problems)
    })
    return
  }
  if (ref && typeof ref === 'object') {
    if (!got || typeof got !== 'object') return problems.push(`${where}: expected an object`)
    for (const k of Object.keys(ref)) {
      if (!Object.hasOwn(got, k)) problems.push(`${where}.${k}: missing`)
      else walk(ref[k], got[k], `${where}.${k}`, problems)
    }
    for (const k of Object.keys(got)) if (!Object.hasOwn(ref, k)) problems.push(`${where}.${k}: not in en`)
    return
  }
  if (typeof got !== typeof ref) problems.push(`${where}: expected ${typeof ref}, got ${typeof got}`)
  else if (typeof ref === 'string' && !got.trim() && ref.trim()) problems.push(`${where}: empty`)
}

test('every language listed has a locale file, and every locale file is listed', () => {
  const files = fs.readdirSync(dir).filter(f => /^[a-z]{2}\.js$/.test(f)).map(f => f.slice(0, 2)).sort()
  assert.deepEqual(files, [...CODES].sort())
  assert.equal(new Set(CODES).size, CODES.length)
  assert.deepEqual(Object.keys(LOCALES).sort(), [...CODES].sort())
  for (const [code, name] of LANGS) {
    assert.equal(LOCALES[code].code, code)
    assert.equal(LOCALES[code].name, name)
  }
})

for (const code of CODES.filter(c => c !== 'en')) {
  test(`${code}: same keys and shapes as English, every text function returns a string`, () => {
    const loc = LOCALES[code]
    const problems = []
    for (const s of SECTIONS) walk(en[s], loc[s], `${code}.${s}`, problems)
    assert.deepEqual(problems, [])
    const ui = loc.ui
    assert.doesNotThrow(() => new Date(0).toLocaleString(ui.locale), 'ui.locale is a valid BCP 47 tag')
    assert.doesNotThrow(() => new Date(0).toLocaleString(loc.share.locale), 'share.locale is a valid BCP 47 tag')
    assert.equal(ui.listCols.length, en.ui.listCols.length)
    assert.deepEqual(Object.keys(ui.stage), Object.keys(en.ui.stage))
    assert.deepEqual(ui.mutePresets.map(([m]) => m), en.ui.mutePresets.map(([m]) => m), 'mute preset minutes stay the same')
    assert.deepEqual(loc.digest.states.map(([k]) => k), en.digest.states.map(([k]) => k), 'digest state keys stay the same')
  })
}

test('language helpers: the browser language picks a listed code, unknown codes are refused with the list', () => {
  assert.equal(pickLang('de-AT'), 'de')
  assert.equal(pickLang(['xx', 'pt-BR']), 'pt')
  assert.equal(pickLang('zh-Hans-CN'), 'zh')
  assert.equal(pickLang('xx'), 'en')
  assert.equal(langError('ja', 'digest.lang'), null)
  assert.match(langError('xx', 'digest.lang'), /digest\.lang must be one of en, ru/)
  assert.equal(words('xx', 'digest'), words('en', 'digest'))
})

test('the digest, alerts and client pages render in every language without English leftovers in the headings', () => {
  const now = Date.parse('2026-11-20T07:00:00Z')
  const card = { name: 'Acme', zone: '+03:00', fields: { stage: 'fixes', next_step: 'ship', deadline: '2026-11-19' }, tasks: [{ text: 'late', done: false, due: '2026-11-18', p: 'p1' }], updates: [], health: { last: { code: 502 }, down: true, uptime24: 80 }, repoInfo: null }
  for (const code of CODES) {
    const d = buildDigest([card], now, { offset: 180, lang: code })
    assert.ok(d.includes(words(code, 'digest').next), `${code}: digest uses its own words`)
    if (code !== 'en') assert.ok(!d.includes('In progress:'), `${code}: digest heading translated`)
    const alert = alertText([{ kind: 'open', id: 1, target: 'shop', signal: 'up', detail: [{ k: 'net', code: 'ETIMEDOUT' }], openedAt: now, at: now }], { lang: code })
    assert.ok(alert.startsWith(`${words(code, 'watch').open}: shop · ${signalName('up', code)}`), `${code}: alert`)
    assert.ok(detailText([{ k: 'balance', value: 0.01, min: 0.05, unit: 'SOL' }], code).includes('0.01'), `${code}: balance detail`)
    assert.ok(durationText(3 * 3600e3 + 5 * 60e3, code).length > 0)
    const html = renderPage(pageData({ card, show: ['stage', 'progress', 'updates', 'uptime', 'incidents'], lang: code, now }))
    assert.match(html, new RegExp(`<html lang="${code}">`))
    assert.ok(html.includes(words(code, 'share').stage.fixes), `${code}: client page stage`)
  }
})

test('the config schema lists exactly the supported languages wherever it takes one', () => {
  const schema = fs.readFileSync(path.join(path.dirname(dir), '..', 'tracker.config.schema.json'), 'utf8')
  const lists = [...schema.matchAll(/"lang": \{ "enum": (\[[^\]]*\])/g)].map(m => JSON.parse(m[1]))
  assert.equal(lists.length, 3)
  for (const l of lists) assert.deepEqual(l, CODES)
})
