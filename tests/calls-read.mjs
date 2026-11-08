/**
 * calls.mjs —— 调用账本的回归。不开 DSH，不依赖本地知识库。
 *
 * 只守三件在设置页「调用记录」上肉眼可见的事：
 *   1. 轮转之后窗口不该被内存缓冲又撑回去；
 *   2. 同一秒内的多次调用，「新的在前」要对；
 *   3. 关闭观察 = 连内存都不收。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALL_FIELDS, createCallLog, normalizeEntry } from '../lib/calls.js'

let passed = 0
function ok(name, fn) {
  try {
    fn()
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`✓ ${name}`)
}

const fresh = () => join(mkdtempSync(join(tmpdir(), 'calls-')), 'calls.jsonl')

ok('轮转后窗口不被内存缓冲撑回去，新的排在最前', () => {
  const file = fresh()
  const log = createCallLog({ file, maxLines: 5, keepLines: 3 })
  for (let i = 0; i < 8; i += 1) {
    log.record({ source: 'model', tool: 'wiki_recall', mode: 'search', query: `q${i}`, hits: i, ms: i, ok: true })
  }
  const view = log.read({ limit: 50 })
  assert.equal(view.rows[0].query, 'q7', '最新一条不最前')
  // 到 maxLines 就先轮转（留最后 keepLines=3 条）再写，所以文件里是 q4..q7；
  // 内存里那批更旧的行不该把窗口再撑回去。
  assert.deepEqual(view.rows.map((row) => row.query), ['q7', 'q6', 'q5', 'q4'])
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 4)
})

ok('写失败才补内存：文件里最后一条之后的不丢', () => {
  const file = fresh()
  const log = createCallLog({ file })
  log.record({ tool: 'wiki_recall', mode: 'search', query: 'a', hits: 1, ms: 1 })
  const before = log.read({ limit: 5 }).rows.length
  assert.equal(before, 1)
  // 直接往内存塞一条「比文件更新」的，模拟写盘失败后只留在内存里的那种
  log.record({ ts: '2999-01-01T00:00:00', tool: 'wiki_recall', mode: 'page', query: 'b', hits: 1, ms: 1 })
  const view = log.read({ limit: 5 })
  assert.equal(view.rows[0].query, 'b')
  assert.equal(view.rows.length, 2)
})

ok('关闭观察：连内存缓冲都不收', () => {
  const file = fresh()
  const log = createCallLog({ file })
  log.setEnabled(false)
  assert.equal(log.record({ tool: 'wiki_recall', mode: 'search', query: 'x', hits: 1, ms: 1 }), null)
  assert.equal(log.buffer().length, 0)
  assert.equal(log.read({ limit: 5 }).rows.length, 0)
})

ok('白名单之外的字段一律不进账本', () => {
  const entry = normalizeEntry({ tool: 'wiki_recall', mode: 'search', query: 'q', hits: 1, ms: 1, page: '资料-sources/x.md', answer: '整段回答' })
  assert.deepEqual(Object.keys(entry), CALL_FIELDS)
  assert.equal(entry.page, undefined)
  assert.equal(entry.answer, undefined)
})

ok('hits 为 null 时不混进命中率分母', () => {
  const entry = normalizeEntry({ tool: 'wiki_context', mode: 'context', hits: null })
  assert.equal(entry.hits, null)
})

console.log(`\n[calls] 全部通过（${passed} 项）`)
