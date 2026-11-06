# dsh-wiki-notes

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)](https://github.com/deepseek-ai)

**给你那堆 Markdown 笔记，接上四个能用的工具：查得到、读得出、核得住、看得见。**

为 [DeepSeek Harness](https://github.com/deepseek-ai) 做的只读检索插件。旧的流程是五步：读总览 → 读索引 → 敲命令搜 → 打开那页 → 追它的来源。现在一次调用就把**命中小节的完整正文 + 出处**返回，模型自己接着答。

> 中文文档从下面开始。实测：73 页的库，旧流程单次 ≈ 18.7k 字符，新流程 ≈ 2.5k。

---

## 目录

| 你想知道 | 直接跳 |
| --- | --- |
| 这插件到底能干什么 | [四个工具](#四个工具) |
| 我要先装上试试 | [装](#装) · [配](#配) |
| 我自己的笔记该怎么写 | [库该长什么样](#库该长什么样) |
| 检索为什么这么打分 | [检索质量](#检索质量) |
| 它有没有偷看我的东西 | [只读，且不往外发](#只读且不往外发) |
| 旧版本有没有遗留 | [发布物与残余风险](#发布物与残余风险) |
| 已知毛病 | [已知局限](#已知局限) |
| 要改代码 | [目录 / 开发](#目录--开发) |

---

## 四个工具

插件注册四个工具，用途不重叠，按顺序读就明白了：

| 工具 | 一句话 | 什么时候用 |
| --- | --- | --- |
| **`wiki_recall`** | 检索库，拿到命中小节的正文与出处 | 「我的笔记里怎么写的？」 |
| **`wiki_context`** | 检索 + 抽证据 + 标缺口 + 给回答约束，**一次做完** | 要引用笔记原文回答，或想知道「依据够不够」 |
| **`wiki_verify`** | 拿已有的 context 核验一段回答，**不重新检索** | 答案写完了自查，特别是有数字的时候 |
| **`wiki_observe`** | 查观察日志统计（调用次数、支持状态分布、违规类型） | 诊断，不参与回答 |

设置页里只有一个「知识库」入口，进去分两个页签：**概览**（路径、体检、提示词）和**调用记录**（谁在什么时候查了什么、查到没有）。后者不是工具，是那本账的界面。

### `wiki_recall` —— 检索

一个工具，七种 mode：

| mode | 干什么 | 参数 |
| --- | --- | --- |
| `search`（默认） | 关键词 AND 检索 | `query`、`limit`（5，≤12）、`sectionChars`（900，≤3000） |
| `page` | 按页名/别名取整页 | `name`、`pageChars`（6000） |
| `list` | 按类型/标签/状态列目录 | `type`、`tags`、`status`、`limit`（40，≤200） |
| `overview` | 总览 + 规模行 + 最近日志 + 健康计数 | `pageChars`（4000）、`logLimit`（5，≤20） |
| `lint` | 库健康检查：孤儿页、断链名字、缺字段、别名冲突、久未更新、无出链、草稿、index 与磁盘不一致；**并和上次体检对比，报出新增与已修** | `limit`（8，≤40）、`staleDays`（120） |
| `draft` | 把好答案回写成新页的落盘骨架（目录、frontmatter、index 行、log 条），不写文件 | `title`、`type`、`tags`、`summary`、`sources` |
| `help` | 用法与状态说明：七个 mode 各返回什么、`status` 各取值怎么读、参数默认值 | 无 |

```jsonc
{ "mode": "search", "query": "上下文 预算", "limit": 5 }
```

每条命中带 `kind`（note / raw-summary / source）、`sources`（来源数，**证据强度的唯一可靠代理**）、`status`、`gist`、`section`（命中小节正文，不是 90 字片段）、`citation`（`← [[页名]] §小节 → 路径`）、`brokenLinks`（指向不存在页的双链 = 「库里没依据」的硬信号），以及 `updated` 后面的**距今天数**（超过 180 天标「可能已过时」——三年前的结论和上周的长得一样，模型需要这个信号）。`overview` 额外给三项健康信号：index 有磁盘无、磁盘有 index 无、跨目录重名。

### `wiki_context` —— 带证据的上下文

要引用笔记原文回答、或需要知道「有没有依据 / 依据够不够 / 哪里是缺口」时用它，而不是自己连续调 `wiki_recall`。

参数：`query`（必填）、`limit`（1–12，默认 5）、`engine`（`both` / `search` / `wiki_recall`，默认 `both`）、`ttl_seconds`（默认 1800）。

返回里最重要的一条：**`status.support` 和 `status.degraded` 是两件事，必须分开看。**

- `support` 说的是**知识够不够**（`sufficient` / `partial` / `insufficient`）。
- `degraded` 说的是**引擎有没有坏**。它是布尔值，为真时说明某个检索通道挂了 —— 这时候不能把 `support` 当结论，那是拿不完整的检索结果下的判断。

同时返回 `evidence`（证据页，含分级、支撑了哪个槽位）、`missing`（缺什么、为什么缺）、`conflicts`（冲突候选，**未裁决，别当成已确认的结论**）、`answer.contract_text`（给回答的约束：必须披露缺口、不得超出证据、引文须原文），以及一个 `context_id`。

### `wiki_verify` —— 核验回答

写完答案后自查（尤其含数字、范围、年份、题量分值这类主张时）用它。参数：`context_id` + `answer`（可选 `observe_id`，一般不用传，插件会自动带上）。

它不重新检索 —— 拿当初那份快照来比，所以快，也不受库里后来改动的影响。

返回 `status` 与 `violations`：violations 非空说明回答越过了证据允许的边界，每条都带类型、主张和原因。另有 `notices` 单独放「说不清」的提示 —— **「说不清」不等于「说错了」**，模型若只读 violations 会漏掉这一块。

`context_expired` / `context_missing` 是**快照问题**，不等于回答错了：重新取一份 context 再核验就行。

每次核验都会往观察日志追加一条记录，并用 `parent_observe_id` 指回当初那份 context —— 这样「哪次核验修好了哪次回答」在日志里追得回。

### `wiki_observe` —— 诊断

参数：`days`（1–365，默认 7）、`limit`（1–50，默认 10）。

报观察窗口内的调用次数、支持状态分布、检索状态分布、违规类型分布，还有**修正情况**（核验过的 context 里已改正 / 仍未改正的比例）—— 这一项比违规总数更能反映核验到底有没有用。只读诊断，不参与回答，也不改检索行为。

> ⚠️ 它只看**网关**那三次调用（`wiki_context` / `wiki_verify`）。`wiki_recall` 不走 Python，也就不写观察日志 —— 要看全部调用，去「知识库」页的「调用记录」页签。

### 调用审计 —— 「知识库」页的「调用记录」页签

在设置页的「知识库」里切到第二个页签。模型和面板**每一次**查库都会记一行，回答的是「我这句问话，它到底查了没有、查到没有」。

三格数字（今日调用 / 命中率 / 零命中）+ 一张表（时间 · 来源 · 工具 · 问题 · 命中 · 耗时）+ 筛选（全部 / 模型 / 面板、只看零命中）。页面每 2 秒自己刷新。

账本落在插件目录旁的 `calls.jsonl`（已在 `.gitignore` 里），只记 8 个字段：

```
ts · source · tool · mode · query · hits · ms · ok
```

**页面路径、正文、答案一律不进账本。** `query` 截到 120 字。

几条口径值得写清楚：

- **命中率的分母不含 `wiki_verify` / `wiki_observe`**，也不算 `page` / `list` 这类非检索模式 —— 它们没有「命中几页」这回事，记成 0 会把命中率系统性压低，所以记 `null`，不进统计。
- **它只能看见「发生了的调用」**。模型压根没想起来查库，这里也不会有记录 —— 那是一种缺席，账本记不了缺席。要统计「哪类问题从来不查库」，得去读会话转录（本插件不读）。
- 记满 5000 行轮转一次，只留最近 2500 行；读取只扫文件尾部 256 KB。
- 记账是**旁路**：写不进去只打一行警告，工具的返回值一个字都不改。`calls.enabled` 可以整个关掉。

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

返回 `application: applied` 就生效，不用重启。但**改插件自己的代码要重启 DSH**：`lib/*.js`（宿主半）和 `lib/client.js`（设置页）都一样，已载入的模块不会因为关开插件而重新求值。

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

`wiki_context` / `wiki_verify` / `wiki_observe` 还需要一条 Python 通路（`bridge.python` + `bridge.toolsRoot`，后者是含 `wiki_bridge.py` 的目录）。没配的话这三个工具会明确报 `E_PYTHON_UNAVAILABLE` —— **不会假装成「知识库里没有」**。配置形状见 [docs/契约-stage0/阶段4-插件接入.md](docs/契约-stage0/阶段4-插件接入.md)。

---

## 模型怎么知道该查库

插件会从你库里现有的 `标签` 算出主题词，注入一行（约 50 token，例如「本地知识库主题：上下文工程、ai、agent…」）。不带页数 —— 页数一变就会打掉提示词的前缀缓存，而它对「该不该查」没有帮助。换库自动变，所以问题沾这些主题时它自己会去查，不用你提醒。设置页里可以关掉（不占上下文）、换成自己的整段、或在末尾追加一句，改完下一回合生效。

主题词怎么挑：跳过 `总览`/`index` 这类结构页，跳过 `数据`/`工具`/`meta` 这类空泛标签，默认只留出现 ≥2 次的标签（设置页可改回 ≥1）。全被滤掉时退回不过滤的前五 —— 小库不至于一条提示都没有。

---

## 设置页

设置 →「知识库」。状态栏圆点表示实时同步是否生效，三个数字是页面 / 资料 / 红链页，下面是路径卡片和 `测试 · 保存并生效 · 重新扫描`。一次没配过时，卡片会变成三步引导。

浏览器半侧走同源 HTTP `/api/wiki-notes/*`（`state` / `search` / `check` / `save` / `rescan`），不碰 RPC。

---

## 检索面板

设置页里有一张「试一试检索」的卡，右侧栏另有一个「知识库」页签 —— 同一份组件，`compact` 控制密度。用途只有一个：**让人自己看见检索依据**，不必等模型说它查到了什么。

输入关键词回车，上面一行是「命中 7 页（显示前 5）· 参与打分 95 页 · 36 ms · 库 95 页」；紧跟一行是**查询诊断**：`实际用的词` 后面逐个列出这次真正参与打分的词，一页都没沾到的词会标成「没沾到」，末尾写清这次是「全词都要（AND）」还是「命中任一（OR）」。中文不分词，写整句时这一行通常只剩一个词 —— 这是最直观的提示：换词，而不是加词。

每条命中占一行，左边是名次、页名、类型，右边是一条按「相对第一名」缩放的分数条和总分。多类型命中会按类型分组（`概念（3）`、`资料（2）`…）。展开后有：

- 页名、类型、总分，以及「只命中部分词」的标记（该条没命中全部查询词）；
- **命中理由**：每个查询词一条徽章，主词加粗、明细灰字，例如 `上下文 · 页名 120 · 别名 50 · 正文 ×7 21`，未得分的词显示为「未命中」。悬停徽章有各通道的权重说明；
- 该条命中的小节标题与正文（正文里出现过的查询词带淡黄底纹），末尾附 citation，右侧一个复制按钮 —— 把「哪句话支撑了这条」直接抄进对话里；
- 查询降级成「命中任一」时，计数行旁边会黄字提示。

**键盘**：输入框防抖 350ms（够 2 个字符才查），`Enter` 立刻查，`Esc` 清空，`↑`/`↓` 在结果里移动高亮并展开对应条目；任意位置按 `/` 或 `Ctrl/⌘ + K` 直接跳到输入框。查询进行中列表上方显示「检索中…」。输入框右边有「复制词」—— 查出来的说法常常要拿去别处再查一遍，省得重敲；citation 那行的复制按钮同理（键盘走过去会看到焦点框）。

**覆盖统计**在设置页的状态卡下面：`发现 102 个文件 → 读到 95 页 / 677 个小节`，后面是总体积、跳过 / 读不了 / 超大未读 / 读取失败的计数（非 0 时标黄）、最新修改时间、本次扫描耗时，以及这次实际扫的目录（自动下钻过时它和配置里的路径不是同一个）。

没查之前不是一片空白：显示库的规模、同步开关，以及库里出现最多的几个标签 —— 点一下直接拿它当查询词，省得先想「该查什么」。查不到时也顺带报覆盖：`参与检索 95 页 / 677 个小节 · 跳过 7` ——「没命中」和「那几页根本没读」是两回事，面板得能分清。`discovered = pages + unreadable + skipped` 在 `tests/api.mjs` 里当恒等式断言，这几个数不是凑出来的。

面板是只读的：不写库、不改配置、不进模型上下文。

**`explain` 是对既有检索的解释，不是第二套检索。** 引擎里分数只有一个实现 —— `termScore(page, token)` 就是 `termBreakdown(page, token).score`，理由和排序分数出自同一份明细，所以面板不可能显示「一套理由、另一套排序」；`tests/explain.mjs` 对同一批查询比对开关前后的 `name|score|allTerms` 逐条相同，还核对了「每个词的明细加起来 === 该条总分」。`explain` 也不在工具 schema 里：模型触发不到它，`wiki_recall` 的输出体积一个 token 都不变。

工具输出里新增两个短字段，是给**模型**看的而不是给面板看的：`matchMode`（`and`/`or`）和 `missedTerms`（一个词都没沾到的那些）—— 模型看到「这个词没用上」才可能换词重查。它们会被渲染成一行：`没沾到：量子纠缠（这些词在库里一页都没命中，换同义词或干脆去掉）`；没有漏词时这行不出现，正常路径不多花一个 token。而「每个词命中多少页」(`termPages`) 只在 `explain` 时出现：那是面板的事，模型用不上。

> 这条踩过一次：字段先加进了 `run()` 的返回值，但模型拿到的是 `renderValue()` 渲染出的文本 —— 不写进渲染，模型就等于没拿到。`tests/status.mjs` 现在有两条断言看着它（有漏词要出现、没漏词不许出现）。

侧栏是可选能力：`ctx.inject(['sidebarRightTabs'], …)` 运行时按需取，服务不在就静默跳过，设置页照常可用；`dsh.client.inject` 刻意不钉侧栏模块（钉了会把「侧栏在不在」变成整个客户端包的加载前提）。`tests/contract.mjs` 守着这两条。

接口：`GET /api/wiki-notes/search?q=上下文 预算&limit=5`，`q` 截到 200 字，`limit` 夹在 1–12，缺 `q` 返回 400。

---

## 实时同步

`fs.watch(root, { recursive: true })`，`.md` 新增 / 改 / 删 → 400ms 防抖 → 作废缓存。监听失败自动退回 30 秒 TTL 缓存。`recursive` 在 Linux 需 Node 20.13+，这也是 `engines` 的下限。

---

## 检索质量

基线是 v3：14 条 query / 68 个槽位，比 top5 集合，**Recall@5 = 100%，当回归硬门禁**（口径、判据与历史快照见 [docs/metrics.md](docs/metrics.md)）。单条查询 0–2ms，扫 95 页约 76ms。

评分刻意朴素：标题全等 120 / 标题含 60 / 别名含 50 / 标签含 25 / 正文词频 ×3（封顶 36）/ index 摘要只在其它通道全 0 时补 8。三处经验细节：摘要分只补漏不抢位、同分用码点序（拼音序不可复现）、选节排除清单类与元讨论类小节。

---

## 只读，且不往外发

- 插件只读你的笔记：不写库、不改页、不修红链。
- 检索在本地进程内跑，没有任何出站请求。
- `wiki_context` / `wiki_verify` 调的是**你自己机器上的** Python 管线（`bridge.toolsRoot`），同样不出网。
- 仓库里不含任何本机绝对路径或用户名；测试用环境变量拿真实路径（`WIKI_ROOT` / `WIKI_TOOLS`），不给就跑样例库。
- 公开仓库里的样例、契约文档与测试查询词一律用虚构语料，不写任何人的笔记主题。旧发布物仍有遗留，见下一节。

---

## 发布物与残余风险

**1.4.3 起是干净版本。** 仓库内 `docs/`（整目录进 `files`）、`examples/`、`tests/` 里的演示样例已全部换成虚构的「星港缓存」技术语料：没有真实引文、真实页面路径、外链、本机用户名、私有路径或凭据。发版前会解包 `npm pack` 的产物逐文件扫一遍，命中即视为发布失败。`wiki-notes.config.json` 是本机文件，`.gitignore` 覆盖，从未提交。

**1.4.2 及更早的公开传播源已经发出去了，收不回来：**

| 来源 | 情况 | 处置 |
| --- | --- | --- |
| npm `1.4.0` / `1.4.1` / `1.4.2` | 包内 `docs/契约-stage0/samples/` 与几份阶段文档含少量早期演示用的笔记引文、页面标题和一个外部链接；**不含**凭据、用户名、本机路径，也不是运行时采集的数据 | npm 不允许覆盖已发布版本 ⇒ 只把这三个版本标记 `deprecated`，提示升级到 `>=1.4.3`（更早的干净版本不误伤） |
| GitHub Release `v1.4.0` / `v1.4.1` / `v1.4.2` 的 tarball | 与对应 npm 包同源 | 不删 Release 记录，只删带内容的 tarball 资产；取包用 `v1.4.3` 或 `releases/latest/download/dsh-wiki-notes.tgz` |
| Git 历史 `36cfe85` 与标签 `v1.4.0`–`v1.4.2` 自动生成的源码归档 | `36cfe85` 曾写进本机绝对路径与用户名，`f82b125` 已在首个 1.4.0 npm 包发布**之前**清掉；但历史对象与标签归档仍在 | 不重写历史：改 tag SHA 会断掉已发 npm 包与 Release 的提交关联。在意的话请自行 fork 后清理 |

一句话结论：**升级到 `1.4.3+` 即可**；旧版本里那部分内容不会自行消失，别把旧包当「干净语料」再分发。这里只做事实登记，不假装把它们删干净了。

---

## 上下游（可选）

- **进料**：[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) —— 网页剪藏成 Markdown 落进 raw 层。模板里写好 `类型` / `来源数量` / `标签`，本插件的 `kind`、`sources`、证据强度才有东西可用。
- **维护**：[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) —— 六个 `SKILL.md`，教 agent 写 Obsidian 语法（wikilink / `.base` / `.canvas` / CLI），少猜少往返。

---

## 已知局限

- 中文不分词，靠空格切分；连写词靠 `别名` 补。
- 页名本身是查询词时，正文很少重复该词，选节可能偏。
- 每次调用全量扫描；70–100 页无所谓，再大一个数量级要上增量索引。
- **重启后第一次扫描是冷盘读**：95 页实测 5,217ms（此后 29ms）。插件启动就预热一次，所以这段延迟通常落在你还没提问的时候；但第一条查询正好赶上也确实要等。
- **面板没打开时 `/`、`Ctrl/⌘ + K` 不会有反应**：快捷键绑在面板上，而宿主的 `sidebarRightTabs` 只提供 `register()`，没有「打开 / 激活页签」的接口，插件没法从外面把面板叫出来。
- **知识网关那套仍是两套实现**：JS 侧 `wiki_recall` 和 Python 侧 `wiki_context` 各自解析页面，差在结构解读层。统一方向未定。
- **`unverifiable` 只在 `notices` 里**：模型若只看 `violations`，会漏掉「这个数字我核实不了」。
- **观察日志无轮转**：只追加不清理，`legacy` 计数会随时间变大。
- **快照不自动清理**，也没有滑动续期。

---

## 目录 / 开发

```
lib/corpus.js   扫描 + frontmatter / 小节 / 双链解析
lib/engine.js   评分、选节、七种模式（纯函数）
lib/config.js   库路径解析与配置读写
lib/index.js    插件入口：工具、渲染、设置页 API、目录监听
lib/client.js   设置页 + 检索面板 + 右侧栏页签（手写 bundle，无构建）
bin/cli.mjs     命令行，不装插件也能跑
tools/probe.mjs 检索质量探针：hit@1 / hit@3 / Recall@5，追加趋势 CSV
tools/preview.mjs 把面板渲染成静态页（真组件 + 真 CSS），改样式不必重启 DSH
docs/库结构.md  库结构约定（这份才是一手文档）
docs/README.md  文档导航页
docs/superpowers/specs/  检索面板的设计稿
docs/契约-stage0/  知识网关的设计与验收记录
examples/       可跑的最小样例库
tests/          smoke / status / lint / explain / api / help / contract / watch / client bundle / gateway
```

```bash
npm test                                           # 跑样例库，不需要本地知识库
node bin/cli.mjs search 上下文 --root=examples/sample-wiki
WIKI_ROOT="/path/your/wiki" node tests/smoke.mjs   # 拿自己的库跑通就行（不校验答案）
npm run probe -- --root "/path/your/wiki"          # 攒一行检索质量趋势
node tools/preview.mjs                             # 出 preview/panel.html，浏览器直接看面板
node tools/preview.mjs --diag                      # 同上，并量一遍宽度 / 截断 / 溢出 / 对比度
```

跑知识网关那两段真实通路，要给两个环境变量（不给就整段跳过，不会假装通过）：

```bash
WIKI_ROOT="/path/your/知识层-wiki" WIKI_TOOLS="/path/your/工具-tools" node tests/gateway.mjs
```

发版：改 `version` → `npm test` 全绿（`scripts.test` 只调 `node tests/*.mjs`，所以 20.x 也能跑；`node --run test` 要 Node 22+，别在低版本上用它，也别拿它当门槛的证明）→ `npm pack --dry-run` 看一眼打包内容（`files` 只含 `lib`/`bin`/`docs`/`examples`/`README.md`/`LICENSE`/`cordis.patch.yml`，`preview/` 与 `tools/` 不进包）→ `npm publish`。发布前先 `npm whoami --registry=https://registry.npmjs.org/` 确认已登录（本机 token 在 `.npmrc` 的 `//registry.npmjs.org/:_authToken=`；注意 `npm config get registry` 指向 npmmirror，而 npmmirror 那边不认这个 token，登录状态要显式指定 registry 去查）。

改样式的两条经验：

- `.wn-hit-row` 那道 span 不能省。`<summary>` 自带 display 规则，某些浏览器会把 `display:flex` 顶掉，行就塌成内容宽度、分数贴在标题右边 —— 所以行布局放在 summary 里那层 span 上，`tests/client.mjs` 守着它。
- 小字别用 `--wn-faint`（这组 token 在浅色底上约 3.4:1，低于 WCAG AA 的 4.5），小字一律 `--wn-muted`（约 5:1），层级靠字号和字重拉开，不靠把字调淡。
- `--diag` 遍历样式表时，别用「有 `cssRules` 就往下钻」的写法：现代 Chrome 的 `CSSStyleRule` 自己也带一个空的 `cssRules`（CSS 嵌套），会把你正要找的那条规则跳过，于是明明 `display=flex` 却报「NOT FOUND」。先判 `rule.cssRules.length`。

## License

MIT
