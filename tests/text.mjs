/**
 * text.mjs —— clipChars 是「所有按长度截断」的唯一入口，
 * 这里钉住它最关键的一条性质：绝不产出孤立代理（半个表情 / 半个扩展区汉字）。
 */
import './support/quiet-ledger.mjs'
import assert from 'node:assert/strict'
import { clipChars } from '../lib/text.js'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

ok('短于上限时原样返回', () => {
  assert.equal(clipChars('上下文工程', 10), '上下文工程')
  assert.equal(clipChars('abc', 3), 'abc')
})

ok('纯 ASCII 按字数切', () => {
  assert.equal(clipChars('abcdef', 4), 'abcd')
})

ok('切点落在表情中间时退一格，不切半个', () => {
  // '😀' 占 2 个码元；上限 3 → 切点前一个码元是第一个表情的低位代理
  const text = '😀😀😀'
  const out = clipChars(text, 3)
  assert.equal(lone.test(out), false)
  assert.equal(out, '😀')
})

ok('扩展 B 区汉字（如 𠮷）同样不被切开', () => {
  const out = clipChars('𠮷𠮷𠮷', 5)
  assert.equal(lone.test(out), false)
  assert.equal(out.length <= 5, true)
})

ok('上限 0 或负数返回空串，而不是整段', () => {
  assert.equal(clipChars('上下文', 0), '')
  assert.equal(clipChars('上下文', -1), '')
})

ok('非字符串输入不抛', () => {
  assert.equal(clipChars(null, 5), '')
  assert.equal(clipChars(undefined, 5), '')
  assert.equal(clipChars(42, 5), '42')
})

ok('上限为小数时向下取整', () => {
  assert.equal(clipChars('abcdef', 3.9), 'abc')
})

console.log(`\n[text] 全部通过（${passed} 项）`)
