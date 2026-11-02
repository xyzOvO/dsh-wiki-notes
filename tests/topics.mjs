/**
 * topics.mjs —— 主题词那一行（systemPrompt.context）。
 *
 * 它每回合都在上下文里，所以既要真的能触发检索，又不能长。
 * 这里钉三件事：格式对、长度有上限、库没配时是空串。
 */

import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki/', import.meta.url))
let failed = 0
function check(name, ok, detail = '') {
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function makeCtx() {
  const state = { sections: [], definition: null }
  const ctx = {
    tools: { register: (d) => { state.definition = d; return () => {} } },
    systemPrompt: { context: (options) => { state.sections.push(options); return () => {} } },
    webServer: { register: () => () => {} },
    logger: { info() {}, warn() {} },
    on() {},
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  }
  return { ctx, state }
}

// 1. 有库：一行主题词，点出标签，且不超长
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})

  check('注册了一个 context 段', state.sections.length === 1, `实际 ${state.sections.length}`)
  const section = state.sections[0]
  check('段名固定', section?.name === 'wiki-notes:topics', String(section?.name))
  const text = typeof section?.text === 'function' ? section.text() : ''
  check('格式对：本地知识库 N 页，主题：…', /^本地知识库 \d+ 页，主题：/.test(text), text)
  check('点出了样例库的标签 AI', text.includes('AI'), text)
  check('长度有上限（≤ 130 字符）', text.length <= 130, `${text.length} 字符`)
}

// 2. 没配库：必须是空串，不能每回合白占上下文
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: '' })
  const section = state.sections[0]
  const text = typeof section?.text === 'function' ? section.text() : 'x'
  check('没配库时为空串', text === '', text)
}

if (failed > 0) {
  process.stderr.write(`topics smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log('topics smoke 全部通过（5 项）')
