/** config.js —— 库位置解析与保存。插件、CLI、设置页共用同一套规则，避免三处跑出不同结果。 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 内置默认库路径。
 *
 * 故意留空：插件不该猜你把笔记放在哪。留空时插件会明确报「未配置」，
 * 并在设置页（设置 → 知识库）里给一个输入框，而不是默默扫一个不存在的目录
 * 然后让模型以为「库里没有这条」。
 *
 * 想给团队内部分发一份带默认值的版本，把绝对路径填在这里即可；
 * 它仍然是优先级最低的一层，用户配过配置文件就覆盖它。
 */
export const DEFAULT_WIKI_ROOT = ''

/** 配置文件名（放在插件目录旁，不进库，也不进 profile 的 patch）。 */
export const CONFIG_FILE = 'wiki-notes.config.json'

const SOURCE_LABEL = {
  inline: '插件 config.root',
  env: '环境变量 DSH_WIKI_ROOT',
  file: '配置文件 wiki-notes.config.json',
  default: '内置默认',
  unset: '未配置',
}

/**
 * 解析库位置，并说明这个值从哪来 —— 设置页要显示「当前生效的是哪一层」，
 * 否则用户改了配置文件却发现被环境变量盖着，会以为没生效。
 *
 * 优先级：插件 config.root > 环境变量 DSH_WIKI_ROOT > 插件目录旁的配置文件 > 内置默认。
 * 四层都没有 → 返回 root:'' 与 source:'unset'，由调用方给出「请先配置」的提示。
 */
export function resolveWikiRootInfo(pluginRoot, inlineRoot = '') {
  const fromInline = typeof inlineRoot === 'string' ? inlineRoot.trim() : ''
  if (fromInline !== '') return { root: path.resolve(fromInline), source: 'inline', label: SOURCE_LABEL.inline }

  const fromEnv = typeof process.env.DSH_WIKI_ROOT === 'string' ? process.env.DSH_WIKI_ROOT.trim() : ''
  if (fromEnv !== '') return { root: path.resolve(fromEnv), source: 'env', label: SOURCE_LABEL.env }

  const saved = readConfigFile(pluginRoot)
  if (saved !== '') return { root: path.resolve(saved), source: 'file', label: SOURCE_LABEL.file }

  if (DEFAULT_WIKI_ROOT !== '') {
    return { root: path.resolve(DEFAULT_WIKI_ROOT), source: 'default', label: SOURCE_LABEL.default }
  }

  return { root: '', source: 'unset', label: SOURCE_LABEL.unset }
}

/** 未配置库路径时统一的提示语：工具、CLI、设置页三处共用，避免说法不一致。 */
export const NOT_CONFIGURED_HINT =
  '还没配置知识库路径。请在「设置 → 知识库」里填一个目录（含 .md 笔记的文件夹），' +
  '或设置环境变量 DSH_WIKI_ROOT、或写插件目录旁的 wiki-notes.config.json。'

/** 只要路径时的薄封装（工具与 CLI 用，保持旧的调用形状）。 */
export function resolveWikiRoot(pluginRoot, inlineRoot = '') {
  return resolveWikiRootInfo(pluginRoot, inlineRoot).root
}

/** 读整个配置文件。文件缺失或坏掉都当空对象 —— 不能因为配置问题让工具消失。 */
function readRecord(pluginRoot) {
  if (pluginRoot === '') return {}
  try {
    const parsed = JSON.parse(readFileSync(path.join(pluginRoot, CONFIG_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 没有配置文件或文件坏了，都退回默认值
  }
  return {}
}

/** 写回整个配置文件（保留不认识的字段，别把提示词配置顺手抹掉）。 */
function writeRecord(pluginRoot, record) {
  const file = path.join(pluginRoot, CONFIG_FILE)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

/** 读配置文件里的 root；没有文件、文件坏了、字段不对，都返回空串。 */
export function readConfigFile(pluginRoot) {
  const root = readRecord(pluginRoot).root
  return typeof root === 'string' ? root.trim() : ''
}

/**
 * 写入 root。空串 = 清掉配置、回到默认值。
 * 只写插件目录旁的这一个 JSON，绝不写知识库本体。
 */
export function writeConfigFile(pluginRoot, root) {
  const value = typeof root === 'string' ? root.trim() : ''
  const record = readRecord(pluginRoot)
  if (value === '') delete record.root
  else record.root = value
  return { file: writeRecord(pluginRoot, record), root: value }
}

/* --------------------- 提示词那一行：可关、可改、可加 --------------------- */

/** 提示词配置：默认开着（自动主题词），可整段换成自己的，也可在末尾追加一句。 */
export const DEFAULT_PROMPT_CONFIG = { enabled: true, override: '', extra: '' }

/** 单段文本上限：注入的东西每回合都在上下文里，不能让它长成一篇小作文。 */
export const PROMPT_MAX_CHARS = 600

/** 把任意输入规整成提示词配置（缺字段按默认补齐，超长截断）。不是对象就返回 null。 */
export function normalizePromptConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    enabled: raw.enabled !== false,
    override: typeof raw.override === 'string' ? raw.override.slice(0, PROMPT_MAX_CHARS).trim() : '',
    extra: typeof raw.extra === 'string' ? raw.extra.slice(0, PROMPT_MAX_CHARS).trim() : '',
  }
}

/** 读提示词配置。缺字段按默认补齐，超长截断。 */
export function readPromptConfig(pluginRoot) {
  return normalizePromptConfig(readRecord(pluginRoot).prompt) ?? { ...DEFAULT_PROMPT_CONFIG }
}

/** 写提示词配置。整块替换 `prompt` 字段，其余字段原样保留。 */
export function writePromptConfig(pluginRoot, next) {
  const record = readRecord(pluginRoot)
  const clean = normalizePromptConfig(next) ?? { ...DEFAULT_PROMPT_CONFIG }
  record.prompt = clean
  return { file: writeRecord(pluginRoot, record), config: clean }
}
