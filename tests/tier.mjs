/**
 * tier.mjs —— 同分时的类型分层（TYPE_TIER）必须把「总览」和「综合」放在同一档。
 *
 * 为什么值得单独钉：2026-11-08 重导 A/B 基线后暴露过一次真退步 ——
 * `错题` 一查询里 `总览-overview` 与某个模块综合页同分，总览落在默认档被挤到第 6，
 * Recall@5 从 70/70 掉到 69/70。这个 bug 不看真实库根本看不出来（样例库没有总览页），
 * 所以这里用合成库把它钉住：分数完全相同时，顺序只由分层和文件名决定。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-tier-cfg-')), 'wiki-notes.config.json')

const { loadCorpus } = await import('../lib/corpus.js')
const { search } = await import('../lib/engine.js')

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

const wiki = mkdtempSync(join(tmpdir(), 'wiki-notes-tier-wiki-'))
const dirs = ['综合-syntheses', '概念-concepts', '实体-entities', '对比-comparisons', '资料-sources']
for (const dir of dirs) mkdirSync(join(wiki, dir), { recursive: true })

/**
 * 造一页：标题里不含探测词（否则会走「标题包含 60」那条通道），
 * 正文里固定出现 5 次 → 正文得分 min(5,12)*3 = 15，所有页同分。
 */
function page({ rel, name, type, status = '演进中', updated = '2026-11-01' }) {
  const front = [
    '---',
    ...(type === null ? [] : [`类型: ${type}`]),
    `别名: []`,
    `标签: []`,
    `来源数量: 1`,
    `状态: ${status}`,
    `创建: 2026-10-01`,
    `更新: ${updated}`,
    '---',
    '',
    `# ${name}`,
    '',
  ]
  // 每行一次，五处；不写进标题/别名/标签，只有正文通道。
  for (let i = 0; i < 5; i += 1) front.push(`第 ${i + 1} 段提到埋点，仅用于同分测试。`)
  front.push('')
  writeFileSync(join(wiki, rel, `${name}.md`), front.join('\n'), 'utf8')
}

page({ rel: '.', name: '总览-overview', type: null }) // 真实库里总览没有「类型」字段
page({ rel: '综合-syntheses', name: '某综合', type: '综合' })
page({ rel: '概念-concepts', name: '某概念', type: '概念' })
page({ rel: '实体-entities', name: '某实体', type: '实体' })
page({ rel: '对比-comparisons', name: '某对比', type: '对比' })
page({ rel: '资料-sources', name: '某资料', type: '资料' })

writeFileSync(join(wiki, 'index.md'), '# 总览\n\n- [[总览-overview]]：合成库（仅供 tier 测试）\n', 'utf8')

const corpus = await loadCorpus(wiki)
const result = search(corpus, '埋点', { limit: 10 })
const order = result.hits.map((hit) => hit.name)

check('六页都命中，分数相同（正文通道 15）', result.hits.length === 6
  && result.hits.every((hit) => hit.score === 15), JSON.stringify(result.hits.map((h) => [h.name, h.score])))
check('总览（无「类型」字段）与「综合」同档，占前两名',
  Math.max(order.indexOf('总览-overview'), order.indexOf('某综合')) === 1, order.join(' → '))
check('总览与综合都排在 概念/实体/对比 之前',
  Math.max(order.indexOf('某综合'), order.indexOf('总览-overview')) < Math.min(order.indexOf('某概念'), order.indexOf('某实体'), order.indexOf('某对比')), order.join(' → '))
check('概念/实体/对比 都排在「资料」之前',
  Math.min(order.indexOf('某概念'), order.indexOf('某实体'), order.indexOf('某对比')) < order.indexOf('某资料'), order.join(' → '))

rmSync(wiki, { recursive: true, force: true })

if (failed > 0) {
  console.error(`tier 测试失败 ${failed} 项 / 共 ${total} 项`)
  process.exit(1)
}
console.log(`tier smoke 全部通过（${total} 项）`)
