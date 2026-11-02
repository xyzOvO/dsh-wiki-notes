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
 */
function parseFields(raw) {
  const fields = {}
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === '') continue
    fields[key] = parseValue(value)
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
  const entries = await walkMarkdown(wikiDir)

  const pages = []
  const indexFile = path.join(wikiDir, 'index.md')
  const logFile = path.join(wikiDir, 'log.md')

  // 并发读：这里唯一的 IO 等待点是单页 readFile。串行读在大库上会线性变慢
  // （1000 页约 0.4s），分块并发后基本被文件系统缓存吃掉。块大小取 32，
  // 兼顾吞吐与同时打开的句柄数。
  const READ_CHUNK = 32
  const readOne = async (entry) => {
    const base = path.basename(entry.abs)
    // 模板与特殊文件不参与「页面」概念
    if (entry.rel.startsWith('_')) return null
    if (base === 'index.md' || base === 'log.md') return null
    if (entry.size > MAX_PAGE_BYTES) {
      return { name: base.slice(0, -3), file: entry.rel, oversized: true, bytes: entry.size,
        fields: {}, sections: [], body: '', links: [] }
    }
    let text = ''
    try {
      text = await fs.readFile(entry.abs, 'utf8')
    } catch {
      return null
    }
    const { fields, body } = splitFrontmatter(text)
    const name = base.slice(0, -3)
    return {
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
  }
  for (let i = 0; i < entries.length; i += READ_CHUNK) {
    const chunk = await Promise.all(entries.slice(i, i + READ_CHUNK).map(readOne))
    for (const page of chunk) {
      if (page !== null) pages.push(page)
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
  const brokenLinks = []
  for (const page of pages) {
    const missing = []
    for (const link of page.links) {
      if (link === page.name) continue
      if (byName.has(link)) continue
      if (byAlias.has(link.toLowerCase())) continue
      if (!missing.includes(link)) missing.push(link)
    }
    if (missing.length > 0) brokenLinks.push({ name: page.name, missing })
  }

  const indexData = await readIndex(indexFile)
  const log = await readLog(logFile)

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
    scannedMs: Date.now() - startedAt,
    wikiDir,
  }

  return { wikiDir, pages, byName, byAlias, indexLines: indexData.lines, scaleLine: indexData.scale, log, brokenLinks, stats }
}

async function walkMarkdown(root) {
  const out = []
  async function walk(dir, relPrefix) {
    let dirents = []
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
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
      } catch {
        continue
      }
      out.push({ abs, rel, size, mtime })
    }
  }
  await walk(root, '')
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'))
  return out
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
    if (meta !== null) {
      sources = Number(meta[1])
      updated = meta[2]
      summary = rest.slice(0, meta.index).trim()
    }
    summary = summary.replace(/^[—–\-:：]\s*/, '').trim()
    lines.push({ name, summary, sources, updated, raw: line.trim() })
  }
  return { lines, scale }
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
