/**
 * ab.mjs —— 与现有 search.py 做召回对比。
 *
 * 目标不是「结果完全一致」（那会把算法锁死，再也演进不了），而是**召回不降**：
 * search.py 能进前 5 的页，新引擎也必须能进前 5。漏了任何一页都要解释得出原因。
 *
 * 对照数据来自 tests/ab_baseline.json —— 由 tests/ab_export.py 生成（沙箱禁止
 * node spawn python，所以分两步）：
 *   python tests/ab_export.py > tests/ab_baseline.json
 *   node tests/ab.mjs
 */

import { readFileSync } from 'node:fs'

import { loadCorpus } from '../../lib/corpus.js'
import { search } from '../../lib/engine.js'

const ROOT = (process.env.WIKI_ROOT ?? '')
if (ROOT === '') {
  console.log('跳过：需要 WIKI_ROOT 指向真实库，且已用 ab_export.py 导出 ab_baseline.json')
  process.exit(0)
}
const baseline = JSON.parse(readFileSync(new URL('./ab_baseline.json', import.meta.url), 'utf8'))
const corpus = await loadCorpus(ROOT)

let covered = 0
let missed = 0

for (const [query, pyNames] of Object.entries(baseline)) {
  const mine = search(corpus, query, { limit: 5 }).hits.map((hit) => hit.name)
  const missing = pyNames.filter((name) => !mine.includes(name))
  const extra = mine.filter((name) => !pyNames.includes(name))
  covered += pyNames.length - missing.length
  missed += missing.length

  console.log(`${missing.length === 0 ? '✓' : '✗'} ${query.padEnd(14, ' ')} python: ${pyNames.join(' / ')}`)
  if (missing.length > 0) console.log(`    漏掉 ${missing.join(' / ')}\n    我的 ${mine.join(' / ')}`)
  if (extra.length > 0) console.log(`    新增 ${extra.join(' / ')}`)
}

console.log(`\n召回覆盖 ${covered} / ${covered + missed}（漏 ${missed}）`)
process.exitCode = missed === 0 ? 0 : 2
