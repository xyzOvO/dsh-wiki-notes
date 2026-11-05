# 调用审计页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让知识库插件把每次工具调用（含面板手查）按最小字段记下来，并在设置页新增一个标签页把调用流水显示出来。

**Architecture:** 新增 `lib/calls.js` 一个纯 Node 模块负责环形缓冲 + `calls.jsonl` 追加写 + 尾部读取；`lib/index.js` 用 `traced()` 包住四个工具的 `execute`，并在 `/search` 路由里给面板手查补记一条；新增 `GET /calls`、`POST /calls/clear`、`POST /calls/config` 三个路由；`lib/client.js` 注册第二个 `settings.section` 承载流水页。

**Tech Stack:** Node ESM（`node:fs` 同步 API，零依赖）；客户端手写 bundle，`React.createElement`；测试是 `node tests/*.mjs` 裸脚本 + `node:assert/strict`，无测试框架。

**Spec:** `docs/superpowers/specs/2026-11-05-wiki-call-audit-design.md`

## Global Constraints

- `engines.node` 是 `>=20.13.0`。**不许用 `zlib.zstdDecompressSync`**（Node 22.15+ 才有）、不许用 `node --run`（Node 22+ 才有）。
- 插件**零运行时依赖**：不加 `dependencies`，不 import 任何非 `node:` 前缀模块。
- 记录字段白名单**只有 8 个**：`ts`、`source`、`tool`、`mode`、`query`、`hits`、`ms`、`ok`。**绝不写页面路径、文件名、正文片段、答案原文、错误堆栈。**
- 采集是旁路：记录失败一律 `console.warn` 后继续，**不得改变任何工具的返回值、schema 或描述**。
- 客户端只能 `React.createElement`（文件内别名 `h`），不能用 JSX。
- 客户端改动要**重启 DSH** 才生效。
- 写盘只写插件根目录下的文件；**知识库本体一个字节都不写**。
- 中文注释，和现有代码同风格：注释解释「为什么」，不复述「做了什么」。

## Review Focus

- **半行 JSON**：进程在 `appendFileSync` 中途被杀，`calls.jsonl` 末尾会留半行。读取必须跳过坏行，不能让整页白掉。
- **文件被外部删掉**：用户在资源管理器里删了 `calls.jsonl`，下一次 `record()` 必须自动重建，而不是永久静默失败。
- **目录不可写**：插件目录只读时，工具必须照常返回结果（记录只进内存），不能因为记不了账就让检索失败。
- **跨天**：`totals` 的「今日」按本地日期字符串比较；23:59 与 00:01 的两条不能被算进同一天。
- **query 含换行/超长**：`\n` 经 `JSON.stringify` 转义后不会撑破 jsonl；但长度必须截到 120 字，否则一条记录能到几十 KB。

---

### Task 1: 记录模块 `lib/calls.js`

**Files:**
- Create: `lib/calls.js`
- Test: `tests/calls.mjs`

**Interfaces:**
- Consumes: 无（纯 Node 模块）
- Produces:
  - `CALL_FIELDS: string[]` —— `['ts','source','tool','mode','query','hits','ms','ok']`
  - `normalizeEntry(raw: object) => object | null` —— 只留白名单字段；`query` 截到 120 字；非法输入返回 `null`
  - `createCallLog({ file: string, enabled?: boolean }) => CallLog`
  - `CallLog.record(entry: object): void`
  - `CallLog.read({ limit?: number, source?: 'all'|'model'|'panel', only?: 'all'|'miss' }) => { rows, totals, enabled, window }`
  - `CallLog.clear(): void`
  - `CallLog.setEnabled(next: boolean): void`
  - `CallLog.enabled(): boolean`
  - `CallLog.buffer(): object[]` —— 只给测试看

- [ ] **Step 1: 写失败测试**

`tests/calls.mjs`：

```js
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { CALL_FIELDS, normalizeEntry, createCallLog } from '../lib/calls.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-calls-'))
const file = path.join(tmp, 'calls.jsonl')

// 1. 字段白名单：多给的字段一律丢掉，缺的补 null
{
  const entry = normalizeEntry({
    ts: '2026-11-05T21:00:00', source: 'model', tool: 'wiki_recall', mode: 'search',
    query: '别了 司徒雷登', hits: 0, ms: 1, ok: true,
    file: '/wiki/某页.md', text: '正文片段',
  })
  assert.deepEqual(Object.keys(entry).sort(), [...CALL_FIELDS].sort())
  assert.equal(entry.file, undefined)
  assert.equal(entry.text, undefined)
}

// 2. query 截到 120 字
{
  const entry = normalizeEntry({ query: 'x'.repeat(500) })
  assert.equal(entry.query.length, 121) // 120 + 省略号
}

// 3. 非法输入不算记录
{
  assert.equal(normalizeEntry(null), null)
  assert.equal(normalizeEntry('字符串'), null)
}

// 4. 写进去能读出来
{
  const log = createCallLog({ file })
  log.record({ source: 'model', tool: 'wiki_recall', mode: 'search', query: '甲', hits: 2, ms: 3, ok: true })
  const { rows } = log.read({})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].query, '甲')
  assert.equal(JSON.parse(readFileSync(file, 'utf8').trim()).tool, 'wiki_recall')
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/calls.mjs`
Expected: `Cannot find module .../lib/calls.js`

- [ ] **Step 3: 实现 `lib/calls.js`**

要点（签名与上面 Interfaces 一致）：
- `record()`：`normalizeEntry` → 推入内存环形缓冲（上限 500）→ 若 `enabled` 则 `appendFileSync(file, JSON.stringify(entry) + '\n')`，`try/catch` 包住，失败只 `console.warn` 且记一个 `writeBroken` 标志（下次不再重试直到文件可写）。
- 轮转：模块内维护 `lineCount`，首次为 `null`，第一次写时用 `readFileSync` 数行数（文件不存在记为 0）；`lineCount > 5000` 时读全部行、取最后 2500 行重写、更新 `lineCount`。
- `read()`：读文件**尾部** `TAIL_BYTES = 262144` 字节；按 `\n` 切、逐行 `JSON.parse`，坏行 `continue`；然后按 `ts|tool|query` 键去重并入内存缓冲里文件没有的行；再按 `source` / `only === 'miss'`（`hits === 0`）过滤；`rows` 取 `limit`（默认 200，夹到 1–500），`totals` 用**过滤前**的全部行算。
- `totals`：`{ today, calls, hits, misses, hitRate }`。`today` 是本地日期 `YYYY-MM-DD`；只统计 `ts.slice(0,10) === today` 的行；`hitRate` 的分母是**`hits !== null` 的行**（即排除 `verify` / `observe`），分子是 `hits > 0` 的行；分母为 0 时 `hitRate = null`。
- `window` = 参与 `totals` 计算的行数。
- `clear()`：`writeFileSync(file, '')`，`lineCount = 0`，清空缓冲，`try/catch`。
- `setEnabled()` / `enabled()`：读写闭包里的 `enabled`。
- 文件不存在或读失败时，`read()` 返回内存缓冲里的行，`totals` 照算。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/calls.mjs`
Expected: 无输出、退出码 0

- [ ] **Step 5: 补两组边界测试并跑**

追加到 `tests/calls.mjs`：

```js
// 5. 坏行跳过
{
  const f2 = path.join(tmp, 'broken.jsonl')
  writeFileSync(f2, '{"ts":"2026-11-05T21:00:00","tool":"wiki_recall","hits":1}\n{"半个\n')
  const log = createCallLog({ file: f2 })
  assert.equal(log.read({}).rows.length, 1)
}

// 6. enabled=false 时不写文件
{
  const f3 = path.join(tmp, 'off.jsonl')
  const log = createCallLog({ file: f3, enabled: false })
  log.record({ tool: 'wiki_recall', hits: 1 })
  assert.equal(log.read({}).rows.length, 1)      // 内存里有
  assert.equal(existsSync(f3), false)            // 文件没有
}

// 7. 命中率排除 verify / observe
{
  const log = createCallLog({ file: path.join(tmp, 'rate.jsonl') })
  const today = new Date().toISOString().slice(0, 10)
  log.record({ ts: `${today}T10:00:00`, tool: 'wiki_recall', hits: 3, ok: true })
  log.record({ ts: `${today}T10:01:00`, tool: 'wiki_recall', hits: 0, ok: true })
  log.record({ ts: `${today}T10:02:00`, tool: 'wiki_verify', hits: null, ok: true })
  const { totals } = log.read({})
  assert.equal(totals.calls, 3)
  assert.equal(totals.hitRate, 0.5)   // 1 / 2，verify 不进分母
}

// 8. 目录不可写不抛错
{
  const log = createCallLog({ file: path.join(tmp, 'no-such-dir', 'x.jsonl') })
  assert.doesNotThrow(() => log.record({ tool: 'wiki_recall', hits: 1 }))
  assert.equal(log.read({}).rows.length, 1)
}

// 9. 文件被外部删掉后，下一次 record 自动重建
{
  const f4 = path.join(tmp, 'gone.jsonl')
  const log = createCallLog({ file: f4 })
  log.record({ tool: 'wiki_recall', hits: 1 })
  rmSync(f4)
  log.record({ tool: 'wiki_recall', hits: 2 })
  assert.equal(existsSync(f4), true)
  assert.equal(log.read({}).rows.length, 2)   // 被删前那条还在内存里
}

// 10. 跨天不混算：昨天那两条不进今日统计
{
  const f5 = path.join(tmp, 'crossday.jsonl')
  const log = createCallLog({ file: f5 })
  log.record({ ts: '2026-11-04T23:59:00', tool: 'wiki_recall', hits: 5, ok: true })
  log.record({ ts: '2026-11-04T00:01:00', tool: 'wiki_recall', hits: 5, ok: true })
  log.record({ ts: `${new Date().toISOString().slice(0, 10)}T00:01:00`, tool: 'wiki_recall', hits: 0, ok: true })
  assert.equal(log.read({}).totals.calls, 1)
  assert.equal(log.read({}).totals.misses, 1)
}

// 11. query 里的换行不会撑破 jsonl
{
  const f6 = path.join(tmp, 'newline.jsonl')
  const log = createCallLog({ file: f6 })
  log.record({ query: '第一行\n第二行', tool: 'wiki_recall', hits: 0 })
  const lines = readFileSync(f6, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).query, '第一行\n第二行')
}
```

跑之前补 `existsSync` 到 import 列表。

Run: `node tests/calls.mjs`
Expected: 退出码 0

- [ ] **Step 6: 提交**

```bash
git add lib/calls.js tests/calls.mjs
git commit -m "feat(calls): 调用记录模块——8 字段白名单、环形缓冲、尾部读取"
```

---

### Task 2: 配置项 `calls`

**Files:**
- Modify: `lib/config.js`（在 `writeTopicConfig` 之后、提示词那节之前插入）
- Modify: `tests/config.mjs`

**Interfaces:**
- Consumes: `readRecord(pluginRoot)` / `writeRecord(pluginRoot, record)`（`lib/config.js` 内部已有，不导出）
- Produces:
  - `DEFAULT_CALLS_CONFIG = { enabled: true, log: '' }`
  - `normalizeCallsConfig(raw) => { enabled: boolean, log: string } | null`
  - `readCallsConfig(pluginRoot) => { enabled, log }`
  - `writeCallsConfig(pluginRoot, next) => { file, config }`

- [ ] **Step 1: 写失败测试**

`tests/config.mjs` 追加：

```js
import { DEFAULT_CALLS_CONFIG, normalizeCallsConfig, readCallsConfig, writeCallsConfig } from '../lib/config.js'

// calls 配置：缺字段按默认补齐，log 只认字符串
assert.deepEqual(normalizeCallsConfig({}), { enabled: true, log: '' })
assert.deepEqual(normalizeCallsConfig({ enabled: false }), { enabled: false, log: '' })
assert.deepEqual(normalizeCallsConfig({ log: '/tmp/x.jsonl' }), { enabled: true, log: '/tmp/x.jsonl' })
assert.equal(normalizeCallsConfig(null), null)
assert.deepEqual(readCallsConfig('/不存在的目录'), { ...DEFAULT_CALLS_CONFIG })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/config.mjs`
Expected: `does not provide an export named 'normalizeCallsConfig'`

- [ ] **Step 3: 实现**

照 `DEFAULT_TOPIC_CONFIG` / `normalizeTopicConfig` / `readTopicConfig` / `writeTopicConfig` 那组的写法：
`normalizeCallsConfig` 不是对象返回 `null`；`enabled` 只认 `=== false` 为关闭；`log` 用 `typeof === 'string' ? trim() : ''`。
`readCallsConfig` = `normalizeCallsConfig(readRecord(pluginRoot).calls) ?? {...DEFAULT_CALLS_CONFIG}`。
`writeCallsConfig` 整块替换 `calls` 字段，其余字段原样保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/config.mjs`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add lib/config.js tests/config.mjs
git commit -m "feat(config): 加 calls 配置块（enabled / log）"
```

---

### Task 3: 接入四个工具 + 三个 HTTP 路由

**Files:**
- Modify: `lib/index.js`
- Modify: `lib/config.js` 的 import 行（`readCallsConfig`）
- Test: `tests/api.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createCallLog` / Task 2 的 `readCallsConfig`、`writeCallsConfig`
- Produces（HTTP）：
  - `GET /api/wiki-notes/calls?limit=200&source=all|model|panel&only=all|miss` → `{ rows, totals, enabled, window }`
  - `POST /api/wiki-notes/calls/clear` → `{ ok: true, cleared: number }`（过 `blockedOrigin` 写闸）
  - `POST /api/wiki-notes/calls/config` body `{ enabled: boolean }` → `{ ok: true, config }`（过写闸）

- [ ] **Step 1: 写失败测试**

`tests/api.mjs` 追加：

```js
// 调用记录：记一条，/calls 能读回来；/calls/clear 清空
await call('POST', '/save', JSON.stringify({ root: wiki }))
const callsFile = path.join(path.dirname(configFile), 'calls.jsonl')
process.env.DSH_WIKI_CALLS_LOG = callsFile   // 见 Step 3：允许环境变量指定
```

**注意**：为了让测试不污染真实文件，`apply()` 读配置时 `log` 为空就用 `path.join(pluginRoot, 'calls.jsonl')`，而测试里走 env `DSH_WIKI_CALLS_LOG` 覆盖（和 `DSH_WIKI_CONFIG` 同样的手法）。所以断言写成：

```js
const { status, body } = await call('GET', '/calls')
check('/calls 返回 rows 数组', Array.isArray(body.rows))
check('/calls 返回 totals', typeof body.totals?.calls === 'number')
check('/calls 返回 enabled 布尔', body.enabled === true)

const cleared = await call('POST', '/calls/clear')
check('/calls/clear 返回 200', cleared.status === 200)

const off = await call('POST', '/calls/config', JSON.stringify({ enabled: false }))
check('/calls/config 关掉后 enabled=false', off.body?.enabled === false)
const after = await call('GET', '/calls')
check('关掉后 /calls 的 enabled 是 false', after.body.enabled === false)

// 跨源写闸：带外来源的 POST 必须被拒
const blocked = await call('POST', '/calls/clear', '', { origin: 'https://evil.example' })
check('/calls/clear 拒绝跨源', blocked.status === 403)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/api.mjs`
Expected: `/calls 返回 rows 数组` 等几条 `✗`

- [ ] **Step 3: 实现**

在 `apply()` 内、`invalidate` 那组状态之后：

```js
const callsCfg = readCallsConfig(pluginRoot)
const callFile = process.env.DSH_WIKI_CALLS_LOG || callsCfg.log || path.join(pluginRoot, 'calls.jsonl')
const callLog = createCallLog({ file: callFile, enabled: callsCfg.enabled })
```

`traced()` 包装器（同作用域）：

```js
/** 记账，但不改变被包的东西：返回值、异常、耗时语义一律原样透传。 */
function traced(name, execute) {
  return async function (args) {
    const started = Date.now()
    let ok = true
    let hits = null
    try {
      const value = await execute(args)
      if (value && value.mode === 'error') ok = false
      hits = countHits(name, value)
      return value
    } catch (error) {
      ok = false
      throw error
    } finally {
      callLog.record({
        source: 'model', tool: name, mode: modeOf(args),
        query: queryOf(args), hits, ms: Date.now() - started, ok,
      })
    }
  }
}
```

`countHits`：`wiki_recall` → `Array.isArray(value?.hits) ? value.hits.length : null`；
`wiki_context` → `Array.isArray(value?.evidence) ? value.evidence.length : null`；
`wiki_verify` / `wiki_observe` → `null`。

`queryOf`：`wiki_recall` / `wiki_context` → `typeof args?.query === 'string' ? args.query : ''`；
`wiki_verify` → `typeof args?.context_id === 'string' ? args.context_id : ''`；
`wiki_observe` → `''`。

`modeOf`：`typeof args?.mode === 'string' ? args.mode : ''`。

接法：把四处 `ctx.tools.register({ ..., execute(args) {...} })` 里的 `execute` 改成
`execute: traced('wiki_recall', async (args) => { ...原函数体... })`，**函数体一个字都不动**。

`/search` 路由里，在 `sendJson` 之前补：

```js
callLog.record({
  source: 'panel', tool: 'wiki_search', mode: 'search', query,
  hits: result.hits.length, ms: Date.now() - started, ok: true,
})
```

三个新路由，插在 `/search` 之后：

```js
if (route === '/calls' && req.method === 'GET') {
  const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
  const limit = Number(parsed.searchParams.get('limit') ?? 200)
  const source = parsed.searchParams.get('source') ?? 'all'
  const only = parsed.searchParams.get('only') ?? 'all'
  return sendJson(res, 200, callLog.read({
    limit: Number.isFinite(limit) ? limit : 200, source, only,
  }))
}
if (route === '/calls/clear' && req.method === 'POST') {
  if (blockedOrigin(req)) return sendJson(res, 403, { error: '拒绝跨源写入' })
  return sendJson(res, 200, { ok: true, cleared: callLog.read({ limit: 1 }).totals.calls })
}
if (route === '/calls/config' && req.method === 'POST') {
  if (blockedOrigin(req)) return sendJson(res, 403, { error: '拒绝跨源写入' })
  const body = await readBody(req)
  if (body === undefined) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
  const next = writeCallsConfig(pluginRoot, body)
  callLog.setEnabled(next.config.enabled)
  return sendJson(res, 200, { ok: true, enabled: next.config.enabled })
}
```

`/calls/clear` 里 `callLog.clear()` 要在取完 `cleared` 之后调。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/api.mjs`
Expected: 全绿

- [ ] **Step 5: 确认记录真的落盘了**

Run: `DSH_WIKI_CALLS_LOG=/tmp/probe-calls.jsonl node tests/gateway.mjs`
Expected: 11/11 通过，且 `/tmp/probe-calls.jsonl` 存在、每行恰好 8 个键（`node -e` 数一下键名）。

- [ ] **Step 6: 提交**

```bash
git add lib/index.js lib/config.js tests/api.mjs
git commit -m "feat(calls): 四个工具接入调用记录，加 /calls 三条路由"
```

---

### Task 4: 设置页新标签页

**Files:**
- Modify: `lib/client.js`
- Test: `tests/client.mjs`

**Interfaces:**
- Consumes: Task 3 的 `GET /calls`、`POST /calls/clear`、`POST /calls/config`
- Produces: `WikiCallsSection(props)` 组件 + 第二个 `settings.section` 注册（`id: 'wiki-notes-calls'`，`order: 48`，`label: () => '知识库 · 调用'`）

- [ ] **Step 1: 写失败测试**

`tests/client.mjs` 追加：

```js
check('调用审计页：section id 存在', source.includes("id: 'wiki-notes-calls'"))
check('调用审计页：label 是「知识库 · 调用」', source.includes("'知识库 · 调用'"))
check('调用审计页：组件是函数', typeof mod.WikiCallsSection === 'function' || source.includes('function WikiCallsSection'))
check('调用审计页：调 /calls 接口', source.includes("'/calls'"))
check('调用审计页：清空要过写闸', source.includes("'/calls/clear'"))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/client.mjs`
Expected: 前两条 `✗`

- [ ] **Step 3: 实现 `WikiCallsSection`**

放在 `WikiNotesSection`（`lib/client.js:170`）之后。结构：

```js
function WikiCallsSection(props) {
  var state = React.useState({ rows: [], totals: null, enabled: true, error: '' })
  // fetchCalls(limit, source, only) -> fetch(API + '/calls?...')
  // React.useEffect：立即拉一次，然后 setInterval 2000；document.visibilityState 不可见时跳过
  // clear：window.confirm 一行确认 -> POST /calls/clear -> 重拉
  // toggle：POST /calls/config {enabled} -> 重拉
  return h('div', { className: 'wn-root' }, 三格数字, 筛选行, 表格, 空态)
}
```

细节：
- 顶部三格：`今日调用 {totals.calls}`、`命中率 {totals.hitRate === null ? '—' : Math.round(totals.hitRate * 100) + '%'}`、`零命中 {totals.misses}`；下方小字 `统计基于最近 {window} 条记录；命中率分母不含 verify / observe`。
- 筛选：`全部 / 模型 / 面板` 三按钮 + `只看零命中` 开关 + `清空` 按钮 + `记录开关` 勾选框。
- 表格行：`时间`（`ts.slice(11,16)`）· `来源`（`model` → `模型`，`panel` → `面板`）· `工具` · `问题`（`title={row.query}`，CSS `text-overflow:ellipsis`）· `命中`（`hits === null ? '—' : hits`）· `耗时`（`${ms}ms`，`> 1000` 加 `wn-slow` 类）。
- 空态：`还没有调用记录。让模型查一次库，或在这儿手查一次。`
- 新增 CSS 全部用 `wn-calls-` 前缀，追加到现有 `CSS` 数组末尾。

在 `apply(ctx)` 里、现有 `settings.section` 注册之后，再注册一个：

```js
ctx.slots.inject('settings.section', function () {
  return ctx.slots.register(
    { name: 'settings.section', id: 'wiki-notes-calls', order: 48,
      label: function () { return '知识库 · 调用' } },
    function (props) { return h(WikiCallsSection, props || {}) },
  )
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/client.mjs`
Expected: 全绿

- [ ] **Step 5: 重启 DSH 后人工验一遍**

重启 DSH → 设置 → 左边应出现第二个入口「知识库 · 调用」→ 让模型查一次库 → 页面上 2 秒内出现那一行。

- [ ] **Step 6: 提交**

```bash
git add lib/client.js tests/client.mjs
git commit -m "feat(calls): 设置页加「知识库 · 调用」标签页"
```

---

### Task 5: 挂进测试流水线 + 文档 + 发版号

**Files:**
- Modify: `package.json`（`scripts.test` 末尾加 `&& node tests/calls.mjs`；`version` → `1.4.3`）
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-05-wiki-call-audit-design.md`

- [ ] **Step 1: 接测试**

`package.json` 的 `scripts.test` 在 `client` 那一段之前插入 `node tests/calls.mjs &&`。

Run: `npm test`
Expected: 18 个文件全绿

- [ ] **Step 2: 写 README**

在 `wiki_observe` 那段之后加一小节：

```markdown
### 调用审计（设置页「知识库 · 调用」）

`wiki_observe` 只统计走 Python 网关的 `wiki_context` / `wiki_verify`。
`wiki_recall` 是纯 JS 路径，从来不进观察日志——所以「模型到底查没查库」这个问题，
观察日志答不了。

设置页新增的「知识库 · 调用」页补上这一块：每次工具调用与面板手查都记一行，
只存 `ts / source / tool / mode / query / hits / ms / ok` 八个字段，
**不存页面路径、正文与答案**。记录写到插件目录下的 `calls.jsonl`（已被 `.gitignore` 忽略），
超过 5000 行自动裁到 2500 行。可以在页面上关掉记录，也可以一键清空。
```

- [ ] **Step 3: 更新设计稿状态**

`docs/superpowers/specs/2026-11-05-wiki-call-audit-design.md` 的「待确认」三条改写为已定结论：
标题「知识库 · 调用」；命中率分母排除 `verify` / `observe`；清空要一行确认。

- [ ] **Step 4: 提交并打 tag**

```bash
git add package.json README.md docs/superpowers/specs/2026-11-05-wiki-call-audit-design.md
git commit -m "docs+chore: 调用审计页文档与 1.4.3"
```

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 18 个文件全绿

Run: `node tests/gateway.mjs`
Expected: 11/11（未配管线时）
