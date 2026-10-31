import { readZip } from './zip.js'

const ENT = { '&amp;': '&', '&lt:': '<', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' }
export function decodeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (m, k) => {
    if (k[0] === '#') {
      const code = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENT[`&${k};`] ?? m
  })
}

/**
 * 读 numbering.xml，把「自动编号」还原成能看见的序号。
 *
 * 为什么必须有这一步：Word 里的条款编号（一、二、三 / 1. 2. 3.）**不存在于正文文字里**，
 * 只有 numId+ilvl，序号是 Word 渲染时补的。不还原的话，一份用自动编号的真实合同
 * 在 document.xml 里就是「居间服务项目」「合作期限」「服务费用」一串裸标题，
 * 按「第X条」切条款会得到 0 条——功能看着有，实际对绝大多数合同失效。
 *
 * 返回 Map<'numId:ilvl', {fmt, text}>，以及一个按 numId 计数的状态容器。
 */
export function readNumbering(zip) {
  const defs = new Map()
  let xml = ''
  try {
    xml = zip.readText('word/numbering.xml') || ''
  } catch (e) {
    return defs
  }
  if (!xml) return defs

  // numId -> abstractNumId
  const numMap = new Map()
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = m[2].match(/<w:abstractNumId w:val="(\d+)"/)
    if (abs) numMap.set(m[1], abs[1])
  }

  // abstractNumId -> 各级 lvl 定义
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const absId = m[1]
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const ilvl = l[1]
      const fmt = (l[2].match(/<w:numFmt w:val="([^"]*)"/) || [])[1] || 'decimal'
      const text = (l[2].match(/<w:lvlText w:val="([^"]*)"/) || [])[1] || ''
      const start = Number((l[2].match(/<w:start w:val="(\d+)"/) || [])[1] || 1)
      for (const [numId, a] of numMap) {
        if (a === absId) defs.set(numId + ':' + ilvl, { fmt, text, start })
      }
    }
  }
  return defs
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_UNITS = ['', '十', '百', '千']

/** 1 → 一、11 → 十一、20 → 二十、105 → 一百零五（合同条号够用，不超过 9999） */
export function toChineseNumber(n) {
  const num = Math.floor(Number(n) || 0)
  if (num <= 0) return CN_DIGITS[0]
  if (num < 10) return CN_DIGITS[num]
  if (num < 20) return '十' + (num % 10 ? CN_DIGITS[num % 10] : '')
  const s = String(num)
  if (s.length > 4) return s
  let out = ''
  let zero = false
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i])
    const unit = CN_UNITS[s.length - 1 - i]
    if (d === 0) {
      zero = true
      continue
    }
    if (zero && out) out += CN_DIGITS[0]
    zero = false
    out += CN_DIGITS[d] + unit
  }
  return out
}

/** 按 numFmt + lvlText 把计数器渲染成序号文字（如 %1. → "1." ；%1、→ "一、"） */
function renderNumber(def, counters, ilvl) {
  const fmt = def.fmt
  if (fmt === 'bullet' || fmt === 'none') return ''
  let tpl = def.text
  if (!tpl) return ''
  return tpl.replace(/%(\d)/g, (_all, d) => {
    const lv = Number(d) - 1
    const v = counters[Number.isFinite(lv) ? lv : ilvl] || 1
    if (fmt === 'chineseCounting' || fmt === 'chineseCountingThousand' || fmt === 'ideographTraditional') {
      return toChineseNumber(v)
    }
    if (fmt === 'lowerLetter') return String.fromCharCode(96 + ((v - 1) % 26) + 1)
    if (fmt === 'upperLetter') return String.fromCharCode(64 + ((v - 1) % 26) + 1)
    if (fmt === 'lowerRoman') return toRoman(v).toLowerCase()
    if (fmt === 'upperRoman') return toRoman(v)
    return String(v)
  })
}

function toRoman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let out = ''
  let v = Math.floor(Number(n) || 0)
  for (const [k, s] of map) {
    while (v >= k) {
      out += s
      v -= k
    }
  }
  return out
}

/** docx → 段落数组。每段保留原始序号，段落号 = 在文档里的出现次序（1 起）。
 *  text 是**还原自动编号之后**的可见文字，所以下游按「第X条 / X. / 一、」都能切。 */
export function readDocx(buf) {
  const zip = readZip(buf)
  const xml = zip.readText('word/document.xml')
  if (!xml) throw new Error('docx 缺少 word/document.xml')
  const numbering = readNumbering(zip)
  // 每一级编号各自的计数器：进入更深层级时把更深层的计数清零（Word 的行为）
  const counters = []
  // 表格外与表格内都按出现顺序取 <w:p>
  const paras = []
  const re = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
  let m
  let idx = 0
  while ((m = re.exec(xml))) {
    idx++
    const body = m[1]
    let text = ''
    const tr = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g
    let t
    while ((t = tr.exec(body))) {
      if (t[1] !== undefined) text += decodeXml(t[1])
      else if (/tab/.test(t[0])) text += '\t'
      else text += '\n'
    }

    // 自动编号：还原成可见序号，拼在正文前面
    let label = ''
    let numLevel = null
    let numListId = null
    const numPr = body.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/)
    if (numPr) {
      const ilvl = Number((numPr[1].match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0)
      const numId = (numPr[1].match(/<w:numId w:val="(\d+)"/) || [])[1]
      if (numId) {
        const def = numbering.get(numId + ':' + ilvl)
        if (def) {
          // **每个 numId 各自一套计数器**：同一份合同里正文条款是一组编号，
          // 附件里的列表是另一组（也从 1 开始）。共用计数器会让附件列表接在正文后面，
          // 看起来像「第14条、第15条」，其实是附件清单。
          const c = counters[numId] || (counters[numId] = [])
          c[ilvl] = (c[ilvl] || 0) + 1
          // 进入第 ilvl 级：更深层级重新计数
          for (let deeper = ilvl + 1; deeper < c.length; deeper++) c[deeper] = 0
          label = renderNumber(def, c, ilvl)
          numLevel = ilvl
          numListId = numId
        }
      }
    }

    const joined = (label ? label + ' ' : '') + text.replace(/\s+$/g, '')
    if (!joined.trim()) {
      paras.push({ n: idx, text: '' })
      continue
    }
    // numListId 让下游能区分「正文条款那组编号」和「附件列表那组编号」
    paras.push({ n: idx, text: joined, label, ilvl: numLevel, numListId })
  }
  return paras
}
