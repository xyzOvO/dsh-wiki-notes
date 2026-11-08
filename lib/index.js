/**
 * index.js —— dsh-wiki-notes 的宿主半：注册一个只读工具 wiki_recall。
 *
 * 为什么只有一个工具：profile 里已经装了 26 个插件，模型每回合都要在工具表里选，
 * 多一个工具就是多一份选择成本。四种查询压在同一个工具里用 mode 区分。
 *
 * 为什么用 node:fs 而不是 ctx.fs：库在笔记仓库（会话工作区之外），抽象 fs 会先被
 * 沙箱策略拦一道；这里只需要「读一个用户明确授权的目录」，用 node:fs 更直接，
 * 而且这一步只在扫描时发生，不涉及任何写操作。
 *
 * 只读承诺：知识库本体一个字节都不写。会写盘的只有插件目录旁这两个文件——
 * wiki-notes.config.json（设置页保存库路径与提示词配置）、lint-history.json
 * （lint 的上一轮问题键，只用来算「新增 / 已修」）。而且只在用户点了保存、
 * 或模型真的跑了 lint 时才写，检索路径全程不落盘。
 */

import path from 'node:path'
import { mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { asList, loadCorpus } from './corpus.js'
import { createCallLog } from './calls.js'
import { buildRequiredChecks, createGovernance } from './governance.js'
import { mergePromptConfig, mergeTopicConfig, normalizeTopicConfig, readBridgeConfig, readCallsConfig, readTopicConfig, writeCallsConfig, writeTopicConfig } from './config.js'
import { MODES, freshnessOf, lint, run } from './engine.js'
import { configPath, DEFAULT_WIKI_ROOT, NOT_CONFIGURED_HINT, readConfigFile, normalizePromptConfig, readPromptConfig, resolveWikiRootInfo, writeConfigFile, writePromptConfig } from './config.js'
import { errorEnvelope, isObserveResult, runBridge } from './bridge.js'

export const name = 'wiki-notes'

/** 工具是主职。Cordis 是严格注入：apply() 直接读到的每个 ctx.* 服务都必须在这里声明，漏一个就在激活期抛 without inject。 */
export const inject = ['tools', 'webServer', 'systemPrompt', 'sessions']

/** 库扫描结果缓存时长：扫描 70 页约 40ms，但同一回合常连着问好几遍。 */
const CACHE_TTL_MS = 30_000

/** 设置页的同源 API 前缀（浏览器半侧 lib/client.js 里写的是同一个值）。 */
const API_PREFIX = '/api/wiki-notes'

/** 面板里一次输入的查询长度上限：超过这个长度不是检索，是粘贴事故。 */
const MAX_QUERY_CHARS = 200

/** 面板显示几条：引擎自己封顶 12（那是给模型的 token 预算），面板取更小的默认值。 */
function clampLimit(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return 5
  return Math.min(Math.max(value, 1), 12)
}

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
    let tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        // 早先这里直接 destroy 连接：调用方拿到的是「连接被重置」，不知道是自己发大了。
        // 现在把超限记下来、后面的字节丢掉，读完再回 413 —— 错误得说清楚是哪一步错。
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(`请求体超过 ${limit} 字节上限`)
        error.code = 'BODY_TOO_LARGE'
        return reject(error)
      }
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

/**
 * 跨源写配置的闸。
 *
 * 本机服务没有鉴权，浏览器里的任何网页都能往 127.0.0.1 发 POST —— 一个恶意页面
 * 就能把库路径改走、把提示词换掉。拦的判据很窄：带 Origin 且 Origin 主机不是回环地址
 * 就拒。不带 Origin 的请求（curl、命令行、插件自己）照旧放行，那是本机程序不是网页。
 * 没有做 CSRF token：Setting 页是宿主的，改不动它的请求，先挡住最实的一层。
 */
function blockedOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  // 沙箱 iframe / file:// 页面发的是字符串 'null'。DSH 的设置页若被宿主放进
  // 不透传来源的 iframe，这里放行才不至于把用户自己的保存按钮挡掉 ——
  // 代价是不透明来源挡不住，但那类页面本来也拿不到响应，只能盲写。
  if (origin === 'null') return false
  try {
    const host = new URL(origin).hostname
    return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  } catch {
    return true
  }
}

const PARAMETERS = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      // 枚举只有一个来源：engine 的 MODES。新增 mode 时漏改这里，
      // 描述教会了模型、schema 却把它挡在门外 —— 那是最难查的一种错。
      enum: MODES,
      description: 'search=关键词检索（默认）；page=整页；list=目录；overview=总览；lint=健康检查；draft=落盘骨架；help=用法与状态说明',
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

/**
 * 四个工具各自的硬触发句。抽成常量，测试可以逐条核对：
 * 系统提示只能承载稳定规则，而工具 description 是静态字符串，
 * 「必须 / 不得 / 先…再…」这几条得真的落在模型看得见的描述里。
 */
const RECALL_TRIGGERS =
  '涉及本地知识、笔记原文或需要引用库内依据时，必须且只调用一次 wiki_recall；不得反复检索，不得在普通快速回答里自动转去 wiki_context / wiki_verify。'
const CONTEXT_TRIGGERS =
  '用户明确要求查看原文时，必须且仅按需调用一次 wiki_context；明确要求核验，或问题涉及高风险、后果重大的重要事实，或库内存在复杂冲突时，必须先调用 wiki_context 再进入深度核验；不得在普通快速回答里自动调用 wiki_context。'
const VERIFY_TRIGGERS =
  '只有进入深度核验模式，才必须用 wiki_verify 核验候选答案；不得因答案含数字、引文或未填槽位就在快速回答里自动核验，不得绕过 violations_found。'
const OBSERVE_TRIGGERS =
  '要查核验链有没有收敛、违规有没有被改正时，必须用 wiki_observe 看观察统计；不得用日志缺行反推结论。'

/**
 * L1 治理总纲：单独注册进 systemPrompt 的稳定文本。
 * 不含主题词、不含库内容，prompt.enabled / override 都碰不到它；
 * 每个拟议模型步骤重算 text 时拿到的都是同一段常量。
 */
const GOVERNANCE_TEXT = [
  '本地知识网关的双模式纪律（凡用到本地知识库就适用）：',
  '- 默认快速回答：命中库内已知线索、个人记录、长期整理的领域，或要求引用 / 转述 / 核对笔记原文时，先调用一次 wiki_recall 查库再作答；纯通用常识且回答不依赖本地知识库时可跳过检索，检索无结果不代表知识库不存在对应内容。',
  '- 快速回答只调用一次 wiki_recall，据检索结果直接作答；不得自动调用 wiki_context / wiki_verify，不反复检索、不自我验证。',
  '- 快速回答结尾加一句简短可信度提醒；status 非 ok、warnings 非空、零命中或正文被截断时须明说资料不足，不为回答而编造，也不偷偷启动多轮检索。',
  '- 深度核验按需启用：用户只想查看原文时，可仅按需调用一次 wiki_context；明确要求核验，或问题涉及高风险、后果重大的重要事实，或库内存在复杂冲突时，才先调用 wiki_context 取结构化证据，再用 wiki_verify 核验候选答案；普通数字题、概念题不升级。',
  '- 深度核验发现违规时定向修正答案，不得绕过 violations_found；最多再核验一次，复核仍有违规即停止并披露，不得无限循环、不能悄悄收尾。',
  '- 多页 / 多来源时须披露证据边界与来源独立性；不承诺核验一般性跨页推导。数字或引文本身不触发强制核验，只有进入深度模式才核验。',
].join('\n')

const DESCRIPTION = `本地 LLM-Wiki 知识库检索（只读，不会改动任何文件）。

何时必须调用（命中任一）：
- 涉及库内已知线索：页名、别名、标签或注入的主题词；
- 问个人记录（「我之前怎么记的」「笔记里写了什么」）；
- 涉及长期整理的学科或领域；
- 点名具体工具、框架、模型、项目、论文；
- 要求引用、转述、核对笔记原文；
- 下判断、写结论或回写新页之前：先查再动笔。

何时可以不查：纯通用常识且不依赖本地知识库时跳过。
默认快速回答：只调用一次 wiki_recall，据结果直接答，不自动调 wiki_context / wiki_verify、不反复检索或自我验证；结尾加一句简短可信度提醒，资料不足就明说不足、不编造、不偷偷多轮检索。
${RECALL_TRIGGERS}

mode 用法：
- search（默认）：1-4 个关键词，空格分隔做 AND，别传整句问话。
- page / list / overview / lint / draft：取整页 / 列目录 / 看总览 / 查健康 / 拿落盘骨架。
机制、返回格式、status 与全部参数 —— 用 mode:"help" 查一次。

怎么读结果：
- kind=note 是消化过的笔记（最可信）；raw-summary 是资料压缩稿；source 是资料页。
- sources 是「来源数量」，判断证据强度用：1 份和 12 份不是一回事。
- 标了「可能已过时」的页，引用时说明时间。
- 一次 search 给元数据 + 摘要 + 命中小节正文，不是整页全文；status 非 ok、warnings 非空、零命中或正文被截断时须披露资料不足。
- 一条都没命中不代表话题不存在，换同义词或先用 list 看目录再搜。`

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

  /**
   * 调用账本。
   *
   * 位置优先级：DSH_WIKI_CALLS_LOG（测试与临时排查）> 配置里的 calls.log > 插件目录旁的
   * calls.jsonl。绝不写进知识库本体 —— 库是用户的，插件只能在库外面留账。
   */
  let callsCfg = readCallsConfig(pluginRoot)
  const calls = createCallLog({
    file: process.env.DSH_WIKI_CALLS_LOG || callsCfg.log || path.join(pluginRoot, 'calls.jsonl'),
    enabled: callsCfg.enabled,
  })

  /**
   * 治理观察账本。与 calls.jsonl 并列，但只记 Context / Verify 的生命周期事件，
   * 不记回答原文、引文或页面路径。位置同样优先读环境变量（测试与临时排查）。
   */
  const governance = createGovernance({
    file: process.env.DSH_WIKI_GOVERNANCE_LOG || path.join(pluginRoot, 'governance.jsonl'),
    enabled: callsCfg.enabled,
    sessionScope: ctx.sessions?.scopeOf?.(ctx) ?? 'unscoped',
  })

  /**
   * 记一条调用。旁路：记账失败绝不能变成工具失败 ——
   * 审计的价值远小于「查库还能用」，坏了就让它坏在暗处。
   */
  function recordCall(entry) {
    try {
      calls.record(entry)
    } catch {
      // 吞掉：账本写不进去不该影响检索
    }
  }

  /**
   * 清空两个账本与内存里的待核验状态。
   *
   * 顺序是硬的：先 setEnabled(false) 把闸关死，再 clear()。否则清空途中
   * 异步工具调用仍会把旧观察周期的事件写回文件，重开时又浮出来。
   * keepEnabled=true 时清完立刻开闸，governance 会切到新的观察周期，
   * 不补造任何历史。关闭路径则留在 disabled，指标返回「没有数据」。
   */
  function clearObservation(keepEnabled) {
    calls.setEnabled(false)
    governance.setEnabled(false)
    calls.clear()
    governance.clear()
    if (keepEnabled) {
      calls.setEnabled(true)
      governance.setEnabled(true)
    }
  }

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

  /**
   * context_id → observe_id 的短期对照表。
   *
   * 为什么插件要自己记：观察闭环要求 verify 记录能指回它的 context（parent_observe_id），
   * 但契约里 verify 的返回体不带 observe_id，Python 侧也不从快照回查 ——
   * 只认请求里带过去的那一个（`req.get("observe_id")`）。所以这一对得由插件存着，转发时补上。
   *
   * 换库时清掉：旧库的编号留着只会指错地方。
   * 内存里只留最近几条：context_id 每次都是新 uuid，用不到几轮。
   */
  const observeIds = new Map()
  const OBSERVE_ID_MAP_MAX = 64

  function rememberObserve(contextId, observeId) {
    observeIds.set(contextId, observeId)
    while (observeIds.size > OBSERVE_ID_MAP_MAX) {
      const oldest = observeIds.keys().next()
      if (oldest.done) break
      observeIds.delete(oldest.value)
    }
  }

  /** 查一对对应关系；查不到就返回空串，不猜。 */
  function lookupObserve(contextId) {
    return observeIds.get(contextId) ?? ''
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
      // persistent: false —— 声明的就是「这个句柄不该把进程钉住」。
      // 光靠下面的 handle.unref() 不够：Linux 上 recursive watch 是「每个子目录一个 inotify 句柄」，
      // unref() 只作用于主 handle，子句柄仍然是 ref 状态，Node 20/22 上进程跑完测试不退（CI 里挂死 15 分钟）。
      // Node 24 重写了实现、Windows 用单句柄，所以只有 ubuntu + node20/22 这一格暴露。
      handle = watch(watchRoot, { recursive: true, persistent: false }, (_event, filename) => {
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
  // 顺带把「重启后第一次扫描」提前到没人等的时候做 —— 实测冷盘要 5s 上下（一次真实重启后
  // 5,217ms，第二次 29ms），这段延迟不该落在用户的第一句提问上。
  const warmStarted = Date.now()
  getCorpus()
    .then((corpus) => {
      ctx.logger?.info?.(
        `LLM-Wiki 检索就绪：${corpus.stats.pages} 页 / ${corpus.stats.resources} 份资料 / ${corpus.stats.brokenPages} 页存在红链（${root}，首次扫描 ${Date.now() - warmStarted} ms）`,
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
      // 覆盖诊断：分母各是各的，别让人对着「95 页」猜漏了什么。
      // discovered = pages + unreadable + skipped（文件级恒等式）；walkFailures 是目录数，另算。
      discovered: stats.discovered ?? 0,
      skipped: stats.skipped ?? 0,
      unreadable: stats.unreadable ?? 0,
      oversized: stats.oversized ?? 0,
      walkFailures: stats.walkFailures ?? 0,
      statFailures: stats.statFailures ?? 0,
      sections: stats.sections ?? 0,
      bytes: stats.bytes ?? 0,
      newestMtime: stats.newestMtime ?? '',
      oldestMtime: stats.oldestMtime ?? '',
      scannedAt: stats.scannedAt ?? '',
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
      // 写操作先过跨源闸；GET /state 是只读，不拦。
      if (req.method === 'POST' && blockedOrigin(req)) {
        return sendJson(res, 403, { error: '拒绝跨源请求：写配置只接受本机页面或命令行' })
      }
      try {
        if (route === '/state' && req.method === 'GET') {
          return sendJson(res, 200, await buildState())
        }
        // 面板专用只读查询：和模型调 wiki_recall 走同一个 run()，所以「人看到的」
        // 就是「模型拿到的」——这正是这个面板存在的理由，另写一套轻量检索就白做了。
        // explain 只在服务端打开；工具 schema 里没有这个参数，模型触发不到。
        if (route === '/search' && req.method === 'GET') {
          const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
          const query = (parsed.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS)
          // 空查询不当作错误让面板弹红字：面板要显示的是「库现在什么样」，那是 /state 的事。
          if (query === '') return sendJson(res, 400, { error: '缺少 q 参数（要查什么）' })
          const started = Date.now()
          const corpus = await getCorpus()
          const result = run(corpus, {
            mode: 'search',
            query,
            limit: clampLimit(parsed.searchParams.get('limit')),
            explain: true,
          })
          recordCall({
            source: 'panel',
            tool: 'wiki_recall',
            mode: 'search',
            query,
            hits: Array.isArray(result?.hits) ? result.hits.length : 0,
            ms: Date.now() - started,
            ok: true,
          })
          return sendJson(res, 200, {
            ...result,
            // 面板要的分母：扫了多少页、扫描本身花了多久、这次查询花了多久
            scanned: corpus.stats?.pages ?? 0,
            scannedMs: corpus.stats?.scannedMs ?? 0,
            elapsedMs: Date.now() - started,
          })
        }
        // 调用审计：账本只读得回最近的调用，够回答「模型到底查没查、查了什么、查到没有」。
        // governance 是同一份插件侧统计，页面与 wiki_observe 看到的是同一个对象形状。
        if (route === '/calls' && req.method === 'GET') {
          const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
          const limit = Number(parsed.searchParams.get('limit'))
          const days = Number(parsed.searchParams.get('days'))
          const audit = calls.read({
            limit: Number.isFinite(limit) ? limit : undefined,
            source: parsed.searchParams.get('source') ?? 'all',
            only: parsed.searchParams.get('only') ?? 'all',
          })
          return sendJson(res, 200, {
            ...audit,
            governance: governance.stats({ days: Number.isFinite(days) && days > 0 ? days : undefined }),
          })
        }
        if (route === '/calls/config' && req.method === 'POST') {
          const body = await readBody(req)
          if (body === undefined) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
          callsCfg = writeCallsConfig(pluginRoot, { ...callsCfg, ...body }).config
          if (callsCfg.enabled !== true) {
            // 关闭 = 破坏性清空：先关闸再清两个账本和 pending，指标随即进入 disabled。
            clearObservation(false)
            return sendJson(res, 200, { enabled: false, cleared: true, governance_state: 'disabled' })
          }
          // 开启 = 新观察周期，不补造关闭期间的历史。
          calls.setEnabled(true)
          governance.setEnabled(true)
          return sendJson(res, 200, { enabled: true })
        }
        if (route === '/calls/clear' && req.method === 'POST') {
          // 手动清空与关闭共用同一实现：保持当前开关状态，清完切到新观察周期。
          clearObservation(callsCfg.enabled !== false)
          return sendJson(res, 200, { ok: true })
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
          // 换了库，旧库的 context_id ↔ observe_id 对就指错地方了，清掉。
          observeIds.clear()
          // 旧库的待核验状态同样不能留：清账本但保持当前观察开关。
          try {
            clearObservation(callsCfg.enabled !== false)
          } catch (error) {
            ctx.logger?.warn?.(`[wiki-notes] 换库后清治理账本失败：${String(error?.message ?? error)}`)
          }
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
        if (error?.code === 'BODY_TOO_LARGE') {
          return sendJson(res, 413, { error: String(error.message ?? error) })
        }
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
      // 关掉变量插值：这段文本里可能有用户自己写的提示词（extra / override），
      // 里面的 {{...}} 是普通文字，不该被宿主当变量解析成空串或报错。
      interpolate: false,
      text: () => buildTopicText(),
    })
  } catch (error) {
    ctx.logger?.warn?.(`[wiki-notes] 主题提示注册失败：${String(error?.message ?? error)}`)
  }

  // 治理总纲：独立于主题词那一段。关掉主题提示 / 整段覆盖都不影响它，
  // 因为核验纪律是稳定规则，不该跟着用户可编辑的那一行一起消失。
  try {
    ctx.systemPrompt?.context?.({
      name: 'wiki-notes:governance',
      order: 241,
      interpolate: false,
      text: () => GOVERNANCE_TEXT,
    })
  } catch (error) {
    ctx.logger?.warn?.(`[wiki-notes] 治理提示注册失败：${String(error?.message ?? error)}`)
  }

/**
 * 知识网关的两个工具：把判断交给 Python 管线。
 *
 * 为什么另开工具而不是塞进 wiki_recall：wiki_recall 是「给我看几条候选」，
 * 而这两个是「给我一份带证据、缺口与约束的上下文」和「拿它核验我的答案」。
 * 混在一起会让模型分不清「我拿到的是线索还是可引用的证据」。
 */

/** 读插件自己的版本号，用于契约里的 plugin_version。读不到就写 unknown。 */
function readPluginVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 插件版本：契约里要填，读一次就够。 */
const PLUGIN_VERSION = readPluginVersion(pluginRoot)

/**
 * Bridge 的错误信封比别处多一层：{kind:'error', contract_version, bridge_version, error:{code,message}}。
 * 直接取 value.error.code 会拿到 undefined，模型就只能看到「失败：? — 」，等于没给原因。
 */
function errorBrief(value) {
  const outer = value?.error ?? {}
  const inner = outer.error ?? outer
  const code = inner.code ?? '?'
  const message = inner.message ?? ''
  return message === '' ? code : `${code} — ${message}`
}

/** context 结果的一行摘要：先给结论面，细节交给结构化字段。 */
function renderContext(args, value) {
  if (!value || typeof value !== 'object') return '（没有结果）'
  if (value.kind === 'error') {
    return `知识网关调用失败：${errorBrief(value)}`
  }
  const status = value.status ?? {}
  const lines = [
    `问题：${value.query ?? args?.query ?? ''}`,
    `状态：检索 ${status.retrieval ?? '?'} / 支持 ${status.support ?? '?'} / 阶段 ${status.stage ?? '?'}`
      + (status.degraded ? `（降级：${(status.degraded_sources ?? []).join('、') || '未知引擎'}）` : ''),
  ]

  const reason = value.support_reason
  if (reason?.primary_label) lines.push(`依据：${reason.primary_label}`)

  const evidence = value.evidence ?? []
  if (evidence.length > 0) {
    lines.push(`证据页 ${evidence.length} 张：`)
    for (const page of evidence.slice(0, 6)) {
      const supports = page.supports ?? []
      const grade = page.evidence_grade ?? '?'
      lines.push(`  · [${grade}] ${page.title ?? page.page ?? ''}（${page.page ?? ''}）`
        + (supports.length ? `，支撑 ${supports.map((s) => s.slot).join('/')}` : ''))
    }
  } else {
    lines.push('证据页：0 张')
  }

  const missing = value.missing ?? []
  if (missing.length > 0) {
    lines.push(`缺口 ${missing.length} 项：${missing.map((m) => `${m.slot}(${m.reason})`).join('、')}`)
  }
  const conflicts = value.conflicts ?? []
  if (conflicts.length > 0) lines.push(`冲突候选 ${conflicts.length} 项（未裁决，别当成已确认的结论）`)

  if (value.answer?.contract_text) lines.push('', value.answer.contract_text.trim())
  if (value.context_id) lines.push('', `context_id：${value.context_id}（可交给 wiki_verify 核验回答）`)
  // observe_id 也露出来：观察日志靠它把 verify 记录挂回这条 context。
  // 插件会自动转发它，所以模型不用管；但写出来，模型想显式传参时手里有。
  if (value.observe_id) lines.push(`observe_id：${value.observe_id}`)
  // 必核清单只从这份 Context 的真实证据 / 缺口 / 约束派生：
  // 不写页面路径、标题、引文或具体数值，也不推断事实。错误信封没有清单。
  const checks = buildRequiredChecks(value)
  if (checks.count > 0) lines.push('', ...checks.lines)
  return lines.join('\n')
}

/** verify 结果的一行摘要：违规逐条列出，别只给个数。 */
function renderVerify(args, value) {
  if (!value || typeof value !== 'object') return '（没有结果）'
  if (value.kind === 'error') {
    return `核验没跑成：${errorBrief(value)}`
  }
  const lines = [`核验状态：${value.status ?? '?'}`]
  const violations = value.violations ?? []
  if (violations.length === 0) lines.push('没有发现违规。')
  else {
    lines.push(`违规 ${violations.length} 条：`)
    for (const v of violations) {
      lines.push(`  · ${v.type ?? v.rule ?? '?'}：${v.claim ?? ''} — ${v.reason ?? ''}`.trim())
    }
  }
  const notices = value.notices ?? []
  if (notices.length > 0) {
    lines.push(`提示 ${notices.length} 条：${notices.map((n) => n.rule ?? '').join('、')}`)
  }
  // 违规处置纪律：ok 只说明这次核验没发现越界，不等于逐项必核规则都查过；
  // 发现违规就定向改答案，最多复核一次；复核仍有违规即停止并披露，不再循环。
  if (violations.length > 0 || value.status === 'violations_found') {
    lines.push('', '不得绕过 violations_found：定向修正答案后最多再跑一次 wiki_verify；复核仍有违规即停止并披露，不再循环核验。')
  }
  return lines.join('\n')
}

/** 治理指标的一行：value 为 null 时绝不伪装成 0%。 */
function governanceMetricLine(label, metric) {
  if (!metric || typeof metric !== 'object') return `  ${label}：没有数据`
  const ratio = `${metric.numerator ?? '?'} / ${metric.denominator ?? '?'}`
  const rate = typeof metric.value === 'number' && Number.isFinite(metric.value)
    ? `${(metric.value * 100).toFixed(1)}%`
    : '没有数据'
  const samples = `有效样本 ${metric.effective_samples ?? '?'} / 排除 ${metric.excluded_count ?? 0}`
  const reasons = Array.isArray(metric.exclude_reasons) && metric.exclude_reasons.length > 0
    ? `（${metric.exclude_reasons.join('、')}）`
    : ''
  return `  ${label}：${ratio}（${rate}）· ${samples}${reasons}`
}

/**
 * 治理账本摘要：只渲染 observe 成功返回里附带的 governance 字段。
 * 关闭观察与「零违规」是两种不同状态，不能都显示成 0%；断言数量恒为数据不可用。
 */
function renderGovernanceLines(g) {
  if (!g || typeof g !== 'object') return []
  const lines = ['', '治理观察（插件侧账本，与 Python 观察日志分开）：']
  lines.push(`  观察是否启用：${g.observe_enabled === true ? '已启用' : '未启用'}`)
  if (g.state === 'disabled' || g.state === 'unavailable' || g.observe_enabled === false) {
    lines.push(`  观察窗口：${g.window?.days ?? 7} 天`)
    lines.push(`  ${g.message || '没有启用观察，因此没有数据'}`)
    lines.push('  断言数量：数据不可用')
    lines.push('  观察到的核验链收敛率：没有启用观察，因此没有数据')
    return lines
  }
  const metrics = g.metrics ?? {}
  lines.push(`  观察窗口：${g.window?.days ?? 7} 天`)
  const trigger = metrics.required_check_verification_trigger_rate
  lines.push(governanceMetricLine('必核项 Context 核验触发率', trigger))
  const group = trigger?.groups?.partial_insufficient
  if (group && typeof group === 'object') {
    lines.push(governanceMetricLine('  └ partial / insufficient 分组', group))
  }
  const discovery = metrics.effective_verify_violation_discovery_rate
  const discoveryLine = discovery?.numerator === 0 && discovery?.denominator > 0
    ? `  有效 Verify 违规发现率：0 次违规（0.0%）· 有效样本 ${discovery.denominator} / 排除 ${discovery.excluded_count ?? 0}`
    : governanceMetricLine('有效 Verify 违规发现率', discovery)
  lines.push(discoveryLine)
  lines.push(governanceMetricLine('观察覆盖率', metrics.observation_coverage))
  lines.push('  断言数量：数据不可用')
  const conv = g.convergence ?? {}
  if (typeof conv.converged === 'number' || typeof conv.unresolved === 'number' || typeof conv.not_rechecked === 'number') {
    lines.push(`  观察到的核验链收敛率：已收敛 ${conv.converged ?? 0} / 仍未收敛 ${conv.unresolved ?? 0} / 未复核 ${conv.not_rechecked ?? 0}`)
    lines.push('  收敛只表示观察到的核验链，不等于最终回答已证明可靠。')
  } else {
    lines.push('  观察到的核验链收敛率：没有数据')
  }
  const ex = g.excluded ?? {}
  const reasons = []
  for (const [key, value] of Object.entries(ex.context_samples ?? {})) {
    if (typeof value === 'number' && value > 0) reasons.push(`${key}×${value}`)
  }
  for (const [key, value] of Object.entries(ex.verify_calls ?? {})) {
    if (typeof value === 'number' && value > 0) reasons.push(`${key}×${value}`)
  }
  if (typeof ex.late_verify === 'number' && ex.late_verify > 0) reasons.push(`late_verify×${ex.late_verify}`)
  lines.push(`  排除原因：${reasons.length > 0 ? reasons.join('、') : '无'}`)
  return lines
}

/** observe 统计摘要：只报分布，不下结论，也不参与回答。 */
function renderObserve(args, value) {
  if (!value || typeof value !== 'object') return '（没有结果）'
  if (value.kind === 'error') {
    return `观察统计没跑成：${errorBrief(value)}`
  }
  const totals = value.totals ?? {}
  const window = value.window ?? {}
  const dist = (obj) => {
    const pairs = Object.entries(obj ?? {})
    return pairs.length === 0 ? '—' : pairs.map(([k, v]) => `${k}×${v}`).join('、')
  }
  const lines = [
    `观察窗口：最近 ${window.days ?? '?'} 天（context ${totals.contexts ?? 0} 次 / verify ${totals.verifies ?? 0} 次）`,
    `支持状态：${dist(value.support_distribution)}`,
    `检索状态：${dist(value.retrieval_distribution)}`,
    `违规类型：${dist(value.violation_types)}`,
  ]
  // 修正情况：这一块专门看「发现违规之后改没改」，比违规总数更能反映核验有没有用
  const rev = value.revision
  if (rev && typeof rev === 'object') {
    const rate = rev.correction_rate
    const rateText = typeof rate === 'number' ? `${(rate * 100).toFixed(0)}%` : '暂无可算样本'
    lines.push(
      `修正情况：核验过的 context ${rev.contexts_verified ?? 0} 个，`
      + `已改正 ${rev.corrected ?? 0} / 仍未改正 ${rev.unresolved ?? 0}，修正率 ${rateText}`,
    )
    const seqs = Array.isArray(rev.sequences) ? rev.sequences.slice(0, 3) : []
    for (const s of seqs) {
      const mark = s.corrected ? '已改正' : (s.unresolved ? '仍未改正' : '单次通过')
      const types = Array.isArray(s.types_seen) && s.types_seen.length ? `（${s.types_seen.join('、')}）` : ''
      lines.push(`  · ${s.query ?? '(无问题)'} — ${s.attempts ?? 0} 次核验 / ${mark}${types}`)
    }
  }
  if (totals.legacy) lines.push(`另有 ${totals.legacy} 条早期记录（无事件字段，未计入统计）`)
  if (value.governance && typeof value.governance === 'object') {
    lines.push(...renderGovernanceLines(value.governance))
  }
  return lines.join('\n')
}

/** 统一的 Bridge 调用包装：配置从插件配置读，错就错在明处。 */
async function callBridge(command, payload) {
  const started = Date.now()
  const cfg = readBridgeConfig(pluginRoot)
  const rootInfo = resolveWikiRootInfo(pluginRoot, root)
  /** 网关这条路上「一次调用」的记账：三个工具都从这里过，记在一处不散。 */
  const note = (hits, ok) => recordCall({
    tool: `wiki_${command}`,
    mode: typeof payload?.engine === 'string' ? payload.engine : '',
    query: typeof payload?.query === 'string' ? payload.query : '',
    // 只有 context 会产生「命中了几页证据」；verify 是核对、observe 是读统计，
    // 记成 0 会把命中率的分母悄悄稀释，所以记 null。
    hits: command === 'context' ? hits : null,
    ms: Date.now() - started,
    ok,
  })
  if (rootInfo.root === '') {
    note(null, false)
    return errorEnvelope('E_WIKI_ROOT_MISSING', NOT_CONFIGURED_HINT, 'validate')
  }
  const result = await runBridge({
    command,
    payload: { ...payload, root: rootInfo.root },
    python: cfg.python || 'python',
    toolsRoot: cfg.toolsRoot,
    timeoutMs: cfg.timeoutMs,
    // 观察日志单独落盘：正式使用与测试数据物理隔离，免得修正率被自测记录带歪
    env: cfg.observeLog ? { WIKI_OBSERVE_LOG: cfg.observeLog } : {},
    pluginVersion: PLUGIN_VERSION,
  })
  if (!result.ok) {
    note(null, false)
    return result.error
  }
  const data = result.data ?? errorEnvelope('E_BRIDGE_CRASH', 'Bridge 返回了空结果', 'bridge')
  note(Array.isArray(data?.evidence) ? data.evidence.length : 0, true)
  return data
}

const registerGateway = () => {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'wiki_context',
    description:
      '向本地知识库要一份「带证据的上下文」：检索、抽证据、标缺口、给回答约束，一次完成。'
      + '仅在按需深度证据时使用：用户明确要求查看原文 / 核验，或问题涉及高风险、后果重大的重要事实，或库内存在复杂冲突；普通快速回答不要调用，'
      + '也不要自己连续调 wiki_recall。返回里 status.support 与 status.degraded 必须分别看待：'
      + 'support 说的是「知识够不够」，degraded 说的是「引擎有没有坏」，后者为真时不能把 support 当结论。'
      + '返回的 context_id 可交给 wiki_verify 核验后续回答。'
      + CONTEXT_TRIGGERS,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题，或核心名词组合（不要整段散文）' },
        limit: { type: 'number', description: '最多读几页证据，1–12，默认 5' },
        engine: {
          type: 'string',
          enum: ['both', 'search', 'wiki_recall'],
          description: '用哪个检索通道；默认 both（两个都跑，各自保留出处，不混排名）',
        },
        ttl_seconds: { type: 'number', description: '这份上下文的快照保留多久，默认 1800 秒' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: renderContext(args, value) }],
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') {
        return errorEnvelope('E_QUERY_EMPTY', 'query 不能为空', 'validate')
      }
      const cycle = governance.cycle()
      const value = await callBridge('context', {
        query: query.slice(0, MAX_QUERY_CHARS * 4),
        limit: args?.limit,
        engine: args?.engine,
        ttl_seconds: args?.ttl_seconds,
      })
      // 记下 context_id ↔ observe_id 这一对，verify 时自动带上（见 lookupObserve）。
      // 观察记录写不进去时 Python 返回 observe_id=null，这里也就没得记 —— 不硬造。
      if (value && value.kind === 'context' && value.context_id && value.observe_id) {
        rememberObserve(value.context_id, value.observe_id)
      }
      // 只记成功生成的 Context；错误信封不进账本，也不制造 pending。
      // cycle 是调用前取的观察周期号，关闭后旧周期的迟到结果会被丢弃。
      try {
        governance.recordContext(value, cycle)
      } catch (error) {
        ctx.logger?.warn?.(`[wiki-notes] 治理账本记 Context 失败：${String(error?.message ?? error)}`)
      }
      return value
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'wiki_verify',
    description:
      '拿一份已有的 wiki_context 结果去核验一段回答，不重新检索。'
      + '仅在深度核验模式下使用：写完候选答案后按需自查，不因答案含数字、范围、年份或引文就在快速回答里自动调用。'
      + '返回 status 与 violations：violations 非空说明回答越过了证据允许的边界；'
      + 'context_expired / context_missing 是快照问题，不等于回答错了，需要重新取上下文再核验。'
      + VERIFY_TRIGGERS,
    parameters: {
      type: 'object',
      properties: {
        context_id: { type: 'string', description: 'wiki_context 返回的 context_id' },
        answer: { type: 'string', description: '要核验的回答原文' },
        observe_id: {
          type: 'string',
          description:
            '可选：wiki_context 返回的 observe_id。插件会自动带上与之对应的那个，'
            + '一般不用自己传；显式传了则以你传的这个为准。',
        },
      },
      required: ['context_id', 'answer'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: renderVerify(args, value) }],
    },
    async execute(args) {
      const contextId = typeof args?.context_id === 'string' ? args.context_id.trim() : ''
      if (contextId === '') {
        return errorEnvelope('E_CONTEXT_NOT_FOUND', '缺少 context_id', 'validate')
      }
      const answer = typeof args?.answer === 'string' ? args.answer : ''
      if (answer.trim() === '') {
        return errorEnvelope('E_VERIFY_EMPTY_ANSWER', 'answer 不能为空', 'validate')
      }
      // observe_id 转发：显式传的优先，否则用插件记下的那一对。
      // Python 侧只认请求里带的 observe_id（不从快照回查），不传就等于把 verify
      // 记录和它的 context 拆成两条互不相认的日志。
      const explicit = typeof args?.observe_id === 'string' ? args.observe_id.trim() : ''
      const observeId = explicit || lookupObserve(contextId)
      const cycle = governance.cycle()
      const value = await callBridge('verify', {
        context_id: contextId,
        answer,
        ...(observeId ? { observe_id: observeId } : {}),
      })
      // 事件记账旁路：返回值原样交回调用方，不污染 context/verify 契约。
      // 不可用 Verify 由账本按调用级原因排除，不改动所属 Context 的处置状态。
      try {
        governance.recordVerify(contextId, value, cycle)
      } catch (error) {
        ctx.logger?.warn?.(`[wiki-notes] 治理账本记 Verify 失败：${String(error?.message ?? error)}`)
      }
      return value
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'wiki_observe',
    description:
      '仅诊断深度核验链的观察统计。'
      + '查观察日志的统计：这段时间 wiki_context 被问过多少次、支持状态怎么分布、'
      + 'wiki_verify 挑出过哪些违规类型。只读诊断，不参与回答，也不改检索行为。'
      + OBSERVE_TRIGGERS,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, description: '统计窗口天数，默认 7' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最近记录条数，默认 10' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: renderObserve(args, value) }],
    },
    async execute(args) {
      const base = await callBridge('observe', { days: args?.days, limit: args?.limit })
      if (!isObserveResult(base)) return base // error_envelope 不带任何额外键
      return { ...base, governance: governance.stats({ days: args?.days }) }
    },
  }))

  return disposers
}

  const register = () => ctx.tools.register({
    name: 'wiki_recall',    description: DESCRIPTION,
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
          if (result.mode === 'lint') {
            try {
              result.sinceLast = recordLintRun(corpus, args ?? {}, pluginRoot)
            } catch {
              // 历史文件坏了不该让体检失败：少一行对比，其它照报
            }
          }
          if (typeof corpus.drilledFrom === 'string') result.drilledFrom = corpus.drilledFrom
          result.ms = Date.now() - started
        }
        const value = result ?? { mode: 'error', error: '查询没有返回结果（mode 可能传错了）' }
        recordCall({
          tool: 'wiki_recall',
          mode: typeof value?.mode === 'string' ? value.mode : '',
          query: typeof args?.query === 'string' ? args.query : '',
          // 只有 search 有「命中几页」这回事。page/list 是「读到了就是读到了」，
          // 记成 0 会把命中率的分子分母一起带歪，所以记 null 让它不进统计。
          hits: value?.mode === 'search' && Array.isArray(value.hits) ? value.hits.length : null,
          ms: Date.now() - started,
          ok: value?.mode !== 'error',
        })
        return value
      } catch (error) {
        recordCall({
          tool: 'wiki_recall',
          mode: typeof args?.mode === 'string' ? args.mode : '',
          query: typeof args?.query === 'string' ? args.query : '',
          hits: null,
          ms: Date.now() - started,
          ok: false,
        })
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

  // 网关工具单独注册：Python 侧没装好、或者配置里没填工具目录，
  // 都不该连累 wiki_recall —— 那是两条独立的通路。
  const gatewayDisposers = []
  try {
    gatewayDisposers.push(...registerGateway())
  } catch (error) {
    ctx.logger?.warn?.(`LLM-Wiki 网关：注册工具失败 —— ${String(error && error.message || error)}`)
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
    for (const item of gatewayDisposers) {
      try {
        item?.()
      } catch {
        // 同上
      }
    }
  })
}

/* ------------------------- 体检历史（lint 的对比基线） ------------------------- */

/** 需要动手的项。不含「久未更新」：它随时间自己变，进 diff 只会产生噪音。 */
function lintIssueKeys(value) {
  const keys = new Set()
  for (const row of value.orphans ?? []) keys.add(`孤儿页 ${row}`)
  for (const row of value.brokenTargets ?? []) keys.add(`断链 ${row.name}`)
  for (const row of value.missingFields ?? []) keys.add(`缺字段 ${row.name}`)
  for (const row of value.aliasConflicts ?? []) keys.add(`别名冲突 ${row.alias}`)
  for (const row of value.noLinks ?? []) keys.add(`无出链 ${row}`)
  return keys
}

/**
 * 记下这次体检，并和上一次比。
 *
 * 单次报告只说明「现在有什么」，说不出「库在变好还是变坏」——
 * 修了三处、又坏了五处，和一处没动，在单次报告里长得一样。
 * 对比用的那份用大 limit 重算一次：报告的 items 是截断的，拿截断结果做 diff 会漏项。
 */
function recordLintRun(corpus, args, pluginRoot) {
  const file = path.join(path.dirname(configPath(pluginRoot)), 'lint-history.json')
  const full = lint(corpus, { ...args, limit: 500 })
  const keys = lintIssueKeys(full)

  let previous = null
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    previous = null // 第一次跑，或文件坏了：都当作没有基线
  }

  const before = new Set(Array.isArray(previous?.keys) ? previous.keys : [])
  const added = [...keys].filter((key) => !before.has(key))
  const fixed = [...before].filter((key) => !keys.has(key))

  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), keys: [...keys] }), 'utf8')
  } catch {
    // 写不进去（只读家目录）不该影响体检本身
  }

  return {
    at: previous?.at ?? '',
    first: previous === null,
    added: added.slice(0, 5),
    addedTotal: added.length,
    fixed: fixed.slice(0, 5),
    fixedTotal: fixed.length,
  }
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
    case 'help':
      body = renderHelp(value)
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

  const since = value.sinceLast
  if (since && since.first !== true) {
    // 单次报告只有「现在」，说不出趋势：修了三处又坏五处，和一处没动长得一样
    const parts = []
    if (since.addedTotal > 0) parts.push(`新增 ${since.addedTotal} 项（${since.added.join('；')}）`)
    if (since.fixedTotal > 0) parts.push(`已修 ${since.fixedTotal} 项（${since.fixed.join('；')}）`)
    if (parts.length === 0) parts.push('没有变化')
    lines.push(`与上次（${String(since.at).slice(0, 10)}）相比：${parts.join('，')}`)
  } else if (since && since.first === true) {
    lines.push('（第一次记录基线，下次起会显示相对上次的变化）')
  }

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
/**
 * help 的渲染：纯静态文本，按小节铺开。
 * 不放 markdown 表格 —— 模型读的是文本，表格的对齐空白是白付的 token。
 */
function renderHelp(value) {
  const out = ['【wiki_recall 用法】']
  for (const section of value.sections ?? []) {
    out.push('')
    out.push(`■ ${section.title}`)
    for (const line of section.lines ?? []) out.push(line)
  }
  return out.join('\n')
}

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
  // 光给日期模型判断不了该不该信：三年前的结论和上周的结论长得一模一样。
  if (hit.updated) parts.push(freshnessOf(hit.updated))
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
  // 「没沾到」是给模型看的换词依据：面板上能点出来，模型看不到就等于白算。
  // 它和 degraded 说的不是一件事：degraded 是「一条全词命中都没有」，
  // 这里是「这个具体的词在库里一页都没沾到」—— 后者才指着该换哪个词。
  const missed = Array.isArray(value.missedTerms) ? value.missedTerms : []
  if (missed.length > 0) out.push(`没沾到：${missed.join('、')}（这些词在库里一页都没命中，换同义词或干脆去掉）`)
  // 降级说明已由 warnings 承载（degraded 时必有一条，用的就是同一段文字）；只有 status 仍是 ok
  // 或老调用方（结果里没有 status 字段）才需要这里的 note —— 否则同一句话模型会读两遍。
  // ok 也要放行：单字查询「这个字到处都有、排序没有区分度」是 ok 状态下唯一能说这句话的出口，
  // 而 ok 按契约不带 warnings 键（tests/status.mjs 守着「正常路径零额外 token」）。
  if (value.note && (value.status === undefined || value.status === 'ok')) out.push(`⚠️ ${value.note}`)

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
      out.push('下一步：① 用页面标题或术语原文重试（别用整句问话）；② 换同义词 / 英文 / 缩写；③ mode:"list" 看这个库的命名习惯。')
      out.push('三条都试过仍然没有，才可以说「笔记里没有这个主题」。')
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
  if (value.note && value.status === 'ok') out.push(`⚠️ ${value.note}`)
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
    // 和 search / page 一样把「多久以前」算出来：目录里最常被误读的就是一串裸日期，
    // 看不出哪页是上个月改的、哪页是两年前的。
    const updated = row.updated ? freshnessOf(row.updated) : ''
    const meta = [row.type, row.status, row.sources === null ? '' : `${row.sources} 源`, updated]
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
