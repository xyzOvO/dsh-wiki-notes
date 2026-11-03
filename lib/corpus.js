/**
 * corpus.js —— 只读地把 LLM-Wiki 知识层读进内存，变成可查询的结构。
 *
 * 设计约束（不要改）：
 *   1. 只读。这里没有任何写文件的能力，绝不 import appendFile / writeFile。
 *   2. 零第三方依赖，只用 node: 内置模块。
 *   3. 不碰 原始资料-raw/ 与 Obsidian 目录，只读配置声明的 wiki 层。
 *
 * 解析三样东西：
 *   - 每个 .md 页：frontmatter 七个字段 + 按 `##` 切好的小节 + 正文双链
 *   - index.md：一行一条目录，附带人工提炼的一句话摘要（比正文片段质量高）
 *   - log.md：`## [YYYY-MM-DD] 类型 | 标题` 的时间线
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 单页正文上限：超过就只记元数据，防止某个巨型资料页把内存和上下文吃穿。 */
const MAX_PAGE_BYTES = 512 * 1024

/** 失败明细最多留几条：够定位问题，又不至于让一个坏目录把结果撑大。 */
const MAX_FAILURE_DETAILS = 20

/**
 * 「环境性」文件系统错误：路径不存在、没权限、被占用 —— 这些是这个世界本来的样子，
 * 属于数据缺失，记一条继续扫。不在这张表里的一律当成程序缺陷，必须往上冒。
 *
 * UNKNOWN 只对应一个已确认场景：Windows 上不受信任的 junction / reparse point
 * （ERROR_UNTRUSTED_MOUNT_POINT，0x800701C0），libuv 把它报成 errno -4094。
 * 要给这里加条目，先拿出可复现的来源 —— 别让它慢慢变成「啥都收」的兜底。
 */
const ENV_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EINVAL',
  'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EIO', 'EPIPE', 'UNKNOWN',
])

/** 环境故障还是程序故障。纯函数，测试直接喂 Error 对象。 */
export function classifyFsError(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  if (typeof code === 'string' && ENV_ERROR_CODES.has(code)) return 'environment'
  return 'program'
}

/**
 * 环境错误 → 一条失败记录（降级为数据缺失）；程序错误 → 立刻抛出。
 * 把程序 bug 记成「少读了一页」，会让模型以为覆盖问题已经报备过了 —— 那是这次改造最容易制造的谎言。
 */
function failureOf(stage, rel, error) {
  if (classifyFsError(error) === 'program') {
    const detail = error !== null && typeof error === 'object' && error.message ? error.message : String(error)
    const wrapped = new Error(`扫描 ${rel} 时发生非预期错误（${stage}）：${detail}`)
    wrapped.cause = error
    wrapped.stage = stage
    wrapped.file = rel
    throw wrapped
  }
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN'
  return { path: rel, stage, code }
}

/** frontmatter 分隔线。允许文件开头有 BOM。 */
const FM_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 解析 frontmatter：只在文件开头有 `---` 时才认，避免把正文里的分隔线当元数据。 */
export function splitFrontmatter(text) {
  if (!text.startsWith('---') && !text.startsWith('\uFEFF---')) {
    return { fields: {}, body: text }
  }
  const match = text.match(FM_RE)
  if (match === null) return { fields: {}, body: text }
  return { fields: parseFields(match[1]), body: text.slice(match[0].length) }
}

/**
 * 解析 key: value 行。
 * 真实库里只有七种值形态：纯文本、数字、`[]`、`[a, b]`、`[{{占位}}]`、日期、带引号。
 * 不引入 YAML 解析器 —— 这个库的 frontmatter 是 Obsidian 属性面板写出来的，形态极窄。
 *
 * 但「窄」不等于只有行内写法：Obsidian 属性面板给多值属性（标签、别名）落盘时用的是
 * YAML 块序列——
 *     标签:
 *       - RAG
 *       - 检索
 * 早先只认 `[a, b]`，这几行会被整段丢掉，标签变空串，下游 tags 过滤、别名取页、
 * lint 的字段检查一起失效，而且报成「库里没有」。这里补上：`标签:` 后面值为空时
 * 记住这个键，接下来以 `- ` 开头的行都归它。
 */
function parseFields(raw) {
  const fields = {}
  let pendingKey = ''
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const trimmed = line.trimStart()

    // 块序列项：`- 值`，归属上面那个值为空的键
    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (pendingKey === '') continue
      const item = stripQuotes(trimmed.slice(1).trim())
      if (item === '') continue
      const prev = fields[pendingKey]
      if (Array.isArray(prev)) prev.push(item)
      else if (prev === '' || prev === undefined) fields[pendingKey] = [item]
      else fields[pendingKey] = [prev, item]
      continue
    }

    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === '') continue
    fields[key] = parseValue(value)
    // 只有「键后面空着」才接受后续的块序列；`标签: [a, b]` 之后再来 `- c` 是无意义输入
    pendingKey = value === '' ? key : ''
  }
  return fields
}

function parseValue(value) {
  if (value === '') return ''
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner
      .split(/[,，]/)
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item !== '')
  }
  if (/^-?\d+$/.test(value)) return Number(value)
  return stripQuotes(value)
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const head = value[0]
    const tail = value[value.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 把正文按 `## ` 切节；第一个 `##` 之前的部分记为「文首」。 */
export function splitSections(body) {
  const lines = body.split(/\r?\n/)
  const sections = []
  let current = { title: '', level: 0, lines: [] }
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading !== null && heading[1].length === 2) {
      if (current.title !== '' || current.lines.some((l) => l.trim() !== '')) sections.push(finish(current))
      current = { title: heading[2].trim(), level: 2, lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.title !== '' || current.lines.some((l) => l.trim() !== '')) sections.push(finish(current))
  return sections
}

function finish(section) {
  return { title: section.title, text: section.lines.join('\n').trim() }
}

/** 正文里的双链：`[[页名]]` 与 `[[页名|显示名]]`，去掉 `#锚点`。 */
export function extractLinks(text) {
  const names = []
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
  let match
  while ((match = re.exec(text)) !== null) {
    const name = match[1].trim()
    if (name !== '') names.push(name)
  }
  return names
}

/**
 * 扫描整个 wiki 层。
 * 返回 { wikiDir, pages, byName, byAlias, indexLines, scaleLine, log, brokenLinks, stats }
 */
export async function loadCorpus(wikiDir) {
  const startedAt = Date.now()
  const walked = await walkMarkdown(wikiDir)
  const entries = walked.files
  const failures = [...walked.failures]

  const pages = []
  let skipped = 0
  const indexFile = path.join(wikiDir, 'index.md')
  const logFile = path.join(wikiDir, 'log.md')

  // 并发读：这里唯一的 IO 等待点是单页 readFile。串行读在大库上会线性变慢
  // （1000 页约 0.4s），分块并发后基本被文件系统缓存吃掉。块大小取 32，
  // 兼顾吞吐与同时打开的句柄数。
  const READ_CHUNK = 32
  const readOne = async (entry) => {
    const base = path.basename(entry.abs)
    // 结构性排除（模板页、目录页）不是损失，单独计数，别混进 unreadable
    if (entry.rel.startsWith('_')) return { skipped: true }
    if (base === 'index.md' || base === 'log.md') return { skipped: true }
    if (entry.size > MAX_PAGE_BYTES) {
      return { page: { name: base.slice(0, -3), file: entry.rel, oversized: true, bytes: entry.size,
        fields: {}, sections: [], body: '', links: [] } }
    }
    let text = ''
    try {
      text = await fs.readFile(entry.abs, 'utf8')
    } catch (error) {
      return { failure: failureOf('read', entry.rel, error) }
    }
    let parsed
    try {
      parsed = splitFrontmatter(text)
    } catch (error) {
      // 解析失败也是「这页没读进来」，但阶段不同：排查方向是文件内容，不是权限
      return { failure: failureOf('parse', entry.rel, error) }
    }
    const { fields: rawFields, body } = parsed
    const fields = normalizeFields(rawFields)
    const name = base.slice(0, -3)
    const page = {
      name,
      file: entry.rel,
      bytes: entry.size,
      mtime: entry.mtime,
      fields,
      // 目录名同时保留（概念/实体/对比/综合/资料），供 list 按类别筛
      dir: path.dirname(entry.rel).split(/[\\/]/).pop(),
      sections: splitSections(body),
      body,
      links: extractLinks(body),
    }
    return { page }
  }
  for (let i = 0; i < entries.length; i += READ_CHUNK) {
    const chunk = await Promise.all(entries.slice(i, i + READ_CHUNK).map(readOne))
    for (const item of chunk) {
      if (item.page !== undefined) pages.push(item.page)
      else if (item.skipped === true) skipped += 1
      else if (item.failure !== undefined) failures.push(item.failure)
    }
  }

  const byName = new Map()
  const byAlias = new Map()
  const nameCount = new Map()
  for (const page of pages) {
    nameCount.set(page.name, (nameCount.get(page.name) ?? 0) + 1)
    byName.set(page.name, page)
    for (const alias of asList(page.fields['别名'])) {
      const key = alias.toLowerCase()
      if (!byAlias.has(key)) byAlias.set(key, [])
      byAlias.get(key).push(page)
    }
  }

  // 断链：正文里指向的页不存在。注意别名也算存在。
  // index / log 是结构文件、不参与页面集合，被 [[index]] 链到不算断链。
  const STRUCTURAL_LINKS = new Set(['index', 'log'])
  const brokenLinks = []
  for (const page of pages) {
    const missing = []
    for (const link of page.links) {
      if (link === page.name) continue
      if (STRUCTURAL_LINKS.has(link.toLowerCase())) continue
      if (byName.has(link)) continue
      if (byAlias.has(link.toLowerCase())) continue
      if (!missing.includes(link)) missing.push(link)
    }
    if (missing.length > 0) brokenLinks.push({ name: page.name, missing })
  }

  const indexData = await readIndex(indexFile)
  const log = await readLog(logFile)

  // 覆盖口径：discovered = pages + unreadable + skipped（文件级恒等式，tests/status.mjs 里断言）
  const unreadable = failures.filter((item) => item.stage === 'read' || item.stage === 'parse').length
  const oversizedCount = pages.filter((page) => page.oversized === true).length

  const stats = {
    pages: pages.length,
    resources: pages.filter((p) => p.fields['类型'] === '资料').length,
    brokenPages: brokenLinks.length,
    brokenTotal: brokenLinks.reduce((sum, item) => sum + item.missing.length, 0),
    // 不同目录下的同名页：byName 只会留最后一个，等于静默丢页。
    // 当前这套库没有重名，但别人照抄结构时很容易撞上，统计出来让 overview 提醒一句。
    duplicateNames: pages
      .filter((page) => nameCount.get(page.name) > 1)
      .map((page) => ({ name: page.name, file: page.file })),
    // 扫描覆盖：这四项让「看到多少」可核算，而不是只报一个 pages
    discovered: entries.length,
    skipped,
    unreadable,
    oversized: oversizedCount,
    // 目录数与文件数分开记：walkFailures 是目录数，不参与上面的文件级等式
    walkFailures: walked.walkFailures,
    statFailures: walked.statFailures,
    failuresTotal: failures.length + walked.statFailures,
    failures: failures.slice(0, MAX_FAILURE_DETAILS),
    scannedMs: Date.now() - startedAt,
    wikiDir,
  }

  return { wikiDir, pages, byName, byAlias, indexLines: indexData.lines, scaleLine: indexData.scale, log, brokenLinks, stats }
}

async function walkMarkdown(root) {
  const files = []
  const failures = []
  let walkFailures = 0
  let statFailures = 0

  async function walk(dir, relPrefix) {
    let dirents = []
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      // 目录列不出来 = 整棵子树的页都不在结果里。以前这里直接 return，
      // 于是「库少了 30 页」和「库本来只有 60 页」看起来一模一样。
      failures.push(failureOf('walk', relPrefix === '' ? '.' : relPrefix, error))
      walkFailures += 1
      return
    }
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name)
      const rel = relPrefix === '' ? dirent.name : `${relPrefix}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (dirent.name.startsWith('.')) continue
        await walk(abs, rel)
        continue
      }
      if (!dirent.isFile()) continue
      if (!dirent.name.toLowerCase().endsWith('.md')) continue
      let size = 0
      let mtime = 0
      try {
        const stat = await fs.stat(abs)
        size = stat.size
        mtime = stat.mtimeMs
      } catch (error) {
        failures.push(failureOf('stat', rel, error))
        statFailures += 1
        continue
      }
      files.push({ abs, rel, size, mtime })
    }
  }

  await walk(root, '')
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))
  return { files, failures, walkFailures, statFailures }
}

/**
 * 解析 index.md。
 * 行格式：`- [[页名]] — 一句话摘要（N 份资料，更新于 YYYY-MM-DD）`
 * 这句话是人工提炼的，检索时它比正文片段更值钱，所以单独存一份映射。
 */
async function readIndex(file) {
  const lines = []
  let scale = ''
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { lines, scale }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (scale === '') {
      const scaleMatch = line.match(/\*\*当前规模\*\*[:：]\s*(.+)$/)
      if (scaleMatch !== null) scale = scaleMatch[1].trim()
    }
    const bullet = line.match(/^\s*[-*]\s+\[\[([^\]|#]+)(?:[^\]]*)\]\](.*)$/)
    if (bullet === null) continue
    const name = bullet[1].trim()
    let rest = (bullet[2] || '').trim()
    let summary = rest
    let sources = null
    let updated = ''
    // 真实库里括号有三种写法：`（2 份资料，2026-11-01）`、`（2 份，2026-11-01）`、
    // `（2 份资料，更新于 2026-11-01）`。都当成尾部的元数据剥掉，剩下的才是摘要。
    const meta = rest.match(/[（(]\s*(\d+)\s*(?:份|篇|条|个)\s*(?:资料)?\s*[,，]\s*(?:更新于\s*)?(\d{4}-\d{2}-\d{2})\s*[）)]\s*$/)
    // 英文模板写成「（2026-11-02 / 1）」，日期在前、数量在后
    const metaAlt = rest.match(/[（(]\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(\d+)\s*[）)]\s*$/)
    if (meta !== null) {
      sources = Number(meta[1])
      updated = meta[2]
      summary = rest.slice(0, meta.index).trim()
    } else if (metaAlt !== null) {
      updated = metaAlt[1]
      sources = Number(metaAlt[2])
      summary = rest.slice(0, metaAlt.index).trim()
    }
    summary = summary.replace(/^[—–\-:：]\s*/, '').trim()
    lines.push({ name, summary, sources, updated, raw: line.trim() })
  }
  return { lines, scale }
}

/**
 * 字段归一化：英文 frontmatter（title/type/tags/sources/created/updated）与
 * 中文七字段是同一套东西的两种写法。库可能来自不同模板，这里统一译成中文键，
 * 下游（engine / lint / topics）就只用认一套。
 */
const FIELD_ALIASES = {
  标题: ['title'],
  类型: ['type', 'kind', 'category'],
  标签: ['tags', 'tag', 'keywords'],
  别名: ['aliases', 'alias', 'alt'],
  状态: ['status', 'state'],
  创建: ['created', 'createdAt', 'created_at', 'date'],
  更新: ['updated', 'updatedAt', 'updated_at', 'modified', 'lastUpdated', 'last_updated'],
}
const SOURCE_COUNT_KEYS = ['来源数量', 'sourceCount', 'source_count', 'sourcesCount', 'sources_count']
const SOURCE_LIST_KEYS = ['sources', 'source', '来源']
const TYPE_ALIASES = {
  concept: '概念', concepts: '概念',
  entity: '实体', entities: '实体',
  comparison: '对比', comparisons: '对比', compare: '对比',
  synthesis: '综合', syntheses: '综合',
  source: '资料', sources: '资料', material: '资料', materials: '资料', raw: '资料',
  overview: '总览', note: '笔记', notes: '笔记',
}

export function normalizeFields(input) {
  const fields = { ...(input || {}) }
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (fields[canonical] !== undefined && fields[canonical] !== '') continue
    for (const alias of aliases) {
      const value = fields[alias]
      if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
        fields[canonical] = value
        break
      }
    }
  }
  // 来源数量：没有就直接数 sources 列表
  if (fields['来源数量'] === undefined || fields['来源数量'] === '') {
    let count = null
    for (const key of SOURCE_COUNT_KEYS) {
      const value = fields[key]
      if (value !== undefined && value !== '') {
        const num = Number(value)
        if (Number.isFinite(num)) count = num
        break
      }
    }
    if (count === null) {
      for (const key of SOURCE_LIST_KEYS) {
        const list = asList(fields[key])
        if (list.length > 0) { count = list.length; break }
      }
    }
    if (count !== null) fields['来源数量'] = count
  }
  // 类型值：concept → 概念，好让排序分层与 list 的类型筛认得
  const type = fields['类型']
  if (typeof type === 'string') {
    const mapped = TYPE_ALIASES[type.trim().toLowerCase()]
    if (mapped !== undefined) fields['类型'] = mapped
  } else if (Array.isArray(type) && typeof type[0] === 'string') {
    const mapped = TYPE_ALIASES[type[0].trim().toLowerCase()]
    if (mapped !== undefined) fields['类型'] = mapped
  }
  return fields
}

/** 解析 log.md：`## [YYYY-MM-DD] 类型 | 标题`，只取标题行，不碰正文。 */
async function readLog(file) {
  const entries = []
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return entries
  }
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    const head = line.match(/^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*([^|]*)\|(.*)$/)
    if (head !== null) {
      if (current !== null) entries.push(current)
      current = { date: head[1], type: head[2].trim(), title: head[3].trim(), body: [] }
      continue
    }
    if (current !== null) current.body.push(line)
  }
  if (current !== null) entries.push(current)
  return entries.map((entry) => ({ date: entry.date, type: entry.type, title: entry.title,
    text: entry.body.join('\n').trim() }))
}

export function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}
