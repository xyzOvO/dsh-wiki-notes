/**
 * visits.js —— 「最近打开过哪几页」的账本。
 *
 * 为什么需要它：概览页要显示「最近访问 5 篇」。这件事**没法从 corpus 算出来** ——
 * corpus 只知道文件什么时候被改过（mtime），那是「最近更新」，不是「最近看过」。
 * 把 mtime 摆在「最近访问」这四个字底下，就是拿一个看起来对的数字冒充另一个问题。
 *
 * 所以单独记一条链接账：宿主在「模型读了一页」和「用户在面板里点开一页」时各记一行。
 *
 * 与 calls.jsonl 的分工：那边记「一次调用」（含查询与命中数），这边记「一页被打开」。
 * 同一个动作会各留一条，但两边的用途不同，混在一张表里会让两张统计都失真。
 *
 * 三条铁律（与 calls.js 一致）：
 *   1. 只记 ts / name / file / source 四个字段 —— 正文、摘要一律不进账本。
 *   2. 记账是旁路：写文件失败只 warn，绝不改变工具返回值。
 *   3. 读的时候只认尾部，并按 file 去重（同一页看十次，概览里只出现一次，时间取最近那次）。
 */
import { createJsonlStore } from './jsonl-store.js'
import { MAX_LINES, KEEP_LINES } from './jsonl-store.js'
import { clipChars } from './text.js'

/** 账本只认这 4 个字段。顺序就是 JSONL 的键序。 */
export const VISIT_FIELDS = ['ts', 'name', 'file', 'source']
/** 页名与路径的截断长度：路径可能很长，但截断也要能看出是哪一页。 */
const NAME_MAX = 120
const FILE_MAX = 240
/** 内存里留最近多少条 —— 文件读不出来时的兜底。 */
const BUFFER_MAX = 200
/** 默认返回几条「最近访问」。 */
export const DEFAULT_VISITS = 5
const LIMIT_MAX = 50

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，与 calls.js 同一套时区（账本里的时间要能直接对比）。 */
export function stampNow(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 只留白名单字段；name 与 file 都空就没有「哪一页」可言，返回 null 让调用方别记。 */
export function normalizeVisit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? clipChars(raw.name, NAME_MAX) : ''
  const file = typeof raw.file === 'string' ? clipChars(raw.file, FILE_MAX) : ''
  if (name === '' && file === '') return null
  return {
    ts: typeof raw.ts === 'string' && raw.ts !== '' ? raw.ts : stampNow(),
    name,
    file,
    // 谁打开的：模型自己读的一页（model），还是人在面板里点的（panel）。
    // 概览里要能区分 —— 「模型常读」和「我常看」是两个不同的信息。
    source: raw.source === 'panel' ? 'panel' : 'model',
  }
}

export function createVisitLog({ file, maxLines = MAX_LINES, keepLines = KEEP_LINES } = {}) {
  const buffer = []
  const store = createJsonlStore({
    file, maxLines, keepLines,
    onRotate: ({ kept }) => {
      while (buffer.length > kept) buffer.shift()
    },
  })
  let warned = false

  function warnOnce(error) {
    if (warned) return
    warned = true
    console.warn('[wiki-notes] 最近访问写不进文件，只保留在内存里：', error?.message ?? error)
  }

  function record(raw) {
    const entry = normalizeVisit(raw)
    if (entry === null) return null
    buffer.push(entry)
    while (buffer.length > BUFFER_MAX) buffer.shift()
    if (file !== undefined && file !== null && file !== '') {
      try {
        store.append(entry)
        warned = false
      } catch (error) {
        warnOnce(error)
        store.invalidate()
      }
    }
    return entry
  }

  function read({ limit = DEFAULT_VISITS } = {}) {
    const fileRows = store.readRows()
    const seen = new Set(fileRows.map((row) => `${row.ts}|${row.file}|${row.name}`))
    const merged = [...fileRows]
    for (const row of buffer) {
      const key = `${row.ts}|${row.file}|${row.name}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
    merged.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))
    // 同一页只留最近一次：按 file（没有 file 就用 name）去重，从新往旧扫。
    const unique = []
    const taken = new Set()
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const row = merged[i]
      const key = String(row.file || row.name)
      if (taken.has(key)) continue
      taken.add(key)
      unique.push(row)
      if (unique.length >= LIMIT_MAX) break
    }
    const size = Math.max(1, Math.min(Math.trunc(Number(limit) || DEFAULT_VISITS), LIMIT_MAX))
    return unique.slice(0, size)
  }

  return { record, read, file, fields: VISIT_FIELDS }
}
