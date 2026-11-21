import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseOffset } from '../lib/config.mjs'

const dir = path.join(import.meta.dirname, '..', 'public')
const literal = s => s.replace(/\\(.)/g, '$1')

const patterns = () => {
  const out = []
  for (const f of fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const m of src.matchAll(/\bpattern:\s*'((?:[^'\\]|\\.)*)'/g)) out.push({ f, p: literal(m[1]) })
    for (const m of src.matchAll(/\bpattern="([^"]*)"/g)) out.push({ f, p: m[1] })
  }
  return out
}

const asBrowser = p => new RegExp(`^(?:${p})$`, 'v')

test('every pattern attribute in the UI compiles with the v flag browsers use for it', () => {
  const found = patterns()
  assert.ok(found.length > 0)
  for (const { f, p } of found) assert.doesNotThrow(() => asBrowser(p), `${f}: ${p}`)
})

test('the time zone pattern takes what the config accepts: a signed hh:mm offset or local', () => {
  const zone = patterns().find(x => x.p.includes(':[0-9]{2}'))
  assert.ok(zone)
  const r = asBrowser(zone.p)
  for (const ok of ['+03:00', '-05:30', '+14:00', '-10:00', 'local']) {
    assert.equal(r.test(ok), true, ok)
    assert.doesNotThrow(() => parseOffset(ok), ok)
  }
  for (const bad of ['03:00', '+3:00', '+03:0', '+0300', '±03:00', '-+03:00', 'Local', 'localtime']) {
    assert.equal(r.test(bad), false, bad)
    assert.throws(() => parseOffset(bad), bad)
  }
})
