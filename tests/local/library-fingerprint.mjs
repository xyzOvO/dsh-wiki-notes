#!/usr/bin/env node
/**
 * library-fingerprint.mjs —— 库内容指纹（metrics.mjs 与 recall.mjs 共用）。
 *
 * 旧算法只 hash「页名 + body 长度」：等长改写、别名 / 标签改字、index 摘要改字
 * 全都测不出来，而 termScore() 恰恰读 page.fields['别名']、page.fields['标签']
 * 和 corpus.indexLines 的摘要。于是「库变了、基线没过期、指标悄悄变」这条路是通的。
 * 指纹必须量「检索真正读到的内容」，不能只量长度。
 *
 * 覆盖：page.name / page.file / page.fields（全部；键与数组都排序）/ page.body
 *       + corpus.indexLines（name / summary / sources / updated / raw）
 *       + corpus.scaleLine
 * 不覆盖：mtime / bytes / sections / links / log / brokenLinks / stats —— 它们是派生量
 *        或 search() 不读的字段，进去只会制造「没改内容却要重导基线」的噪音。
 *
 * 页顺序、indexLines 顺序、frontmatter 键顺序都不影响结果（先规范化再排序）。
 * 宁可多报一次 BASELINE_STALE 让人复核，也不要漏报 —— 漏报会让指标在无人知晓的
 * 情况下失去参照系。
 */

import { createHash } from 'node:crypto'

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const str = (value) => String(value ?? '')

function stableFields(fields) {
  const out = {}
  for (const key of Object.keys(fields ?? {}).sort(cmp)) {
    const value = fields[key]
    out[key] = Array.isArray(value) ? value.map(str).sort(cmp) : str(value)
  }
  return out
}

/**
 * @param {{pages?: Array, indexLines?: Array, scaleLine?: string|null}} corpus
 * @returns {string} 'sha256:' + 16 位十六进制
 */
export function fingerprintOf(corpus) {
  const pages = (corpus.pages ?? [])
    .map((page) => ({
      name: str(page.name),
      file: str(page.file),
      fields: stableFields(page.fields),
      body: str(page.body),
    }))
    .sort((a, b) => cmp(`${a.name}\u0000${a.file}`, `${b.name}\u0000${b.file}`))

  const index = (corpus.indexLines ?? [])
    .map((line) => ({
      name: str(line.name),
      summary: str(line.summary),
      sources: str(line.sources),
      updated: str(line.updated),
      raw: str(line.raw),
    }))
    .sort((a, b) => cmp(`${a.name}\u0000${a.raw}`, `${b.name}\u0000${b.raw}`))

  // JSON.stringify 自己负责转义，正文里的换行 / 分隔符不会伪造出字段边界。
  const joined = JSON.stringify({ pages, index, scale: str(corpus.scaleLine) })
  return 'sha256:' + createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 16)
}
