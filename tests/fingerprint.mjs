#!/usr/bin/env node
/**
 * fingerprint.mjs —— 库内容指纹的自检（进 npm test）。
 *
 * 守的是一条原则：检索真正读到的东西变了，指纹必须变；只是顺序 / 派生量变了，
 * 指纹必须不变。旧算法（name|body.length）在这张表上会连输五行。
 */

import { fingerprintOf } from './local/library-fingerprint.mjs'

let total = 0
function check(label, condition, detail = '') {
  total += 1
  if (!condition) {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    process.exitCode = 1
  }
}

const page = (name, body, fields = {}) => ({ name, file: `概念-concepts/${name}.md`, body, fields })
const line = (name, summary) => ({ name, summary, sources: '', updated: '', raw: `- [[${name}]] — ${summary}` })
const base = () => ({
  pages: [
    page('甲', '今天股市大涨', { 别名: ['甲页'], 标签: ['金融'] }),
    page('乙', '另一段正文', { 别名: ['乙页'], 标签: ['常识'] }),
  ],
  indexLines: [line('甲', '一份摘要')],
  scaleLine: '267 份资料 · 123 个页面',
})

const fp = (mutate) => {
  const corpus = base()
  mutate(corpus)
  return fingerprintOf(corpus)
}

const original = fingerprintOf(base())

check('同一份库两次计算一致', original === fingerprintOf(base()))
check('指纹格式 sha256:16 位十六进制', /^sha256:[0-9a-f]{16}$/.test(original), original)

// —— 变了必须报（这五行是旧算法的盲区）——
check('等长改写正文 → 变', fp((c) => { c.pages[0].body = '今天股市暴跌' }) !== original)
check('别名改字 → 变', fp((c) => { c.pages[0].fields['别名'] = ['甲页新版'] }) !== original)
check('标签改字 → 变', fp((c) => { c.pages[0].fields['标签'] = ['经济'] }) !== original)
check('index 摘要改字 → 变', fp((c) => { c.indexLines[0].summary = '另一份摘要' }) !== original)
check('规模行改字 → 变', fp((c) => { c.scaleLine = '268 份资料 · 123 个页面' }) !== original)
check('页名改字 → 变', fp((c) => { c.pages[0].name = '甲改' }) !== original)
check('文件名改了（同页名）→ 变', fp((c) => { c.pages[0].file = '资料-sources/甲.md' }) !== original)
check('多一页 → 变', fp((c) => { c.pages.push(page('丙', '新增页')) }) !== original)
check('加一个 frontmatter 字段 → 变', fp((c) => { c.pages[0].fields['状态'] = '存疑' }) !== original)

// —— 没变不许报（避免「没改内容却要重导基线」）——
check('页顺序变化 → 不变', fp((c) => { c.pages.reverse() }) === original)
check('frontmatter 键顺序变化 → 不变', fp((c) => {
  const f = c.pages[0].fields
  c.pages[0].fields = { 标签: f['标签'], 别名: f['别名'] }
}) === original)

const aliasesA = fp((c) => { c.pages[0].fields['别名'] = ['甲页', '另一个别名'] })
const aliasesB = fp((c) => { c.pages[0].fields['别名'] = ['另一个别名', '甲页'] })
check('同一别名集合内换序 → 不变', aliasesA === aliasesB)

const two = base()
two.indexLines.push(line('乙', '乙摘要'))
const twoRev = { ...two, indexLines: [...two.indexLines].reverse() }
check('同一 indexLines 集合换序 → 不变', fingerprintOf(two) === fingerprintOf(twoRev))

check('mtime / bytes / sections / links 变化 → 不变', fp((c) => {
  c.pages[0].mtime = new Date('2030-01-01')
  c.pages[0].bytes = 99999
  c.pages[0].sections = [{ title: '新节', text: 'x' }]
  c.pages[0].links = ['别的页']
}) === original)
check('log / stats / brokenLinks 变化 → 不变', fp((c) => {
  c.log = [{ date: '2030-01-01', type: 'fix', title: 'x' }]
  c.stats = { pages: 999 }
  c.brokenLinks = ['红链']
}) === original)

// —— 空库与缺字段不炸 ——
check('空库稳定', fingerprintOf({}) === fingerprintOf({ pages: [], indexLines: [], scaleLine: null }))
check('空库与有一页不同', fingerprintOf({}) !== original)
check('缺 file / fields / body 的页不炸', /^sha256:/.test(fingerprintOf({ pages: [{ name: '裸页' }] })))

if (!process.exitCode) console.log(`[fingerprint] 全部通过（${total} 项）`)
