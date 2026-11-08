import './support/quiet-ledger.mjs'
/**
 * draft.mjs —— 回写骨架的三处可信度修正（2026-11-03）：
 *
 * 1. 日期按运行机器的本地时区算，且 frontmatter 创建/更新、index 行、log 行共用同一个值
 *    （原来是 toISOString，UTC，本机凌晨 0–8 点会整体差一天）
 * 2. logType 可选，默认 query；非法值（含换行、竖线、超长）不得破坏 `## [日期] 类型 | 标题`
 * 3. renderDraft 第一行必须声明「尚未写入任何文件」——模型会截断或转述，末尾的说明最先丢
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draft, getLocalDate } from '../lib/engine.js'
import { loadCorpus } from '../lib/corpus.js'
import { apply } from '../lib/index.js'

// 测试不许碰用户的真配置
process.env.DSH_WIKI_CONFIG = join(mkdtempSync(join(tmpdir(), 'wiki-notes-draft-')), 'wiki-notes.config.json')

const SAMPLE = fileURLToPath(new URL('../examples/sample-wiki', import.meta.url))
const corpus = await loadCorpus(SAMPLE)

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

/** 测试侧独立写一遍本地日期，不复用被测实现（否则等于自己验证自己）。 */
function localDateOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// UTC 2026-11-02T20:30Z —— 在 +08 是 11-03 04:30，UTC 与本地跨日。
// 换成 toISOString 就会写成 11-02，这条用例才有区分力。
const CROSS = Date.UTC(2026, 10, 2, 20, 30)

ok('getLocalDate 用的是本地日期，不是 UTC', () => {
  assert.equal(getLocalDate(new Date(CROSS)), localDateOf(CROSS))
  const utc = new Date(CROSS).toISOString().slice(0, 10)
  if (utc !== localDateOf(CROSS)) {
    assert.notEqual(getLocalDate(new Date(CROSS)), utc, '仍在使用 UTC 日期')
  }
})

ok('四处日期一致（创建/更新/index/log），且都是本地日期', () => {
  const value = draft(corpus, { title: '示例页', now: CROSS })
  assert.equal(value.date, localDateOf(CROSS))
  const all = [value.frontmatter, value.indexLine, value.logLine].join('\n')
  const found = all.match(/\d{4}-\d{2}-\d{2}/g) ?? []
  assert.equal(found.length, 4, `日期出现 ${found.length} 次：${found.join(' / ')}`)
  assert.equal(new Set(found).size, 1, `日期不一致：${[...new Set(found)].join(' / ')}`)
  assert.equal(found[0], localDateOf(CROSS))
})

ok('不传 logType 时仍是 query（旧调用兼容）', () => {
  const value = draft(corpus, { title: '示例页', now: CROSS })
  assert.equal(value.logType, 'query')
  assert.equal(value.logLine, `## [${localDateOf(CROSS)}] query | 示例页`)
})

ok('logType 能表达真实事件类型（ingest / 结构补齐 / 拍板）', () => {
  for (const logType of ['ingest', '结构补齐', '拍板']) {
    const value = draft(corpus, { title: '示例页', now: CROSS, logType })
    assert.equal(value.logType, logType)
    assert.equal(value.logLine, `## [${localDateOf(CROSS)}] ${logType} | 示例页`)
  }
})

ok('非法 logType 不许破坏 log 行结构', () => {
  for (const bad of ['a\nb', 'a\r\nb', 'a|b', '   ', 'x'.repeat(30)]) {
    const value = draft(corpus, { title: '示例页', now: CROSS, logType: bad })
    assert.equal(value.logType, 'query', `未拦下：${JSON.stringify(bad)}`)
    assert.equal(value.logLine.split('\n').length, 1, 'log 行被换行撑开了')
    assert.match(value.logLine, /^## \[\d{4}-\d{2}-\d{2}\] query \| 示例页$/)
  }
})

/* ------------------------------- 渲染层 ------------------------------- */

const tools = []
apply({
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  logger: { info() {}, warn() {} },
  on: () => {},
}, { root: SAMPLE })

const tool = tools[0]
const render = (args, value) => (tool.output.render(args, value)[0] ?? {}).text ?? ''

{
  const value = await tool.execute({ mode: 'draft', title: '示例页' }, {})
  const text = render({ mode: 'draft' }, value)

  ok('renderDraft 第一行就是「未写入任何文件」', () => {
    const first = text.split('\n')[0]
    assert.equal(first, '⚠ 以下内容仅为待审阅草稿，尚未写入任何文件。')
  })

  ok('骨架正文与两行收尾都还在（声明没有挤掉内容）', () => {
    assert.match(text, /回写骨架：概念-concepts\/示例页\.md/)
    assert.match(text, /落盘后还有三件事/)
    assert.match(text, /## \[\d{4}-\d{2}-\d{2}\] query \| 示例页/)
    assert.match(text, /更新于 \d{4}-\d{2}-\d{2}/)
  })
}

console.log(`\n[draft] 全部通过（${passed} 项）`)
