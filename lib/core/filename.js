// 跨平台文件名安全化。
//
// 为什么需要（2026-11-01，为 Windows 交付准备）：
//   交付文件名大多来自**用户自己的合同名**——「采购合同（2026版）：修订」这种，
//   在 macOS 上合法，到了 Windows 会因为 `:` `*` `?` `"` `<` `>` `|` 而写入失败，
//   表现为「生成失败」但看不出原因。Windows 还额外禁止结尾的 `.` 和空格。
//
// 做法：只替换非法字符，不改变可读性；并强制长度上限（Windows 全路径 260）。

/** Windows 禁用字符 + 控制字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

/** Windows 保留设备名（大小写不敏感，且带扩展名也不行） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 把任意字符串变成可跨平台落盘的文件名。
 * @param {string} name 原始名（可含路径分隔符，会被去掉）
 * @param {{maxBytes?: number, fallback?: string}} [opts]
 */
export function safeFileName(name, { maxBytes = 180, fallback = 'file' } = {}) {
  let s = String(name == null ? '' : name)
  // 只取最后一段（防止传进来的是路径）
  s = s.replace(/^.*[\\/]/, '')
  s = s.replace(ILLEGAL, '_')
  // 结尾的点和空格 Windows 会静默截断，导致实际文件名与预期不符
  s = s.replace(/[. ]+$/, '')
  s = s.trim()
  if (!s) s = fallback
  if (RESERVED.test(s)) s = '_' + s

  // 按 UTF-8 字节控制长度：中文一个字 3 字节，按字符数算会超
  while (Buffer.byteLength(s, 'utf8') > maxBytes && s.length > 1) {
    // 保留扩展名
    const m = /^([\s\S]*)(\.[A-Za-z0-9]{1,8})$/.exec(s)
    if (m) {
      const keep = Math.max(1, m[1].length - 4)
      s = m[1].slice(0, keep).replace(/[. ]+$/, '') + m[2]
    } else {
      s = s.slice(0, Math.max(1, s.length - 4))
    }
  }
  return s
}

/** 把「基础名 + 扩展名」拼成安全文件名 */
export function safeJoinName(base, ext = '') {
  const e = String(ext || '').startsWith('.') || !ext ? String(ext || '') : '.' + ext
  // 基础名本身就是空/空白时直接给 fallback：
  // 不能先拼成 '.docx' 再交给 safeFileName —— 那样它非空，fallback 分支永远走不到，
  // 结果产出一个只有扩展名的隐藏文件（Windows 上还会被当成无扩展名）。
  const b = String(base || '').trim()
  if (!b) return 'file' + e
  return safeFileName(b + e, { fallback: 'file' + e })
}
