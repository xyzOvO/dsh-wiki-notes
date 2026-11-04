/**
 * contract.mjs —— 与 DSH 宿主的契约，不是功能测试。
 *
 * 这些约束一旦破了，功能测试照样全绿，坏的是「装不上」或「网页起不来」：
 *   - package.json 没有 dsh.bundle，市场拒绝安装（只声明 dsh.client 不够）；
 *   - cordis.patch.yml 里的 name 不是裸包名，dsh-web 扫不到客户端模块，设置页消失；
 *   - client.js 第一句不是 __ModuleLoader__.load，整个 bundle 不激活；
 *   - engines.dsh 写了 ^0.1.x-rc，上界卡死在 0.2.0 之前，整包被静默 skip。
 *
 * 不测 DSH 的版本号本身 —— 那是宿主的事，我们只保证自己没写错形状。
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
let total = 0
function ok(name, fn) {
  total += 1
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`✗ ${name} — ${error.message}`)
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

ok('package.json 有 name 与 version', () => {
  if (!pkg.name) throw new Error('缺 name')
  if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? '')) throw new Error(`version 不是 semver：${pkg.version}`)
})

ok('声明了 dsh.bundle.manifest（只声明 dsh.client 装不上）', () => {
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.trim() === '') throw new Error('缺 dsh.bundle.patch')
})

ok('bundle 补丁文件真的在仓库里', () => {
  const patch = pkg.dsh?.bundle?.patch ?? ''
  const file = path.resolve(ROOT, patch)
  if (!existsSync(file)) throw new Error(`找不到 ${patch}`)
})

ok('cordis.patch.yml 可解析，且插入项用的是裸包名', () => {
  const patch = pkg.dsh?.bundle?.patch ?? ''
  const text = readFileSync(path.resolve(ROOT, patch), 'utf8')
  // 只认最小结构：- insert: 下面是行列表，每行有 name。不引 YAML 库（零依赖）。
  const names = [...text.matchAll(/^\s*(?:-\s*)?name:\s*(\S+)\s*$/gm)].map((match) => match[1])
  if (names.length === 0) throw new Error('没找到 name 行')
  for (const name of names) {
    if (name !== pkg.name) throw new Error(`name=${name} 与包名 ${pkg.name} 不一致`)
    if (name.includes('/')) throw new Error(`name=${name} 不是裸包名（带了 scope 或路径）`)
  }
})

ok('声明了 dsh.client.platform', () => {
  const platform = pkg.dsh?.client?.platform
  if (typeof platform !== 'string' || platform.trim() === '') throw new Error('缺 dsh.client.platform')
})

ok('client.js 第一句是 __ModuleLoader__.load（不是先跑别的）', () => {
  const text = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  // 去掉整段注释与空行，看第一条语句
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  const first = stripped[0] ?? ''
  if (!first.startsWith('window.__ModuleLoader__.load(')) {
    throw new Error(`第一句是：${first.slice(0, 60)}`)
  }
})

ok('engines 不写会卡死上界的 dsh 版本约束', () => {
  const range = pkg.engines?.dsh
  if (range === undefined) return // 没写是安全的
  if (typeof range !== 'string' || range.trim() === '') throw new Error('engines.dsh 存在但为空')
  // ^0.1.x 的语义上界是 0.2.0，宿主升上去之后整包被 skip
  if (/^\^0\.1\./.test(range)) throw new Error(`engines.dsh=${range} 会把上界卡在 0.2.0`)
})

ok('files 里带了运行必需的东西', () => {
  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const required of ['lib', 'bin', 'cordis.patch.yml']) {
    if (!files.includes(required)) throw new Error(`files 里缺 ${required}`)
  }
})

ok('private 不是 true（否则 npm publish 会被拒）', () => {
  if (pkg.private === true) throw new Error('private=true')
})

// 侧栏是可选能力：它一坏，设置页必须还能进。所以侧栏模块不能出现在
// dsh.client.inject 里 —— 那会把「侧栏模块在不在」变成整个客户端包的加载前提。
ok('没有把侧栏模块写进 dsh.client.inject（否则侧栏缺失会连累设置页）', () => {
  const injected = pkg.dsh?.client?.inject
  if (injected === undefined) return
  if (!Array.isArray(injected)) throw new Error('dsh.client.inject 不是数组')
  const pinned = injected.filter((name) => String(name).includes('sidebar'))
  if (pinned.length > 0) throw new Error(`dsh.client.inject 钉了侧栏模块：${pinned.join(', ')}`)
})

ok('侧栏能力走运行时 ctx.inject 按需取，而不是写死依赖', () => {
  const text = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  if (!text.includes("ctx.inject(['sidebarRightTabs']")) {
    throw new Error("找不到 ctx.inject(['sidebarRightTabs']")
  }
  if (!text.includes("owner.slots.inject('sidebar.right.pane.tab'")) {
    throw new Error('找不到 sidebar.right.pane.tab 的登记')
  }
})

ok('启动时就探一次库（冷扫描不落在用户第一句话上）', () => {
  const text = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  if (!text.includes('启动时探一次库')) throw new Error('找不到启动预热的注释')
  if (!text.includes('首次扫描')) throw new Error('预热日志没带耗时')
})

if (failed > 0) {
  console.log(`\n${total - failed}/${total} 通过，${failed} 项失败`)
  process.exit(1)
}
console.log(`\n${total}/${total} 全部通过`)
