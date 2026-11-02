import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { analyzeSheet, renderLedgerReport } from '../lib/core/ledger.js'
import { readXlsxGrid } from '../lib/core/xlsx.js'

const REAL = process.env.LAWCASE_SAMPLE_XLSX || ''

function sheet(rows) {
  return {
    name: 'Sheet1',
    rows: rows.map((cells, i) => ({
      r: i + 1,
      cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, typeof v === 'string' ? { v, kind: 'text' } : v])),
    })),
  }
}
const num = (v) => ({ v: String(v), kind: 'number' })

test('日期列的序列号未格式化 → 报出来', () => {
  const r = analyzeSheet(sheet([
    { A: { v: '完成截止时间', kind: 'text' } },
    { A: num(44089) },
    { A: num(44090) },
    { A: num(44091) },
  ]))
  const hit = r.issues.find((i) => /日期|序列号|人读不出/.test(i.msg))
  assert.ok(hit, '应报日期序列号问题')
  assert.equal(hit.level, 'warn')
})

test('文字算式当数值 → 报出来（能看不能用）', () => {
  const r = analyzeSheet(sheet([
    { A: { v: '服务费', kind: 'text' } },
    { A: { v: '(189,464,959 - 174,515,814) × 20% = 14,949,829', kind: 'text' } },
  ]))
  assert.ok(r.issues.some((i) => /文字算式/.test(i.msg)))
})

test('浮点尾巴 → 报出来', () => {
  const r = analyzeSheet(sheet([
    { A: { v: '比例', kind: 'text' } },
    { A: { v: '5.0000000000000001E-4', kind: 'text' } },
  ]))
  assert.ok(r.issues.some((i) => /浮点尾巴/.test(i.msg)))
})

test('整表多列无表头 → 报一次（不是逐列刷屏）', () => {
  const r = analyzeSheet(sheet([
    { A: num(1), B: num(2), C: num(3), D: num(4) },
    { A: num(5), B: num(6), C: num(7), D: num(8) },
  ]))
  const noHead = r.issues.filter((i) => /没有表头/.test(i.msg))
  assert.equal(noHead.length, 1, '同一张表只报一条整表无表头')
})

test('正常表不误报（有表头、数值干净）', () => {
  const r = analyzeSheet(sheet([
    { A: { v: '序号', kind: 'text' }, B: { v: '金额（元）', kind: 'text' } },
    { A: num(1), B: num(100) },
    { A: num(2), B: num(200) },
  ]))
  assert.equal(r.issues.filter((i) => i.level === 'warn').length, 0, `不该有 warn：${JSON.stringify(r.issues)}`)
})

test('空表不崩', () => {
  const r = analyzeSheet({ name: '空', rows: [] })
  assert.equal(r.empty, true)
})

test('真实 xlsx：能读网格并分 sheet', () => {
  if (!fs.existsSync(REAL)) return
  const g = readXlsxGrid(fs.readFileSync(REAL))
  assert.ok(g.sheets.length >= 1)
  const first = g.sheets[0]
  assert.ok(first.rows.length > 3)
  const cells = first.rows[1].cells
  assert.ok(Object.keys(cells).length > 3, '第 2 行应有多个单元格')
})

test('报告渲染含表头清单，且明确「未修改」', () => {
  const md = renderLedgerReport({
    files: [{ mid: 'M1', file: 'a.xlsx', sheets: [analyzeSheet(sheet([{ A: { v: '金额', kind: 'text' } }, { A: num(1) }]))], issues: [] }],
    totalIssues: 0,
  })
  assert.match(md, /未修改任何文件/)
  assert.match(md, /金额/)
})
