/**
 * inject.mjs —— Cordis 严格注入回归门禁（行为测试，不是源码字符串探测）。
 *
 * 真机症状（2026-11-07）：P1 治理引入 `ctx.sessions?.scopeOf?.(ctx)`，但
 * `export const inject` 没声明 'sessions'。DSH 的 Cordis Proxy 在严格模式下
 * 对未声明的属性访问抛 `cannot get property "sessions" without inject`，
 * 于是 include:wiki-notes fiberPhase:failed、/api/wiki-notes/* 全部 404、
 * 设置页显示「未连接宿主（插件没启动或 API 不可达）」。
 *
 * 这里用 Proxy 复刻宿主的 strict property trap：只有 inject 声明的服务和宿主
 * 特殊属性（logger / on / get）可读，其余属性一律抛同款错误。跑真实的 apply()，
 * 证明插件在这种宿主里能装起来，而不是只检查源码里有没有某个字样。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(path.join(tmpdir(), 'wiki-inject-'))
const wiki = path.join(tmp, 'wiki')
mkdirSync(path.join(wiki, '概念-concepts'), { recursive: true })
writeFileSync(path.join(wiki, '概念-concepts', '测试页.md'), '# 测试页\n\n缓存策略分三个分片。\n', 'utf8')

// 所有产物都落到临时目录，绝不碰插件目录或用户库。
process.env.DSH_WIKI_CONFIG = path.join(tmp, 'wiki-notes.config.json')
process.env.DSH_WIKI_CALLS_LOG = path.join(tmp, 'calls.jsonl')
process.env.DSH_WIKI_GOVERNANCE_LOG = path.join(tmp, 'governance.jsonl')

const { apply, inject, name } = await import('../lib/index.js')

const registered = []
const sections = []
let dispose = null

const services = {
  tools: {
    register(definition) {
      registered.push(definition?.name)
      return () => {}
    }
  },
  webServer: { register: () => () => {} },
  systemPrompt: {
    context(section) {
      sections.push(section?.name)
    }
  },
  sessions: { scopeOf: () => 'test-scope' }
}

function strictCtx(injectList) {
  const allowed = new Set(injectList)
  const target = {
    logger: { info() {}, warn() {} },
    on(event, fn) {
      if (event === 'dispose') dispose = fn
    },
    get(service) {
      return allowed.has(service) ? services[service] : undefined
    }
  }
  return new Proxy(target, {
    get(store, prop) {
      if (prop in store) return Reflect.get(store, prop)
      if (typeof prop === 'symbol') return undefined
      if (allowed.has(prop)) return services[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    }
  })
}

let failed = 0
let total = 0
function check(label, fn) {
  total += 1
  try {
    fn()
    console.log(`✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`✗ ${label} — ${error.message}`)
  }
}

check('插件导出名与 inject 数组形状', () => {
  assert.equal(name, 'wiki-notes')
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
})

check('inject 声明了 apply() 直接读取的四个宿主服务', () => {
  for (const service of ['tools', 'webServer', 'systemPrompt', 'sessions']) {
    assert.ok(
      inject.includes(service),
      `inject 少了 '${service}'：宿主会抛 cannot get property "${service}" without inject`
    )
  }
})

check('apply() 在 Cordis 严格注入宿主下不抛 without inject', () => {
  try {
    apply(strictCtx(inject), { root: wiki })
  } catch (error) {
    const message = String(error?.message ?? error)
    if (message.includes('without inject')) {
      throw new Error(`apply() 触发宿主严格注入错误：${message}`)
    }
    throw new Error(`apply() 抛了非预期错误：${message}`)
  }
})

check('激活后四个网关工具与两段 systemPrompt 都注册了', () => {
  assert.deepEqual(registered.slice().sort(), [
    'wiki_context', 'wiki_observe', 'wiki_recall', 'wiki_verify'
  ])
  assert.deepEqual(sections.slice().sort(), [
    'wiki-notes:governance', 'wiki-notes:topics'
  ])
})

if (typeof dispose === 'function') {
  try { dispose() } catch { /* 清理失败不影响断言结论 */ }
}
rmSync(tmp, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n${total - failed}/${total} 通过，${failed} 项失败`)
  process.exit(1)
}
console.log(`\n${total}/${total} 全部通过`)
