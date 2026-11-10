/**
 * config.mjs —— 配置文件层的读写。
 *
 * 同一份 wiki-notes.config.json 现在存两件事：库路径和提示词配置。
 * 危险的失败是「存提示词时把路径抹了」或者反过来，所以这里专门钉这个。
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PROMPT_MAX_CHARS,
  mergePromptConfig,
  mergeTopicConfig,
  normalizeCallsConfig,
  readCallsConfig,
  readConfigFile,
  readPromptConfig,
  readTopicConfig,
  writeCallsConfig,
  writeTopicConfig,
  writeConfigFile,
  writePromptConfig,
} from '../lib/config.js'

let failed = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (ok) return
  failed += 1
  process.stderr.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const dir = mkdtempSync(path.join(tmpdir(), 'wiki-notes-cfg-'))

// 1. 存提示词不能把路径抹掉
writeConfigFile(dir, 'D:/notes/wiki')
writePromptConfig(dir, { enabled: false, override: '要查。', extra: '' })
check('存提示词后路径还在', readConfigFile(dir) === 'D:/notes/wiki', readConfigFile(dir))
check('提示词读得回', readPromptConfig(dir).override === '要查。', JSON.stringify(readPromptConfig(dir)))

// 2. 存路径不能把提示词抹掉
writeConfigFile(dir, 'D:/notes/other')
check('存路径后提示词还在', readPromptConfig(dir).enabled === false, JSON.stringify(readPromptConfig(dir)))
check('路径已更新', readConfigFile(dir) === 'D:/notes/other', readConfigFile(dir))

// 3. 清掉路径（空串）只清 root
writeConfigFile(dir, '')
check('清路径后 root 为空', readConfigFile(dir) === '', readConfigFile(dir))
check('清路径后提示词没被连带清掉', readPromptConfig(dir).override === '要查。', JSON.stringify(readPromptConfig(dir)))

// 4. 超长截断 + 非法值兜底
const long = 'x'.repeat(PROMPT_MAX_CHARS + 100)
writePromptConfig(dir, { enabled: 'nope', override: long, extra: 123 })
const clamped = readPromptConfig(dir)
check('override 截断到上限', clamped.override.length === PROMPT_MAX_CHARS, String(clamped.override.length))
check('enabled 非布尔按开启处理', clamped.enabled === true, String(clamped.enabled))
check('extra 非字符串按空处理', clamped.extra === '', JSON.stringify(clamped.extra))

// 5. 文件坏掉不抛错，按默认值走
writeFileSync(path.join(dir, 'wiki-notes.config.json'), '{ 这不是 json', 'utf8')
check('坏文件时 root 为空', readConfigFile(dir) === '', readConfigFile(dir))
check('坏文件时提示词用默认', readPromptConfig(dir).enabled === true, JSON.stringify(readPromptConfig(dir)))

// 5b. 覆盖坏文件之前必须留备份，否则「存一次设置」= 静默丢掉主题词/桥路径/提示词
// 注意：此刻配置文件里还是上面那段坏 JSON，这里一次写操作会触发备份
writePromptConfig(dir, { enabled: true, override: '要查。', extra: '' })
const brokenCopy = path.join(dir, 'wiki-notes.config.json.broken')
check('坏文件被覆盖前留了 .broken 备份', existsSync(brokenCopy), brokenCopy)
check('备份内容是原来那段坏 JSON', readFileSync(brokenCopy, 'utf8') === '{ 这不是 json', readFileSync(brokenCopy, 'utf8'))
check('覆盖后能正常读回', readPromptConfig(dir).override === '要查。', JSON.stringify(readPromptConfig(dir)))
check('写入后不留下 .tmp', !existsSync(path.join(dir, 'wiki-notes.config.json.tmp')), '还留着 .tmp')

// 5c. 正常文件不该产生备份（否则每次保存都堆一个 .broken）
const before = existsSync(brokenCopy)
writePromptConfig(dir, { enabled: true, override: '再查。', extra: '' })
check('正常覆盖不新增 .broken', existsSync(brokenCopy) === before, '多出了一个备份')
check('正常覆盖后内容已更新', readPromptConfig(dir).override === '再查。', JSON.stringify(readPromptConfig(dir)))

// 6. 不认识的字段要保留（别人手写的注释性字段不该被吃掉）
writeFileSync(path.join(dir, 'wiki-notes.config.json'), JSON.stringify({ root: 'D:/a', note: '手写的' }), 'utf8')
writePromptConfig(dir, { enabled: true, override: '', extra: '' })
const kept = JSON.parse(readFileSync(path.join(dir, 'wiki-notes.config.json'), 'utf8'))
check('未知字段被保留', kept.note === '手写的', JSON.stringify(kept))

rmSync(dir, { recursive: true, force: true })

// 9. 主题词配置：单独写，不碰路径与提示词（上一个临时目录已删，这里另起一个）
const dir2 = mkdtempSync(path.join(tmpdir(), 'wiki-notes-topic-'))
writeConfigFile(dir2, 'D:/notes/wiki')
writePromptConfig(dir2, { enabled: true, override: '', extra: '加一句' })
writeTopicConfig(dir2, { minCount: 1 })
check('写主题词后路径还在', readConfigFile(dir2) === 'D:/notes/wiki', readConfigFile(dir2))
check('写主题词后提示词还在', readPromptConfig(dir2).extra === '加一句', JSON.stringify(readPromptConfig(dir2)))
check('minCount 读得回来', readTopicConfig(dir2).minCount === 1, JSON.stringify(readTopicConfig(dir2)))
writeTopicConfig(dir2, { minCount: 99 })
check('minCount 超上限被夹到 20', readTopicConfig(dir2).minCount === 20, JSON.stringify(readTopicConfig(dir2)))
check('stopwords 缺省为开', readTopicConfig(dir2).stopwords === true)
rmSync(dir2, { recursive: true, force: true })

// 10. 局部合并：没提到的字段不许被清空（POST /prompt 只带 enabled 的那个 bug）
const current = { enabled: true, override: '整句替换', extra: '加一句' }
const onlyEnabled = mergePromptConfig(current, { enabled: false })
check('合并：只改 enabled 不动 override', onlyEnabled.override === '整句替换', JSON.stringify(onlyEnabled))
check('合并：只改 enabled 不动 extra', onlyEnabled.extra === '加一句', JSON.stringify(onlyEnabled))
check('合并：enabled 真的改了', onlyEnabled.enabled === false, JSON.stringify(onlyEnabled))
const onlyExtra = mergePromptConfig(current, { extra: '换一句' })
check('合并：只给 extra 时 enabled/override 保持', onlyExtra.enabled === true && onlyExtra.override === '整句替换', JSON.stringify(onlyExtra))
const notPatch = mergePromptConfig(current, null)
check('合并：patch 非对象时原样返回', notPatch.extra === '加一句' && notPatch.enabled === true, JSON.stringify(notPatch))
const wrongType = mergePromptConfig(current, { enabled: 'yes' })
check('合并：类型不对的字段当没写', wrongType.enabled === true && wrongType.override === '整句替换', JSON.stringify(wrongType))
const topicMerged = mergeTopicConfig({ minCount: 1, stopwords: false }, { minCount: 3 })
check('合并主题词：保留 stopwords', topicMerged.stopwords === false && topicMerged.minCount === 3, JSON.stringify(topicMerged))

// 调用记录配置：缺字段按默认补齐，enabled 只认显式 false
const callsEmpty = normalizeCallsConfig({})
check('calls 配置：空对象走默认（开着、路径空）', callsEmpty.enabled === true && callsEmpty.log === '', JSON.stringify(callsEmpty))
const callsOff = normalizeCallsConfig({ enabled: false })
check('calls 配置：enabled=false 才关', callsOff.enabled === false, JSON.stringify(callsOff))
const callsTruthy = normalizeCallsConfig({ enabled: 'no' })
// 字符串 "false" 是真值，按旧写法（raw.enabled !== false）会被读成「开」——
// 想关掉观察反而打开了它，然后开始往账本里记东西。
check('calls 配置：字符串 "false"/"no" 也算关闭', callsTruthy.enabled === false, JSON.stringify(callsTruthy))
check('calls 配置：字符串 "yes" 算打开', normalizeCallsConfig({ enabled: 'yes' }).enabled === true)
check('calls 配置：数字 0 算关闭', normalizeCallsConfig({ enabled: 0 }).enabled === false)
check('calls 配置：认不出来的值走默认（开着）', normalizeCallsConfig({ enabled: 'maybe' }).enabled === true, JSON.stringify(normalizeCallsConfig({ enabled: 'maybe' })))
check('提示词配置：合并时字符串 "false" 也关', mergePromptConfig({ enabled: true }, { enabled: 'false' }).enabled === false, JSON.stringify(mergePromptConfig({ enabled: true }, { enabled: 'false' })))
check('提示词配置：没提到 enabled 时保持原值', mergePromptConfig({ enabled: false }, { extra: 'x' }).enabled === false)
const callsLog = normalizeCallsConfig({ log: '  /tmp/x.jsonl  ' })
check('calls 配置：log 去空白', callsLog.log === '/tmp/x.jsonl', JSON.stringify(callsLog))
check('calls 配置：非对象返回 null', normalizeCallsConfig(null) === null && normalizeCallsConfig([1]) === null)
check('calls 配置：读不到时给默认值', readCallsConfig('/不存在的目录').enabled === true)

if (failed > 0) {
  process.stderr.write(`config smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log(`config smoke 全部通过（${total} 项）`)
