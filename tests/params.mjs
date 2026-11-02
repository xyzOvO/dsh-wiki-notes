/**
 * params.mjs —— 把「参数边界」钉死。
 *
 * 这些数字是模型和人都能改的输入，越界不该炸、不该返回一万条。
 * 先钉住现在的行为，再动实现（重构前后都要绿）。
 */

import { fileURLToPath } from 'node:url'
import { loadCorpus } from '../lib/corpus.js'
import { run } from '../lib/engine.js'

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki/', import.meta.url))
const corpus = await loadCorpus(SAMPLE)

let failed = 0
function check(name, ok, detail = '') {
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const search = run(corpus, { mode: 'search', query: '上下文 记忆', limit: 999 })
check('search limit 上限 12', search.hits.length <= 12, `得到 ${search.hits.length}`)

const fallback = run(corpus, { mode: 'search', query: '上下文 记忆', limit: 0 })
check('search limit 0 退回默认 5', fallback.hits.length <= 5, `得到 ${fallback.hits.length}`)

const lean = run(corpus, { mode: 'search', query: '上下文 记忆', limit: 1, sectionChars: 1 })
check('sectionChars 下限 120', (lean.hits[0]?.section.text ?? '').length <= 120,
  `${lean.hits[0]?.section.text?.length ?? 0} 字符`)

const list = run(corpus, { mode: 'list', limit: 999 })
check('list limit 上限 40', list.rows.length <= 40, `得到 ${list.rows.length}`)

const overview = run(corpus, { mode: 'overview', logLimit: 999 })
check('overview logLimit 上限 20', overview.recentLog.length <= 20, `得到 ${overview.recentLog.length}`)

if (failed > 0) {
  process.stderr.write(`params smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log('params smoke 全部通过（6 项边界）')
