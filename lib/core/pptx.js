import { readZip } from './zip.js'
import { decodeXml } from './docx.js'

/**
 * pptx → 文本单元。一页幻灯片拆成若干单元（按文本框的行切）。
 * 单位带 page（第几页幻灯片），因为引用 PPT 内容时「第几页」才有意义。
 */
export function readPptx(buf) {
  const zip = readZip(buf)
  // ppt/slides/slide1.xml, slide2.xml ... 按数字排序（否则 slide10 会排在 slide2 前面）
  const names = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)\.xml$/) || [])[1] || 0)
      const nb = Number((b.match(/slide(\d+)\.xml$/) || [])[1] || 0)
      return na - nb
    })
  if (!names.length) throw new Error('pptx 里没有找到幻灯片（ppt/slides/slideN.xml）')

  const units = []
  let n = 0
  for (let i = 0; i < names.length; i++) {
    const xml = zip.readText(names[i]) || ''
    // 一个 <a:p> 是一个段落；段落里可能有多个 <a:t> 片段（被拆开的 run）
    const paras = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || []
    for (const p of paras) {
      const text = (p.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g) || [])
        .map((m) => decodeXml(m.replace(/<a:t\b[^>]*>|<\/a:t>/g, '')))
        .join('')
        .replace(/\s+$/, '')
        .trim()
      if (!text) continue
      n += 1
      units.push({ n, page: i + 1, text })
    }
  }
  return { units, slides: names.length, nonEmpty: units.length }
}
