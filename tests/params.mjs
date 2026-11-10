/**
 * params.mjs —— 把「参数边界」钉死。
 *
 * 这些数字是模型和人都能改的输入，越界不该炸、不该返回一万条。
 * 先钉住现在的行为，再动实现（重构前后都要绿）。
 */

import { fileURLToPath } from 'node:url'
import { loadCorpus } from '../lib/corpus.js'
import { run, validateArgs } from '../lib/engine.js'

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki/', import.meta.url))
const corpus = await loadCorpus(SAMPLE)

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
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

// list 的 limit 上限挪到 tests/lint.mjs：那里用 250 页的合成语料测，
// 在样例库上证「≤40」永远是空过（样例库本来不到 40 页）。

const overview = run(corpus, { mode: 'overview', logLimit: 999 })
check('overview logLimit 上限 20', overview.recentLog.length <= 20, `得到 ${overview.recentLog.length}`)

// 「空查询」和「查询切不出字」是两种输入，说法不能一样：
// 前者是他漏了参数，后者是参数在、只是全是标点 —— 都回「query 为空」会让人反复检查自己漏了什么。
const emptyQ = validateArgs('search', { query: '   ' })
check('空查询说「query 为空」', String(emptyQ).includes('query 为空'), String(emptyQ))
const punctQ = validateArgs('search', { query: '???!!!' })
check('全标点查询不说「为空」', !String(punctQ).includes('query 为空'), String(punctQ))
check('全标点查询说「切不出可检索的字」', String(punctQ).includes('切不出可检索的字'), String(punctQ))
check('合法查询不报错', validateArgs('search', { query: '上下文' }) === null)

if (failed > 0) {
  process.stderr.write(`params smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`params smoke 全部通过（${total} 项边界）`)
