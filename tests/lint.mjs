/**
 * lint.mjs —— 代码审查找出来的三处口径问题，钉死在这里。
 *
 * 1. 入链走别名时，孤儿不能被误报（`[[检索实践]]` 指向「甲页」的别名）
 * 2. 超大文件（> 512KB，只记元数据）不能进「缺字段 / 无出链 / 未登记」这些检查
 * 3. 标签筛不区分大小写（主题词那边已经归并 RAG/rag，查询这边不能更严）
 * 4. list 的 limit 真的夹上限（样例库页数太少，旧断言是空过的）
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCorpus } from '../lib/corpus.js'
import { lint, list, search } from '../lib/engine.js'
import { apply } from '../lib/index.js'
// 测试不许碰用户的真配置：把配置文件指到临时目录（跑测试不该改掉设置页里的库路径/提示词）
process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-cfg-')), 'wiki-notes.config.json')


let pass = 0
const ok = (label, cond, extra) => {
  if (!cond) {
    console.error('  ✗ ' + label + (extra ? ' — ' + extra : ''))
    process.exitCode = 1
    return
  }
  pass += 1
  console.log('  ✓ ' + label)
}

const root = mkdtempSync(join(tmpdir(), 'wiki-notes-lint-'))
const wiki = join(root, 'wiki')
mkdirSync(join(wiki, 'concepts'), { recursive: true })
mkdirSync(join(wiki, 'sources'), { recursive: true })
const put = (rel, text) => writeFileSync(join(wiki, rel), text, 'utf8')

put('index.md', '# 索引\n\n**当前规模**：2 份资料 · 2 个页面\n\n- [[甲页]] — 讲甲（2 份资料，更新于 2026-11-01）\n- [[乙页]] — 讲乙（1 份资料，更新于 2026-11-01）\n')
put('log.md', '# 日志\n\n## [2026-11-01] ingest | 甲页\n')
put('concepts/甲页.md', `---
类型: 概念
状态: 演进中
标签: [RAG]
别名: [检索实践]
来源数量: 2
创建: 2026-10-01
更新: 2026-11-01
---

# 甲页

> 定义：甲的定义。

## 结论

只说自己的事，没链接别人。
`)
put('concepts/乙页.md', `---
类型: 概念
状态: 演进中
标签: [ai]
别名: [乙别名]
来源数量: 1
创建: 2026-10-01
更新: 2026-11-01
---

# 乙页

## 结论

这一段的做法见 [[检索实践]]（那是「甲页」的别名，不是红链）。
`)
// 超大页：超过 MAX_PAGE_BYTES(512KB)，只记元数据、不读正文
put('sources/巨型.md', '---\n类型: 资料\n---\n\n' + 'x'.repeat(600 * 1024))

const corpus = await loadCorpus(wiki)
const lb = lint(corpus, { limit: 20 })

ok('别名入链不再被误报成孤儿', !lb.orphans.includes('甲页'), JSON.stringify(lb.orphans))
ok('超大页出现在 oversized 名单', lb.oversized.includes('巨型'), JSON.stringify(lb.oversized))
ok('超大页不算「缺 frontmatter 字段」', !lb.missingFields.some((row) => row.name === '巨型'))
ok('超大页不算「无出链」', !lb.noLinks.includes('巨型'))
ok('超大页不算「没进 index.md」', !(lb.consistency?.diskOnly ?? []).includes('巨型'))
ok('counts.oversized 计数正确', lb.counts.oversized === 1, String(lb.counts.oversized))

const upper = search(corpus, 'rag', { tags: ['rag'] })
ok('标签筛不区分大小写（小写 rag 命中标签 RAG 的页）', upper.total === 1, `total=${upper.total}`)
const upper2 = search(corpus, 'rag', { tags: ['RAG'] })
ok('大写写法同样命中', upper2.total === 1, `total=${upper2.total}`)
const listed = list(corpus, { tags: ['rag'] })
ok('list 的标签筛也吃大小写差异', listed.total === 1, `total=${listed.total}`)

// list 上限：用合成语料，样例库页数太少会把这个断言空过
const fake = {
  pages: Array.from({ length: 250 }, (_, i) => ({
    name: `p${String(i).padStart(3, '0')}`,
    file: `concepts/p${i}.md`,
    fields: { 类型: '概念', 更新: '2026-11-01' },
    sections: [],
    body: '',
    links: [],
  })),
  indexLines: [],
  log: [],
  scaleLine: '',
  stats: { pages: 250, resources: 0, brokenPages: 0, brokenTotal: 0, scannedMs: 0 },
}
const clamped = list(fake, { limit: 999 })
ok('list limit 999 被夹到 200', clamped.shown === 200, `shown=${clamped.shown}`)
ok('list limit 999 标记 truncated', clamped.truncated === true)
const zeroed = list(fake, { limit: 0 })
ok('list limit 0 退回默认 40', zeroed.shown === 40, `shown=${zeroed.shown}`)
// 5. 保存校验：路径扫不出页面时必须拒绝，且一个字节都不写进配置文件
{
  const CONFIG = process.env.DSH_WIKI_CONFIG
  // 先放一份哨兵配置：被拒绝的保存必须一个字节都不动
  const seed = JSON.stringify({ root: 'D:/seed-not-real' }, null, 2) + '\n'
  writeFileSync(CONFIG, seed, 'utf8')
  const before = readFileSync(CONFIG, 'utf8')

  let handler = null
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    systemPrompt: { context: () => () => {} },
    logger: { info() {}, warn() {} },
    on() {},
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  apply(ctx, { root })

  function fakeReq(payload) {
    const listeners = {}
    const req = {
      url: '/api/wiki-notes/save',
      method: 'POST',
      on(event, cb) { (listeners[event] ??= []).push(cb); return req },
      destroy() {},
    }
    queueMicrotask(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(payload), 'utf8'))
      for (const cb of listeners.end ?? []) cb()
    })
    return req
  }
  function fakeRes() {
    return { statusCode: 0, body: '', setHeader() {}, end(chunk) { this.body = chunk } }
  }

  const res = fakeRes()
  await handler(fakeReq({ root: 'D:/definitely-not-a-wiki-xyz' }), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch {}
  ok('扫不出页面的路径被拒绝保存', parsed?.ok === false && parsed?.saved === false, String(res.body).slice(0, 120))
  ok('拒绝时带明确原因', typeof parsed?.error === 'string' && parsed.error.length > 0, String(parsed?.error))
  ok('拒绝时没有改写配置文件', readFileSync(CONFIG, 'utf8') === before)
}

// 6. 渲染不留连续空行：模型读的是这段文本，空行也是要付钱的 token
{
  let definition = null
  const ctx = {
    tools: { register: (d) => { definition = d; return () => {} } },
    webServer: { register: () => () => {} },
    systemPrompt: { context: () => () => {} },
    logger: { info() {}, warn() {} },
    on() {},
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  apply(ctx, { root })

  const cases = [
    { mode: 'page', name: '甲页', pageChars: 60 },
    { mode: 'search', query: '甲', limit: 2 },
    { mode: 'list' },
    { mode: 'lint' },
  ]
  for (const args of cases) {
    const value = await definition.execute(args, {})
    const text = definition.output.render(args, value).map((block) => block.text).join('\n')
    ok(`渲染无连续空行：${args.mode}`, !/\n{3,}/.test(text), `${text.length} 字符`)
  }
}

rmSync(root, { recursive: true, force: true })
if (process.exitCode === 1) {
  console.error('lint smoke 失败')
} else {
  console.log(`lint smoke 全部通过（${pass} 项）`)
}
process.exit(process.exitCode ?? 0)
