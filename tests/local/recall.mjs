#!/usr/bin/env node
/**
 * recall.mjs —— 带标注的检索质量测试（和 ab.mjs / metrics.mjs 不是一回事）。
 *
 * ab.mjs / metrics.mjs 测的是「和 search.py 有多一致」（parity）：基线是旧引擎的排序，
 * 一致性高不代表检索对，只代表没跑偏。它们还有个结构性上限——只要两边都不命中，
 * 一致性照样 100%，于是评测集一饱和就再也证明不了改进。
 *
 * 这个测的是「该出现的那一页出现了没有」：queries.json 里每条查询都写了 expect
 * （必须进前 5 的页名），由人来标，不依赖任何旧引擎。
 *
 * 三个数字：
 *   Recall@5  micro，命中页数 / 应命中页数
 *   Top-1     首位是否就是首选页
 *   MRR@5     首个命中页的 1/rank，全漏记 0
 *
 * 判定顺序（先中先停）：
 *   没有 WIKI_ROOT            → 跳过
 *   queries.json 缺失          → 跳过（这是本地回归，不是通用用例）
 *   expect 里的页在库里找不到  → LABEL_ERROR（标注错了，先修标注，别怪引擎）
 *   低于 floor                → GATE_FAIL（退步了）
 *   其余                      → PASS
 *
 * floor 在 queries.json 里，只升不降。要往下调必须说明为什么。
 *
 * 用法：WIKI_ROOT="<知识层目录>" node tests/local/recall.mjs [--verbose]
 */

import { readFileSync } from 'node:fs'

import { loadCorpus } from '../../lib/corpus.js'
import { search } from '../../lib/engine.js'

const SKIP = 0
const FAIL = 2
const LABEL = 3

const root = process.env.WIKI_ROOT ?? ''
if (root === '') {
  console.log('跳过：需要 WIKI_ROOT 指向真实库（这是本地回归，不是通用用例）')
  process.exit(SKIP)
}

let suite
try {
  suite = JSON.parse(
    readFileSync(new URL('./queries.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''),
  )
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log('跳过：没有 tests/local/queries.json（本机评测集不进仓库，见 queries.example.json）')
    process.exit(SKIP)
  }
  console.error(`读不了 queries.json：${String(error?.message ?? error)}`)
  process.exit(LABEL)
}

const queries = Array.isArray(suite.queries) ? suite.queries : []
if (queries.length === 0) {
  console.error('queries.json 里没有查询')
  process.exit(LABEL)
}

const corpus = await loadCorpus(root)
const known = new Set(corpus.pages.map((page) => page.name))

// 标错页名是最常见的错误，单独报，别混进指标
const labelErrors = []
for (const item of queries) {
  for (const name of item.expect ?? []) {
    if (!known.has(name)) labelErrors.push(`${item.q} → 「${name}」`)
  }
}
if (labelErrors.length > 0) {
  console.log(`\nLABEL_ERROR：${labelErrors.length} 个 expect 页名在库里不存在`)
  for (const line of labelErrors) console.log(`  ${line}`)
  console.log('\n标注错了，先修 queries.json 再谈指标。')
  process.exit(LABEL)
}

const verbose = process.argv.includes('--verbose')

let expectTotal = 0
let hitTotal = 0
let top1Hit = 0
let mrrSum = 0
const byTag = new Map()
const rows = []

for (const item of queries) {
  const expect = item.expect ?? []
  const mine = search(corpus, item.q, { limit: 5 }).hits.map((hit) => hit.name)

  const ranks = expect.map((name) => {
    const at = mine.indexOf(name)
    return at === -1 ? 0 : at + 1
  })
  const hits = ranks.filter((rank) => rank > 0).length
  const first = ranks.filter((rank) => rank > 0).sort((a, b) => a - b)[0] ?? 0

  expectTotal += expect.length
  hitTotal += hits
  if (expect.length > 0 && mine[0] === expect[0]) top1Hit += 1
  mrrSum += first === 0 ? 0 : 1 / first

  const ok = hits === expect.length
  rows.push({ q: item.q, tags: item.tags ?? [], ok, hits, expect, mine, ranks })

  for (const tag of item.tags ?? ['未分类']) {
    const cell = byTag.get(tag) ?? { expect: 0, hit: 0, queries: 0, okQueries: 0 }
    cell.expect += expect.length
    cell.hit += hits
    cell.queries += 1
    if (ok) cell.okQueries += 1
    byTag.set(tag, cell)
  }
}

const recall = expectTotal === 0 ? 0 : hitTotal / expectTotal
const top1 = queries.length === 0 ? 0 : top1Hit / queries.length
const mrr = queries.length === 0 ? 0 : mrrSum / queries.length
const floor = suite.floor ?? {}

console.log(`\n库 ${corpus.stats.pages} 页　查询 ${queries.length} 条　应命中 ${expectTotal} 页　queries.json ${suite.version ?? '?'}`)
console.log(`${'查询'.padEnd(22)} ${'命'.padStart(3)} ${'首'.padStart(3)}  漏掉的`)

for (const row of rows) {
  const missed = row.expect.filter((name) => !row.mine.includes(name))
  if (!row.ok || verbose) {
    console.log(
      `${row.q.slice(0, 22).padEnd(22)} ${String(row.hits).padStart(2)}/${row.expect.length} ` +
      `${(row.mine[0] === row.expect[0] ? '✓' : '—').padStart(3)}  ${missed.join(' / ') || '（全中）'}`,
    )
    if (!row.ok) console.log(`    我的前五 ${row.mine.join(' / ')}`)
  }
}

console.log(`\n按标签：`)
for (const [tag, cell] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const rate = cell.expect === 0 ? 0 : cell.hit / cell.expect
  console.log(
    `  ${tag.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ` +
    `(${cell.hit}/${cell.expect} 页，${cell.okQueries}/${cell.queries} 条全中)`,
  )
}

console.log('')
console.log(`Recall@5   ${(recall * 100).toFixed(1)}%  (${hitTotal}/${expectTotal} 页)${rate_note(recall, floor.recallAt5)}`)
console.log(`Top-1      ${(top1 * 100).toFixed(1)}%  (${top1Hit}/${queries.length} 条)${rate_note(top1, floor.top1)}`)
console.log(`MRR@5      ${mrr.toFixed(3)}${rate_note(mrr, floor.mrrAt5)}`)

function rate_note(actual, baseline) {
  if (typeof baseline !== 'number' || baseline <= 0) return '  （floor 未设）'
  const delta = actual - baseline
  const sign = delta >= 0 ? '+' : ''
  return `  （floor ${(baseline * 100).toFixed(1)}%，${sign}${(delta * 100).toFixed(1)}pt）`
}

// floor 是按展示精度（3 位小数）记的，比较也按 3 位小数比：
// 45/59 = 0.762711 对 floor 0.763 的裸浮点比较会差 0.0003 判成退步，
// 那是舍入噪声，不是引擎退步。
const r3 = (x) => Math.round(x * 1000) / 1000

const below = []
if (typeof floor.recallAt5 === 'number' && floor.recallAt5 > 0 && r3(recall) < r3(floor.recallAt5)) below.push('Recall@5')
if (typeof floor.top1 === 'number' && floor.top1 > 0 && r3(top1) < r3(floor.top1)) below.push('Top-1')
if (typeof floor.mrrAt5 === 'number' && floor.mrrAt5 > 0 && r3(mrr) < r3(floor.mrrAt5)) below.push('MRR@5')

if (below.length > 0) {
  console.log(`\nGATE_FAIL：${below.join(' / ')} 低于 floor —— 这是引擎退步，别改 floor 迁就它。`)
  process.exit(FAIL)
}

const missCount = rows.filter((row) => !row.ok).length
console.log(`\nPASS　${queries.length - missCount} 条全中，${missCount} 条有漏（漏不代表错，但要能解释）`)
console.log('floor 是地板不是目标：涨了就把 floor 一起抬上去，别让它回落。')
