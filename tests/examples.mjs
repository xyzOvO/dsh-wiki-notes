/**
 * examples.mjs —— 随包发布的两个示例库自己得是健康的。
 *
 * 为什么单开一个测试：`examples/` 在 `files` 里，也就是说 npm 用户第一眼看到的
 * 就是它。示例库要是被改坏了（比如某页少了 frontmatter、标题写成 `## 而不是 #`、
 * 链接指向一个删掉的页），坏的不是测试而是「装完试一下」这条唯一的低门槛体验。
 *
 * 两个库代表两种结构，对应 README 里的「第 0 层」和「第 1 层」：
 *   demo-wiki —— 分目录、七个 frontmatter 字段、标签/别名/双链齐全
 *   flat-wiki —— 一个目录 + 一堆 .md，零 frontmatter、没有 index.md / log.md
 * 断言的重点不是「有几页」，而是「两种结构都读得出东西、缺的东西不报错」。
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { loadCorpus } from '../lib/corpus.js'

const demo = fileURLToPath(new URL('../examples/demo-wiki/', import.meta.url))
const flat = fileURLToPath(new URL('../examples/flat-wiki/', import.meta.url))

/** 入链统计（示例库的枢纽页断言要用） */
function inlinks(corpus) {
  const counts = new Map()
  for (const page of corpus.pages) {
    for (const link of page.links) {
      const target = corpus.byName.get(link)
      if (target && target.name !== page.name) counts.set(target.name, (counts.get(target.name) ?? 0) + 1)
    }
  }
  return counts
}

// ---------------------------------------------------------------- demo-wiki
{
  const corpus = await loadCorpus(demo)
  assert.equal(corpus.pages.length, 10, `demo-wiki 应该有 10 页，实际 ${corpus.pages.length}`)

  const byName = corpus.byName
  assert.ok(byName.has('萃取率'), 'demo-wiki 缺「萃取率」页')
  assert.equal(byName.get('萃取率').fields['类型'], '概念')
  assert.equal(byName.get('某咖啡课第二讲·资料摘要').fields['类型'], '资料')
  assert.equal(corpus.stats.resources, 1, '资料页应该正好 1 个（只有那篇课程摘要）')

  // 别名要归成数组，检索的 +50 分靠它
  assert.deepEqual(byName.get('萃取率').fields['别名'], ['Extraction Yield', '萃取率公式'])
  assert.deepEqual(byName.get('V60滤杯').fields['别名'], ['V60', '锥形滤杯'])

  // 标签同理
  assert.ok(byName.get('研磨度').fields['标签'].includes('咖啡'), '「研磨度」的标签里应该有「咖啡」')

  // 枢纽页与红链：示例库的理由就是让人看见这两种东西
  const counts = inlinks(corpus)
  assert.ok((counts.get('萃取率') ?? 0) >= 5, `「萃取率」应该被链到至少 5 次，实际 ${counts.get('萃取率')}`)
  assert.equal(corpus.stats.brokenTotal, 1, `应该有且只有 1 处红链，实际 ${corpus.stats.brokenTotal}`)
  assert.deepEqual(corpus.brokenLinks.find((item) => item.name === '萃取率')?.missing, ['浓度计'])

  // 每个页面都得有正文与小节，不能是空壳
  for (const page of corpus.pages) {
    assert.ok(page.body.length > 40, `「${page.name}」正文太短（${page.body.length} 字）`)
    assert.ok(Array.isArray(page.sections), `「${page.name}」没有小节数组`)
  }
}

// ---------------------------------------------------------------- flat-wiki
{
  const corpus = await loadCorpus(flat)
  assert.equal(corpus.pages.length, 8, `flat-wiki 应该有 8 页，实际 ${corpus.pages.length}`)
  assert.equal(corpus.stats.resources, 0, 'flat-wiki 没有任何 frontmatter，不该有资料页')

  // 零 frontmatter 时字段一律为空 —— 不报错、不当成解析失败
  for (const page of corpus.pages) {
    assert.deepEqual(page.fields, {}, `「${page.name}」不该解析出字段（它没有 frontmatter）`)
    assert.equal(page.dir, '.', `「${page.name}」应该是平铺在根目录的（dir=${page.dir}）`)
  }

  // 正文照样读得到，双链照样解析得出（红链也不算崩）
  const byName = corpus.byName
  assert.ok(byName.get('刀具保养').body.includes('磨刀'), '「刀具保养」正文没读到')
  assert.ok(byName.get('刀具保养').links.includes('磨刀石的目数'), '双链没解析出来')
  assert.equal(corpus.stats.brokenTotal, 1, `flat-wiki 应该有且只有 1 处红链，实际 ${corpus.stats.brokenTotal}`)

  // 没有 index.md / log.md 是合法结构，不该被当成错误
  assert.equal(corpus.stats.logPresent, false, 'flat-wiki 不该有 log.md')
  assert.ok(corpus.indexLines.length === 0, 'flat-wiki 不该有 index.md')
}

console.log('[examples] 全部通过（两个示例库：demo-wiki 结构与 flat-wiki 零结构）')
