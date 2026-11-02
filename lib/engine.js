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

/** 把用户 query 拆成检索词。中文没有空格，所以整句当一个词；有空格才算多词 AND。 */
export function tokenize(query) {
  const trimmed = String(query ?? '').trim()
  if (trimmed === '') return []
  const parts = trimmed.split(/[\s,，、。;；/|]+/).map((part) => part.trim()).filter((part) => part !== '')
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
  const name = page.name.toLowerCase()
  const term = token.toLowerCase()
  let score = 0
  if (name === term) score += 120
  else if (name.includes(term)) score += 60

  for (const alias of asList(page.fields['别名'])) {
    if (alias.toLowerCase().includes(term)) {
      score += 50
      break
    }
  }
  for (const tag of asList(page.fields['标签'])) {
    if (tag.toLowerCase().includes(term)) {
      score += 25
      break
    }
  }
  score += Math.min(countOccurrences(page.body, term), 12) * 3
  return score
}

/**
 * index.md 摘要通道：**只在其它通道全零时才给分**。
 *
 * 一开始把 +8 加进总分，立刻把某个 query 的 top5 挤掉三页——摘要里提到过
 * 某个词的资料页会顶掉真正相关的笔记页，召回不降的目标当场就破了。改成「只补漏、
 * 不抢位」之后，它只负责 search.py 搜不到的口语说法，不干扰既有名次。
 */
const INDEX_ONLY_SCORE = 8

/** 类型分层：同分时结构化笔记优先于原始资料摘要 —— 笔记是消化过的结论。 */
const TYPE_TIER = { 综合: 3, 概念: 2, 实体: 2, 对比: 2, 资料: 1 }

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

/**
 * 挑命中最密的一节交给模型。
 *
 * 先按「命中了几种检索词」排（覆盖广度比出现次数更能说明这一节在讲什么），再按次数。
 * 清单类小节先排除：`§元信息` 里列着 `03-第一讲-要点.md` 这种文件名，词频很高但
 * 一个字都没回答「立意怎么写」，早先版本就是被它抢了头名。
 */
function pickSection(page, tokens) {
  const sections = page.sections
  if (sections.length === 0) return { title: '', text: page.body }
  const candidates = sections.filter((section) => section.title !== '' && !isBoilerplate(section.title))
  const pool = candidates.length > 0 ? candidates : sections.filter((section) => section.title !== '')
  const realPool = pool.length > 0 ? pool : sections
  let best = null
  let bestScore = 0
  for (const [index, section] of realPool.entries()) {
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
    const positionBonus = (realPool.length - index) / realPool.length * 6
    const score = covered * 10 + Math.min(hits, 30) + positionBonus
    if (score > bestScore) {
      bestScore = score
      best = section
    }
  }
  return best ?? realPool[0]
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
 * mode 2：search
 * 返回 hits（按分数降序），每项带索引摘要、命中小节正文、citation、断链。
 */
export function search(corpus, query, options = {}) {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return { mode: 'search', query, total: 0, tokens: [], hits: [], note: '空查询' }
  }
  const indexMap = buildIndexMap(corpus)
  const limit = Math.max(1, Math.min(Number(options.limit ?? 5) || 5, 12))
  const sectionChars = Math.max(120, Math.min(Number(options.sectionChars ?? DEFAULT_SECTION_CHARS) || DEFAULT_SECTION_CHARS, 3000))
  const typeFilter = typeof options.type === 'string' && options.type.trim() !== '' ? options.type.trim() : null
  const tagFilter = asList(options.tags)

  const scored = []
  for (const page of corpus.pages) {
    if (page.oversized === true) continue
    if (typeFilter !== null && String(page.fields['类型'] ?? '') !== typeFilter) continue
    if (tagFilter.length > 0) {
      const pageTags = asList(page.fields['标签'])
      if (!tagFilter.some((tag) => pageTags.includes(tag))) continue
    }
    const indexLine = indexMap.get(page.name) ?? null
    let total = 0
    let matched = 0
    for (const token of tokens) {
      let score = termScore(page, token)
      if (score === 0 && indexLine !== null && indexLine.summary.toLowerCase().includes(token.toLowerCase())) {
        score = INDEX_ONLY_SCORE
      }
      total += score
      if (score > 0) matched += 1
    }
    if (matched === 0) continue
    scored.push({ page, indexLine, score: total, matched, allTerms: matched === tokens.length })
  }

  // AND 优先；一条 AND 都没有时降级为 OR，并在结果里说明，别让模型以为「库里没有」。
  let degraded = false
  let list = scored.filter((item) => item.allTerms)
  if (list.length === 0) {
    degraded = true
    list = scored
  }

  list.sort(compareHits)

  const hits = list.slice(0, limit).map((item) => {
    const section = pickSection(item.page, tokens)
    const broken = section.text !== ''
      ? [...new Set((section.text.match(/\[\[([^\]|#]+)/g) ?? []).map((raw) => raw.slice(2).trim()))]
        .filter((link) => !corpus.byName.has(link) && !corpus.byAlias.has(link.toLowerCase()))
      : []
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
    }
  })

  return {
    mode: 'search',
    query,
    tokens,
    total: list.length,
    degraded,
    hits,
    note: degraded ? '没有同时命中全部检索词，已降级为「命中任一」，命中面变宽、精度下降' : '',
  }
}

/** mode 2：page —— 按页名/别名/模糊取整页。取不到就给最像的 5 个候选。 */
export function page(corpus, name, options = {}) {
  const wanted = String(name ?? '').trim()
  const limit = Math.max(500, Math.min(Number(options.pageChars ?? DEFAULT_PAGE_CHARS) || DEFAULT_PAGE_CHARS, 20000))
  if (wanted === '') return { mode: 'page', found: null, candidates: [] }

  const indexMap = buildIndexMap(corpus)
  const exact = corpus.byName.get(wanted) ?? corpus.byName.get(wanted.replace(/\.md$/i, ''))
  if (exact !== undefined) return { mode: 'page', found: renderPage(corpus, exact, indexMap, limit), candidates: [] }

  const aliasHits = corpus.byAlias.get(wanted.toLowerCase()) ?? []
  if (aliasHits.length > 0) {
    const first = aliasHits[0]
    return { mode: 'page', found: renderPage(corpus, first, indexMap, limit), candidates: [] }
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
    .filter((p) => tagFilter.length === 0 || tagFilter.some((tag) => asList(p.fields['标签']).includes(tag)))
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

  const limit = Number(options.limit ?? 40) || 40
  const shown = limit > 0 ? rows.slice(0, limit) : rows

  return {
    mode: 'list',
    total: rows.length,
    shown: shown.length,
    truncated: shown.length < rows.length,
    byType,
    scale: corpus.scaleLine,
    rows: shown,
  }
}

/** mode 4：overview —— 全库当前状态：总览正文 + 规模行 + 最近日志 + 健康计数。 */
export function overview(corpus, options = {}) {
  const indexMap = buildIndexMap(corpus)
  const overviewPage = corpus.byName.get('总览-overview') ?? corpus.byName.get('总览')
  const logLimit = Math.max(1, Math.min(Number(options.logLimit ?? 5) || 5, 20))
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
      body: clip(overviewPage.body, Math.max(1000, Math.min(Number(options.pageChars ?? 4000) || 4000, 20000))),
      citation: `← [[${overviewPage.name}]] → ${overviewPage.file}`,
      sections: overviewPage.sections.map((section) => section.title).filter((title) => title !== ''),
      summary: indexMap.get(overviewPage.name)?.summary ?? '',
    },
    recentLog,
    broken: corpus.brokenLinks.slice(0, 10),
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

/** 统一入口：工具只暴露一个函数，四个 mode 分派到这里。 */
export function run(corpus, args = {}) {
  const mode = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : 'search'
  switch (mode) {
    case 'search':
      return search(corpus, args.query ?? '', args)
    case 'page':
      return page(corpus, args.name ?? args.query ?? '', args)
    case 'list':
      return list(corpus, args)
    case 'overview':
      return overview(corpus, args)
    default:
      return { error: `未知 mode: ${mode}（可用 search / page / list / overview）` }
  }
}
