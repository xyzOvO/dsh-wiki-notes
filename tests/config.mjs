/**
 * config.mjs —— 配置文件层的读写。
 *
 * 同一份 wiki-notes.config.json 现在存两件事：库路径和提示词配置。
 * 危险的失败是「存提示词时把路径抹了」或者反过来，所以这里专门钉这个。
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  PROMPT_MAX_CHARS,
  readConfigFile,
  readPromptConfig,
  readTopicConfig,
  writeTopicConfig,
  writeConfigFile,
  writePromptConfig,
} from '../lib/config.js'

let failed = 0
function check(name, ok, detail = '') {
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

if (failed > 0) {
  process.stderr.write(`config smoke 失败 ${failed} 项\n`)
  process.exit(1)
}
console.log('config smoke 全部通过（12 项）')
