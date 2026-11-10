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


// 命中片段被截断时要明说：clip 只在真截断时补「…」，而原文自己也可能以省略号结尾，
// 模型只看正文分不出「整节」和「砍了一半的表格」。
const hit = (extra) => ({
  mode: 'search',
  query: '甲',
  hits: [{
    name: '长节页', kind: 'note', type: '概念', status: '稳定', sources: 1, updated: '2026-01-05',
    tags: [], aliases: [], score: 120, allTerms: true, gist: '要点', summary: '摘要',
    section: { title: '细节', text: '甲'.repeat(120) + '…', chars: 2924, truncated: true },
    citation: '← [[长节页]] §细节 → 概念-concepts/长节页.md',
    brokenLinks: [], ...extra,
  }],
})

ok('片段被截断时告诉模型去取整节', () => {
  const text = textOf('wiki_recall', hit())
  assert.match(text, /本节正文已截断/)
  assert.match(text, /2924 字符/)
  assert.match(text, /page 取「长节页」/)
})

ok('没截断时不多印这一行', () => {
  const value = hit()
  value.hits[0].section = { title: '细节', text: '甲'.repeat(120), chars: 120, truncated: false }
  assert.ok(!textOf('wiki_recall', value).includes('本节正文已截断'))
})

// stats.resources 是「类型: 资料」的页数，不是原始资料份数。写成「N 份资料」
// 会让模型把库里的原文数量报小四倍 —— renderOverview 早已改口径，lint 首行是漏网的。
ok('lint 报告首行说「资料页 N 个」，不说「N 份资料」', () => {
  const text = textOf('wiki_recall', {
    mode: 'lint', stats: { pages: 3, resources: 2, scannedMs: 12 }, counts: {},
  })
  assert.match(text, /其中资料页 2 个/, `没标清是页数：${text}`)
  assert.ok(!text.includes('份资料'), `首行仍用「份资料」口径：${text.split('\n')[0]}`)
})

console.log(`\n[render] 全部通过（${passed} 项）`)
