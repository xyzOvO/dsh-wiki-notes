import './support/quiet-ledger.mjs'
/**
 * status.mjs —— 状态机与覆盖口径的回归。不开 DSH，不依赖本地知识库。
 *
 * 为什么用合成 corpus：decideStatus 是纯函数，喂假数据就能覆盖「一页都没读出来」
 * 「根目录不存在」这类在 Windows 上很难稳定造出来的文件系统情形；
 * 真文件系统只用来断言那条文件级恒等式。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideStatus, freshnessOf, list, page, run, tokenize } from '../lib/engine.js'
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

const SECTION_PAGE = {
  ...PAGE,
  sections: [
    { title: '定义', text: '上下文工程说的是怎么把有限预算花在刀刃上。' },
    { title: '细节', text: '细节正文第一句。细节正文第二句。' },
  ],
  body: '# 上下文工程\n\n## 定义\n\n上下文工程说的是怎么把有限预算花在刀刃上。\n\n## 细节\n\n细节正文第一句。细节正文第二句。',
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
  // failures 已经含 walk/stat/read/parse，stat 不能再加一遍
  assert.equal(corpus.stats.failuresTotal, corpus.stats.failures.length)
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

ok('没沾到的词写进检索头，模型才知道该换哪个词', () => {
  const value = run(corpus, { mode: 'search', query: '上下文 量子纠缠' })
  assert.deepEqual(value.missedTerms, ['量子纠缠'])
  const text = render({ mode: 'search' }, value)
  assert.match(text, /没沾到：量子纠缠/)
})

ok('没有漏词时不出「没沾到」那行（正常路径不多一个 token）', () => {
  const value = run(corpus, { mode: 'search', query: '上下文' })
  const text = render({ mode: 'search' }, value)
  assert.doesNotMatch(text, /没沾到/)
})

ok('degraded 的说明只说一遍（warnings 与 note 不能重复）', () => {
  const value = run(corpus, { mode: 'search', query: '上下文 量子纠缠' })
  assert.equal(value.status, 'degraded')
  const text = render({ mode: 'search' }, value)
  const times = text.split('降级').length - 1
  assert.equal(times, 1, `「降级」出现了 ${times} 次：\n${text}`)
})

/* ---------------------- 第三批：过滤与取页的三种误导 ---------------------- */

ok('标签写成逗号串时解析成数组（否则「按标签筛」会漏页）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-tag-'))
  const dir = join(root, 'wiki')
  mkdirSync(join(dir, '概念-concepts'), { recursive: true })
  writeFileSync(
    join(dir, '概念-concepts/逗号标签.md'),
    '---\n类型: 概念\n标签: agent, llm, 记忆\n来源数量: 1\n状态: 稳定\n创建: 2026-01-01\n更新: 2026-01-01\n---\n\n# 逗号标签\n\n## 定义\n\n正文。\n',
  )
  writeFileSync(join(dir, 'index.md'), '# 索引\n')
  writeFileSync(join(dir, 'log.md'), '## [2026-01-01] init | 初始化\n')
  const corpus = await loadCorpus(dir)
  const tags = corpus.pages[0].fields['标签']
  assert.ok(Array.isArray(tags), `标签应当是数组，实际 ${JSON.stringify(tags)}`)
  assert.deepEqual(tags, ['agent', 'llm', '记忆'])
  // 真值断言：按标签筛能筛到这页
  const rows = list(corpus, { tags: ['llm'] }).rows
  assert.deepEqual(rows.map((row) => row.name), ['逗号标签'])
})

ok('type 过滤把候选清空 → 说明「库里没这种页」，不是「没这个主题」', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '上下文', type: '资料' })
  assert.equal(value.status, 'no_match')
  assert.equal(value.considered, 0)
  assert.match(value.note, /库里没有符合 type=资料 的页/)
  assert.match(value.note, /概念 1/)
})

ok('page 走别名且别名被两页共用 → partial 并点名两页', () => {
  const a = { ...PAGE, name: '甲页', file: '概念-concepts/甲页.md' }
  const b = { ...PAGE, name: '乙页', file: '概念-concepts/乙页.md' }
  const corpus = fakeCorpus({ pages: [a, b] })
  corpus.byAlias = new Map([['共用别名', [a, b]]])
  const value = run(corpus, { mode: 'page', name: '共用别名' })
  assert.equal(value.status, 'partial')
  assert.match(value.warnings[0], /甲页/)
  assert.match(value.warnings[0], /乙页/)
})

ok('page 命中没有正文的页 → 明说「没有正文」', () => {
  const empty = { ...PAGE, name: '空页', file: '概念-concepts/空页.md', body: '', sections: [] }
  const value = run(fakeCorpus({ pages: [empty] }), { mode: 'page', name: '空页' })
  assert.equal(value.status, 'ok')
  assert.match(render({ mode: 'page' }, value), /没有正文/)
})

/* ---------------------- 第二批：降级原因要说到点上 ---------------------- */
/** 造 n 页，每页正文都是同一句 —— 只为制造「命中面很宽」和「字面沾边」两种情形。 */
function manyPages(n, body) {
  return Array.from({ length: n }, (_, i) => ({
    ...PAGE,
    name: `合成页${i + 1}`,
    file: `概念-concepts/合成页${i + 1}.md`,
    fields: { 类型: '概念', 状态: '稳定', 标签: [], 更新: '2026-11-01', 来源数量: 1 },
    sections: [{ title: '定义', text: body }],
    body: `# 合成页${i + 1}\n\n## 定义\n\n${body}`,
  }))
}

ok('覆盖率兜底时说「字面覆盖率」，不能再说成 OR', () => {
  // 整句没有任何一页含这个词元 → AND/OR 都空 → 走覆盖率兜底。
  const body = '上下文工程说的是怎么把有限预算花在刀刃上。'
  const value = run(fakeCorpus({ pages: manyPages(24, body) }), { mode: 'search', query: '上下文工程说的是什么呢' })
  assert.equal(value.coverageFallback, true, '这条查询应当走覆盖率兜底')
  assert.equal(value.status, 'degraded')
  assert.match(value.warnings[0], /字面覆盖率/)
  assert.doesNotMatch(value.warnings[0], /OR/, '兜底不是 OR 降级，措辞不能混')
})

ok('单字查询：status 仍 ok，但渲染里必须说清「排序没有区分度」', () => {
  const value = run(fakeCorpus({ pages: manyPages(24, '这一页到处都有的字。') }), { mode: 'search', query: '的' })
  assert.equal(value.status, 'ok', 'ok 是契约：结果没坏，只是没区分度')
  assert.equal(Object.hasOwn(value, 'warnings'), false, 'ok 不带 warnings 键')
  const text = render({ mode: 'search' }, value)
  assert.match(text, /没有区分度/)
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

ok('核验发现违规：定向修正后最多再核验一次，复核仍有违规即停止', () => {
  const verify = tools.find((item) => item?.name === 'wiki_verify')
  if (!verify) throw new Error('没捕获到 wiki_verify 注册')
  const text = verify.output.render({}, {
    kind: 'verify', status: 'violations_found',
    violations: [{ type: 'gap_not_disclosed', claim: '示例主张', reason: '示例缺口未披露' }],
  })[0].text
  assert.match(text, /不得绕过 violations_found/)
  assert.match(text, /最多再跑一次 wiki_verify/)
  assert.match(text, /复核仍有违规即停止并披露/)
  assert.doesNotMatch(text, /超过 4 轮/)
  assert.doesNotMatch(text, /仍有违规须披露。$/)
})

ok('零命中的渲染给出下一步，而不只是「换同义词」', () => {
  const value = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '量子计算' })
  // scanned 由 execute 补，这里手动给：否则会走「扫描到 0 页 = 路径指错」那条分支
  const text = render({ mode: 'search' }, { ...value, scanned: 1 })
  assert.match(text, /页面标题或术语原文重试/)
  assert.match(text, /才可以说「笔记里没有这个主题」/)
})

ok('过了 type 过滤但整句没命中：要说清是词不对还是被过滤掉了', () => {
  const corpus = fakeCorpus({ pages: [PAGE] })
  const value = run(corpus, { mode: 'search', query: '量子计算', type: '概念' })
  assert.equal(value.status, 'no_match')
  assert.equal(value.considered, 1)
  assert.match(value.note, /过滤后仍有 1 页参与检索/)
  assert.match(value.note, /去掉过滤再搜一次/)
  // 渲染侧非 ok 时由 warnings 承载同一句话，不该一个字都不出现
  const text = render({ mode: 'search' }, { ...value, scanned: 1 })
  assert.match(text, /过滤后仍有 1 页参与检索/)
})

ok('hit.brokenLinks 取 corpus 解析好的 page.links，不自己重扫正文', () => {
  // 正文里写着 `[[示例页]]`（行内代码，是举例不是链接），corpus 不会把它算进 links；
  // 这里再扫一遍正文就会把示例当红链 —— 这正是自己写正则的那一版犯的错。
  const page = {
    ...PAGE,
    body: `${PAGE.body}\n\n写法示例：\`[[示例页]]\`，另有 [[真断链]]。`,
    links: ['真断链'],
  }
  const value = run(fakeCorpus({ pages: [page] }), { mode: 'search', query: '上下文' })
  assert.deepEqual(value.hits[0].brokenLinks, ['真断链'])
})

ok('超长查询在引擎层就截到 200 字，不把整段当词元', () => {
  const tokens = tokenize('甲'.repeat(300))
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].length, 200)
})

ok('截断不切半个表情：孤立代理会让下游显示成「�」', () => {
  // 199 个 ASCII + 1 个表情：第 200 个码元正好是表情的高位代理，旧写法切在这里
  const tokens = tokenize(`${'a'.repeat(199)}😀😀`)
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  assert.equal(lone.test(tokens[0]), false, '词元里出现了孤立代理')
  assert.ok(tokens[0].length <= 200)

  // 命中小节正文的 sectionChars 截断同理
  const page = { ...PAGE, sections: [{ title: '定义', text: '😀'.repeat(600) }], body: `## 定义\n\n${'😀'.repeat(600)}` }
  const value = run(fakeCorpus({ pages: [page] }), { mode: 'search', query: '上下文', sectionChars: 901 })
  assert.equal(lone.test(value.hits[0].section.text), false, '小节正文里出现了孤立代理')
})

ok('超大页取页：说「超过 512KB 未载入」，不说「文件是空的」', () => {
  // 超大页的 body 也是空字符串，早先两条提示会同时出现且互相矛盾
  const huge = { ...PAGE, oversized: true, body: '', sections: [] }
  const value = run(fakeCorpus({ pages: [huge], stats: { oversized: 1 } }), { mode: 'page', name: PAGE.name })
  assert.equal(value.status, 'partial')
  assert.equal(value.note, undefined)
  const joined = value.warnings.join(' ')
  assert.match(joined, /超过 512KB/)
  assert.doesNotMatch(joined, /文件是空的/)

  // 真的是空页时仍要说清
  const blank = { ...PAGE, body: '', sections: [] }
  const value2 = run(fakeCorpus({ pages: [blank] }), { mode: 'page', name: PAGE.name })
  assert.match(String(value2.note), /这页没有正文/)
})

/* --------------------- lint：「更新」读不出来的页 --------------------- */

{
  const dir = mkdtempSync(join(tmpdir(), 'wiki-notes-stale-'))
  const fm = (date) => `---\n类型: 概念\n状态: 稳定\n标签: [x]\n别名: []\n来源数量: 1\n创建: 2020-01-01\n更新: ${date}\n---\n\n# 页\n\n正文。\n`
  writeFileSync(join(dir, '好日期.md'), fm('2020-01-01'))
  writeFileSync(join(dir, '坏日期.md'), fm('2020/01/01'))
  const corpus = await loadCorpus(dir)
  const value = run(corpus, { mode: 'lint' })

  ok('「更新」不是 YYYY-MM-DD 的页：算不进久未更新，但必须单独报出来', () => {
    assert.equal(value.counts.staleUnknown, 1, `staleUnknown=${value.counts.staleUnknown}`)
    assert.equal(value.staleUnknown[0].name, '坏日期')
    assert.equal(value.counts.stale, 1, '只有能算天数的那页该进 stale')
    // 「0 页久未更新」不能冒充「全库都新」—— 有读不出的日期就得说出来
    assert.equal(value.status, 'partial')
    assert.match(value.warnings.join(' '), /不是 YYYY-MM-DD/)
  })
}

/* ------------------ overview：没有总览页 ≠ 总览是空的 ------------------ */

{
  const head = { ...PAGE, name: '总览-overview', file: '总览-overview.md', fields: { 类型: '总览', 状态: '稳定', 更新: '2026-11-01' } }
  const withOverview = run(fakeCorpus({ pages: [head, PAGE] }), { mode: 'overview' })
  const noOverview = run(fakeCorpus({ pages: [PAGE] }), { mode: 'overview' })

  ok('有总览页时 overview 正常（ok、无 note）', () => {
    assert.equal(withOverview.status, 'ok')
    assert.equal(withOverview.note, undefined)
    assert.equal(withOverview.overview.name, '总览-overview')
  })

  ok('没有总览页时 overview 要说清「没有」，不能默默给个空', () => {
    assert.equal(noOverview.overview, null)
    assert.match(String(noOverview.note), /没有「总览-overview」页/)
    assert.equal(noOverview.status, 'partial')
    assert.match(noOverview.warnings.join(' '), /没有「总览-overview」页/)
  })
}

/* ------------------ 链接目录：不跟，但要留痕 ------------------ */

{
  const base = mkdtempSync(join(tmpdir(), 'wiki-notes-link-'))
  const wiki = join(base, 'wiki')
  const outside = join(base, 'outside')
  mkdirSync(wiki)
  mkdirSync(outside)
  writeFileSync(join(wiki, '正常页.md'), '---\n类型: 概念\n状态: 稳定\n更新: 2026-11-01\n---\n\n# 正常页\n\n正文。\n')
  writeFileSync(join(outside, '外部页.md'), '# 外部页\n\n正文。\n')
  // Windows 上建目录链接要管理员权限，但 junction 不用；Linux/macOS 用 dir
  symlinkSync(outside, join(wiki, '链接目录'), process.platform === 'win32' ? 'junction' : 'dir')
  const corpus = await loadCorpus(wiki)

  ok('junction/symlink 不跟进去扫描（不重复、不成环）', () => {
    assert.deepEqual(corpus.pages.map((page) => page.name), ['正常页'])
  })

  ok('跳过链接要留痕：linksSkipped + 名字都报出来', () => {
    assert.equal(corpus.stats.linksSkipped, 1)
    assert.deepEqual(corpus.stats.linkSkips, ['链接目录'])
  })
}

// log.md 在、但一条记录也对不上格式：不能让「最近日志 0 条」冒充「最近没有改动」
{
  const base = mkdtempSync(join(tmpdir(), 'wiki-notes-log-'))
  let seq = 0
  const make = (logBody) => {
    seq += 1
    const dir = join(base, `v${seq}`)
    mkdirSync(join(dir, '概念-concepts'), { recursive: true })
    writeFileSync(join(dir, '总览-overview.md'), '---\n类型: 综合\n状态: 稳定\n标签: [x]\n更新: 2026-11-01\n---\n\n# 总览\n\n规模。\n')
    writeFileSync(join(dir, '概念-concepts', '甲.md'), '---\n类型: 概念\n状态: 稳定\n标签: [x]\n更新: 2026-11-01\n---\n\n# 甲\n\n正文。\n')
    writeFileSync(join(dir, 'index.md'), '# 索引\n\n- [[甲]]\n')
    if (logBody !== null) writeFileSync(join(dir, 'log.md'), logBody)
    return dir
  }

  const broken = run(await loadCorpus(make('# 我的日志\n\n- 今天写了点东西\n')), { mode: 'overview' })
  ok('log 格式对不上：状态降 partial', () => assert.equal(broken.status, 'partial'))
  ok('log 格式对不上：说清「格式没对上」而不是「没有改动」', () => {
    const said = broken.warnings.join(' ')
    assert.match(said, /没有一条符合「## \[日期\] 类型 \| 标题」/)
    assert.match(said, /不代表库里最近没有改动/)
  })
  ok('log 格式对不上：logPresent 与 logEntries 分开报', () => {
    assert.equal(broken.logPresent, true)
    assert.equal(broken.logEntries, 0)
  })

  const normal = run(await loadCorpus(make('# 日志\n\n## [2026-11-01] ingest | 摄入甲\n- 改了 [[甲]]\n')), { mode: 'overview' })
  ok('log 正常：不降级、解析出 1 条', () => {
    assert.equal(normal.status, 'ok')
    assert.equal(normal.logEntries, 1)
  })

  const missing = run(await loadCorpus(make(null)), { mode: 'overview' })
  ok('没有 log.md：不报警（没有 ≠ 格式不对）', () => {
    assert.equal(missing.status, 'ok')
    assert.equal(missing.logPresent, false)
  })

  // 两个「看起来是空」同时成立时，两条都得报：以前两条 if 各自 return，
  // 第二条被第一条吞掉 —— 状态还是 partial，但只交代了一件事。
  const bothDir = make('# 我的日志\n\n- 今天写了点东西\n')
  rmSync(join(bothDir, '总览-overview.md'), { force: true })
  const both = run(await loadCorpus(bothDir), { mode: 'overview' })
  ok('缺总览 + log 格式坏：状态仍是 partial', () => assert.equal(both.status, 'partial'))
  ok('缺总览 + log 格式坏：两条警告都在，没互相吞掉', () => {
    const said = both.warnings.join(' ')
    assert.match(said, /没有「总览-overview」页/)
    assert.match(said, /不代表库里最近没有改动/)
    assert.equal(both.warnings.length, 2, JSON.stringify(both.warnings))
  })
}

ok('search 传 status：不匹配的页不参与，不是静默忽略', () => {
  const bad = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '上下文', status: '绝不存在的状态' })
  assert.equal(bad.total, 0)
  assert.equal(bad.considered, 0)
  assert.match(String(bad.note ?? ''), /过滤条件的问题/)
  assert.match(String(bad.note ?? ''), /status=/)
  const good = run(fakeCorpus({ pages: [PAGE] }), { mode: 'search', query: '上下文', status: '已提纯' })
  assert.equal(good.total, 1)
})

ok('page(section=标题) 只回那一节，citation 指到该节', () => {
  const result = page(fakeCorpus({ pages: [SECTION_PAGE] }), '上下文工程', { section: '细节' })
  assert.equal(result.found.sectionTitle, '细节')
  assert.match(result.found.body, /细节正文第一句/)
  assert.ok(!result.found.body.includes('上下文工程说的是'), '取单节时把整页搬回来了')
  assert.match(result.found.citation, /§细节/)
})

ok('page(section=序号) 也认；找不到时列出可选小节', () => {
  const corpus2 = fakeCorpus({ pages: [SECTION_PAGE] })
  assert.equal(page(corpus2, '上下文工程', { section: '1' }).found.sectionTitle, '定义')
  const miss = page(corpus2, '上下文工程', { section: '没有这节' })
  // 原因放在 found.sectionNote（渲染器在正文前印一行 ⚠️），不再拼进顶层 note，
  // 否则同一句话会在「⚠️ note」和「⚠️ sectionNote」里各印一遍。
  assert.match(String(miss.found.sectionNote ?? ''), /没有这一节/)
  assert.match(String(miss.found.sectionNote ?? ''), /定义 \/ 细节/)
})

ok('page 不带 section 时行为不变（整页）', () => {
  const result = page(fakeCorpus({ pages: [SECTION_PAGE] }), '上下文工程')
  assert.equal(result.found.sectionTitle, '')
  assert.match(result.found.body, /上下文工程说的是/)
})

// splitSections 把 H1 前言留成 { title: '' } 的第一节；界面列出的「小节」不含它，
// 所以 1-based 序号必须按「有标题的节」算，否则 section:'1' 会把前言交出去。
ok('section 序号跳过无标题前言；找不到小节不退整页也不说成 ok', () => {
  const withPreamble = {
    ...PAGE,
    sections: [
      { title: '', text: '# 上下文工程\n\n前言里有一句不该被当成第一节。' },
      { title: '定义', text: '上下文工程说的是怎么把有限预算花在刀刃上。' },
      { title: '细节', text: '细节正文第一句。细节正文第二句。' },
    ],
  }
  const corpus3 = fakeCorpus({ pages: [withPreamble] })
  const first = page(corpus3, '上下文工程', { section: '1' })
  assert.equal(first.found.sectionTitle, '定义')
  assert.match(first.found.body, /上下文工程说的是/)
  assert.ok(!first.found.body.includes('前言里有'), '把无标题前言当成了第 1 节')
  assert.equal(page(corpus3, '上下文工程', { section: '2' }).found.sectionTitle, '细节')
  const miss = page(corpus3, '上下文工程', { section: '没有这节' })
  assert.equal(miss.found.body, '', '找不到小节时又把整页正文搬回来了')
  assert.match(String(miss.found.sectionNote ?? ''), /定义 \/ 细节/)
  assert.equal(miss.note, undefined, '「没有这一节」和「整页没正文」不该同时出现在 note 里')
  assert.equal(run(corpus3, { mode: 'page', name: '上下文工程', section: '没有这节' }).status, 'no_match')
})

console.log(`\n[status] 全部通过（${passed} 项）`)
