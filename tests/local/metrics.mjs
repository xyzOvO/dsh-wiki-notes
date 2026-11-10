#!/usr/bin/env node
/**
 * metrics.mjs —— 与 python 基线的一致性指标（定义见 docs/metrics.md）。
 *
 * 三个数字：Recall@5（micro）、Top-1 一致率、Top-5 Jaccard（macro）。
 * 它们测的是「和 search.py 有多一致」，不是「检索得准不准」。
 *
 * 判定顺序（先中先停）：
 *   没有 WIKI_ROOT            → 跳过
 *   元数据缺失 / 无指纹        → BASELINE_STALE
 *   指纹不一致                → BASELINE_STALE（库内容或指纹算法变了，先重导基线，别怪算法）
 *
 * 指纹由 tests/local/library-fingerprint.mjs 计算，recall.mjs 用的是同一个函数：
 * 量的是「检索真正读到的内容」（正文 / frontmatter / index 摘要 / 规模行），
 * 不是只量正文长度 —— 等长改写曾经让基线悄悄失效过。
 *   指纹一致但 Recall < 100%   → GATE_FAIL（算法退步，逐条解释漏项）
 *   其余                      → PASS
 *
 * 用法：WIKI_ROOT="<知识层目录>" node tests/local/metrics.mjs
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { loadCorpus } from '../../lib/corpus.js'
import { search } from '../../lib/engine.js'
import { fingerprintOf } from './library-fingerprint.mjs'

const HERE = new URL('./', import.meta.url)

const STALE = 3
const FAIL = 2

function readJson(url, label) {
  try {
    // Windows 上 `python ab_export.py > ab_baseline.json` 会写成 UTF-16LE 或带 BOM，
    // 直接 JSON.parse 会报 Unexpected token。这里统一去掉 BOM 再解析。
    return JSON.parse(readFileSync(url, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    console.error(`读不了 ${label}：${String(error?.message ?? error)}`)
    process.exit(STALE)
  }
}

function engineCommit() {
  // 沙箱可能禁止 spawn：拿不到就写 unknown，不因为版本信息缺失而失败
  try {
    const out = spawnSync('git', ['log', '-1', '--format=%h', '--', 'lib/engine.js'], { encoding: 'utf8' })
    const line = String(out?.stdout ?? '').trim()
    return line === '' ? 'unknown' : line
  } catch {
    return 'unknown'
  }
}

function stale(reason) {
  console.log(`\nBASELINE_STALE：${reason}`)
  console.log('库和基线对不上，这次不出指标。先复核是「库内容变了」还是「指纹算法变了」：')
  console.log('  · 只是指纹算法升级（库没动）→ 排序没变，ab_baseline.json 不用重导，')
  console.log('    只把 meta 的 library.fingerprint 和 queries.json 的 libraryFingerprint 改成新值。')
  console.log('  · 库内容真的变了 → 重新导出基线：')
  console.log('    AB_QUERIES=... WIKI_TOOLS_DIR=... python tests/local/ab_export.py | Out-File -Encoding utf8 tests/local/ab_baseline.json')
  console.log('    （PowerShell 的 > 默认写 UTF-16，会写出 readJson 读不了的 JSON）')
  console.log('    然后更新 meta 的 library.fingerprint，并按新库重新标定 queries.json 的 floor / floorNote。')
  console.log('\n这不是算法失败 —— 参照系过期了，就该先把参照系对齐。')
  process.exit(STALE)
}

const root = process.env.WIKI_ROOT ?? ''
if (root === '') {
  console.log('跳过：需要 WIKI_ROOT 指向真实库（这是本地回归，不是通用用例）')
  process.exit(0)
}

const baseline = readJson(new URL('ab_baseline.json', HERE), 'ab_baseline.json')
if (baseline === null || Object.keys(baseline).length === 0) stale('基线缺失或为空')
const meta = readJson(new URL('ab_baseline.meta.json', HERE), 'ab_baseline.meta.json')
if (meta === null) stale('缺少 ab_baseline.meta.json，无法确认基线对应哪份库')
const expected = meta?.library?.fingerprint
if (typeof expected !== 'string' || expected === '') stale('meta 里没有 library.fingerprint')

const corpus = await loadCorpus(root)
const actual = fingerprintOf(corpus)
if (actual !== expected) {
  stale(`库指纹不一致：基线 ${expected} / 当前 ${actual}（${corpus.stats.pages} 页）`)
}

// 已知分歧白名单：原因已查清、不打算改回去的查询（见 parity-exceptions.json）。
// 它们不参与对齐分母，但逐条打印「豁免」—— 白名单是记账，不是眼罩。
const exceptions = readJson(new URL('parity-exceptions.json', HERE), 'parity-exceptions.json')
const exempt = new Set((exceptions?.queries ?? []).map((item) => item.q))

const known = new Set(corpus.pages.map((page) => page.name))
const queries = Object.keys(baseline)

let denom = 0
let hitSum = 0
let missingFromLibrary = 0
let top1Matches = 0
let top1Base = 0
let jaccardSum = 0

console.log(`\n引擎 ${engineCommit()}（基线冻结时 ${meta?.engine?.commit ?? '?'}）　库指纹 ${actual}　${corpus.stats.pages} 页`)
console.log(`${'查询'.padEnd(16)} ${'B'.padStart(2)} ${'M'.padStart(2)} ${'交'.padStart(2)} ${'首位'.padStart(4)} ${'J'.padStart(6)} ${'漏'.padStart(2)} ${'缺页'.padStart(4)}`)

for (const query of queries) {
  const base = Array.isArray(baseline[query]) ? baseline[query] : []
  const mine = search(corpus, query, { limit: 5 }).hits.map((hit) => hit.name)

  const baseSet = new Set(base)
  const mineSet = new Set(mine)
  const inter = [...baseSet].filter((name) => mineSet.has(name)).length
  const union = new Set([...baseSet, ...mineSet]).size
  const jaccard = union === 0 ? 1 : inter / union
  const gone = base.filter((name) => !known.has(name)).length
  const top1 = base.length > 0 && base[0] === mine[0]

  if (exempt.has(query)) {
    console.log(`${query.padEnd(16)}  ◦ 已知分歧，不计入（差 ${baseSet.size - inter} 页）`)
    continue
  }

  denom += baseSet.size
  hitSum += inter
  missingFromLibrary += gone
  jaccardSum += jaccard
  if (base.length > 0) top1Base += 1
  if (top1) top1Matches += 1

  console.log(
    `${query.padEnd(16)} ${String(baseSet.size).padStart(2)} ${String(mineSet.size).padStart(2)} ` +
    `${String(inter).padStart(2)} ${(top1 ? '✓' : '—').padStart(4)} ${jaccard.toFixed(2).padStart(6)} ` +
    `${String(baseSet.size - inter).padStart(2)} ${String(gone).padStart(4)}`,
  )
}

const recall = denom === 0 ? 0 : hitSum / denom
const top1Rate = top1Base === 0 ? 0 : top1Matches / top1Base
const top5Jaccard = queries.length === 0 ? 0 : jaccardSum / queries.length
const gate = recall >= 1 ? 'PASS' : 'GATE_FAIL'

console.log('')
console.log(`missingFromLibrary  ${missingFromLibrary}`)
console.log(`recallMisses        ${denom - hitSum} / ${denom}`)
console.log(`Recall@5            ${(recall * 100).toFixed(1)}%  (${hitSum}/${denom} 槽)`)
console.log(`top1Matches         ${top1Matches} / ${top1Base} 查询`)
console.log(`Top-1 一致率        ${(top1Rate * 100).toFixed(1)}%`)
console.log(`top5Jaccard         ${top5Jaccard.toFixed(3)}  (macro)`)
console.log(`gate                ${gate}`)

if (gate !== 'PASS') {
  console.log('\n指纹一致却漏槽 —— 这是引擎侧的问题，请逐条解释上面「漏」> 0 的查询。')
  if (missingFromLibrary > 0) {
    console.log(`注意：其中有 ${missingFromLibrary} 个基线页名已不在当前库（见「缺页」列）—— 那是基线该重导的信号，不是算法锅。`)
  }
  process.exit(FAIL)
}

console.log('\n基线是测量工具，不是优化目标：不要为了让这些数字好看去改库或改查询集。')
