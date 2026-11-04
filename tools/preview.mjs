#!/usr/bin/env node
/**
 * 面板预览：把 `lib/client.js` 里的真组件和真 CSS 渲染成一张静态页面，
 * 用来在改样式的时候「看一眼」，而不是在 DSH 里反复重启试。
 *
 *   node tools/preview.mjs                 → 写到 preview/panel.html
 *   node tools/preview.mjs --out /tmp/x.html
 *   node tools/preview.mjs --data hits.json  （不给就现取活库，取不到退回内置样例）
 *
 * 做法：
 *   1. 从 client.js 里抠出 CSS 数组求值 —— 样式只有一份，预览不会跑偏；
 *   2. 用假的 __ModuleLoader__ + 假 React 把 bundle 求值，拿到组件；
 *   3. 自己的 vnode 序列化器把组件渲染成 HTML（函数组件就地展开）。
 *
 * 它只读不写库，也不联网改任何东西；活库那次 GET 和面板本身打的是同一个接口。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'lib/client.js')

/* ------------------------------ 取 CSS ------------------------------ */

function extractCss(text) {
  const start = text.indexOf('var CSS = [')
  if (start === -1) throw new Error('client.js 里找不到 CSS 数组')
  const end = text.indexOf("].join('')", start)
  if (end === -1) throw new Error('CSS 数组没有以 ].join 收尾')
  const literal = text.slice(start + 'var CSS = '.length, end + 1)
  // 求值出来的是数组，必须 join('') —— 直接拼进模板会变成「用逗号连接」的非法 CSS。
  return vm.runInNewContext(literal, {}, { timeout: 1000 }).join('')
}

/* ------------------------------ 取组件 ------------------------------ */

const ELEMENT = Symbol('element')
const FRAGMENT = Symbol('fragment')

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return { $$: ELEMENT, type, props: props || {}, children }
}

// 只够把面板渲染一次的 React：没有调度、没有状态迁移。
const fakeReact = {
  createElement,
  Fragment: FRAGMENT,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useLayoutEffect: () => {},
}

function loadBundle(css, text) {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
    console,
    fetch: () => Promise.reject(new Error('预览不联网')),
    setTimeout,
    clearTimeout,
    URL,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox.window
  vm.runInNewContext(text, sandbox, { filename: 'client.js', timeout: 5000 })
  if (captured === null) throw new Error('没抓到 __ModuleLoader__.load')
  const stub = {
    exports: {},
  }
  const require = () => fakeReact
  // factory 内部自己维护 module/exports，返回的只是它顺手给出的东西
  const factoryExports = captured.factory(require)
  const exported = factoryExports && factoryExports.name ? factoryExports : stub.exports
  if (!exported.__preview) throw new Error('bundle 没导出 __preview（组件拿不到，预览无从谈起）')
  return { preview: exported.__preview, css }
}

/* --------------------------- vnode → HTML --------------------------- */

const VOID = new Set(['input', 'br', 'hr', 'img'])
const ATTRS = {
  className: 'class',
  htmlFor: 'for',
  value: 'value',
  placeholder: 'placeholder',
  type: 'type',
  title: 'title',
  open: 'open',
  disabled: 'disabled',
  spellCheck: 'spellcheck',
  'aria-label': 'aria-label',
  'aria-live': 'aria-live',
  'aria-describedby': 'aria-describedby',
  maxLength: 'maxlength',
  rows: 'rows',
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

function renderAttributes(props) {
  const out = []
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'key') continue
    const value = props[key]
    if (value === null || value === undefined || value === false) continue
    if (key === 'style') {
      // 组件里写的是 style 对象，React 会展开；这里的序列化器得自己展开。
      if (typeof value === 'object') {
        const css = Object.keys(value)
          .map((name) => name + ':' + value[name])
          .join(';')
        if (css !== '') out.push(' style="' + escapeAttr(css) + '"')
      }
      continue
    }
    const name = ATTRS[key] || (key.startsWith('data-') || key.startsWith('aria-') ? key : '')
    if (name === '') continue
    if (value === true) {
      out.push(' ' + name)
      continue
    }
    if (typeof value === 'function') continue
    out.push(' ' + name + '="' + escapeAttr(value) + '"')
  }
  return out.join('')
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (typeof node === 'function') return render(node({}))
  if (node.$$ !== ELEMENT) return escapeHtml(String(node))

  const { type, props, children } = node
  const kids = children.length > 0 ? children : props.children !== undefined ? [props.children] : []

  if (type === FRAGMENT) return kids.map(render).join('')
  if (typeof type === 'function') {
    return render(type({ ...props, children: kids.length === 1 ? kids[0] : kids }))
  }
  if (typeof type !== 'string') return ''

  const attributes = renderAttributes(props)
  const open = VOID.has(type) ? '/>' : '>'
  const body = VOID.has(type) ? '' : kids.map(render).join('') + '</' + type + '>'
  return '<' + type + attributes + open + body
}

/* ------------------------------ 样例数据 ------------------------------ */

function liveHits() {
  const base = process.env.DSH_WIKI_API || 'http://127.0.0.1:64109'
  return fetch(base + '/api/wiki-notes/search?q=' + encodeURIComponent('上下文 预算') + '&limit=5', {
    headers: { accept: 'application/json' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
}

function liveState() {
  const base = process.env.DSH_WIKI_API || 'http://127.0.0.1:64109'
  return fetch(base + '/api/wiki-notes/state', { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return null
      const stats = data.stats || {}
      return {
        pages: stats.pages || 0,
        resources: stats.resources || 0,
        watch: data.watch === 'on' ? '开' : '关',
        topics: (Array.isArray(data.topics) ? data.topics : []).slice(0, 6),
        sections: stats.sections || 0,
        oversized: stats.oversized || 0,
        unreadable: stats.unreadable || 0,
        skipped: stats.skipped || 0,
        root: data.scannedRoot || data.root || '',
      }
    })
    .catch(() => null)
}

/**
 * 本机引擎优先：宿主里跑的还是旧进程，接口缺 termPages 这类新字段就会让预览
 * 少画一块 —— 预览要验的是我刚改的代码，不是宿主那一刻的版本。
 */
async function localSearch() {
  try {
    const { loadCorpus } = await import('../lib/corpus.js')
    const { run } = await import('../lib/engine.js')
    const { resolveWikiRootInfo } = await import('../lib/config.js')
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const info = resolveWikiRootInfo(pluginRoot, process.env.DSH_WIKI_ROOT || '')
    if (!info.root) return null
    const started = Date.now()
    const corpus = await loadCorpus(info.root)
    const result = run(corpus, { mode: 'search', query: '上下文 预算', limit: 5, explain: true })
    return {
      ...result,
      scanned: corpus.stats?.pages ?? 0,
      scannedMs: corpus.stats?.scannedMs ?? 0,
      elapsedMs: Date.now() - started,
      __stats: corpus.stats ?? null,
    }
  } catch {
    return null
  }
}

async function localState() {
  try {
    const { loadCorpus } = await import('../lib/corpus.js')
    const { readTopicConfig, resolveWikiRootInfo } = await import('../lib/config.js')
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const info = resolveWikiRootInfo(pluginRoot, process.env.DSH_WIKI_ROOT || '')
    if (!info.root) return null
    const corpus = await loadCorpus(info.root)
    const stats = corpus.stats ?? {}
    const tags = new Map()
    for (const page of corpus.pages) {
      const list = page.fields['标签']
      const values = Array.isArray(list) ? list : typeof list === 'string' ? [list] : []
      for (const value of values) tags.set(value, (tags.get(value) ?? 0) + 1)
    }
    const config = readTopicConfig(pluginRoot)
    const minCount = config.minCount ?? 2
    const topics = [...tags.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag, count]) => ({ tag, count }))
    return {
      pages: stats.pages || 0,
      resources: stats.resources || 0,
      watch: '开',
      topics,
      sections: stats.sections || 0,
      oversized: stats.oversized || 0,
      unreadable: stats.unreadable || 0,
      skipped: stats.skipped || 0,
      root: info.root,
    }
  } catch {
    return null
  }
}

/* ------------------------------ 页面 ------------------------------ */

/**
 * --diag：量一遍真实排版（宽度、截断、溢出），把结果写进页面。
 * 配上 `msedge --headless --dump-dom` 就能在没有眼睛的情况下核对版式有没有崩。
 */
const DIAG = `<pre id="diag" style="white-space:pre-wrap;font:11px/1.6 ui-monospace,monospace;color:#333;max-width:1120px;margin:26px auto;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fff"></pre>
<script>
(function () {
  function run() {
    var out = []
    var doc = document.documentElement
    out.push('page overflow: ' + (doc.scrollWidth > doc.clientWidth ? 'YES ' + doc.scrollWidth + ' > ' + doc.clientWidth : 'no'))
    var rows = document.querySelectorAll('.wn-hit-row')
    out.push('rows: ' + rows.length)
    Array.prototype.forEach.call(rows, function (row, i) {
      var name = row.querySelector('.wn-hit-name')
      var score = row.querySelector('.wn-hit-score')
      var meter = row.querySelector('.wn-hit-meter')
      var r = row.getBoundingClientRect()
      var s = score.getBoundingClientRect()
      var m = meter ? meter.getBoundingClientRect() : null
      out.push('#' + (i + 1) +
        ' h=' + r.height.toFixed(1) +
        ' disp=' + getComputedStyle(row).display +
        ' w=' + r.width.toFixed(1) +
        ' parentW=' + row.parentElement.getBoundingClientRect().width.toFixed(1) +
        ' overflow=' + (row.scrollWidth > row.clientWidth + 1) +
        ' trunc=' + (name.scrollWidth > name.clientWidth + 1) +
        ' meter.right=' + (m ? m.right.toFixed(1) : '-') +
        ' score.right=' + s.right.toFixed(1) +
        ' row.right=' + r.right.toFixed(1))
    })
    var chips = document.querySelectorAll('.wn-chip')
    var spill = 0
    Array.prototype.forEach.call(chips, function (chip) {
      var parent = chip.parentElement.getBoundingClientRect()
      if (chip.getBoundingClientRect().right > parent.right + 1) spill++
    })
    out.push('chips: ' + chips.length + ' spillOutOfParent: ' + spill)
    Array.prototype.forEach.call(document.querySelectorAll('.wn-hit-text'), function (text, i) {
      var box = text.getBoundingClientRect()
      out.push('text#' + (i + 1) + ' h=' + box.height.toFixed(1) + ' scrollH=' + text.scrollHeight + ' clipped=' + (text.scrollHeight > box.height + 1))
    })
    // 对比度：小字号最容易「看起来很淡」的地方，直接算 WCAG 比值。
    function rgb(text) {
      var m = String(text).match(/[\\d.]+/g)
      return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0]
    }
    function lum(c) {
      var f = c.map(function (v) {
        v = v / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
    }
    function bgOf(node) {
      var el = node
      while (el) {
        var bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return rgb(bg)
        el = el.parentElement
      }
      return [255, 255, 255]
    }
    Array.prototype.forEach.call(
      ['.wn-hit-name', '.wn-hit-score', '.wn-count-meta', '.wn-chip-detail', '.wn-hit-type', '.wn-hit-section', '.wn-hit-cite', '.wn-empty-line',
       '.wn-term-word', '.wn-term-count', '.wn-terms-mode', '.wn-group-label', '.wn-cite-copy', '.wn-empty-cov', '.wn-busy', '.wn-mark'],
      function (sel) {
        var node = document.querySelector(sel)
        if (!node) return
        var l1 = lum(rgb(getComputedStyle(node).color))
        // .wn-mark 自己的底纹就是它要衬的那块底色，从父元素往上找背景才有意义
        var l2 = lum(bgOf(sel === '.wn-mark' ? node.parentElement : node))
        var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        out.push('contrast ' + sel + ' = ' + ratio.toFixed(2) + ' @' + getComputedStyle(node).fontSize)
      },
    )
    document.getElementById('diag').textContent = out.join('\\n')
    // 规则到底有没有进样式表、有没有被包进不匹配的 @media —— 这类问题只有样式表自己知道。
    try {
      // 全部样式表都扫：只看最后一张会在「样式表被拆成多张」时给出假的 NOT FOUND。
      var sheets = []
      var found = []
      var walk = function (rules, label) {
        Array.prototype.forEach.call(rules, function (rule) {
          if (rule.selectorText && rule.selectorText.indexOf('wn-hit-row') !== -1) {
            found.push(rule.selectorText + ' display=' + rule.style.display + ' in=' + label + (rule.parentRule ? '/' + (rule.parentRule.conditionText || 'nested') : ''))
          }
          // 新 Chrome 里 CSSStyleRule 也带一个空的 cssRules（CSS 嵌套），
          // 只看 cssRules 是否存在就会跳掉规则本身 —— 必须先判长度。
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, label)
        })
      }
      Array.prototype.forEach.call(document.styleSheets, function (sheet, index) {
        var count = 0
        try {
          count = sheet.cssRules.length
          walk(sheet.cssRules, 'sheet#' + index)
        } catch (failure) {
          sheets.push('sheet#' + index + ' unreadable: ' + failure.message)
          return
        }
        sheets.push('sheet#' + index + ' rules=' + count)
      })
      out.push('sheets: ' + sheets.join(' | '))
      out.push('style/link 节点: ' + document.querySelectorAll('style,link[rel=stylesheet]').length)
      var tail = []
      Array.prototype.forEach.call(document.styleSheets, function (sheet) {
        try {
          var list = sheet.cssRules
          for (var i = Math.max(0, list.length - 6); i < list.length; i++) tail.push(i + ':' + (list[i].selectorText || list[i].cssText.slice(0, 24)).slice(0, 40))
        } catch {}
      })
      out.push('末尾规则: ' + tail.join(' | '))
      out.push('wn-hit-row: ' + (found.join(' ; ') || 'NOT FOUND'))
      out.push('row display: ' + getComputedStyle(document.querySelector('.wn-hit-row')).display)
      document.getElementById('diag').textContent = out.join('\\n')
    } catch (failure) {
      out.push('sheet probe failed: ' + failure.message)
      document.getElementById('diag').textContent = out.join('\\n')
    }
  }
  if (document.readyState === 'complete') run()
  else window.addEventListener('load', run)
})()
</script>`

function page(css, panels, diagBlock) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>wiki-notes 检索面板预览</title>
<style>
:root{color-scheme:light;}
html,body{margin:0;padding:0;background:#f6f1e7;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:22px;display:flex;gap:22px;align-items:flex-start;justify-content:center;flex-wrap:wrap;}
.preview-frame{display:flex;flex-direction:column;gap:8px;}
.preview-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9a8f7d;}
.preview-surface{background:#fffdf8;border:1px solid #e3daca;border-radius:14px;padding:16px 18px;box-shadow:0 1px 2px rgba(31,28,24,.04);box-sizing:border-box;}
.preview-settings{width:720px;min-width:0;}
.preview-sidebar{width:368px;min-width:0;}
${css}
</style></head>
<body>${panels}${diagBlock}</body></html>`
}

function frame(label, cls, inner) {
  return `<div class="preview-frame"><div class="preview-label">${escapeHtml(label)}</div><div class="preview-surface ${cls}">${inner}</div></div>`
}

/**
 * 面板外壳：除了输入框那一行和 .wn-root 包层，其余全部由**真组件**渲染。
 *
 * 早先这里是手抄的一段 HTML —— 结果是组件改了、预览不变，量出来的数据看着正常却早已失真。
 * 现在只有「状态」是假的（结果、选中项由参数喂），版式和文案都来自 lib/client.js 本身。
 */
function panelShell(h, preview, data, options) {
  const opts = options || {}
  const hits = (data && data.hits) || []
  const active = typeof opts.active === 'number' ? opts.active : -1
  const parts = []
  if (data === null) {
    parts.push(render(h(preview.EmptyState, { lib: opts.lib || null, onPick: function () {} })))
  } else {
    parts.push(render(h(preview.CountRow, { result: data })))
    const termRow = render(h(preview.TermRow, { termPages: data.termPages, matchMode: data.matchMode }))
    if (termRow !== '') parts.push(termRow)
    if (hits.length > 0) {
      parts.push(render(h(preview.HitList, { hits: hits, active: active })))
    } else {
      parts.push(
        render(
          h(preview.Notice, {
            tone: 'warn',
            message: '一条也没命中。要么库里确实没写这个说法，要么该换个词 —— 中文不分词，写整句只会一个词都匹配不上。',
          }),
        ),
      )
    }
  }
  // 真身外面有一层 .wn-root 提供 --wn-* 变量；预览也得包上，否则 color:var(--wn-faint) 全是无效值。
  return `<div class="wn-root"><div class="wn-panel${opts.compact ? ' wn-panel-compact' : ''}">
  <div class="wn-search"><input class="wn-input wn-search-input" type="text" value="${
    opts.query ? escapeAttr(opts.query) : ''
  }" placeholder="输入关键词，例如「上下文 预算」">${
    opts.query ? render(h(preview.CopyButton, { className: 'wn-copy-query', text: opts.query, label: '复制词' })) : ''
  }<button class="wn-btn wn-btn-primary" type="button">查一下</button></div>
  ${parts.join('\n  ')}
</div></div>`
}

/** 侧栏页：标题 + 副标题 + 面板（compact）。 */
function sidebarShell(h, preview, data, options) {
  return `<div class="wn-root wn-sidebar"><div class="wn-head"><div class="wn-title">知识库</div><div class="wn-sub">在这儿查一遍，看模型为什么会、或者为什么不会想起你的笔记。</div></div>${panelShell(
    h,
    preview,
    data,
    options,
  )}</div>`
}

/* ------------------------------ 主流程 ------------------------------ */

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : args[index + 1]
}

const text = readFileSync(SOURCE, 'utf8')
const css = extractCss(text)
const { preview } = loadBundle(css, text)

const h = createElement
const out = resolve(ROOT, arg('out', 'preview/panel.html'))

const live = (await localSearch()) || (await liveHits())
const sample = live || { hits: [], total: 0, considered: 0, elapsedMs: 0, scanned: 0 }
const libState = (await localState()) || (await liveState())

const panels = [
  frame('设置页 · 有结果', 'preview-settings', panelShell(h, preview, sample, { open: 0, query: '上下文 预算' })),
  frame('右侧栏 · 有结果', 'preview-sidebar', sidebarShell(h, preview, sample, { compact: true, query: '上下文 预算' })),
  frame(
    '右侧栏 · 键盘选中第 2 条',
    'preview-sidebar',
    sidebarShell(h, preview, sample, { compact: true, query: '上下文 预算', active: 1 }),
  ),
  frame('右侧栏 · 空状态', 'preview-sidebar', sidebarShell(h, preview, null, { compact: true, query: '', lib: libState })),
  frame('设置页 · 空状态', 'preview-settings', panelShell(h, preview, null, { query: '', lib: libState })),
]

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, page(css, panels.join('\n'), args.includes('--diag') ? DIAG : ''), 'utf8')
console.log('预览已写出：' + out)
console.log('数据来源：' + (live ? '本机引擎（' + sample.total + ' 条命中 / 扫描 ' + (sample.scanned || 0) + ' 页）' : '空（本机引擎与接口都没连上）'))
