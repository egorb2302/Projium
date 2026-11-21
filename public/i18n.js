import en from './locales/en.js'
import { CODES, pickLang } from './locales/index.js'
import { registerWords } from './watch-text.js'

const DICTS = { en }
const KEY = 'tracker-lang'

let lang = pickLang(navigator.languages ?? navigator.language)
try {
  const saved = localStorage.getItem(KEY)
  if (CODES.includes(saved)) lang = saved
} catch {}

export const loadLang = async (code = lang) => {
  if (!CODES.includes(code)) return false
  if (!DICTS[code]) {
    try {
      DICTS[code] = (await import(`./locales/${code}.js`)).default
    } catch {
      return false
    }
  }
  registerWords(code, DICTS[code])
  return true
}

export const getLang = () => lang
export const setLang = next => {
  lang = DICTS[next] ? next : 'en'
  try {
    localStorage.setItem(KEY, lang)
  } catch {}
}

const deep = (a, b) => {
  if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
    const out = { ...b }
    for (const [k, v] of Object.entries(a)) out[k] = deep(v, b[k])
    return out
  }
  return a ?? b
}

export const t = (key, ...args) => {
  const v = deep(DICTS[lang]?.ui[key], en.ui[key])
  return typeof v === 'function' ? v(...args) : v
}
export const fmtDate = ts => new Date(ts).toLocaleString(t('locale'), { dateStyle: 'medium', timeStyle: 'short' })
