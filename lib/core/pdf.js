import { execFileSync } from 'node:child_process'
import { which } from './bins.js'

/** 找 pdftotext：环境变量 LAWCASE_PDFTOTEXT 优先，其次 PATH 与常见目录 */
export function findPdftotext() {
  return which('pdftotext', { envName: 'LAWCASE_PDFTOTEXT' })
}

/**
 * 抽 PDF 文本。返回 { units:[{n,page,text}], pages, engine }。
 * 行级切分：一段一行，页码保留在 unit 上——事实出处要能指回「第 12 页第 3 行」。
 * 给 from/to 就只抽这一段（1-based、含两端），页码仍按源 PDF 的绝对页号。
 */
export function readPdf(absPath, { from, to } = {}) {
  const bin = findPdftotext()
  if (!bin) {
    throw new Error(
      '这台机器上找不到 pdftotext。装一个（brew install poppler），或用 LAWCASE_PDFTOTEXT 指到它的绝对路径。' +
        '扫描件（图片型 PDF）即使有 pdftotext 也抽不出字，需要先 OCR。',
    )
  }
  const startPage = Math.max(1, Number(from) || 1)
  const endPage = Math.max(startPage, Number(to) || startPage)
  const rangeArgs = from || to ? ['-f', String(startPage), '-l', String(endPage)] : []
  let raw
  try {
    // stderr 丢掉：poppler 对缺字体的 PDF 会喷几百行 Syntax Error，
    // 这些对结果毫无影响，混进输出会把真正要看的信息淹掉
    raw = execFileSync(bin, ['-layout', '-enc', 'UTF-8', ...rangeArgs, String(absPath), '-'], {
      maxBuffer: 128 * 1024 * 1024,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (/timed out|ETIMEDOUT/i.test(msg)) throw new Error(`PDF 抽取超时（120 秒）：${absPath}`)
    throw new Error(`PDF 抽取失败：${msg}`)
  }
  // pdftotext 每页后写一个 \f（最后一页也有），split 会多出尾部空串。
  // 不 pop 掉它，页数就会比真实页数多 1——coverage 会凭空报缺页。
  const parts = raw.split('\f')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  const units = []
  let n = 0
  for (let pi = 0; pi < parts.length; pi++) {
    for (const line of parts[pi].split(/\r?\n/)) {
      const t = line.replace(/\s+$/, '').trim()
      if (!t) continue
      n += 1
      units.push({ n, page: startPage + pi, text: t })
    }
  }
  const nonEmpty = units.length
  return { units, pages: parts.length, engine: 'pdftotext', nonEmpty, from: startPage, to: startPage + parts.length - 1 }
}

/** 每页字符数：用来判断「这一页有文本层」还是「这一页是扫描的」 */
export function pageCharCounts(result) {
  const out = new Map()
  for (const u of result.units || []) {
    out.set(u.page, (out.get(u.page) || 0) + String(u.text || '').length)
  }
  return out
}

/** 判断抽出来的是不是「查得到字」——全是空白或只有几个字符，多半是扫描件 */
export function looksScanned(result) {
  const chars = result.units.reduce((s, u) => s + u.text.length, 0)
  return chars < 20
}
