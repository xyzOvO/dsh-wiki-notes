/**
 * probe.mjs —— 检索质量的日常探针：同一批查询，攒成一条趋势线。
 *
 * A/B 门禁只回答「现在过不过」，回答不了「这周是在变好还是变坏」：
 * 每次改动只看一个数字，等于没有基线。这里把每次跑的结果追加进 CSV，
 * 一次跑没意义，连起来看才有意义。
 *
 * 用法：
 *   node tools/probe.mjs --queries tests/local/ab_baseline.json --root <你的库根目录>
 *   node tools/probe.mjs --no-save      # 只看这一次，不写趋势文件
 *
 * 查询文件格式：{ "查询词": ["期望的第一页名", "其它相关页名"], ... }
 * 期望页名来自人工确认，不是模型生成的 —— 否则等于自己给自己打分。
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCorpus } from '../lib/corpus.js'
import { search } from '../lib/engine.js'
import { configPath } from '../lib/config.js'
import { DEFAULT_WIKI_ROOT } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'no-save') { out.save = false; continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1 } else { out[key] = true }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const queriesFile = path.resolve(ROOT, args.queries ?? 'tests/local/ab_baseline.json')
if (!existsSync(queriesFile)) {
  console.error(`找不到查询文件：${queriesFile}`)
  console.error('先导一份：{ "查询词": ["期望页名", ...] }')
  process.exit(2)
}

const queries = JSON.parse(readFileSync(queriesFile, 'utf8'))
const DRILL = ['知识层-wiki', '知识层', 'wiki', 'Wiki']

/** 跟插件一样：指到上一层时自动下钻，否则会把原始资料页也算进检索面。 */
function drill(root) {
  if (!root) return root
  for (const name of DRILL) {
    const candidate = path.join(root, name)
    if (existsSync(candidate)) return candidate
  }
  return root
}

const root = drill(args.root ?? process.env.WIKI_ROOT ?? DEFAULT_WIKI_ROOT)
if (!root) {
  console.error('没有库路径：传 --root，或设 WIKI_ROOT，或在设置页里配过')
  process.exit(2)
}

const corpus = await loadCorpus(root)
if (corpus.stats.pages === 0) {
  console.error(`扫不到页面：${root}`)
  process.exit(2)
}

let hit1 = 0
let hit3 = 0
let recalled = 0
let expectedTotal = 0
let ms = 0
const misses = []

for (const [query, expected] of Object.entries(queries)) {
  const started = Date.now()
  const result = search(corpus, query, { limit: 5 })
  ms += Date.now() - started
  const got = (result.hits ?? []).map((hit) => hit.name)
  const want = Array.isArray(expected) ? expected : [expected]
  expectedTotal += want.length
  recalled += got.filter((name) => want.includes(name)).length
  if (got[0] === want[0]) hit1 += 1
  if (got.slice(0, 3).some((name) => want.includes(name))) hit3 += 1
  if (!got.slice(0, 3).some((name) => want.includes(name))) misses.push(`${query} → ${got.slice(0, 3).join(' / ') || '（空）'}`)
}

const n = Object.keys(queries).length
const pct = (value) => `${(value * 100).toFixed(0)}%`
const recall = expectedTotal === 0 ? 1 : recalled / expectedTotal

console.log(`查询 ${n} 条 · 库 ${corpus.stats.pages} 页`)
console.log(`Top-1 一致 ${hit1}/${n}（${pct(hit1 / n)}）`)
console.log(`Top-3 命中 ${hit3}/${n}（${pct(hit3 / n)}）`)
console.log(`Recall@5 ${recalled}/${expectedTotal}（${pct(recall)}）`)
console.log(`平均 ${(ms / n).toFixed(1)} ms/查询`)
if (misses.length > 0) {
  console.log('\nTop-3 未命中：')
  for (const line of misses) console.log(`  · ${line}`)
}

if (args.save !== false) {
  const file = path.join(path.dirname(configPath(ROOT)), 'probe-history.csv')
  const fresh = !existsSync(file)
  mkdirSync(path.dirname(file), { recursive: true })
  if (fresh) appendFileSync(file, 'at,pages,queries,hit1,hit3,recall5,ms_per_query\n')
  const line = [
    new Date().toISOString().slice(0, 19),
    corpus.stats.pages,
    n,
    hit1,
    hit3,
    recall.toFixed(3),
    (ms / n).toFixed(1),
  ].join(',')
  appendFileSync(file, `${line}\n`)
  console.log(`\n已追加一行趋势：${file}`)
}
