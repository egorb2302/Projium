const num = v => String(Number(Number(v).toFixed(4)))

const WORDS = {
  en: {
    signal: { up: 'site', cert: 'certificate', beat: 'heartbeat', balance: 'balance' },
    open: 'Down',
    close: 'Recovered',
    lasted: d => `lasted ${d}`,
    min: 'min',
    h: 'h',
    d: 'd',
    part: {
      http: p => `HTTP ${p.status}`,
      net: p => `no answer (${p.code})`,
      cert: p => `certificate expires ${p.date}, in ${p.days} d`,
      nocert: () => 'certificate not read',
      beat: p => `last beat ${p.age} min ago (limit ${p.max})`,
      nobeat: p => `no time in ${p.field}`,
      ahead: p => `last beat is ${p.min} min in the future`,
      nokey: p => `${p.key} is missing or of another type`,
      paused: p => `${p.key} is ${p.value}, age not checked`,
      limit: p => `${p.key} is ${p.value} (max ${p.max})`,
      nolimit: p => `no number in ${p.key}`,
      json: () => 'answer is not JSON',
      balance: p => `${num(p.value)} ${p.unit} (alert below ${num(p.min)})`,
      rpc: p => `RPC failed (${p.code})`,
      norpc: p => `no RPC: ${p.env} is not set`,
      error: () => 'check failed',
    },
  },
  ru: {
    signal: { up: 'сайт', cert: 'сертификат', beat: 'пульс', balance: 'баланс' },
    open: 'Сбой',
    close: 'Восстановлено',
    lasted: d => `длилось ${d}`,
    min: 'мин',
    h: 'ч',
    d: 'д',
    part: {
      http: p => `HTTP ${p.status}`,
      net: p => `нет ответа (${p.code})`,
      cert: p => `сертификат истекает ${p.date}, через ${p.days} д`,
      nocert: () => 'сертификат не прочитан',
      beat: p => `последний пульс ${p.age} мин назад (порог ${p.max})`,
      nobeat: p => `нет времени в ${p.field}`,
      ahead: p => `пульс из будущего: на ${p.min} мин вперёд`,
      nokey: p => `нет поля ${p.key} или у него другой тип`,
      paused: p => `${p.key} = ${p.value}, возраст не проверяется`,
      limit: p => `${p.key} = ${p.value} (максимум ${p.max})`,
      nolimit: p => `нет числа в ${p.key}`,
      json: () => 'ответ не JSON',
      balance: p => `${num(p.value)} ${p.unit} (порог ${num(p.min)})`,
      rpc: p => `RPC не ответил (${p.code})`,
      norpc: p => `RPC не задан: нет ${p.env}`,
      error: () => 'проверка упала',
    },
  },
}

const words = lang => WORDS[lang] ?? WORDS.en

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

export const alertBlock = (e, { lang = 'en', link = () => null } = {}) => {
  const w = words(lang)
  return [
    `${e.kind === 'open' ? w.open : w.close}: ${e.target} · ${signalName(e.signal, lang)}`,
    [detailText(e.detail, lang), e.kind === 'close' && e.openedAt != null && e.closedAt != null ? w.lasted(durationText(e.closedAt - e.openedAt, lang)) : ''].filter(Boolean).join(', '),
    link(e),
  ].filter(Boolean).join('\n')
}

export const alertText = (events, opts = {}) => {
  const text = events.map(e => alertBlock(e, opts)).join('\n\n')
  if (text.length <= ALERT_MAX) return text
  const cut = text.slice(0, ALERT_MAX - 10)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…`
}
