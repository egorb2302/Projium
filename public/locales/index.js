export const LANGS = [
  ['en', 'English'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['pt', 'Português'],
  ['it', 'Italiano'],
  ['pl', 'Polski'],
  ['tr', 'Türkçe'],
  ['zh', '中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
]

export const CODES = LANGS.map(([code]) => code)

export const langName = code => LANGS.find(([c]) => c === code)?.[1] ?? code

export const pickLang = (wanted, fallback = 'en') => {
  for (const w of [wanted].flat()) {
    const code = String(w ?? '').toLowerCase().split(/[-_]/)[0]
    if (CODES.includes(code)) return code
  }
  return fallback
}
