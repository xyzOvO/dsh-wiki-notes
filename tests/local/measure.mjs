/**
 * measure.mjs —— 量一下「旧五步」与「一次 wiki_recall」各自的文本规模。
 *
 * 只数进上下文的可见字符（工具返回值、文件正文），不含系统提示与工具 schema。
 * token 数按中英混排的经验系数另算，脚本只给字符数，避免假装精确。
 */

import { readFileSync } from 'node:fs'

import { loadCorpus } from '../../lib/corpus.js'
import { run } from '../../lib/engine.js'

const ROOT = (process.env.WIKI_ROOT ?? '')
if (ROOT === '') {
  console.log('跳过：这个脚本量的是作者真实库的 token 收益，需要 WIKI_ROOT 指向一个装满笔记的目录')
  process.exit(0)
}

function chars(text) {
  return String(text ?? '').length
}

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// 旧流程的固定开销：skill 正文 + 总览 + index
const skill = chars(read((process.env.SKILL_MD ?? '')))
const overview = chars(read(`${ROOT}/总览-overview.md`))
const index = chars(read(`${ROOT}/index.md`))

console.log('=== 旧流程固定开销（每次查询都要付） ===')
console.log('SKILL.md             ', skill, '字符')
console.log('总览-overview.md     ', overview, '字符')
console.log('index.md             ', index, '字符')
console.log('小计                 ', skill + overview + index, '字符')
console.log()

// 取工具的渲染结果：跑一次 apply，抓住 register 的 definition
const captured = []
const fakeCtx = {
  logger: { info() {}, warn() {} },
  on() {},
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { captured.push(definition); return () => {} } },
}

const { apply } = await import('../../lib/index.js')
apply(fakeCtx, {})
const tool = captured[0]
if (tool === undefined) throw new Error('没有捕获到工具注册')

const schemaChars = chars(tool.description) + chars(JSON.stringify(tool.parameters))
console.log('=== 新流程常驻开销（每回合都付） ===')
console.log('工具 description     ', chars(tool.description), '字符')
console.log('工具 parameters JSON ', chars(JSON.stringify(tool.parameters)), '字符')
console.log('小计（每回合常驻）   ', schemaChars, '字符')
console.log()

const corpus = await loadCorpus(ROOT)
// 量测用的查询默认中性；作者本地用真实查询时传 MEASURE_QUERIES="词一|词二"
const queryWords = (process.env.MEASURE_QUERIES ?? '上下文 工程|记忆 系统|证据 分级|检索 增强|微调')
  .split('|').map((q) => q.trim()).filter(Boolean)
const queries = queryWords.map((q) => ({ label: q, args: { mode: 'search', query: q, limit: 5 } }))

console.log('=== 新流程单次查询 ===')
let total = 0
for (const item of queries) {
  const value = run(corpus, item.args)
  const blocks = tool.output.render(item.args, value)
  const text = blocks.map((block) => block.text ?? '').join('\n')
  total += chars(text)
  console.log(item.label.padEnd(18), String(chars(text)).padStart(6), '字符', `（${(value.hits ?? []).length} 条命中）`)
}
console.log('平均                 ', Math.round(total / queries.length), '字符')
console.log()

// 旧流程一条查询还要读的页：search.py 只给 90 字摘要，必须读页
// 样页路径也从环境变量来，避免把私人笔记的页名写进仓库
const pageSamples = (process.env.MEASURE_PAGES ?? 'index.md,log.md,总览-overview.md')
  .split(',').map((p) => p.trim()).filter(Boolean)
const pageAvg = Math.round(pageSamples.reduce((sum, p) => sum + chars(read(`${ROOT}/${p}`)), 0) / pageSamples.length)

console.log('=== 旧流程单次查询（搜 + 读 1 页） ===')
const legacyOnce = skill + overview + index + 1568 + pageAvg
console.log('固定开销             ', skill + overview + index, '字符')
console.log('search.py 输出       ', 1568, '字符（实测 5 条）')
console.log('读 1 页正文          ', pageAvg, '字符（3 个样页均值）')
console.log('合计                 ', legacyOnce, '字符')
console.log()

const newOnce = Math.round(total / queries.length)
console.log('=== 单次查询差额 ===')
console.log('旧                   ', legacyOnce, '字符')
console.log('新                   ', newOnce, '字符')
console.log('省下                 ', legacyOnce - newOnce, '字符', `（${Math.round((1 - newOnce / legacyOnce) * 100)}%）`)
console.log()

// 多轮场景：同一会话里问第 2、3 个问题时，旧流程仍要重新读总览+index（模型每次都读）
console.log('=== 同一会话问 N 次的累计（旧流程每次都重读固定开销） ===')
for (const n of [1, 3, 5, 10]) {
  const oldTotal = legacyOnce * n
  const newTotal = newOnce * n + schemaChars
  console.log(
    `问 ${String(n).padStart(2)} 次：旧 ${String(oldTotal).padStart(7)} 字符 · 新 ${String(newTotal).padStart(6)} 字符 · 省 ${String(oldTotal - newTotal).padStart(7)}`,
  )
}
