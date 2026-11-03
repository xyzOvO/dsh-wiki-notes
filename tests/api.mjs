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
function call(method, route, rawBody) {
  const req = new EventEmitter()
  req.method = method
  req.url = `/api/wiki-notes${route}`
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

rmSync(wiki, { recursive: true, force: true })
if (existsSync(configFile)) rmSync(configFile, { force: true })

if (failed > 0) {
  process.stderr.write(`api smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`api smoke 全部通过（${total} 项）`)
