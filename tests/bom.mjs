/**
 * bom.mjs —— UTF-8 BOM（U+FEFF）在读取层的处理。
 *
 * Windows 上 PowerShell 5.1 的 `Out-File -Encoding utf8`、记事本写出的 .md / .json
 * 开头常带一个 BOM。它是编码标记，不是内容；读进来若不剥，会粘在首个标题、
 * 首个 `##` 小节、log 首条记录的行首，让行首正则整条失效；配置文件更会被
 * JSON.parse 判成坏文件，下次写入时把完好的配置备份成 .broken。
 *
 * 这些故障都不抛异常，只是「看起来库里没有 / 还没配库」，所以专门钉住。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadCorpus, splitFrontmatter, splitSections } from '../lib/corpus.js'
import { readConfigFile, readJsonFile, readPromptConfig, writeConfigFile } from '../lib/config.js'

const BOM = '\uFEFF'
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
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
const eq = (actual, expected, hint = '') =>
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${hint} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)

// ---------- 纯函数兜底：有人不经过 loadCorpus 直接喂字符串 ----------
ok('splitFrontmatter 直接吃带 BOM 的字符串', () => {
  const out = splitFrontmatter(BOM + '---\n类型: 概念\n---\n\n# 标题\n\n正文')
  eq(out.fields['类型'], '概念')
  assert(out.body.trim().startsWith('# 标题'), '正文没从 BOM 后开始')
})

// ---------- 整库：BOM 在读取层统一剥掉 ----------
const root = mkdtempSync(path.join(tmpdir(), 'wiki-notes-bom-'))
try {
  mkdirSync(path.join(root, '概念-concepts'), { recursive: true })
  // 1) 有 frontmatter + BOM
  writeFileSync(path.join(root, '概念-concepts', '甲.md'),
    BOM + '---\n别名: [别名甲]\n标签: [检索词]\n---\n\n# 甲\n\n## 第一节\n\n这里写着检索词。\n', 'utf8')
  // 2) 无 frontmatter + BOM，且首行就是 `##` 小节
  writeFileSync(path.join(root, '概念-concepts', '乙.md'),
    BOM + '## 第二节\n\n这里也写着检索词。\n', 'utf8')
  // 3) 无 BOM 对照
  writeFileSync(path.join(root, '概念-concepts', '丙.md'),
    '## 第三节\n\n检索词。\n', 'utf8')
  // 4) index.md 第一行就是目录行，前面粘 BOM
  writeFileSync(path.join(root, 'index.md'),
    BOM + '- [[甲]] — 摘要甲（1 份资料，2026-11-10）\n- [[乙]] — 摘要乙（1 份资料，2026-11-10）\n', 'utf8')
  // 5) log.md 第一行就是标题行，前面粘 BOM（第二条不带）
  writeFileSync(path.join(root, 'log.md'),
    BOM + '## [2026-11-10] fix | 第一条\n\n正文一。\n\n## [2026-11-09] ingest | 第二条\n\n正文二。\n', 'utf8')

  const corpus = await loadCorpus(root)
  const byName = new Map(corpus.pages.map((p) => [p.name, p]))

  ok('无 frontmatter 的页：BOM 不混进正文', () => {
    const body = byName.get('乙').body
    assert(body.charCodeAt(0) !== 0xfeff, 'body 第一个字符仍是 U+FEFF')
    assert(body.startsWith('## 第二节'), `正文开头不对：${JSON.stringify(body.slice(0, 20))}`)
  })
  ok('无 frontmatter 的页：首行 `##` 能切出小节', () => {
    eq(byName.get('乙').sections.map((s) => s.title), ['第二节'])
  })
  ok('有 frontmatter 的页：字段照常解析', () => {
    eq(byName.get('甲').fields['别名'], ['别名甲'])
    eq(byName.get('甲').fields['标签'], ['检索词'])
  })
  ok('index.md 首条目录行不因 BOM 丢掉', () => {
    eq(corpus.indexLines.map((l) => l.name), ['甲', '乙'])
  })
  ok('log.md 首条记录不因 BOM 丢掉', () => {
    eq(corpus.log.map((e) => e.title), ['第一条', '第二条'])
    eq(corpus.stats.logEntries, 2)
  })

  // 内容保真：只剥开头那一个，正文中间的 U+FEFF 是零宽不换行空格，属于内容
  const mid = mkdtempSync(path.join(tmpdir(), 'wiki-notes-bom-mid-'))
  try {
    writeFileSync(path.join(mid, '丁.md'), BOM + '# 丁\n\n零宽\uFEFF不换行空格要留住。\n', 'utf8')
    const c2 = await loadCorpus(mid)
    ok('正文中间的 U+FEFF 不被删（只剥开头那一个）', () => {
      assert(c2.pages[0].body.includes('零宽\uFEFF不换行空格要留住。'), '中间的 BOM 被吃掉了')
      assert(c2.pages[0].body.charCodeAt(0) !== 0xfeff, '开头的 BOM 反而没剥')
    })
  } finally {
    rmSync(mid, { recursive: true, force: true })
  }

  ok('splitSections 本身不处理 BOM（由读取层负责，别偷偷改纯函数契约）', () => {
    // 文档化现状：BOM 交给 stripBom，splitSections 保持「给什么切什么」
    eq(splitSections(BOM + '## 第一节\n\n内容。\n').map((s) => s.title), [''])
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---------- 配置文件：带 BOM 的 JSON 不能被当成坏文件 ----------
const cfgDir = mkdtempSync(path.join(tmpdir(), 'wiki-notes-bom-cfg-'))
const cfgFile = path.join(cfgDir, 'wiki-notes.config.json')
const savedEnv = process.env.DSH_WIKI_CONFIG
try {
  writeFileSync(cfgFile,
    BOM + JSON.stringify({ root: '/tmp/vault-a', prompt: { enabled: true, override: '要查。' } }, null, 2), 'utf8')
  process.env.DSH_WIKI_CONFIG = cfgFile

  ok('带 BOM 的配置：库路径读得到（不是「还没配库」）', () => {
    eq(readConfigFile(cfgDir), '/tmp/vault-a')
  })
  ok('带 BOM 的配置：提示词读得到', () => {
    eq(readPromptConfig(cfgDir).override, '要查。')
  })
  ok('带 BOM 的配置：下次写入不产生 .broken（没把好配置当坏文件埋掉）', () => {
    writeConfigFile(cfgDir, '/tmp/vault-b')
    assert(!readdirSync(cfgDir).some((n) => n.endsWith('.broken')),
      `产生了备份文件：${readdirSync(cfgDir).join(',')}`)
    eq(readConfigFile(cfgDir), '/tmp/vault-b')
  })

  // 宿主半还有两处读 JSON：package.json（版本号）与 lint-history.json（历史对比）。
  // 它们以前裸 JSON.parse，带 BOM 时分别退化成「版本 unknown」「第一次记录基线」。
  const jsonFile = path.join(cfgDir, 'any.json')
  ok('readJsonFile：带 BOM 的 JSON 读得到（宿主半统一入口）', () => {
    writeFileSync(jsonFile, BOM + '{"version":"9.9.9","keys":["甲"]}', 'utf8')
    eq(readJsonFile(jsonFile), { version: '9.9.9', keys: ['甲'] })
  })
  ok('readJsonFile：不带 BOM 的 JSON 照常读', () => {
    writeFileSync(jsonFile, '{"version":"1.2.3"}', 'utf8')
    eq(readJsonFile(jsonFile), { version: '1.2.3' })
  })
  ok('readJsonFile：正文中间的 U+FEFF 是内容，不剥', () => {
    writeFileSync(jsonFile, '{"text":"甲' + BOM + '乙"}', 'utf8')
    eq(readJsonFile(jsonFile).text, '甲' + BOM + '乙')
  })
  ok('readJsonFile：真坏文件照样抛（不把错误吞成空对象）', () => {
    writeFileSync(jsonFile, '{not json', 'utf8')
    let threw = false
    try { readJsonFile(jsonFile) } catch { threw = true }
    assert(threw, '坏 JSON 没抛错')
  })
} finally {
  if (savedEnv === undefined) delete process.env.DSH_WIKI_CONFIG
  else process.env.DSH_WIKI_CONFIG = savedEnv
  rmSync(cfgDir, { recursive: true, force: true })
}

if (failed > 0) {
  process.stderr.write(`bom 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`bom 全部通过（${total} 项）`)
