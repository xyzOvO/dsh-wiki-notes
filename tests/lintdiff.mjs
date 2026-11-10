import './support/quiet-ledger.mjs'
/**
 * lintdiff.mjs —— 体检的历史对比：第二次跑要说出「变了什么」。
 *
 * 单次报告只说明「现在有什么」，说不出「库在变好还是变坏」：
 * 修了三处又坏了五处，和一处没动，在单次报告里长得一样。
 * 这里钉的是：第一次记录基线、第二次能报出新增、报告里的名字对得上。
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const BOM = '\uFEFF'

const cfgDir = mkdtempSync(path.join(tmpdir(), 'wiki-notes-lintdiff-cfg-'))
process.env.DSH_WIKI_CONFIG = path.join(cfgDir, 'wiki-notes.config.json')

const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-notes-lintdiff-wiki-'))
mkdirSync(path.join(wiki, '概念-concepts'), { recursive: true })
const pageA = path.join(wiki, '概念-concepts', '甲.md')

function page(name, body) {
  return ['---', '类型: 概念', '状态: 已提纯', '标签: [测试]', '更新: 2026-01-01', '---', '', `# ${name}`, '', body, ''].join('\n')
}

const { apply } = await import('../lib/index.js')

/** 每次 apply 都是新的缓存实例，等于模拟一次「重启后重新扫描」。 */
function register() {
  let definition = null
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {},
    webServer: { register: () => () => {} },
    tools: { register: (item) => { if (item?.name === 'wiki_recall') definition = item; return () => {} } },
    systemPrompt: { context: () => () => {} },
  }
  apply(ctx, { root: wiki })
  return definition
}

let failed = 0
let total = 0
function ok(name, fn) {
  total += 1
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`✗ ${name} — ${error.message}`)
  }
}

// 第一轮：有一个红链
writeFileSync(pageA, page('甲', '引用 [[还没写的页]]。'), 'utf8')
const first = await register().execute({ mode: 'lint' })

ok('第一次跑：标记为基线', () => {
  if (first.sinceLast?.first !== true) throw new Error(JSON.stringify(first.sinceLast))
})

ok('第一次跑：渲染里有「第一次记录基线」', () => {
  const text = register().output.render({ mode: 'lint' }, first).map((b) => b.text).join('\n')
  if (!text.includes('第一次记录基线')) throw new Error(text.slice(0, 200))
})

ok('历史文件落在了配置目录旁边', () => {
  const text = readFileSync(path.join(cfgDir, 'lint-history.json'), 'utf8')
  if (!text.includes('断链 还没写的页')) throw new Error(text.slice(0, 200))
})

// 第二轮：再加一个红链，等于库变差了
writeFileSync(pageA, page('甲', '引用 [[还没写的页]] 和 [[另一个缺口]]。'), 'utf8')
const second = await register().execute({ mode: 'lint' })

ok('第二次跑：报出新增', () => {
  if (!(second.sinceLast?.addedTotal >= 1)) throw new Error(JSON.stringify(second.sinceLast))
  if (!second.sinceLast.added.some((item) => item.includes('另一个缺口'))) {
    throw new Error(`新增项里没有新红链：${JSON.stringify(second.sinceLast.added)}`)
  }
})

ok('第二次跑：渲染里带上「与上次…相比：新增」', () => {
  const text = register().output.render({ mode: 'lint' }, second).map((b) => b.text).join('\n')
  if (!/与上次（\d{4}-\d{2}-\d{2}）相比：新增 \d+ 项/.test(text)) throw new Error(text.slice(0, 300))
  if (!text.includes('另一个缺口')) throw new Error('没点出新增的那条')
})

// 第三轮：删掉一个红链，等于修好了
writeFileSync(pageA, page('甲', '只引用 [[另一个缺口]]。'), 'utf8')
const third = await register().execute({ mode: 'lint' })

ok('修掉之后报「已修」', () => {
  if (!(third.sinceLast?.fixedTotal >= 1)) throw new Error(JSON.stringify(third.sinceLast))
  if (!third.sinceLast.fixed.some((item) => item.includes('还没写的页'))) {
    throw new Error(`已修项里没有它：${JSON.stringify(third.sinceLast.fixed)}`)
  }
})

// 第四轮：历史文件带 BOM（PowerShell 5.1 写出的 JSON 常见）——不许被当成「第一次」。
// 以前 recordLintRun 裸 JSON.parse，带 BOM 会抛错 → previous=null → first=true，
// 「与上次相比」整段消失，历史对比被静默重置。
const historyFile = path.join(cfgDir, 'lint-history.json')
const historyBefore = JSON.parse(readFileSync(historyFile, 'utf8'))
writeFileSync(historyFile, BOM + JSON.stringify({ ...historyBefore, at: '2026-11-10T00:00:00.000Z' }), 'utf8')
const fourth = await register().execute({ mode: 'lint' })

ok('带 BOM 的历史文件：不重置成「第一次记录基线」', () => {
  if (fourth.sinceLast?.first === true) throw new Error(JSON.stringify(fourth.sinceLast))
  if (fourth.sinceLast?.at !== '2026-11-10T00:00:00.000Z') {
    throw new Error(`上次时间没读到：${JSON.stringify(fourth.sinceLast)}`)
  }
})

ok('带 BOM 的历史文件：渲染里仍说「与上次…相比」', () => {
  const text = register().output.render({ mode: 'lint' }, fourth).map((b) => b.text).join('\n')
  if (!/与上次（2026-11-10）相比/.test(text)) throw new Error(text.slice(0, 300))
})

if (failed > 0) {
  console.log(`\n${total - failed}/${total} 通过，${failed} 项失败`)
  process.exit(1)
}
console.log(`\n${total}/${total} 全部通过`)
