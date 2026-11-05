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

/**
 * 配置文件的实际位置：插件目录旁的那一份。
 *
 * 环境变量 DSH_WIKI_CONFIG 能把它指到别处 —— 测试用它把写入引到临时文件，
 * 免得跑一次 `npm test` 就把你设置页里的库路径和提示词改掉。
 */
export function configPath(pluginRoot) {
  const override = typeof process.env.DSH_WIKI_CONFIG === 'string' ? process.env.DSH_WIKI_CONFIG.trim() : ''
  if (override !== '') return path.resolve(override)
  return pluginRoot === '' ? '' : path.join(pluginRoot, CONFIG_FILE)
}

/** 读整个配置文件。文件缺失或坏掉都当空对象 —— 不能因为配置问题让工具消失。 */
function readRecord(pluginRoot) {
  const file = configPath(pluginRoot)
  if (file === '') return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 没有配置文件或文件坏了，都退回默认值
  }
  return {}
}

/** 写回整个配置文件（保留不认识的字段，别把提示词配置顺手抹掉）。 */
function writeRecord(pluginRoot, record) {
  const file = configPath(pluginRoot)
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

/* --------------------- 主题词那一行：阈值与停用词 --------------------- */

/**
 * 主题词配置。
 *
 * minCount：只统计出现这么多次以上的标签。=1 就是「不管频次，全都算」。
 *   挡的是「只属于某一篇笔记」的专有名词 —— 人物、朝代、某次会议，
 *   它们对「这个库在研究什么」没有代表性，占掉 5 个名额就是浪费。
 * stopwords：跳过工具泛词（数据 / 工具 / 人物 / 方法…）。这类词哪篇都能打，
 *   一旦挤进前五，模型会觉得「什么话题都沾边」，于是动不动来查库，白烧 token。
 */
export const DEFAULT_TOPIC_CONFIG = { minCount: 2, stopwords: true }

/** 把任意输入规整成主题词配置。不是对象就返回 null；minCount 夹在 1–20。 */
export function normalizeTopicConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const num = Number(raw.minCount)
  const minCount = Number.isFinite(num) ? Math.max(1, Math.min(Math.trunc(num), 20)) : DEFAULT_TOPIC_CONFIG.minCount
  return { minCount, stopwords: raw.stopwords !== false }
}

/**
 * 把「局部改动」并进现有主题词配置。
 *
 * 和 mergePromptConfig 同理：接口拿到的经常只有 minCount 一个字段，
 * 直接 normalize(patch) 会把 stopwords 打回默认值，等于悄悄改了另一项。
 */
export function mergeTopicConfig(current, patch) {
  const base = normalizeTopicConfig(current) ?? { ...DEFAULT_TOPIC_CONFIG }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  return (
    normalizeTopicConfig({
      minCount: patch.minCount === undefined ? base.minCount : patch.minCount,
      stopwords: typeof patch.stopwords === 'boolean' ? patch.stopwords : base.stopwords,
    }) ?? base
  )
}

/** 读主题词配置。缺字段按默认补齐。 */
export function readTopicConfig(pluginRoot) {
  return normalizeTopicConfig(readRecord(pluginRoot).topics) ?? { ...DEFAULT_TOPIC_CONFIG }
}

/** 写主题词配置。整块替换 `topics` 字段，其余字段原样保留。 */
export function writeTopicConfig(pluginRoot, next) {
  const record = readRecord(pluginRoot)
  const clean = normalizeTopicConfig(next) ?? { ...DEFAULT_TOPIC_CONFIG }
  record.topics = clean
  return { file: writeRecord(pluginRoot, record), config: clean }
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

/**
 * 把「局部改动」并进现有提示词配置。
 *
 * 为什么不直接用 normalizePromptConfig(patch)：那样没带的字段会被打回默认值，
 * 等于把用户存好的 override / extra 抹掉。HTTP 接口经常只带一个字段
 * （比如只切 enabled），这里补的正是「没提到就别动」。
 */
export function mergePromptConfig(current, patch) {
  const base = normalizePromptConfig(current) ?? { ...DEFAULT_PROMPT_CONFIG }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  return (
    normalizePromptConfig({
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled,
      override: typeof patch.override === 'string' ? patch.override : base.override,
      extra: typeof patch.extra === 'string' ? patch.extra : base.extra,
    }) ?? base
  )
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

/* ------------------- 知识网关：Python Bridge 的那一行 ------------------- */

/**
 * Bridge 配置。
 *
 * toolsRoot 是「Python 管线所在目录」（里面要有 wiki_bridge.py）。
 * 故意不给内置默认值：猜错目录比没配更糟 —— 猜错时插件会起一个
 * 根本不存在的脚本，报出来的错还像是库坏了。留空就明确说「没配」。
 *
 * python 留空表示用 PATH 里的 `python`；Windows 上多版本共存时建议填绝对路径。
 * timeoutMs 默认 120s：本机实测一次 context 约 10–25 秒，留足余量但不至于挂死。
 */
export const DEFAULT_BRIDGE_CONFIG = {
  python: '',
  toolsRoot: '',
  observeLog: '',
  timeoutMs: 120000,
  ttlSeconds: 1800,
}

/** 把任意输入规整成 Bridge 配置：缺字段补默认，数字夹在合理区间。 */
export function normalizeBridgeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const num = (v, def, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.max(min, Math.min(Math.trunc(n), max))
  }
  return {
    python: typeof raw.python === 'string' ? raw.python.trim() : '',
    toolsRoot: typeof raw.toolsRoot === 'string' ? raw.toolsRoot.trim() : '',
    observeLog: typeof raw.observeLog === 'string' ? raw.observeLog.trim() : '',
    timeoutMs: num(raw.timeoutMs, DEFAULT_BRIDGE_CONFIG.timeoutMs, 5000, 600000),
    ttlSeconds: num(raw.ttlSeconds, DEFAULT_BRIDGE_CONFIG.ttlSeconds, 60, 86400),
  }
}

/** 读 Bridge 配置。环境变量能盖过文件（方便临时换 python）。 */
export function readBridgeConfig(pluginRoot) {
  const base = normalizeBridgeConfig(readRecord(pluginRoot).bridge) ?? { ...DEFAULT_BRIDGE_CONFIG }
  const envRoot = typeof process.env.DSH_WIKI_TOOLS === 'string' ? process.env.DSH_WIKI_TOOLS.trim() : ''
  const envPython = typeof process.env.DSH_WIKI_PYTHON === 'string' ? process.env.DSH_WIKI_PYTHON.trim() : ''
  const envObserve = typeof process.env.DSH_WIKI_OBSERVE_LOG === 'string' ? process.env.DSH_WIKI_OBSERVE_LOG.trim() : ''
  return {
    ...base,
    toolsRoot: envRoot || base.toolsRoot,
    python: envPython || base.python,
    observeLog: envObserve || base.observeLog,
  }
}

/** 写 Bridge 配置。整块替换 `bridge` 字段，其余字段原样保留。 */
export function writeBridgeConfig(pluginRoot, next) {
  const record = readRecord(pluginRoot)
  const clean = normalizeBridgeConfig(next) ?? { ...DEFAULT_BRIDGE_CONFIG }
  record.bridge = clean
  return { file: writeRecord(pluginRoot, record), config: clean }
}
