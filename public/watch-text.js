import en from './locales/en.js'

const WORDS = { en: en.watch }
export const registerWords = (code, dict) => {
  if (dict?.watch) WORDS[code] = dict.watch
}
const words = lang => {
  const w = WORDS[lang]
  if (!w || w === WORDS.en) return WORDS.en
  return { ...WORDS.en, ...w, signal: { ...WORDS.en.signal, ...w.signal }, part: { ...WORDS.en.part, ...w.part } }
}

export const signalName = (signal, lang) => words(lang).signal[signal] ?? signal

export const detailText = (parts, lang) => (Array.isArray(parts) ? parts : []).map(p => words(lang).part[p?.k]?.(p) ?? String(p?.k ?? '')).join('; ')

export const durationText = (ms, lang) => {
  const w = words(lang)
  const m = Math.max(0, Math.round(ms / 60e3))
  if (m < 60) return `${m} ${w.min}`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} ${w.h} ${m % 60} ${w.min}` : `${h} ${w.h}`
  return h % 24 ? `${Math.floor(h / 24)} ${w.d} ${h % 24} ${w.h}` : `${h / 24} ${w.d}`
}

export const ALERT_MAX = 4000

const DETAIL_MAX = 3000

export const alertBlock = (e, { lang = 'en', link = () => null } = {}) => {
  const w = words(lang)
  const detail = detailText(e.detail, lang)
  return [
    `${e.kind === 'open' ? w.open : w.close}: ${e.target} · ${signalName(e.signal, lang)}`,
    [detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail, e.kind === 'close' && e.openedAt != null && e.closedAt != null ? w.lasted(durationText(e.closedAt - e.openedAt, lang)) : ''].filter(Boolean).join(', '),
    link(e),
  ].filter(Boolean).join('\n')
}

export const alertText = (events, opts = {}) => {
  const text = events.map(e => alertBlock(e, opts)).join('\n\n')
  if (text.length <= ALERT_MAX) return text
  const cut = text.slice(0, ALERT_MAX - 10)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…`
}
