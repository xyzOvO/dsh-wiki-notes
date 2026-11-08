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
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'

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

/**
 * 数「物理行」，不是「能解析的行」。
 *
 * 轮转看的是文件会不会无限长，所以坏行也算一行 —— 否则一份满是坏行的账本
 * 永远数出 0 行，轮转一辈子不触发。
 */
export function countPhysicalLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length
  } catch {
    return 0
  }
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
export function createJsonlStore({ file, maxLines = MAX_LINES, keepLines = KEEP_LINES, tailBytes = TAIL_BYTES, onRotate = null } = {}) {
  let lineCount = null

  function rotateIfNeeded() {
    if (lineCount === null) lineCount = countPhysicalLines(file)
    // 到 maxLines 就先轮转再写：这样文件永远不超过 maxLines。
    // （原来写的是 `<=`，于是 5000 行上限实际会先长到 5001 行才收。）
    if (lineCount < maxLines) return
    let kept = []
    try {
      kept = parseLines(readFileSync(file, 'utf8')).slice(-keepLines)
    } catch {
      kept = []
    }
    // 先写临时文件再 rename：账本被清空一半比不轮转更糟（并发读的人要么看到旧的、要么看到新的）。
    const tmp = `${file}.tmp`
    writeFileSync(tmp, kept.map((row) => JSON.stringify(row) + '\n').join(''))
    renameSync(tmp, file)
    lineCount = kept.length
    // 轮转把更旧的行从文件里裁掉了。调用方若还把它们留在内存缓冲里，
    // 展示时又会补回列表（窗口越读越长，还都是已经不存在于账本里的行）——
    // 所以这里给一个钩子，让它能同步裁掉自己那份副本。
    if (typeof onRotate === 'function') {
      try {
        onRotate({ kept: kept.length, maxLines, keepLines })
      } catch {
        // 钩子出错不能连带把记账搞坏
      }
    }
  }

  /**
   * 文件是不是以换行结尾。
   *
   * 上一次写到一半被 kill 时，最后那行没有换行符；直接 append 会把新记录
   * 粘在坏行后面（`{"broken":{"ok":3}`）——**坏行毁掉的是新写进去的那条**，
   * 而它正是唯一还在内存里的。所以写之前先补一个换行，让坏行自己坏掉。
   */
  function endsWithNewline() {
    try {
      const size = statSync(file).size
      if (size === 0) return true
      const fd = openSync(file, 'r')
      try {
        const one = Buffer.alloc(1)
        readSync(fd, one, 0, 1, size - 1)
        return one[0] === 0x0a
      } finally {
        closeSync(fd)
      }
    } catch {
      return true
    }
  }

  function append(entry) {
    if (file === undefined || file === null || file === '') return
    rotateIfNeeded()
    const prefix = endsWithNewline() ? '' : '\n'
    appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`)
    lineCount = Math.min((lineCount ?? 0) + 1, maxLines)
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
