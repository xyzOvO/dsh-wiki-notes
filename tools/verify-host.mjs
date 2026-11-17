#!/usr/bin/env node
/**
 * verify-host.mjs —— 验收宿主半：对**正在跑的 DSH**，或者对**自己在进程里起的一个真 HTTP 服务**。
 *
 * 为什么要有这个：`npm test` 里 tests/api.mjs 用假 ctx 直接调 handler，能证明
 * 「函数签了名」，证明不了「真的接上了 HTTP」。插件是 link: 装进 profile 的，
 * 改完宿主必须重启 DSH 才重新 import 新模块；重启前 set_plugin 只能重挂注册、
 * 不能换实现。于是每次发版后都有一句「重启了吗？生效了吗？」没法回答 ——
 * 界面里看不到 /links 到底回 200、404 还是 500。
 *
 * 两种模式：
 *   --self   在本进程里用真 lib/index.js 起一个真 http 服务（真库、临时配置与账本），
 *            然后把所有探针打过去。证明「这份代码在真 HTTP 上跑得通」。
 *   --port   探一个已经在跑的 DSH。证明「这台机器上那个进程装的是这份代码」。
 *            两个都过，才叫「交付了」。
 *
 * 用法：
 *   node tools/verify-host.mjs --self
 *   node tools/verify-host.mjs --port 63123
 *   node tools/verify-host.mjs --base http://127.0.0.1:58888 --verbose
 *
 * 判定：每项 PASS / FAIL / SKIP，末行汇总。有 FAIL 就 exit 2。
 * 只发 GET；唯一的 POST 是 /open 的越界路径（本来就该被 400 挡住），
 * --self 下还会额外设 DSH_WIKI_OPEN_DRYRUN=1，确保不真开任何文件。
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const pick = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const verbose = args.includes('--verbose')
const selfMode = args.includes('--self')

let pass = 0
let fail = 0
let skip = 0

function report(kind, name, detail) {
  if (kind === 'PASS') pass += 1
  else if (kind === 'FAIL') fail += 1
  else skip += 1
  const mark = kind === 'PASS' ? '✓' : kind === 'FAIL' ? '✗' : '–'
  console.log(`${mark} ${name}${detail ? `  —  ${detail}` : ''}`)
}

/**
 * --self：把插件自己的 apply() 接到一个真 http 服务上。
 * 配置/账本/观察账本全走临时目录，只有知识库是真的 —— 探针要打真库才有意义。
 */
async function bootSelf() {
  // 默认拿随包的示例库，而不是作者本机那本笔记：这个脚本要能给别人跑。
  // 想探自己的库就 WIKI_ROOT=... 显式给。
  const root = process.env.WIKI_ROOT ?? path.join(import.meta.dirname, '..', 'examples', 'demo-wiki')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-verify-'))
  const configFile = path.join(tmp, 'wiki-notes.config.json')
  writeFileSync(configFile, JSON.stringify({ root }, null, 2), 'utf8')
  process.env.DSH_WIKI_CONFIG = configFile
  process.env.DSH_WIKI_CALLS_LOG = path.join(tmp, 'calls.jsonl')
  process.env.DSH_WIKI_GOVERNANCE_LOG = path.join(tmp, 'governance.jsonl')
  process.env.DSH_WIKI_OPEN_DRYRUN = '1'

  let handler = null
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {},
    webServer: {
      register: (definition) => {
        handler = definition.handler
        return () => {}
      },
    },
    tools: { register: () => () => {} },
  }

  const { apply } = await import('../lib/index.js')
  apply(ctx)
  if (handler === null) throw new Error('没捕获到 API handler，apply() 没注册 webServer 路由')

  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const close = async () => {
    await new Promise((resolve) => server.close(resolve))
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  }
  return { base: `http://127.0.0.1:${port}`, close, root }
}

async function get(base, route) {
  const response = await fetch(base + route, { headers: { accept: 'application/json' } })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, body, text }
}

async function probe(base) {
  // 1) /state —— 一切的基础
  let state = null
  try {
    const response = await get(base, '/api/wiki-notes/state')
    if (response.status !== 200 || !response.body) {
      report('FAIL', '/state', `HTTP ${response.status}${response.status === 401 ? '（launch token 不在手里）' : ''}`)
      return
    }
    state = response.body
    report('PASS', '/state', `HTTP 200，${(response.text.length / 1024).toFixed(1)} kB`)
  } catch (error) {
    report('FAIL', '/state', String(error?.message ?? error))
    return
  }

  // 2) 版本指纹：这几样分别是 1.8.0 / 1.9.0 / 1.10.0 新增的字段。
  //    缺哪个就说明跑到的是哪个版本的宿主 —— 比读 package.json 可靠，
  //    因为 package.json 说的是磁盘上的代码，不是内存里那个模块。
  //
  //    注意「库里没有数据」不等于「宿主没有这个能力」：一个零标签的库，
  //    `overview.tags` 就是 []，拿 tags[0].with 去判断会把好宿主判成旧的。
  //    所以数据类探针在没有数据时记 skip，不计入缺失。
  const overview = state.overview ?? null
  const hasTags = Array.isArray(overview?.tags) && overview.tags.length > 0
  const marks = [
    ['connection', typeof state.connection === 'string'],
    ['usage', Boolean(state.usage)],
    ['overview', Boolean(overview)],
    ['overview.tagPages', Boolean(overview?.tagPages)],
    ['overview.tags[].with', hasTags ? Array.isArray(overview.tags[0]?.with) : 'skip'],
  ]
  const missing = marks.filter(([, ok]) => ok === false).map(([name]) => name)
  const skipped = marks.filter(([, ok]) => ok === 'skip').map(([name]) => name)
  report(
    missing.length === 0 ? 'PASS' : 'FAIL',
    '宿主版本指纹',
    missing.length === 0
      ? 'connection / usage / overview.tagPages / tags[].with 都在（≥ 1.10.0）' +
          (skipped.length > 0 ? `；${skipped.join(' / ')} 因库里没有标签跳过` : '')
      : `缺 ${missing.join(' / ')} —— 宿主还是旧模块，重启 DSH 再来`,
  )

  report(state.connection === 'connected' ? 'PASS' : 'FAIL', '连接状态', `connection=${state.connection}`)

  // 3) /links —— 1.10.0 的新路由。挑一个真的枢纽页，别拿不存在的页去探：
  //    那样 404 和 200 分不清是「路由没挂」还是「页真的不在」。
  const hub = overview?.relations?.hubPages?.[0]?.name
  if (typeof hub !== 'string' || hub === '') {
    report('SKIP', '/links', '概览里没有枢纽页，挑不出探测目标')
  } else {
    const response = await get(base, `/api/wiki-notes/links?name=${encodeURIComponent(hub)}`)
    if (response.status === 200 && response.body?.totals) {
      const totals = response.body.totals
      report('PASS', '/links', `「${hub}」出 ${totals.out} / 入 ${totals.inn} / 双向 ${totals.both} / 红链 ${totals.broken}`)
    } else {
      const why = String(response.body?.error ?? response.text ?? '').slice(0, 60)
      report('FAIL', '/links', `HTTP ${response.status} ${why}`)
    }
  }

  // 4) /links 的 404 语义：找不到页必须是 404，而且不能是「未知路由」那种 404。
  //    只看状态码会让两条完全不同的失败长得一样 —— 这正是要分开的地方。
  const ghost = await get(base, `/api/wiki-notes/links?name=${encodeURIComponent('这个页一定不存在-验收用')}`)
  const ghostText = String(ghost.body?.error ?? ghost.text ?? '')
  const ghostRouted = ghost.status === 404 && ghostText.includes('库里没有这一页')
  report(
    ghostRouted ? 'PASS' : 'FAIL',
    '/links 找不到页',
    ghost.status === 404
      ? ghostRouted
        ? 'HTTP 404「库里没有这一页」（对）'
        : `HTTP 404 但正文是「${ghostText.slice(0, 40)}」—— 是路由没挂，不是页不在`
      : `HTTP ${ghost.status}（要 404）`,
  )

  // 5) /search —— 顺带确认 considered 这种「客户端算不出来」的诊断字段还在。
  //    查询词从库里现挑（枢纽页名，没有就用第一页），不写死某个库的内容 ——
  //    写死的话换一个库来跑就只能测到「查不到」。
  const probeQuery = typeof hub === 'string' && hub !== '' ? hub : '验收'
  const search = await get(base, `/api/wiki-notes/search?q=${encodeURIComponent(probeQuery)}`)
  if (search.status === 200 && Array.isArray(search.body?.hits)) {
    const body = search.body
    report('PASS', '/search', `「${probeQuery}」${body.hits.length} 条命中 · 参与 ${body.considered ?? '?'} 页 · ${body.elapsedMs ?? '?'}ms`)
    report(
      Number.isFinite(body.considered) ? 'PASS' : 'FAIL',
      '/search 诊断字段',
      `considered=${body.considered}（客户端算不出这个数，缺了说明宿主旧）`,
    )
    // 参与 0 页有两种原因：宿主旧（没有 considered）和「库根本没读到」。
    // 后者会让上面两项显示成漂亮的「0 条命中」，所以必须单独判 —— 跳过和通过不该长得一样。
    report(
      Number.isFinite(body.considered) && body.considered > 0 ? 'PASS' : 'FAIL',
      '/search 读到了库',
      Number.isFinite(body.considered) && body.considered > 0
        ? `参与 ${body.considered} 页`
        : '参与 0 页 —— root 可能无效（Windows 上别传 /c/... 这种 MSYS 路径，要 C:/...）',
    )
  } else {
    report('FAIL', '/search', `HTTP ${search.status}`)
  }

  // 6) /open 的越界闸 —— 只探拒绝路径，不真开文件
  const escape = await fetch(base + '/api/wiki-notes/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../../Windows/System32/drivers/etc/hosts' }),
  })
  const escapeText = await escape.text()
  report(
    escape.status === 400 ? 'PASS' : 'FAIL',
    '/open 越界闸',
    `HTTP ${escape.status}${verbose ? ` ${escapeText.slice(0, 120)}` : ''}（要 400：只能开库里的文件）`,
  )

  // 7) /calls —— 账本与治理面板的数据源
  const calls = await get(base, '/api/wiki-notes/calls')
  if (calls.status === 200 && Array.isArray(calls.body?.rows)) {
    const rows = calls.body.rows
    report('PASS', '/calls', `${rows.length} 行 · governance ${calls.body?.governance ? '在' : '缺'}`)
    const fields = rows[0] ? Object.keys(rows[0]).length : 0
    report(
      fields >= 13 || rows.length === 0 ? 'PASS' : 'FAIL',
      '/calls 字段',
      rows.length === 0 ? '账本空，无从比对' : `${fields} 个字段（≥13 才是 1.7.0 后的口径）`,
    )
  } else {
    report('FAIL', '/calls', `HTTP ${calls.status}`)
  }
}

let booted = null
try {
  if (selfMode) {
    booted = await bootSelf()
    console.log(`验收目标：${booted.base}（本进程自起，真库 ${booted.root}）\n`)
  } else {
    const base = pick('--base', `http://127.0.0.1:${pick('--port', '63123')}`).replace(/\/+$/, '')
    console.log(`验收目标：${base}\n`)
  }
  await probe(booted ? booted.base : pick('--base', `http://127.0.0.1:${pick('--port', '63123')}`).replace(/\/+$/, ''))

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 / ${skip} 项跳过`)
  if (fail > 0) {
    console.log('有 FAIL 时先确认：DSH 是不是重启过（宿主改动必须重启才 import 新模块）。')
    process.exitCode = 2
  }
} finally {
  if (booted) await booted.close()
}
