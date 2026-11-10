/**
 * 按「字符」截断，但绝不把表情或扩展区汉字切成半个。
 *
 * 为什么要单独一个函数：JS 的 `String.length` 数的是 UTF-16 码元，
 * 一个 😀 或一个扩展 B 区汉字（如 𠮷）占两个码元。`slice(0, 200)` 正好切在
 * 前半截时，得到的是一个孤立高位代理（`\uD83D`），JSON 序列化后变成 `\ud83d`，
 * 渲染出来就是「�」。截断点是否踩到代理对取决于字数，人工测不出来，
 * 所以所有按长度截断的地方都要走这里。
 */
export function clipChars(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Number.isFinite(max) ? Math.floor(max) : 0
  // 上限不是正数时返回空串：这个函数只回答「能放下几个字符」，
  // 「不截断」是调用方的事（engine 的 clip 自己判 limit <= 0）。
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  // 切点前一个码元若高位代理，说明这一刀落在字符中间：退一格，宁可少一个字
  const before = text.charCodeAt(limit - 1)
  return text.slice(0, before >= 0xd800 && before <= 0xdbff ? limit - 1 : limit)
}
