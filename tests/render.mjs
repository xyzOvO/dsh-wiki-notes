import './support/quiet-ledger.mjs'
/**
 * render.mjs —— 三个网关工具的错误渲染回归。
 *
 * 为什么要单测这件事：Bridge 的错误信封是 {kind:'error', error:{code,message}} —— 比别处多一层。
 * 取错层不会抛异常、也不会让测试变红，只会让模型看到「失败：? — 」，等于把原因吞掉。
 * 所以这里不测 Python，只测「拿到信封之后怎么说话」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

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

const root = mkdtempSync(join(tmpdir(), 'wiki-render-'))
const wiki = join(root, 'wiki')
mkdirSync(join(wiki, '概念-concepts'), { recursive: true })
writeFileSync(join(wiki, 'index.md'), '- [[甲]] — 摘要（1 份资料，更新于 2026-01-05）\n')
writeFileSync(join(wiki, 'log.md'), '## [2026-01-05] init | 初始化\n')
writeFileSync(
  join(wiki, '概念-concepts/甲.md'),
  '---\n类型: 概念\n别名: [甲别名]\n标签: [x]\n来源数量: 1\n状态: 稳定\n创建: 2026-01-01\n更新: 2026-01-05\n---\n\n# 甲\n\n## 定义\n\n正文。\n',
)

const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {} },
  on() {},
  sessions: { scopeOf: () => 'test-session' },
  webServer: { register: () => () => {} },
  systemPrompt: { context: () => () => {} },
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
}
apply(ctx, { root: wiki })

const envelope = {
  kind: 'error',
  contract_version: '1.0',
  bridge_version: '0.1.0',
  error: { code: 'E_PYTHON_UNAVAILABLE', message: '找不到 Python 解释器', stage: 'bridge', retryable: false, detail: null },
}

const textOf = (name, value) => {
  const tool = tools.get(name)
  assert.ok(tool, `${name} 没有注册`)
  const blocks = tool.output.render({}, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 应当返回内容块数组')
  return String(blocks[0].text ?? '')
}

for (const name of ['wiki_context', 'wiki_verify', 'wiki_observe']) {
  ok(`${name} 渲染错误信封时要说清 code 与 message`, () => {
    const text = textOf(name, envelope)
    assert.match(text, /E_PYTHON_UNAVAILABLE/, `没带上错误码：${text}`)
    assert.match(text, /找不到 Python 解释器/, `没带上原因：${text}`)
    assert.ok(!text.includes('? —'), `错误码被渲染成问号：${text}`)
  })
}

ok('扁平信封（error 里直接放 code/message）也认', () => {
  const flat = { kind: 'error', error: { code: 'E_X', message: '扁平写法' } }
  assert.match(textOf('wiki_context', flat), /E_X — 扁平写法/)
})

ok('只有 code 没有 message 时不留下空破折号', () => {
  const bare = { kind: 'error', error: { error: { code: 'E_BRIDGE_TIMEOUT' } } }
  const text = textOf('wiki_verify', bare)
  assert.match(text, /E_BRIDGE_TIMEOUT/)
  assert.ok(!text.includes('— '), `多印了空原因：${text}`)
})

console.log(`\n[render] 全部通过（${passed} 项）`)
