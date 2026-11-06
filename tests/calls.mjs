/**
 * calls.mjs —— 调用记录模块。
 *
 * 钉的是「记账不许把工具带坏，也不许把私货记进去」：
 *   - 字段白名单之外的东西（页面路径、正文）一个都不许落盘；
 *   - 文件被删、目录不可写、末尾半行 JSON，都只影响账本，不影响检索；
 *   - 命中率的分母不含 verify / observe。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { CALL_FIELDS, normalizeEntry, createCallLog } from '../lib/calls.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wiki-calls-'))
const file = path.join(tmp, 'calls.jsonl')

/** 账本的「今日」是本地日期，测试也得按本地算，不能用 toISOString（那是 UTC）。 */
function localDay() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// 1. 字段白名单：多给的字段一律丢掉，缺的补 null
{
  const entry = normalizeEntry({
    ts: '2026-11-05T21:00:00', source: 'model', tool: 'wiki_recall', mode: 'search',
    query: '别了 旧索引', hits: 0, ms: 1, ok: true,
    file: '/wiki/某页.md', text: '正文片段',
  })
  assert.deepEqual(Object.keys(entry).sort(), [...CALL_FIELDS].sort())
  assert.equal(entry.file, undefined)
  assert.equal(entry.text, undefined)
}

// 2. query 截到 120 字
{
  const entry = normalizeEntry({ query: 'x'.repeat(500) })
  assert.equal(entry.query.length, 121) // 120 + 省略号
}

// 3. 非法输入不算记录
{
  assert.equal(normalizeEntry(null), null)
  assert.equal(normalizeEntry('字符串'), null)
}

// 4. 写进去能读出来
{
  const log = createCallLog({ file })
  log.record({ source: 'model', tool: 'wiki_recall', mode: 'search', query: '甲', hits: 2, ms: 3, ok: true })
  const { rows } = log.read({})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].query, '甲')
  assert.equal(JSON.parse(readFileSync(file, 'utf8').trim()).tool, 'wiki_recall')
}

// 5. 坏行跳过
{
  const f2 = path.join(tmp, 'broken.jsonl')
  writeFileSync(f2, '{"ts":"2026-11-05T21:00:00","tool":"wiki_recall","hits":1}\n{"半个\n')
  const log = createCallLog({ file: f2 })
  assert.equal(log.read({}).rows.length, 1)
}

// 6. enabled=false 时不写文件
{
  const f3 = path.join(tmp, 'off.jsonl')
  const log = createCallLog({ file: f3, enabled: false })
  log.record({ tool: 'wiki_recall', hits: 1 })
  assert.equal(log.read({}).rows.length, 1)      // 内存里有
  assert.equal(existsSync(f3), false)            // 文件没有
}

// 7. 命中率排除 verify / observe
{
  const log = createCallLog({ file: path.join(tmp, 'rate.jsonl') })
  const today = localDay()
  log.record({ ts: `${today}T10:00:00`, tool: 'wiki_recall', hits: 3, ok: true })
  log.record({ ts: `${today}T10:01:00`, tool: 'wiki_recall', hits: 0, ok: true })
  log.record({ ts: `${today}T10:02:00`, tool: 'wiki_verify', hits: null, ok: true })
  const { totals } = log.read({})
  assert.equal(totals.calls, 3)
  assert.equal(totals.hitRate, 0.5)   // 1 / 2，verify 不进分母
}

// 8. 目录不可写不抛错
{
  const log = createCallLog({ file: path.join(tmp, 'no-such-dir', 'x.jsonl') })
  assert.doesNotThrow(() => log.record({ tool: 'wiki_recall', hits: 1 }))
  assert.equal(log.read({}).rows.length, 1)
}

// 9. 文件被外部删掉后，下一次 record 自动重建
{
  const f4 = path.join(tmp, 'gone.jsonl')
  const log = createCallLog({ file: f4 })
  log.record({ tool: 'wiki_recall', hits: 1 })
  rmSync(f4)
  log.record({ tool: 'wiki_recall', hits: 2 })
  assert.equal(existsSync(f4), true)
  assert.equal(log.read({}).rows.length, 2)   // 被删前那条还在内存里
}

// 10. 跨天不混算：昨天那两条不进今日统计
{
  const f5 = path.join(tmp, 'crossday.jsonl')
  const log = createCallLog({ file: f5 })
  log.record({ ts: '2026-11-04T23:59:00', tool: 'wiki_recall', hits: 5, ok: true })
  log.record({ ts: '2026-11-04T00:01:00', tool: 'wiki_recall', hits: 5, ok: true })
  log.record({ ts: `${localDay()}T00:01:00`, tool: 'wiki_recall', hits: 0, ok: true })
  assert.equal(log.read({}).totals.calls, 1)
  assert.equal(log.read({}).totals.misses, 1)
}

// 11. query 里的换行不会撑破 jsonl
{
  const f6 = path.join(tmp, 'newline.jsonl')
  const log = createCallLog({ file: f6 })
  log.record({ query: '第一行\n第二行', tool: 'wiki_recall', hits: 0 })
  const lines = readFileSync(f6, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).query, '第一行\n第二行')
}

// 12. 超过上限自动轮转：行数回到上限以内，最新那条必须还在
{
  const f7 = path.join(tmp, 'rotate.jsonl')
  const log = createCallLog({ file: f7, maxLines: 10, keepLines: 3 })
  for (let i = 0; i < 14; i += 1) log.record({ tool: 'wiki_recall', hits: i, ok: true })
  const kept = readFileSync(f7, 'utf8').split('\n').filter(Boolean)
  assert.ok(kept.length <= 10, `轮转后行数 ${kept.length} 超过上限`)
  assert.ok(kept.length < 14, '14 条全留着，说明根本没轮转')
  assert.equal(JSON.parse(kept[kept.length - 1]).hits, 13)
}

process.stdout.write('[calls] 全部通过\n')
