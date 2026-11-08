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
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULE_FAMILIES } from '../lib/governance.js'
import { isObserveResult } from '../lib/bridge.js'

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

// ---- 治理四层触发 / 冻结契约只读门禁 ----
// 只读断言：CI 不跑 Python，也不宣称「证明 Python 有对应规则」；
// 人工对照冻结版 answer_policy.py / wiki_bridge.py 是实施前的另一道门禁。
ok('四个工具 description 都有硬触发，且 wiki_recall 引用同一份 DESCRIPTION', () => {
  const source = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  const hard = /(必须|不得|先[^。]*再)/
  const constants = ['RECALL_TRIGGERS', 'CONTEXT_TRIGGERS', 'VERIFY_TRIGGERS', 'OBSERVE_TRIGGERS']
  for (const name of constants) {
    const match = source.match(new RegExp(`const ${name}\\s*=\\s*'([^']*)'`))
    if (!match) throw new Error(`找不到常量 ${name}`)
    if (!hard.test(match[1])) throw new Error(`${name} 没有「必须 / 不得 / 先…再…」硬触发`)
    if (!source.includes('${' + name + '}') && !source.includes('+ ' + name + ',')) {
      throw new Error(`${name} 没被任何工具 description 引用`)
    }
  }
  if (!source.includes('description: DESCRIPTION')) throw new Error('wiki_recall 没引用 DESCRIPTION')
})

ok('双模式：recall 只一次、查看原文与深度核验分流、数字引文不强制核验', () => {
  const source = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  const recall = source.match(/const RECALL_TRIGGERS\s*=\s*'([^']*)'/)?.[1] ?? ''
  const context = source.match(/const CONTEXT_TRIGGERS\s*=\s*'([^']*)'/)?.[1] ?? ''
  const verify = source.match(/const VERIFY_TRIGGERS\s*=\s*'([^']*)'/)?.[1] ?? ''
  if (!recall.includes('只调用一次')) throw new Error('RECALL_TRIGGERS 没写「只调用一次」')
  if (!recall.includes('不得反复检索')) throw new Error('RECALL_TRIGGERS 没禁止反复检索')
  if (!context.includes('查看原文')) throw new Error('CONTEXT_TRIGGERS 没分流「查看原文」')
  if (!context.includes('高风险') || !context.includes('后果重大')) throw new Error('CONTEXT_TRIGGERS 没把重要事实限定为高风险、后果重大')
  if (!context.includes('重要事实') || !context.includes('复杂冲突')) throw new Error('CONTEXT_TRIGGERS 没把「高风险后果重大的重要事实」与「复杂冲突」拆成两个独立触发条件')
  if (!verify.includes('不得因答案含数字')) throw new Error('VERIFY_TRIGGERS 没取消数字强制核验')
  if (verify.includes('候选答案含数字') || verify.includes('输出最终答案之前必须用 wiki_verify')) {
    throw new Error('VERIFY_TRIGGERS 仍残留旧「含数字 / 输出前必须核验」')
  }
  if (source.includes('写完答案后自查（尤其含数字、范围、年份、题量分值这类主张时）用它。')) {
    throw new Error('wiki_verify description 仍残留「含数字就自查」')
  }
})

ok('RULE_FAMILIES 是冻结契约 violation.type.enum 的子集', () => {
  const schemaPath = path.join(ROOT, 'docs/契约-stage0/knowledge-gateway.v1.schema.json')
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const allowed = schema?.$defs?.violation?.properties?.type?.enum
  if (!Array.isArray(allowed)) throw new Error('冻结契约里找不到 violation.type.enum')
  const extra = RULE_FAMILIES.filter((name) => !allowed.includes(name))
  if (extra.length > 0) throw new Error(`不在冻结契约里的规则族：${extra.join(', ')}`)
})

ok('冻结契约 knowledge-gateway.v1.schema.json 逐字节未变', () => {
  const bytes = readFileSync(path.join(ROOT, 'docs/契约-stage0/knowledge-gateway.v1.schema.json'))
  const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  if (digest !== 'AD12FA65699A9CB7E0F3EACB025A8370BAE0142CBC474834FA87237A42B860EE') {
    throw new Error(`冻结契约哈希变了：${digest}`)
  }
})

// 冻结契约把两类 observe 形状分得很清：'observe' 是 observe_log.jsonl 里
// 单条日志事件的 kind，'observe_stats' 才是 wiki_observe 命令的成功统计返回。
// 早期 guard 把两者混了，governance 会静默不合并；这条只读门禁钉住语义。
ok('冻结契约区分 observe 日志事件与 observe_stats 命令返回', () => {
  const schemaPath = path.join(ROOT, 'docs/契约-stage0/knowledge-gateway.v1.schema.json')
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const logEventKind = schema?.$defs?.observe?.properties?.kind?.const
  const statsKind = schema?.$defs?.observe_stats?.properties?.kind?.const
  const statsRequired = schema?.$defs?.observe_stats?.required
  if (logEventKind !== 'observe') throw new Error(`日志事件 kind 不是 observe：${logEventKind}`)
  if (statsKind !== 'observe_stats') throw new Error(`命令返回 kind 不是 observe_stats：${statsKind}`)
  if (!Array.isArray(statsRequired) || !statsRequired.includes('totals') || !statsRequired.includes('window')) {
    throw new Error(`observe_stats 缺 totals/window 约束：${JSON.stringify(statsRequired)}`)
  }
  const source = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  if (!source.includes('isObserveResult(base)')) {
    throw new Error('wiki_observe 的 guard 没复用冻结契约成功返回判定')
  }
})

ok('isObserveResult 只认冻结契约的成功返回，不认日志事件或错误信封', () => {
  if (!isObserveResult({ kind: 'observe_stats', totals: {}, window: {} })) {
    throw new Error('observe_stats 被误判为失败')
  }
  if (isObserveResult({ kind: 'observe' })) throw new Error('observe 日志事件被误判为成功统计')
  if (isObserveResult({ kind: 'error' })) throw new Error('error 信封被误判为成功统计')
  if (isObserveResult(null)) throw new Error('null 被误判为成功统计')
})

if (failed > 0) {
  console.log(`\n${total - failed}/${total} 通过，${failed} 项失败`)
  process.exit(1)
}
console.log(`\n${total}/${total} 全部通过`)
