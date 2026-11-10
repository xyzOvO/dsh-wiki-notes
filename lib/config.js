/** config.js —— 库位置解析与保存。插件、CLI、设置页共用同一套规则，避免三处跑出不同结果。 */

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { clipChars } from './text.js'

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

/**
 * UTF-8 BOM 是编码标记，不是 JSON 内容。PowerShell 的 `Out-File -Encoding utf8`
 * （PS 5.1）写出的是带 BOM 的文件，直接 JSON.parse 会失败 —— 后果不是「读不到」这么
 * 简单：readRecord 把整份配置当空对象，界面显示「还没配库」；下一次写入又把这份
 * 其实完好的配置当成坏文件备份成 .broken，用户的主题词/桥路径被埋进备份里。
 * 读 JSON 的地方统一先剥掉开头那一个 BOM；中间的 U+FEFF 属于内容，不动。
 *
 * 导出给宿主半复用：package.json 与 lint-history.json 若裸 JSON.parse，带 BOM 时
 * 分别会退化成「版本 unknown」和「第一次记录基线」，同样是静默丢信息。
 */
export function readJsonFile(file) {
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
}

/** 读整个配置文件。文件缺失或坏掉都当空对象 —— 不能因为配置问题让工具消失。 */
function readRecord(pluginRoot) {
  const file = configPath(pluginRoot)
  if (file === '') return {}
  try {
    const parsed = readJsonFile(file)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 没有配置文件或文件坏了，都退回默认值
  }
  return {}
}

/** 现有文件是不是一份可用的配置对象（用来决定覆盖前要不要留备份）。 */
function isUsableRecord(file) {
  try {
    const parsed = readJsonFile(file)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** 写回整个配置文件（保留不认识的字段，别把提示词配置顺手抹掉）。 */
function writeRecord(pluginRoot, record) {
  const file = configPath(pluginRoot)
  if (file === '') return ''
  const text = `${JSON.stringify(record, null, 2)}\n`

  // 现有文件若是坏的，直接覆盖等于把用户之前那份配置（主题词、桥路径、提示词）一起埋了 ——
  // 写入前先留一份 `.broken` 备份，随后 readRecord 会把空对象当起点，界面照常能存。
  if (existsSync(file) && !isUsableRecord(file)) {
    try {
      copyFileSync(file, `${file}.broken`)
    } catch {
      // 备份失败（权限、磁盘满）也要继续写，否则设置页直接存不了
    }
  }

  // 原子写：崩在写一半只会留下 `.tmp`，配置文件本身仍是上一份完整内容。
  // 以前是直写，一次意外断电就可能得到一个被截断的 JSON，而 readRecord 会把坏文件当空对象，
  // 用户看到的是「我配的路径怎么没了」。
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
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

/* --------------------- 调用记录：开关与账本位置 --------------------- */

/**
 * 把「开 / 关」这种输入统一成布尔。
 *
 * 只认显式 false 的写法（`raw.enabled !== false`）有个坑：字符串 `"false"` 是真值，
 * 于是「想关掉观察」的调用会把它**打开** —— 方向反了，而且打开之后就开始往账本里记东西。
 * 这里把常见的写法都认下来，认不出来的保留原值（调用方给的是 undefined 时不改语义）。
 */
function toFlag(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true
    if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false
  }
  return fallback
}

/**
 * 调用记录配置。
 *
 * enabled 的语义是「要不要记账」：一个拼错的字符串不该让审计悄悄停工，
 * 但也不能把 `"false"` 读成开 —— 见 toFlag。
 * log 空串表示「用插件根目录下的 calls.jsonl」。
 */
export const DEFAULT_CALLS_CONFIG = { enabled: true, log: '' }

/** 把任意输入规整成调用记录配置。不是对象就返回 null。 */
export function normalizeCallsConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    enabled: toFlag(raw.enabled, true),
    log: typeof raw.log === 'string' ? raw.log.trim() : '',
  }
}

/** 读调用记录配置。缺字段按默认补齐。 */
export function readCallsConfig(pluginRoot) {
  return normalizeCallsConfig(readRecord(pluginRoot).calls) ?? { ...DEFAULT_CALLS_CONFIG }
}

/** 写调用记录配置。整块替换 `calls` 字段，其余字段原样保留。 */
export function writeCallsConfig(pluginRoot, next) {
  const record = readRecord(pluginRoot)
  const clean = normalizeCallsConfig(next) ?? { ...DEFAULT_CALLS_CONFIG }
  record.calls = clean
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
    enabled: toFlag(raw.enabled, true),
    override: typeof raw.override === 'string' ? clipChars(raw.override, PROMPT_MAX_CHARS).trim() : '',
    extra: typeof raw.extra === 'string' ? clipChars(raw.extra, PROMPT_MAX_CHARS).trim() : '',
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
      enabled: toFlag(patch.enabled, base.enabled),
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
