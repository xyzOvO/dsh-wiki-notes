/**
 * gateway.mjs —— 知识网关两个工具（wiki_context / wiki_verify）的行为与契约对齐。
 *
 * 钉的几件事：
 *   1. 注册成功、参数校验在插件这一层就把空值挡住；
 *   2. 通路坏了（没配工具目录、没这个 python）报 E_PYTHON_UNAVAILABLE，
 *      不能伪装成「知识库里没有」；
 *   3. 同一个输入，插件拿到的东西和直接用 Python CLI 拿到的东西逐字段一致
 *      （排除 request_id / context_id / timing 这类每次都变的东西）；
 *   4. verify 会真的把「星港缓存策略 5 个分片」这种越界主张抓出来。
 *
 * 隐私口径：仓库里的查询词与答案一律用虚构的「星港缓存」样例，不写真实笔记主题。
 * 本机要跑真实管线的真通路断言时，用 WIKI_TEST_QUERY / WIKI_TEST_BAD_ANSWER
 * 两个环境变量覆盖（只进内存，不进仓库；CI 没给 Python 管线时这段本来就跳过）。
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-gateway-'))
const configFile = path.join(tmp, 'wiki-notes.config.json')
process.env.DSH_WIKI_CONFIG = configFile
// 治理观察账本也落到临时目录：真通路会写 verify 事件，不能污染插件目录
process.env.DSH_WIKI_GOVERNANCE_LOG = path.join(tmp, 'governance.jsonl')

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 库路径与工具目录不写死本机绝对路径（写死了会跟着仓库公开出去）：
//   WIKI_ROOT   知识层目录（插件 root）
//   WIKI_TOOLS  工具目录（含 wiki_bridge.py）
// 两个都给齐才跑真实 Python 通路；只给 WIKI_ROOT 时用仓库里的样例库跑纯插件侧的断言。
const WIKI = process.env.WIKI_ROOT || path.join(PLUGIN_ROOT, 'examples', 'sample-wiki')
const TOOLS = process.env.WIKI_TOOLS || ''
const HAS_PIPELINE = Boolean(process.env.WIKI_ROOT && process.env.WIKI_TOOLS)
const PYTHON = process.env.WIKI_TEST_PYTHON || 'python'
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version
// 观察日志单独落一份到临时目录：观察闭环的断言要读它，
// 也不能把测试记录写进正式使用的日志里（那会把修正率带歪）。
const OBSERVE_LOG = path.join(tmp, 'observe.jsonl')
// 真通路断言的样例：默认全是虚构内容（星港缓存），绝不带真实笔记主题进仓库。
// 本机想拿自己那套库验证时，用环境变量覆盖，值只活在进程里。
const TEST_QUERY = process.env.WIKI_TEST_QUERY || '星港 缓存策略 分几个片'
const TEST_BAD_ANSWER = process.env.WIKI_TEST_BAD_ANSWER || '星港缓存策略一共分五个分片，180 秒，冷数据 30%。'

// 起始配置：有库、没 bridge。先测「没配工具目录」这一路。
writeFileSync(configFile, JSON.stringify({ root: WIKI }, null, 2), 'utf8')

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function writeConfig(patch) {
  writeFileSync(configFile, JSON.stringify({ root: WIKI, ...patch }, null, 2), 'utf8')
}

const registered = new Map()
const ctx = {
  logger: { info() {}, warn() {} },
  on() {},
  webServer: { register: () => () => {} },
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
}

const { apply } = await import('../lib/index.js')
apply(ctx, {})

check('注册了 wiki_recall', registered.has('wiki_recall'))
check('注册了 wiki_context', registered.has('wiki_context'))
check('注册了 wiki_verify', registered.has('wiki_verify'))
check('注册了 wiki_observe', registered.has('wiki_observe'))

const contextTool = registered.get('wiki_context')
const verifyTool = registered.get('wiki_verify')

// --- 1. 参数校验（不碰 Python） -------------------------------------------
const emptyQuery = await contextTool.execute({ query: '   ' })
check('空 query → E_QUERY_EMPTY', emptyQuery?.error?.code === 'E_QUERY_EMPTY', JSON.stringify(emptyQuery))

const emptyAnswer = await verifyTool.execute({ context_id: 'ctx_x', answer: '  ' })
check('空 answer → E_VERIFY_EMPTY_ANSWER', emptyAnswer?.error?.code === 'E_VERIFY_EMPTY_ANSWER')

const noCid = await verifyTool.execute({ context_id: '', answer: 'x' })
check('缺 context_id → E_CONTEXT_NOT_FOUND', noCid?.error?.code === 'E_CONTEXT_NOT_FOUND')

// --- 2. 通路故障：不能伪装成「库里没有」 ---------------------------------
const noTools = await contextTool.execute({ query: '缓存策略' })
check('没配 toolsRoot → E_PYTHON_UNAVAILABLE',
  noTools?.error?.code === 'E_PYTHON_UNAVAILABLE', JSON.stringify(noTools?.error))
check('故障结果里没有 support 字段（不许伪装知识不足）',
  noTools?.status === undefined && noTools?.evidence === undefined)

writeConfig({ bridge: { python: 'no-such-python-xyz', toolsRoot: TOOLS, timeoutMs: 15000 } })
const badPython = await contextTool.execute({ query: '缓存策略' })
check('python 不存在 → E_PYTHON_UNAVAILABLE',
  badPython?.error?.code === 'E_PYTHON_UNAVAILABLE', JSON.stringify(badPython?.error))

// 真实通路要真的调 Python 管线，所以两个环境变量都得给。
// 没给就整段跳过——留参数校验与故障隔离那两段就够了，不能因为环境不齐就假装通过。
if (HAS_PIPELINE) {
  // --- 3. 真跑：插件 vs CLI 逐字段一致 -------------------------------------
  writeConfig({ bridge: { python: PYTHON, toolsRoot: TOOLS, timeoutMs: 180000, ttlSeconds: 1800, observeLog: OBSERVE_LOG } })

  const QUERY = TEST_QUERY
  const viaPlugin = await contextTool.execute({ query: QUERY, limit: 4 })

  check('插件拿到 kind=context', viaPlugin?.kind === 'context', JSON.stringify(viaPlugin?.error ?? viaPlugin?.kind))
  check('插件拿到 context_id', typeof viaPlugin?.context_id === 'string' && viaPlugin.context_id.startsWith('ctx_'))
  check('status 三段齐全',
    typeof viaPlugin?.status?.retrieval === 'string'
    && typeof viaPlugin?.status?.support === 'string'
    && typeof viaPlugin?.status?.stage === 'string')
  check('support 与 degraded 是两件事',
    typeof viaPlugin?.status?.degraded === 'boolean')

  const cliRun = spawnSync(PYTHON, [path.join(TOOLS, 'wiki_bridge.py'), 'context'], {
    input: JSON.stringify({ query: QUERY, limit: 4, root: WIKI, plugin_version: PLUGIN_VERSION }),
    encoding: 'utf8',
    cwd: TOOLS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    timeout: 180000,
  })

  let cliOut = null
  try {
    cliOut = JSON.parse(String(cliRun.stdout || '').trim().split(/\r?\n/).pop())
  } catch {
    cliOut = null
  }

  check('CLI 也拿到了 kind=context', cliOut?.kind === 'context', String(cliRun.stderr || '').slice(0, 300))

  const VOLATILE = new Set(['request_id', 'context_id', 'timing_ms', 'snapshot', 'observe_id'])
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value).sort()) {
        if (VOLATILE.has(key)) continue
        out[key] = stable(value[key])
      }
      return out
    }
    return value
  }

  if (cliOut?.kind === 'context' && viaPlugin?.kind === 'context') {
    const a = JSON.stringify(stable(viaPlugin))
    const b = JSON.stringify(stable(cliOut))
    check('插件结果与 CLI 逐字段一致', a === b,
      a === b ? '' : `插件 ${a.length} 字节 / CLI ${b.length} 字节，首个差异位置 ${[...a].findIndex((c, i) => c !== b[i])}`)
  }

  // --- 4. verify：越界主张必须被抓住 ---------------------------------------
  const cid = viaPlugin?.context_id
  if (cid) {
    const bad = await verifyTool.execute({ context_id: cid, answer: TEST_BAD_ANSWER })
    const types = (bad?.violations ?? []).map((v) => v.type)
    check('坏答案被核验出违规', (bad?.violations ?? []).length > 0, JSON.stringify(bad?.violations))
    check('坏答案命中 unsupported_numeric_claim', types.includes('unsupported_numeric_claim'), String(types))
    check('verify 返回 context_id 原值', bad?.context_id === cid)

    const cliVerify = spawnSync(PYTHON, [path.join(TOOLS, 'wiki_bridge.py'), 'verify'], {
      input: JSON.stringify({ context_id: cid, answer: TEST_BAD_ANSWER, plugin_version: PLUGIN_VERSION }),
      encoding: 'utf8',
      cwd: TOOLS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      timeout: 120000,
    })
    let cliVerifyOut = null
    try {
      cliVerifyOut = JSON.parse(String(cliVerify.stdout || '').trim().split(/\r?\n/).pop())
    } catch {
      cliVerifyOut = null
    }
    check('verify 与 CLI 一致', JSON.stringify(stable(bad)) === JSON.stringify(stable(cliVerifyOut ?? {})),
      `插件 ${JSON.stringify(stable(bad)).slice(0, 160)} / CLI ${JSON.stringify(stable(cliVerifyOut ?? {})).slice(0, 160)}`)

    const expired = await verifyTool.execute({ context_id: 'ctx_0000000000000000', answer: 'x' })
    check('不存在的快照 → context_missing',
      expired?.status === 'context_missing' && expired?.error?.code === 'E_CONTEXT_NOT_FOUND',
      JSON.stringify(expired?.status ?? expired?.error))
    check('快照问题不等于回答错误', (expired?.violations ?? []).length === 0)

    // --- 4b. 观察闭环：verify 记录要能指回它的 context ---------------------
    // 这是本条断链的回归门禁：插件以前既不显示 observe_id，也不转发它，
    // 于是日志里每条 verify 记录的 parent_observe_id 都是 null，闭环断开。
    check('context 返回 observe_id',
      typeof viaPlugin?.observe_id === 'string' && viaPlugin.observe_id.startsWith('obs_'),
      JSON.stringify(viaPlugin?.observe_id))

    function readObserveLog() {
      let raw = ''
      try {
        raw = readFileSync(OBSERVE_LOG, 'utf8')
      } catch {
        return []
      }
      return raw.split(/\r?\n/).filter(Boolean).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)
    }

    const records = readObserveLog()
    const ctxRecord = records.find((r) => r.event === 'context' && r.context_id === cid)
    check('观察日志里有这条 context 的记录', Boolean(ctxRecord), `共 ${records.length} 条记录`)
    check('context 记录的 observe_id 与返回值一致',
      ctxRecord?.observe_id === viaPlugin?.observe_id,
      `日志 ${ctxRecord?.observe_id} / 返回 ${viaPlugin?.observe_id}`)

    const verifyRecord = records.find((r) => r.event === 'verify' && r.context_id === cid)
    check('观察日志里有这条 verify 的记录', Boolean(verifyRecord), `共 ${records.length} 条记录`)
    check('verify 记录的 parent_observe_id 指回 context（闭环接通）',
      verifyRecord?.parent_observe_id === viaPlugin?.observe_id,
      `parent_observe_id=${JSON.stringify(verifyRecord?.parent_observe_id)}，期望 ${viaPlugin?.observe_id}`)

    // 显式传 observe_id 时以传入的为准（不依赖插件记住的那一对）。
    const explicitObs = 'obs_explicit00001'
    await verifyTool.execute({ context_id: cid, answer: '再核验一次。', observe_id: explicitObs })
    const explicitRecord = readObserveLog()
      .filter((r) => r.event === 'verify' && r.context_id === cid)
      .at(-1)
    check('显式传 observe_id 时以传入的为准',
      explicitRecord?.parent_observe_id === explicitObs,
      `parent_observe_id=${JSON.stringify(explicitRecord?.parent_observe_id)}`)
  }

  // --- 4c. wiki_observe 成功返回必须合并插件侧 governance -------------------
  // 冻结契约里 observe 命令的成功统计返回 kind:'observe_stats'；'observe' 是
  // observe_log.jsonl 里单条日志事件的 kind。早期 guard 写成 !== 'observe'，
  // 把两者混了，governance 会静默不合并 —— 这条真通路断言就是它的回归门禁。
  const observeTool = registered.get('wiki_observe')
  const observeValue = await observeTool.execute({ days: 7, limit: 10 })
  check('observe 成功返回 kind=observe_stats',
    observeValue?.kind === 'observe_stats', JSON.stringify(observeValue?.kind ?? observeValue?.error))
  check('observe 成功返回合并了 governance（插件侧账本）',
    observeValue?.governance && typeof observeValue.governance === 'object'
      && observeValue.governance.state === 'ok',
    JSON.stringify(Object.keys(observeValue ?? {})))
  check('observe.governance 带三项现行指标',
    typeof observeValue?.governance?.metrics?.required_check_verification_trigger_rate === 'object'
      && typeof observeValue?.governance?.metrics?.effective_verify_violation_discovery_rate === 'object'
      && typeof observeValue?.governance?.metrics?.observation_coverage === 'object',
    JSON.stringify(Object.keys(observeValue?.governance?.metrics ?? {})))
  const observeRendered = observeTool.output.render({ days: 7, limit: 10 }, observeValue)
  check('renderObserve 输出治理观察段',
    String(observeRendered?.[0]?.text ?? '').includes('治理观察（插件侧账本'),
    String(observeRendered?.[0]?.text ?? '').slice(-200))

} else {
  process.stdout.write('（WIKI_ROOT / WIKI_TOOLS 未设置：跳过真实 Python 通路的断言）\n')
}

// --- 5. 库没配：讲清是配置问题 -------------------------------------------
// 库里没配这件事发生在 apply 时，改了配置要重新装配才看得出来，所以另起一个进程。
const emptyCfg = path.join(tmp, 'empty.config.json')
writeFileSync(emptyCfg, JSON.stringify({ bridge: { python: PYTHON, toolsRoot: TOOLS } }), 'utf8')

const childCode = [
  "const registered = new Map()",
  "const ctx = { logger: { info() {}, warn() {} }, on() {}, webServer: { register: () => () => {} },",
  "  tools: { register: (d) => { registered.set(d.name, d); return () => {} } } }",
  "const mod = await import(process.argv[1])",
  "mod.apply(ctx, {})",
  "const out = await registered.get('wiki_context').execute({ query: '缓存策略' })",
  "process.stdout.write(JSON.stringify(out))",
].join(String.fromCharCode(10))

const noRootRun = spawnSync(process.execPath, ['--input-type=module', '--eval', childCode,
  pathToFileURL(path.join(process.cwd(), 'lib/index.js')).href], {
  encoding: 'utf8',
  env: { ...process.env, DSH_WIKI_CONFIG: emptyCfg, DSH_WIKI_TOOLS: '' },
  timeout: 60000,
})
let noRoot = null
try {
  noRoot = JSON.parse(String(noRootRun.stdout || '').trim())
} catch {
  noRoot = null
}
check('库未配置 → E_WIKI_ROOT_MISSING',
  noRoot?.error?.code === 'E_WIKI_ROOT_MISSING',
  `${String(noRootRun.stderr || '').slice(-300)} | ${String(noRootRun.stdout || '').slice(0, 200)}`)

process.stdout.write(`\n${total - failed}/${total} 通过\n`)
if (failed > 0) process.exit(1)
