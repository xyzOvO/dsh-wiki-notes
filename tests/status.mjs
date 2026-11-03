/**
 * status.mjs —— 状态机与覆盖口径的回归。不开 DSH，不依赖本地知识库。
 *
 * 为什么用合成 corpus：decideStatus 是纯函数，喂假数据就能覆盖「一页都没读出来」
 * 「根目录不存在」这类在 Windows 上很难稳定造出来的文件系统情形；
 * 真文件系统只用来断言那条文件级恒等式。
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideStatus, freshnessOf, run } from '../lib/engine.js'
import { classifyFsError, loadCorpus } from '../lib/corpus.js'
import { apply } from '../lib/index.js'

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

/** 需要走 execute（会补 scanned/root）的用例用这个。 */
async function okAsync(name, fn) {
  try {
    await fn()
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`✓ ${name}`)
}

/** 最小 corpus：stats 只写关心的字段，其余补零，避免测试依赖真实库。 */
function fakeCorpus({ pages = [], stats = {}, indexLines = [] } = {}) {
  return {
    pages,
    byName: new Map(pages.map((page) => [page.name, page])),
    byAlias: new Map(),
    indexLines,
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

/* ------------------------- 超大页：按相关性降级（方案 C） ------------------------- */

const BIG = { name: '大文件', file: '资料-sources/大文件.md', oversized: true, fields: {}, sections: [], body: '', links: [] }

ok('超大页与查询无关 → search 仍是 ok（不因库里有大页就降级）', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'search', query: '上下文' })
  assert.equal(value.status, 'ok')
  assert.equal(Object.hasOwn(value, 'warnings'), false)
})

ok('超大页无关时 no_match 仍然可达（否则这套库永远下不了「没有」的结论）', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'search', query: '量子计算' })
  assert.equal(value.status, 'no_match')
  assert.equal(value.oversizedRelevant, 0)
})

ok('超大页标题命中查询词 → partial + 标题口径的提醒', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'search', query: '大文件' })
  assert.equal(value.status, 'partial')
  assert.equal(value.oversizedRelevant, 1)
  assert.match(value.warnings.join('\n'), /标题命中查询词/)
})

ok('超大页只在 index 摘要里命中 → partial + 摘要口径的提醒', () => {
  const corpus = fakeCorpus({
    pages: [PAGE, BIG],
    stats: { oversized: 1 },
    indexLines: [{ name: '大文件', summary: '关于量子计算的资料汇编' }],
  })
  const value = run(corpus, { mode: 'search', query: '量子计算' })
  assert.equal(value.status, 'partial')
  assert.equal(value.oversizedRelevant, 1)
  assert.equal(value.oversizedRelevantVia, '摘要')
  assert.match(value.warnings.join('\n'), /index 摘要命中查询词/)
})

ok('降级与超大页相关同时成立 → 状态 degraded，但两条事实都输出', () => {
  const corpus = fakeCorpus({ pages: [PAGE, BIG], stats: { oversized: 1 } })
  const value = run(corpus, { mode: 'search', query: '上下文 大文件' })
  assert.equal(value.status, 'degraded')
  const text = value.warnings.join('\n')
  assert.match(text, /超大页/)
  assert.match(text, /降级为 OR/)
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

/* ---------------------------- 渲染文案（第二步） ---------------------------- */

// 测试不许碰用户的真配置
process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-status-')), 'wiki-notes.config.json')
const tools = []
apply({
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  logger: { info() {}, warn() {} },
  on: () => {},
}, { root: SAMPLE })

const tool = tools[0]
const render = (args, value) => (tool.output.render(args, value)[0] ?? {}).text ?? ''

await okAsync('检索头行把分母摊开写（扫描 · 参与 · 命中 · 返回）', async () => {
  const value = await tool.execute({ mode: 'search', query: '上下文' }, {})
  const text = render({ mode: 'search' }, value)
  assert.match(text, /扫描 \d+ · 参与 \d+ · 命中 \d+（全词 \d+）· 返回 \d+/)
})

await okAsync('空查询的文案是「参数不对」，不再出现「库里没有」', async () => {
  const value = await tool.execute({ mode: 'search', query: '' }, {})
  const text = render({ mode: 'search' }, value)
  assert.match(text, /参数不对/)
  assert.doesNotMatch(text, /库里没有/)
})

await okAsync('没命中的文案限定为「当前可检索范围」，并明说不能反推全库', async () => {
  const value = await tool.execute({ mode: 'search', query: '这段话在样例库里不可能出现' }, {})
  const text = render({ mode: 'search' }, value)
  assert.match(text, /当前可检索范围内没有命中/)
  assert.match(text, /不能反推全库没有/)
  assert.doesNotMatch(text, /库里没有命中/)
})

ok('非 ok 时 warnings 渲染成「本次结果有缺口」块', () => {
  const text = render({ mode: 'search' }, {
    mode: 'search', status: 'partial', warnings: ['1 个超大页正文没有参与检索，但标题命中查询词 —— 可能还有相关内容没看到'],
    query: 'x', tokens: ['x'], scanned: 10, considered: 6, matched: 0, allTerms: 0, returned: 0, total: 0, hits: [],
    oversizedRelevant: 1,
  })
  assert.match(text, /本次结果有缺口/)
  assert.match(text, /标题命中查询词/)
})

ok('degraded 的说明只说一遍（warnings 与 note 不能重复）', () => {
  const value = run(corpus, { mode: 'search', query: '上下文 量子纠缠' })
  assert.equal(value.status, 'degraded')
  const text = render({ mode: 'search' }, value)
  const times = text.split('降级').length - 1
  assert.equal(times, 1, `「降级」出现了 ${times} 次：\n${text}`)
})

/* ---------------------- 第一批：时效与同名页 ---------------------- */

ok('freshnessOf：今天 / 昨天 / N 天前 / N 个月前 / 可能已过时', () => {
  const now = new Date(2026, 10, 4).getTime() // 2026-11-04 本地零点
  assert.equal(freshnessOf('2026-11-04', now), '2026-11-04（今天更新）')
  assert.equal(freshnessOf('2026-11-03', now), '2026-11-03（昨天更新）')
  assert.equal(freshnessOf('2026-10-25', now), '2026-10-25（10 天前）')
  assert.equal(freshnessOf('2026-08-04', now), '2026-08-04（3 个月前）')
  assert.match(freshnessOf('2024-01-01', now), /个月前，可能已过时/)
})

ok('freshnessOf：解析不了或未来日期原样返回，不编造', () => {
  const now = new Date(2026, 10, 4).getTime()
  assert.equal(freshnessOf('2027-01-01', now), '2027-01-01')
  assert.equal(freshnessOf('', now), '')
  assert.equal(freshnessOf('待补', now), '待补')
})

ok('渲染出来的命中带时效，不只给一个日期', () => {
  const old = { ...PAGE, fields: { ...PAGE.fields, 更新: '2024-01-01' } }
  const value = run(fakeCorpus({ pages: [old] }), { mode: 'search', query: '上下文' })
  const text = render({ mode: 'search' }, value)
  assert.match(text, /2024-01-01（\d+ 个月前，可能已过时）/)
})

ok('page 命中同名页 → partial，并点名另一篇的文件', () => {
  const twin = { ...PAGE, file: '方法-methods/上下文工程.md' }
  const corpus = fakeCorpus({
    pages: [twin, PAGE],
    stats: {
      duplicateNames: [
        { name: PAGE.name, file: twin.file },
        { name: PAGE.name, file: PAGE.file },
      ],
    },
  })
  const value = run(corpus, { mode: 'page', name: PAGE.name })
  assert.equal(value.status, 'partial')
  assert.match(value.warnings[0], /2 篇同名页「上下文工程」/)
  assert.ok(value.warnings[0].includes(twin.file), value.warnings[0])
})

ok('名字唯一的 page 不触发重名提示', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'page', name: PAGE.name })
  assert.equal(value.status, 'ok')
})

ok('零命中的渲染给出下一步，而不只是「换同义词」', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '量子计算' })
  // scanned 由 execute 补，这里手动给：否则会走「扫描到 0 页 = 路径指错」那条分支
  const text = render({ mode: 'search' }, { ...value, scanned: 1 })
  assert.match(text, /页面标题或术语原文重试/)
  assert.match(text, /才可以说「笔记里没有这个主题」/)
})

console.log(`\n[status] 全部通过（${passed} 项）`)
