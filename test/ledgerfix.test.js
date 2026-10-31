import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planFixes, excelSerialToDate, applyFixes } from '../lib/core/ledgerfix.js'
import { readXlsxGrid } from '../lib/core/xlsx.js'
import { readZip } from '../lib/core/zip.js'

const REAL = process.env.LAWCASE_SAMPLE_XLSX || ''

const num = (v) => ({ v: String(v), kind: 'number' })
const txt = (v) => ({ v: String(v), kind: 'text' })
function sheet(rows, name = 'Sheet1') {
  return { name, rows: rows.map((cells, i) => ({ r: i + 1, cells })) }
}

test('浮点尾巴：四舍五入到分，差异极小时才改', () => {
  const grid = { sheets: [sheet([
    { A: txt('金额') },
    { A: num('5117657.0999999996') },
    { A: num('133751.35999999999') },
    { A: num('7.123456') },   // 真小数，不该动
  ])] }
  const plan = planFixes(grid, { decimals: 2 })
  assert.equal(plan.length, 2, `应只改两条浮点尾巴，实际 ${JSON.stringify(plan.map((p) => p.before))}`)
  assert.ok(plan.every((p) => p.kind === 'float'))
  assert.equal(plan[0].after, '5117657.1')
})

test('日期序列号：表头写着日期时识别（只改样式，不动值）', () => {
  const grid = { sheets: [sheet([
    { A: txt('完成截止时间') },
    { A: num(44089) },
    { A: num(44090) },
  ])] }
  const plan = planFixes(grid)
  const dates = plan.filter((p) => p.kind === 'date')
  assert.equal(dates.length, 2)
  assert.equal(dates[0].before, '44089', '值不变')
  assert.match(dates[0].after, /^\d{4}-\d{2}-\d{2}$/)
})

test('表头不是日期时不把普通数字当日期', () => {
  const grid = { sheets: [sheet([
    { A: txt('金额（元）') },
    { A: num(44089) },
  ])] }
  assert.equal(planFixes(grid).filter((p) => p.kind === 'date').length, 0)
})

test('excelSerialToDate 换算正确（1899-12-30 基准）', () => {
  // 期望值用 Python 独立算过：datetime(1899,12,30)+timedelta(days=s)
  assert.equal(excelSerialToDate(44089), '2020-09-15')
  assert.equal(excelSerialToDate(46085), '2026-03-04')
  // 1900 闰日 bug 只影响 1900-01-01～1900-02-28，序列号 1 在标准换算下是 1899-12-31
  assert.equal(excelSerialToDate(1), '1899-12-31')
})

test('applyFixes 后能重新读出，且值真的变了（真文件）', () => {
  if (!fs.existsSync(REAL)) return
  const buf = fs.readFileSync(REAL)
  const plan = planFixes(readXlsxGrid(buf))
  if (!plan.length) return
  const { buf: out } = applyFixes(buf, plan)
  assert.ok(out.length > 1000)
  const back = readXlsxGrid(out)
  assert.equal(back.sheets.length, readXlsxGrid(buf).sheets.length, 'sheet 数不变')
  const p = plan[0]
  const sheet = back.sheets.find((s) => s.name === p.sheet)
  const cell = sheet.rows.find((r) => r.r === Number(/\d+$/.exec(p.ref)[0]))?.cells[/^[A-Z]+/.exec(p.ref)[0]]
  assert.equal(String(cell.v), p.after, '回读值应等于计划的新值')
})

test('applyFixes 不破坏 zip 结构（能再被 readZip 解析）', () => {
  if (!fs.existsSync(REAL)) return
  const buf = fs.readFileSync(REAL)
  const plan = planFixes(readXlsxGrid(buf))
  if (!plan.length) return
  const { buf: out } = applyFixes(buf, plan)
  const zip = readZip(out)
  assert.ok(zip.names().includes('xl/worksheets/sheet1.xml'))
  assert.ok(zip.names().includes('xl/styles.xml'))
})

test('日期样式追加时 cellXfs count 同步增加', () => {
  if (!fs.existsSync(REAL)) return
  const buf = fs.readFileSync(REAL)
  const grid = readXlsxGrid(buf)
  // 造一条日期修复，验证 styles.xml 的 count 字段
  const plan = planFixes({ sheets: [sheet([{ A: txt('日期') }, { A: num(44089) }])] })
  if (!plan.length) return
  const { buf: out } = applyFixes(buf, plan)
  const styles = readZip(out).readText('xl/styles.xml')
  const m = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(styles)
  assert.ok(m, 'styles.xml 应有 cellXfs')
  const xfCount = (m[2].match(/<xf\b/g) || []).length
  assert.equal(Number(m[1]), xfCount, 'count 字段必须与实际 xf 数一致，否则 Excel 报文件损坏')
  void grid
})
