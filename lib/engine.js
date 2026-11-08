/**
 * engine.js —— 检索/取页/目录/总览四种查询。纯函数风格，输入 corpus，输出可序列化对象。
 *
 * 评分规则是 search.py 的超集（权重保持一致，方便 A/B 对比召回是否下降）：
 *   标题全等 120 / 标题包含 60 / 别名包含 50 / 标签包含 25 / 正文命中 ×3 封顶 12
 * 新增一项 index 摘要包含 8 —— index.md 那行摘要是人工提炼的，正文里常常没有
 * 这个词，如果没有它，「上下文怎么管」这种说法就搜不到「上下文工程」。
 */

import { asList } from './corpus.js'

const DEFAULT_SECTION_CHARS = 900
const DEFAULT_PAGE_CHARS = 6000

/**
 * 参数边界只在入口解析一次，里面的函数直接信这个数。
 * 越界不炸（llm 偶尔会写 limit: 999），但也不能让它真返回一万条。
 */
function intOption(options, key, fallback, lo, hi) {
  const value = Number(options[key] ?? fallback) || fallback
  return Math.max(lo, Math.min(value, hi))
}

// 中文疑问词。它们出现在查询里几乎从不出现在页面正文里，留着就会变成「必须同时命中」的
// 硬条件：`Agent Harness 是什么` 里那个「是什么」会把真正该命中的页筛掉。
// 只剥疑问词，不碰「的 / 了 / 和」—— 那些字在「目的」「和平」里是真词，剥了会切坏词。
const QUESTION_WORDS = ['是什么样的', '是什么', '什么样', '怎么样', '怎么办', '咋办', '咋整', '做什么', '怎么', '怎样', '如何', '为什么', '为何', '哪些', '哪个', '哪种', '是否', '有没有', '能不能', '要不要', '多少', '吗', '呢', '吧']

/**
 * 剥掉查询两端的疑问词。
 *
 * 只剥**贴在两端**的，不从中间切：中文没有词边界，一从中间切就造伪词。
 * 反例（真跑出来的）：「甲方案的实施顺序应该怎么安排」按旧的「全局 split」切出来是
 * 「甲方案的实施顺序应该」+「安排」——两个都不是词，AND 全落空，覆盖率兜底也没机会，
 * 于是最该命中的那页总览反而进不了前五。
 *
 * 三种情形：
 *   part 整个就是一个疑问词  → 丢掉（它不含内容，留着只会当硬条件）
 *   疑问词在头或在尾，剥完还剩 ≥2 字 → 剥
 *   其余（含剥完不足 2 字）  → 原样保留，宁可搜不到，也不把查询悄悄缩窄
 */
function stripQuestionWords(part) {
  for (const word of QUESTION_WORDS) {
    if (part === word) return []
    if (part.endsWith(word)) {
      const head = part.slice(0, part.length - word.length).trim()
      if (head.length >= 2) return [head]
      return [part]
    }
    if (part.startsWith(word)) {
      const tail = part.slice(word.length).trim()
      if (tail.length >= 2) return [tail]
      return [part]
    }
  }
  return [part]
}

/**
 * 输入卫生：去掉两端包着的标点，丢掉既没有文字也没有数字的片段。
 *
 * 两件真事逼出来的：`？？？` 经 NFKC 变成 `???` 会当成一个检索词（结果页显示「没有命中」，
 * 但实际上查询本身就没内容，该报空查询）；`"引号"` 带着引号去匹配，永远只能落在覆盖率兜底。
 * 只去引号/括号/句读，不动 `+ # . _ -`：`C#`、`F#`、`node.js` 里的符号是词的一部分。
 */
const EDGE_PUNCT = /^["'“”‘’「」『』（）()《》〈〉【】[\]!?！？。，,、;；:：]+|["'“”‘’「」『』（）()《》〈〉【】[\]!?！？。，,、;；:：]+$/g
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u

function cleanPart(part) {
  return part.replace(EDGE_PUNCT, '').trim()
}

/**
 * 把用户 query 拆成检索词。中文没有空格，所以整句当一个词；有空格才算多词 AND。
 *
 * 两处归一化，都是被评测集逼出来的（queries.json 的「全角」「中英混写」两组）：
 *   NFKC  —— 全角「ＲＡＧ」要能命中半角「RAG」。search.py 第一步就是这一步，之前这边漏了。
 *   疑问词剥离 —— 见 QUESTION_WORDS，不让「是什么」当硬条件。
 */
export function tokenize(query) {
  // 200 字上限放在这里，而不是只放在工具层：CLI、设置页 /search、Python 桥都走这条路，
  // 上一层拦住的长度到这里不该又变回一个 300 字的「词元」——它会拖慢每个页面的比对，
  // 还会被原样回显进 note（`"<整段查询>" 被当成一个词元`）。
  const trimmed = String(query ?? '').normalize('NFKC').trim().slice(0, MAX_QUERY_CHARS)
  if (trimmed === '') return []
  const rawParts = trimmed
    .split(/[\s,，、。;；/|]+/)
    .map((part) => cleanPart(part))
    .filter((part) => part !== '' && HAS_WORD_CHAR.test(part))
  // 整条查询就是一个疑问词（「多少」「怎么样」）时退回原样：宁可搜不到，也不把查询悄悄变成空
  const stripped = rawParts.flatMap(stripQuestionWords)
  const parts = stripped.length > 0 ? stripped : rawParts
  // 去重但保留顺序
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(part)
  }
  return out
}

/** 标签比较不区分大小写：主题词统计那边已经归并 `RAG`/`rag`，查询这边不能反而更严。 */
function matchesTag(pageTags, wanted) {
  const lower = String(wanted).toLowerCase()
  return pageTags.some((tag) => tag.toLowerCase() === lower)
}

function countOccurrences(haystack, needle) {
  if (needle === '' || haystack === '') return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let count = 0
  let idx = h.indexOf(n)
  while (idx !== -1) {
    count += 1
    idx = h.indexOf(n, idx + n.length)
    if (count > 200) break
  }
  return count
}

/**
 * 单个检索词对单个页面的贡献分。0 表示这个词与这页无关。
 *
 * 权重与 search.py **完全一致**（标题全等 120 / 标题含 60 / 别名含 50 / 标签 25 /
 * 正文 min(命中数,12)×3，各项累加），因为 A/B 的目标是「召回不降」——算法一变，
 * 对比就失去意义。唯一的新增是 index.md 摘要命中 +8：那行摘要人工提炼过，
 * 常含正文里不出现的说法（例如「上下文怎么管」这类口语），不加就搜不到。
 */
function termScore(page, token) {
  return termBreakdown(page, token).score
}

/**
 * 单个检索词对单个页面的贡献**明细**：每条通道各给了多少分。
 *
 * termScore 就是把它求和 —— 只有一个实现，所以「面板上显示的理由」与
 * 「排序用的分数」不可能对不上。explain 只是把已经在算的数摊开，不是第二条路径。
 */
function termBreakdown(page, token) {
  const name = page.name.toLowerCase()
  const term = token.toLowerCase()
  const parts = []
  let score = 0

  if (name === term) {
    parts.push({ via: 'name', score: 120 })
    score += 120
  } else if (name.includes(term)) {
    parts.push({ via: 'name', score: 60 })
    score += 60
  }

  for (const alias of asList(page.fields['别名'])) {
    if (alias.toLowerCase().includes(term)) {
      parts.push({ via: 'alias', score: 50 })
      score += 50
      break
    }
  }
  for (const tag of asList(page.fields['标签'])) {
    if (tag.toLowerCase().includes(term)) {
      parts.push({ via: 'tag', score: 25 })
      score += 25
      break
    }
  }

  const count = countOccurrences(page.body, term)
  const bodyScore = Math.min(count, 12) * 3
  if (bodyScore > 0) {
    parts.push({ via: 'body', score: bodyScore, count })
    score += bodyScore
  }
  return { score, parts, count }
}

/**
 * explain 用：每个检索词在这页上「凭什么得分」，没得分也留一条，好让面板看出是哪个词掉了。
 * index 通道同样按「只补漏」的规则在这里补记 —— 与 search() 里的判定条件一字不差。
 */
function explainTerms(page, indexLine, tokens) {
  return tokens.map((token) => {
    const breakdown = termBreakdown(page, token)
    if (breakdown.score > 0) {
      return {
        term: token,
        score: breakdown.score,
        count: breakdown.count,
        parts: breakdown.parts,
      }
    }
    if (indexLine !== null && indexLine.summary.toLowerCase().includes(token.toLowerCase())) {
      return { term: token, score: INDEX_ONLY_SCORE, count: 0, parts: [{ via: 'index', score: INDEX_ONLY_SCORE }] }
    }
    return { term: token, score: 0, count: 0, parts: [] }
  })
}

/**
 * index.md 摘要通道：**只在其它通道全零时才给分**。
 *
 * 一开始把 +8 加进总分，立刻把某个 query 的 top5 挤掉三页——摘要里提到过
 * 某个词的资料页会顶掉真正相关的笔记页，召回不降的目标当场就破了。改成「只补漏、
 * 不抢位」之后，它只负责 search.py 搜不到的口语说法，不干扰既有名次。
 */
const INDEX_ONLY_SCORE = 8

/**
 * 类型分层：同分时结构化笔记优先于原始资料摘要 —— 笔记是消化过的结论。
 *
 * 总览放在最高一档而不是默认档：它是全库唯一的入口页，一个跨模块的词（「复盘」「数据」
 * 这类）在总览里出现的意义，和它在某个模块综合页里出现的意义不是一回事。2026-11-08 用
 * tests/local/ab_export.py 重导基线后暴露：某一查询里总览与某个模块综合页同分 15，
 * 按旧表（总览落到默认档 2）被挤到第 6 位，与 search.py 的前 5 不一致。
 */
const TYPE_TIER = { 综合: 3, 总览: 3, 概念: 2, 实体: 2, 对比: 2, 资料: 1 }

function typeTier(page) {
  return TYPE_TIER[String(page.fields['类型'] ?? '')] ?? 2
}

/**
 * 排序：先「命中全部检索词」的页，再按分数。
 *
 * 多词查询里总有几页像「某课程·资料摘要」这种大而全的资料页，每个词都沾一点、分数最高，
 * 但不是答案。把只命中一部分词的页压到全命中页后面，等于保留 search.py 的 AND 语义；
 * 全部页都只命中一部分时（库里的确没写这个词），次序退回纯分数，并标 degraded。
 */
function compareHits(a, b) {
  if (a.allTerms !== b.allTerms) return a.allTerms ? -1 : 1
  if (b.score !== a.score) return b.score - a.score
  const tierDiff = typeTier(b.page) - typeTier(a.page)
  if (tierDiff !== 0) return tierDiff
  const updatedA = String(a.page.fields['更新'] ?? '')
  const updatedB = String(b.page.fields['更新'] ?? '')
  if (updatedA !== updatedB) return updatedB.localeCompare(updatedA)
  // 码点序（不是拼音序）：与文件系统里的名字顺序一致，同分次序可复现。
  // 用 localeCompare('zh') 会按拼音重排，A/B 对比时同一组 3 分页会漂移。
  return a.page.name < b.page.name ? -1 : a.page.name > b.page.name ? 1 : 0
}

/** 页面性质：原始资料压缩稿 / 资料页 / 结构化笔记。渲染时给模型一个判断依据。 */
function pageKind(page) {
  const type = String(page.fields['类型'] ?? '')
  if (type === '资料') {
    return page.name.endsWith('·资料摘要') ? 'raw-summary' : 'source'
  }
  return 'note'
}

/** 正文开头那句 `> 一句话总结：…` / `> 定义：…`，一两百字就能判断该不该读整页。 */
function extractGist(body) {
  const match = String(body ?? '').match(/^>\s*(?:一句话总结|定义|一句话|摘要)[：:]\s*(.+)$/m)
  return match === null ? '' : clip(match[1].trim(), 140)
}

/**
 * 不该抢头名的小节：前一组只是清单，后一组谈的是「这一页自己」而不是它讲的主题。
 * 命中了也不是答案，先排掉，实在没有别的小节才回退。
 */
const BOILERPLATE_TITLES = [
  '元信息', '原始文件', '文件清单', '更新日志', '变更记录', '修订记录', '来源', '参考', '附录',
  '悬而未决', '值得追问', '它改变了什么', '相关', '待办', '遗留',
]

function isBoilerplate(title) {
  return BOILERPLATE_TITLES.some((word) => title.includes(word))
}

/** 在一组小节里挑命中最密的那节；一个都没命中返回 null。 */
function bestSectionIn(pool, tokens) {
  let best = null
  let bestScore = 0
  for (const [index, section] of pool.entries()) {
    let covered = 0
    let hits = 0
    for (const token of tokens) {
      const inTitle = countOccurrences(section.title, token)
      const inText = countOccurrences(section.text, token)
      if (inTitle + inText > 0) covered += 1
      hits += inTitle * 3 + inText
    }
    if (covered === 0) continue
    // 靠前的小节更像「这页在讲什么」：越往后越可能是补充、反例、边角。给一点微弱的顺位分，
    // 只在命中密度接近时起作用。
    const positionBonus = (pool.length - index) / pool.length * 6
    const score = covered * 10 + Math.min(hits, 30) + positionBonus
    if (score > bestScore) {
      bestScore = score
      best = section
    }
  }
  return best
}

/**
 * 挑命中最密的一节交给模型。
 *
 * 先按「命中了几种检索词」排（覆盖广度比出现次数更能说明这一节在讲什么），再按次数。
 * 清单类小节先排除：`§元信息` 里列着 `03-第一讲-要点.md` 这种文件名，词频很高但
 * 一个字都没回答「立意怎么写」，早先版本就是被它抢了头名。
 *
 * 但排除不等于「宁缺毋滥」：如果排除后一个都没命中，得回头在被排除的小节里找，
 * 而不是拿 realPool[0] 顶上 —— 那是一个从未参与打分的无关小节，模型会当成「找到了」。
 */
function pickSection(page, tokens) {
  const sections = page.sections
  if (sections.length === 0) return { title: '', text: page.body }
  const candidates = sections.filter((section) => section.title !== '' && !isBoilerplate(section.title))
  const pool = candidates.length > 0 ? candidates : sections.filter((section) => section.title !== '')
  const realPool = pool.length > 0 ? pool : sections

  const primary = bestSectionIn(realPool, tokens)
  if (primary !== null) return primary

  // 命中的词只落在清单类小节里：给那一节，至少它含查询词
  const excluded = sections.filter((section) => section.title !== '' && isBoilerplate(section.title))
  const fromExcluded = bestSectionIn(excluded, tokens)
  if (fromExcluded !== null) return fromExcluded

  // 真的一个词都没出现（比如这一页只靠标签/别名命中）：给首节，但调用方会看到空命中
  return realPool[0]
}

function clip(text, limit) {
  const value = String(text ?? '')
  if (limit <= 0 || value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

function buildIndexMap(corpus) {
  const map = new Map()
  for (const line of corpus.indexLines) {
    if (!map.has(line.name)) map.set(line.name, line)
  }
  return map
}

/**
 * 超大页没有正文可比（只记了元数据），所以「相关性」只能看页名与 index 摘要。
 * 这是「有没有可能相关」的线索，不是正文检索 —— 标题和摘要没命中，
 * 不能反推正文没命中；这也是 no_match 只能表示「当前可检索范围未命中」的原因。
 */
function oversizedRelevance(corpus, tokens, indexMap) {
  let total = 0
  let byTitle = 0
  let bySummary = 0
  for (const page of corpus.pages) {
    if (page.oversized !== true) continue
    const title = page.name.toLowerCase()
    const summary = String(indexMap.get(page.name)?.summary ?? '').toLowerCase()
    const titleHit = tokens.some((token) => title.includes(token.toLowerCase()))
    const summaryHit = tokens.some((token) => summary.includes(token.toLowerCase()))
    if (!titleHit && !summaryHit) continue
    total += 1
    if (titleHit) byTitle += 1
    if (summaryHit) bySummary += 1
  }
  const via = byTitle > 0 && bySummary > 0 ? '标题与摘要' : byTitle > 0 ? '标题' : bySummary > 0 ? '摘要' : ''
  return { total, via }
}

// 字面覆盖率兜底的阈值，与 search.py 的 COVERAGE_MIN 取同一个数。
// 低于这条线不是「相关性弱」，是「根本不像在说同一件事」，放进结果里只会骗人。
const COVERAGE_MIN = 0.45
// 查询长度上限，与工具层 schema 的意思对齐（那边拦的是模型，这里拦的是 CLI / /search / 桥）。
const MAX_QUERY_CHARS = 200
const CJK_RE = /[\u3400-\u9fff]/

/**
 * 把查询切成「字面原子」：中文按二字组、拉丁按整词。
 *
 * 为什么需要这一步：中文没有空格，一句「甲方案的实施顺序应该怎么安排」在 tokenize 眼里
 * 就是**一个词元**，而库里不可能逐字出现这句话，于是 AND、OR 双双落空。用户看到的是
 * 「库里没有」，可库里明明有一页在讲这件事。search.py 的降级层就是干这个的，
 * 这里补上同一层，只在前面全落空时才启用。
 */
function coverageAtomsOf(text) {
  const atoms = []
  const seen = new Map()
  const push = (atom, weight) => {
    const previous = seen.get(atom) ?? 0
    if (previous >= weight) return
    if (previous === 0) atoms.push(atom)
    seen.set(atom, weight)
  }
  for (const chunk of String(text).match(/[\u3400-\u9fff]+|[A-Za-z0-9][A-Za-z0-9._+#-]*/g) ?? []) {
    if (CJK_RE.test(chunk)) {
      if (chunk.length === 1) push(chunk, 1)
      else for (let i = 0; i < chunk.length - 1; i += 1) push(chunk.slice(i, i + 2), 1)
    } else {
      // 一个拉丁词比一个二字组信息量大：权重 3，与 search.py 的整段权重对齐
      push(chunk.toLowerCase(), 3)
    }
  }
  return atoms.map((atom) => ({ atom, weight: seen.get(atom) ?? 1 }))
}

/**
 * 覆盖率通道：不要求整句出现，只要求「查询里的字面片段在这页出现了多少」。
 * 分数刻意做成覆盖率 × 100 + 结构加分，量级远低于正常命中（页名全等 120），
 * 所以它永远排在真命中后面 —— 这一层只负责「别报空」。
 */
function coveragePass(corpus, tokens, { typeFilter, tagFilter }) {
  const atoms = coverageAtomsOf(tokens.join(' '))
  const totalWeight = atoms.reduce((sum, item) => sum + item.weight, 0)
  if (atoms.length === 0 || totalWeight === 0) return []
  const indexMap = buildIndexMap(corpus)
  const out = []
  for (const page of corpus.pages) {
    if (page.oversized === true) continue
    if (typeFilter !== null && String(page.fields['类型'] ?? '') !== typeFilter) continue
    if (tagFilter.length > 0) {
      const pageTags = asList(page.fields['标签'])
      if (!tagFilter.some((tag) => matchesTag(pageTags, tag))) continue
    }
    const body = page.body.toLowerCase()
    const title = page.name.toLowerCase()
    const aliasText = asList(page.fields['别名']).join(' ').toLowerCase()
    const tagText = asList(page.fields['标签']).join(' ').toLowerCase()
    let hitWeight = 0
    const hitAtoms = []
    for (const { atom, weight } of atoms) {
      if (!body.includes(atom)) continue
      hitWeight += weight
      hitAtoms.push(atom)
    }
    const coverage = hitWeight / totalWeight
    if (coverage < COVERAGE_MIN) continue
    let bonus = 0
    if (hitAtoms.some((atom) => title.includes(atom))) bonus += 20
    if (hitAtoms.some((atom) => aliasText.includes(atom))) bonus += 10
    if (hitAtoms.some((atom) => tagText.includes(atom))) bonus += 5
    out.push({
      page,
      indexLine: indexMap.get(page.name) ?? null,
      score: Math.round(coverage * 100) + bonus,
      matched: hitAtoms.length,
      allTerms: false,
      atoms: hitAtoms,
    })
  }
  return out
}

/**
 * mode 2：search
 * 返回 hits（按分数降序），每项带索引摘要、命中小节正文、citation、断链。
 */
export function search(corpus, query, options = {}) {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return { mode: 'search', query, total: 0, tokens: [], hits: [], note: '空查询' }
  }
  const indexMap = buildIndexMap(corpus)
  const limit = intOption(options, 'limit', 5, 1, 12)
  const sectionChars = intOption(options, 'sectionChars', DEFAULT_SECTION_CHARS, 120, 3000)
  const typeFilter = typeof options.type === 'string' && options.type.trim() !== '' ? options.type.trim() : null
  const tagFilter = asList(options.tags)
  // explain 只多带「这分怎么来的」，不参与打分与排序；工具 schema 里没有这个开关，
  // 它只给设置页/侧栏那份只读 API 用，模型看不到也多不出 token。
  const explain = options.explain === true

  const scored = []
  // 每个词在多少页上真正拿到分 —— 用来回答「这个词到底有没有用上」，
  // 以及「没命中的是词太少，还是库没写到」。
  const termPages = new Map(tokens.map((token) => [token, 0]))
  // 分母要分开记：扫描了多少页、过滤后真正参与打分的多少页、命中的多少页、最后返回多少条。
  // 只报一个「扫描 90 页，12 命中」，读起来像 90 页都比过了。
  let considered = 0
  for (const page of corpus.pages) {
    if (page.oversized === true) continue
    if (typeFilter !== null && String(page.fields['类型'] ?? '') !== typeFilter) continue
    if (tagFilter.length > 0) {
      const pageTags = asList(page.fields['标签'])
      if (!tagFilter.some((tag) => matchesTag(pageTags, tag))) continue
    }
    considered += 1
    const indexLine = indexMap.get(page.name) ?? null
    let total = 0
    let matched = 0
    for (const token of tokens) {
      let score = termScore(page, token)
      if (score === 0 && indexLine !== null && indexLine.summary.toLowerCase().includes(token.toLowerCase())) {
        score = INDEX_ONLY_SCORE
      }
      total += score
      if (score > 0) {
        matched += 1
        termPages.set(token, termPages.get(token) + 1)
      }
    }
    if (matched === 0) continue
    scored.push({ page, indexLine, score: total, matched, allTerms: matched === tokens.length })
  }

  // AND 优先；一条 AND 都没有时降级为 OR，并在结果里说明，别让模型以为「库里没有」。
  // 注意：OR 也一条没有时不算「降级」——那是真的没命中，标 degraded 反而误导。
  let degraded = false
  let list = scored.filter((item) => item.allTerms)
  if (list.length === 0) {
    degraded = scored.length > 0
    list = scored
  }

  // 最后一道兜底：AND 和 OR 都一条没有，但查询本身是「一句话」时，用字面覆盖率再找一遍。
  // 只在结果为 0 时启用 —— 有任何一条真命中就不碰，所以它不可能把好结果挤掉。
  let coverageFallback = false
  if (list.length === 0) {
    const covered = coveragePass(corpus, tokens, { typeFilter, tagFilter })
    if (covered.length > 0) {
      coverageFallback = true
      degraded = true
      list = covered
    }
  }

  list.sort(compareHits)

  // 覆盖率通道下，整句作为一个词元在正文里必然找不到，选节会退化成「取第一段」。
  // 改用命中的字面片段去选节：pickSection 本身没动，只是换了喂进去的词。
  const sectionTokensOf = (item) => (coverageFallback ? item.atoms ?? tokens : tokens)

  const hits = list.slice(0, limit).map((item) => {
    const section = pickSection(item.page, sectionTokensOf(item))
    // 断链按整页算，不按命中小节算：选节会把页面截成一段，断链常落在文末的「相关」里，
    // 只报小节内的会让模型把「这一页没有断链」当成结论 —— README 给它的语义是页级硬信号。
    // 复用 corpus 已经解析好的 page.links，而不是在这里再扫一遍正文：
    // 那边会跳过行内代码里的 `[[示例]]`（那是举例，不是链接），这边自己扫就会把示例当红链。
    const broken = [...new Set(item.page.links ?? [])]
      .filter((link) => !corpus.byName.has(link) && !corpus.byAlias.has(link.toLowerCase()))
    return {
      name: item.page.name,
      kind: pageKind(item.page),
      type: String(item.page.fields['类型'] ?? ''),
      status: String(item.page.fields['状态'] ?? ''),
      sources: typeof item.page.fields['来源数量'] === 'number' ? item.page.fields['来源数量'] : null,
      updated: String(item.page.fields['更新'] ?? ''),
      tags: asList(item.page.fields['标签']),
      aliases: asList(item.page.fields['别名']),
      score: item.score,
      allTerms: item.allTerms,
      gist: extractGist(item.page.body),
      summary: item.indexLine?.summary ?? '',
      section: { title: section.title, text: clip(section.text, sectionChars) },
      citation: `← [[${item.page.name}]]${section.title === '' ? '' : ` §${section.title}`} → ${item.page.file}`,
      brokenLinks: broken,
      file: item.page.file,
      ...(explain ? { termHits: explainTerms(item.page, item.indexLine, tokens) } : {}),
    }
  })

  const oversized = oversizedRelevance(corpus, tokens, indexMap)

  // 单字查询命中过半页时，排序确实没有区分度（「的」「a」会命中几乎整库）。
  // 不改结果——改了就是动排序，那是 §13.1 的地界；但必须让模型知道这批结果别当真。
  const trivialQuery = tokens.length === 1 && tokens[0].length <= 1 && considered > 20 && scored.length >= considered * 0.5

  // 过滤器把候选清空时，「这次没命中」和「库里根本没这种页」是两件事。
  // 不说清楚，模型会把「库里没有资料类型的页」读成「库里没有这个主题」。
  // 还有第三种：过了滤、也有页参与，但整句一页都没命中 —— 那时同样得说话，
  // 否则「词不对」和「命中页被 type 过滤掉了」在模型看来长得一模一样（真库实测过）。
  const filterApplied = typeFilter !== null || tagFilter.length > 0
  const filterNote = !filterApplied
    ? ''
    : considered === 0
      ? filterEmptyNote(corpus, typeFilter, tagFilter)
      : (scored.length === 0 && list.length === 0
          ? `过滤后仍有 ${considered} 页参与检索，但整句没有命中任何一页（字面覆盖率兜底 ${Math.round(COVERAGE_MIN * 100)}% 也没过）。这可能是词不对，也可能命中的页被 type/tags 过滤掉了——去掉过滤再搜一次就能分开。`
          : '')

  return {
    mode: 'search',
    query,
    tokens,
    // 查询诊断：引擎实际拿哪几个词去找的、哪几个词一页都没沾到、用的是 AND 还是 OR。
    // 这三件事决定「结果为空」该怪词、怪库，还是怪匹配模式。
    // missedTerms / matchMode 常驻（模型看到「这个词没用上」才可能换词重查，成本两个短字段）；
    // 每个词在多少页上得分的明细只有 explain 时才给，那是面板的事。
    // 覆盖率兜底下调时不能报「这些词一页都没命中」——命中正是靠这些词的字面片段捞到的，
    // 两句话放在一起自相矛盾，note 里已经交代清楚。
    missedTerms: coverageFallback ? [] : tokens.filter((token) => (termPages.get(token) ?? 0) === 0),
    matchMode: degraded ? 'or' : 'and',
    // 覆盖率兜底是 or 的下一层（仍标 matchMode/or 以保持面板与既有断言的两值语义），
    // 但必须单独标出来：这时候「命中」只是字面沾边，精度比 OR 更低，模型叙述时要收着写。
    coverageFallback,
    trivialQuery,
    ...(explain ? { termPages: tokens.map((token) => ({ term: token, pages: termPages.get(token) ?? 0 })) } : {}),
    total: list.length,
    degraded,
    // 调用级统计：分母各是各的，别合成一个数字
    considered,
    matched: coverageFallback ? list.length : scored.length,
    allTerms: scored.filter((item) => item.allTerms).length,
    returned: hits.length,
    // 超大页里「标题或 index 摘要」沾到查询词的数量：决定这次要不要提醒覆盖缺口，
    // 不参与命中与排序 —— 它只是元数据线索，不是正文检索结果
    oversizedRelevant: oversized.total,
    oversizedRelevantVia: oversized.via,
    hits,
    note: filterNote
      || (coverageFallback
        ? `整句没有命中任何页（中文不分词，"${query}" 被当成一个词元），已降级为字面覆盖率匹配（≥${Math.round(COVERAGE_MIN * 100)}%）。结果只作线索：命中是字面沾边，不是这页回答了你。`
        : degraded
          ? '没有同时命中全部检索词，已降级为 OR（命中任一）：命中面变宽、精度下降'
          : trivialQuery
            ? `查询只有一个字（"${tokens[0]}"），它在这 ${considered} 页里出现了 ${scored.length} 页——这个字到处都有，排序没有区分度。换个更具体的词再搜。`
            : ''),
  }
}

/** 过滤器把候选清空时，说清楚是「库里没这种页」而不是「库里没这个主题」。 */
function filterEmptyNote(corpus, typeFilter, tagFilter, statusFilter = null) {
  const dist = new Map()
  const statuses = new Map()
  for (const page of corpus.pages) {
    if (page.oversized === true) continue
    const type = String(page.fields['类型'] ?? '') || '(无类型)'
    dist.set(type, (dist.get(type) ?? 0) + 1)
    const status = String(page.fields['状态'] ?? '') || '(无状态)'
    statuses.set(status, (statuses.get(status) ?? 0) + 1)
  }
  const tally = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([key, count]) => `${key} ${count}`)
    .join(' / ')
  const asked = [
    typeFilter === null ? '' : `type=${typeFilter}`,
    statusFilter === null ? '' : `status=${statusFilter}`,
    tagFilter.length === 0 ? '' : `tags=${tagFilter.join('/')}`,
  ].filter((part) => part !== '').join(' ')
  const typeShown = tally(dist)
  const statusShown = tally(statuses)
  return `库里没有符合 ${asked} 的页（现有类型：${typeShown === '' ? '无' : typeShown}${statusFilter === null ? '' : `；现有状态：${statusShown === '' ? '无' : statusShown}`}）。这是过滤条件的问题，不是主题不存在——去掉过滤再搜。`
}

/** mode 2：page —— 按页名/别名/模糊取整页。取不到就给最像的 5 个候选。 */
export function page(corpus, name, options = {}) {
  const wanted = String(name ?? '').trim()
  const limit = intOption(options, 'pageChars', DEFAULT_PAGE_CHARS, 500, 20000)
  if (wanted === '') return { mode: 'page', found: null, candidates: [] }

  const indexMap = buildIndexMap(corpus)
  const exact = corpus.byName.get(wanted) ?? corpus.byName.get(wanted.replace(/\.md$/i, ''))
  if (exact !== undefined) {
    const found = renderPage(corpus, exact, indexMap, limit)
    const note = pageBodyNote(found)
    return { mode: 'page', found, candidates: [], ...(note === '' ? {} : { note }) }
  }

  const aliasHits = corpus.byAlias.get(wanted.toLowerCase()) ?? []
  if (aliasHits.length > 0) {
    const first = aliasHits[0]
    return {
      mode: 'page',
      found: renderPage(corpus, first, indexMap, limit),
      candidates: [],
      // 别名是检索入口，被两页共用时「按名字取页」就是抛硬币 —— 必须点名，别让引用悄悄指错。
      ...(aliasHits.length > 1
        ? { note: aliasCollisionNote(aliasHits, first, wanted), aliasConflict: true }
        : {}),
    }
  }

  // 模糊：包含关系 → 相似度
  const scored = corpus.pages
    .filter((p) => p.oversized !== true)
    .map((p) => {
      const lower = p.name.toLowerCase()
      const target = wanted.toLowerCase()
      let score = 0
      if (lower.includes(target) || target.includes(lower)) score += 60
      score += bigramSimilarity(lower, target) * 100
      return { page: p, score }
    })
    .filter((item) => item.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  return {
    mode: 'page',
    found: null,
    wanted,
    candidates: scored.map((item) => ({
      name: item.page.name,
      type: String(item.page.fields['类型'] ?? ''),
      updated: String(item.page.fields['更新'] ?? ''),
      summary: indexMap.get(item.page.name)?.summary ?? '',
      score: Math.round(item.score),
    })),
    note: scored.length === 0 ? '没有任何页与这个名称相近' : '页名没精确命中，下面是候选；确认后把候选名当 name 再查一次',
  }
}

/** 命中的页没有正文时会话里最容易出的错：模型引用一个空页当依据。 */
function pageBodyNote(found) {
  const body = typeof found?.body === 'string' ? found.body.trim() : ''
  return body === '' ? '这页没有正文（只有 frontmatter 或文件是空的）：别把它当依据，回到原始资料或换一页' : ''
}

/** 别名被多页共用：按别名取页等于抛硬币，点名让人改。 */
function aliasCollisionNote(aliasHits, chosen, wanted) {
  const names = aliasHits.map((item) => `${item.name}（${item.file}）`).join('、')
  return `别名「${wanted}」被 ${aliasHits.length} 页共用：${names}；这次给的是 ${chosen.name}。引用前先确认是哪一篇，或把别名改成唯一。`
}

function renderPage(corpus, page, indexMap, limit) {
  const body = clip(page.body, limit)
  return {
    name: page.name,
    type: String(page.fields['类型'] ?? ''),
    status: String(page.fields['状态'] ?? ''),
    sources: typeof page.fields['来源数量'] === 'number' ? page.fields['来源数量'] : null,
    created: String(page.fields['创建'] ?? ''),
    updated: String(page.fields['更新'] ?? ''),
    tags: asList(page.fields['标签']),
    aliases: asList(page.fields['别名']),
    summary: indexMap.get(page.name)?.summary ?? '',
    sections: page.sections.map((section) => section.title).filter((title) => title !== ''),
    body,
    truncated: body.length < page.body.length,
    citation: `← [[${page.name}]] → ${page.file}`,
    file: page.file,
  }
}

/** mode 3：list —— 按类型/标签/状态列目录，替代「每次读 1.5k token 的 index.md」。 */
export function list(corpus, options = {}) {
  const typeFilter = typeof options.type === 'string' && options.type.trim() !== '' ? options.type.trim() : null
  const statusFilter = typeof options.status === 'string' && options.status.trim() !== '' ? options.status.trim() : null
  const tagFilter = asList(options.tags)
  const indexMap = buildIndexMap(corpus)

  const rows = corpus.pages
    .filter((p) => p.oversized !== true)
    .filter((p) => typeFilter === null || String(p.fields['类型'] ?? '') === typeFilter)
    .filter((p) => statusFilter === null || String(p.fields['状态'] ?? '') === statusFilter)
    .filter((p) => tagFilter.length === 0 || tagFilter.some((tag) => matchesTag(asList(p.fields['标签']), tag)))
    .map((p) => ({
      name: p.name,
      type: String(p.fields['类型'] ?? ''),
      status: String(p.fields['状态'] ?? ''),
      sources: typeof p.fields['来源数量'] === 'number' ? p.fields['来源数量'] : null,
      updated: String(p.fields['更新'] ?? ''),
      summary: indexMap.get(p.name)?.summary ?? '',
      file: p.file,
    }))
    .sort((a, b) => (b.sources ?? -1) - (a.sources ?? -1) || a.name.localeCompare(b.name, 'zh'))

  const byType = {}
  for (const row of rows) byType[row.type || '(无类型)'] = (byType[row.type || '(无类型)'] ?? 0) + 1

  // 上限 200：目录是给人扫一眼的，再多也不该一口气塞进上下文。
  const limit = intOption(options, 'limit', 40, 1, 200)
  const shown = rows.slice(0, limit)

  // 空目录同样要区分「库里没这种页」与「库里没这个东西」：list 的调用方拿到的是一张空表，
  // 不给一句话它只能猜。与 search 的 filterEmptyNote() 同一套说法，维度多一个 status。
  const filtered = typeFilter !== null || statusFilter !== null || tagFilter.length > 0
  const note = rows.length === 0 && filtered
    ? filterEmptyNote(corpus, typeFilter, tagFilter, statusFilter)
    : ''

  return {
    mode: 'list',
    total: rows.length,
    shown: shown.length,
    truncated: shown.length < rows.length,
    byType,
    scale: corpus.scaleLine,
    rows: shown,
    ...(note === '' ? {} : { note }),
  }
}

/** mode 4：overview —— 全库当前状态：总览正文 + 规模行 + 最近日志 + 健康计数。 */
export function overview(corpus, options = {}) {
  const indexMap = buildIndexMap(corpus)
  const overviewPage = corpus.byName.get('总览-overview') ?? corpus.byName.get('总览')
  const logLimit = intOption(options, 'logLimit', 5, 1, 20)
  const recentLog = corpus.log.slice(-logLimit).map((entry) => ({
    date: entry.date, type: entry.type, title: entry.title,
  }))

  // index.md 与磁盘的一致性：index 登记了但磁盘上没有的页（红链的另一种来源），
  // 以及磁盘上有却没登记的页（新写的东西忘了进目录）。这两项是免费的库健康信号。
  const diskNames = new Set(corpus.pages.map((page) => page.name))
  const indexNames = new Set(corpus.indexLines.map((line) => line.name))
  const indexOnly = corpus.indexLines.map((line) => line.name).filter((name) => !diskNames.has(name))
  // 总览页是 overview 模式的数据源，本来就不该出现在「按主题分组的目录」里 —— 别报成漏登记
  const overviewName = overviewPage?.name ?? ''
  const diskOnly = corpus.pages
    .map((page) => page.name)
    .filter((name) => !indexNames.has(name) && name !== overviewName)

  return {
    mode: 'overview',
    scale: corpus.scaleLine,
    stats: {
      pages: corpus.stats.pages,
      resources: corpus.stats.resources,
      brokenPages: corpus.stats.brokenPages,
      brokenTotal: corpus.stats.brokenTotal,
      // 库级缺陷在总览里如实报，但不拿它去污染单次检索的状态
      oversized: corpus.stats.oversized ?? 0,
      scannedMs: corpus.stats.scannedMs,
      duplicateNames: corpus.stats.duplicateNames ?? [],
    },
    consistency: {
      indexOnly: [...new Set(indexOnly)].slice(0, 10),
      indexOnlyTotal: new Set(indexOnly).size,
      diskOnly: [...new Set(diskOnly)].slice(0, 10),
      diskOnlyTotal: new Set(diskOnly).size,
    },
    overview: overviewPage === undefined ? null : {
      name: overviewPage.name,
      body: clip(overviewPage.body, intOption(options, 'pageChars', 4000, 1000, 20000)),
      citation: `← [[${overviewPage.name}]] → ${overviewPage.file}`,
      sections: overviewPage.sections.map((section) => section.title).filter((title) => title !== ''),
      summary: indexMap.get(overviewPage.name)?.summary ?? '',
    },
    recentLog,
    broken: corpus.brokenLinks.slice(0, 10),
  }
}

/** 每个页面至少该有的 frontmatter 字段（缺了会让排序、证据强度判断失真）。 */
const REQUIRED_FIELDS = ['类型', '状态', '标签', '更新']

/** 没推断出目录时的兜底顺序：与 karpathy 原文的 wiki 分层一致（概念/实体/对比/综合/资料）。 */
const DEFAULT_TYPE_DIRS = {
  概念: '概念-concepts',
  实体: '实体-entities',
  对比: '对比-comparisons',
  综合: '综合-syntheses',
  资料: '资料-sources',
}

/** 从现有页面的真实路径反推「类型 → 目录」，别把目录名写死。 */
function inferTypeDirs(corpus) {
  const votes = new Map()
  for (const page of corpus.pages) {
    const type = typeof page.fields['类型'] === 'string' ? page.fields['类型'] : ''
    const parts = String(page.file ?? '').split(/[\\/]/)
    if (type === '' || parts.length < 2) continue
    const dir = parts[parts.length - 2]
    if (dir === '' || dir === '.') continue
    const counter = votes.get(type) ?? new Map()
    counter.set(dir, (counter.get(dir) ?? 0) + 1)
    votes.set(type, counter)
  }
  const result = new Map()
  for (const [type, counter] of votes) {
    const best = [...counter.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
    if (best !== undefined) result.set(type, best[0])
  }
  return result
}

/** 本地日期 YYYY-MM-DD。不能用 toISOString —— 那是 UTC，本机凌晨 0–8 点会差一天。 */
export function getLocalDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 「更新」字段 → 模型能用的判断。
 *
 * 只写一个 2025-03-14，模型没法判断该不该信：三年前的结论和上周的结论长得一样。
 * 所以补上距今天数，超过半年直接说「可能已过时」。
 * 这个信息 compareHits 一直在用（排序第五级就是 updated），但从来没渲染出去 ——
 * 排了序、却不告诉模型为什么这么排。
 */
export function freshnessOf(updated, now = Date.now()) {
  const text = String(updated ?? '').trim()
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!match) return text
  const stamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  if (!Number.isFinite(stamp)) return text
  const days = Math.floor((now - stamp) / 86400000)
  if (!Number.isFinite(days) || days < 0) return text // 未来日期不解释，原样输出
  if (days === 0) return `${text}（今天更新）`
  if (days === 1) return `${text}（昨天更新）`
  if (days < 31) return `${text}（${days} 天前）`
  if (days <= 180) return `${text}（${Math.floor(days / 30)} 个月前）`
  return `${text}（${Math.floor(days / 30)} 个月前，可能已过时）`
}

/**
 * 日志事件类型：不强制枚举（query / ingest / 拍板 / 结构补齐…本来该由调用方表达），
 * 只挡住会破坏 `## [日期] 类型 | 标题` 这一行结构的东西。
 */
function normalizeLogType(value) {
  const text = String(value ?? '').trim()
  if (text === '' || text.length > 24) return 'query'
  if (/[\r\n|]/.test(text)) return 'query' // 换行或竖线会把 log 的第二个分隔符顶掉
  return text
}

/**
 * mode 6：draft —— 给「把这次的好答案回写成新页」生成落盘骨架（仍然只读，不写任何文件）。
 *
 * 对应 karpathy「LLM Wiki」原文 Query 一节：good answers can be filed back into the wiki
 * as new pages，否则一次探索就消失在聊天记录里。回写真正的难点不是写正文，而是
 * frontmatter 七个字段、该放哪个目录、index.md 那一行的格式、log.md 那条的格式 ——
 * 这些都由本函数按库里现有约定现推，模型照着填就行。
 */
export function draft(corpus, options = {}) {
  const title = String(options.title ?? options.name ?? options.query ?? '').trim()
  if (title === '') return { error: 'mode=draft 需要一个 title（新页的名字）' }

  const typeDirs = inferTypeDirs(corpus)
  const type = String(options.type ?? '').trim() || '概念'
  const dir = typeDirs.get(type) ?? DEFAULT_TYPE_DIRS[type] ?? DEFAULT_TYPE_DIRS['概念']
  // 日期只算一次，四处复用（frontmatter 创建/更新、indexLine、logLine）。
  // 分别取四次的话，迟早出现「创建 03 号、log 02 号」这种自相矛盾的骨架。
  const date = getLocalDate(Number.isFinite(Number(options.now)) ? new Date(Number(options.now)) : new Date())
  // draft 是操作模式，logType 是日志事件类型（query / ingest / 拍板…），两件事不能混
  const logType = normalizeLogType(options.logType)

  const tags = asList(options.tags)
  const aliases = asList(options.alias ?? options.aliases)
  const sources = Number.isFinite(Number(options.sources)) ? Number(options.sources) : 0
  const summary = String(options.summary ?? '').trim()
  const file = `${dir}/${title}.md`

  // 同名页已经存在时，回写会覆盖旧内容 —— 必须先在结果里警告，而不是让人写完才发现
  const existing = corpus.byName.get(title) ?? corpus.byAlias.get(title) ?? null

  const frontmatter = [
    '---',
    `类型: ${type}`,
    '状态: 草稿',
    `标签: [${tags.join(', ')}]`,
    `别名: [${aliases.join(', ')}]`,
    `来源数量: ${sources}`,
    `创建: ${date}`,
    `更新: ${date}`,
    '---',
  ].join('\n')

  const body = [
    `# ${title}`,
    '',
    `> 一句话总结：${summary === '' ? '（一句话说清这页讲什么）' : summary}`,
    '',
    '## 结论',
    '',
    '（先说结论。）',
    '',
    '## 依据',
    '',
    '（正文里用 [[双链]] 指向已有页；缺少的页会在 lint 里报成红链。）',
  ].join('\n')

  return {
    mode: 'draft',
    title,
    type,
    dir,
    file,
    exists: existing === null ? null : { name: existing.name, file: existing.file },
    frontmatter,
    body,
    date,
    logType,
    indexLine: `- [[${title}]] — ${summary === '' ? '（一句话摘要）' : summary}（${sources} 份资料，更新于 ${date}）`,
    logLine: `## [${date}] ${logType} | ${title}`,
  }
}

/** 总览页天然没有入链来源，不算孤儿。 */
const OVERVIEW_NAMES = new Set(['总览-overview', '总览'])

/**
 * mode 5：lint —— 库健康检查，纯只读。
 *
 * 对应 karpathy「LLM Wiki」原文里的第三个操作 Lint：查孤儿页、断链、缺字段、
 * 别名冲突、久未更新、单页无出链。原文还提到「页面间矛盾」「被新资料推翻的旧结论」
 * 和「被提到但没有独立页的概念」——前两项要读懂内容才能判断，不是本函数能做到的，
 * 这里只报可机械判定的部分（红链本身就是「被提到但没成页」的硬信号）。
 */
export function lint(corpus, options = {}) {
  const limit = intOption(options, 'limit', 8, 1, 40)
  const staleDays = intOption(options, 'staleDays', 120, 1, 3650)
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()

  // 超大文件只记了元数据（没读正文），拿它去比对「缺字段 / 无出链 / 孤儿」全是噪音：
  // 单独列一项「未读入的大文件」，其余检查一律只看真正读进来的页。
  const readable = corpus.pages.filter((page) => page.oversized !== true)
  const oversized = corpus.pages.filter((page) => page.oversized === true).map((page) => page.name)

  // 入链：别人正文里 [[X]] 指向它。X 可能是页名，也可能是别名 ——
  // 别名命中时必须记在「拥有这个别名的那一页」名下，否则被别名引用的页会被误报成孤儿。
  const inbound = new Map()
  for (const page of corpus.pages) {
    for (const link of page.links) {
      if (link === page.name) continue
      const owners = corpus.byAlias.get(link.toLowerCase()) ?? []
      const target = corpus.byName.has(link) ? link : owners[0]?.name
      if (target === undefined || target === page.name) continue
      inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }
  const orphans = readable
    .filter((page) => !OVERVIEW_NAMES.has(page.name))
    .filter((page) => (inbound.get(page.name) ?? 0) === 0)
    .map((page) => page.name)

  // 红链按「没人接的名字」聚合：同一个缺口被引用得越多，越该补页
  const brokenCount = new Map()
  for (const entry of corpus.brokenLinks) {
    for (const name of entry.missing) brokenCount.set(name, (brokenCount.get(name) ?? 0) + 1)
  }
  const brokenTargets = [...brokenCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, pages]) => ({ name, pages }))

  const missingFields = readable
    .map((page) => ({
      name: page.name,
      missing: REQUIRED_FIELDS.filter((field) => page.fields[field] === undefined || page.fields[field] === ''),
    }))
    .filter((row) => row.missing.length > 0)

  // 一个别名指向多个页时，检索排序会随文件顺序漂移，必须报出来
  const aliasGroups = new Map()
  for (const page of readable) {
    for (const alias of asList(page.fields['别名'])) {
      const owners = aliasGroups.get(alias) ?? []
      owners.push(page.name)
      aliasGroups.set(alias, owners)
    }
  }
  const aliasConflicts = [...aliasGroups.entries()]
    .map(([alias, owners]) => ({ alias, pages: [...new Set(owners)] }))
    .filter((row) => row.pages.length > 1)

  const stale = []
  for (const page of readable) {
    const raw = page.fields['更新']
    if (typeof raw !== 'string' || raw.length < 10) continue
    const time = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`)
    if (!Number.isFinite(time)) continue
    const days = Math.floor((now - time) / 86400000)
    if (days > staleDays) stale.push({ name: page.name, updated: raw.slice(0, 10), days })
  }
  stale.sort((a, b) => b.days - a.days)

  const noLinks = readable.filter((page) => page.links.length === 0).map((page) => page.name)
  const drafts = readable.filter((page) => page.fields['状态'] === '草稿').map((page) => page.name)

  // index.md 与磁盘的两侧差异（与 overview 保持一致的口径）
  const diskNames = new Set(corpus.pages.map((page) => page.name))
  const indexNames = new Set(corpus.indexLines.map((line) => line.name))
  const indexOnly = [...new Set(corpus.indexLines.map((line) => line.name).filter((name) => !diskNames.has(name)))]
  const diskOnly = readable
    .map((page) => page.name)
    .filter((name) => !indexNames.has(name) && !OVERVIEW_NAMES.has(name))

  return {
    mode: 'lint',
    staleDays,
    stats: {
      pages: corpus.stats.pages,
      resources: corpus.stats.resources,
      scannedMs: corpus.stats.scannedMs,
      brokenPages: corpus.stats.brokenPages,
      brokenTotal: corpus.stats.brokenTotal,
    },
    counts: {
      orphans: orphans.length,
      broken: brokenTargets.length,
      missingFields: missingFields.length,
      aliasConflicts: aliasConflicts.length,
      stale: stale.length,
      noLinks: noLinks.length,
      drafts: drafts.length,
      indexOnly: indexOnly.length,
      diskOnly: diskOnly.length,
      oversized: oversized.length,
    },
    orphans: orphans.slice(0, limit),
    brokenTargets: brokenTargets.slice(0, limit),
    missingFields: missingFields.slice(0, limit),
    aliasConflicts: aliasConflicts.slice(0, limit),
    stale: stale.slice(0, limit),
    noLinks: noLinks.slice(0, limit),
    drafts: drafts.slice(0, limit),
    oversized: oversized.slice(0, limit),
    consistency: { indexOnly: indexOnly.slice(0, limit), diskOnly: diskOnly.slice(0, limit) },
  }
}

function bigramSimilarity(a, b) {
  if (a === b) return 1
  const grams = (text) => {
    const set = new Set()
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const gram of ga) if (gb.has(gram)) shared += 1
  return (2 * shared) / (ga.size + gb.size)
}

/* ----------------------- 调用级：参数校验、状态与警告 ----------------------- */

/**
 * help：把「这个工具怎么用」做成可查的内容。
 *
 * 工具描述是每回合都要付的固定成本，机制文档只在模型真的要问时付一次。
 * 而且描述写不全、写多了都一样有害：写不全模型猜错模式，写太满挤占别的东西。
 * 这里的内容只讲「怎么用」，不讲这个库有什么 —— 后者是 overview 的事。
 */
export function help() {
  return {
    mode: 'help',
    sections: [
      {
        title: '它是什么',
        lines: [
          '一个只读的本地知识库检索器：给关键词，返回库里最相关的几页，附命中小节正文与出处。',
          '不改文件、不联网、不生成内容。要写新页先用 mode:"draft" 拿骨架，再自己落盘。',
        ],
      },
      {
        title: '七个 mode',
        lines: [
          'help：就是这份说明。不确定用哪个 mode、或看不懂某个 status 时先查它 —— 它不读库，不会失败。',
          'search（默认）：1-4 个核心名词，空格分隔做 AND。返回元数据 + index 摘要 + 命中小节正文 + 出处，通常一次就够作答。',
          'page：传页名取整页；没精确命中会给 5 个候选。',
          'list：按 type / tags / status 列目录，比读 index.md 省 token。',
          'overview：总览正文 + 规模 + 最近日志 + 断链统计。',
          'lint：全库健康检查 —— 孤儿页、断链、缺字段、别名冲突、久未更新、草稿、index 与磁盘不一致。',
          'draft：给一份落盘骨架（目录、frontmatter、index 那行、log 那条），只返回文本。',
        ],
      },
      {
        title: 'status 怎么读',
        lines: [
          'ok：正常，内容可信。',
          'degraded：只有部分检索词命中，已降级成 OR —— 命中面变宽、精度下降，答案要点可能偏。',
          'partial：看到的不全（有页读不出来 / 目录列不出 / 超大页没参与 / 有同名页）。warnings 说漏了什么。',
          'no_match：参与比对的页里没有命中。**不能反推全库没有**，换词组或 list 看命名习惯。',
          'unavailable：库一页都没扫到，通常是路径指错层 —— 该去查配置，不是换关键词。',
          'invalid_input：参数写错了（空 query、缺 name）。按提示补参数重试，别当成「库里没有」。',
        ],
      },
      {
        title: '输出里的字段',
        lines: [
          'kind=note 是消化过的笔记（最可信）；raw-summary 是原始资料压缩稿；source 是资料页。',
          'sources 是来源数量，判断证据强度用：1 份和 12 份不是一回事。',
          '更新 后面括号是距今天数；标「可能已过时」的页，引用时要说明时间。',
          '断链 / brokenLinks 非空 = 那处引用了库里不存在的页，说明该判断缺少页级支撑。',
          '§小节 是命中的具体小节，引用时可以指到这个粒度。',
        ],
      },
      {
        title: '参数',
        lines: [
          'limit：search 返回几页，默认 5、最多 12；lint 时是每组列几条，默认 8。',
          'sectionChars：search 每页正文上限，默认 900；需要完整段落时调到 1500-2000。',
          'pageChars：page 正文上限，默认 6000；overview 引用总览时默认 4000。',
          'staleDays：lint 判「久未更新」的天数，默认 120。',
        ],
      },
      {
        title: '不该用它的时候',
        lines: [
          '纯通用常识、且能从库索引线索确认没有对应内容 —— 查了只会拿到不相干的页。',
          '但你「没看到线索」不等于库里没有：不确定就查一次，一次检索比一个错的结论便宜。',
        ],
      },
    ],
  }
}

export const MODES = ['search', 'page', 'list', 'overview', 'lint', 'draft', 'help']

/**
 * 参数校验：必须在碰语料之前跑完。
 * 空查询不该触发一次完整扫描，也不该被顺手归因成「库读不出来」或「库里没有」。
 * 返回 null 表示参数没问题，否则返回一句给模型看的话。
 */
export function validateArgs(mode, args = {}) {
  if (!MODES.includes(mode)) return `未知 mode: ${mode}（可用 ${MODES.join(' / ')}）`
  if (mode === 'search' && tokenize(args.query ?? '').length === 0) {
    return 'query 为空：请传 1–4 个关键词'
  }
  if (mode === 'page' && String(args.name ?? args.query ?? '').trim() === '') {
    return 'name 为空：请传要查的页名'
  }
  if (mode === 'draft' && String(args.title ?? args.name ?? args.query ?? '').trim() === '') {
    return 'title 为空：请传新页的名字'
  }
  return null
}

const toCount = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)

/**
 * 状态判定：纯函数。只读 corpus.stats 与 result，绝不改 result、不动排序。
 *
 * 优先级不是按发生顺序排的，是按「错误结论的代价」排的：
 * 「没搜全」被读成「没有」，比「没命中」被标成「不完整」贵得多 —— 所以覆盖类永远压过查询类。
 * status 编码「模型该做什么」，warnings 编码「为什么」，两者都不承担修改结果的责任。
 */
export function decideStatus(corpus, mode, args = {}, result = {}) {
  // help 不碰语料：不该因为「库读不出来」被降级成 partial —— 说明文档和库的状态无关
  if (mode === 'help') return { status: 'ok', warnings: [] }
  const stats = (corpus && corpus.stats) || {}
  const pages = toCount(stats.pages)
  const discovered = toCount(stats.discovered, pages)
  const unreadable = toCount(stats.unreadable)
  const walkFailures = toCount(stats.walkFailures)
  const statFailures = toCount(stats.statFailures)
  const oversized = toCount(stats.oversized)
  const failures = Array.isArray(stats.failures) ? stats.failures : []

  // 覆盖类：先说「你看到的不是全部」。顺序固定（读失败 → 目录 → 属性 → 超大），
  // 模型扫一眼就知道该先信哪条、该向用户交代什么。
  const warnings = []
  if (unreadable > 0) {
    const names = failures
      .filter((item) => item.stage === 'read' || item.stage === 'parse')
      .slice(0, 3)
      .map((item) => item.path)
    const more = unreadable > names.length ? '…' : ''
    warnings.push(`${unreadable} 页读取失败${names.length > 0 ? `（${names.join('、')}${more}）` : ''}：共 ${discovered} 页中 ${pages} 页可用`)
  }
  if (walkFailures > 0) warnings.push(`${walkFailures} 个目录无法列出，其中的页面没有计入`)
  if (statFailures > 0) warnings.push(`${statFailures} 个文件读不到属性，已跳过`)

  // 超大页：只有「和这次调用真的相关」才升级状态。
  //   search —— 标题或 index 摘要沾到查询词的超大页数（oversizedRelevant）；
  //   page   —— 目标页本身超大；
  //   list   —— 目录天然漏掉了它们；
  //   overview / lint —— 自己就会把这件事报出来，不必靠状态再喊一遍。
  // 判据是相关性，不是「库里有几页太大」这个与本次查询无关的事实：后者会让每次调用都挂 partial，
  // 这个信号很快就会变成模型学会忽略的背景噪音。
  const wanted = mode === 'page' ? String(args.name ?? args.query ?? '').trim() : ''
  const targetOversized = wanted !== '' && corpus.byName?.get?.(wanted)?.oversized === true
  const relevantOversized = mode === 'search' ? toCount(result.oversizedRelevant) : 0
  const oversizedHit = (mode === 'search' && relevantOversized > 0)
    || (mode === 'page' && targetOversized)
    || (mode === 'list' && oversized > 0)
  const oversizedWarning = mode === 'page'
    ? '目标页正文超过 512KB 未载入，这次只有标题与元数据'
    : mode === 'list'
      ? `${oversized} 页正文超过 512KB，没有进目录`
      : `${relevantOversized} 个超大页正文没有参与检索，但${viaText(result.oversizedRelevantVia)} —— 可能还有相关内容没看到`

  const coverageLost = unreadable > 0 || walkFailures > 0 || statFailures > 0

  // 同名页：byName 是 Map，后扫到的覆盖先扫到的，page 会静默返回其中一篇。
  // 这是最难自查的一类错 —— 状态是 ok、正文有内容、引用也写得出来，只是可能引错了版本。
  const dupWarning = duplicatePageWarning(stats, mode, result)

  // 空结果按 mode 各取各的字段，不为「统一」虚构字段
  const empty =
    mode === 'search' ? (result.hits ?? []).length === 0
      : mode === 'page' ? result.found === null || result.found === undefined
        : mode === 'list' ? toCount(result.total) === 0
          : false

  if (pages === 0) {
    // 这条必须排在最前：找到了文件却一页都读不出来，是权限/损坏，不是路径指错。
    // 判成 unavailable 会把用户引去改路径，而真正该看的是文件本身。
    if (unreadable > 0) {
      warnings.push('0 页可用：库不是空的，是这次一页都没读出来')
      return { status: 'partial', warnings }
    }
    const rootGone = failures.some((item) => item.stage === 'walk' && (item.code === 'ENOENT' || item.code === 'ENOTDIR'))
    if (discovered === 0 && walkFailures > 0 && !rootGone) {
      warnings.push('0 页可用：目录列不出来')
      return { status: 'partial', warnings }
    }
    warnings.push(discovered === 0
      ? '没有扫描到任何 .md 文件：路径可能指错了层'
      : `扫描到 ${discovered} 个文件，但没有一个算作页面（只有 index/log，或被规则跳过）`)
    return { status: 'unavailable', warnings }
  }
  if (coverageLost) {
    if (dupWarning) warnings.push(dupWarning)
    return { status: 'partial', warnings }
  }
  if (dupWarning) {
    // 覆盖没丢，但「拿到的是不是那一篇」不确定：失败模式是引错版本，同样配 partial。
    warnings.push(dupWarning)
    return { status: 'partial', warnings }
  }
  // 别名被多页共用与同名页是同一类风险（引错版本），只是入口不同：一个按页名，一个按别名。
  if (mode === 'page' && result.aliasConflict === true) {
    warnings.push(engineNote(result) || '这个别名被多页共用，这次给的不一定是你要的那篇')
    return { status: 'partial', warnings }
  }
  if (mode === 'search' && result.degraded === true) {
    // 降级与「超大页可能相关」可以同时成立：状态按约定取 degraded，但两条事实都要输出 ——
    // 别让一个状态值把覆盖缺口吞掉。
    if (oversizedHit) warnings.push(oversizedWarning)
    // 引擎自己知道这次是「命中任一词」还是「整句只沾字面」（覆盖率兜底），
    // 让它的说法优先：模型要做的动作不一样 —— 前者该收窄词，后者该换更短的词或直接查页面。
    // 固定文案只当兜底（老调用方不带 note 时）。
    warnings.push(engineNote(result)
      || '只命中部分检索词，已降级为 OR：命中面变宽、精度下降；想收窄就改用页面标题或更少的词重查一次')
    return { status: 'degraded', warnings }
  }
  if (oversizedHit) {
    // 目录/检索为空而库里恰好有超大页时，两件事都得说：先说「为什么是空的」（可能是过滤条件写错），
    // 再说「还漏了超大页」。只报后者的话，模型会以为过滤是对的、只是内容太大。
    const why = engineNote(result)
    if (why !== '') warnings.push(why)
    warnings.push(oversizedWarning)
    return { status: 'partial', warnings }
  }
  // 零命中也要带上「为什么零命中」：过滤器清空与主题不存在是两件事，
  // 引擎写在 note 里的那句话如果在这里丢掉，模型只能自己猜。
  if (empty) {
    const why = engineNote(result)
    return { status: 'no_match', warnings: why === '' ? [] : [why] }
  }
  return { status: 'ok', warnings: [] }
}

/** 引擎写好的那句话（降级原因 / 单字无区分度），没有就返回空串。 */
function engineNote(result) {
  return typeof result?.note === 'string' ? result.note.trim() : ''
}

/** 把「超大页靠什么沾上查询词」翻成一句人话，别在 warnings 里塞枚举值。 */function viaText(via) {
  if (via === '标题') return '标题命中查询词'
  if (via === '摘要') return 'index 摘要命中查询词'
  return '标题或 index 摘要命中查询词'
}

/**
 * 同名页提示：byName 只留最后一个，page 命中的可能不是模型以为的那一页。
 * 返回空串表示这次没有这个风险（别的 mode、没取到页、名字唯一）。
 */
function duplicatePageWarning(stats, mode, result) {
  if (mode !== 'page') return ''
  const found = result && result.found
  if (!found || !found.name) return ''
  const dups = Array.isArray(stats.duplicateNames) ? stats.duplicateNames : []
  const same = dups.filter((item) => item.name === found.name)
  if (same.length < 2) return ''
  const others = same.map((item) => item.file).filter((file) => file && file !== found.file)
  const rest = others.length > 0 ? `；另外还有 ${others.join('、')}` : ''
  return `库里有 ${same.length} 篇同名页「${found.name}」，这次返回的是 ${found.file}${rest} —— 引用前请确认是哪一篇，或先把同名页改名`
}

/** 统一入口：工具只暴露一个函数，六个 mode 分派到这里。 */
export function run(corpus, args = {}) {
  const mode = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : 'search'

  // 校验先于语料：参数错不该产生一次完整扫描，也不该被归因成扫描失败
  const invalid = validateArgs(mode, args)
  if (invalid !== null) {
    return {
      mode: MODES.includes(mode) ? mode : 'error',
      status: 'invalid_input',
      warnings: [invalid],
      // 第二步会把 render 改成按 status 分支；在那之前靠 error 挡住「库里没有命中」这句，
      // 否则模型会把「参数写错了」读成「库里没这条」。
      error: invalid,
      ...(mode === 'search' ? { query: args.query ?? '', tokens: [], total: 0, hits: [] } : {}),
    }
  }

  let result
  switch (mode) {
    case 'search':
      result = search(corpus, args.query ?? '', args)
      break
    case 'page':
      result = page(corpus, args.name ?? args.query ?? '', args)
      break
    case 'list':
      result = list(corpus, args)
      break
    case 'overview':
      result = overview(corpus, args)
      break
    case 'lint':
      result = lint(corpus, args)
      break
    case 'draft':
      result = draft(corpus, args)
      break
    case 'help':
      result = help()
      break
  }

  const verdict = decideStatus(corpus, mode, args, result)
  // status 永远有；warnings 只在非 ok 时出现 —— 正常路径零额外 token
  return verdict.warnings.length > 0
    ? { ...result, status: verdict.status, warnings: verdict.warnings }
    : { ...result, status: verdict.status }
}
