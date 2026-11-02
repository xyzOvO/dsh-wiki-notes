# dsh-wiki-notes

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)](https://github.com/deepseek-ai)

**Read-only retrieval for a folder of Markdown notes, exposed as one tool call.**

Built for [DeepSeek Harness](https://github.com/deepseek-ai). Instead of the usual 5-step agent loop — read the overview, read the index, shell out to a search script, open the page, chase its sources — `wiki_recall` returns **the matching section's full text plus a page-level citation** in a single call. Any Markdown folder works; the four-layer convention from [Karpathy's `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) makes it sharper.

> 中文文档从下面开始 ↓

---

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的**本地 Markdown 知识库检索插件**。
一个工具 `wiki_recall`，四种查询模式，纯只读。

它要解决的问题很具体：**模型查自己的笔记，原本要花 5 次往返**——
读总览 → 读 index → 跑检索脚本 → 读页 → 追源。这 5 次里每一次都要把整个历史重发一遍，
token 成本是线性叠加的。

这个插件把它压成 **1 次调用**：直接返回**命中小节的完整正文 + 页级出处**。

> 实测（73 页的库，2.5 MB）：旧流程单次查询 ≈ 18.7k 字符，新流程单次 ≈ 2.5k 字符。
> 真正省的不是字符数，是**往返次数**。

---

## 这套库的设计从哪来

库结构不是本项目发明的，它来自 **Andrej Karpathy 的 [`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)**——一篇公开的 idea file，作者说它本来就是设计成整段粘给自己的 LLM Agent 看的。本插件只借鉴其架构思路，未复制原文。

那篇讲的是**为什么**要这样搭库：与其每次提问都从原始文档重新检索（RAG 的老问题——知识不累积），不如让 LLM 增量维护一个持久的 wiki，新资料进来就并入已有页面、改写摘要、标注新旧结论的冲突。原文的原话是 "the wiki is a persistent, compounding artifact"。

本插件的全部假设都长在这套模式上：

| gist 里的概念 | 本插件对应的默认位置 |
|---|---|
| Raw sources —— 不可变的原始资料 | `原始资料-raw/`（只读，本插件不碰） |
| The wiki —— LLM 拥有并维护的那层 | `知识层-wiki/`（本插件只读） |
| The schema —— 告诉 LLM 规矩的契约文件 | 库根目录的 `AGENTS.md` |
| `index.md` 内容目录 / `log.md` 时间线 | 同名文件，格式一致 |
| Ingest / Query / Lint 三种操作 | 本插件只加速 **Query** 这一段 |

**一处具体的致谢**：gist 在「Optional: CLI tools」一节说，库大了就该给 LLM 配个检索工具（它推荐 qmd），并补了一句——碰到这种需求，你也可以让 LLM 帮你随手 vibe-code 一个朴素的检索脚本。`dsh-wiki-notes` 就是这句话的产物：把检索做进 Harness 的工具表，一次调用直接返回命中小节与出处。

还没读过那篇的话建议先读，它负责「怎么搭库」，本插件只负责「怎么查得快」。

---

## 上下游：另外两件值得装的工具

这套模式分三段——**进料 → 维护 → 查询**。本插件只做了最后一段，前两段有现成的，都不是必须，但装上之后整条链路会顺很多。

### 进料：[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)

Obsidian 官方的浏览器扩展：[Chrome](https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf) / [Firefox](https://addons.mozilla.org/en-US/firefox/addon/web-clipper-obsidian/) / [Safari](https://apps.apple.com/us/app/obsidian-web-clipper/id6720708363) / [Edge](https://microsoftedge.microsoft.com/addons/detail/obsidian-web-clipper/eigdjhmgnaaeaonimdklocfekkaanfme)。

看到好文章，划重点、点一下，正文连同高亮变成 Markdown 直接落进 `原始资料-raw/`。模板 + 变量 + 过滤器能让「来源、日期、标签」自动写进 frontmatter —— 这一步的收益不在省事，在于 **raw 层的元数据质量决定了后面 LLM 能榨出多少**。

> Karpathy 那篇 gist 的「Tips and tricks」第一条推的就是它。

### 维护：[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)

六个 `SKILL.md`，教 agent 别瞎猜 Obsidian 的语法：

| skill | 管什么 |
| --- | --- |
| `obsidian-markdown` | wikilink / embed / callout / properties |
| `obsidian-bases` | `.base` 的视图、筛选、公式、汇总 |
| `obsidian-cli` | 通过 Obsidian CLI 操作 vault |
| `json-canvas` | `.canvas` 的节点、连线、分组 |
| `defuddle` | 网页抽干净正文（省 token） |
| `knap` | JSON/CSV + 模板批量渲染 Markdown |

它本身不是软件，是「给模型看的说明书」，遵循 [Agent Skills 规范](https://agentskills.io/specification)，Claude Code / Codex / OpenCode 都能用。价值很实在：没有它，模型写 `.base` 和 `.canvas` 只能靠猜，猜错就是一次往返 —— **正好是这插件想省掉的那种往返**。

### 三者各管一段

| 环节 | 谁来做 | 对应 gist 里的 |
| --- | --- | --- |
| 网页 → raw 层 | Web Clipper | 收集 Raw sources |
| raw → wiki 页 | LLM + obsidian-skills | Ingest 与日常维护 |
| 查 wiki | **本插件** | Query |

---

## 它假设你的库长什么样

**一个目录 + 一堆 `.md` 就能用**，别的都是加分项。完整约定见 [docs/库结构.md](docs/库结构.md)。

最省事的做法：照着文档的四层约定搭库——frontmatter 七个字段、`index.md` 摘要目录、
`log.md` 时间线、`总览-overview.md`。满足得越多，检索越准。仓库里有一份可跑的
六页样例：[`examples/sample-wiki/`](examples/sample-wiki/)。

---

## 装

### 从本地目录装（推荐，改代码即时生效）

在 DSH 对话框里对 agent 说一句就够：

> 帮我装一个 DSH 插件，目录是 `<本仓库的绝对路径>`

它会在后台执行这次调用 —— 你也可以自己发：

```
plugin_manager { action: "install_bundle", target: "<本仓库的绝对路径>" }
```

返回 `application: applied` 即已生效，不用重启。装好后模型工具表里出现 `wiki_recall`。

### 卸载 / 重载

改宿主侧 `lib/*.js` 后，把插件关掉再打开即可热重载；改 `lib/client.js`（设置页半侧）需要重启 DSH。

---

## 配

库路径四级优先，**默认是空**，没配会明确告诉你「还没配置知识库路径」：

| 优先级 | 来源 |
| --- | --- |
| 1 | 插件 config 的 `root` |
| 2 | 环境变量 `DSH_WIKI_ROOT` |
| 3 | 插件目录旁的 `wiki-notes.config.json`（设置页保存的就是这里） |
| 4 | `lib/config.js` 的 `DEFAULT_WIKI_ROOT`（默认空；想给团队发带默认值的版本才填） |

最省事：**设置 →「知识库」**，填路径 → 测试 → 保存。

```bash
# 或者命令行临时指定
node bin/cli.mjs search 上下文 --root=examples/sample-wiki
```

---

## 用

```jsonc
// 1. 检索（默认模式）
{ "mode": "search", "query": "上下文 预算", "limit": 5 }
{ "mode": "search", "query": "RAG", "limit": 3, "sectionChars": 1500 }

// 2. 按页名/别名取整页（模糊，未命中给候选）
{ "mode": "page", "name": "上下文工程" }

// 3. 按类型/标签/状态列目录
{ "mode": "list", "type": "概念", "tags": ["AI"], "status": "草稿", "limit": 20 }

// 4. 库总览 + 规模行 + 最近日志 + 健康计数
{ "mode": "overview" }
```

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `query` | search | 空格分词，AND 语义；全部命中为零时降级为「命中任一」并标 `degraded` |
| `name` | page | 页名或别名，可只给前缀片段 |
| `type` / `tags` / `status` | list | 三个筛选可叠加 |
| `limit` | search / list | search 默认 5（最多 12），list 默认 40 |
| `sectionChars` | search | 每节正文上限，默认 900，最大 3000 |
| `pageChars` | page / overview | 整页正文上限，page 默认 6000 |

> **省 token 的开关**：`limit` 默认 5，一次返回约 2.5–3k token。如果你的问题通常两三页就能回答，
> 传 `limit: 3` 能省下约 40% 的返回量——但偶尔会需要再查一次。默认留在 5，
> 是因为「少一次往返」比「省 40% token」更值钱；你自己的库和模型（你的库很小、你的模型很便宜）
> 可以自己权衡。

### 返回里有什么

每条命中带：

- `kind` —— `note`（结构化笔记）/ `raw-summary`（资料摘要）/ `source`（资料页）
- `sources` —— 来源数量，**证据强度的唯一可靠代理**（本插件不认「可信档」这种字段）
- `status` —— 草稿 / 演进中 / 已提纯
- `gist` —— 正文开头的 `> 一句话总结：…` 或 `> 定义：…`
- `section` —— 命中最密的那一节正文（不是 90 字片段）
- `citation` —— `← [[页名]] §小节 → 相对路径`，可直接引用
- `brokenLinks` —— 这一节里指向不存在页的双链，**「库里没依据」的硬信号**

`overview` 还会额外给三项库健康信号：`index.md` 里登记了但磁盘上没有的页、
磁盘上有却没登记的页、不同目录下的重名页。

---

## 设置页

设置 →「知识库」（`settings.section`，order 47）：

- **状态栏**：一个圆点表示实时同步是否生效（绿=改完笔记立刻可见，灰=退回 30 秒缓存），
  后面跟上次扫描的页数与耗时
- **三个数字**：页面 / 资料 / 有红链的页
- **库路径卡片**：当前生效的路径 + 来源徽标；一次都没配过时，卡片换成三步引导（填路径 → 测试 → 保存）
- **测试**（试扫不保存，结果用四颗 chip 显示：页数 / 资料数 / 红链数 / 耗时）→
  **保存并生效**（写配置文件，立刻作废缓存，不用重启）→ **重新扫描**；
  「清掉配置」推到最后单独放着，免得误点
- **「配置来源与优先级」** 默认折叠：展开能看到配置文件路径、文件里的值、环境变量覆盖、内置默认

浏览器半侧走同源 HTTP `/api/wiki-notes/*`（`state` / `check` / `save` / `rescan`），不碰 RPC。

> 客户端半侧（`lib/client.js`）由 dsh-web 在**应用启动时**扫描进 bundle，改完要重启 DSH。

---

## 实时同步

`fs.watch(root, { recursive: true })` 监听库目录：`.md` 文件新增/修改/删除 → 400ms 防抖 → 作废缓存，
下次查询重扫。监听失败时自动退回 30 秒 TTL 缓存，不会让工具不可用。

`recursive` 在 Linux 上需要 Node 20.13+，这也是 `engines` 写 `>=20.13.0` 的原因。

---

## 检索质量

与一个零依赖的关键词检索脚本（Python，每次启动都要全量重解析）做 A/B：
14 条真实 query、比 top5 集合，**召回覆盖 65 / 65，无遗漏**。

单条查询 0–2 ms，全量扫 73 页约 50 ms。

评分权重刻意保持朴素：标题全等 120 / 标题含 60 / 别名含 50 / 标签含 25 / 正文词频 ×3（封顶 36）
/ index 摘要只在其它通道全为 0 时补 8 分。

三处经验性的细节：

1. **摘要分只补漏不抢位**。直接累加会让「摘要里提过这个词」的资料页顶掉真正相关的笔记页。
2. **同分次序用码点序**，不用 `localeCompare('zh')`。拼音序会让同分页重排，结果不可复现。
3. **选节排除清单类与元讨论类小节**。`§元信息` 里列着文件名，词频很高却一个字都不回答问题。

---

## 已知局限

- 中文不分词，靠空格切分；「上下文工程」这种连写词只能整体匹配。别名可以补：把常见拆法写进 `别名`。
- 页名本身就是查询词时，正文很少重复该词，选节可能偏到边角小节。
- 每次调用全量扫描。当前规模（70–100 页）下 1–2 ms 无所谓，库再大一个数量级就该上增量索引了。
- 只读。不写库、不改页、不自动修红链。

---

## 目录

```
lib/corpus.js   只读扫描 + frontmatter/小节/双链解析
lib/engine.js   评分、选节、四种模式的纯函数
lib/config.js   库路径解析（含来源判定）与配置文件读写
lib/index.js    插件入口：注册 wiki_recall、渲染返回、设置页 API、目录监听
lib/client.js   设置页「知识库」（手写 __ModuleLoader__ bundle，无构建）
bin/cli.mjs     命令行，不装插件也能跑
docs/库结构.md   库结构约定（这是这个项目的真正文档）
examples/       可跑的最小样例库
tests/          smoke（样例库）/ watch / client bundle
tests/local/    作者私有回归：真实库 A/B、设置页 API 端到端、token 量测
```

## 开发

```bash
node --run test          # 不需要任何本地知识库，跑 examples/sample-wiki
node bin/cli.mjs search 上下文 --root=examples/sample-wiki
```

想看看它在你自己的库上跑出来什么（只确认「能跑通、能查到东西」，不校验具体答案）：

```bash
WIKI_ROOT="/path/to/your/wiki" node tests/smoke.mjs
```

## License

MIT
