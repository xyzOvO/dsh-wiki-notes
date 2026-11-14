import './support/quiet-ledger.mjs'
/**
 * client smoke：在 node 里用最小 stub 跑 lib/client.js，验证
 * 「模块结构 + apply 注册 + CSS 注入」这条链路，不需要真浏览器。
 *
 * 它验不了真实渲染（那是 useState/React 的事），但能挡住绝大多数低级错误：
 * 语法、模块导出、slot 注册参数、effect 清理。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const file = new URL('../lib/client.js', import.meta.url)
const source = readFileSync(file, 'utf8')

// ---- 浏览器 stub ----
const styleNodes = new Map()

// head 只用来挂 style，给它 removeChild 就够了
const headStub = {
  appendChild(node) {
    styleNodes.set(node.id, node)
    node.parentNode = headStub
  },
  removeChild(node) {
    styleNodes.delete(node.id)
    node.parentNode = null
  },
}

const documentStub = {
  head: headStub,
  createElement(tag) {
    return { tag, id: '', textContent: '', parentNode: null }
  },
  getElementById(id) {
    return styleNodes.get(id) ?? null
  },
}

let loaded = null
const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

// ---- React 最小 stub ----
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.fetch = async () => ({ ok: true, text: async () => '{}' })

new Function('window', 'document', source)(windowStub, documentStub)

if (loaded === null) throw new Error('client.js 没有调用 __ModuleLoader__.load')
console.log('✓ 模块 id:', loaded.id)

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('未知依赖：' + name)
})

console.log('✓ 导出 name:', moduleExports.name)
console.log('✓ 导出 inject:', JSON.stringify(moduleExports.inject))

const registrations = []
const cleanups = []

const ctx = {
  effect(factory, label) {
    cleanups.push({ label, dispose: factory() })
    return () => {}
  },
  slots: {
    inject(name, factory) {
      console.log('✓ slots.inject:', name)
      return factory()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)

if (registrations.length !== 1) throw new Error(`期望注册 1 个 slot，实际 ${registrations.length}`)
const { options, component } = registrations[0]
console.log('✓ slot name:', options.name)
console.log('✓ slot id:', options.id)
console.log('✓ slot order:', options.order)
console.log('✓ slot label():', typeof options.label === 'function' ? options.label() : options.label)
if (typeof component !== 'function') throw new Error('slot 组件不是函数')

const tree = component({ sessionId: 'stub' })
if (tree === null || typeof tree !== 'object') throw new Error('组件没有返回元素')
console.log('✓ 组件可调用，根节点类型:', tree.type)

// ---- 调用记录：是「知识库」页里的第二个页签，不是第二个一级入口 ----
if (!source.includes("setTab('calls')")) throw new Error('知识库页里没有切到调用记录的页签')
if (!source.includes("'调用记录'")) throw new Error('页签文案不对')
if (source.includes('wiki-notes-calls')) throw new Error('不该再注册第二个 settings.section —— 它属于「知识库」页内部')
if (!source.includes('h(WikiCallsSection, { embedded: true })')) throw new Error('调用记录没有以嵌入方式挂进知识库页')
console.log('✓ 调用记录是页内页签，不是第二级入口')

const callGuards = [
  ['调用页走 /calls 接口', "'/calls?limit='"],
  ['清空走 /calls/clear', "'/calls/clear'"],
  ['开关走 /calls/config', "'/calls/config'"],
  ['命中率分母口径写清楚', '命中率分母不含 verify / observe'],
  ['空态有话可说', '还没有调用记录'],
  ['轮询间隔 2 秒', 'CALLS_POLL_MS'],
  ['清空要二次确认，不弹系统对话框', '确认清空？'],
]
for (const [label, needle] of callGuards) {
  if (!source.includes(needle)) throw new Error(`缺少调用页实现：${label}（找不到 ${needle}）`)
  console.log('✓ 调用页守卫:', label)
}

console.log('✓ CSS 已注入，长度:', (styleNodes.get('dsh-wiki-notes-styles')?.textContent ?? '').length)
console.log('✓ effect 清理函数数量:', cleanups.length)
for (const item of cleanups) {
  item.dispose()
}
console.log('✓ 清理后 style 节点:', styleNodes.get('dsh-wiki-notes-styles') ?? '已移除')

// ---- 交互规则的守卫 ----
// 这些只能验源码里写着，验不了真点一下（没有真 DOM）；但它们恰好都是
// 「删掉这行就悄悄回退成坏行为」的地方，值得钉住。
const guards = [
  ['空输入框不许保存', '输入框是空的。想换库就填新路径'],
  ['清掉配置要二次确认', '确认清掉？'],
  ['请求有超时', 'AbortController'],
  ['扫描用更长的超时', 'SCAN_TIMEOUT_MS'],
  ['同一时刻只跑一个操作', 'busyRef.current'],
]
for (const [label, needle] of guards) {
  if (!source.includes(needle)) throw new Error(`缺少交互守卫：${label}（找不到 ${needle}）`)
  console.log('✓ 交互守卫:', label)
}

const textareaMax = (source.match(/maxLength: 600/g) || []).length
if (textareaMax < 2) throw new Error(`两段提示词都该有 600 字上限，实际 ${textareaMax} 处`)
console.log('✓ 提示词输入框上限:', textareaMax, '处')

if (!source.includes('.wn-btn-danger')) throw new Error('缺少二次确认时的危险按钮样式 .wn-btn-danger')
console.log('✓ 危险按钮样式已注入')

// ---- 右侧栏：注册形状与故障隔离 ----
// 真渲染验不了，但「登记了什么」和「服务不在时会不会炸」恰好是故障隔离的全部内容。

function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  // 函数组件在 React 里是「渲染时才展开」的：stub 没有渲染器，就自己展开一层，
  // 否则只能看到 <WikiSearchPanel/> 这个元素本身，看不到它里面的输入框。
  if (typeof node.type === 'function') {
    flatten(node.type(node.props ?? {}), out)
    return out
  }
  out.push(node)
  flatten(node.children ?? [], out)
  return out
}

function sidebarCtx(tabs) {
  const seen = { tabs: [], panes: [], injected: [] }
  const owner = {
    get: (name) => (name === 'sidebarRightTabs' ? tabs : undefined),
    effect: (factory, label) => {
      const dispose = factory()
      seen.effectLabel = label
      return dispose
    },
    slots: {
      inject: (name, factory) => {
        seen.injected.push(name)
        return factory()
      },
      register: (options, component) => {
        seen.panes.push({ options, component })
        return () => {}
      },
    },
  }
  const ctx = {
    effect: () => () => {},
    slots: { inject: () => () => {}, register: () => () => {} },
    inject: (deps, factory) => {
      seen.deps = deps
      return factory(owner)
    },
  }
  return { ctx, seen }
}

// 1) 服务在：tab 类型与面板都要登记上去
const registeredTabs = []
const live = sidebarCtx({ register: (definition) => { registeredTabs.push(definition); return () => {} } })
moduleExports.apply(live.ctx)
if (JSON.stringify(live.seen.deps) !== JSON.stringify(['sidebarRightTabs'])) {
  throw new Error(`期望按需注入 sidebarRightTabs，实际 ${JSON.stringify(live.seen.deps)}`)
}
console.log('✓ 侧栏：按需注入 sidebarRightTabs')
if (registeredTabs.length !== 1) throw new Error(`期望注册 1 个 tab 类型，实际 ${registeredTabs.length}`)
const tab = registeredTabs[0]
if (tab.id !== 'dsh-wiki-notes/search') throw new Error(`tab id 不对：${tab.id}`)
if (tab.kind !== 'wiki-notes-search') throw new Error(`tab kind 不对：${tab.kind}`)
if (tab.priority !== 'extension') throw new Error(`tab priority 不对：${tab.priority}`)
if (tab.title() !== '知识库') throw new Error(`tab 标题不对：${tab.title()}`)
// 侧栏实际显示的是 guide 里的标题（image-gen 也是两处同一个字符串），两处不一致就会
// 把页签写成一句说明。
if (!Array.isArray(tab.guide) || tab.guide.length !== 1) throw new Error('tab.guide 应恰好一条')
if (tab.guide[0].title() !== tab.title()) {
  throw new Error(`guide 标题 ${tab.guide[0].title()} 与 tab.title() ${tab.title()} 不一致`)
}
console.log('✓ 侧栏：tab 类型注册正确（id / kind / priority / title / guide 标题一致）')
if (!live.seen.injected.includes('sidebar.right.pane.tab')) throw new Error('没有登记 sidebar.right.pane.tab')
if (live.seen.panes.length !== 1) throw new Error(`期望 1 个侧栏面板，实际 ${live.seen.panes.length}`)
if (live.seen.panes[0].options.key !== 'dsh-wiki-notes/search') {
  throw new Error(`面板 key 与 tab id 对不上：${live.seen.panes[0].options.key}`)
}
console.log('✓ 侧栏：面板挂在与 tab 同名的 key 上')

// 面板里必须有输入框和按钮，否则这个入口就是个空壳
const paneTree = flatten(live.seen.panes[0].component({}))
const inputs = paneTree.filter((node) => node.type === 'input')
const buttons = paneTree.filter((node) => node.type === 'button')
if (inputs.length !== 1) throw new Error(`侧栏面板应有 1 个输入框，实际 ${inputs.length}`)
if (!String(inputs[0].props.placeholder).includes('输入关键词')) throw new Error('输入框没有引导文案')
if (buttons.length !== 1) throw new Error(`侧栏面板应有 1 个按钮，实际 ${buttons.length}`)
if (buttons[0].props.disabled !== true) throw new Error('空查询时按钮应当禁用')
console.log('✓ 侧栏：面板有输入框与「查一下」，空查询时按钮禁用')

// 2) 服务不在：一个面板都不许注册，也不许抛 —— 设置页要照常可用
const empty = sidebarCtx(undefined)
moduleExports.apply(empty.ctx)
if (empty.seen.panes.length !== 0) throw new Error('服务不在时不该注册侧栏面板')
console.log('✓ 侧栏故障隔离：服务不在时静默跳过')

// 3) 面板走的是模型那条路：/search 接口，不许自己另算一套
if (!source.includes("apiGet('/search?q='")) throw new Error('面板没有走 /search 接口')
console.log('✓ 面板走 /api/wiki-notes/search（与 wiki_recall 同一条 run()）')

// 4) 设置页里也挂着同一个面板
const settingsTree = flatten(tree)
const settingsInputs = settingsTree.filter((node) => node.type === 'input' && node.props.placeholder === inputs[0].props.placeholder)
if (settingsInputs.length !== 1) throw new Error('设置页里没有检索面板')
console.log('✓ 设置页内也有同一个检索面板')

// 5) 命中行：行布局必须挂在 summary 里那层 span 上
//    summary 自带 display 规则，有些浏览器会顶掉 display:flex —— 真机验证过，
//    直接把 flex 写在 summary 上时整行会塌成内容宽度、分数贴在标题右边。
const preview = moduleExports.__preview
if (!preview || typeof preview.SearchHit !== 'function') throw new Error('缺少 __preview.SearchHit（预览与测试都要它）')
const hitTree = flatten(
  preview.SearchHit({
    hit: {
      name: '甲',
      type: '概念',
      score: 100,
      allTerms: false,
      section: '小节',
      body: '正文',
      citation: 'a.md',
      termHits: [
        { term: '甲', score: 100, count: 3, parts: [{ via: 'name', score: 120 }, { via: 'body', score: 9, count: 3 }] },
      ],
    },
    rank: 1,
    top: 100,
  }),
)
const rows = hitTree.filter((node) => node.props && node.props.className === 'wn-hit-row')
if (rows.length !== 1) throw new Error(`命中行应有 1 层 .wn-hit-row，实际 ${rows.length}`)
const summary = hitTree.find((node) => node.type === 'summary')
if (!summary) throw new Error('命中行没有 summary（不可展开）')
const meterFill = hitTree.find((node) => node.props && node.props.className === 'wn-hit-meter-fill')
if (!meterFill || !meterFill.props.style || meterFill.props.style.width !== '100%') {
  throw new Error('分数条没有按相对第一名的比例设置宽度')
}
const partial = hitTree.filter((node) => node.props && node.props.className === 'wn-hit-partial')
if (partial.length !== 1) throw new Error('未命中全部词时缺「部分词」标记')
console.log('✓ 命中行：行布局在 span 上，分数条按相对分缩放')

// 6) 正文命中高亮：长词优先，且只标位置不改字
const marks = preview.highlightNodes('上下文工程就是上下文预算', ['上下文', '上下文工程'])
const marked = marks.filter((node) => typeof node === 'object' && node.type === 'mark')
const text = marks.map((node) => (typeof node === 'string' ? node : node.children[0])).join('')
if (marked.length !== 2) throw new Error(`应当标 2 处（长词优先，上下文工程不被切开），实际 ${marked.length}`)
if (marked[0].children[0] !== '上下文工程') throw new Error('长词没有优先匹配：' + marked[0].children[0])
if (text !== '上下文工程就是上下文预算') throw new Error('高亮改动了原文：' + text)
// 正则元字符不许把整段吃掉
const risky = preview.highlightNodes('a.b(c)', ['a.b(c)'])
if (risky.filter((node) => typeof node === 'object').length !== 1) throw new Error('正则元字符没被转义')
console.log('✓ 正文高亮：长词优先、原文不变、元字符安全')

// 7) citation 可复制
const citeTree = flatten(preview.CiteRow({ text: '← [[甲]] §小节 → 甲.md' }))
const copyBtn = citeTree.find((node) => node.type === 'button' && node.props.className === 'wn-cite-copy')
if (!copyBtn) throw new Error('citation 那一行没有复制按钮')
const emptyCite = flatten(preview.CiteRow({ text: '' }))
if (emptyCite.some((node) => node.type === 'button')) throw new Error('没有出处时不该出现复制按钮')
console.log('✓ citation 可复制')

// 8) 格式化助手：路径与时间不能编数
if (preview.bytesLabel(0) !== '0 KB' || preview.bytesLabel(2048) !== '2 KB' || !preview.bytesLabel(3 * 1024 * 1024).endsWith('MB')) {
  throw new Error('bytesLabel 输出不对：' + [preview.bytesLabel(0), preview.bytesLabel(2048), preview.bytesLabel(3145728)].join(' / '))
}
if (preview.shortTime('') !== '—' || preview.shortTime('乱码') !== '—') throw new Error('坏时间应当给短横')
if (!/^\d\d-\d\d \d\d:\d\d$/.test(preview.shortTime('2026-11-04T15:22:00.000Z'))) {
  throw new Error('时间格式不对：' + preview.shortTime('2026-11-04T15:22:00.000Z'))
}
console.log('✓ 覆盖诊断的格式化助手')

// 9) 查询诊断那一行的 CSS 与源码守卫（没有真 DOM，只能钉「写着」）
for (const needle of ['.wn-terms{', '.wn-term-miss{', '.wn-mark{', '.wn-group-label{', '.wn-cov{', '.wn-busy{']) {
  if (!source.includes(needle)) throw new Error('缺少样式：' + needle)
}
for (const [label, needle] of [
  ['输入防抖', 'scheduleSearch'],
  ['Esc 清空', "event.key === 'Escape'"],
  ['上下键选结果', "event.key === 'ArrowDown'"],
  ['快捷键聚焦', 'window.addEventListener'],
  ['按类型分组', 'wn-group-label'],
]) {
  if (!source.includes(needle)) throw new Error(`缺少交互：${label}（找不到 ${needle}）`)
  console.log('✓ 交互:', label)
}
console.log('✓ 查询诊断与覆盖诊断的样式/交互守卫')

// 10) 复制查询词：按钮要能画出来，样式与焦点可见都要在
if (typeof preview.CopyButton !== 'function') throw new Error('CopyButton 没导出给预览')
const copyTree = flatten(preview.CopyButton({ className: 'wn-copy-query', text: '上下文 预算', label: '复制词' }))
const copyNode = copyTree[0]
if (!copyNode || copyNode.type !== 'button') throw new Error('复制查询词应当渲染成 button')
if (copyNode.props.className !== 'wn-copy-query') throw new Error('复制按钮没带上 .wn-copy-query')
if (String(copyNode.children) !== '复制词') throw new Error('复制按钮文案不对：' + copyNode.children)
for (const needle of ['wn-copy-query', '.wn-copy-query{', 'wn-cite-copy:focus-visible']) {
  if (!source.includes(needle)) throw new Error('缺少复制相关实现：' + needle)
}
console.log('✓ 复制查询词：按钮可渲染，样式与焦点可见')

// 11) 治理观察指标面板：只查现行 governance 指标键 / 报表展示名称 / UI 标签。
//    历史决策记录与标注历史口径不在这里检查；no_assertion 不产生也不展示。
if (typeof preview.WikiGovernancePanel !== 'function') {
  throw new Error('WikiGovernancePanel 没导出给预览（UI 守卫要直接渲染它）')
}

// flatten 只收对象、丢字符串；这里另走一遍把文本捞出来，函数组件照样展开一层。
function renderPanel(props) {
  const texts = []
  const nodes = []
  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') texts.push(String(node))
      return
    }
    if (typeof node.type === 'function') {
      walk(node.type(node.props ?? {}))
      return
    }
    nodes.push(node)
    walk(node.children ?? [])
  }
  walk(preview.WikiGovernancePanel(props))
  return { text: texts.join(' '), nodes }
}

function metric(numerator, denominator, reasons) {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
    effective_samples: denominator,
    excluded_count: reasons.length,
    exclude_reasons: reasons,
  }
}

const enabledGov = {
  state: 'ok',
  observe_enabled: true,
  window: { days: 7 },
  message: '',
  metrics: {
    required_check_verification_trigger_rate: {
      ...metric(2, 4, ['restart_not_observed']),
      groups: { partial_insufficient: metric(1, 2, []) },
    },
    effective_verify_violation_discovery_rate: metric(1, 3, ['context_missing']),
    observation_coverage: metric(3, 4, ['capacity']),
  },
  assertion_measurement: { state: 'unavailable', assertion_count: null, reason: 'contract_unavailable' },
  convergence: { metric: '观察到的核验链收敛率', converged: 1, unresolved: 0, not_rechecked: 1 },
  excluded: {
    context_samples: { restart_not_observed: 1, capacity: 0 },
    verify_calls: { context_missing: 1, context_expired: 0, context_corrupt: 0, exec_failed: 0 },
    late_verify: 1,
  },
}

const onPanel = renderPanel({ governance: enabledGov })
for (const [label, needle] of [
  ['现行指标键 1', '必核项 Context 核验触发率'],
  ['现行指标键 2', '有效 Verify 违规发现率'],
  ['现行指标键 3', '观察覆盖率'],
  ['partial / insufficient 分组行', '其中 partial / insufficient 分组'],
  ['触发率百分比', '50.0%'],
  ['违规发现率按次数不按条数', '33.3%'],
  ['覆盖率百分比', '75.0%'],
  ['每项带分子分母', '分子/分母：2/4'],
  ['每项带有效样本数', '有效样本：4'],
  ['每项带排除数', '排除：1'],
  ['每项带排除原因', '排除原因：restart_not_observed'],
  ['观察是否启用', '观察是否启用：已启用 · 窗口 7 天'],
  ['断言数量固定不可用', '断言数量：数据不可用'],
  ['收敛诊断独立命名', '观察到的核验链收敛率：已收敛 1 / 仍未收敛 0 / 未复核 1'],
  ['排除分层展示', '排除：样本 restart_not_observed 1 · Verify context_missing 1 · 迟到 Verify 1'],
  ['收敛不等于最终回答可靠', '收敛只表示观察到的核验链，不等于最终回答已证明可靠。'],
]) {
  if (!onPanel.text.includes(needle)) throw new Error(`治理面板缺少${label}：${needle}`)
}
for (const old of ['必核项完成率', 'Verify 违规率', '模型合规率', '最终回答正确率', '答案修正成功率', '必核项 Context 完成率', 'no_assertion']) {
  if (onPanel.text.includes(old)) throw new Error(`治理面板混进旧口径或不该展示的分类：${old}`)
}
const plainRows = onPanel.nodes.filter((node) => node.props?.className === 'wn-gov-row')
const subRows = onPanel.nodes.filter((node) => node.props?.className === 'wn-gov-row wn-gov-sub')
if (plainRows.length !== 3 || subRows.length !== 1) {
  throw new Error(`治理面板应有 3 项指标 + 1 行分组，实际 ${plainRows.length} / ${subRows.length}`)
}
console.log('✓ 治理面板：三项现行指标、分组、分子分母/排除、收敛与边界说明')

// 「0 次违规」是一种有数据的状态，不能与「没有启用观察，因此没有数据」混为一谈。
const zeroGov = {
  ...enabledGov,
  metrics: {
    ...enabledGov.metrics,
    effective_verify_violation_discovery_rate: metric(0, 5, []),
  },
}
const zeroPanel = renderPanel({ governance: zeroGov })
if (!zeroPanel.text.includes('0 次违规（0.0%）')) throw new Error('0 次违规没有单独展示')
if (zeroPanel.text.includes('没有启用观察，因此没有数据')) throw new Error('有数据时误报「没有启用观察」')
console.log('✓ 治理面板：0 次违规与「没有启用观察」是两种界面状态')

const blank = () => ({
  numerator: null, denominator: null, value: null,
  effective_samples: null, excluded_count: null, exclude_reasons: [],
})
const disabledGov = {
  state: 'disabled',
  observe_enabled: false,
  window: { days: 7 },
  message: '观察未启用，因此没有数据',
  metrics: {
    required_check_verification_trigger_rate: { ...blank(), groups: { partial_insufficient: blank() } },
    effective_verify_violation_discovery_rate: blank(),
    observation_coverage: blank(),
  },
  assertion_measurement: { state: 'unavailable', assertion_count: null, reason: 'contract_unavailable' },
  convergence: { metric: '观察到的核验链收敛率', converged: null, unresolved: null, not_rechecked: null },
  excluded: {
    context_samples: { restart_not_observed: null, capacity: null },
    verify_calls: { context_missing: null, context_expired: null, context_corrupt: null, exec_failed: null },
    late_verify: null,
  },
}
const offPanel = renderPanel({ governance: disabledGov })
for (const needle of ['观察未启用，因此没有数据', '观察是否启用：未启用 · 窗口 7 天', '断言数量：数据不可用', '观察到的核验链收敛率：没有启用观察，因此没有数据']) {
  if (!offPanel.text.includes(needle)) throw new Error(`关闭态缺少：${needle}`)
}
for (const banned of ['0 次违规', '50.0%', '0.0%', '必核项 Context 核验触发率', 'no_assertion']) {
  if (offPanel.text.includes(banned)) throw new Error(`关闭态把没有数据伪装成了数值/指标：${banned}`)
}
if (!offPanel.nodes.some((node) => node.props?.className === 'wn-gov-off')) throw new Error('关闭态没有 .wn-gov-off 容器')
console.log('✓ 治理面板：关闭态不伪装成 0、不展示指标、不展示 no_assertion')

// 后端没给 governance 时走 fallback，不能崩，也不能写成 0 违规。
const fallbackPanel = renderPanel({ governance: null })
if (!fallbackPanel.text.includes('没有启用观察，因此没有数据')) throw new Error('空 governance 没有 fallback 文案')
if (!fallbackPanel.text.includes('断言数量：数据不可用')) throw new Error('空 governance 丢了断言不可用口径')
console.log('✓ 治理面板：governance 缺失时静默降级')

for (const [label, needle] of [
  ['面板只挂在调用记录页签内', 'h(WikiGovernancePanel, { governance: state.governance })'],
  ['/calls 返回体的 governance 进 state', 'governance: data && data.governance'],
  ['关闭勾选框旁写明破坏性清空', '关闭会清空现有记录与待核验状态，期间指标不可用'],
  ['治理面板样式', '.wn-gov{'],
  ['关闭提示样式', '.wn-calls-warn{'],
]) {
  if (!source.includes(needle)) throw new Error(`缺少治理面板实现：${label}（找不到 ${needle}）`)
}
console.log('✓ 治理面板：嵌入位置、数据来源、关闭提示与样式守卫')

// ---- 检索面板的交互与可读性守卫 ----
// 这几条都是「中文用户每天会撞上、但只在真浏览器里才疼」的地方：
// 输入法组词时的回车、请求在飞时改词、兜底方式说错、读屏读不到结果。
for (const [label, needle] of [
  ['输入法组词时不吃回车', 'event.isComposing === true || event.keyCode === 229'],
  ['组词中直接返回、不 preventDefault', 'if (composing) return'],
  ['请求在飞也不丢新查询', '不再因为 busy 就丢弃新查询'],
  ['兜底说了覆盖率就别说成「命中任一」', '已按字面覆盖率匹配（≥45%）'],
  ['兜底分支要读 coverageFallback', 'result.coverageFallback === true'],
  ['结果变化报给读屏', "'aria-live': 'polite'"],
]) {
  if (!source.includes(needle)) throw new Error(`缺少检索面板改进：${label}（找不到 ${needle}）`)
}
if (source.includes("trimmed === '' || busy")) throw new Error('busy 时仍会丢弃新查询：面板会显示旧结果配新输入')
if (!source.includes('title: hit.name')) throw new Error('被省略号截断的页名没有 title，看不到全名')
// 正文里出现一长串没有空格的英文 / URL 时，pre-wrap 不换行会把面板顶出横向滚动条
if (!source.includes('overflow-wrap:anywhere')) throw new Error('.wn-hit-text 没有 overflow-wrap，长词会顶破面板')
// stats.resources 数的是「类型: 资料」的页数，写成「N 份资料」会让人以为库里只有 N 份原文
if (source.includes("+ ' 份资料'")) throw new Error('界面把资料页数说成了「份资料」：原始资料份数在每页的「来源数量」里')
if (!source.includes('资料页 ')) throw new Error('空状态应把 resources 说成「资料页」')
if (!source.includes('实时同步：')) throw new Error('「实时同步开/关」少了冒号，读起来像「同步开关」')
// 页签不带 role/aria-selected 时，读屏软件只会念「按钮 概览」「按钮 调用记录」，
// 听不出这是同一组里选一个、也听不出现在选的是哪个。
if (!source.includes("role: 'tablist'")) throw new Error('两个页签没有 role="tablist"，读屏听不出这是一组')
if (!source.includes("role: 'tab'")) throw new Error('页签按钮没有 role="tab"')
if (!source.includes("'aria-selected': tab === 'overview'")) throw new Error('页签没把选中态报给读屏（aria-selected）')
// 页签不是 .wn-btn，不单独给焦点环就等于「Tab 走过去什么也看不见」
if (!source.includes('.wn-tab:focus-visible')) throw new Error('页签没有焦点环样式，键盘用户看不出焦点在哪')
// --wn-faint（#8a7f6e）在白卡片上只有 3.87:1，低于 AA 的 4.5；它只该用来画装饰（点、▸），
// 不该承载文字。承载文字的地方要用 --wn-muted（5.62:1）。
for (const banned of ['.wn-calls-note{font-size:11.5px;color:var(--wn-faint)', '.wn-chip-dim .wn-chip-term{font-weight:500;color:var(--wn-faint)']) {
  if (source.includes(banned)) throw new Error(`次要文字用了 --wn-faint（对比度不足 4.5:1）：${banned}`)
}
// 没配库时 stats 全是 0，界面若只写「库 0 页」，读起来像「库里什么都没有」
if (!source.includes("lib.source === 'unset'")) throw new Error('空状态没区分「没配库」与「库是空的」')
if (!source.includes('还没有配置知识库路径')) throw new Error('没配库时应直接说去填路径')
for (const [label, needle] of [
  ['inline config.root 覆盖警告', '插件 profile 里的 config.root 正在覆盖'],
  ['保存时不再谎称生效', '已保存，但当前生效路径仍被'],
  ['调用页错误按状态分流', 'function callsErrorHint(status)'],
  ['调用页错误条改用已有样式', 'wn-notice-err'],
  ['筛选选中态补样式', '.wn-btn.wn-btn-on{'],
  ['筛选选中态报给读屏', "'aria-pressed': filter === item[0]"],
  ['调用页补「模式」列', "h('th', null, '模式')"],
  ['调用页补「成败」列', "h('th', null, '成败')"],
  ['失败可重试', "'重试'"],
]) {
  if (!source.includes(needle)) throw new Error(`缺少设置页/调用页改进：${label}（找不到 ${needle}）`)
}
if (source.includes('wn-notice-bad')) throw new Error('调用页错误条仍在用没有样式的 wn-notice-bad')
console.log('✓ 检索面板：输入法、并发改词、兜底措辞、读屏与省略号')

console.log('\nclient smoke 全部通过')
