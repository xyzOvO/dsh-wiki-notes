/**
 * 英文 frontmatter 兼容：title / type / tags / sources / created / updated
 *
 * 起因：一份用英文模板建起来的库，标签全读不到（插件只认中文字段），
 * 表现是检索不命、主题词为空、设置页没有 chip。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCorpus, normalizeFields } from '../lib/corpus.js'
import { search, list } from '../lib/engine.js'

let pass = 0
const ok = (label, cond, extra) => {
  if (!cond) {
    console.error('  ✗ ' + label + (extra ? ' — ' + extra : ''))
    process.exitCode = 1
    return
  }
  pass += 1
  console.log('  ✓ ' + label)
}

// 1) 纯函数：字段与类型值
const f = normalizeFields({
  title: '全面从严治党',
  type: 'concept',
  tags: ['时政', '党建'],
  sources: ['raw/a.md', 'raw/b.md'],
  created: '2026-11-02',
  updated: '2026-11-02',
})
ok('title → 标题', f['标题'] === '全面从严治党')
ok('type → 类型（concept → 概念）', f['类型'] === '概念')
ok('tags → 标签', Array.isArray(f['标签']) && f['标签'].length === 2)
ok('sources 列表 → 来源数量 2', f['来源数量'] === 2)
ok('updated → 更新', f['更新'] === '2026-11-02')

// 中文优先，不被英文覆盖
const g = normalizeFields({ 类型: '实体', type: 'concept', 标签: ['a'], tags: ['b'] })
ok('中文字段优先', g['类型'] === '实体' && g['标签'][0] === 'a')

// 2) 整库：英文目录 + 英文 frontmatter + 英文 index 行格式
const dir = mkdtempSync(join(tmpdir(), 'wn-en-'))
mkdirSync(join(dir, 'concepts'))
writeFileSync(
  join(dir, 'concepts', '全面从严治党.md'),
  ['---', 'title: 全面从严治党', 'type: concept', 'tags: [时政, 党建, 纪律]', 'sources: [raw/a.md]', 'created: 2026-11-02', 'updated: 2026-11-02', '---', '', '# 全面从严治党', '', '把纪律挺在前面。', ''].join('\n'),
)
writeFileSync(
  join(dir, 'index.md'),
  ['# 内容目录', '', '- [[全面从严治党]] — 本周时政主线（2026-11-02 / 1）', ''].join('\n'),
)

const corpus = await loadCorpus(dir)
ok('扫到 1 页', corpus.pages.length === 1)
ok('标签读到了', (corpus.pages[0].fields['标签'] || []).join(',') === '时政,党建,纪律')
ok('类型映射成概念', corpus.pages[0].fields['类型'] === '概念')
ok('来源数量 = 1', corpus.pages[0].fields['来源数量'] === 1)
ok('index 行也解析了摘要', corpus.indexLines[0]?.summary?.startsWith('本周时政主线'), JSON.stringify(corpus.indexLines[0]))
ok('index 行解析出日期与数量', corpus.indexLines[0]?.sources === 1 && corpus.indexLines[0]?.updated === '2026-11-02')

const hits = search(corpus, '党建', { limit: 5 })
ok('按标签能搜到', hits.hits.length >= 1 && hits.hits[0].name === '全面从严治党')

const listed = list(corpus, { tags: '时政' })
ok('list --tags 能筛到', listed.rows.length === 1)
const listedType = list(corpus, { type: '概念' })
ok('list --type 概念 能筛到', listedType.rows.length === 1)

rmSync(dir, { recursive: true, force: true })
console.log('\nfields smoke ' + (process.exitCode ? '有失败' : `全部通过（${pass} 项）`))
