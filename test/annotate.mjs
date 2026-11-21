import fs from 'node:fs'

if (!fs.existsSync(process.argv[2] ?? '')) {
  console.log('::error title=tests failed::no TAP output (the run stopped before the tests)')
  process.exit(0)
}
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)
const clean = s => s.replace(/[\r\n]+/g, ' ').replace(/%/g, '%25').slice(0, 300)
const field = (block, key) => {
  const at = block.findIndex(l => l.trim().startsWith(`${key}:`))
  if (at < 0) return ''
  const value = block[at].trim().slice(key.length + 1).trim()
  if (!/^[|>]-?$/.test(value)) return value.replace(/^'|'$/g, '')
  const indent = block[at].search(/\S/)
  const more = []
  for (let j = at + 1; j < block.length && (block[j].search(/\S/) > indent || !block[j].trim()); j++) if (block[j].trim()) more.push(block[j].trim())
  return more.join(' ')
}
let shown = 0
lines.forEach((line, i) => {
  const m = line.match(/^(\s*)not ok \d+ - (.*)$/)
  if (!m || shown >= 20) return
  const block = []
  for (let j = i + 1; j < lines.length && block.length < 80; j++) {
    if (lines[j].trim() === '...' && lines[j].search(/\S/) <= m[1].length + 2) break
    block.push(lines[j])
  }
  const where = field(block, 'location')
  const why = [field(block, 'error'), field(block, 'code')].filter(Boolean).join(' | ')
  console.log(`::error title=${clean(m[2]).replace(/[:,]/g, ' ')}::${clean(`${why}${where ? ` at ${where}` : ''}`)}`)
  shown++
})
if (!shown) console.log('::error title=tests failed::no "not ok" lines in the TAP output')
