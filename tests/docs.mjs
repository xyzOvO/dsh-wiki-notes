/**
 * docs.mjs —— 文档也是要守的。
 *
 * 这个仓库的文档有个具体病史：`README.md` 里长期指着 `examples/sample-wiki/`，
 * 而那份样例早改名了，链接静静烂掉没人发现；`docs/库结构.md` 被合并进使用指南后，
 * 如果还有地方指它，读者会撞 404。这类问题测试不跑就永远查不出来，
 * 所以这里把「文档里写的路径必须存在」「提示词必须带验收标准」钉成断言。
 */
import './support/quiet-ledger.mjs'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const root = resolve(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const PROMPTS = [
  'docs/prompts/p1-搭骨架.md',
  'docs/prompts/p2-立规则.md',
  'docs/prompts/p3-摄入.md',
  'docs/prompts/p4-体检.md',
  'docs/prompts/p5-查询.md',
  'docs/prompts/p6-脱敏.md',
]

ok('六份提示词都在', () => {
  for (const p of PROMPTS) assert.equal(existsSync(join(root, p)), true, `${p} 不见了`)
})

ok('每份提示词都有「提示词 / 验收标准 / 失败怎么办」三节', () => {
  for (const p of PROMPTS) {
    const text = read(p)
    for (const heading of ['## 提示词', '## 验收标准', '## 失败怎么办']) {
      assert.match(text, new RegExp(`^${heading}`, 'm'), `${p} 缺 ${heading}`)
    }
  }
})

ok('每份提示词都给了可对照的勾选项（至少 3 个 - [ ]）', () => {
  for (const p of PROMPTS) {
    const boxes = read(p).match(/^- \[ \] /gm) || []
    assert.ok(boxes.length >= 3, `${p} 只有 ${boxes.length} 个验收项，照着打勾都做不到`)
  }
})

ok('提示词里不许出现真实库的具体内容（示例页名一律通用）', () => {
  // 这个是隐私红线：提示词会被用户直接贴给别家的模型，里面不能带作者真实笔记的痕迹。
  const banned = ['考公', '行测', '申论', '党史', '时政周报', '错题', '五方取证']
  for (const p of PROMPTS) {
    const text = read(p)
    for (const word of banned) assert.equal(text.includes(word), false, `${p} 里出现了「${word}」`)
  }
})

ok('AGENTS.md 模板存在，且六节齐全', () => {
  const text = read('docs/templates/AGENTS.md')
  for (const heading of [
    '## 1. 三层结构',
    '## 2. 页面类型与目录',
    '## 3. 每次会话开场',
    '## 4. 命名、别名、双链',
    '## 5. Frontmatter',
    '## 6. 操作',
    '## 8. 边界（硬约束）',
  ]) {
    assert.match(text, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'), `模板缺 ${heading}`)
  }
})

ok('AGENTS.md 模板控制在 250 行以内（写长了没人读，包括 AI）', () => {
  const lines = read('docs/templates/AGENTS.md').split('\n').length
  assert.ok(lines <= 250, `模板 ${lines} 行，超了`)
})

ok('AGENTS.md 模板不含作者库的专属规则（那是要用户自己加的）', () => {
  const banned = ['考公', '行测', '申论', '时政周报', '错题回写', '五方取证', 'L3 派五路']
  for (const word of banned) {
    assert.equal(read('docs/templates/AGENTS.md').includes(word), false, `模板里出现了「${word}」`)
  }
})

ok('AGENTS.md 模板把最要紧的三条纪律写成了硬约束', () => {
  const text = read('docs/templates/AGENTS.md')
  assert.match(text, /永不修改 `原始资料-raw\/`/, '没写「永不改 raw」')
  assert.match(text, /永不物理删除/, '没写「不物理删除」')
  assert.match(text, /没记等于没发生/, '没写「改动必记 log」')
  assert.match(text, /有引文必须有位置/, '没写引文硬规则')
})

ok('使用指南存在，八节 + 三个附录都在', () => {
  const text = read('docs/使用指南.md')
  for (let i = 0; i <= 8; i += 1) {
    assert.match(text, new RegExp(`^## ${i}\\. `, 'm'), `指南缺第 ${i} 节`)
  }
  for (const appendix of ['## 附录 A', '## 附录 B', '## 附录 C']) {
    assert.match(text, new RegExp(`^${appendix}`, 'm'), `指南缺 ${appendix}`)
  }
})

ok('使用指南开头就说清「插件只读」这条分工', () => {
  const text = read('docs/使用指南.md')
  assert.match(text, /插件是这套规矩的读取端，不是维护端/)
  assert.match(text, /不建库、不整理、不写回、不联网/)
})

ok('每节都有英文摘要行（> EN:）', () => {
  const text = read('docs/使用指南.md')
  const sections = text.match(/^## [0-8]\. /gm) || []
  const en = text.match(/^> EN: /gm) || []
  assert.equal(sections.length, 9)
  assert.ok(en.length >= 9, `只有 ${en.length} 行英文摘要`)
})

ok('docs/库结构.md 已经并进使用指南，不许再回来', () => {
  assert.equal(existsSync(join(root, 'docs/库结构.md')), false, '旧的库结构.md 又出现了——内容应该只在附录 B')
  const guide = read('docs/使用指南.md')
  assert.match(guide, /附录 B · 插件认的字段与文件/, '附录 B 标题变了？文档导航页指着它')
})

ok('文档里的相对链接全都指向真东西（README + docs 下所有 md）', () => {
  const targets = ['README.md', 'docs/README.md', 'docs/使用指南.md', 'docs/templates/AGENTS.md', ...PROMPTS]
  const missing = []
  for (const file of targets) {
    const text = read(file)
    const dir = dirname(join(root, file))
    const links = text.match(/\]\((\.{0,2}\/[^)\s#]+|[^)\s:#/][^)\s#]*\.(?:md|png|json|yml))\)/g) || []
    for (const raw of links) {
      const href = raw.slice(2, -1).split('#')[0]
      if (href === '' || /^(https?:|mailto:)/.test(href)) continue
      if (!existsSync(resolve(dir, href))) missing.push(`${file} → ${href}`)
    }
  }
  assert.deepEqual(missing, [], `这些链接指向不存在的文件：\n    ${missing.join('\n    ')}`)
})

ok('README 的目录里给了「从零到能查」的路标', () => {
  const text = read('README.md')
  assert.match(text, /^## 从零到能查（第一次用看这个）/m)
  assert.match(text, /\[使用指南\]\(docs\/使用指南\.md\)/)
  assert.match(text, /\[AGENTS\.md 模板\]\(docs\/templates\/AGENTS\.md\)/)
})

ok('npm 包里带上了 templates 与 prompts（link: 装的用户也拿得到）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs'), 'files 里没有 docs')
  const docsFiles = readdirSync(join(root, 'docs'))
  assert.ok(docsFiles.includes('templates'), 'docs/templates 不在')
  assert.ok(docsFiles.includes('prompts'), 'docs/prompts 不在')
  assert.ok(statSync(join(root, 'docs/prompts')).isDirectory())
})

ok('CHANGELOG 记了这一版（文档重构不是「顺手改的」）', () => {
  assert.match(read('CHANGELOG.md'), /使用指南|AGENTS\.md 模板|从零到能查/, 'CHANGELOG 里没有这次文档重构的记录')
})

console.log(`\n[examples] ${passed} 项通过（文档守卫）`)
