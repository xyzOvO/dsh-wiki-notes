/**
 * smoke.mjs —— 不开 DSH，按工具契约完整跑一遍，验证「模型会收到什么文本」。
 *
 * 默认跑仓库自带的 examples/sample-wiki（不需要任何本地知识库）：
 *   node tests/smoke.mjs
 * 想对自己的库做冒烟：
 *   WIKI_ROOT="/path/to/your/wiki" node tests/smoke.mjs
 */

import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki/', import.meta.url))
const ROOT = process.env.WIKI_ROOT ?? SAMPLE
const isSample = ROOT === SAMPLE

const registered = []
const logger = {
  info: (message) => process.stderr.write(`[info] ${message}\n`),
  warn: (message) => process.stderr.write(`[warn] ${message}\n`),
}
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  logger,
  on: () => {},
}

apply(ctx, { root: ROOT })

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (registered.length !== 1) fail(`期望注册 1 个工具，实际 ${registered.length}`)
const definition = registered[0]
if (definition.name !== 'wiki_recall') fail(`工具名不对：${definition.name}`)
if (definition.parameters?.required?.includes('mode') !== true) fail('parameters 缺少必填的 mode')

const seen = []
async function show(label, args, expect) {
  const value = await definition.execute(args, {})
  if (value === null || typeof value !== 'object') fail(`${label}：execute 没返回对象`)
  if (typeof value.error === 'string') fail(`${label}：返回了错误 —— ${value.error}`)
  const blocks = definition.output.render(args, value)
  const text = blocks?.[0]?.text ?? ''
  if (text.trim() === '') fail(`${label}：render 输出为空`)
  if (expect !== undefined && !expect.test(text)) fail(`${label}：输出里没找到 ${expect}`)
  console.log(`\n${'═'.repeat(72)}\n${label}  ${JSON.stringify(args)}\n${'═'.repeat(72)}`)
  console.log(text)
  seen.push({ label, text })
}

const CASES = isSample
  ? [
      ['1. 检索：上下文 预算', { mode: 'search', query: '上下文 预算', limit: 2 }, /某课程第三讲|上下文工程/],
      ['2. 检索：别名命中（Context Engineering）', { mode: 'search', query: 'Context Engineering', limit: 2 }, /上下文工程/],
      ['3. 取页（模糊名）', { mode: 'page', name: '微调' }, /微调与检索增强/],
      ['4. 目录：概念页', { mode: 'list', type: '概念', limit: 5 }, /上下文工程/],
      ['5. 总览', { mode: 'overview' }, /库总览/],
      ['6. 健康检查', { mode: 'lint' }, /库健康检查/],
    ]
  : [
      ['1. 检索：上下文 预算', { mode: 'search', query: '上下文 预算', limit: 2 }, /./],
      ['2. 检索：记忆 系统', { mode: 'search', query: '记忆 系统', limit: 2, sectionChars: 500 }, /./],
      ['3. 取页（模糊名）', { mode: 'page', name: '上下文' }, /./],
      ['4. 目录：概念页', { mode: 'list', type: '概念', limit: 5 }, /./],
      ['5. 总览', { mode: 'overview' }, /库总览/],
      ['6. 健康检查', { mode: 'lint' }, /库健康检查/],
    ]

for (const [label, args, expect] of CASES) {
  await show(label, args, expect)
}

// 空查询 / 坏 mode 必须给可读的提示，而不是抛异常或返回空对象
const empty = await definition.execute({ mode: 'search', query: '' }, {})
if (typeof empty?.error === 'string' || empty?.total === 0) {
  console.log('\n✓ 空查询给了明确提示')
} else {
  fail('空查询既没报错也没返回 0 命中')
}

const bogus = await definition.execute({ mode: 'nonsense' }, {})
if (typeof bogus?.error !== 'string' && bogus?.mode !== 'error') fail('坏 mode 没有返回错误对象')

// 库路径指错时必须说「扫到 0 页，路径可能不对」，
// 而不是「库里没有命中」—— 后者会让模型以为你真的没记过这条。
const emptyCtx = {
  tools: { register: (d) => { emptyCtx.registered = d; return () => {} } },
  logger: { info() {}, warn() {} },
  on: () => {},
}
apply(emptyCtx, { root: fileURLToPath(new URL('./__不存在的库__/', import.meta.url)) })
const emptyTool = emptyCtx.registered
const emptyValue = await emptyTool.execute({ mode: 'search', query: '随便什么' }, {})
const emptyText = (emptyTool.output.render({ mode: 'search' }, emptyValue)[0] ?? {}).text ?? ''
if (!/0 个页面/.test(emptyText)) fail(`库路径无效时没提示「0 个页面」，实际输出：${emptyText.slice(0, 120)}`)
console.log('\n✓ 库路径无效时给了「扫到 0 个页面」的明确提示')

console.log(`\n[smoke] 全部通过（${isSample ? '样例库' : ROOT}，${seen.length} 个用例）`)
