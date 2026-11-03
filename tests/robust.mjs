/**
 * robust.mjs —— 解析层「安静出错」的那几处。
 *
 * 共同点：它们都不抛异常、不影响启动，只是把内容悄悄改掉 ——
 * 链接少一个、标题整段不见、目录里看不出哪页很旧。测试就钉这些。
 */

import { extractLinks, splitFrontmatter } from '../lib/corpus.js'

let failed = 0
let total = 0
function ok(name, fn) {
  total += 1
  try {
    fn()
  } catch (error) {
    failed += 1
    process.stderr.write(`  ✗ ${name} — ${error?.message ?? error}\n`)
  }
}
function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${hint} 期望 ${e}，实际 ${a}`)
}

// ---------- extractLinks ----------

ok('普通双链', () => eq(extractLinks('见 [[甲]]'), ['甲']))

ok('带显示名', () => eq(extractLinks('见 [[甲|甲的说明]]'), ['甲']))

// 表格里必须写 `\|`，早先会把页名读成 `甲\`，于是整张表的链接都变红链
ok('表格转义竖线不带到页名里', () => {
  const links = extractLinks('| [[甲\\|甲的说明]] | 备注 |')
  eq(links, ['甲'])
  if (links.some((name) => name.includes('\\'))) throw new Error(`页名里还有反斜杠：${links.join(',')}`)
})

ok('锚点被剥掉', () => eq(extractLinks('[[甲#某一节]]'), ['甲']))

ok('锚点 + 显示名', () => eq(extractLinks('[[甲#某节|说明]]'), ['甲']))

// 代码块里的双链是示例，不算链接（splitSections 早就剥了围栏，这里原来没剥，两套口径）
ok('围栏代码块里的不算链接', () => {
  eq(extractLinks('正文\n```\n[[假的]]\n```\n结尾 [[真的]]'), ['真的'])
})

ok('行内代码里的不算链接', () => eq(extractLinks('写法是 `[[页名]]`，例如 [[甲]]'), ['甲']))

ok('多行表格里逐行取', () => eq(extractLinks('| [[甲]] |\n| [[乙\\|说明]] |'), ['甲', '乙']))

// ---------- splitFrontmatter ----------

ok('正常 frontmatter', () => {
  const out = splitFrontmatter('---\n类型: 概念\n更新: 2026-01-01\n---\n\n# 标题\n\n正文')
  eq(out.fields['类型'], '概念')
  eq(out.body.trim().startsWith('# 标题'), true)
})

// 缺收尾 ---：非贪婪正则会吃到正文里下一条分隔线，把标题和首段整段吞掉
ok('缺收尾分隔线时不吞正文', () => {
  const text = '---\n类型: 概念\n\n# 标题\n\n第一段正文。\n\n---\n\n## 小节\n\n第二节。'
  const out = splitFrontmatter(text)
  eq(out.body, text, '正文应原样返回')
  if (out.body.includes('第一段') === false) throw new Error('第一段被吞掉了')
})

ok('正文里的分隔线不被当元数据', () => {
  const text = '# 标题\n\n前面一段\n\n---\n\n后面一段'
  const out = splitFrontmatter(text)
  eq(out.body, text)
})

ok('真 frontmatter 后面还有分隔线时仍只吃第一块', () => {
  const out = splitFrontmatter('---\n类型: 概念\n---\n\n正文\n\n---\n\n别的内容')
  eq(out.fields['类型'], '概念')
  eq(out.body.trim().startsWith('正文'), true)
  if (!out.body.includes('别的内容')) throw new Error('后半段正文丢了')
})

ok('块序列标签仍然解析', () => {
  const out = splitFrontmatter('---\n标签:\n  - RAG\n  - 检索\n---\n正文')
  eq(out.fields['标签'], ['RAG', '检索'])
})

if (failed > 0) {
  process.stderr.write(`robust 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`robust 全部通过（${total} 项）`)
