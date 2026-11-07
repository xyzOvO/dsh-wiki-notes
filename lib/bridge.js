/**
 * bridge.js —— 插件这侧的「打电话」代码。
 *
 * 这里只做三件事：起一个 python 子进程、把参数写进它的 stdin、把 stdout 当 JSON 读回来。
 * 任何判断（检索、证据、范围、支持度、核验）都不在这里做 —— 那是 Python 管线的活。
 * 插件唯一有权判的是「这次调用本身成没成」，所以这里只产出两类结果：
 *   1) 管线正常回话（哪怕它说 support=insufficient）→ 原样返回；
 *   2) 通路坏了（没 python、超时、崩了、吐的不是 JSON）→ 生成 error 信封，
 *      并且带 stage='bridge'。绝不能把第 2 类伪装成「知识库里没有」。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

export const BRIDGE_VERSION = '0.1.0'
export const CONTRACT_VERSION = '1.0'

/** 单次 stdout 上限：管线正常输出也就几十 KB，超过这个数说明出事了。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** 生成与 Python 侧同形的 error 信封，插件与模型看到的形状保持一致。 */
export function errorEnvelope(code, message, stage = 'bridge', detail = null, retryable = false) {
  return {
    kind: 'error',
    contract_version: CONTRACT_VERSION,
    bridge_version: BRIDGE_VERSION,
    error: {
      code,
      message,
      stage,
      retryable: retryable === true,
      detail: detail === null || detail === undefined ? null : String(detail).slice(0, 2000),
    },
  }
}

/**
 * 冻结契约里 observe 命令的「成功统计返回」只有一种形状：kind === 'observe_stats'。
 * 'observe' 是 observe_log.jsonl 里单条日志事件的 kind，不是命令返回；
 * 'error' 是通路坏了的错误信封，绝不能往上挂治理指标。
 * 判定放在 bridge 层（这里只管调用形状），让插件接线和 CI 复用同一份语义。
 */
export function isObserveResult(value) {
  return value !== null && typeof value === 'object' && value.kind === 'observe_stats'
}

function tail(text, n = 600) {
  const s = String(text ?? '')
  return s.length <= n ? s : `…${s.slice(-n)}`
}

/**
 * 跑一次 Bridge 命令。
 *
 * @returns {Promise<{ok:boolean, data:object|null, error:object|null, stderr:string, ms:number}>}
 *   ok=true 时 data 是管线返回的 JSON（可能是 context / verify / ping，也可能是 Python 侧的 error 信封）
 */
export function runBridge({
  command,
  payload,
  python = 'python',
  toolsRoot = '',
  timeoutMs = 120000,
  pluginVersion = 'unknown',
  env = {},
} = {}) {
  const started = Date.now()

  if (!toolsRoot) {
    return Promise.resolve({
      ok: false,
      data: null,
      stderr: '',
      ms: 0,
      error: errorEnvelope('E_PYTHON_UNAVAILABLE',
        '还没配置工具目录（Python 管线所在文件夹）。请在插件配置里填 bridge.toolsRoot。',
        'bridge'),
    })
  }

  const script = path.join(toolsRoot, 'wiki_bridge.py')
  const body = JSON.stringify({ ...(payload ?? {}), plugin_version: pluginVersion })
  const pythonExe = python || 'python'

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(pythonExe, [script, command], {
        cwd: toolsRoot,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          WIKI_PLUGIN_VERSION: pluginVersion,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false, data: null, stderr: '', ms: Date.now() - started,
        error: errorEnvelope('E_BRIDGE_SPAWN_FAILED', '起不了 Python 进程',
          'bridge', error?.message ?? error),
      })
      return
    }

    const out = []
    const err = []
    let outBytes = 0
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ...result, ms: Date.now() - started })
    }

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退了就算了
      }
      finish({
        ok: false, data: null, stderr: err.join(''),
        error: errorEnvelope('E_BRIDGE_TIMEOUT',
          `Python 管线超过 ${timeoutMs}ms 没回话（检索本身可能很慢，可以先调大 bridge.timeoutMs）`,
          'bridge', tail(err.join('')), true),
      })
    }, Math.max(1000, Number(timeoutMs) || 120000))

    child.on('error', (error) => {
      // ENOENT = 这台机器上没这个 python；其它算起进程失败
      const notFound = error?.code === 'ENOENT'
      finish({
        ok: false, data: null, stderr: err.join(''),
        error: errorEnvelope(
          notFound ? 'E_PYTHON_UNAVAILABLE' : 'E_BRIDGE_SPAWN_FAILED',
          notFound
            ? `找不到 Python 解释器「${pythonExe}」。请在插件配置里填 bridge.python 的绝对路径。`
            : '起不了 Python 进程',
          'bridge', error?.message ?? error, notFound),
      })
    })

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > MAX_OUTPUT_BYTES) {
        try {
          child.kill()
        } catch {
          // 同上
        }
        finish({
          ok: false, data: null, stderr: err.join(''),
          error: errorEnvelope('E_BRIDGE_CRASH', 'Python 输出超过上限，已中止', 'bridge'),
        })
        return
      }
      out.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      // 诊断只留最后一段，够定位就行，不要把它灌给模型
      err.push(chunk.toString('utf8'))
      if (err.join('').length > 20000) err.splice(0, err.length - 8)
    })

    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = err.join('')

      if (stdout === '') {
        finish({
          ok: false, data: null, stderr,
          error: errorEnvelope('E_BRIDGE_CRASH',
            `Python 没有输出（退出码 ${code}）`, 'bridge', tail(stderr)),
        })
        return
      }

      // stdout 只应有一行 JSON；万一有杂音，取最后一行能解析的
      let parsed = null
      let parseError = null
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i])
          break
        } catch (error) {
          parseError = error
        }
      }

      if (parsed === null || typeof parsed !== 'object') {
        finish({
          ok: false, data: null, stderr,
          error: errorEnvelope('E_BRIDGE_BAD_JSON', 'Python 输出不是合法 JSON',
            'bridge', `${parseError?.message ?? ''} | ${tail(stdout, 300)}`),
        })
        return
      }

      finish({ ok: true, data: parsed, stderr, error: null })
    })

    try {
      child.stdin.end(body, 'utf8')
    } catch (error) {
      finish({
        ok: false, data: null, stderr: err.join(''),
        error: errorEnvelope('E_BRIDGE_CRASH', '写不进 Python 的 stdin',
          'bridge', error?.message ?? error),
      })
    }
  })
}
