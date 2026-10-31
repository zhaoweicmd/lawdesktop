import { readZip } from './zip.js'
import { decodeXml } from './docx.js'

function colToNum(ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** xlsx → 行数组。每行一条 unit，text 为「A=值 | B=值」形式，便于人读与定位。 */
export function readXlsx(buf) {
  const zip = readZip(buf)
  const shared = []
  const sst = zip.readText('xl/sharedStrings.xml')
  if (sst) {
    const re = /<si>([\s\S]*?)<\/si>/g
    let m
    while ((m = re.exec(sst))) {
      const texts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]))
      shared.push(texts.join(''))
    }
  }
  const sheetNames = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()
  const units = []
  let n = 0
  for (const name of sheetNames) {
    const xml = zip.readText(name) || ''
    const sheetIdx = Number(/sheet(\d+)\.xml$/.exec(name)[1])
    const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
    let r
    while ((r = rowRe.exec(xml))) {
      const rowNum = Number(r[1])
      const cells = []
      const cellRe = /<c[^>]*r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g
      let c
      while ((c = cellRe.exec(r[2]))) {
        const ref = c[1]
        const attrs = c[2] || ''
        const inner = c[3] || ''
        const isShared = /t="s"/.test(attrs)
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
        let val = ''
        if (isShared && v) val = shared[Number(v[1])] ?? ''
        else if (v) val = decodeXml(v[1])
        else {
          const inline = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner)
          if (inline) val = decodeXml(inline[1])
        }
        if (String(val).trim()) cells.push(`${colToNum(ref) && ref.replace(/\d+$/, '')}=${val}`)
      }
      if (cells.length) {
        n++
        units.push({ n, text: `[S${sheetIdx} 第${rowNum}行] ${cells.join(' | ')}`, sheet: sheetIdx, row: rowNum })
      }
    }
  }
  return units
}

// ── 单元格级读取（台账体检用）────────────────────────────────────────────
// readXlsx() 返回的是给人读的扁平文本；体检需要知道「哪一列、是不是数字、
// 有没有公式、样式是不是日期」，所以另开一个返回二维网格的入口。

/** 解析 styles.xml，得到每个 cellXf 的 numFmtId（用于判断日期格式） */
function parseCellXfs(zip) {
  const xml = zip.readText('xl/styles.xml') || ''
  const out = []
  const xfBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
  if (!xfBlock) return out
  for (const m of xfBlock[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = /numFmtId="(\d+)"/.exec(m[0])
    out.push(id ? Number(id[1]) : 0)
  }
  return out
}

const DATE_FMT_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const DATE_FMT_CUSTOM = /[ymd]/i

function isDateStyle(zip, xfIdx) {
  const xfs = parseCellXfs(zip)
  const id = xfs[xfIdx] ?? 0
  if (DATE_FMT_BUILTIN.has(id)) return true
  const xml = zip.readText('xl/styles.xml') || ''
  const custom = new RegExp(`<numFmt[^>]*numFmtId="${id}"[^>]*formatCode="([^"]*)"`).exec(xml)
  return custom ? DATE_FMT_CUSTOM.test(custom[1]) && !/[#0]/.test(custom[1].replace(/[ymdhs]/gi, '')) : false
}

/** 台账体检用的网格：{ sheets: [{ name, rows: [{ r, cells: { A: { v, kind, formula } } }] }] } */
export function readXlsxGrid(buf) {
  const zip = readZip(buf)
  const shared = []
  const sst = zip.readText('xl/sharedStrings.xml')
  if (sst) {
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]))
      shared.push(texts.join(''))
    }
  }

  const wb = zip.readText('xl/workbook.xml') || ''
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]))

  const sheetFiles = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/sheet(\d+)/.exec(a)[1]) - Number(/sheet(\d+)/.exec(b)[1]))

  const sheets = []
  sheetFiles.forEach((file, si) => {
    const xml = zip.readText(file) || ''
    const rows = []
    for (const r of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowNum = Number(r[1])
      const cells = {}
      for (const c of r[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = c[1] || ''
        const ref = /r="([A-Z]+)(\d+)"/.exec(attrs)
        if (!ref) continue
        const col = ref[1]
        const inner = c[2] || ''
        const tAttr = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || 'n'
        const sAttr = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] || 0)
        const fMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner)

        let v = ''
        let kind = 'empty'
        if (tAttr === 's' && vMatch) { v = shared[Number(vMatch[1])] ?? ''; kind = 'text' }
        else if (tAttr === 'inlineStr') {
          const inline = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner)
          v = inline ? decodeXml(inline[1]) : ''
          kind = 'text'
        } else if (tAttr === 'b' && vMatch) { v = vMatch[1]; kind = 'bool' }
        else if (vMatch) {
          v = decodeXml(vMatch[1])
          if (isDateStyle(zip, sAttr)) kind = 'date'
          else kind = 'number'
        }
        if (fMatch) kind = 'formula'
        if (String(v).trim() === '' && !fMatch) continue
        cells[col] = { v, kind, ...(fMatch ? { formula: decodeXml(fMatch[1]) } : {}) }
      }
      if (Object.keys(cells).length) rows.push({ r: rowNum, cells })
    }
    sheets.push({ name: names[si] || `Sheet${si + 1}`, rows })
  })
  return { sheets }
}
