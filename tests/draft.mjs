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
import { loadCorpus, splitFrontmatter } from '../lib/corpus.js'
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

/* --------------------------- 文件名安全（第四批）--------------------------- */

ok('标题含文件名禁用字符时：路径改用替代名，带不出知识层', () => {
  for (const bad of ['RAG: 取舍', '../../etc/passwd']) {
    const value = draft(corpus, { title: bad, now: CROSS })
    assert.ok(value.nameWarning, `缺少 nameWarning：${bad}`)
    assert.ok(!/[\\/:*?"<>|]/.test(value.safeTitle), `替代名里仍禁用字符：${value.safeTitle}`)
    // 斜杠是「路径」而不是「字符」：../../etc/passwd 曾原样生成 概念-concepts/../../etc/passwd.md
    assert.ok(!value.file.split('/').includes('..'), `路径仍在穿越：${value.file}`)
    assert.match(value.file, /^概念-concepts\/[^/]+\.md$/)
  }
})

ok('标题正常时不产生多余的 nameWarning', () => {
  const value = draft(corpus, { title: '普通标题', now: CROSS })
  assert.equal(value.nameWarning, undefined)
  assert.equal(value.safeTitle, undefined)
})

{
  const value = await tool.execute({ mode: 'draft', title: 'RAG: 取舍' }, {})
  const text = render({ mode: 'draft' }, value)
  ok('renderDraft 把文件名问题印在骨架之后、frontmatter 之前', () => {
    const lines = text.split('\n')
    const at = lines.findIndex((line) => line.startsWith('⚠ 标题里的'))
    assert.ok(at > 0, '渲染里没有 nameWarning 行')
    assert.match(lines[at], /带出知识层/)
    // 紧挨着「回写骨架」那行，人一眼就能对上是哪个路径有问题；但不能掉到 frontmatter 后面去
    assert.ok(at > lines.findIndex((line) => line.startsWith('回写骨架')), '提醒排在了骨架前面')
    assert.ok(at < lines.findIndex((line) => line === '---'), '提醒掉到了 frontmatter 后面')
  })
}

ok('类型没有对应目录时给 typeWarning（别让类型与目录自相矛盾）', () => {
  const value = draft(corpus, { title: '面试备忘', type: '备忘', now: CROSS })
  assert.match(String(value.typeWarning), /没有对应目录/)
  assert.match(String(value.typeWarning), /SKILL\.md/)
  // 已知类型不该有这条
  assert.equal(draft(corpus, { title: '面试备忘', type: '概念', now: CROSS }).typeWarning, undefined)
})

ok('来源数量只写非负整数（负数与小数不落盘）', () => {
  assert.equal(draft(corpus, { title: '甲', now: CROSS, sources: -3 }).frontmatter.includes('来源数量: 0'), true)
  assert.equal(draft(corpus, { title: '甲', now: CROSS, sources: 2.7 }).frontmatter.includes('来源数量: 2'), true)
  assert.equal(draft(corpus, { title: '甲', now: CROSS, sources: '3' }).frontmatter.includes('来源数量: 3'), true)
})

/* ------------------- 第五批：frontmatter YAML 清洗 ------------------- */

/**
 * 测试侧独立解析 `键: [ ... ]` 形式的内联数组：只认 YAML 双引号标量，
 * 这样裸 `]`、`,`、换行、未转义的引号都过不了 —— 不复用被测实现。
 * 双引号标量里的 \" \\ \n \r \t 按 YAML 规则还原。
 */
function parseInlineArray(line, key) {
  const prefix = `${key}: [`
  assert.ok(line.startsWith(prefix), `不是 ${key} 数组行：${JSON.stringify(line)}`)
  assert.ok(line.endsWith(']'), `数组行没以 ] 收尾：${JSON.stringify(line)}`)
  const inner = line.slice(prefix.length, -1).trim()
  if (inner === '') return []
  const items = []
  let i = 0
  while (i < inner.length) {
    if (inner[i] !== '"') {
      // 安全标量没必要包引号（正常输出格式必须保持原样）；只要它不含结构字符即可。
      let j = i
      while (j < inner.length && inner[j] !== ',') j += 1
      const plain = inner.slice(i, j).trim()
      assert.ok(!/[\[\]"\\\r\n]/.test(plain), `裸标量含结构字符：${JSON.stringify(plain)}`)
      items.push(plain)
      if (j < inner.length) {
        assert.match(inner.slice(j), /^, /, `数组分隔符错误：${JSON.stringify(inner.slice(j))}`)
        i = j + 2
      } else {
        i = j
      }
      continue
    }
    i += 1
    let s = ''
    let closed = false
    while (i < inner.length) {
      const ch = inner[i]
      if (ch === '"') { closed = true; i += 1; break }
      if (ch === '\\') {
        const esc = inner[i + 1]
        i += 2
        if (esc === 'n') s += '\n'
        else if (esc === 'r') s += '\r'
        else if (esc === 't') s += '\t'
        else if (esc === '"' || esc === '\\' || esc === '/') s += esc
        else throw new Error(`非法转义 \\${esc}`)
        continue
      }
      s += ch
      i += 1
    }
    assert.ok(closed, `标量没有闭合引号：${JSON.stringify(inner)}`)
    items.push(s)
    if (i < inner.length) {
      assert.match(inner.slice(i), /^, /, `数组分隔符错误：${JSON.stringify(inner.slice(i))}`)
      i += 2
    }
  }
  return items
}

/** frontmatter 必须是单个 `---` 块，且只有一对边界。 */
function frontmatterLines(value) {
  const lines = value.frontmatter.split('\n')
  assert.equal(lines[0], '---', 'frontmatter 没有以 --- 开头')
  assert.equal(lines.at(-1), '---', 'frontmatter 没有以 --- 收尾')
  assert.equal(lines.filter((l) => l === '---').length, 2, 'frontmatter 边界不唯一')
  assert.ok(!lines.slice(1, -1).some((l) => /^---\s*$/.test(l)), '中间出现裸 ---，会提前闭合 frontmatter')
  return lines
}

ok('tags/aliases 含 ] , 换行 引号 竖线时，frontmatter 仍是合法内联数组', () => {
  const tags = ['a]b', 'c,d', 'e\nf', 'say "hi"', 'x|y', 'back\\slash']
  const aliases = ['alias]1', 'alias,2', 'alias\n3', 'alias|4']
  const value = draft(corpus, { title: '宿主页', now: CROSS, tags, alias: aliases })
  const lines = frontmatterLines(value)
  const tagLine = lines.find((l) => l.startsWith('标签: ['))
  const aliasLine = lines.find((l) => l.startsWith('别名: ['))
  assert.ok(tagLine && aliasLine, '缺少标签/别名数组行')
  const parsedTags = parseInlineArray(tagLine, '标签')
  const parsedAliases = parseInlineArray(aliasLine, '别名')
  // 清洗后每个元素必须是单个不含结构字符的标量（corpus.js 按逗号切，不能留裸逗号）
  for (const item of [...parsedTags, ...parsedAliases]) {
    assert.ok(!/[\[\],，\r\n"\\]/.test(item), `清洗后仍有结构字符：${JSON.stringify(item)}`)
  }
  assert.deepEqual(parsedTags, ['ab', 'cd', 'ef', 'say hi', 'x|y', 'backslash'])
  assert.deepEqual(parsedAliases, ['alias1', 'alias2', 'alias3', 'alias|4'])
  // 文件名走原安全替换逻辑，不因标签清洗而改变
  assert.equal(value.file, '概念-concepts/宿主页.md')
})

ok('title/summary 含 --- 或换行时，frontmatter 不提前闭合且追加行仍是单行', () => {
  const title = '危险 --- 标题\n第二行 | 尾'
  const summary = '摘要\n---\n注入'
  const value = draft(corpus, { title, summary, now: CROSS, logType: 'ingest' })
  frontmatterLines(value)
  assert.equal(value.indexLine.split('\n').length, 1, 'indexLine 被 summary 的换行撑开')
  assert.ok(value.indexLine.includes('摘要'), '摘要原文丢失')
  const at = value.logLine.indexOf(' | ')
  assert.ok(at > 0, 'logLine 结构不对')
  const expectedTitle = '危险 --- 标题\\n第二行 | 尾'
  assert.equal(value.logLine.slice(at + 3), expectedTitle, '标题原文（换行转义）应保留在行尾')
})

ok('draft 的 frontmatter 能被本库 corpus.js 读回来（含特殊字符）', () => {
  const tags = ['a]b', 'c,d', 'e\nf', 'say "hi"', 'x|y', 'back\\slash']
  const aliases = ['alias]1', 'alias,2', 'alias\n3', 'alias|4']
  const value = draft(corpus, { title: '回读页', now: CROSS, tags, alias: aliases })
  const parsed = splitFrontmatter(`${value.frontmatter}\n\n${value.body}`)
  assert.ok(parsed, 'corpus.js 没识别出 frontmatter 边界')
  // corpus.js 按逗号切分元素；清洗后每个标签/别名必须是单个不含结构字符的标量
  assert.deepEqual(parsed.fields['标签'], ['ab', 'cd', 'ef', 'say hi', 'x|y', 'backslash'], '标签回读不一致')
  assert.deepEqual(parsed.fields['别名'], ['alias1', 'alias2', 'alias3', 'alias|4'], '别名回读不一致')
})

ok('正常 tags/aliases/title/summary 的输出格式不变（回归守卫）', () => {
  const baseline = draft(corpus, { title: '普通标题', now: CROSS, tags: ['甲', '乙'], alias: ['A'], summary: '正常摘要' })
  const lines = baseline.frontmatter.split('\n')
  assert.deepEqual(lines, [
    '---',
    '类型: 概念',
    '状态: 草稿',
    '标签: [甲, 乙]',
    '别名: [A]',
    '来源数量: 0',
    `创建: ${localDateOf(CROSS)}`,
    `更新: ${localDateOf(CROSS)}`,
    '---',
  ])
  assert.equal(baseline.body.replace(/\n/g, '\\n').includes('# 普通标题'), true)
  assert.equal(baseline.indexLine, `- [[普通标题]] — 正常摘要（0 份资料，更新于 ${localDateOf(CROSS)}）`)
  assert.equal(baseline.logLine, `## [${localDateOf(CROSS)}] query | 普通标题`)
})

// 别名查表大小写：byAlias 的 key 全小写（corpus.js:339），draft 若用标题原样查会漏报「已存在」，
// 回写时就会覆盖旧页。样例库真实别名原文 `Fine-tuning vs RAG`（页「微调与检索增强」）。
ok('draft 的 exists 用别名的大写形式也能查到已存在的页', () => {
  const d = draft(corpus, { title: 'FINE-TUNING VS RAG' })
  assert.ok(d.exists, '大写作标题时 exists 为 null —— 别名查表没做小写化，会覆盖旧页')
  assert.equal(d.exists.name, '微调与检索增强')
})

console.log(`\n[draft] 全部通过（${passed} 项）`)
