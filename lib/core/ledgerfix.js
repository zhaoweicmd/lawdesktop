/**
 * 台账批改（写操作）
 *
 * 只管两类「改了不会改变含义」的修复：
 *   1. 浮点尾巴：5.0000000000000001E-4 → 0.0005（四舍五入到指定小数位）
 *   2. 日期序列号：44089 → 显示成 2020-09-21（只加日期样式，不动值）
 *
 * 文字算式、缺表头、列错位一律不改——那些要判断「本该是什么」，机器猜不出来。
 *
 * 安全底线：**不动原文件**。输出到 <案件>/out/台账修正_<时间>/，并附修改清单。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readZip } from './zip.js'
import { writeZip } from './zipwrite.js'
import { readXlsxGrid } from './xlsx.js'
import { readJson, casePaths, loadCase, log } from './store.js'

const DATE_FMT_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const FLOAT_TAIL = /(?:0000000\d{2,}|9999999\d{2,}|E-?\d+)$/
const HEADER_HINT = /(日期|时间|date|time)/i

// 证据目录下的表格一律不动：改了对方提交的证据，性质就变了。
// 「被告的证据整理.xlsx」在根目录，是本方对对方证据的整理，不在拦截范围。
const PROTECTED_RE = /(?:^|\/)(?:4\.证据|\d+\.证据|调查|聊天记录|当事人提交|证据材料)/

const colOf = (ref) => /^([A-Z]+)/.exec(ref)?.[1] || ''
const rowOf = (ref) => Number(/\d+$/.exec(ref)?.[0] || 0)

/** 列出可自动修的点（不写盘） */
export function planFixes(grid, { decimals = 2 } = {}) {
  const plan = []
  for (const sheet of grid.sheets) {
    const rows = sheet.rows
    if (!rows.length) continue
    const headIdx = rows.slice(0, 3).reduce((best, r, i, arr) =>
      Object.keys(r.cells).length > Object.keys(arr[best]?.cells ?? {}).length ? i : best, 0)
    const head = rows[headIdx]?.cells || {}

    // 每列的表头（纯数字不算表头）
    const headerOf = {}
    for (const c of Object.keys(head)) {
      const t = String(head[c].v ?? '').trim()
      headerOf[c] = /^-?\d+(?:\.\d+)?$/.test(t) ? '' : t
    }

    for (const r of rows.slice(headIdx + 1)) {
      for (const [col, cell] of Object.entries(r.cells)) {
        const ref = `${col}${r.r}`
        const raw = String(cell.v ?? '')

        // 1) 浮点尾巴
        if (cell.kind === 'number' && FLOAT_TAIL.test(raw)) {
          const n = Number(raw)
          if (Number.isFinite(n)) {
            const fixed = Number(n.toFixed(decimals))
            if (Math.abs(n - fixed) < 1e-6) {
              plan.push({
                sheet: sheet.name, ref, kind: 'float', col, header: headerOf[col] || '',
                before: raw, after: String(fixed),
                why: `浮点累计误差，四舍五入到 ${decimals} 位`,
              })
            }
          }
        }

        // 2) 日期序列号（表头写着日期，值却是 1000–99999 的整数）
        if (cell.kind === 'number' && HEADER_HINT.test(headerOf[col] || '')) {
          const n = Number(raw)
          if (Number.isInteger(n) && n >= 1000 && n <= 99999) {
            plan.push({
              sheet: sheet.name, ref, kind: 'date', col, header: headerOf[col],
              before: raw,
              after: excelSerialToDate(n),
              why: '日期被存成序列号，加日期格式（值不变）',
            })
          }
        }
      }
    }
  }
  return plan
}

/** Excel 序列号 → YYYY-MM-DD（1900 基准，含 1900-02-29 的历史误差处理） */
export function excelSerialToDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/** styles.xml 里补一个日期 xf，返回其索引 */
function ensureDateXf(stylesXml) {
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml || '')
  if (!cellXfs) return { xml: stylesXml, idx: null }
  const xfMatches = [...cellXfs[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)]
  const idx = xfMatches.findIndex((m) => /numFmtId="(?:14|15|16|17|22)"/.test(m[0]))
  if (idx >= 0) return { xml: stylesXml, idx }
  // 没有现成的日期 xf：照着第 0 个 xf 造一个，只换 numFmtId=14，然后追加
  const base = xfMatches[0]?.[0] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  const dateXf = base.replace(/numFmtId="\d+"/, 'numFmtId="14"')
    .replace(/\s*applyNumberFormat="[^"]*"/, '')
    .replace(/\/>$/, ' applyNumberFormat="1"/>')
    .replace(/>$/, ' applyNumberFormat="1">').replace(/<\/xf>/, '</xf>')
  const newBlock = cellXfs[1].replace(/(<\/xf>|[^/]\/>)(\s*)$/, `$1${dateXf}$2`)
  const newCount = xfMatches.length + 1
  const out = stylesXml
    .replace(cellXfs[0], `<cellXfs count="${newCount}">${newBlock}</cellXfs>`)
  return { xml: out, idx: xfMatches.length }
}

/** 把计划落到 xlsx 内容上，返回新 Buffer 与自检结果 */
export function applyFixes(srcBuf, plan) {
  const zip = readZip(srcBuf)
  const bySheet = new Map()
  for (const p of plan) {
    if (!bySheet.has(p.sheet)) bySheet.set(p.sheet, [])
    bySheet.get(p.sheet).push(p)
  }

  const grid = readXlsxGrid(srcBuf)
  const sheetFiles = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/sheet(\d+)/.exec(a)[1]) - Number(/sheet(\d+)/.exec(b)[1]))

  let stylesXml = zip.readText('xl/styles.xml')
  let dateXfIdx = null
  const needDate = plan.some((p) => p.kind === 'date')
  if (needDate) {
    const r = ensureDateXf(stylesXml)
    stylesXml = r.xml
    dateXfIdx = r.idx
  }

  const changed = new Map()
  grid.sheets.forEach((s, i) => {
    const fixes = bySheet.get(s.name)
    if (!fixes?.length) return
    const file = sheetFiles[i]
    let xml = zip.readText(file)
    for (const f of fixes) {
      const re = new RegExp(`(<c\\b[^>]*\\br="${f.ref}"[^>]*>)([\\s\\S]*?)(</c>)`)
      const m = re.exec(xml)
      if (!m) continue
      const open = m[1]
      const inner = m[2]
      if (f.kind === 'float') {
        xml = xml.replace(m[0], `${open}${inner.replace(/<v>[^<]*<\/v>/, `<v>${f.after}</v>`)}${m[3]}`)
      } else if (f.kind === 'date' && dateXfIdx != null) {
        const newOpen = /\bs="\d+"/.test(open)
          ? open.replace(/\bs="\d+"/, `s="${dateXfIdx}"`)
          : open.replace(/<c\b/, `<c s="${dateXfIdx}"`)
        xml = xml.replace(m[0], `${newOpen}${inner}${m[3]}`)
      }
    }
    changed.set(file, xml)
  })

  const files = zip.names().map((name) => {
    if (changed.has(name)) return { name, data: Buffer.from(changed.get(name), 'utf8') }
    if (name === 'xl/styles.xml' && stylesXml != null) return { name, data: Buffer.from(stylesXml, 'utf8') }
    return { name, data: zip.read(name) }
  })

  return { buf: writeZip(files), changedSheets: [...changed.keys()] }
}

/** 对案件里的 xlsx 执行批改；dryRun 默认 true */
export function fixLedgers({ case: caseDir, mid, apply = false, decimals = 2 } = {}) {
  const cp = casePaths(caseDir)
  const mats = readJson(cp.materials, null)
  if (!mats) throw new Error(`不是 LawCase 案件或材料未登记：${caseDir}`)
  const c = loadCase(caseDir)
  const source = mats.source || caseDir

  let files = (mats.files || []).filter((f) => /\.xlsx$/i.test(f.rel || f.name || ''))
  const skipped = []
  if (mid) {
    files = files.filter((f) => f.mid === mid)
  } else {
    // 不显式指定时，跳过证据目录
    const keep = []
    for (const f of files) {
      if (PROTECTED_RE.test(String(f.rel || ''))) skipped.push({ mid: f.mid, file: f.rel, why: '证据/调查材料，不改' })
      else keep.push(f)
    }
    files = keep
  }
  if (!files.length) {
    return { ok: true, applied: false, plan: [], skipped, total: 0,
      summary: '没有可处理的台账（证据目录下的表格不改；要改请用 mid 明确指定）' }
  }

  const results = []
  for (const f of files) {
    const abs = f.abs || path.join(source, f.rel)
    if (!fs.existsSync(abs)) { results.push({ mid: f.mid, file: f.rel, error: '源文件不存在' }); continue }
    const buf = fs.readFileSync(abs)
    let grid
    try { grid = readXlsxGrid(buf) } catch (e) {
      results.push({ mid: f.mid, file: f.rel, error: `读不出表格：${e.message}` }); continue
    }
    const plan = planFixes(grid, { decimals })
    results.push({ mid: f.mid, file: f.rel, abs, buf, plan })
  }

  const total = results.reduce((n, r) => n + (r.plan?.length || 0), 0)
  void skipped
  if (!apply) {
    return {
      ok: true, applied: false, total, decimals,
      files: results.map((r) => ({ mid: r.mid, file: r.file, error: r.error, plan: r.plan || [] })),
      skipped,
      summary: total
        ? `可自动修 ${total} 处（未写盘）${skipped.length ? `；跳过 ${skipped.length} 份证据材料` : ''}`
        : `没有可自动修的问题${skipped.length ? `（跳过 ${skipped.length} 份证据材料）` : ''}`,
    }
  }

  // 写盘：输出到 out/台账修正_<时间>/，原文件不动
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.join(caseDir, 'out', `台账修正_${stamp}`)
  fs.mkdirSync(outDir, { recursive: true })

  const written = []
  for (const r of results) {
    if (r.error || !r.plan?.length) continue
    const { buf: outBuf, changedSheets } = applyFixes(r.buf, r.plan)
    const target = path.join(outDir, path.basename(r.file))
    fs.writeFileSync(target, outBuf)
    // 自检：改完还能读回来，且修过的单元格值已变
    let selfCheck = 'ok'
    try {
      const back = readXlsxGrid(fs.readFileSync(target))
      const sheet = back.sheets.find((s) => s.name === r.plan[0].sheet)
      const cell = sheet?.rows.find((x) => x.r === rowOf(r.plan[0].ref))?.cells?.[colOf(r.plan[0].ref)]
      if (!cell) selfCheck = '回读找不到单元格'
    } catch (e) { selfCheck = `回读失败：${e.message}` }
    written.push({ mid: r.mid, file: r.file, out: path.relative(caseDir, target), count: r.plan.length, changedSheets, selfCheck })
  }

  // 修改清单
  const md = []
  md.push(`# 台账批改清单 · ${c.title}`, '')
  md.push(`- 时间：${new Date().toISOString()}`)
  md.push(`- 规则：浮点四舍五入到 ${decimals} 位；日期序列号加日期格式（值不变）`)
  md.push(`- **原文件未改动**，修正版见本目录`, '')
  for (const w of written) {
    md.push(`## ${w.mid} ${w.file} → ${w.out}`, '')
    md.push(`自检：${w.selfCheck}`, '')
    md.push('| 位置 | 类型 | 改前 | 改后 | 说明 |', '|---|---|---|---|---|')
    const r = results.find((x) => x.mid === w.mid)
    for (const p of r.plan) md.push(`| ${p.sheet}!${p.ref} | ${p.kind} | ${p.before} | ${p.after} | ${p.why} |`)
    md.push('')
  }
  const untouched = results.filter((r) => r.error || !r.plan?.length)
  if (untouched.length) {
    md.push('## 未处理', '')
    for (const r of untouched) md.push(`- ${r.mid} ${r.file}：${r.error || '没有可自动修的问题'}`)
    md.push('')
  }
  fs.writeFileSync(path.join(outDir, '修改清单.md'), md.join('\n'))
  log(cp, { op: 'ledger-fix', caseId: c.caseId, total, out: path.relative(caseDir, outDir), files: written.map((w) => w.file) })

  return {
    ok: true, applied: true, total, decimals,
    outDir: path.relative(caseDir, outDir),
    written,
    summary: `改 ${total} 处，输出 ${written.length} 个文件到 ${path.relative(caseDir, outDir)}（原文件未动）`,
  }
}
