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

console.log('\nclient smoke 全部通过')
