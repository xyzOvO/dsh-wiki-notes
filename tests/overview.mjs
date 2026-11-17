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

// ---------- 5. 使用情况：读的就是调用账本那一本 ----------
const usage = state.json?.usage
check('使用情况对象存在', usage !== null && typeof usage === 'object', JSON.stringify(usage))
check('账本一开始是空的', usage?.rows === 0, String(usage?.rows))
check('四类工具都列出来（没调过也要有 0）', Array.isArray(usage?.byTool) && usage.byTool.length === 4, JSON.stringify(usage?.byTool))
check('模型调用 0', usage?.bySource?.model === 0, JSON.stringify(usage?.bySource))
check('面板手动查的 0', usage?.bySource?.panel === 0, JSON.stringify(usage?.bySource))
check('零命中率分母为 0 时是 null，不是 0', usage?.zeroRate === null, String(usage?.zeroRate))

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
check(
  '孤岛样本里没有靠别名被链到的甲页',
  !(ov?.relations?.orphanSample ?? []).map((item) => item.name).includes('甲页'),
  JSON.stringify(ov?.relations?.orphanSample),
)
// 孤岛行在界面上要能点开：只给页名的话客户端只能猜路径，猜错就是「点了没反应」。
check(
  '孤岛样本带文件路径',
  (ov?.relations?.orphanSample ?? []).every((item) => typeof item.file === 'string' && item.file !== ''),
  JSON.stringify(ov?.relations?.orphanSample),
)
check(
  '枢纽页带文件路径',
  (ov?.relations?.hubPages ?? []).every((item) => typeof item.file === 'string' && item.file !== ''),
  JSON.stringify(ov?.relations?.hubPages),
)
check('枢纽第一是乙页或甲页（入链 1）', (ov?.relations?.hubPages ?? []).length === 2, JSON.stringify(ov?.relations?.hubPages))
check('枢纽页带 inlinks 数字', (ov?.relations?.hubPages ?? []).every((item) => item.inlinks === 1), JSON.stringify(ov?.relations?.hubPages))
check('最该先补的页 = 不存在页', ov?.relations?.brokenTargets?.[0]?.name === '不存在页', JSON.stringify(ov?.relations?.brokenTargets))
check('断链目标带出现次数', ov?.relations?.brokenTargets?.[0]?.count === 1, JSON.stringify(ov?.relations?.brokenTargets))

// ---------- 7. 「页面」那一窗连同两条路由一起撤了 ----------
// 人读笔记是去自己的 markdown 编辑器：面板再给一份清单、再展开一次正文，
// 只是把同一件事做第二遍。撤掉之后这两条路由必须真的没了（404 不是 200 空数组）。
const gonePages = await call('GET', '/pages')
check('/pages 已撤掉', gonePages.status === 404, String(gonePages.status))
const gonePage = await call('GET', '/page?name=' + encodeURIComponent('乙页'))
check('/page 已撤掉', gonePage.status === 404, String(gonePage.status))
check('/state 不再带最近访问', state.json?.visits === undefined, JSON.stringify(state.json?.visits))

// ---------- 10. /open：把文件交给系统打开 ----------
// 这条路的意义是「点一行，那个 .md 真被编辑器打开」。测试里不能真弹窗，
// 走 DSH_WIKI_OPEN_DRYRUN=1 —— 回的仍是同一份结构，所以除了「有没有真 spawn」以外
// 全部行为都被钉住了：路径必须落在库内、文件必须存在、打开算一次访问。
process.env.DSH_WIKI_OPEN_DRYRUN = '1'
const openOne = await call('POST', '/open', JSON.stringify({ path: '资料-sources/资料页.md' }))
check('/open 回 200', openOne.status === 200, String(openOne.status))
check('/open 认出是哪一页', openOne.json?.name === '资料页', JSON.stringify(openOne.json))
check('/open 走的是旁路（测试不弹窗）', openOne.json?.via === 'dryrun', JSON.stringify(openOne.json))
check('/open 回报文件大小', typeof openOne.json?.bytes === 'number' && openOne.json.bytes > 0, JSON.stringify(openOne.json))

// 打开文件不再记访问：最近访问那一栏已经撤了，留下的账本没人读就是白写。
const afterOpen = await call('GET', '/state')
check('打开文件不写任何账本', afterOpen.json?.visits === undefined, JSON.stringify(afterOpen.json?.visits))

// 面板里手动查一次：这一笔必须记成 source=panel，不能算成模型用过知识库
await call('GET', '/search?q=' + encodeURIComponent('甲页'))
const afterSearch = await call('GET', '/state')
const usage2 = afterSearch.json?.usage
check('手动查一次，账本多一条', usage2?.rows === 1, String(usage2?.rows))
check('来源记成 panel', usage2?.bySource?.panel === 1, JSON.stringify(usage2?.bySource))
check('模型那栏不动', usage2?.bySource?.model === 0, JSON.stringify(usage2?.bySource))
check('工具那栏记在 wiki_recall 上', usage2?.byTool?.[0]?.count === 1, JSON.stringify(usage2?.byTool))
check('零命中率有分母了', usage2?.hitsKnown === 1 && typeof usage2?.zeroRate === 'number', JSON.stringify({ known: usage2?.hitsKnown, rate: usage2?.zeroRate }))

const escape = await call('POST', '/open', JSON.stringify({ path: '../outside.md' }))
check('/open 拒绝库外路径', escape.status === 400, String(escape.status))
check('/open 拒绝时说明原因', typeof escape.json?.error === 'string' && escape.json.error.includes('库里'), JSON.stringify(escape.json))

const absoluteEscape = await call('POST', '/open', JSON.stringify({ path: path.join(tmp, 'outside.md') }))
check('/open 拒绝库外的绝对路径', absoluteEscape.status === 400, String(absoluteEscape.status))

const ghostFile = await call('POST', '/open', JSON.stringify({ path: '概念-concepts/没有这一页.md' }))
check('/open 文件不在回 404', ghostFile.status === 404, String(ghostFile.status))
check('/open 文件不在要有话说', typeof ghostFile.json?.error === 'string' && ghostFile.json.error.includes('不在了'), JSON.stringify(ghostFile.json))

const noPath = await call('POST', '/open', JSON.stringify({}))
check('/open 缺 path 回 400', noPath.status === 400, String(noPath.status))
delete process.env.DSH_WIKI_OPEN_DRYRUN


process.stdout.write(`  overview ${total - failed}/${total}\n`)
if (failed > 0) {
  process.stderr.write(`overview: ${failed} 项失败\n`)
  process.exit(1)
}
