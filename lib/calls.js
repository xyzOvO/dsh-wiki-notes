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
import { createJsonlStore } from './jsonl-store.js'

export { MAX_LINES, KEEP_LINES, TAIL_BYTES, lineCountOf } from './jsonl-store.js'
import { MAX_LINES, KEEP_LINES } from './jsonl-store.js'

/** 账本只认这 8 个字段。顺序就是表头顺序。 */
export const CALL_FIELDS = ['ts', 'source', 'tool', 'mode', 'query', 'hits', 'ms', 'ok']

/** query 截断长度。一条记录撑到几十 KB 只会有害。 */
export const QUERY_MAX = 120
/** 内存里留最近多少条 —— 文件读不出来时的兜底。 */
export const BUFFER_MAX = 500
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

/**
 * 建一个账本。同一个文件可以有多个实例（宿主一个、测试一个），
 * 它们各记各的内存缓冲，文件是共享的。
 */
export function createCallLog({ file, enabled = true, maxLines = MAX_LINES, keepLines = KEEP_LINES } = {}) {
  const buffer = []
  const store = createJsonlStore({
    file, maxLines, keepLines,
    // 轮转后文件里只剩最后 keepLines 条；内存缓冲若还留着被裁掉的那些，
    // read() 会把它们当「文件缺的行」补回去 —— 窗口越读越长，而且补的是已经不存在的历史。
    onRotate: ({ kept }) => {
      while (buffer.length > kept) buffer.shift()
    },
  })
  let on = enabled !== false
  let warned = false

  function warnOnce(error) {
    if (warned) return
    warned = true
    console.warn('[wiki-notes] 调用记录写不进文件，只保留在内存里：', error?.message ?? error)
  }

  function append(entry) {
    if (file === undefined || file === null || file === '') return
    try {
      store.append(entry)
      warned = false
    } catch (error) {
      // 目录被删、只读、被别的进程占住 —— 都只影响账本，不影响检索。
      // 下次还会再试：用户可能只是临时删掉了文件。
      warnOnce(error)
      store.invalidate()
    }
  }

  function record(raw) {
    // 关闭观察就是明确放弃这段历史：先阻断新事件进入，连内存缓冲也不收。
    // 否则关闭后旧周期仍会有一行「没落盘但留在内存里」的残留，重新打开时又浮出来。
    if (!on) return null
    const entry = normalizeEntry(raw)
    if (entry === null) return null
    buffer.push(entry)
    while (buffer.length > BUFFER_MAX) buffer.shift()
    append(entry)
    return entry
  }

  function read({ limit = DEFAULT_LIMIT, source = 'all', only = 'all' } = {}) {
    const fileRows = store.readRows()
    // 文件里可能只有历史的一部分：要么写盘失败过（缺的是**最新**那几条），
    // 要么被轮转/被外部删掉过（缺的是**更旧**那几条）。两种都要补回来，
    // 但得放对位置 —— 直接往后追加会让旧行排到新行后面（真跑出来的顺序是 q2,q1,q0,q7,q6…）。
    // 键带上 hits / ms：同一秒里两次相同的查询是不同的两件事，不该被去重吃掉。
    const seen = new Set(fileRows.map((row) => `${row.ts}|${row.tool}|${row.query}|${row.hits}|${row.ms}`))
    const firstTs = fileRows.length === 0 ? '' : String(fileRows[0].ts ?? '')
    const missing = []
    for (const row of buffer) {
      const key = `${row.ts}|${row.tool}|${row.query}|${row.hits}|${row.ms}`
      if (seen.has(key)) continue
      seen.add(key)
      missing.push(row)
    }
    // ts 只到秒，所以「同一秒」一律当成更旧（它们先写、文件后写）：宁可让同秒的记录排前面，
    // 也不要让列表撒谎。窗口最大不超过 maxLines —— 否则轮转等于没发生。
    const older = firstTs === '' ? [] : missing.filter((row) => String(row.ts ?? '') <= firstTs)
    const newer = firstTs === '' ? missing : missing.filter((row) => String(row.ts ?? '') > firstTs)
    let merged = [...older, ...fileRows, ...newer]
    if (merged.length > maxLines) merged = merged.slice(-maxLines)
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
    if (file === undefined || file === null || file === '') return
    try {
      store.clear()
      warned = false
    } catch (error) {
      warnOnce(error)
      store.invalidate()
    }
  }

  function setEnabled(next) {
    on = next !== false
  }

  return { record, read, clear, setEnabled, enabled: () => on, buffer: () => buffer.slice() }
}
