/**
 * accept.mjs —— 端到端验收：从「设置页会做什么」出发，验证换库真的立刻生效。
 *
 * 它做的事等价于用户在设置页里：输入路径 → 保存 → 看到数字变了。
 * 每一步都包在 try/finally 里：无论中间怎么失败，最后一定把库路径恢复成原值。
 */

const ORIGIN = (process.env.DSH_WEB_URL || 'http://127.0.0.1:63598').replace(/\/$/, '')
const BASE = `${ORIGIN}/api/wiki-notes`

const WIKI = (process.env.WIKI_ROOT ?? '')
const PARENT = (process.env.WIKI_ROOT_PARENT ?? '')
if (WIKI === '' || PARENT === '') {
  console.log('跳过：需要 WIKI_ROOT / WIKI_ROOT_PARENT，且 DSH 正在运行（DSH_WEB_URL）')
  process.exit(0)
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

async function get(path) {
  const response = await fetch(BASE + path, { cache: 'no-store' })
  return response.json()
}
async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return response.json()
}

const original = await get('/state')
console.log('原始状态：', original.root, `（${original.stats.pages} 页 / ${original.stats.resources} 份资料）`)
check('配置来源是文件层', original.source === 'file', `source=${original.source}`)
check('三个统计字段都在', ['pages', 'resources', 'brokenPages'].every((key) => typeof original.stats[key] === 'number'))

try {
  // 1. 切到上一层的 LLM-Wiki（用户最容易犯的错：指错一层）
  const changed = await post('/save', { root: PARENT })
  check('保存上层路径后立即换成 295 页', changed.stats.pages > 200, `实得 ${changed.stats.pages} 页`)
  check('保存后 source 仍是文件层', changed.source === 'file')
  check('savedRoot 记的是绝对路径', String(changed.savedRoot).replace(/\\/g, '/') === PARENT, `savedRoot=${changed.savedRoot}`)

  // 2. 换回来
  const restored = await post('/save', { root: WIKI })
  check('切回知识层后回到 70 页', restored.stats.pages === original.stats.pages, `实得 ${restored.stats.pages} 页`)
  check('红链数也对得上', restored.stats.brokenPages === original.stats.brokenPages)

  // 3. 试扫但不保存：状态不该被改动
  const probe = await post('/check', { root: PARENT })
  check('试扫返回 hint 提醒指错层', typeof probe.hint === 'string' && probe.hint.includes('知识层-wiki'))
  const afterProbe = await get('/state')
  check('试扫没有改动配置', afterProbe.root === restored.root)

  // 4. 乱写路径：能扫出 0 页就报错，不静默成功
  const bogus = await post('/check', { root: 'D:/这个目录不存在/知识层-wiki' })
  check('不存在的路径明确报错', bogus.ok === false && typeof bogus.error === 'string')

  // 5. 重新扫描
  const rescanned = await post('/rescan')
  check('重扫后页数不变', rescanned.stats.pages === original.stats.pages)
} finally {
  const final = await post('/save', { root: original.root })
  const same = final.stats.pages === original.stats.pages && final.root === original.root
  check('已恢复原始库路径', same, `现在 ${final.root}（${final.stats.pages} 页）`)
}

console.log(failures === 0 ? '\n验收全部通过' : `\n有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
