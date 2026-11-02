/**
 * status.mjs —— 状态机与覆盖口径的回归。不开 DSH，不依赖本地知识库。
 *
 * 为什么用合成 corpus：decideStatus 是纯函数，喂假数据就能覆盖「一页都没读出来」
 * 「根目录不存在」这类在 Windows 上很难稳定造出来的文件系统情形；
 * 真文件系统只用来断言那条文件级恒等式。
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { decideStatus, run } from '../lib/engine.js'
import { classifyFsError, loadCorpus } from '../lib/corpus.js'

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki/', import.meta.url))

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

/** 最小 corpus：stats 只写关心的字段，其余补零，避免测试依赖真实库。 */
function fakeCorpus({ pages = [], stats = {} } = {}) {
  return {
    pages,
    byName: new Map(pages.map((page) => [page.name, page])),
    byAlias: new Map(),
    indexLines: [],
    log: [],
    brokenLinks: [],
    stats: {
      pages: pages.length,
      discovered: pages.length,
      skipped: 0,
      unreadable: 0,
      oversized: 0,
      walkFailures: 0,
      statFailures: 0,
      failuresTotal: 0,
      failures: [],
      ...stats,
    },
  }
}

const PAGE = {
  name: '上下文工程',
  file: '概念-concepts/上下文工程.md',
  fields: { 类型: '概念', 状态: '已提纯', 标签: ['agent'], 更新: '2026-11-01', 来源数量: 3 },
  sections: [{ title: '定义', text: '上下文工程说的是怎么把有限预算花在刀刃上。' }],
  body: '# 上下文工程\n\n## 定义\n\n上下文工程说的是怎么把有限预算花在刀刃上。',
  links: [],
  oversized: false,
}

/* ------------------------------ 正常路径 ------------------------------ */

ok('正常命中 → ok，且 ok 时不带 warnings 键（正常路径零额外 token）', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '上下文' })
  assert.equal(value.status, 'ok')
  assert.equal(Object.hasOwn(value, 'warnings'), false)
})

ok('正常库但没有这个词 → no_match', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '量子计算' })
  assert.equal(value.status, 'no_match')
  assert.equal(value.total, 0)
})

ok('只命中部分检索词 → degraded（不是 no_match）', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '上下文 量子' })
  assert.equal(value.status, 'degraded')
  assert.equal(value.degraded, true)
})

/* ---------------------------- 覆盖类状态 ---------------------------- */

ok('有页读失败 → partial', () => {
  const corpus = fakeCorpus({
    pages: [PAGE],
    stats: {
      pages: 1,
      discovered: 2,
      unreadable: 1,
      failures: [{ path: '坏页.md', stage: 'read', code: 'EACCES' }],
    },
  })
  const verdict = decideStatus(corpus, 'search', { query: '上下文' }, { hits: [{}], total: 1 })
  assert.equal(verdict.status, 'partial')
  assert.match(verdict.warnings[0], /1 页读取失败/)
  assert.match(verdict.warnings[0], /共 2 页中 1 页可用/)
})

ok('pages=0 且 unreadable>0 → partial，不能被 unavailable 抢先（锁定修正一）', () => {
  const corpus = fakeCorpus({
    pages: [],
    stats: {
      pages: 0,
      discovered: 3,
      unreadable: 3,
      failures: [
        { path: 'a.md', stage: 'read', code: 'EACCES' },
        { path: 'b.md', stage: 'read', code: 'EPERM' },
        { path: 'c.md', stage: 'parse', code: 'UNKNOWN' },
      ],
    },
  })
  const verdict = decideStatus(corpus, 'search', { query: '任何词' }, { hits: [] })
  assert.equal(verdict.status, 'partial')
  assert.ok(verdict.warnings.some((line) => line.includes('0 页可用')))
})

ok('一页都没扫到 → unavailable（路径问题）', () => {
  const verdict = decideStatus(fakeCorpus(), 'search', { query: 'x' }, { hits: [] })
  assert.equal(verdict.status, 'unavailable')
})

ok('根目录不存在（ENOENT）→ unavailable，说路径指错了层', () => {
  const corpus = fakeCorpus({
    stats: {
      pages: 0,
      discovered: 0,
      walkFailures: 1,
      failures: [{ path: '.', stage: 'walk', code: 'ENOENT' }],
    },
  })
  const verdict = decideStatus(corpus, 'search', { query: 'x' }, { hits: [] })
  assert.equal(verdict.status, 'unavailable')
  assert.match(verdict.warnings.join('\n'), /路径可能指错了层/)
})

ok('子目录列不出来、一页都没有 → partial（是权限，不是路径）', () => {
  const corpus = fakeCorpus({
    stats: {
      pages: 0,
      discovered: 0,
      walkFailures: 1,
      failures: [{ path: '概念-concepts', stage: 'walk', code: 'EACCES' }],
    },
  })
  const verdict = decideStatus(corpus, 'search', { query: 'x' }, { hits: [] })
  assert.equal(verdict.status, 'partial')
  assert.ok(verdict.warnings.some((line) => line.includes('目录列不出来')))
})

ok('扫到文件但全是 index/log → unavailable（不是 no_match）', () => {
  const corpus = fakeCorpus({ stats: { pages: 0, discovered: 2, skipped: 2 } })
  const verdict = decideStatus(corpus, 'overview', {}, {})
  assert.equal(verdict.status, 'unavailable')
})

ok('overview 在没有页面时也不会变成 no_match（总览没有「没命中」这回事）', () => {
  const corpus = fakeCorpus({ pages: [PAGE] })
  const verdict = decideStatus(corpus, 'overview', {}, {})
  assert.equal(verdict.status, 'ok')
})

/* ------------------------- 超大页：按相关性降级 ------------------------- */

const BIG = { name: '大文件', file: '资料-sources/大文件.md', oversized: true, fields: {}, sections: [], body: '', links: [] }

ok('search 在有超大页的库上 → partial（那些页可能本该命中）', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'search', query: '上下文' })
  assert.equal(value.status, 'partial')
  assert.match(value.warnings.join('\n'), /512KB/)
})

ok('page 取普通页时，别处的大页不该把状态拖成 partial', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'page', name: '上下文工程' })
  assert.equal(value.status, 'ok')
  assert.equal(Object.hasOwn(value, 'warnings'), false)
})

ok('page 取超大页本身 → partial，并说明只有元数据', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'page', name: '大文件' })
  assert.equal(value.status, 'partial')
  assert.match(value.warnings.join('\n'), /512KB/)
})

/* ---------------------------- 参数类状态 ---------------------------- */

ok('空 query → invalid_input（既不是 no_match，也不是程序崩溃）', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '   ' })
  assert.equal(value.status, 'invalid_input')
  assert.notEqual(value.status, 'no_match')
  assert.equal(value.mode, 'search')
  assert.match(value.warnings[0], /query 为空/)
})

ok('未知 mode → invalid_input（保留 error 字段给旧 render）', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'nonsense' })
  assert.equal(value.status, 'invalid_input')
  assert.equal(value.mode, 'error')
  assert.equal(typeof value.error, 'string')
})

ok('page 缺 name → invalid_input', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'page', name: '  ' })
  assert.equal(value.status, 'invalid_input')
})

/* --------------------------- 异常分类（纯函数） --------------------------- */

ok('环境错误归 environment，程序错误归 program', () => {
  const withCode = (code) => Object.assign(new Error('boom'), { code })
  assert.equal(classifyFsError(withCode('ENOENT')), 'environment')
  assert.equal(classifyFsError(withCode('EACCES')), 'environment')
  assert.equal(classifyFsError(withCode('UNKNOWN')), 'environment')
  assert.equal(classifyFsError(new TypeError('boom')), 'program')
  assert.equal(classifyFsError(undefined), 'program')
  assert.equal(classifyFsError(withCode('ERR_INVALID_ARG_TYPE')), 'program')
})

/* ------------------------ 真文件系统：恒等式 ------------------------ */

const corpus = await loadCorpus(SAMPLE)
ok('文件级恒等式：discovered = pages + unreadable + skipped', () => {
  assert.equal(
    corpus.stats.discovered,
    corpus.stats.pages + corpus.stats.unreadable + corpus.stats.skipped,
    `discovered=${corpus.stats.discovered} pages=${corpus.stats.pages} unreadable=${corpus.stats.unreadable} skipped=${corpus.stats.skipped}`,
  )
  assert.equal(corpus.stats.failuresTotal, corpus.stats.failures.length + corpus.stats.statFailures)
})

ok('样例库本身是 ok（没有覆盖缺口）', () => {
  const value = run(corpus, { mode: 'overview' })
  assert.equal(value.status, 'ok')
  assert.equal(Object.hasOwn(value, 'warnings'), false)
})

console.log(`\n[status] 全部通过（${passed} 项）`)
