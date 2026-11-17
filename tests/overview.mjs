/**
 * overview.mjs —— 左侧栏「概览」页签的数据源。
 *
 * 钉的是这一条：概览里的数字**只能来自宿主对这一份 corpus 的现算**。
 * 所以断言不写「像 4 一样的数字」，而是造一个小库、把每一项算得出来再比：
 * 页面数量、可检索页面、资料页面、标签按页计、入链 / 孤岛 / 枢纽 / 断链目标、
 * 以及「最近访问」是不是真的因为读了一页才多出一条。
 *
 * 第二个钉子：`/page` 读完一页必须落一次访问记录，而且 `source` 是 `panel`。
 * 少了它，界面上的「最近访问」会永远只有模型的足迹 —— 而那一栏看起来完全正常。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-overview-'))
process.env.DSH_WIKI_CONFIG = path.join(tmp, 'wiki-notes.config.json')
process.env.DSH_WIKI_CALLS_LOG = path.join(tmp, 'calls.jsonl')
process.env.DSH_WIKI_GOVERNANCE_LOG = path.join(tmp, 'governance.jsonl')
// 访问账本指到临时目录：测试不许往插件目录里写「最近访问」
const visitsProbe = path.join(tmp, 'visits.jsonl')
process.env.DSH_WIKI_VISITS_LOG = visitsProbe

const wiki = path.join(tmp, 'wiki')
mkdirSync(path.join(wiki, '概念-concepts'), { recursive: true })
mkdirSync(path.join(wiki, '资料-sources'), { recursive: true })

function page(dir, name, front, body) {
  writeFileSync(
    path.join(wiki, dir, `${name}.md`),
    ['---', ...front, '---', '', `# ${name}`, '', body, ''].join('\n'),
    'utf8',
  )
}

// 甲页 → 乙页，还有两处指向不存在的页（同一个名字写两遍，只该算一处断链）
page('概念-concepts', '甲页', ['类型: 概念', '状态: 已提纯', '标签: [测试, 标签A]', '别名: [甲别名]', '更新: 2026-01-01'], '见 [[乙页]]，另见 [[不存在页]]，再提一次 [[不存在页]]。')
// 乙页 → 甲的**别名**：别名也算存在，所以它不该把甲页算成孤岛
page('概念-concepts', '乙页', ['类型: 概念', '状态: 已提纯', '标签: [标签A]', '更新: 2026-01-02'], '回看 [[甲别名]]。')
page('资料-sources', '资料页', ['类型: 资料', '状态: 待整理', '标签: [测试]', '更新: 2026-01-03'], '一份资料。')
// 没有人链它、它也不链别人
page('概念-concepts', '孤岛页', ['类型: 概念', '状态: 已提纯', '标签: [冷门]', '更新: 2026-01-04'], '只有正文。')

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

let handler = null
const ctx = {
  logger: { info() {}, warn() {} },
  on() {},
  webServer: { register: (definition) => { handler = definition.handler; return () => {} } },
  tools: { register: () => () => {} },
}

const { apply } = await import('../lib/index.js')
apply(ctx, { root: wiki })
if (handler === null) throw new Error('没有捕获到 API handler')

function call(method, route, rawBody) {
  const req = new EventEmitter()
  req.method = method
  req.url = `/api/wiki-notes${route}`
  req.headers = {}
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = String(v) }, end() {} }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${method} ${route}`)), 20000)
    res.end = (body) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(body) } catch { /* 不是 JSON 就算了 */ }
      resolve({ status: res.statusCode, json })
    }
    handler(req, res).catch(reject)
    if (rawBody !== undefined) req.emit('data', Buffer.from(rawBody, 'utf8'))
    req.emit('end')
  })
}

const byTag = (list, tag) => (Array.isArray(list) ? list.find((item) => item && item.tag === tag) : undefined)

// ---------- 1. 状态三态 ----------
const state = await call('GET', '/state')
const ov = state.json?.overview
check('/state 回 200', state.status === 200, String(state.status))
check('三态字段：已连接', state.json?.connection === 'connected', String(state.json?.connection))
check('概览对象存在', ov !== null && typeof ov === 'object', JSON.stringify(ov))
check('最近访问是数组', Array.isArray(state.json?.visits), JSON.stringify(state.json?.visits))

// ---------- 2. 页面数量 ----------
check('总页数 = 4', ov?.pages?.all === 4, String(ov?.pages?.all))
check('资料页面 = 1', ov?.pages?.resources === 1, String(ov?.pages?.resources))
check(
  '可检索 = 总页 − 超大',
  ov?.pages?.searchable === ov?.pages?.all - ov?.problems?.oversized,
  `${ov?.pages?.searchable} vs ${ov?.pages?.all} - ${ov?.problems?.oversized}`,
)
check('体积 > 0', ov?.pages?.bytes > 0, String(ov?.pages?.bytes))

// ---------- 3. 索引状态 ----------
check('扫描时间非空', typeof ov?.index?.scannedAt === 'string' && ov.index.scannedAt.length >= 10, String(ov?.index?.scannedAt))
check('扫描耗时是数字', Number.isFinite(ov?.index?.scannedMs), String(ov?.index?.scannedMs))
check('发现文件 = 4', ov?.index?.discovered === 4, String(ov?.index?.discovered))

// ---------- 4. 内容问题 ----------
check('断链目标 1 处（同名不重复计）', ov?.problems?.brokenTotal === 1, String(ov?.problems?.brokenTotal))
check('断链涉及 1 页', ov?.problems?.brokenPages === 1, String(ov?.problems?.brokenPages))
check('超大页 0', ov?.problems?.oversized === 0, String(ov?.problems?.oversized))

// ---------- 5. 主题与标签 ----------
check('标签种数 = 3（测试 / 标签A / 冷门）', ov?.tagTotal === 3, String(ov?.tagTotal))
check('「测试」计 2 页', byTag(ov?.tags, '测试')?.count === 2, JSON.stringify(byTag(ov?.tags, '测试')))
check('「标签A」计 2 页', byTag(ov?.tags, '标签A')?.count === 2, JSON.stringify(byTag(ov?.tags, '标签A')))
check('「冷门」计 1 页', byTag(ov?.tags, '冷门')?.count === 1, JSON.stringify(byTag(ov?.tags, '冷门')))
check('标签列表不超过 12 条', Array.isArray(ov?.tags) && ov.tags.length <= 12, String(ov?.tags?.length))

// ---------- 6. 知识关系 ----------
// 甲页 → 乙页、乙页 →（别名）甲页：两条链接；指向不存在的页不算「关系」，算内容问题。
check('链接数 = 2', ov?.relations?.links === 2, String(ov?.relations?.links))
check('孤岛 = 2（资料页 + 孤岛页）', ov?.relations?.orphans === 2, String(ov?.relations?.orphans))
check('孤岛样本里没有靠别名被链到的甲页', !(ov?.relations?.orphanSample ?? []).includes('甲页'), JSON.stringify(ov?.relations?.orphanSample))
check('枢纽第一是乙页或甲页（入链 1）', (ov?.relations?.hubPages ?? []).length === 2, JSON.stringify(ov?.relations?.hubPages))
check('枢纽页带 inlinks 数字', (ov?.relations?.hubPages ?? []).every((item) => item.inlinks === 1), JSON.stringify(ov?.relations?.hubPages))
check('最该先补的页 = 不存在页', ov?.relations?.brokenTargets?.[0]?.name === '不存在页', JSON.stringify(ov?.relations?.brokenTargets))
check('断链目标带出现次数', ov?.relations?.brokenTargets?.[0]?.count === 1, JSON.stringify(ov?.relations?.brokenTargets))

// ---------- 7. 全部页面清单 ----------
const pagesRoute = await call('GET', '/pages')
check('/pages 回 200', pagesRoute.status === 200, String(pagesRoute.status))
check('/pages 总数 = 4', pagesRoute.json?.total === 4, String(pagesRoute.json?.total))
check('/pages 每行带类型', (pagesRoute.json?.pages ?? []).every((item) => typeof item.type === 'string'), JSON.stringify(pagesRoute.json?.pages))
const names = (pagesRoute.json?.pages ?? []).map((item) => item.name)
check('/pages 按页名排好序', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, 'zh'))), JSON.stringify(names))

// ---------- 8. /page 读完一页 = 一条访问记录 ----------
const readOne = await call('GET', '/page?name=' + encodeURIComponent('乙页'))
check('/page 回 200', readOne.status === 200, String(readOne.status))
check('/page 读到正文', typeof readOne.json?.found?.body === 'string' && readOne.json.found.body.includes('回看'), JSON.stringify(readOne.json?.found?.name))

const afterRead = await call('GET', '/state')
check('读完一页后最近访问多出一条', Array.isArray(afterRead.json?.visits) && afterRead.json.visits.length === 1, String(afterRead.json?.visits?.length))
check('访问记录指向刚读的那一页', afterRead.json?.visits?.[0]?.name === '乙页', JSON.stringify(afterRead.json?.visits?.[0]))
check('访问来源是 panel', afterRead.json?.visits?.[0]?.source === 'panel', JSON.stringify(afterRead.json?.visits?.[0]))

// 同一页再读一次：不该变成两条（去重按页名，留最新那条）
await call('GET', '/page?name=' + encodeURIComponent('乙页'))
const afterTwice = await call('GET', '/state')
check('同一页读两次仍只占一条', afterTwice.json?.visits?.length === 1, String(afterTwice.json?.visits?.length))

// ---------- 9. /page 的坏输入 ----------
const noName = await call('GET', '/page')
check('/page 缺 name 回 400', noName.status === 400, String(noName.status))
const ghost = await call('GET', '/page?name=' + encodeURIComponent('根本没有这一页'))
check('/page 读不存在的页回 200', ghost.status === 200, String(ghost.status))
check('/page 读不存在的页有说明', ghost.json?.found === null || typeof ghost.json?.note === 'string', JSON.stringify(ghost.json))
const afterGhost = await call('GET', '/state')
check('读不存在的页不记访问', afterGhost.json?.visits?.length === 1, String(afterGhost.json?.visits?.length))

process.stdout.write(`  overview ${total - failed}/${total}\n`)
if (failed > 0) {
  process.stderr.write(`overview: ${failed} 项失败\n`)
  process.exit(1)
}
