import fs from 'node:fs'
import path from 'node:path'
import {
  hashOf, readFields, readTasks, updateLines, timelineRows, validate, setField, lockedFields,
  replaceTask, addTask, formatTask, toggleLine, newTaskId,
} from './card.mjs'

export class Conflict extends Error {
  constructor(message, current) {
    super(message)
    this.current = current
  }
}

const NAME = /^[\p{L}\p{N} ._()-]+$/u

const withStage = fields => (fields.stage || !fields.project ? fields : { ...fields, stage: 'development' })

const sameExcept = (a, b, key) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete(key)
  return [...keys].every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

export const createStore = root => {
  const cardPath = name => {
    if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('.') || name.includes('..')) throw new Error('bad project name')
    const p = path.join(root, name, `${name}.md`)
    if (!fs.existsSync(p)) throw new Error(`no card for ${name}`)
    if (!fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`the card for ${name} links outside the projects folder`)
    return p
  }

  const load = name => {
    const file = cardPath(name)
    const text = fs.readFileSync(file, 'utf8')
    return {
      name,
      file,
      hash: hashOf(text),
      fields: withStage(readFields(text)),
      locked: lockedFields(text),
      tasks: readTasks(text).map(({ line, ...t }) => t),
      updates: updateLines(text),
      timeline: timelineRows(text),
      text,
    }
  }

  const list = () => {
    const out = []
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      try {
        const card = load(d.name)
        if (card.fields.stage) out.push(card)
      } catch (e) {
        if (fs.existsSync(path.join(root, d.name, `${d.name}.md`))) out.push({ name: d.name, error: typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code) ? e.code : String(e?.message ?? e) })
      }
    }
    return out
  }

  const write = (file, before, after) => {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tracker-tmp`)
    try {
      fs.writeFileSync(tmp, after)
      if (fs.readFileSync(file, 'utf8') !== before) return false
      fs.renameSync(tmp, file)
      return true
    } catch {
      return false
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  const mutate = (name, change) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) pause(100 * attempt)
      const file = cardPath(name)
      const before = fs.readFileSync(file, 'utf8')
      const after = change(before)
      if (after === before) return load(name)
      if (write(file, before, after)) return load(name)
    }
    throw new Error('could not write the card (it keeps changing or is locked); try again')
  }

  const saveField = (name, key, value, expected) => {
    const err = validate(key, value)
    if (err) throw new Error(err)
    return mutate(name, text => {
      const before = readFields(text)
      const cur = withStage(before)[key] ?? ''
      if (cur !== (expected ?? '')) throw new Conflict(`${key} was changed outside the dashboard`, cur)
      const after = setField(text, key, value)
      const read = readFields(after)
      const added = Object.hasOwn(before, key) ? 0 : 1
      if ((read[key] ?? '') !== value || !sameExcept(before, read, key) || after.split('\n').length !== text.split('\n').length + added)
        throw new Error(`refused: writing ${key} would change more than that field`)
      return after
    })
  }

  const saveTask = (name, op) =>
    mutate(name, text => {
      if (op.op === 'add') return addTask(text, { ...op.task, id: newTaskId(text), done: false })
      const r = replaceTask(text, op.id, cur => {
        const seen = op.expected ?? {}
        if (cur.done !== seen.done || cur.text !== seen.text || cur.due !== (seen.due ?? '') || cur.p !== (seen.p ?? ''))
          throw new Conflict('the task was changed outside the dashboard', { ...cur, line: undefined })
        if (op.op === 'toggle') return toggleLine(cur.line)
        if (op.op === 'edit') return formatTask({ ...cur, ...op.task, id: cur.id, done: cur.done })
        throw new Error(`unknown task op ${op.op}`)
      })
      if (!r) throw new Conflict('the task is gone from the card', null)
      return r.text
    })

  return { list, load, saveField, saveTask, cardPath }
}
