# 可视化检索面板设计（设置页 + 右侧栏）

日期：2026-11-04 · 状态：待确认 · 规模：小（约 350 行）

## 为什么

现在检查一个检索插件的唯一办法是问模型「你查到了什么」，再自己判断它是不是在编。
人看不见检索过程，也就无法判断**是库没写、还是没查到、还是查到了没用好**——
这三种失败在对话里长得一模一样。

面板把同一套 `run()` 的结果直接摊在人眼前：搜的词切成了什么、
每个命中凭什么得分、选中的是哪一小节。人和模型看同一份证据，
分歧才能落到具体一条上。

## 目标

- 设置页「知识库」里多一个搜索框：输入 → 立刻看到命中列表与命中理由。
- 右侧栏多一个常驻 tab，装的是**同一个组件**，不必每次开设置。
- 每条命中可展开该小节正文与出处（页名 · §小节 · 文件路径）。
- 空查询时显示库的状态摘要（页数 / 资料数 / 扫描耗时 / 红链 / 最后更新）。

## 非目标（本轮不做）

- 一键把结果注入对话上下文。
- 打开笔记文件到编辑器（那是 better-sidebar 的能力，本轮不引入该依赖）。
- 任何检索算法改动：分数口径、分词、排序一律不动。
- 任何写知识库的能力。

## 约束

- `lib/client.js` 是手写 `__ModuleLoader__` bundle，无构建步骤，只能用 `React.createElement`（`h`）。
- 组件必须能在测试的 React stub 下加载（`tests/client.mjs` 现有做法）。
- 客户端改动要**重启 DSH** 才生效，改完得自己验一遍。
- 侧栏接入不依赖 `dsh-better-sidebar`：用原生 `sidebarRightTabs` + `sidebar.right.pane.tab` 插槽。

## 方案（已选 B）

| 方案 | 代价 | 结论 |
|---|---|---|
| A 只在设置页加搜索框 | 约 150 行 | 能做，但每次要开设置 |
| **B 设置页 + 右侧栏 tab，共用一个组件** | 约 350 行 | **选中**：常驻，且与模型同源 |
| C 接 better-sidebar `registerTab` | 多一个硬依赖 | 不做：它的 tab 最后也落在原生右侧栏 |

## 怎么实现

### 1. 命中理由要能看见 → 引擎加一个只给面板用的开关

`search()` 增加 `args.explain === true` 时，每条命中多返回：

```js
termHits: [{ term: '上下文', score: 15, via: 'body', count: 5 },
           { term: '预算',   score: 3,  via: 'body', count: 1 }]
```

`via` 取值 `name | alias | tag | body | index`，`count` 是正文出现次数。
**这只是把 `termScore` 已经在算的数摊开**，权重与排序零改动；
开关不进工具 schema，模型永远触发不到，工具输出的 token 也不变。

### 2. 一个只读接口

`GET /api/wiki-notes/search?q=…&limit=5&explain=1`

- 复用 `loadCorpus` 的 30s 缓存与 `fs.watch` 失效，不引入第二条读取路径。
- 直接返回 `run({ mode:'search', query, limit, explain:true })` 的结果 + `elapsedMs`。
- `q` 上限 200 字、`limit` 上限 20；超了截断而不是报错。
- 只读 GET，和 `/state` 同级，不过跨源写闸。

### 3. 组件 `WikiSearchPanel`

- 输入框（Enter 提交）+ 结果计数行：`命中 1 / 考虑 95 · 全词命中 · 12ms`。
- 降级（OR）时那行变黄并写明「没有一条命中全部词，下面是任一词命中」。
- 每条：`页名 · 类型 · 分数` + 命中词徽章（词 + 通过哪条通道 + 次数）+「未命中全词」标记。
- 点击展开：该小节 `## 标题` + 正文 + `← [[页名]] §小节 → 相对路径`。
- 空查询：显示 `/state` 已有的规模摘要，顺带一眼看出库配没配好。

### 4. 两处挂载

- 设置页：现有 `settings.section` 组件底部加一节「查一下」。
- 右侧栏：`ctx.inject(['sidebarRightTabs'], owner => …)`，注册
  `{ id:'dsh-wiki-notes/search', kind:'wiki-notes-search', priority:'extension', title:()=>'知识库' }`
  与 `sidebar.right.pane.tab` 插槽；`package.json` 的 `dsh.client.inject` 补
  `@deepseek-ai/dsh-client-ui-sidebar-right`。
- 服务不存在时静默跳过侧栏那一半，设置页照常可用。

## 测试

- `tests/api.mjs`：`/search` 正常返回、`limit` 截断、空 `q` 400、`explain` 打开时每条命中带 `termHits`。
- 新增 `tests/explain.mjs`：`explain` 不改分数、不改排序、不加字段到默认输出（同一 query 两次对比）。
- `tests/client.mjs`：模块结构、面板组件是函数、侧栏注册代码在。
- `tests/contract.mjs`：`package.json` 的 `dsh.client.inject` **不含**侧栏模块（见下方实现记录，原方案写反了）。
- 重启 DSH 后手验：设置页搜「上下文 预算」；右侧栏 tab 同步出结果。

## 留给实现者

- 面板的视觉细节（间距、徽章配色）按现有设置页 CSS 变量走，不新增主题。
- 命中很多时的折叠策略：默认只展示前 5 条（侧栏 8 条），计数行标出「显示前 N」，不做二次展开。

## 实现记录（2026-11-04，1.2.0）

三处与设计稿不同，都是实现时才发现设计稿写错/写不全：

1. **`dsh.client.inject` 不加侧栏模块**（设计稿写反）。加了会把「侧栏模块在不在」变成整个客户端包的加载前提 —— 侧栏一缺，连设置页都进不去，正好违反本轮的故障隔离要求。改为运行时 `ctx.inject(['sidebarRightTabs'], …)` 按需取，取不到就静默跳过；`tests/contract.mjs` 钉住「不许钉进 inject」。
2. **不引 better-sidebar**，原生 `sidebarRightTabs` + `sidebar.right.pane.tab` 就够（照 dsh-image-gen 的写法）。
3. **不做「还有 N 条」展开**，改在计数行标「显示前 N」——面板的用途是对照模型看到什么，条数与工具默认值一致更重要。

已验证：

- explain 不改检索：`termScore` 现在就是 `termBreakdown().score`，同一份明细既排序又当理由；拿 `git show HEAD:lib/engine.js` 的旧引擎与新引擎同跑活库（95 页），27 次查询（15 个 query × limit 3/12）+ 6 个 mode，输出 JSON 完全一致。
- `tests/explain.mjs` 34 项：6 个查询开关前后 `name|score|allTerms` 逐条相同、每条 `termHits` 各词分数之和 === 该条总分、工具 schema 与工具输出里都没有 `termHits`。
- 侧栏故障隔离：`tests/client.mjs` 用假 owner 跑「服务缺失 → 0 个面板、不抛」，设置页那份面板照常渲染。
- 全量 `node --run test` 17 个脚本全绿（新增 explain 34 项、api 增到 35 项、contract 11 项、client 增侧栏断言）。
- 活库经 `/search` 路由实测：`上下文 预算` → 命中 7 / 参与 95 / 36ms，Top1「上下文 [概念] 194 分」理由 `上下文(name:120+alias:50+body×7:21)` + `预算(body×1:3)`；`逻辑填空` → 1ms，Top1 123 分 `name:120+body×1:3`。
- 未完成：GUI 内的实际点击验收要重启 DSH 才有效（新路由 `/api/wiki-notes/search` 在运行中的宿主里还是 404）。
