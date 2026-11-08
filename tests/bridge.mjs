/**
 * bridge.mjs —— 插件这侧的打电话代码。
 *
 * 钉的是「通路坏了不许伪装成库里没有」：
 *   - 缺 python / 没配 toolsRoot / 超时 / 崩了 / 吐的不是 JSON，各自给各自的码；
 *   - 进程根本没起来时不许让 stdin 的 EPIPE 变成一个没人接的 error 事件（那会杀掉宿主）；
 *   - stdout 有杂音时取最后一行能解析的，而不是整体判坏。
 *
 * 用 node 冒充 python：`spawn(python, [script])` 只看文件内容，扩展名不影响解析，
 * 所以把一个普通 JS 写成 `wiki_bridge.py` 就能当假桥用，测试不依赖本机装没装 Python。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { runBridge, errorEnvelope, isObserveResult } from '../lib/bridge.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-bridge-'))
const NODE = process.execPath

/** 造一个假的 toolsRoot，里面那个 wiki_bridge.py 其实是 JS。 */
function fakeBridge(name, source) {
  const dir = path.join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'wiki_bridge.py'), source)
  return dir
}

const call = (toolsRoot, extra = {}) => runBridge({ command: 'ping', payload: { q: 1 }, python: NODE, toolsRoot, timeoutMs: 8000, ...extra })

// 1. 没配 toolsRoot：直接回 unavailable，且不碰进程
{
  const r = await call('', { python: '/definitely/not/python' })
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_PYTHON_UNAVAILABLE')
  assert.match(r.error.error.message, /toolsRoot/)
  assert.equal(r.ms, 0)
}

// 2. python 不存在：进 ENOENT 分支，且不许因为 stdin EPIPE 把进程带走
{
  const r = await call(fakeBridge('echo', 'process.stdin.resume()'), { python: path.join(tmp, 'no-such-python.exe') })
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_PYTHON_UNAVAILABLE')
  assert.match(r.error.error.message, /找不到 Python 解释器/)
}

// 3. 正常回话：stdin 收到的 JSON 要能被脚本读到，plugin_version 由插件补
{
  const dir = fakeBridge('ok', `
    let s = ''
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => {
      const req = JSON.parse(s)
      process.stdout.write(JSON.stringify({ kind: 'ping', got: req.q, pv: req.plugin_version }) + '\\n')
    })
  `)
  const r = await call(dir, { pluginVersion: '9.9.9' })
  assert.equal(r.ok, true)
  assert.equal(r.data.kind, 'ping')
  assert.equal(r.data.got, 1)
  assert.equal(r.data.pv, '9.9.9')
  assert.equal(r.error, null)
}

// 4. stdout 有杂音：取最后一行能解析的（诊断往 stderr 写才合规，但真出事时不能整页白掉）
{
  const dir = fakeBridge('noise', `process.stdout.write('debug: hello\\nplain text\\n{"kind":"ok"}\\n')`)
  const r = await call(dir)
  assert.equal(r.ok, true)
  assert.equal(r.data.kind, 'ok')
}

// 5. 输出不是 JSON
{
  const dir = fakeBridge('badjson', `process.stdout.write('not json at all\\n')`)
  const r = await call(dir)
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_BRIDGE_BAD_JSON')
  assert.match(r.error.error.detail, /not json at all/)
}

// 6. 一句话不说就退：message 里要带退出码，stderr 尾巴要进 detail
{
  const dir = fakeBridge('silent', `process.stderr.write('boom\\n'); process.exit(3)`)
  const r = await call(dir)
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_BRIDGE_CRASH')
  assert.match(r.error.error.message, /退出码 3/)
  assert.match(r.error.error.detail, /boom/)
}

// 7. 超时：要可重试，且不能等到子进程自己退
{
  const dir = fakeBridge('hang', `setTimeout(() => {}, 30000)`)
  const started = Date.now()
  const r = await call(dir, { timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_BRIDGE_TIMEOUT')
  assert.equal(r.error.error.retryable, true)
  assert.ok(Date.now() - started < 8000, '超时没生效')
}

// 8. 输出超过上限：中止并报 CRASH，而不是把 8MB 塞进内存当结果
{
  const dir = fakeBridge('flood', `
    const chunk = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 10; i += 1) process.stdout.write(chunk)
  `)
  const r = await call(dir)
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_BRIDGE_CRASH')
  assert.match(r.error.error.message, /上限/)
}

// 9. observe 的成功形状只认 observe_stats（§5 那个静默 bug 的守卫）
{
  assert.equal(isObserveResult({ kind: 'observe_stats', totals: {} }), true)
  assert.equal(isObserveResult({ kind: 'observe' }), false)
  assert.equal(isObserveResult({ kind: 'error' }), false)
  assert.equal(isObserveResult(null), false)
  assert.equal(isObserveResult('observe_stats'), false)
}

// 10. 信封形状：与 Python 侧同形，detail 截断到 2000 字
{
  const big = 'y'.repeat(5000)
  const env = errorEnvelope('E_X', 'msg', 'search', big, true)
  assert.equal(env.kind, 'error')
  assert.equal(env.error.code, 'E_X')
  assert.equal(env.error.stage, 'search')
  assert.equal(env.error.retryable, true)
  assert.equal(env.error.detail.length, 2000)
  assert.equal(errorEnvelope('E_Y', 'm').error.retryable, false)
  assert.equal(errorEnvelope('E_Z', 'm').error.detail, null)
}

// 11. 大 payload + 子进程立刻退出（不读 stdin）：写 stdin 会 EPIPE/EOF，
//     没有监听就是一个没人接的 error 事件 —— 会把宿主进程直接带崩。
{
  let escaped = null
  const onUncaught = (error) => { escaped = error }
  process.on('uncaughtException', onUncaught)
  const dir = fakeBridge('quitearly', 'process.exit(0)')
  const r = await runBridge({
    command: 'ping', payload: { blob: 'z'.repeat(4 * 1024 * 1024) },
    python: NODE, toolsRoot: dir, timeoutMs: 8000,
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  process.off('uncaughtException', onUncaught)
  assert.equal(escaped, null, `stdin 写失败变成了未捕获异常：${escaped?.message}`)
  assert.equal(r.ok, false)
  assert.equal(r.error.error.code, 'E_BRIDGE_CRASH')
  assert.match(r.error.error.message, /stdin 写入也失败了/)
}

console.log('[bridge] 全部通过（11 项）')
