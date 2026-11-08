import './support/quiet-ledger.mjs'
/**
 * help.mjs —— help 这个 mode 的存在理由，以及「枚举只有一个来源」。
 *
 * 钉三件事：
 *   1. mode 的 enum 必须直接从 engine 的 MODES 来 —— 新增 mode 时漏改 schema，
 *      描述教会了模型、schema 却把它挡在门外，这是最难自查的一类错。
 *   2. help 不碰语料：库读不出来时它照样是 ok，不该被降级成 partial。
 *   3. 机制文档要真的能拿到（有 status 说明、有参数说明），否则描述瘦身就是丢信息。
 */

import { MODES, run, validateArgs } from '../lib/engine.js'

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
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

// —— 捕获工具注册，才能看到模型真正拿到的 schema 与描述
let registered = null
const ctx = {
  logger: { info() {}, warn() {} },
  on() {},
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { if (definition?.name === 'wiki_recall') registered = definition; return () => {} } },
}
const { apply } = await import('../lib/index.js')
apply(ctx, { root: null })

ok('MODES 里有 help', () => {
  if (!MODES.includes('help')) throw new Error(`MODES=${JSON.stringify(MODES)}`)
})

ok('schema 的 enum 就是 MODES（同一个来源，不是手抄）', () => {
  if (!registered) throw new Error('没捕获到工具注册')
  eq(registered.parameters?.properties?.mode?.enum, MODES, 'enum')
})

ok('help 不需要任何参数', () => {
  eq(validateArgs('help', {}), null, 'validateArgs')
})

ok('help 不碰语料：传 null 语料也是 ok', () => {
  const result = run(null, { mode: 'help' })
  eq(result.status, 'ok', 'status')
  eq(result.warnings, undefined, 'warnings')
})

ok('help 带出各小节，且真的讲了 status 取值', () => {
  const result = run(null, { mode: 'help' })
  const titles = (result.sections ?? []).map((section) => section.title)
  if (titles.length < 4) throw new Error(`只有 ${titles.length} 节：${titles.join(' / ')}`)
  if (!titles.some((title) => title.includes('status'))) throw new Error(`没有 status 小节：${titles.join(' / ')}`)
  const text = JSON.stringify(result.sections)
  for (const word of ['no_match', 'partial', 'unavailable', 'degraded']) {
    if (!text.includes(word)) throw new Error(`status 说明里缺 ${word}`)
  }
})

ok('help 的渲染是给人看的文本，不是 JSON', () => {
  if (!registered) throw new Error('没捕获到工具注册')
  const blocks = registered.output.render({ mode: 'help' }, run(null, { mode: 'help' }))
  const text = blocks.map((block) => block.text).join('\n')
  if (!text.startsWith('【wiki_recall 用法】')) throw new Error(`开头不对：${text.slice(0, 40)}`)
  if (!text.includes('■ status 怎么读')) throw new Error('没有 status 小节标题')
  if (text.includes('{"mode":"help"')) throw new Error('退化成了 JSON')
})

ok('描述瘦身了，但把细节指向 help', () => {
  if (!registered) throw new Error('没捕获到工具注册')
  const description = registered.description ?? ''
  if (!description.includes('mode:"help"')) throw new Error('描述里没有指向 help')
  if (description.length >= 900) throw new Error(`描述仍有 ${description.length} 字符，没瘦下来`)
  // 「何时调用」是描述该干的事，不能被瘦掉
  if (!description.includes('何时必须调用')) throw new Error('丢了「何时必须调用」')
  if (!description.includes('何时可以不查')) throw new Error('丢了「何时可以不查」')
  if (!description.includes('默认快速回答')) throw new Error('丢了「默认快速回答」')
  if (!description.includes('资料不足')) throw new Error('丢了「资料不足」披露')
})

if (failed > 0) {
  console.log(`\n${total - failed}/${total} 通过，${failed} 项失败`)
  process.exit(1)
}
console.log(`\n${total}/${total} 全部通过`)
