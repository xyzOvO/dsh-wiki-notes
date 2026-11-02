# dsh-wiki-notes

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)](https://github.com/deepseek-ai)

**Read-only retrieval for a folder of Markdown notes, exposed as one tool call.**

Built for [DeepSeek Harness](https://github.com/deepseek-ai). Instead of a 5-step loop — read the overview, read the index, shell out to a search script, open the page, chase its sources — `wiki_recall` returns **the matching section's full text plus a page-level citation** in one call.

> 中文文档从下面开始。实测：73 页的库，旧流程单次 ≈ 18.7k 字符，新流程 ≈ 2.5k。

---

## 设计从哪来

库结构来自 [Karpathy 的 `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：与其每次提问都从原始文档重新检索（知识不累积），不如让 LLM 增量维护一个持久的 wiki。本插件只加速其中的 **Query** 一段。

| gist 里的概念 | 本插件默认位置 |
| --- | --- |
| Raw sources（不可变） | `原始资料-raw/` |
| The wiki（LLM 维护） | `知识层-wiki/` |
| The schema | 库根 `AGENTS.md` |
| `index.md` + `log.md` | 同名同格式 |

---

## 库该长什么样

**一个目录 + 一堆 `.md` 就能用。** 更细的约定见 [docs/库结构.md](docs/库结构.md)：frontmatter 七字段（英文写法 `title/type/tags/aliases/status/created/updated/sources` 也认）、`index.md` 摘要目录、`log.md` 时间线、`总览-overview.md`，满足得越多检索越准。可跑的样例在 [`examples/sample-wiki/`](examples/sample-wiki/)。

路径指到上一层（比如 `LLM-Wiki/`，里面还有 `原始资料-raw/` 和 `知识层-wiki/`）也没关系：插件会认 `index.md`，自动下钻到知识层，并在返回里注明它实际读的是哪一层。

---

## 装

在 DSH 里说一句即可：**「帮我装一个 DSH 插件，目录是 `<绝对路径>`」**。或自己发：

```
plugin_manager { action: "install_bundle", target: "<绝对路径>" }
```

返回 `application: applied` 就生效，不用重启。改 `lib/*.js` 后关开插件热重载；改 `lib/client.js`（设置页）要重启 DSH。

---

## 配

**设置 →「知识库」**，填路径 → 测试 → 保存。四层优先级：

| 优先级 | 来源 |
| --- | --- |
| 1 | 插件 config 的 `root` |
| 2 | 环境变量 `DSH_WIKI_ROOT` |
| 3 | `wiki-notes.config.json`（设置页写这里） |
| 4 | `lib/config.js` 的 `DEFAULT_WIKI_ROOT`（默认空） |

没配时工具会直接告诉你「还没配置知识库路径」，不会静默扫空目录。

---

## 用

| mode | 干什么 | 参数 |
| --- | --- | --- |
| `search`（默认） | 关键词 AND 检索 | `query`、`limit`（5，≤12）、`sectionChars`（900，≤3000） |
| `page` | 按页名/别名取整页 | `name`、`pageChars`（6000） |
| `list` | 按类型/标签/状态列目录 | `type`、`tags`、`status`、`limit`（40） |
| `overview` | 总览 + 规模行 + 最近日志 + 健康计数 | — |
| `lint` | 库健康检查：孤儿页、断链名字、缺字段、别名冲突、久未更新、无出链、草稿、index 与磁盘不一致 | `limit`（8）、`staleDays`（120） |
| `draft` | 把好答案回写成新页的落盘骨架（目录、frontmatter、index 行、log 条），不写文件 | `title`、`type`、`tags`、`summary`、`sources` |

```jsonc
{ "mode": "search", "query": "上下文 预算", "limit": 5 }
```

每条命中带 `kind`（note / raw-summary / source）、`sources`（来源数，**证据强度的唯一可靠代理**）、`status`、`gist`、`section`（命中小节正文，不是 90 字片段）、`citation`（`← [[页名]] §小节 → 路径`）、`brokenLinks`（指向不存在页的双链 = 「库里没依据」的硬信号）。`overview` 额外给三项健康信号：index 有磁盘无、磁盘有 index 无、跨目录重名。

模型怎么知道该查库：插件会从你库里现有的 `标签` 算出主题词，注入一行（约 50 token，例如「本地知识库 73 页，主题：上下文工程、ai、agent…」）。换库自动变，所以问题沾这些主题时它自己会去查，不用你提醒。设置页里可以关掉（不占上下文）、换成自己的整段、或在末尾追加一句，改完下一回合生效。

> `limit` 默认 5，一次约 2.5–3k token。嫌多可以传 3 省四成，但默认留 5 —— 少一次往返比省四成更值钱。

---

## 设置页

设置 →「知识库」。状态栏圆点表示实时同步是否生效，三个数字是页面 / 资料 / 红链页，下面是路径卡片和 `测试 · 保存并生效 · 重新扫描`。一次没配过时，卡片会变成三步引导。

浏览器半侧走同源 HTTP `/api/wiki-notes/*`（`state` / `check` / `save` / `rescan`），不碰 RPC。

---

## 实时同步

`fs.watch(root, { recursive: true })`，`.md` 新增 / 改 / 删 → 400ms 防抖 → 作废缓存。监听失败自动退回 30 秒 TTL 缓存。`recursive` 在 Linux 需 Node 20.13+，这也是 `engines` 的下限。

---

## 检索质量

与一个零依赖的 python 检索脚本做 A/B：14 条 query、比 top5 集合，**召回 65 / 65，无遗漏**。单条查询 0–2ms，扫 73 页约 50ms。

评分刻意朴素：标题全等 120 / 标题含 60 / 别名含 50 / 标签含 25 / 正文词频 ×3（封顶 36）/ index 摘要只在其它通道全 0 时补 8。三处经验细节：摘要分只补漏不抢位、同分用码点序（拼音序不可复现）、选节排除清单类与元讨论类小节。

---

## 上下游（可选）

- **进料**：[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) —— 网页剪藏成 Markdown 落进 raw 层。模板里写好 `类型` / `来源数量` / `标签`，本插件的 `kind`、`sources`、证据强度才有东西可用。
- **维护**：[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) —— 六个 `SKILL.md`，教 agent 写 Obsidian 语法（wikilink / `.base` / `.canvas` / CLI），少猜少往返。

---

## 已知局限

- 中文不分词，靠空格切分；连写词靠 `别名` 补。
- 页名本身是查询词时，正文很少重复该词，选节可能偏。
- 每次调用全量扫描；70–100 页无所谓，再大一个数量级要上增量索引。
- 只读。不写库、不改页、不修红链。

---

## 目录 / 开发

```
lib/corpus.js   扫描 + frontmatter / 小节 / 双链解析
lib/engine.js   评分、选节、六种模式（纯函数）
lib/config.js   库路径解析与配置读写
lib/index.js    插件入口：工具、渲染、设置页 API、目录监听
lib/client.js   设置页（手写 bundle，无构建）
bin/cli.mjs     命令行，不装插件也能跑
docs/库结构.md  库结构约定（这份才是一手文档）
examples/       可跑的最小样例库
tests/          smoke / watch / client bundle
```

```bash
node --run test                                    # 跑样例库，不需要本地知识库
node bin/cli.mjs search 上下文 --root=examples/sample-wiki
WIKI_ROOT="/path/your/wiki" node tests/smoke.mjs   # 拿自己的库跑通就行（不校验答案）
```

## License

MIT
