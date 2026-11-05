/**
 * gateway.mjs —— 知识网关两个工具（wiki_context / wiki_verify）的行为与契约对齐。
 *
 * 钉的几件事：
 *   1. 注册成功、参数校验在插件这一层就把空值挡住；
 *   2. 通路坏了（没配工具目录、没这个 python）报 E_PYTHON_UNAVAILABLE，
 *      不能伪装成「知识库里没有」；
 *   3. 同一个输入，插件拿到的东西和直接用 Python CLI 拿到的东西逐字段一致
 *      （排除 request_id / context_id / timing 这类每次都变的东西）；
 *   4. verify 会真的把「重庆申论 5 道题」这种越界主张抓出来。
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-gateway-'))
const configFile = path.join(tmp, 'wiki-notes.config.json')
process.env.DSH_WIKI_CONFIG = configFile

const WIKI = 'D:\\笔记\\LLM-Wiki\\知识层-wiki'
const TOOLS = 'D:\\笔记\\LLM-Wiki\\工具-tools'
const PYTHON = process.env.WIKI_TEST_PYTHON || 'python'
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version

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
const noTools = await contextTool.execute({ query: '申论' })
check('没配 toolsRoot → E_PYTHON_UNAVAILABLE',
  noTools?.error?.code === 'E_PYTHON_UNAVAILABLE', JSON.stringify(noTools?.error))
check('故障结果里没有 support 字段（不许伪装知识不足）',
  noTools?.status === undefined && noTools?.evidence === undefined)

writeConfig({ bridge: { python: 'no-such-python-xyz', toolsRoot: TOOLS, timeoutMs: 15000 } })
const badPython = await contextTool.execute({ query: '申论' })
check('python 不存在 → E_PYTHON_UNAVAILABLE',
  badPython?.error?.code === 'E_PYTHON_UNAVAILABLE', JSON.stringify(badPython?.error))

// --- 3. 真跑：插件 vs CLI 逐字段一致 -------------------------------------
writeConfig({ bridge: { python: PYTHON, toolsRoot: TOOLS, timeoutMs: 180000, ttlSeconds: 1800 } })

const QUERY = '重庆 申论 考几道题'
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
  const bad = await verifyTool.execute({ context_id: cid, answer: '重庆申论一共考五道题，180 分钟，作文 30 分。' })
  const types = (bad?.violations ?? []).map((v) => v.type)
  check('坏答案被核验出违规', (bad?.violations ?? []).length > 0, JSON.stringify(bad?.violations))
  check('坏答案命中 unsupported_numeric_claim', types.includes('unsupported_numeric_claim'), String(types))
  check('verify 返回 context_id 原值', bad?.context_id === cid)

  const cliVerify = spawnSync(PYTHON, [path.join(TOOLS, 'wiki_bridge.py'), 'verify'], {
    input: JSON.stringify({ context_id: cid, answer: '重庆申论一共考五道题，180 分钟，作文 30 分。', plugin_version: PLUGIN_VERSION }),
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
  "const out = await registered.get('wiki_context').execute({ query: '申论' })",
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
