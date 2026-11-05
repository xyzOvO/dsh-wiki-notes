# 调用审计页设计（设置页新标签页）

日期：2026-11-05 · 状态：已实现（1.4.3）· 规模：小（约 400 行）

## 为什么

知识库有没有被用起来，现在没人知道。

`wiki_observe` 的统计只覆盖走 Python 网关的 `wiki_context` / `wiki_verify`。
实测本机：`wiki_recall` 被调用 158 次，观察日志里 **0 条**——因为 recall 是纯 JS
路径，从头到尾没有写日志的代码。结果是「库到底有没有帮上忙」这个问题，
插件自己答不上来。

这个页面回答的是使用审计问题：**模型到底有没有查库、查了什么、查到没有。**

## 目标

- 设置页新增一个标签页「知识库 · 调用」，展示调用流水。
- 每次工具调用（四个 wiki 工具）与每次面板手查，都留一条最小记录。
- 顶部三个数：今日调用次数、命中率、零命中次数。
- 流水表：时间 / 来源 / 工具 / 问题 / 命中数 / 耗时。
- 能筛：全部 / 只看模型 / 只看面板 / 只看零命中。
- 能一键清空记录。

## 非目标（本轮不做）

- 「哪类问题压根没查库」——这需要读 DSH 会话转录，要 Node 22.15+ 的
  `zstdDecompressSync`，而 `engines` 是 `>=20.13.0`。留待下一轮。
- 任何检索算法改动：分词、评分、排序一律不动。
- 记录正文、页面路径、答案原文。
- 跨机器同步、上传、任何网络出口。

## 约束

- `lib/client.js` 是手写 bundle，无构建步骤，只能用 `React.createElement`（`h`）。
- 客户端改动要**重启 DSH** 才生效。
- 客户端组件必须能在 `tests/client.mjs` 的 React stub 下加载。
- 插件当前**零运行时依赖**，本设计不新增依赖。
- 写盘一律走插件根目录（已在 `.gitignore`），不写进知识库。

## 方案（已选 B）

| 方案 | 代价 | 结论 |
|---|---|---|
| A 只放内存环形缓冲 | 约 250 行 | 能看，但重启即空，审计要的跨天趋势拿不到 |
| **B 内存 + 追加写 jsonl** | 约 400 行 | **选中**：有历史，字段最小化后不增加隐私面 |
| C 复用 Python 观察日志 | 约 200 行 | 不做：recall 走 Python 会把 0–2ms 拖成进程启动级，违背原设计 |

## 怎么实现

### 1. 采集点：包一层 `execute`，不碰各工具内部

四个工具都经 `ctx.tools.register` 注册。新增一个小包装器：

```js
function traced(name, execute) {
  return async function (args) {
    const started = Date.now()
    let ok = true, hits = null
    try {
      const value = await execute(args)
      if (value && value.mode === 'error') ok = false
      hits = countHits(value)
      return value
    } catch (error) {
      ok = false
      throw error
    } finally {
      if (callsOn) record({ source: 'model', tool: name, mode: modeOf(args),
                            query: queryOf(args), hits, ms: Date.now() - started, ok })
    }
  }
}
```

`countHits`：
- recall → `Array.isArray(value.hits) ? value.hits.length : 0`（非 search 模式记 null）
- context → `value.evidence?.length ?? 0`
- verify / observe → `null`（它们不产生「命中页」，硬塞一个数会让命中率失真）

`queryOf`：recall/context 取 `args.query`；verify 取 `args.context_id`；
observe 取空。**截到 120 字**，超了加省略号。

面板手查（`GET /search`）在 handler 里单独调一次 `record({source:'panel', tool:'search', …})`，
与模型调用同表不同色。

**不包 `execute` 之外的任何东西**：不改工具返回值、不改 schema、不改描述。

### 2. 记录格式（字段白名单，写死）

```json
{"ts":"2026-11-05T21:37:12","source":"model","tool":"wiki_recall",
 "mode":"search","query":"别了 司徒雷登","hits":0,"ms":1,"ok":true}
```

**只有这 8 个字段。** 明确不写：页面路径、文件名、正文片段、答案、错误堆栈。

`record()` 做两件事：推入内存环形缓冲（上限 500 条），并 append 一行到文件。
写文件失败只 `console.warn`，绝不影响工具返回——观察是旁路。

### 3. 存储与轮转

- 路径：`pluginRoot/calls.jsonl`，可通过配置 `calls.log` 覆盖。
- 轮转：append 前若文件行数超 5000，读回最后 2500 行重写。检查用计数缓存，
  不每次 `readFile`。
- 文件不存在时自动创建；目录不存在时跳过写文件但仍保留内存缓冲。

### 4. 读取接口

`GET /api/wiki-notes/calls?limit=200&source=all|model|panel&only=miss`

- 只读 GET，和 `/state` 同级，**不过跨源写闸**。
- 从文件**尾部**读，不做全量解析：读最后 256KB，按行 `JSON.parse`，坏行跳过。
- `limit` 上限 500；`only=miss` 过滤 `hits === 0`。
- 返回 `{ rows: [...], totals: {today, hitRate, misses} }`，`totals` 按当天统计。

### 5. 页面

新增第二个 `settings.section`：

```js
ctx.slots.register({
  name: 'settings.section',
  id: 'wiki-notes-calls',
  order: 48,
  label: () => '知识库 · 调用',
}, WikiCallsSection)
```

组件 `WikiCallsSection`：
- 顶部三格数字：今日调用 / 命中率 / 零命中（分子固定为「返回 ≥1 页证据」的调用，
  `verify` 与 `observe` 不计入分母，页面上注一句）。
- 筛选行：三个来源按钮 + 「只看零命中」开关 + 「清空」按钮（`POST /calls/clear`，过写闸）。
- 流水表：时间（只到分）· 来源徽章 · 工具 · 问题（单行截断，`title` 给全文）·
  命中 · 耗时（>1000ms 标黄）。
- 轮询：页面可见时每 2 秒拉一次（`document.visibilityState`），不可见就停。
- 空态：写明「还没有调用记录。让模型查一次库，或在这儿手查一次」。

样式复用现有 `wn-` 前缀变量，不新增主题变量。

### 6. 开关

配置项 `calls.enabled`，默认 `true`。关掉后 `record()` 直接返回，内存与文件都不动。
设置页那一块给一个勾选框 + 一句「关掉后不再记录任何调用」。

## 测试

- 新增 `tests/calls.mjs`：
  - 调用一次 recall，`calls.jsonl` 多一行，字段恰好是那 8 个（断言不含 `file`/`path`/`text`）。
  - 超长 query 被截到 120 字。
  - 第 5001 次写入触发轮转，行数落到 2500。
  - `calls.enabled=false` 时不写任何行。
  - 写文件失败（目录只读）时工具仍正常返回。
- `tests/api.mjs` 补：`GET /calls` 默认返回、`limit` 截断、`only=miss` 过滤、
  `POST /calls/clear` 清空且过跨源闸。
- `tests/client.mjs` 补：新 section 注册代码在、组件是函数。

## 已定结论（2026-11-05）

1. 页面标题：「知识库 · 调用」。
2. 命中率分母**排除 `verify` / `observe`**，只算 recall 与 context；页面上注一句说明。
3. 「清空」要一行内二次确认（不弹系统对话框）。
