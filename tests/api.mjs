/**
 * api.mjs —— 设置页那几个 HTTP 路由的行为。
 *
 * 钉的是「配置被静默清掉」这一类：
 *   - /save 收到坏 JSON 或缺 root 时，不许把配置文件里的 root 删掉（曾经回 200 删掉）；
 *   - /prompt、/topics 只带一部分字段时，没提到的字段必须保持原值。
 * 「清空配置」这条路径仍然保留，但必须是显式传空字符串，不能靠缺字段撞上去。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'

const configFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-api-cfg-')), 'wiki-notes.config.json')
process.env.DSH_WIKI_CONFIG = configFile

// 临时库：至少一页，否则 /save 的「先试扫再落盘」会拒绝保存
const wiki = mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-api-wiki-'))
mkdirSync(path.join(wiki, '概念-concepts'), { recursive: true })
writeFileSync(
  path.join(wiki, '概念-concepts', '测试页.md'),
  ['---', '类型: 概念', '状态: 已提纯', '标签: [测试]', '更新: 2026-01-01', '---', '', '# 测试页', '', '正文。', ''].join('\n'),
  'utf8',
)

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

/** 造一个最小 req/res，走一遍真正的 handler。 */
function call(method, route, rawBody, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = `/api/wiki-notes${route}`
  req.headers = headers
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) },
    end(body) { this.body = body },
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${method} ${route}`)), 20000)
    res.end = (body) => {
      clearTimeout(timer)
      res.body = body
      let json = null
      try { json = JSON.parse(body) } catch { /* 不是 JSON 就算了 */ }
      resolve({ status: res.statusCode, json, headers: res.headers })
    }
    handler(req, res).catch(reject)
    if (rawBody !== undefined) req.emit('data', Buffer.from(rawBody, 'utf8'))
    req.emit('end')
  })
}

const readCfg = () => JSON.parse(readFileSync(configFile, 'utf8'))

// 0. 先把库路径保存进去（正常路径）
const saved = await call('POST', '/save', JSON.stringify({ root: wiki }))
check('/save 正常路径回 200', saved.status === 200, String(saved.status))
check('/save 正常路径写进配置', readCfg().root === wiki, readCfg().root)

// 1. 坏 JSON：不许删 root，要回 400
const broken = await call('POST', '/save', '{"root": "C:\\坏掉了')
check('坏 JSON 回 400', broken.status === 400, JSON.stringify(broken.json))
check('坏 JSON 不动配置', readCfg().root === wiki, String(readCfg().root))

// 2. 合法 JSON 但没带 root：同样 400，不许当成「清空」
const missing = await call('POST', '/save', '{}')
check('缺 root 字段回 400', missing.status === 400, JSON.stringify(missing.json))
check('缺 root 字段不动配置', readCfg().root === wiki, String(readCfg().root))

// 3. 显式空串才是「清掉配置」，这条路必须还在
const cleared = await call('POST', '/save', JSON.stringify({ root: '' }))
check('显式空串回 200', cleared.status === 200, String(cleared.status))
check('显式空串清掉 root', readCfg().root === undefined, JSON.stringify(readCfg()))

// 4. /prompt 只带 enabled：override / extra 必须保住
await call('POST', '/save', JSON.stringify({ root: wiki }))
await call('POST', '/prompt', JSON.stringify({ enabled: true, override: '', extra: '保住这句' }))
const promptPartial = await call('POST', '/prompt', JSON.stringify({ enabled: false }))
check('/prompt 部分字段回 200', promptPartial.status === 200, String(promptPartial.status))
check('/prompt 只改 enabled 时 extra 还在', readCfg().prompt.extra === '保住这句', JSON.stringify(readCfg().prompt))
check('/prompt enabled 确实改了', readCfg().prompt.enabled === false, JSON.stringify(readCfg().prompt))

// 5. /prompt 坏 JSON：400 且不动配置
const promptBroken = await call('POST', '/prompt', '{"enabled":')
check('/prompt 坏 JSON 回 400', promptBroken.status === 400, String(promptBroken.status))
check('/prompt 坏 JSON 不动配置', readCfg().prompt.extra === '保住这句', JSON.stringify(readCfg().prompt))

// 6. /topics 只带 minCount：stopwords 必须保住
await call('POST', '/topics', JSON.stringify({ minCount: 1, stopwords: false }))
const topicPartial = await call('POST', '/topics', JSON.stringify({ minCount: 3 }))
check('/topics 部分字段回 200', topicPartial.status === 200, String(topicPartial.status))
const topics = readCfg().topics
check('/topics 只改 minCount 时 stopwords 还在', topics.stopwords === false, JSON.stringify(topics))
check('/topics minCount 生效', topics.minCount === 3, JSON.stringify(topics))

// 7. /topics 坏 JSON：400 且不动配置
const topicBroken = await call('POST', '/topics', 'nope')
check('/topics 坏 JSON 回 400', topicBroken.status === 400, String(topicBroken.status))
check('/topics 坏 JSON 不动配置', readCfg().topics.minCount === 3, JSON.stringify(readCfg().topics))

// 7. 跨源写配置：外站 Origin 一律 403，且配置一动不动
const snapshot = JSON.stringify(readCfg())
const crossOrigin = await call('POST', '/save', JSON.stringify({ root: wiki }), { origin: 'https://evil.example.com' })
check('跨源 POST 回 403', crossOrigin.status === 403, String(crossOrigin.status))
check('跨源 POST 不动配置', JSON.stringify(readCfg()) === snapshot)

// 本机页面照常放行（设置页就是从这个源发出来的）
const localOrigin = await call('POST', '/save', JSON.stringify({ root: wiki }), { origin: 'http://127.0.0.1:57808' })
check('本机 Origin 放行', localOrigin.status === 200, String(localOrigin.status))

// 沙箱 iframe / file:// 发的是字符串 'null'：放行，否则用户自己的保存按钮会被挡掉
const opaque = await call('POST', '/save', JSON.stringify({ root: wiki }), { origin: 'null' })
check('不透明来源 Origin: null 放行', opaque.status === 200, String(opaque.status))

// 8. 超大请求体：回 413 说清楚，而不是把连接直接掐掉
const beforeHuge = JSON.stringify(readCfg())
const huge = await call('POST', '/save', 'x'.repeat(70 * 1024))
check('超大 body 回 413', huge.status === 413, String(huge.status))
check('超大 body 不动配置', JSON.stringify(readCfg()) === beforeHuge)

// 9. /search：面板用的只读查询。必须和模型走同一个 run()，explain 只在服务端打开
const found = await call('GET', `/search?q=${encodeURIComponent('测试')}`)
check('/search 回 200', found.status === 200, String(found.status))
check('/search 命中这一页', found.json?.hits?.length === 1, JSON.stringify(found.json?.hits?.length))
check('/search 带命中理由', Array.isArray(found.json?.hits?.[0]?.termHits), JSON.stringify(found.json?.hits?.[0]?.termHits))
check('/search 理由是页名通道', found.json?.hits?.[0]?.termHits?.[0]?.parts?.[0]?.via === 'name',
  JSON.stringify(found.json?.hits?.[0]?.termHits?.[0]))
check('/search 带扫描分母', typeof found.json?.scanned === 'number' && found.json.scanned >= 1, String(found.json?.scanned))
check('/search 带耗时', typeof found.json?.elapsedMs === 'number', String(found.json?.elapsedMs))

const noQuery = await call('GET', '/search')
check('/search 缺 q 回 400', noQuery.status === 400, String(noQuery.status))

const emptyQuery = await call('GET', '/search?q=%20%20')
check('/search 空白 q 回 400', emptyQuery.status === 400, String(emptyQuery.status))

const badLimit = await call('GET', `/search?q=${encodeURIComponent('测试')}&limit=abc`)
check('/search 坏 limit 退回默认而不是报错', badLimit.status === 200 && badLimit.json?.hits?.length === 1, String(badLimit.status))

const hugeLimit = await call('GET', `/search?q=${encodeURIComponent('测试')}&limit=999`)
check('/search limit 超上限不报错', hugeLimit.status === 200 && hugeLimit.json?.hits?.length === 1, String(hugeLimit.status))

const noHit = await call('GET', `/search?q=${encodeURIComponent('这一页里没有的词')}`)
check('/search 无命中时 total=0 且 hits 为空',
  noHit.json?.total === 0 && noHit.json?.hits?.length === 0, JSON.stringify(noHit.json?.total))

// 覆盖诊断：/state 得说清「发现多少、读到多少、漏在哪」，面板才有东西可显示
const state = await call('GET', '/state')
const cov = state.json?.stats ?? {}
check('/state 带 discovered', Number.isInteger(cov.discovered) && cov.discovered > 0, JSON.stringify(cov.discovered))
check('/state 带 sections（可定位到多细）', Number.isInteger(cov.sections) && cov.sections > 0, JSON.stringify(cov.sections))
check('/state 带 bytes', Number.isInteger(cov.bytes) && cov.bytes > 0, JSON.stringify(cov.bytes))
check('/state 带 oversized / unreadable / skipped',
  Number.isInteger(cov.oversized) && Number.isInteger(cov.unreadable) && Number.isInteger(cov.skipped),
  JSON.stringify({ oversized: cov.oversized, unreadable: cov.unreadable, skipped: cov.skipped }))
check('/state 带 newestMtime / scannedAt（ISO 字符串）',
  typeof cov.newestMtime === 'string' && cov.newestMtime !== '' && typeof cov.scannedAt === 'string' && cov.scannedAt !== '',
  JSON.stringify({ newestMtime: cov.newestMtime, scannedAt: cov.scannedAt }))
check('/state 的 discovered = pages + unreadable + skipped',
  cov.discovered === cov.pages + cov.unreadable + cov.skipped, JSON.stringify(cov))

// 查询诊断：面板要看每个词在多少页上有分
const diag = await call('GET', `/search?q=${encodeURIComponent('测试 不存在的词')}`)
check('/search 带 termPages（explain 开着）',
  Array.isArray(diag.json?.termPages) && diag.json.termPages.length === 2, JSON.stringify(diag.json?.termPages))
check('/search 的 missedTerms 指出没用上的词',
  JSON.stringify(diag.json?.missedTerms) === JSON.stringify(['不存在的词']), JSON.stringify(diag.json?.missedTerms))
check('/search 的 matchMode 与 degraded 一致',
  diag.json?.matchMode === (diag.json?.degraded === true ? 'or' : 'and'), String(diag.json?.matchMode))

rmSync(wiki, { recursive: true, force: true })
if (existsSync(configFile)) rmSync(configFile, { force: true })

if (failed > 0) {
  process.stderr.write(`api smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`api smoke 全部通过（${total} 项）`)
