/**
 * watch smoke：在临时迷你库里验证「改完文件 → 缓存作废 → 下次查询看到新内容」。
 *
 * 不动真库：自己建一个 3 页的小仓库，跑完删掉。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DSH_WIKI_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-cfg-')), 'wiki-notes.config.json')

const dir = path.join(os.tmpdir(), `wiki-watch-${Date.now()}`)
mkdirSync(path.join(dir, '概念-concepts'), { recursive: true })

function page(name, body) {
  const file = path.join(dir, '概念-concepts', `${name}.md`)
  writeFileSync(
    file,
    `---\n类型: 概念\n状态: 草稿\n标签: [测试]\n别名: []\n来源数量: 1\n创建: 2026-11-01\n更新: 2026-11-01\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  )
  return file
}

page('甲页', '关于玄武的内容。')
page('乙页', '关于白虎的内容。')

const captured = []
const cleanups = []
let watchedRoot = ''

const ctx = {
  logger: { info() {}, warn() {} },
  on(event, handler) {
    if (event === 'dispose') cleanups.push(handler)
  },
  webServer: { register: () => () => {} },
  tools: {
    register: (definition) => {
      captured.push(definition)
      return () => {}
    },
  },
}

const { apply } = await import('../lib/index.js')
apply(ctx, { root: dir })
watchedRoot = dir

const tool = captured[0]
if (tool === undefined) throw new Error('没有捕获到工具')

const search = async (query) => {
  const value = await tool.execute({ mode: 'search', query })
  return value
}

const before = await search('玄武')
console.log('初次查询「玄武」：', before.total, '命中 →', (before.hits ?? []).map((h) => h.name).join('、'))

// 新增一页，等监听 + debounce（400ms）跑完
page('丙页', '关于朱雀的内容。')
await new Promise((resolve) => setTimeout(resolve, 900))

const after = await search('朱雀')
console.log('新增「丙页」后查「朱雀」：', after.total, '命中 →', (after.hits ?? []).map((h) => h.name).join('、'))
if (after.total === 0) throw new Error('监听没生效：新增的页查不到（缓存没作废）')

// 改一页正文，看内容是否跟着变
writeFileSync(path.join(dir, '概念-concepts', '乙页.md'), '---\n类型: 概念\n状态: 草稿\n标签: [测试]\n别名: []\n来源数量: 1\n创建: 2026-11-01\n更新: 2026-11-02\n---\n\n# 乙页\n\n关于貔貅的内容。\n', 'utf8')
await new Promise((resolve) => setTimeout(resolve, 900))

const edited = await search('貔貅')
console.log('改「乙页」后查「貔貅」：', edited.total, '命中 →', (edited.hits ?? []).map((h) => h.name).join('、'))
if (edited.total === 0) throw new Error('监听没生效：改过的正文查不到')

// 删一页
unlinkSync(path.join(dir, '概念-concepts', '甲页.md'))
await new Promise((resolve) => setTimeout(resolve, 900))
const removed = await search('玄武')
console.log('删「甲页」后查「玄武」：', removed.total, '命中')
if (removed.total !== 0) throw new Error('监听没生效：删掉的页还能查到')

for (const cleanup of cleanups) cleanup()
rmSync(dir, { recursive: true, force: true })

console.log('\nwatch smoke 全部通过（新增 / 修改 / 删除 都能立刻反映）')
