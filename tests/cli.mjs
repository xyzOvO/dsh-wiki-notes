/**
 * cli.mjs —— 命令行参数解析。
 *
 * 钉的是这个 bug：只认 `--limit=3`，写成 `--limit 3` 时 flags.limit 变成 true，
 * Number(true) === 1，于是「要 3 条」安静地只回 1 条；`--root 路径` 同样被整个忽略，
 * 实际读的还是默认库。两种写法现在必须等价。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'bin', 'cli.mjs')

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

// 临时库：三页都命中「测试词」，这样 limit 才有区分度
const dir = mkdtempSync(path.join(tmpdir(), 'wiki-notes-cli-'))
mkdirSync(path.join(dir, '概念'), { recursive: true })
for (const name of ['甲', '乙', '丙']) {
  writeFileSync(
    path.join(dir, '概念', `${name}.md`),
    ['---', '类型: 概念', '状态: 已提纯', '标签: [测试]', '更新: 2026-01-01', '---', '', `# ${name}`, '', `这里讲测试词，第 ${name} 页。`, ''].join('\n'),
    'utf8',
  )
}

function run(args) {
  const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(stdout)
}

// 1. `--limit 3` 空格写法必须真的限制到 3（原来是 1）
const spaced = run(['search', '测试词', '--limit', '3', '--root', dir])
check('空格写法 limit 生效', spaced.returned === 3, JSON.stringify({ returned: spaced.returned, total: spaced.total }))

// 2. 等号写法仍然等价
const eq = run(['search', '测试词', '--limit=2', '--root=' + dir])
check('等号写法 limit 生效', eq.returned === 2, JSON.stringify({ returned: eq.returned }))

// 3. `--root 路径` 必须真的换库（原来被忽略，读的是默认库）
check('空格写法 root 生效', spaced.total === 3, JSON.stringify({ total: spaced.total }))

// 4. 换库是真的换了：空目录里搜同一个词应当零命中
const empty = mkdtempSync(path.join(tmpdir(), 'wiki-notes-cli-empty-'))
const none = run(['search', '测试词', '--root', empty])
check('root 指向空目录时零命中', none.returned === 0, JSON.stringify({ returned: none.returned, status: none.status?.status }))
rmSync(empty, { recursive: true, force: true })

// 5. 布尔开关（不带值）不当成值吃掉后面的位置参数
const page = run(['page', '甲', '--root', dir])
check('page 模式仍能取到页', page.found?.name === '甲', JSON.stringify({ found: page.found?.name ?? page.found }))

rmSync(dir, { recursive: true, force: true })

if (failed > 0) {
  process.stderr.write(`cli smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`cli smoke 全部通过（${total} 项）`)
