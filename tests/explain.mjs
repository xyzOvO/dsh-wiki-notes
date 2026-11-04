/**
 * explain.mjs —— 「解释」必须是既有检索行为的解释，不是第二套检索行为。
 *
 * 面板存在的意义是让人独立检查检索，所以这里钉的不是「解释好不好看」，而是：
 *   - explain 开着和关着，命中名单与分数必须逐条相同（排序不许变）；
 *   - 每条 termHits 的分数加总必须等于该条命中的 score（理由和票数对得上）；
 *   - explain 不在工具 schema 里 —— 模型触发不到，工具输出的 token 不变。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-explain-cfg-')), 'wiki-notes.config.json')

const { loadCorpus } = await import('../lib/corpus.js')
const { run } = await import('../lib/engine.js')
const { apply } = await import('../lib/index.js')

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const wiki = mkdtempSync(join(tmpdir(), 'wiki-notes-explain-wiki-'))
mkdirSync(join(wiki, '概念-concepts'), { recursive: true })
mkdirSync(join(wiki, '资料-sources'), { recursive: true })

writeFileSync(
  join(wiki, 'index.md'),
  [
    '# 总览', '',
    '- [[上下文预算]]：把上下文当预算花，先花在要回答什么上',
    '- [[检索召回]]：召回率与精度的取舍',
    '',
  ].join('\n'),
  'utf8',
)

writeFileSync(
  join(wiki, '概念-concepts', '上下文预算.md'),
  [
    '---', '类型: 概念', '状态: 已提纯', '标签: [上下文, 预算]', '别名: [context budget]', '更新: 2026-02-01', '---',
    '', '# 上下文预算', '', '> 一句话总结：上下文是一种预算。', '',
    '## 结论', '', '上下文预算的核心是排序，不是压缩。上下文 预算 都要算清。', '',
    '## 相关', '', '- [[检索召回]]', '',
  ].join('\n'),
  'utf8',
)

writeFileSync(
  join(wiki, '概念-concepts', '检索召回.md'),
  [
    '---', '类型: 概念', '状态: 已提纯', '标签: [检索]', '更新: 2026-01-01', '---',
    '', '# 检索召回', '', '## 讲了什么', '', '召回靠全量扫描，上下文 只是顺带提到一次。', '',
  ].join('\n'),
  'utf8',
)

writeFileSync(
  join(wiki, '资料-sources', '某课程·资料摘要.md'),
  [
    '---', '类型: 资料', '状态: 已提纯', '标签: [课程]', '更新: 2026-01-15', '---',
    '', '# 某课程·资料摘要', '', '## 讲了什么', '', '把上下文当预算讲了一遍，预算这个词反复出现。上下文 上下文 上下文。', '',
  ].join('\n'),
  'utf8',
)

const corpus = await loadCorpus(wiki)

const QUERIES = ['上下文', '上下文 预算', '预算 召回', '不存在词', 'context budget', '预算']

for (const query of QUERIES) {
  const plain = run(corpus, { mode: 'search', query, limit: 12 })
  const explained = run(corpus, { mode: 'search', query, limit: 12, explain: true })

  const shape = (result) => result.hits.map((hit) => `${hit.name}|${hit.score}|${hit.allTerms}`)
  check(
    `[${query}] explain 开关前后命中与分数逐条一致`,
    JSON.stringify(shape(plain)) === JSON.stringify(shape(explained)),
    `\n  关: ${JSON.stringify(shape(plain))}\n  开: ${JSON.stringify(shape(explained))}`,
  )

  check(`[${query}] 关掉时不带 termHits`, plain.hits.every((hit) => hit.termHits === undefined))
  check(`[${query}] 打开时每条都带 termHits`, explained.hits.every((hit) => Array.isArray(hit.termHits)))

  // 理由加总 == 票数：这是「同一份数据摊开」而不是「另算一遍」的硬证据
  const sumsOk = explained.hits.every((hit) => {
    const sum = hit.termHits.reduce((acc, term) => acc + term.score, 0)
    return sum === hit.score
  })
  check(`[${query}] termHits 分数之和等于该条 score`, sumsOk,
    JSON.stringify(explained.hits.map((hit) => [hit.name, hit.score, hit.termHits.map((term) => term.score)])))

  // 每个词都要有一条记录（没得分也留），否则面板看不出是哪个词掉了
  check(`[${query}] termHits 覆盖全部检索词`,
    explained.hits.every((hit) => hit.termHits.length === explained.tokens.length),
    JSON.stringify(explained.hits.map((hit) => hit.termHits.length)))
}

// 通道标注的具体性：页名命中必须是 name，正文命中必须带 count
const named = run(corpus, { mode: 'search', query: '上下文预算', explain: true })
check('页名全等时通道是 name', named.hits[0]?.termHits?.[0]?.parts?.[0]?.via === 'name',
  JSON.stringify(named.hits[0]?.termHits))

const body = run(corpus, { mode: 'search', query: '排序', explain: true })
const bodyParts = body.hits[0]?.termHits?.[0]?.parts ?? []
check('正文通道带命中次数', bodyParts.some((part) => part.via === 'body' && typeof part.count === 'number'),
  JSON.stringify(bodyParts))

// 工具 schema 里不许出现 explain：模型看不到这个开关，输出 token 就不变
const registered = []
const ctx = {
  logger: { info() {}, warn() {} },
  on: () => {},
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
}
apply(ctx, { root: wiki })
const schemaText = JSON.stringify(registered[0]?.parameters ?? {})
check('工具参数里没有 explain', !schemaText.includes('explain'), schemaText.slice(0, 200))

// 走工具那条路（模型真实路径）时，输出里也不该多出理由
const viaTool = await registered[0].execute({ mode: 'search', query: '上下文' }, {})
check('工具返回里没有 termHits', JSON.stringify(viaTool).includes('termHits') === false)

// ---- 查询诊断：引擎实际怎么理解这串词 ----
// 这三项回答「结果为空该怪词、怪库，还是怪匹配模式」，面板和模型看到的是同一份。
const mixed = run(corpus, { mode: 'search', query: '上下文 玄武', explain: true })
check(
  'termPages 一个词一条',
  Array.isArray(mixed.termPages) && mixed.termPages.length === mixed.tokens.length,
  JSON.stringify(mixed.termPages),
)
check(
  'termPages 的页数是非负整数',
  (mixed.termPages ?? []).every((item) => Number.isInteger(item.pages) && item.pages >= 0),
  JSON.stringify(mixed.termPages),
)
check('missedTerms 只剩那个一页没沾到的词', JSON.stringify(mixed.missedTerms) === JSON.stringify(['玄武']),
  JSON.stringify(mixed.missedTerms))
check('没有全词命中时 matchMode 是 or', mixed.matchMode === 'or' && mixed.degraded === true, mixed.matchMode)

const andOnly = run(corpus, { mode: 'search', query: '上下文', explain: true })
check('全词命中时 matchMode 是 and', andOnly.matchMode === 'and' && andOnly.degraded === false, andOnly.matchMode)
check('termPages 只在 explain 时出现（模型输出不多这个字段）',
  run(corpus, { mode: 'search', query: '上下文' }).termPages === undefined)
check(
  'missedTerms / matchMode 走工具路径也在',
  typeof viaTool.missedTerms !== 'undefined' && typeof viaTool.matchMode === 'string',
  JSON.stringify({ missedTerms: viaTool.missedTerms, matchMode: viaTool.matchMode }),
)


rmSync(wiki, { recursive: true, force: true })

if (failed > 0) {
  process.stderr.write(`explain smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`\nexplain smoke 全部通过（${total} 项）`)
