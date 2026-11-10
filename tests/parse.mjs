/**
 * parse.mjs —— 正文解析的两个口径：小节切分与双链抽取。
 *
 * 钉的是「围栏代码块里的东西不算正文」：贴一段 markdown / YAML 示例是笔记里最常见的事，
 * 示例里的 `## 标题` 被当成小节、`[[页名]]` 被当成链接，都会让检索把示例当知识。
 */
import './support/quiet-ledger.mjs'
import assert from 'node:assert/strict'
import { extractLinks, splitSections } from '../lib/corpus.js'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

ok('围栏里的 ## 标题不算小节', () => {
  const body = [
    '## 真小节',
    '',
    '正文。',
    '',
    '```markdown',
    '## 示例里的标题',
    '```',
    '',
    '## 后一个小节',
    '',
    '尾巴。',
  ].join('\n')
  const titles = splitSections(body).map((s) => s.title)
  assert.deepEqual(titles, ['真小节', '后一个小节'])
})

ok('围栏里的内容仍留在所属小节正文里（不丢行）', () => {
  const body = ['## 甲', '', '```js', 'const a = 1', '```', '', '尾部。'].join('\n')
  const [section] = splitSections(body)
  assert.match(section.text, /const a = 1/)
  assert.match(section.text, /尾部。/)
})

ok('~~~ 围栏同样生效', () => {
  const body = ['## 甲', '', '~~~', '## 假的', '~~~', '', '## 乙', '', 'x'].join('\n')
  assert.deepEqual(splitSections(body).map((s) => s.title), ['甲', '乙'])
})

ok('未闭合的围栏一直吃到文末（与渲染器一致）', () => {
  const body = ['## 甲', '', '```', '## 这不是标题', '```漏了个收尾'].join('\n')
  assert.deepEqual(splitSections(body).map((s) => s.title), ['甲'])
})

ok('``` 与 ~~~ 混用时各自配对，不互相关闭', () => {
  const body = ['## 甲', '', '```', '~~~', '```', '', '## 乙', '', 'x'].join('\n')
  // 第一段 ``` 里出现的 ~~~ 是内容，不该把围栏关掉，所以「乙」仍是真小节
  assert.deepEqual(splitSections(body).map((s) => s.title), ['甲', '乙'])
})

ok('围栏里的双链不算链接', () => {
  const body = ['真链接 [[甲页]]。', '', '```', '[[示例页]]', '```', '', '行内 `[[行内示例]]` 也不算。'].join('\n')
  assert.deepEqual(extractLinks(body), ['甲页'])
})

ok('~~~ 围栏里的双链也不算链接', () => {
  const body = ['[[真]]', '', '~~~', '[[假]]', '~~~'].join('\n')
  assert.deepEqual(extractLinks(body), ['真'])
})

ok('表格里转义竖线的双链仍能解析', () => {
  assert.deepEqual(extractLinks('| [[甲页\\|显示名]] |'), ['甲页'])
})

console.log(`\n[parse] 全部通过（${passed} 项）`)
