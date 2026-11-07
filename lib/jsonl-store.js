/**
 * jsonl-store.js —— 追加写 JSONL 的公共底座。
 *
 * calls.js（调用账本）与 governance.js（观察事件账本）共用同一套
 * 「尾部读 / 追加写 / 轮转」逻辑。抽出来是为了不让两份账本在
 * 「坏行怎么跳、写失败怎么办、什么时候截断」上各走各的。
 *
 * 纪律：写失败一律抛给调用方，由调用方决定 warn 还是静默 ——
 * 账本永远是旁路，不能改变工具返回值。
 */
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'

/** 超过这么多行就轮转。 */
export const MAX_LINES = 5000
/** 轮转后留最后这么多行。 */
export const KEEP_LINES = 2500
/** 尾部读的默认字节数。 */
export const TAIL_BYTES = 262144

/** 读文件尾部；文件不存在或读不了就返回空串，由调用方退回内存缓冲。 */
export function readTail(file, bytes = TAIL_BYTES) {
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

/** 逐行 parse；进程写到一半被杀留下的半行，跳过而不是整页白掉。 */
export function parseLines(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 坏行不进统计，也不影响其它行。
    }
  }
  return rows
}

export function countLines(file) {
  try {
    return parseLines(readFileSync(file, 'utf8')).length
  } catch {
    return 0
  }
}

/** 给测试与排查用：账本文件现在有多少行。 */
export function lineCountOf(file) {
  return existsSync(file) ? countLines(file) : 0
}

/**
 * 建一个 JSONL 账本。同一个文件可以有多个实例（宿主一个、测试一个），
 * 它们各记各的内存缓冲，文件是共享的。
 */
export function createJsonlStore({ file, maxLines = MAX_LINES, keepLines = KEEP_LINES, tailBytes = TAIL_BYTES } = {}) {
  let lineCount = null

  function rotateIfNeeded() {
    if (lineCount === null) lineCount = countLines(file)
    if (lineCount <= maxLines) return
    let kept = []
    try {
      kept = parseLines(readFileSync(file, 'utf8')).slice(-keepLines)
    } catch {
      kept = []
    }
    writeFileSync(file, kept.map((row) => JSON.stringify(row) + '\n').join(''))
    lineCount = kept.length
  }

  function append(entry) {
    if (file === undefined || file === null || file === '') return
    rotateIfNeeded()
    appendFileSync(file, JSON.stringify(entry) + '\n')
    lineCount = (lineCount ?? 0) + 1
  }

  /** 尾部读（调用账本用）：只认最后一段。 */
  function readRows() {
    return parseLines(readTail(file, tailBytes))
  }

  /** 全量读（观察事件账本用）：指标要重放全部事实，不能只看尾巴。 */
  function readAllRows() {
    try {
      return parseLines(readFileSync(file, 'utf8'))
    } catch {
      return readRows()
    }
  }

  function clear() {
    lineCount = 0
    if (file === undefined || file === null || file === '') return
    writeFileSync(file, '')
  }

  /** 写失败后让行数缓存失效，下次 append 重新数一遍。 */
  function invalidate() {
    lineCount = null
  }

  return { append, readRows, readAllRows, clear, invalidate, lineCount: () => lineCount }
}
