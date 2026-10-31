/**
 * 从 CLI 输出里抠出 JSON。
 *
 * 两个 CLI 都有同样的毛病：在 JSON 前面先打一行人类提示——
 *   企查查：`正在调用 company/get_company_registration_info...`
 *   北大法宝：`调用 fatiao / get_law_item_content …`
 * 直接 JSON.parse 会失败，于是被当成「没有返回内容」。所以统一在这里处理。
 */
export function extractJson(raw) {
  const t = String(raw || '').trim()
  const marks = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0)
  if (!marks.length) return t
  const start = Math.min(...marks)
  const closer = t[start] === '{' ? '}' : ']'
  const end = t.lastIndexOf(closer)
  return end > start ? t.slice(start, end + 1) : t.slice(start)
}

/** 尝试解析；失败返回 null（调用方自己决定怎么报错） */
export function tryParseJson(raw) {
  try {
    return JSON.parse(extractJson(raw))
  } catch {
    return null
  }
}
