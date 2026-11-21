import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CODES, LANGS } from '../public/locales/index.js'
import { registerWords } from '../public/watch-text.js'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales')

export const LOCALES = {}
for (const code of CODES) {
  const file = path.join(dir, `${code}.js`)
  if (!fs.existsSync(file)) continue
  LOCALES[code] = (await import(pathToFileURL(file).href)).default
  registerWords(code, LOCALES[code])
}

export { CODES, LANGS }

export const langError = (lang, where) =>
  lang != null && !Object.hasOwn(LOCALES, lang) ? `${where} must be one of ${Object.keys(LOCALES).join(', ')}, got ${lang}` : null

const merge = (a, b) => {
  if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
    const out = { ...b }
    for (const [k, v] of Object.entries(a)) out[k] = merge(v, b[k])
    return out
  }
  return a ?? b
}

const cache = new Map()
export const words = (lang, section) => {
  const key = `${lang}\u0001${section}`
  if (!cache.has(key)) cache.set(key, lang === 'en' || !LOCALES[lang] ? LOCALES.en[section] : merge(LOCALES[lang][section], LOCALES.en[section]))
  return cache.get(key)
}
