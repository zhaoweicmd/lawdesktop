/**
 * 台账体检（只读）
 *
 * 案卷里的计算表、试算表、证据整理表是人手维护的，最常出的问题不是算错，
 * 而是「口径不统一」：同一列有的是日期序列号、有的是日期格式；有的列写的是
 * 数字、有的是「(189,464,959 - 174,515,814) × 20%」这样的文字描述；浮点数
 * 带着 1.0000000000000002E-15 的尾巴。
 *
 * 这些错算不出来的东西，只能靠看。所以这个模块不修改任何文件，只报出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readXlsxGrid } from './xlsx.js'
import { readJson, casePaths } from './store.js'

const DATE_SERIAL = /^(?:[1-9]\d{3}|[1-9]\d{4})(?:\.\d+)?$/  // 1000–99999，Excel 日期序列号区间
const FLOAT_TAIL = /(?:000000000\d|999999999\d|E-?\d+)$/
const FORMULA_TEXT = /[（(][^）)]*\d[^）)]*[）)]\s*[×x*÷/+-]\s*\d|×\s*\d+%|[×x*]\s*\d/
const HEADER_HINT = /(日期|时间|日\b|date|time)/i

/** 分析一张表：列画像 + 问题 */
export function analyzeSheet(sheet) {
  const rows = sheet.rows
  if (!rows.length) return { name: sheet.name, empty: true, columns: [], issues: [] }

  // 表头：前 3 行里单元格最多的一行
  const headIdx = rows.slice(0, 3).reduce((best, r, i, arr) =>
    Object.keys(r.cells).length > Object.keys(arr[best]?.cells ?? {}).length ? i : best, 0)
  const head = rows[headIdx] || { cells: {} }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r.cells)))].sort()

  const columns = cols.map((c) => {
    const vals = rows.slice(headIdx + 1).map((r) => r.cells[c]).filter(Boolean)
    const kinds = {}
    for (const v of vals) kinds[v.kind] = (kinds[v.kind] || 0) + 1
    const nums = vals.filter((v) => v.kind === 'number' || v.kind === 'formula').length
    const rawHead = String(head.cells[c]?.v ?? '').trim()
    // 「表头」位上是纯数字，说明这行不是表头行（是无表头的表），不能拿 123 当列名
    const isNumHead = /^-?\d+(?:\.\d+)?$/.test(rawHead)
    return {
      col: c,
      header: isNumHead ? '' : rawHead,
      count: vals.length,
      kinds,
      numeric: nums,
      first: String(vals[0]?.v ?? ''),
      sample: String(vals[0]?.v ?? '').slice(0, 32),
    }
  })

  const issues = []
  const counts = columns.map((c) => c.count).filter((n) => n > 0)
  const maxCount = counts.length ? Math.max(...counts) : 0
  const medianCount = counts.length ? counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] : 0
  const noHeader = columns.filter((c) => !c.header && c.count > 0)

  // 整表无表头才算问题。单列没表头多半是「一张 sheet 里叠了几块小表」，那是表格的
  // 正常用法，逐列报会把 100 多条噪音堆在真问题前面。
  if (noHeader.length && maxCount > 0 && noHeader.length >= Math.max(3, columns.length * 0.5)) {
    issues.push({
      col: '*',
      level: 'warn',
      msg: `整表 ${noHeader.length}/${columns.length} 列没有表头（首行不是表头行？）——别人接手时不知道每列算什么`,
    })
  }

  for (const col of columns) {
    if (!col.count) continue
    const numericOnly = col.kinds.number === col.count
    const dateish = HEADER_HINT.test(col.header) && col.kinds.number
    const wholeSerial = numericOnly && col.count >= 3 && DATE_SERIAL.test(String(col.sample))

    // 日期序列号：表头明说是日期，或整列都是序列号区间内的整数
    if (dateish || wholeSerial) {
      issues.push({
        col: col.col,
        level: 'warn',
        msg: `「${col.col}${col.header ? ' ' + col.header : ''}」有 ${col.kinds.number} 个数字（如 ${col.sample}），看着是日期但没设日期格式——人读不出是哪天`,
      })
    }

    // 文字算式：能看不能用
    if (col.kinds.text && col.first && FORMULA_TEXT.test(col.first)) {
      issues.push({
        col: col.col,
        level: 'warn',
        msg: `「${col.col}」存的是文字算式（${String(col.first).slice(0, 40)}…）不是数值——底数一变就得手算`,
      })
    }

    // 浮点尾巴
    if (col.first && FLOAT_TAIL.test(col.first)) {
      issues.push({
        col: col.col,
        level: 'warn',
        msg: `「${col.col}」有浮点尾巴（${col.sample}）——除法/百分比累计误差，对外提交前要四舍五入到分`,
      })
    }

    // 局部列（只覆盖表格一小段）——多块小表的正常现象，不报
    void medianCount
  }

  // 同一行里同名列？Excel 不允许，跳过
  // 空行密度
  const dataRows = rows.length - headIdx - 1
  const sparse = rows.slice(headIdx + 1).filter((r) => Object.keys(r.cells).length <= 1).length
  if (dataRows > 3 && sparse > dataRows * 0.3) {
    issues.push({ col: '-', level: 'warn', msg: `${sparse}/${dataRows} 行只有 1 个单元格，可能有大量空行或列错位` })
  }

  return { name: sheet.name, rows: rows.length, headerRow: rows[headIdx]?.r ?? 1, columns, issues }
}

/** 案件里所有 xlsx 的体检结果 */
export function scanLedgers({ case: caseDir, mid }) {
  const cp = casePaths(caseDir)
  const mats = readJson(cp.materials, null)
  if (!mats) throw new Error(`不是 LawCase 案件或材料未登记：${caseDir}`)
  const source = mats.source || caseDir
  let files = (mats.files || []).filter((f) => /\.xlsx?$/i.test(f.rel || f.name || ''))
  if (mid) files = files.filter((f) => f.mid === mid)
  if (!files.length) {
    return { ok: true, files: [], summary: '案件里没有 xlsx 台账（先用 lc_material_scan 登记材料）', totalIssues: 0 }
  }

  const reports = []
  for (const f of files) {
    const abs = f.abs || path.join(source, f.rel)
    if (!fs.existsSync(abs)) {
      reports.push({ mid: f.mid, file: f.rel, error: '源文件不存在（材料清单与磁盘不一致）' })
      continue
    }
    try {
      const grid = readXlsxGrid(fs.readFileSync(abs))
      const sheets = grid.sheets.map(analyzeSheet)
      reports.push({
        mid: f.mid,
        file: f.rel,
        sheets,
        issues: sheets.flatMap((s) => s.issues.map((i) => ({ ...i, sheet: s.name }))),
      })
    } catch (e) {
      reports.push({ mid: f.mid, file: f.rel, error: e.message })
    }
  }

  const totalIssues = reports.reduce((n, r) => n + (r.issues || []).filter((i) => i.level !== 'info').length, 0)
  return { ok: true, files: reports, totalIssues, summary: `体检 ${reports.length} 张表，发现 ${totalIssues} 处口径问题` }
}

/** 渲染成人看的 markdown */
export function renderLedgerReport(result) {
  const L = []
  L.push('# 台账体检报告', '')
  L.push(`> 只读检查，未修改任何文件。`)
  L.push('')
  if (!result.files.length) {
    L.push(result.summary)
    return L.join('\n')
  }
  for (const f of result.files) {
    L.push(`## ${f.mid} ${f.file}`, '')
    if (f.error) { L.push(`⚠ ${f.error}`, ''); continue }
    for (const s of f.sheets) {
      if (s.empty) { L.push(`- 「${s.name}」空表`); continue }
      L.push(`### ${s.name}（${s.rows} 行）`, '')
      const head = s.columns.filter((c) => c.count > 0)
      L.push('| 列 | 表头 | 非空 | 类型 | 样例 |', '|---|---|---|---|---|')
      for (const c of head) {
        const kinds = Object.entries(c.kinds).map(([k, n]) => `${k}×${n}`).join(' ')
        L.push(`| ${c.col} | ${c.header || '（空）'} | ${c.count} | ${kinds || '—'} | ${c.sample || '—'} |`)
      }
      L.push('')
      if (s.issues.length) {
        for (const i of s.issues) L.push(`- ⚠ ${i.msg}`)
        L.push('')
      }
    }
  }
  L.push('## 说明', '')
  L.push('体检只发现「口径不统一」，不改表格。日期序列号、文字算式这类问题，改法由人来定——')
  L.push('比如把 46085 改成日期格式，同一天在不同列可能又变成 46085，需要统一口径再改。')
  return L.join('\n')
}
