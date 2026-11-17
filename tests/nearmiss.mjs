import './support/quiet-ledger.mjs'
/**
 * nearmiss.mjs —— 零命中时给「最接近的几页」，而且不假装它们命中了。
 *
 * 这条通道存在的理由是：命中为空有四种完全不同的原因（词不对 / 中文没分词 /
 * 过滤太窄 / 库里真没有），只回一句「没有命中」，模型分不出是哪一种，只能瞎换词。
 * 所以这里钉的不是「有个数组」，而是四件事：
 *   1. 只有真零命中才出现 —— 有命中时它必须是空数组，绝不能挤掉任何真结果；
 *   2. 覆盖率降序，且带得出来「差多少」；
 *   3. 被过滤条件筛掉的候选要标 filtered —— 「我筛掉了」和「库里没有」是两件事；
 *   4. 渲染进模型能读到的正文里，而不是只活在 JSON 里。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-near-cfg-')), 'wiki-notes.config.json')

const { loadCorpus } = await import('../lib/corpus.js')
const { run } = await import('../lib/engine.js')
const { apply } = await import('../lib/index.js')

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

const root = mkdtempSync(join(tmpdir(), 'wiki-notes-near-'))
const wiki = join(root, 'wiki')
mkdirSync(join(wiki, '概念-concepts'), { recursive: true })
mkdirSync(join(wiki, '资料-sources'), { recursive: true })

writeFileSync(join(wiki, 'index.md'), '- [[逻辑]]：只讲了逻辑两个字\n- [[填空]]：只讲了填空两个字\n')

// 两页各只沾到查询里的一小块 —— 单独看都不足以判「命中」，合起来正好是「差一点」。
writeFileSync(
  join(wiki, '概念-concepts', '逻辑.md'),
  '---\n类型: 概念\n状态: 已提纯\n标签: [示例]\n更新: 2026-01-01\n---\n\n# 逻辑\n\n## 结论\n\n逻辑。\n',
)
writeFileSync(
  join(wiki, '概念-concepts', '填空.md'),
  '---\n类型: 概念\n状态: 已提纯\n标签: [示例]\n更新: 2026-01-02\n---\n\n# 填空\n\n## 结论\n\n填空。\n',
)
writeFileSync(
  join(wiki, '资料-sources', '无关资料.md'),
  '---\n类型: 资料\n状态: 已提纯\n标签: [杂]\n更新: 2026-01-03\n---\n\n# 无关资料\n\n## 讲了什么\n\n天气不错。\n',
)

const corpus = await loadCorpus(wiki)

// 一句话里只有「逻辑」「填空」两个片段在库里出现过，其余全是新词 —— 大概率的零命中现场。
const MISS_QUERY = '逻辑填空技巧方法体系'
const miss = run(corpus, { mode: 'search', query: MISS_QUERY, limit: 5 })

ok('零命中：hits 确实是空的（否则这条测试测的不是它）', () => {
  assert.equal(miss.hits.length, 0, `这条查询居然命中了 ${miss.hits.length} 条，换个更偏的查询`)
})

ok('零命中：nearMiss 给出沾边候选，而不是空手', () => {
  assert.ok(Array.isArray(miss.nearMiss), 'nearMiss 必须是数组')
  assert.ok(miss.nearMiss.length > 0, '零命中却没有任何沾边候选')
  assert.ok(miss.nearMiss.length <= 3, '最多三页，多一个就变成第二份结果列表了')
})

ok('零命中：候选按覆盖率降序，且带得出「差多少」', () => {
  const coverages = miss.nearMiss.map((item) => item.coverage)
  const sorted = [...coverages].sort((a, b) => b - a)
  assert.deepEqual(coverages, sorted, `覆盖率没有降序：${JSON.stringify(coverages)}`)
  for (const item of miss.nearMiss) {
    assert.equal(typeof item.name, 'string')
    assert.ok(item.name !== '')
    assert.ok(Number.isFinite(item.coverage) && item.coverage > 0 && item.coverage <= 100, `覆盖率不合理：${item.coverage}`)
    assert.ok(Array.isArray(item.words), '要带上沾到的是哪几个片段')
  }
})

ok('零命中：候选的覆盖率都在命中线以下（没过的才叫「差一点」）', () => {
  for (const item of miss.nearMiss) {
    assert.ok(item.coverage < 100, `覆盖率 100% 的页不该出现在零命中里：${item.name}`)
  }
})

ok('有命中时 nearMiss 必须是空数组，绝不挤占真结果', () => {
  const hit = run(corpus, { mode: 'search', query: '逻辑', limit: 5 })
  assert.ok(hit.hits.length > 0, '固定查询「逻辑」应当命中')
  assert.deepEqual(hit.nearMiss, [], '有命中还带沾边候选，等于多一份噪音')
})

// 被过滤条件筛掉的候选要标出来：这是「我筛掉了它」和「库里没有它」的分界线。
const filtered = run(corpus, { mode: 'search', query: MISS_QUERY, limit: 5, type: '资料' })
ok('被 type 过滤掉的候选标 filtered，而不是当作不存在', () => {
  assert.equal(filtered.hits.length, 0, '过滤后应当零命中')
  assert.ok(filtered.nearMiss.length > 0, '过滤后零命中，仍要说得出最接近的是哪几页')
  const concept = filtered.nearMiss.find((item) => item.name === '逻辑' || item.name === '填空')
  assert.ok(concept, `没找到被筛掉的候选：${JSON.stringify(filtered.nearMiss)}`)
  assert.equal(concept.filtered, true, '这一页是被 type 过滤筛掉的，必须标出来')
})

// ---- 渲染：候选要进模型读得到的那段文字，不能只活在 JSON 里 ----
const tools = new Map()
apply(
  {
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
  },
  { root: wiki },
)

const textOf = (value) => {
  const tool = tools.get('wiki_recall')
  assert.ok(tool, 'wiki_recall 没有注册')
  const blocks = tool.output.render({}, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 应当返回内容块数组')
  return String(blocks[0].text ?? '')
}

ok('渲染：零命中时把沾边候选写进正文', () => {
  // 真工具链路里 scanned 由宿主补上；这里手写值要带上，否则会走「路径可能不对」那条更早的分支。
  const text = textOf(Object.assign({}, miss, { scanned: corpus.stats.pages }))
  assert.match(text, /最接近的/, `正文没提沾边候选：${text}`)
  for (const item of miss.nearMiss) assert.ok(text.includes(item.name), `正文漏了这一页：${item.name}`)
  assert.match(text, /字面沾边/, '要说清「沾边」不是「命中」')
})

ok('渲染：被过滤的候选要点明是被过滤筛掉的', () => {
  const text = textOf(Object.assign({}, filtered, { scanned: corpus.stats.pages }))
  assert.match(text, /过滤/, `没有点明过滤：${text}`)
})

ok('渲染：有命中时不出现沾边候选那一段', () => {
  const text = textOf(run(corpus, { mode: 'search', query: '逻辑', limit: 5 }))
  assert.ok(!text.includes('最接近的'), `有命中却冒出沾边候选：${text}`)
})

console.log(`\n[nearmiss] 全部通过（${passed} 项）`)
