/**
 * docs.mjs —— 文档也是要守的。
 *
 * 这个仓库的文档有过两次病：
 * ① `README.md` 长期指着 `examples/sample-wiki/`，那份样例早改名了，链接静静烂掉没人发现；
 * ② 上手材料一度拆成「指南 + 模板 + 六份提示词」三类文件，读者要先读一份再看另一份。
 * 现在收敛成一份 `docs/AGENTS.md`（给 agent 的操作手册）。这里钉住两件事：
 * 那一个文件必须自成体系，且不许再悄悄长回多文件。
 */
import './support/quiet-ledger.mjs'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

let passed = 0
function ok(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const root = resolve(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const guide = () => read('docs/AGENTS.md')

ok('docs/AGENTS.md 在，且是唯一的上手文件', () => {
  assert.equal(existsSync(join(root, 'docs/AGENTS.md')), true)
  assert.equal(existsSync(join(root, 'docs/使用指南.md')), false, '指南又回来了——内容应该只在 AGENTS.md')
  assert.equal(existsSync(join(root, 'docs/prompts')), false, 'prompts 目录又回来了')
  assert.equal(existsSync(join(root, 'docs/templates')), false, 'templates 目录又回来了')
})

ok('一个文件装完全部：结构 / 类型 / 开场 / 命名 / 字段 / 五个操作 / 边界', () => {
  const text = guide()
  for (const heading of [
    '## 1. 三层结构',
    '## 2. 页面类型与目录',
    '## 3. 每次会话开场',
    '## 4. 命名、别名、双链',
    '## 5. Frontmatter',
    '### 6.1 摄入 ingest',
    '### 6.2 查询 query',
    '### 6.3 体检 lint',
    '### 6.4 归档 archive',
    '### 6.5 造工具',
    '## 7. `index.md` 与 `log.md`',
    '## 8. 边界（硬约束）',
  ]) {
    assert.match(text, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'), `缺 ${heading}`)
  }
})

ok('第一次建库的步骤写在里面（不是「去读另一份文档」）', () => {
  const text = guide()
  assert.match(text, /第一次建库的六步/)
  assert.match(text, /复制到知识库根目录/)
  // 建库路径要能被一句话说清：装插件 → 没库给提示词 → 甩给 AI → 建好填路径。
  const readme = read('README.md')
  assert.match(readme, /没库时它会给你一句话/)
  assert.match(readme, /设置 → 知识库/)
  assert.equal(/\n\| 你要做的事 \| 看哪儿 \|/.test(readme), false, 'README 又退回成「材料清单」了')
})

ok('长度控制在 220 行内（写长了没人读，包括 AI）', () => {
  const lines = guide().split('\n').length
  assert.ok(lines <= 220, `AGENTS.md ${lines} 行，超了`)
})

ok('四条硬纪律一句不少', () => {
  const text = guide()
  assert.match(text, /永不修改 `原始资料-raw\/`/, '没写「永不改 raw」')
  assert.match(text, /永不物理删除/, '没写「不物理删除」')
  assert.match(text, /没记等于没发生/, '没写「改动必记 log」')
  assert.match(text, /有引文必须有位置/, '没写引文硬规则')
})

ok('造工具的四条纪律在（只读 → dry-run → 幂等 → 先 commit）', () => {
  const text = guide()
  for (const rule of [/先只读/, /--dry-run/, /幂等/, /先 `git commit`/]) {
    assert.match(text, rule, `造工具纪律缺 ${rule}`)
  }
})

ok('三种知识状态分开写（别用一句「不知道」糊过去）', () => {
  const text = guide()
  assert.match(text, /页不存在/)
  assert.match(text, /概念不存在/)
  assert.match(text, /存在但不能回答/)
})

ok('手册写明库该放哪个盘（别放工作区所在的 C 盘）', () => {
  const text = guide()
  assert.match(text, /不要建在工作区所在的盘/)
  assert.match(text, /D:\\Markdown-Wiki|`D:\\Markdown-Wiki`/)
})

ok('不含作者库的专属内容（这份文件要能甩给任何人）', () => {
  const banned = ['考公', '行测', '申论', '党史', '时政周报', '错题回写', '五方取证']
  const text = guide()
  for (const word of banned) assert.equal(text.includes(word), false, `出现了「${word}」`)
})

ok('文档里的相对链接全都指向真东西（README + docs 下所有 md）', () => {
  const files = ['README.md', 'docs/README.md', 'docs/AGENTS.md']
  const missing = []
  for (const file of files) {
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

ok('README 只指一个文件，不再列一串材料', () => {
  const text = read('README.md')
  assert.match(text, /^## 从零到能查$/m)
  assert.match(text, /\[docs\/AGENTS\.md\]\(docs\/AGENTS\.md\)/)
  assert.equal(/docs\/prompts\//.test(text), false, 'README 还在指 prompts')
  assert.equal(/docs\/使用指南\.md/.test(text), false, 'README 还在指使用指南')
})

ok('npm 包里带上了这一份（link: 装的用户也拿得到）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs'), 'files 里没有 docs')
  const docsFiles = readdirSync(join(root, 'docs'))
  assert.ok(docsFiles.includes('AGENTS.md'), 'docs/AGENTS.md 不在')
})

ok('CHANGELOG 记了这一版', () => {
  assert.match(read('CHANGELOG.md'), /docs\/AGENTS\.md/, 'CHANGELOG 里没有这次收敛的记录')
})

console.log(`\n[docs] ${passed} 项通过（文档守卫）`)
