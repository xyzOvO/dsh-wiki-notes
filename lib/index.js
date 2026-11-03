/**
 * index.js —— dsh-wiki-notes 的宿主半：注册一个只读工具 wiki_recall。
 *
 * 为什么只有一个工具：profile 里已经装了 26 个插件，模型每回合都要在工具表里选，
 * 多一个工具就是多一份选择成本。四种查询压在同一个工具里用 mode 区分。
 *
 * 为什么用 node:fs 而不是 ctx.fs：库在 D:\笔记（会话工作区之外），抽象 fs 会先被
 * 沙箱策略拦一道；这里只需要「读一个用户明确授权的目录」，用 node:fs 更直接，
 * 而且这一步只在扫描时发生，不涉及任何写操作。
 *
 * 只读承诺：除了插件目录旁那一个 wiki-notes.config.json（设置页保存库路径用），
 * 这里不写任何文件，更不写知识库本体。
 */

import path from 'node:path'
import { statSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { asList, loadCorpus } from './corpus.js'
import { mergePromptConfig, mergeTopicConfig, normalizeTopicConfig, readTopicConfig, writeTopicConfig } from './config.js'
import { run } from './engine.js'
import { configPath, DEFAULT_WIKI_ROOT, NOT_CONFIGURED_HINT, readConfigFile, normalizePromptConfig, readPromptConfig, resolveWikiRootInfo, writeConfigFile, writePromptConfig } from './config.js'

export const name = 'wiki-notes'

/** 工具是主职；webServer 只给设置页用，缺了也还能检索（只是设置页读不到状态）。 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** 库扫描结果缓存时长：扫描 70 页约 40ms，但同一回合常连着问好几遍。 */
const CACHE_TTL_MS = 30_000

/** 设置页的同源 API 前缀（浏览器半侧 lib/client.js 里写的是同一个值）。 */
const API_PREFIX = '/api/wiki-notes'

/**
 * 工具泛词：它们能出现在任何一页上，对「这个库在研究什么」没有信息量。
 * 命中就跳过，不进主题词候选（打标签不受影响，检索打分照旧用它们）。
 */
const TOPIC_STOPWORDS = new Set([
  'meta', 'data', 'tool', 'tools', 'note', 'notes', 'todo', 'other',
  '数据', '工具', '人物', '政策', '方法', '理论', '笔记', '总结', '其他', '杂项',
  '待整理', '待补充', '通用', '综合', '知识', '资料', '内容',
])

/** 结构页：总览类页面不参与主题词统计。 */
const STRUCTURAL_PAGE_NAMES = new Set(['overview', '总览', '总览-overview', 'index', 'log'])
function isStructuralPage(page) {
  if (STRUCTURAL_PAGE_NAMES.has(page.name)) return true
  return String(page.fields['类型'] ?? '') === '总览'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 请求体很小（一个路径字符串），限量读，别让谁塞一个大 body 进来。
 *
 * 三种返回：空 body → null；合法 JSON → 解析结果；非法 JSON → undefined。
 * 原来把「解析失败」也归成 null，POST 接口拿不到字段就一路按默认值写盘，
 * 等于一次手滑的请求把用户配好的东西清空，还回 200。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve(null)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', reject)
  })
}

const PARAMETERS = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['search', 'page', 'list', 'overview', 'lint', 'draft'],
      description: 'search=关键词检索（默认）；page=按页名取整页；list=按类型/标签列目录；overview=库总览与健康状态；lint=全库健康检查（孤儿页/断链/缺字段/别名冲突/久未更新）；draft=生成「把好答案回写成新页」的落盘骨架（不写文件）',
    },
    query: {
      type: 'string',
      description: 'mode=search 时的检索词：1-4 个核心名词，空格分隔即 AND。不要传整句问话——先自己把问话拆成名词（「什么是向量检索」应传「向量检索」）。',
    },
    name: {
      type: 'string',
      description: 'mode=page 时的页面名，例如「上下文工程」。没精确命中会返回候选。',
    },
    type: {
      type: 'string',
      description: '按页面类型筛：概念 / 实体 / 对比 / 综合 / 资料',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '按标签筛，任一命中即算；例如 ["AI","方法"]',
    },
    status: {
      type: 'string',
      description: '按状态筛：草稿 / 演进中 / 已提纯',
    },
    limit: {
      type: 'number',
      description: 'search 返回几页，默认 5，最多 12；lint 时表示每组列几条，默认 8。',
    },
    staleDays: {
      type: 'number',
      description: 'mode=lint 时判定「久未更新」的天数，默认 120。',
    },
    title: {
      type: 'string',
      description: 'mode=draft 时新页的名字（不含 .md），例如「上下文预算怎么算」。',
    },
    sources: {
      type: 'number',
      description: 'mode=draft 时写进 frontmatter 的「来源数量」，默认 0。',
    },
    summary: {
      type: 'string',
      description: 'mode=draft 时的一句话摘要，会同时写进正文引言与 index.md 那一行。',
    },
    sectionChars: {
      type: 'number',
      description: 'search 时每页返回的正文上限字符数，默认 900（约 600 token）。答案需要完整段落时调到 1500-2000。',
    },
    pageChars: {
      type: 'number',
      description: 'page 的正文上限字符数，默认 6000；overview 引用总览正文时默认 4000。',
    },
    logLimit: {
      type: 'number',
      description: 'mode=overview 时列最近几条日志，默认 5，最多 20。',
    },
  },
  required: ['mode'],
}

const DESCRIPTION = `本地 LLM-Wiki 知识库检索（只读，不会改动任何文件）。

何时必须调用（命中任一）：
- 问题涉及库内已知线索：页名、别名、标签，或系统提示里注入的主题词；
- 问个人记录（「我之前怎么记的」「笔记里写了什么」）；
- 涉及你笔记库里长期整理、反复出现的学科或领域（注入的主题词就是从高频标签取的）；
- 点名具体工具、框架、模型、项目、论文；
- 要求引用、转述、核对笔记原文。

何时可以不查：纯通用常识，且根据库索引线索能确认没有对应内容（如「水」「三角形」）。
只是没看到线索，不等于库里没有；拿不准先查，别靠自信跳过。

mode 用法：
- search（默认）：传 1-4 个关键词，空格分隔做 AND。返回每页的元数据 + index.md 一句话摘要 + **命中小节完整正文** + citation。通常一次调用就够作答，不用再去读文件。
- page：传页名取整页。没精确命中会返回 5 个候选，挑一个再查。
- list：按 type / tags / status 列目录，比读 index.md 更省 token。
- overview：总览正文 + 规模行 + 最近 5 条日志 + 断链统计。
- lint：全库健康检查（只读）——孤儿页、断链名字、缺 frontmatter 字段、别名冲突、久未更新、无出链、草稿、index.md 与磁盘不一致。用户在整理/维护笔记、或问「库里有什么问题」时用。
- draft：把本次的好答案回写成新页时，先要一份落盘骨架（目录、frontmatter 七字段、index.md 那一行、log.md 那一条）。本工具只返回文本，写文件要用你自己的写文件工具。

怎么读结果：
- kind=note 是消化过的笔记（最可信）；raw-summary 是原始资料的压缩稿；source 是资料页。
- sources 是「来源数量」，判断证据强度用：1 份和 12 份不是一回事。
- status=草稿 的页可能只是骨架。
- brokenLinks 非空 = 这一节引用了库里不存在的页（红链），说明该处判断缺少页级支撑，转述时要标明。
- 一条都没命中不代表话题不存在，换同义词（中文/英文/缩写）或先用 list 看目录再搜。`

/** 知识层的候选目录名：路径指到上一层时，自动下钻到这些名字。 */
const DRILL_DIRS = ['知识层-wiki', '知识层', 'wiki', 'Wiki']

/**
 * 库路径指错层时的自动纠正。
 *
 * 判据是 index.md：karpathy 原文的架构里，知识层是「LLM 拥有的 markdown 目录」，
 * 它自己带 index.md；而 LLM-Wiki 根只有 AGENTS.md + 原始资料-raw + 这个知识层目录。
 * 所以「自己有 index.md」= 已经是知识层，不再往下找；否则看有没有带 index.md 的子目录。
 */
function drillTarget(dir) {
  const hasIndex = (target) => {
    try {
      return statSync(path.join(target, 'index.md')).isFile()
    } catch {
      return false
    }
  }
  if (hasIndex(dir)) return ''
  for (const name of DRILL_DIRS) {
    const candidate = path.join(dir, name)
    if (hasIndex(candidate)) return candidate
  }
  return ''
}

export function apply(ctx, config = {}) {
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const inlineRoot = typeof config?.root === 'string' ? config.root : ''

  /** 当前生效的库路径。设置页保存后原地换掉，不用重启插件。 */
  let rootInfo = resolveWikiRootInfo(pluginRoot, inlineRoot)
  let root = rootInfo.root
  /** 提示词那一行：可关、可整段替换、可在末尾追加。存配置文件，改完立即生效。 */
  let promptCfg = normalizePromptConfig(config?.prompt) ?? readPromptConfig(pluginRoot)
  let topicCfg = normalizeTopicConfig(config?.topics) ?? readTopicConfig(pluginRoot)

  let cache = null
  let cachedAt = 0
  let inflight = null
  /** 每次作废 +1。扫描结束时对比它，才知道「这份结果是不是已经被作废了」。 */
  let generation = 0

  /** 换库 / 重扫时把缓存一起作废，否则设置页说「已切换」，模型那边还在看旧库。 */
  function invalidate() {
    cache = null
    cachedAt = 0
    inflight = null
    generation += 1
  }

  /* ---------------------- 目录监听：库是活的 ---------------------- */
  // 有 30 秒缓存兜底就够了，但「刚改完笔记，模型还在念旧版本」很容易让人以为插件坏了。
  // 监听只做一件事：发现 .md 变了就作废缓存，下次查询重扫（70 页约 40ms，重扫不心疼）。

  let watcher = null
  let watchTimer = null
  /** 'on' 实时同步生效；'off' 退回 30 秒缓存。设置页要显示这个 —— 否则实时同步悄悄失效了没人知道。 */
  let watchState = 'off'

  function stopWatch() {
    watchState = 'off'
    if (watchTimer !== null) {
      clearTimeout(watchTimer)
      watchTimer = null
    }
    if (watcher !== null) {
      try {
        watcher.close()
      } catch {
        // 关不掉就算了，进程退出时会一起没
      }
      watcher = null
    }
  }

  function startWatch() {
    stopWatch()
    // 还没配置库路径时没什么可监听的，等用户在设置页存了再说
    if (root === '') return
    // 监听的必须是真正在读的那一层：路径指错层时 getCorpus 会下钻，监听上层等于永远收不到事件
    const watchRoot = drillTarget(root) || root
    let handle
    try {
      handle = watch(watchRoot, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '')
        // 只认笔记：编辑器保存时会带出 .swp/.tmp/xxx.md~ 之类的临时文件，别为它们重扫整库
        if (name !== '' && !/\.md$/i.test(name)) return
        if (/[~#]$|\.(swp|tmp|bak)$/i.test(name)) return
        // 一次保存常常触发多个事件，攒 400ms 再作废
        if (watchTimer !== null) clearTimeout(watchTimer)
        watchTimer = setTimeout(() => {
          watchTimer = null
          invalidate()
        }, 400)
      })
    } catch (error) {
      ctx.logger?.warn?.(`LLM-Wiki 检索：监听不了 ${root}（${String(error?.message ?? error)}），退回 30 秒缓存`)
      return
    }
    handle.on?.('error', () => {
      // 被监听目录消失（比如换了 D 盘盘符）时不炸，让缓存策略继续兜底
      stopWatch()
    })
    // 别让监听句柄把进程钉住：CLI 与测试脚本跑完要能正常退出，DSH 进程本身就常驻。
    handle.unref?.()
    watcher = handle
    watchState = 'on'
  }

  startWatch()


  /** 库路径指错层时的自动纠正（详见 drillTarget）。 */
  let scannedRoot = ''

  /* --------- 主题词：让模型自己判断「这问题该不该查库」 --------- */
  // 工具描述里写「任何主题」等于没有触发条件。这里从库里现有标签算出主题，
  // 注入一行（约 60 token），换库自动变 —— 不用把某一批领域词写死进公开仓库。

  let topicLine = ''
  /** 设置页要显示的那份（主题词 + 出现次数），与 topicLine 同源。 */
  let topicTags = []
  /** 阈值这次没生效（所有标签都低于阈值）时为 true，设置页据此提示。 */
  let topicFilterFallback = false

  /**
   * 主题词：从标签频次算「这个库在研究什么」，注入给模型当触发器。
   *
   * 三道过滤，都是为了「代表性」而不是「覆盖全部」：
   *   1. 结构页（总览/overview）不参与 —— 它们的 meta 之类标签没有主题含义
   *   2. 只留出现 ≥ minCount 次的标签 —— 一次性专有名词进不了前五
   *   3. 跳过工具泛词 —— 「数据」「工具」这种哪篇都能打，进前五等于噪音
   * 全部被滤掉时退回未过滤的前五（小库不至于一条提示都没有）。
   */
  function refreshTopics(corpus) {
    // 按小写归并：`RAG` 和 `rag` 是同一个主题，分开数会让两边都掉到阈值以下。
    // 展示时用出现次数最多的那种写法（一样多就取码点靠前的），保证稳定的可读形式。
    const counts = new Map()
    for (const page of corpus.pages) {
      if (isStructuralPage(page)) continue
      for (const tag of asList(page.fields['标签'])) {
        const form = tag.trim()
        if (form === '') continue
        const key = form.toLowerCase()
        if (topicCfg.stopwords && TOPIC_STOPWORDS.has(key)) continue
        let entry = counts.get(key)
        if (entry === undefined) {
          entry = { key, count: 0, forms: new Map() }
          counts.set(key, entry)
        }
        entry.count += 1
        entry.forms.set(form, (entry.forms.get(form) ?? 0) + 1)
      }
    }
    const label = (entry) => {
      let best = entry.key
      let bestCount = -1
      for (const [form, n] of entry.forms) {
        if (n > bestCount || (n === bestCount && form < best)) {
          best = form
          bestCount = n
        }
      }
      return best
    }
    const ranked = [...counts.values()]
      .map((entry) => ({ tag: label(entry), count: entry.count, key: entry.key }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    const kept = ranked.filter((item) => item.count >= topicCfg.minCount)
    // 保底：过滤太狠（比如整个库只有一两页）就退回不过滤，别让模型完全失去线索。
    // 这时阈值其实没生效，要如实告诉设置页，别让人以为勾选框失灵了。
    topicFilterFallback = kept.length === 0 && ranked.length > 0
    const pool = kept.length > 0 ? kept : ranked
    const top = pool.slice(0, 5).map((item) => item.tag)
    topicTags = pool.slice(0, 8).map((item) => ({ tag: item.tag, count: item.count }))
    // 不写页数：它对「该不该查库」这个判断没有贡献，页数一变还会打掉 systemPrompt 的前缀缓存。
    // 触发靠的是主题词那半句，页数只给人看 —— 给人看的地方是设置页，不是这里。
    topicLine = top.length === 0
      ? ''
      : `本地知识库主题：${top.join('、')}。问题沾这些主题、或要引用笔记原文时，先调用 wiki_recall 查库再作答。`
  }

  /** 最终注入的那段文本：关掉 → 空；有 override → 用它；否则用自动算的主题词；最后追加 extra。 */
  function buildTopicText() {
    if (promptCfg.enabled !== true) return ''
    const body = promptCfg.override !== '' ? promptCfg.override : topicLine
    if (body === '') return promptCfg.extra
    return promptCfg.extra === '' ? body : `${body}\n${promptCfg.extra}`
  }

  async function getCorpus() {
    // 没配库路径就直接说清楚。别让它扫出一个空库 —— 模型会把「0 页」当成
    // 「你笔记里没有这条」，然后自信地给你编答案。
    if (root === '') throw new Error(NOT_CONFIGURED_HINT)
    const now = Date.now()
    if (cache !== null && now - cachedAt < CACHE_TTL_MS) return cache
    if (inflight !== null) return inflight
    const gen = generation
    const task = (async () => {
      // 用户很容易把路径指到 LLM-Wiki 根（那里有 AGENTS.md、raw 与模板），
      // 扫出来数字虚高、还混进不该读的原始资料。这里自动下钻到真正的知识层。
      const drilled = drillTarget(root)
      const target = drilled === '' ? root : drilled
      const corpus = await loadCorpus(target)
      if (target !== root) corpus.drilledFrom = root
      scannedRoot = target
      // 扫描期间被 invalidate 过（换库 / 重扫 / 文件变动）：这份结果对应的是旧状态，
      // 直接交给本次调用方，但绝不回写缓存 —— 否则「刚点过重新扫描」之后，
      // 30 秒内所有查询都会读到作废前的旧快照。
      if (gen !== generation) return corpus
      refreshTopics(corpus)
      cache = corpus
      cachedAt = Date.now()
      return corpus
    })()
    inflight = task
    // 只清自己那一份：慢扫描结束时，inflight 可能已经是后来那次扫描了。
    task.then(
      () => { if (inflight === task) inflight = null },
      () => { if (inflight === task) inflight = null },
    )
    return task
  }

  // 启动时探一次库：路径写错的话，日志里会立刻出现，而不是等模型调用时才失败。
  getCorpus()
    .then((corpus) => {
      ctx.logger?.info?.(
        `LLM-Wiki 检索就绪：${corpus.stats.pages} 页 / ${corpus.stats.resources} 份资料 / ${corpus.stats.brokenPages} 页存在红链（${root}）`,
      )
    })
    .catch((error) => {
      ctx.logger?.warn?.(`LLM-Wiki 检索：打不开知识库 ${root} —— ${String(error && error.message || error)}`)
    })

  /* --------------------------- 设置页 API --------------------------- */
  // 与浏览器半侧只走同源 HTTP：不碰 RPC，就没有「connection 服务缺失」这类降级分支。

  function statsOf(corpus) {
    const stats = corpus?.stats ?? {}
    return {
      pages: stats.pages ?? 0,
      resources: stats.resources ?? 0,
      brokenPages: stats.brokenPages ?? 0,
      brokenTotal: stats.brokenTotal ?? 0,
      scannedMs: stats.scannedMs ?? 0,
    }
  }

  function baseState() {
    return {
      root,
      source: rootInfo.source,
      sourceLabel: rootInfo.label,
      defaultRoot: DEFAULT_WIKI_ROOT,
      envRoot: typeof process.env.DSH_WIKI_ROOT === 'string' ? process.env.DSH_WIKI_ROOT : '',
      configFile: configPath(pluginRoot),
      savedRoot: readConfigFile(pluginRoot),
      // 与 root 不同时说明路径指错层、被自动下钻了 —— 设置页要能显示这一点
      scannedRoot,
      watch: watchState,
      topics: topicTags,
      prompt: promptCfg,
      // fallback = 阈值这次没生效（所有标签都低于阈值，退回不过滤），设置页要提示
      topicFilter: { ...topicCfg, fallback: topicFilterFallback },
      topicPreview: buildTopicText(),
    }
  }

  async function buildState() {
    try {
      const corpus = await getCorpus()
      return { ...baseState(), ok: true, stats: statsOf(corpus), scale: corpus.scaleLine ?? '' }
    } catch (error) {
      return { ...baseState(), ok: false, error: String(error?.message ?? error) }
    }
  }

  /** 试扫一个候选路径但不改配置：让用户在按「保存」之前就知道这条路通不通。 */
  async function probeRoot(candidate) {
    const started = Date.now()
    const target = String(candidate ?? '').trim() || root
    if (target === '') return { ok: false, root: '', ms: Date.now() - started, error: NOT_CONFIGURED_HINT }
    try {
      const corpus = await loadCorpus(target)
      const stats = statsOf(corpus)
      if (stats.pages === 0) {
        return { ok: false, root: target, ms: Date.now() - started, error: '这个目录里没有任何页面（可能是路径写错了，或指到了上一层的 LLM-Wiki 根）' }
      }
      // 指到上一层时也能扫出东西（把 raw 与模板一起数进来），但数字会失真：给个明确提示。
      let hint = ''
      try {
        if (path.basename(target) !== '知识层-wiki' && statSync(path.join(target, '知识层-wiki')).isDirectory()) {
          hint = `这个目录下面还有「知识层-wiki」，那才是知识库本体（这里扫到的是 ${stats.pages} 页，含原始资料与模板）`
        }
      } catch {
        // 没有子目录就算了，不是错误
      }
      return { ok: true, root: target, ms: Date.now() - started, stats, scale: corpus.scaleLine ?? '', hint }
    } catch (error) {
      return { ok: false, root: target, ms: Date.now() - started, error: String(error?.message ?? error) }
    }
  }

  // 路由是「组合级契约」：同名前缀第二次注册会抛 duplicate。所以必须自己保存 disposer，
  // 卸载时释放 —— 否则热重载一次（关掉再打开插件）就会永久占着这个前缀。
  let disposeApi = null
  try {
    disposeApi = ctx.webServer?.register?.({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          return sendJson(res, 200, await buildState())
        }
        if (route === '/check' && req.method === 'POST') {
          const body = await readBody(req)
          return sendJson(res, 200, await probeRoot(body?.root))
        }
        if (route === '/save' && req.method === 'POST') {
          const body = await readBody(req)
          // 和 /topics、/prompt 一样：坏 JSON 直接拒。少了这条，半截请求体会落进
          // 「root 是空串」的分支，把用户配好的库路径从配置文件里删掉还回 200。
          if (body === undefined) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
          // 缺字段同样拒。「清掉配置」必须显式传空字符串 —— 那是设置页灰按钮的意图，
          // 而「没带 root」只说明调用方写错了，不能当成同一个意思。
          if (typeof body?.root !== 'string') {
            return sendJson(res, 400, { error: '缺少 root 字段（要清空配置请显式传空字符串）' })
          }
          const typed = body.root.trim()
          // 统一存成绝对路径（用户可能写成正斜杠或相对路径），空串 = 清配置回到上一层
          const next = typed === '' ? '' : path.resolve(typed)
          // 先试扫再落盘：打错一个字符就把坏路径写进配置文件，等于让整个插件查不到库，
          // 用户还得再存一次才能救回来。扫不出页面就拒绝保存，配置保持原样。
          if (next !== '') {
            const probe = await probeRoot(next)
            if (probe.ok !== true) {
              return sendJson(res, 200, { ok: false, saved: false, error: probe.error || '这个路径扫不出页面' })
            }
          }
          writeConfigFile(pluginRoot, next)
          rootInfo = resolveWikiRootInfo(pluginRoot, inlineRoot)
          root = rootInfo.root
          invalidate()
          startWatch()
          return sendJson(res, 200, await buildState())
        }
        if (route === '/topics' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === undefined) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
          topicCfg = writeTopicConfig(pluginRoot, mergeTopicConfig(topicCfg, body)).config
          invalidate()
          sendJson(res, 200, await buildState())
          return
        }
        if (route === '/prompt' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === undefined) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
          // 局部合并：没带的字段保持原值，只改提到的那几项
          promptCfg = writePromptConfig(pluginRoot, mergePromptConfig(promptCfg, body)).config
          // 不用 invalidate()：提示词和语料无关，下一回合读 text() 就是新值
          return sendJson(res, 200, await buildState())
        }
        if (route === '/rescan' && req.method === 'POST') {
          invalidate()
          return sendJson(res, 200, await buildState())
        }
        return sendJson(res, 404, { error: `未知路由 ${route}` })
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      },
    })
  } catch (error) {
    const message = String(error?.message ?? error)
    // 幂等保护：loader 重放装配时同名 route 会撞 duplicate，跳过 API 而不是让整个插件不激活。
    if (!message.includes('duplicate')) throw error
    ctx.logger?.warn?.(`[wiki-notes] ${API_PREFIX} 已被注册过，跳过重复注册`)
  }

  // 主题词注入：一行、同步、读完即用。库没配好时返回空串，不占上下文。
  try {
    ctx.systemPrompt?.context?.({
      name: 'wiki-notes:topics',
      order: 240,
      text: () => buildTopicText(),
    })
  } catch (error) {
    ctx.logger?.warn?.(`[wiki-notes] 主题提示注册失败：${String(error?.message ?? error)}`)
  }

  const register = () => ctx.tools.register({
    name: 'wiki_recall',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: renderValue(args, value) }],
    },
    async execute(args) {
      const started = Date.now()
      try {
        const corpus = await getCorpus()
        const result = run(corpus, args ?? {})
        if (result !== null && typeof result === 'object') {
          result.scanned = corpus.stats.pages
          result.root = root
          if (typeof corpus.drilledFrom === 'string') result.drilledFrom = corpus.drilledFrom
          result.ms = Date.now() - started
        }
        return result ?? { mode: 'error', error: '查询没有返回结果（mode 可能传错了）' }
      } catch (error) {
        // 工具层不往上抛：把「库读不出来」变成一条模型看得懂、能转告用户的错误，
        // 而不是一次工具调用失败。库里 0 页和库里没有这个词，是两回事。
        // 这里只剩两类：没配路径（用户该去设置页），以及真正的程序异常（该转告）。
        // 文件系统层面的「能扫但不全」已经在 corpus.stats 里记过，不会走到这儿。
        return {
          mode: 'error',
          status: root === '' ? 'unconfigured' : 'error',
          error: String((error && error.message) || error),
        }
      }
    },
  })

  let dispose
  try {
    dispose = register()
  } catch (error) {
    ctx.logger?.warn?.(`LLM-Wiki 检索：注册工具失败 —— ${String(error && error.message || error)}`)
    stopWatch()
    return
  }

  ctx.on?.('dispose', () => {
    stopWatch()
    try {
      disposeApi?.()
    } catch {
      // 卸载时失败无所谓
    }
    try {
      dispose?.()
    } catch {
      // 同上
    }
  })
}

/* ------------------------------- 渲染 ------------------------------- */

function renderValue(args, value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (typeof value.error === 'string') {
    // 三种「没查成」要说成三件事：参数写错了、库没配、程序出错。
    // 前两种都不该让模型怀疑「你笔记里没有这条」。
    if (value.status === 'invalid_input') {
      return `参数不对：${value.error}\n（这次没有读取知识库，改好参数再调一次。）`
    }
    if (value.status === 'unconfigured') return `知识库还没配置：${value.error}`
    return `查询失败：${value.error}`
  }
  let body
  switch (value.mode) {
    case 'search':
      body = renderSearch(value)
      break
    case 'page':
      body = renderPage(value)
      break
    case 'list':
      body = renderList(value)
      break
    case 'overview':
      body = renderOverview(value)
      break
    case 'lint':
      body = renderLint(value)
      break
    case 'draft':
      body = renderDraft(value)
      break
    default:
      body = JSON.stringify(value, null, 2)
  }
  // 路径指错层被自动纠正时，必须让模型知道它看的不是配置里那个目录
  // 顺手把连续空行压成一行：模型读的是这段文本，连着的空行纯属白付 token
  const tidy = body.replace(/\n{3,}/g, '\n\n')
  // 覆盖缺口放最前面：先说「你看到的不是全部」，再给结果。
  // 唯一例外是 search 扫到 0 页 —— 正文里已经把那句话讲清楚了，不必重复。
  const duplicated = value.status === 'unavailable' && value.mode === 'search'
  const warned = Array.isArray(value.warnings) && value.warnings.length > 0 && !duplicated
    ? `⚠ 本次结果有缺口：\n${value.warnings.map((line) => `· ${line}`).join('\n')}\n\n`
    : ''
  const withWarnings = `${warned}${tidy}`
  return value.drilledFrom
    ? `（库路径已自动下钻到知识层：${value.drilledFrom}）\n${withWarnings}`
    : withWarnings
}

/** lint 的渲染：按「该修的地方」分组，每组只说名字，不贴正文。 */
function renderLint(value) {
  const stats = value.stats || {}
  const counts = value.counts || {}
  const lines = [
    `库健康检查（只读）· ${stats.pages ?? 0} 页 · ${stats.resources ?? 0} 份资料 · 扫描 ${stats.scannedMs ?? 0} ms`,
  ]

  const block = (title, total, rows, format) => {
    if (!total) return
    lines.push('')
    lines.push(`${title}（${total}）`)
    for (const row of rows ?? []) lines.push('  · ' + format(row))
    if (total > (rows ?? []).length) lines.push(`  …还有 ${total - rows.length} 个`)
  }

  block('🕳 孤儿页 —— 没有任何页链到它', counts.orphans, value.orphans, (name) => name)
  block('🔗 断链 —— 被提到、但库里没有这页', counts.broken, value.brokenTargets, (row) => `${row.name} × ${row.pages} 页`)
  block('🧩 缺 frontmatter 字段', counts.missingFields, value.missingFields, (row) => `${row.name}：缺 ${row.missing.join('、')}`)
  block('🏷 别名冲突 —— 同一别名挂在多页，检索排序会漂', counts.aliasConflicts, value.aliasConflicts, (row) => `${row.alias} → ${row.pages.join(' / ')}`)
  block(`⏳ 久未更新（> ${value.staleDays} 天）`, counts.stale, value.stale, (row) => `${row.name}（${row.updated}，${row.days} 天前）`)
  block('🚪 无出链 —— 正文里没有任何 [[双链]]', counts.noLinks, value.noLinks, (name) => name)
  block('📝 草稿状态', counts.drafts, value.drafts, (name) => name)
  block('📇 index.md 登记了、磁盘上没有', counts.indexOnly, value.consistency?.indexOnly, (name) => name)
  block('📥 磁盘上有、index.md 没登记', counts.diskOnly, value.consistency?.diskOnly, (name) => name)
  block('📦 未读入的大文件（> 512KB，只记了名字）', counts.oversized, value.oversized, (name) => name)

  if (Object.values(counts).every((n) => !n)) lines.push('', '没有发现问题。')
  lines.push('', '（页面间矛盾、被新资料推翻的旧结论要读内容才能判断，不在这里报。）')
  return lines.join('\n')
}

/** draft 的渲染：要能整段复制去落盘，所以顺序是「未落盘声明 → 文件 → 内容 → 三件收尾」。 */
function renderDraft(value) {
  const out = []
  // 最重要的事实放第一行：模型会截断、摘要或转述，末尾的说明最先被省掉
  out.push('⚠ 以下内容仅为待审阅草稿，尚未写入任何文件。')
  out.push('')
  const warn = value.exists === null
    ? ''
    : `（⚠ 已有同名页 ${value.exists.file}，直接写会覆盖它 —— 换个名字，或确认就是要改那一页）`
  out.push(`回写骨架：${value.file}${warn}`)
  out.push('')
  out.push(value.frontmatter)
  out.push('')
  out.push(value.body)
  out.push('')
  out.push('落盘后还有三件事，少一件这页就等于没进库：')
  out.push(`1. index.md 里与其它「${value.type}」页同一节，加一行：`)
  out.push(`   ${value.indexLine}`)
  out.push('2. log.md 末尾追加一条：')
  out.push(`   ${value.logLine}`)
  out.push('3. 再跑一次 mode:"lint" 复查（这页还挂着红链会被报出来）')
  return out.join('\n')
}

const KIND_LABEL = { note: '笔记', 'raw-summary': '资料摘要', source: '资料页' }

function metaLine(hit) {
  const parts = []
  if (hit.type) parts.push(hit.type)
  if (hit.status) parts.push(hit.status)
  if (hit.sources !== null && hit.sources !== undefined) parts.push(`${hit.sources} 源`)
  if (hit.updated) parts.push(hit.updated)
  if (hit.kind && KIND_LABEL[hit.kind]) parts.push(KIND_LABEL[hit.kind])
  return parts.join(' · ')
}

/** 去掉正文开头与页名重复的 `# 页名`，省一行 token。 */
function stripLeadingH1(text, name) {
  // 正文常以空行开头（frontmatter 之后），先吃掉空行，首行才轮得到标题
  const value = String(text ?? '').replace(/^\s*\n+/, '')
  const lines = value.split('\n')
  if (lines.length === 0) return value
  const first = lines[0].trim()
  if (first === `# ${name}` || first === `# ${name.replace(/\.md$/, '')}`) {
    return lines.slice(1).join('\n').replace(/^\s*\n/, '')
  }
  return value
}

function renderSearch(value) {
  const out = []
  const tokens = Array.isArray(value.tokens) ? value.tokens.join(' + ') : ''
  const scanned = value.scanned ?? 0
  // 分母要摊开写：扫描了多少、过滤后真正参与打分的多少、命中多少、最后返回几条。
  // 只写「扫描 341 页，5 命中」会让人以为 341 页正文都比过了。
  const numbers = Number.isFinite(value.considered)
    ? `扫描 ${scanned} · 参与 ${value.considered} · 命中 ${value.matched ?? value.total}` +
      `${Number.isFinite(value.allTerms) ? `（全词 ${value.allTerms}）` : ''}· 返回 ${value.returned ?? 0}`
    : `扫描 ${scanned} 页，${value.total} 命中`
  out.push(`【检索】${tokens}　${numbers}`)
  // 降级说明已由 warnings 承载（degraded 时必有一条）；只有老调用方（结果里没有 status 字段）
  // 才需要这里的 note —— 否则同一句话模型会读两遍。
  if (value.note && value.status === undefined) out.push(`⚠️ ${value.note}`)

  const hits = Array.isArray(value.hits) ? value.hits : []
  if (hits.length === 0) {
    out.push('')
    if (scanned === 0) {
      // 扫到 0 页几乎一定是路径问题，别让模型得出「你笔记里没有这条」的结论
      out.push(`库路径可能不对：这次扫描到 0 个页面（${value.root ?? '路径未配置'}）。`)
      out.push('请确认「设置 → 知识库」指向的是放着 .md 笔记的目录，而不是它的上级。')
    } else {
      const gap = Number.isFinite(value.oversizedRelevant) && value.oversizedRelevant > 0
        ? `，另有 ${value.oversizedRelevant} 个超大页只比了标题与 index 摘要`
        : ''
      // no_match 只说「当前可检索范围未命中」，不说「全库没有」——
      // 超大页的正文从来没读过，标题和摘要不沾边也推不出正文不沾边。
      out.push(`当前可检索范围内没有命中：已比对 ${value.considered ?? scanned} 页的内容${gap}。`)
      out.push('这只说明参与比对的页面里没有，不能反推全库没有。')
      out.push('换同义词（中文/英文/缩写）再试，或用 mode:"list" 看有哪些页。')
    }
    return out.join('\n')
  }

  hits.forEach((hit, index) => {
    out.push('')
    out.push(`${index + 1}. ${hit.name}　⟨${metaLine(hit)}⟩　${hit.score} 分`)
    if (hit.summary) out.push(`   摘要：${hit.summary}`)
    else if (hit.gist) out.push(`   要点：${hit.gist}`)
    if (hit.section && hit.section.text) {
      const body = stripLeadingH1(hit.section.text, hit.name)
      if (hit.section.title) out.push(`　§${hit.section.title}`)
      out.push(body)
    }
    if (Array.isArray(hit.brokenLinks) && hit.brokenLinks.length > 0) {
      out.push(`   ⚠️ 红链：${hit.brokenLinks.slice(0, 6).join('、')}（库里没有这些页）`)
    }
    out.push(`   引用：${hit.citation}`)
  })
  return out.join('\n')
}

function renderPage(value) {
  const out = []
  if (value.found === null || value.found === undefined) {
    out.push(`没有精确命中「${value.wanted ?? ''}」。${value.note ?? ''}`)
    const candidates = Array.isArray(value.candidates) ? value.candidates : []
    if (candidates.length > 0) {
      out.push('')
      for (const item of candidates) {
        out.push(`- ${item.name}　⟨${item.type || '?'} · ${item.updated || '?'}⟩${item.summary ? `　${item.summary}` : ''}`)
      }
      out.push('')
      out.push('把上面某个名字当 name 再查一次。')
    }
    return out.join('\n')
  }
  const page = value.found
  out.push(`【${page.name}】⟨${metaLine(page)}⟩`)
  if (page.summary) out.push(`摘要：${page.summary}`)
  if (Array.isArray(page.aliases) && page.aliases.length > 0) out.push(`别名：${page.aliases.join(' / ')}`)
  if (Array.isArray(page.sections) && page.sections.length > 0) out.push(`小节：${page.sections.join(' / ')}`)
  out.push('')
  // 正文首尾的空行由 render 自己掌握：不然「正文 + 截断提示」之间会挤出两个空行
  out.push(stripLeadingH1(page.body, page.name).replace(/\s+$/, ''))
  if (page.truncated) out.push('', `…（正文已截断，全文 ${page.file}）`)
  out.push('', `引用：${page.citation}`)
  return out.join('\n')
}

function renderList(value) {
  const out = []
  const byType = value.byType && typeof value.byType === 'object'
    ? Object.entries(value.byType).map(([type, count]) => `${type} ${count}`).join(' / ')
    : ''
  out.push(`【目录】${value.total} 页${byType ? `　（${byType}）` : ''}`)
  if (value.scale) out.push(`规模：${value.scale}`)
  const rows = Array.isArray(value.rows) ? value.rows : []
  for (const row of rows) {
    const meta = [row.type, row.status, row.sources === null ? '' : `${row.sources} 源`, row.updated]
      .filter((part) => part !== '' && part !== null && part !== undefined)
      .join(' · ')
    out.push(`- ${row.name}　⟨${meta}⟩${row.summary ? `　${row.summary}` : ''}`)
  }
  if (value.truncated === true) {
    out.push(`…（只显示前 ${value.shown} 条，加 limit 或按 type/tags 收窄）`)
  }
  return out.join('\n')
}

function renderOverview(value) {
  const out = []
  out.push('【库总览】')
  if (value.scale) out.push(`规模：${value.scale}`)
  const stats = value.stats ?? {}
  const oversizedCount = Number(stats.oversized ?? 0)
  out.push(`扫描：${stats.pages ?? '?'} 页 / ${stats.resources ?? '?'} 份资料 / ${stats.brokenPages ?? 0} 页有红链（共 ${stats.brokenTotal ?? 0} 处）${oversizedCount > 0 ? ` / ${oversizedCount} 页超大未读正文` : ''}`)

  const consistency = value.consistency ?? {}
  if ((consistency.indexOnlyTotal ?? 0) > 0) {
    out.push(`⚠️ index.md 登记了但磁盘上没有：${consistency.indexOnly.join('、')}${consistency.indexOnlyTotal > consistency.indexOnly.length ? ` …共 ${consistency.indexOnlyTotal} 条` : ''}`)
  }
  if ((consistency.diskOnlyTotal ?? 0) > 0) {
    out.push(`⚠️ 磁盘上有但没进 index.md：${consistency.diskOnly.join('、')}${consistency.diskOnlyTotal > consistency.diskOnly.length ? ` …共 ${consistency.diskOnlyTotal} 条` : ''}`)
  }
  const dupNames = Array.isArray(stats.duplicateNames) ? stats.duplicateNames : []
  if (dupNames.length > 0) {
    out.push(`⚠️ 重名页（只保留最后一个，其余查不到）：${dupNames.slice(0, 6).map((item) => `${item.name}（${item.file}）`).join('、')}`)
  }

  if (value.overview !== null && value.overview !== undefined) {
    out.push('')
    out.push(`━━ ${value.overview.name} ━━`)
    out.push(stripLeadingH1(value.overview.body, value.overview.name).replace(/\s+$/, ''))
    out.push('', `引用：${value.overview.citation}`)
  }

  const log = Array.isArray(value.recentLog) ? value.recentLog : []
  if (log.length > 0) {
    out.push('')
    out.push('最近日志：')
    for (const entry of log) out.push(`- [${entry.date}] ${entry.type} | ${entry.title}`)
  }

  const broken = Array.isArray(value.broken) ? value.broken : []
  if (broken.length > 0) {
    out.push('')
    out.push('红链（正文指向不存在的页）：')
    for (const item of broken) out.push(`- ${item.name} → ${item.missing.slice(0, 5).join('、')}`)
  }
  return out.join('\n')
}
