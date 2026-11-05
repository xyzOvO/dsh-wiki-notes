/**
 * calls.js —— 调用审计的账本。
 *
 * 为什么单独一个文件：这是插件里唯一会「每调用一次就写一行」的东西。
 * 放进 index.js 会把宿主那半撑得更长，而它需要守的纪律（字段白名单、
 * 坏行跳过、写失败不抛）跟检索逻辑一点关系都没有。
 *
 * 三条铁律：
 *   1. 只记白名单里的 8 个字段 —— 页面路径、正文、答案一律不进账本。
 *   2. 记账是旁路 —— 写文件失败只 warn，绝不改变工具返回值。
 *   3. 读的时候只认尾部 —— 账本会长到几千行，没人需要为了看一眼今天的调用
 *      把整个文件解析一遍。
 */

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'

/** 账本只认这 8 个字段。顺序就是表头顺序。 */
export const CALL_FIELDS = ['ts', 'source', 'tool', 'mode', 'query', 'hits', 'ms', 'ok']

/** query 截断长度。一条记录撑到几十 KB 只会有害。 */
export const QUERY_MAX = 120
/** 内存里留最近多少条 —— 文件读不出来时的兜底。 */
export const BUFFER_MAX = 500
/** 超过这么多行就轮转。 */
export const MAX_LINES = 5000
/** 轮转后留最后这么多行。 */
export const KEEP_LINES = 2500
/** 读取时只从文件尾部读这么多字节。 */
export const TAIL_BYTES = 262144
const DEFAULT_LIMIT = 200
const LIMIT_MAX = 500
/** totals 最多扫这么多行 —— 再老的不值得为「今日」统计去解析。 */
const TOTALS_MAX = 2000

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，和「今日」用的是同一套时区。 */
function stampNow(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function localDayOf(ts) {
  return typeof ts === 'string' ? ts.slice(0, 10) : ''
}

function clipQuery(value) {
  if (typeof value !== 'string') return ''
  return value.length > QUERY_MAX ? value.slice(0, QUERY_MAX) + '…' : value
}

/**
 * 只留白名单字段。输入不是对象就返回 null —— 调用方据此决定「这条不记」，
 * 而不是记一条全是 undefined 的空壳。
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  // null 与 0 是两件事：`Number(null)` 是 0，直接转会把「不产生命中的工具」
  // 混进命中率的分母里，命中率被系统性地压低。
  const hits = raw.hits === null || raw.hits === undefined ? Number.NaN : Number(raw.hits)
  const ms = raw.ms === null || raw.ms === undefined ? Number.NaN : Number(raw.ms)
  return {
    ts: typeof raw.ts === 'string' && raw.ts !== '' ? raw.ts : stampNow(),
    source: raw.source === 'panel' ? 'panel' : 'model',
    tool: typeof raw.tool === 'string' ? raw.tool : '',
    mode: typeof raw.mode === 'string' ? raw.mode : '',
    query: clipQuery(raw.query),
    hits: Number.isFinite(hits) ? Math.max(0, Math.trunc(hits)) : null,
    ms: Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : null,
    ok: raw.ok !== false,
  }
}

/** 读文件尾部；文件不存在或读不了就返回空串，由调用方退回内存缓冲。 */
function readTail(file, bytes = TAIL_BYTES) {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return ''
  }
  if (size === 0) return ''
  if (size <= bytes) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  let fd = null
  try {
    fd = openSync(file, 'r')
    const length = Math.min(bytes, fstatSync(fd).size)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也只是句柄，不影响读到的内容 */
      }
    }
  }
}

function parseLines(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 进程写到一半被杀会留下半行。跳过它，不要因此让整页白掉。
    }
  }
  return rows
}

function countLines(file) {
  try {
    return parseLines(readFileSync(file, 'utf8')).length
  } catch {
    return 0
  }
}

/**
 * 建一个账本。同一个文件可以有多个实例（宿主一个、测试一个），
 * 它们各记各的内存缓冲，文件是共享的。
 */
export function createCallLog({ file, enabled = true, maxLines = MAX_LINES, keepLines = KEEP_LINES } = {}) {
  const buffer = []
  let on = enabled !== false
  let lineCount = null
  let warned = false

  function warnOnce(error) {
    if (warned) return
    warned = true
    console.warn('[wiki-notes] 调用记录写不进文件，只保留在内存里：', error?.message ?? error)
  }

  function rotateIfNeeded() {
    if (lineCount === null) lineCount = countLines(file)
    if (lineCount <= maxLines) return
    let kept = []
    try {
      kept = parseLines(readFileSync(file, 'utf8')).slice(-keepLines)
    } catch {
      kept = []
    }
    try {
      writeFileSync(file, kept.map((row) => JSON.stringify(row) + '\n').join(''))
      lineCount = kept.length
    } catch (error) {
      warnOnce(error)
    }
  }

  function append(entry) {
    if (file === undefined || file === null || file === '') return
    try {
      rotateIfNeeded()
      appendFileSync(file, JSON.stringify(entry) + '\n')
      lineCount = (lineCount ?? 0) + 1
      warned = false
    } catch (error) {
      // 目录被删、只读、被别的进程占住 —— 都只影响账本，不影响检索。
      // 下次还会再试：用户可能只是临时删掉了文件。
      warnOnce(error)
      lineCount = null
    }
  }

  function record(raw) {
    const entry = normalizeEntry(raw)
    if (entry === null) return null
    buffer.push(entry)
    while (buffer.length > BUFFER_MAX) buffer.shift()
    if (on) append(entry)
    return entry
  }

  function read({ limit = DEFAULT_LIMIT, source = 'all', only = 'all' } = {}) {
    const fileRows = parseLines(readTail(file))
    // 文件里可能只有历史的一部分（刚被删过、或写失败过），把内存里文件没覆盖的补回来。
    // 键带上 hits / ms：同一秒里两次相同的查询是不同的两件事，不该被去重吃掉。
    const seen = new Set(fileRows.map((row) => `${row.ts}|${row.tool}|${row.query}|${row.hits}|${row.ms}`))
    const merged = fileRows.slice()
    for (const row of buffer) {
      const key = `${row.ts}|${row.tool}|${row.query}|${row.hits}|${row.ms}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
    merged.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))

    const scanned = merged.slice(-TOTALS_MAX)
    const today = localDayOf(stampNow())
    const todayRows = scanned.filter((row) => localDayOf(row.ts) === today)
    const denom = todayRows.filter((row) => typeof row.hits === 'number')
    const scored = denom.filter((row) => row.hits > 0)
    const totals = {
      today,
      calls: todayRows.length,
      hits: scored.length,
      misses: denom.filter((row) => row.hits === 0).length,
      hitRate: denom.length === 0 ? null : scored.length / denom.length,
    }

    const filtered = merged.filter((row) => {
      if (source !== 'all' && row.source !== source) return false
      if (only === 'miss' && row.hits !== 0) return false
      return true
    })
    const size = Math.max(1, Math.min(Math.trunc(Number(limit) || DEFAULT_LIMIT), LIMIT_MAX))
    const rows = filtered.slice(-size).reverse() // 新的在前：表头下面第一行就该是刚才那次
    return { rows, totals, enabled: on, window: merged.length }
  }

  function clear() {
    buffer.length = 0
    lineCount = 0
    if (file === undefined || file === null || file === '') return
    try {
      writeFileSync(file, '')
      warned = false
    } catch (error) {
      warnOnce(error)
    }
  }

  function setEnabled(next) {
    on = next !== false
  }

  return { record, read, clear, setEnabled, enabled: () => on, buffer: () => buffer.slice() }
}

/** 给测试与排查用：账本文件现在有多少行。 */
export function lineCountOf(file) {
  return existsSync(file) ? countLines(file) : 0
}
