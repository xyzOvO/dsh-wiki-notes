/**
 * topics.mjs —— 主题词那一行（systemPrompt.context）。
 *
 * 它每回合都在上下文里，所以既要真的能触发检索，又不能长。
 * 这里钉三件事：格式对、长度有上限、库没配时是空串。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
// 测试不许碰用户的真配置：把配置文件指到临时目录（跑测试不该改掉设置页里的库路径/提示词）
process.env.DSH_WIKI_CONFIG = path.join(mkdtempSync(path.join(tmpdir(), 'wiki-notes-cfg-')), 'wiki-notes.config.json')


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
  check('格式对：本地知识库主题：…（不带页数，页数变动不该打掉前缀缓存）', /^本地知识库主题：/.test(text), text)
  check('不带「N 页」（页数在设置页看，不在提示词里）', !/\d+\s*页/.test(text), text)
  check('点出了样例库的标签 AI', text.includes('AI'), text)
  check('长度有上限（≤ 130 字符）', text.length <= 130, `${text.length} 字符`)
  // 用户可能把 {{...}} 写进自己的提示词里，那不是变量，是字面文本
  check('关掉了变量插值（interpolate:false）', section?.interpolate === false, String(section?.interpolate))
  // 同一份输入两次求值必须逐字节相同：这段每回合都在上下文里，
  // 只要上次和这次不一样就打掉一次前缀缓存，而它的内容其实没变
  check('同输入两次求值逐字节相同', section.text() === section.text(), '两次结果不同')
}

// 2. 没配库：必须是空串，不能每回合白占上下文
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: '' })
  const section = state.sections[0]
  const text = typeof section?.text === 'function' ? section.text() : 'x'
  check('没配库时为空串', text === '', text)
}

// 2b. 关掉开关：一个字都不注入
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE, prompt: { enabled: false } })
  const text = state.sections[0].text()
  check('关掉后为空串', text === '', text)
}

// 2c. 用自己的整段文本（override 优先于自动主题词）
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE, prompt: { enabled: true, override: '要查库。' } })
  check('override 原样生效', state.sections[0].text() === '要查库。', state.sections[0].text())
}

// 2d. 追加一句（extra 接在自动内容后面）
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE, prompt: { enabled: true, extra: '不确定时先查库。' } })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})
  const text = state.sections[0].text()
  check('extra 追加在末尾', text.includes('主题：') && text.endsWith('\n不确定时先查库。'), JSON.stringify(text))
}

// 3. 设置页读的 /state 里必须真有这份清单（不然页面显示不出来）
{
  const { ctx, state } = makeCtx()
  const routes = []
  ctx.webServer = { register: (route) => { routes.push(route); return () => {} } }
  apply(ctx, { root: SAMPLE })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})

  let body = ''
  const req = { url: '/api/wiki-notes/state', method: 'GET' }
  const res = { writeHead() {}, setHeader() {}, end(text) { body = text } }
  await routes[0].handler(req, res)

  const payload = JSON.parse(body)
  check('/state 带 topics 数组', Array.isArray(payload.topics), typeof payload.topics)
  check('/state 的 topics 每项有 tag 和 count',
    payload.topics.length > 0 && typeof payload.topics[0].tag === 'string' && typeof payload.topics[0].count === 'number',
    JSON.stringify(payload.topics?.[0]))
  check('/state 带 topicPreview 一行文本', typeof payload.topicPreview === 'string' && payload.topicPreview.includes('主题'), String(payload.topicPreview))
  check('/state 带 prompt 配置', payload.prompt !== null && typeof payload.prompt === 'object' && payload.prompt.enabled === true, JSON.stringify(payload.prompt))
}

// 5. 阈值：只留出现 >=2 次的标签；minCount:1 时一次性标签也进来
//    这里显式传 topics，不受本机配置文件影响（设置页可能把阈值关掉过）
{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE, topics: { minCount: 2 } })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})
  const line = state.sections[0].text()
  check('阈值 2：出现一次的标签不进主题词', !line.includes('训练') && !line.includes('检索'), line)
  check('阈值 2：AI 还在（×5）', line.includes('AI'), line)
}

{
  const { ctx, state } = makeCtx()
  apply(ctx, { root: SAMPLE, topics: { minCount: 1 } })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})
  const line = state.sections[0].text()
  check('minCount:1 时一次性标签也参与排名', line.includes('训练') || line.includes('检索'), line)
}

// 6. 大小写归并：RAG 与 rag 是同一个主题
{
  const dir = mkdtempSync(path.join(tmpdir(), 'wn-case-'))
  const wiki = path.join(dir, '知识层-wiki')
  mkdirSync(wiki, { recursive: true })
  writeFileSync(path.join(wiki, 'index.md'), '# 索引\n')
  const page = (name, tags) => writeFileSync(
    path.join(wiki, name + '.md'),
    '---\n类型: 概念\n标签: [' + tags + ']\n状态: 草稿\n更新: 2026-11-02\n---\n\n正文\n',
  )
  page('a', 'RAG, 向量')
  page('b', 'rag, 向量')
  page('c', 'LLM')

  const { ctx, state } = makeCtx()
  ctx.webServer = { register: (route) => { state.route = route; return () => {} } }
  apply(ctx, { root: wiki, topics: { minCount: 2 } })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})
  const line = state.sections[0].text()
  check('大小写不同的同一个主题只出现一次', !(line.includes('RAG') && line.includes('rag')), line)

  let payload = ''
  await state.route.handler(
    { url: '/api/wiki-notes/state', method: 'GET' },
    { writeHead() {}, setHeader() {}, end(text) { payload = text } },
  )
  const topics = JSON.parse(payload).topics
  const rag = topics.find((item) => item.tag.toLowerCase() === 'rag')
  check('归并后 RAG 计数为 2', (rag?.count ?? 0) === 2, JSON.stringify(topics))
  rmSync(dir, { recursive: true, force: true })
}

// 7. 阈值没生效时要如实标记（所有标签都只出现一次 → 退回不过滤）
{
  const dir = mkdtempSync(path.join(tmpdir(), 'wn-thin-'))
  const wiki = path.join(dir, '知识层-wiki')
  mkdirSync(wiki, { recursive: true })
  writeFileSync(path.join(wiki, 'index.md'), '# 索引\n')
  for (const tag of ['甲', '乙', '丙']) {
    writeFileSync(
      path.join(wiki, tag + '.md'),
      '---\n类型: 概念\n标签: [' + tag + ']\n状态: 草稿\n更新: 2026-11-02\n---\n\n正文\n',
    )
  }
  const { ctx, state } = makeCtx()
  ctx.webServer = { register: (route) => { state.route = route; return () => {} } }
  apply(ctx, { root: wiki, topics: { minCount: 2 } })
  await state.definition.execute({ mode: 'list', limit: 1 }, {})

  let body = ''
  await state.route.handler(
    { url: '/api/wiki-notes/state', method: 'GET' },
    { writeHead() {}, setHeader() {}, end(text) { body = text } },
  )
  const payload = JSON.parse(body)
  check('标签全是一次时 fallback 为 true', payload.topicFilter.fallback === true, JSON.stringify(payload.topicFilter))
  check('此时仍然给出主题词（保底）', payload.topics.length === 3, JSON.stringify(payload.topics))
  rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  process.stderr.write(`topics smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log('topics smoke 全部通过（16 项）')
// 测试里 apply 会建目录监听；临时库删掉后监听可能残留，显式收尾更稳
process.exit(0)
