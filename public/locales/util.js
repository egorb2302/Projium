export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

export const plurals = locale => {
  const rules = new Intl.PluralRules(locale)
  return (n, forms) => forms[rules.select(n)] ?? forms.other ?? forms.many ?? Object.values(forms).at(-1)
}

export const num = v => String(Number(Number(v).toFixed(4)))
