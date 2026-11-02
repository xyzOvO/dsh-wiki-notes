#!/usr/bin/env node
/**
 * cli.mjs —— 本地验证用：不开 DSH 也能看见工具会返回什么。
 *
 *   node bin/cli.mjs search "上下文 预算"
 *   node bin/cli.mjs search "记忆 系统" --limit 3
 *   node bin/cli.mjs page 上下文
 *   node bin/cli.mjs list --type 资料
 *   node bin/cli.mjs overview
 *   node bin/cli.mjs bench          # 批量跑一组查询，看耗时与命中
 */

import { fileURLToPath } from 'node:url'

import { loadCorpus } from '../lib/corpus.js'
import { run } from '../lib/engine.js'
import { resolveWikiRoot } from '../lib/config.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'search'
const rest = argv.slice(1)

const flags = {}
const positional = []
for (const item of rest) {
  if (item.startsWith('--')) {
    const [key, value] = item.slice(2).split('=')
    flags[key] = value ?? true
  } else {
    positional.push(item)
  }
}

// fileURLToPath 会处理百分号编码（路径里有空格或中文时 pathname 是 %E4%B8%AD 这种）
const root = resolveWikiRoot(fileURLToPath(new URL('..', import.meta.url)), flags.root)

function fmtNumber(value) {
  return value === null || value === undefined ? '-' : String(value)
}

async function main() {
  const t0 = Date.now()
  const corpus = await loadCorpus(root)
  const loadMs = Date.now() - t0
  process.stderr.write(`[扫描] ${corpus.stats.pages} 页 / ${corpus.stats.resources} 资料 / ${corpus.stats.brokenPages} 页有断链 / ${loadMs}ms / root=${root}\n`)

  if (command === 'bench') {
    const queries = ['上下文 工程', '记忆 系统', '检索 增强', '微调', '证据 分级', '窗口']
    for (const query of queries) {
      const started = Date.now()
      const result = run(corpus, { mode: 'search', query, limit: 3 })
      const names = result.hits.map((hit) => `${hit.name}(${hit.score})`).join('、')
      console.log(`${query.padEnd(14, ' ')} ${String(Date.now() - started).padStart(3)}ms  ${result.hits.length} 命中  ${names}`)
    }
    return
  }

  const started = Date.now()
  const result = run(corpus, { mode: command, query: positional[0], name: positional[0], type: flags.type, tags: flags.tags, limit: flags.limit, pageChars: flags.chars })
  const queryMs = Date.now() - started
  process.stderr.write(`[查询] ${queryMs}ms\n`)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(`失败：${String(error && error.stack || error)}`)
  process.exitCode = 1
})
