// MinerU 4.x middle_json（协议 docvortex.middle 2.0）→ LawCase 的 units
//
// 为什么不再从 markdown 反推页码：4.x 的 middle_json 已经给出「每页 + 该页的块」，
// 页号是源 PDF 的原始页序（实测 --pages 4-6 → page_idx 3/4/5），
// 于是「页码全局化」从一道算术题变成了一条断言——这正是分片方案能简化掉一整层的原因。
//
// 三条从真机实测里长出来的规则（见 docs/设计方案_大PDF分片并行解析_v3.md §1）：
//   1. 没有 blocks 键的页是空白页，要保留页号占位，不能算作「缺页」；
//   2. standard 档会在空白页/图片页插入英文叙述（"The image provided is a QR code…"），整块丢弃；
//   3. 表格是 <table> HTML，按 <tr> 转成 "A | B | C" 一行，否则单元格里的金额引文核对不到。

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/

/** VLM 对图片的英文描述，不是文档正文。法律文本里凭空多出来的英文句子是污染。 */
const NARRATION = [
  /^the image\b/i,
  /^the provided image\b/i,
  /^this (image|picture|photo|figure)\b/i,
  /^i (cannot|can't|can not|am unable|don't|do not)\b/i,
  /^as an ai\b/i,
]

export function looksLikeNarration(text) {
  const t = String(text || '').trim()
  if (!t) return false
  // 只在「没有中文」时判定：正文里出现英文引用是正常现象，不能误杀
  if (CJK.test(t)) return false
  return NARRATION.some((re) => re.test(t))
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** <table> → 每行一个字符串；单元格用 " | " 连接 */
export function tableToRows(html) {
  const out = []
  for (const tr of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
    const row = cells.filter((c) => c && c !== '-').join(' | ')
    if (row) out.push(row)
  }
  // 没有 <tr> 的退化情况（有些表格只给纯文本），整段当一行
  if (!out.length) {
    const flat = stripTags(html)
    if (flat) out.push(flat)
  }
  return out
}

/**
 * middle_json → { units, blankPages, droppedNarration, pages, fullDocument, schema }
 * units: { n, page, text, blockType }  page = page_idx + 1（源 PDF 页序，1-based）
 */
export function middleToUnits(middle) {
  if (!middle || typeof middle !== 'object') throw new Error('middle_json 是空的，无法转成单元')
  const schema = String(middle.schema || '')
  if (!schema.startsWith('docvortex.middle')) {
    throw new Error(`不认识的输出协议「${schema || '(缺 schema)'}」：MinerU 4.x 应为 docvortex.middle。入口或版本不对`)
  }
  const pages = Array.isArray(middle.pages) ? middle.pages : []
  if (!pages.length) throw new Error('middle_json 里没有任何页')

  const units = []
  const blankPages = []
  let droppedNarration = 0
  let n = 0

  for (const page of pages) {
    const pageNo = Number.isInteger(page.page_idx) ? page.page_idx + 1 : blankPages.length + units.length + 1
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    if (!blocks.length) {
      blankPages.push(pageNo)
      continue
    }
    let got = 0
    for (const block of blocks) {
      const blockType = String(block.type || '')
      for (const item of block.content || []) {
        const type = String(item.type || '')
        const raw = item.content
        if (typeof raw !== 'string' || !raw.trim()) continue
        const lines = type === 'table_body' ? tableToRows(raw) : raw.split(/\r?\n/)
        for (const line of lines) {
          const text = String(line).trim()
          if (!text) continue
          if (looksLikeNarration(text)) {
            droppedNarration += 1
            continue
          }
          n += 1
          got += 1
          units.push({ n, page: pageNo, text, blockType })
        }
      }
    }
    // 有块但一个字都没抽出来（纯图片页），同样按空白页处理
    if (!got) blankPages.push(pageNo)
  }

  return {
    units,
    blankPages,
    droppedNarration,
    pages: pages.length,
    fullDocument: middle.is_full_document === true,
    schema,
  }
}

/** 页区间压缩： [1,2,3,7,8] → "1-3,7-8"（给人看的 coverage 用） */
export function compactRanges(pages) {
  const list = [...new Set(pages)].filter((p) => Number.isInteger(p)).sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < list.length; i++) {
    const start = list[i]
    let end = start
    while (i + 1 < list.length && list[i + 1] === end + 1) {
      end = list[i + 1]
      i += 1
    }
    out.push(start === end ? String(start) : `${start}-${end}`)
  }
  return out.join(',')
}

/** 连续页 → [[a,b], …] */
export function contiguousRanges(pages) {
  const list = [...new Set(pages)].sort((a, b) => a - b)
  const out = []
  for (const p of list) {
    const last = out[out.length - 1]
    if (last && p === last[1] + 1) last[1] = p
    else out.push([p, p])
  }
  return out
}
