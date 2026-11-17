/**
 * verify-bridge.mjs —— 真跑一次 Python 桥，看两个引擎是不是都活着。
 *
 * 为什么需要它：`npm test` 里的 bridge 测试全用「假 python」（拿 node 冒充），
 * 证明的是「通路坏了会报哪个码」，证明不了「真管线跑起来时两个引擎都在」。
 * 2026-11-17 就是靠它发现真管线的 `wiki_recall` 引擎一直是死的：
 * Python 那边回头调 `node bin/cli.mjs search`，插件没给 `WIKI_PLUGIN_DIR`，
 * cwd 落到工具目录、`bin/cli.mjs` 不存在，stdout 空 → `json.loads('')` 抛
 * 「Expecting value: line 1 column 1 (char 0)」，于是每次 context 都挂
 * `degraded:true / degraded_sources:["wiki_recall"]`。
 *
 * 所以这里量的是「降级标记」和「引擎状态」，不是「有没有返回内容」——
 * 返回内容少可能只是库里没写，引擎死掉才是 bug。
 *
 * 用法：
 *   node tools/verify-bridge.mjs                 # 用仓库里的 wiki-notes.config.json
 *   node tools/verify-bridge.mjs --query "..."   # 换一条查询
 *   node tools/verify-bridge.mjs --json          # 只要机器可读的结论
 *
 * 注意：默认不传 WIKI_OBSERVE_LOG，所以这次调用不会往治理账本里写任何东西
 * （context 会落一条 pending 事件）。要连观察一起验就加 --observe-log。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBridge, isObserveResult } from '../lib/bridge.js'

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function argOf(name, fallback) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--' + name)
  if (at === -1) return fallback
  const next = argv[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const query = typeof argOf('query', '') === 'string' && argOf('query', '') !== '' ? argOf('query', '') : '行测 各模块 用时 效率'
const asJson = argOf('json', false) === true
const withObserveLog = argOf('observe-log', false) === true

function readConfig() {
  const file = path.join(pluginRoot, 'wiki-notes.config.json')
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error('读不到 wiki-notes.config.json：' + (error?.message ?? error))
  }
  const bridge = raw?.bridge ?? {}
  if (!bridge.python) throw new Error('wiki-notes.config.json 里没有 bridge.python')
  if (!bridge.toolsRoot) throw new Error('wiki-notes.config.json 里没有 bridge.toolsRoot')
  return bridge
}

/** 和 lib/index.js 的 callBridge 传的 env 保持一致 —— 差一个变量就是差一个 bug。 */
function envFor(bridge) {
  const env = { WIKI_PLUGIN_DIR: pluginRoot }
  if (withObserveLog && bridge.observeLog) env.WIKI_OBSERVE_LOG = bridge.observeLog
  return env
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail ?? '' })
}

const bridge = readConfig()
const env = envFor(bridge)

const context = await runBridge({
  command: 'context',
  payload: { query, engine: 'both' },
  python: bridge.python,
  toolsRoot: bridge.toolsRoot,
  timeoutMs: bridge.timeoutMs ?? 120000,
  env,
  pluginVersion: 'verify-bridge',
})

check('context 调用成功', context.ok === true, context.ok ? String(context.ms) + 'ms' : (context.error?.error?.code ?? '') + ' ' + (context.error?.error?.message ?? ''))

const data = context.ok ? (context.data ?? {}) : {}
const engines = data.engines ?? {}
check('engines.search 活着', engines?.search?.status === 'ok', engines?.search ? JSON.stringify(engines.search) : '没有 engines')
check(
  'engines.wiki_recall 活着（这条挂了就是 WIKI_PLUGIN_DIR 没传）',
  engines?.wiki_recall?.status === 'ok',
  engines?.wiki_recall ? JSON.stringify(engines.wiki_recall) : '没有 engines.wiki_recall',
)
check(
  '没有被标降级',
  data?.status?.degraded === false,
  'degraded=' + String(data?.status?.degraded) + ' sources=' + JSON.stringify(data?.status?.degraded_sources ?? []),
)
check('带回了证据', Array.isArray(data.evidence) && data.evidence.length > 0, String(Array.isArray(data.evidence) ? data.evidence.length : 0) + ' 条')

// observe 只读，不会污染账本；顺带验证 isObserveResult 这道闸门还认得真返回值。
const observe = await runBridge({
  command: 'observe',
  payload: { days: 7 },
  python: bridge.python,
  toolsRoot: bridge.toolsRoot,
  timeoutMs: bridge.timeoutMs ?? 120000,
  env,
  pluginVersion: 'verify-bridge',
})
check('observe 调用成功', observe.ok === true, observe.ok ? String(observe.ms) + 'ms' : (observe.error?.error?.code ?? ''))
check('observe 回的是观察统计（isObserveResult 认）', isObserveResult(observe.data) === true, isObserveResult(observe.data) === true ? '' : JSON.stringify(observe.data)?.slice(0, 160))

const passed = checks.filter((item) => item.ok).length
const failed = checks.length - passed

if (asJson) {
  console.log(JSON.stringify({ query, env: Object.keys(env), passed, failed, checks }, null, 2))
} else {
  console.log('[verify-bridge] 查询：' + query)
  console.log('[verify-bridge] 插件目录：' + pluginRoot)
  console.log('[verify-bridge] 传给桥的 env：' + Object.keys(env).join(', '))
  for (const item of checks) console.log((item.ok ? '  PASS ' : '  FAIL ') + item.name + (item.detail === '' ? '' : '  (' + item.detail + ')'))
  console.log('[verify-bridge] ' + passed + '/' + checks.length + ' 通过' + (failed === 0 ? '' : '，' + failed + ' 项失败'))
}

process.exit(failed === 0 ? 0 : 1)
