/**
 * store.mjs —— 两份账本共用的 JSONL 底座。
 *
 * 钉的是「账本轮转不许吃掉正在写的那条，也不许把文件写坏」：
 *   - 到 maxLines 就先轮转再写，文件永远不超过 maxLines；
 *   - 轮转走临时文件 + rename，崩在半路也不会留下半个账本；
 *   - 坏行不参与统计，但**参与**轮转计数（否则满盘坏行永远不触发轮转）；
 *   - 尾部读按字节截断时会切在行中间，那一行丢掉即可，后面的必须完好。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createJsonlStore, readTail, parseLines, countPhysicalLines, MAX_LINES, KEEP_LINES, TAIL_BYTES } from '../lib/jsonl-store.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-store-'))
let n = 0
const newFile = () => path.join(tmp, `f${(n += 1)}.jsonl`)
const readRows = (file) => parseLines(readFileSync(file, 'utf8'))

// 1. 到 maxLines 就轮转：maxLines=5 时第 6 次写会先收成 keepLines=2 行，再追加一条
{
  const file = newFile()
  const store = createJsonlStore({ file, maxLines: 5, keepLines: 2 })
  for (let i = 0; i < 5; i += 1) store.append({ i })
  assert.equal(readRows(file).length, 5)
  store.append({ i: 5 })
  const rows = readRows(file)
  assert.deepEqual(rows.map((r) => r.i), [3, 4, 5], '轮转后应剩 keepLines 条 + 刚写的一条')
}

// 2. 连写 40 条，文件长度任何时候都不超过 maxLines
{
  const file = newFile()
  const store = createJsonlStore({ file, maxLines: 5, keepLines: 3 })
  let worst = 0
  for (let i = 0; i < 40; i += 1) {
    store.append({ i })
    worst = Math.max(worst, readRows(file).length)
  }
  assert.equal(worst, 5, `文件长到过 ${worst} 行，超过上限`)
  assert.equal(readRows(file).at(-1).i, 39)
}

// 3. 轮转不留临时文件
{
  const file = newFile()
  const store = createJsonlStore({ file, maxLines: 3, keepLines: 2 })
  for (let i = 0; i < 8; i += 1) store.append({ i })
  const leftovers = readdirSync(tmp).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `轮转留下了临时文件：${leftovers.join(',')}`)
}

// 4. 满盘坏行也要轮转（按物理行计数，不是「能解析的行」）
{
  const file = newFile()
  writeFileSync(file, Array.from({ length: 6 }, (_, i) => `garbage ${i}\n`).join(''))
  assert.equal(countPhysicalLines(file), 6)
  const store = createJsonlStore({ file, maxLines: 5, keepLines: 2 })
  store.append({ ok: true })
  assert.deepEqual(readRows(file), [{ ok: true }], '坏行没被清掉，说明轮转没按物理行触发')
}

// 5. 尾部读切在行中间：丢掉半行，后面的行完好
{
  const file = newFile()
  let blob = ''
  for (let i = 0; i < 200; i += 1) blob += JSON.stringify({ i, pad: 'p'.repeat(40) }) + '\n'
  writeFileSync(file, blob)
  const tail = readTail(file, 500)
  assert.ok(!tail.startsWith('{"'), '这段尾巴应该从某行中间开始')
  const rows = parseLines(tail)
  assert.ok(rows.length >= 5, `尾部读只拿到 ${rows.length} 行`)
  assert.equal(rows.at(-1).i, 199, '最后一行必须完整')
  assert.equal(parseLines(readTail(file, TAIL_BYTES)).length, 200)
}

// 6. 文件不存在 / 空文件：返回空串，不抛
{
  assert.equal(readTail(path.join(tmp, 'nope.jsonl')), '')
  const empty = newFile()
  writeFileSync(empty, '')
  assert.equal(readTail(empty), '')
  assert.deepEqual(parseLines(''), [])
}

// 7. 写到一半被杀：末尾半行跳过，已有的不动
{
  const file = newFile()
  writeFileSync(file, '{"ok":1}\n{"ok":2}\n{"broken":')
  const store = createJsonlStore({ file })
  assert.deepEqual(store.readAllRows(), [{ ok: 1 }, { ok: 2 }])
  store.append({ ok: 3 })
  assert.deepEqual(readRows(file).map((r) => r.ok), [1, 2, 3])
}

// 8. clear() 真的清空，并把行数缓存归零
{
  const file = newFile()
  const store = createJsonlStore({ file, maxLines: 5, keepLines: 2 })
  store.append({ a: 1 })
  store.append({ a: 2 })
  store.clear()
  assert.equal(readFileSync(file, 'utf8'), '')
  store.append({ a: 3 })
  assert.deepEqual(readRows(file), [{ a: 3 }])
}

// 9. 没给 file：记账不出错，读回来是空
{
  const store = createJsonlStore({})
  store.append({ a: 1 })
  assert.deepEqual(store.readRows(), [])
}

// 10. 默认上限就是文档里那几个数
{
  assert.equal(MAX_LINES, 5000)
  assert.equal(KEEP_LINES, 2500)
  assert.equal(TAIL_BYTES, 262144)
}

console.log('[store] 全部通过（10 项）')
