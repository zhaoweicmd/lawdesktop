import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normBase } from '../lib/core/material.js'
import { newCase } from '../lib/core/case.js'
import { addFact, listFacts, draftFacts } from '../lib/core/fact.js'
import { checkItem } from '../lib/core/checkoff.js'

test('版本后缀能归一：更新/终稿/(1)/副本 都归到同一 base', () => {
  const cases = [
    ['时间线.xlsx', '时间线更新.xlsx', '时间线'],
    ['庭前准备.docx', '庭前准备-更新.docx', '庭前准备'],
    ['情况简介.docx', '情况简介更新.docx', '情况简介'],
    ['计算表.xlsx', '计算表更新.xlsx', '计算表'],
    ['起诉状.docx', '起诉状(1).docx', '起诉状'],
    ['合同.pdf', '合同副本.pdf', '合同'],
    ['方案.docx', '方案终稿.docx', '方案'],
  ]
  for (const [a, b, want] of cases) {
    assert.equal(normBase(a), want, `${a} base`)
    assert.equal(normBase(b), want, `${b} base`)
  }
})

test('不相干的文件名不能被归一', () => {
  assert.notEqual(normBase('时间线.xlsx'), normBase('证据清单.xlsx'))
  assert.notEqual(normBase('情况简介.docx'), normBase('情况说明.docx'))
})

function tmpCase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mf-'))
  const dir = path.join(base, 'case')
  newCase({ dir, title: '测试案件' })
  return dir
}

test('事实：出处文件不存在必须拒收', () => {
  const dir = tmpCase()
  assert.throws(() => addFact({ case: dir, text: '被告于 2025 年 3 月未付款', source: '不存在.docx', locator: 'P1' }), /出处文件不存在/)
})

test('事实：定位缺失必须拒收', () => {
  const dir = tmpCase()
  const f = path.join(dir, '材料.md')
  fs.writeFileSync(f, '# x\n')
  assert.throws(() => addFact({ case: dir, text: '被告于 2025 年 3 月未付款', source: '材料.md', locator: '' }), /定位必填/)
})

test('事实：正常登记自动编号，默认待核', () => {
  const dir = tmpCase()
  fs.writeFileSync(path.join(dir, '合同.md'), '# 合同\n')
  const a = addFact({ case: dir, text: '合同约定货款于 2025 年 3 月 31 日前付清', source: '合同.md', locator: '第2条' })
  const b = addFact({ case: dir, text: '被告截至起诉日仍未付款', source: '合同.md', locator: '第3条', confirmed: true })
  assert.equal(a.fact.id, 'F1')
  assert.equal(b.fact.id, 'F2')
  assert.equal(a.fact.verified, undefined)
  assert.equal(b.fact.verified, 'ok')
  assert.equal(a.fact.source.file, '合同.md')
  assert.equal(a.fact.source.locator, '第2条')
  const l = listFacts({ case: dir })
  assert.equal(l.total, 2)
  // addFact 的 confirmed 只写历史字段 verified；「是否已核对」的统计口径
  // 统一走 checkoff（逐条核对台账），所以这里两条都算待核
  assert.equal(l.pending, 2)
  assert.equal(l.verified, 0)
  // 用核对台账记一条，统计立刻跟上
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '测试' })
  const l2 = listFacts({ case: dir })
  assert.equal(l2.verified, 1)
  assert.equal(l2.pending, 1)
})

test('事实：编号跨会话递增，不重号', () => {
  const dir = tmpCase()
  fs.writeFileSync(path.join(dir, 'a.md'), 'x')
  addFact({ case: dir, text: '第一条事实内容够长了吧', source: 'a.md', locator: 'L1' })
  addFact({ case: dir, text: '第二条事实内容够长了吧', source: 'a.md', locator: 'L2' })
  const third = addFact({ case: dir, text: '第三条事实内容够长了吧', source: 'a.md', locator: 'L3' })
  assert.equal(third.fact.id, 'F3')
})

test('事实：docx 不许抽候选，要提示先转 md', () => {
  const dir = tmpCase()
  fs.writeFileSync(path.join(dir, 'a.docx'), 'fake')
  assert.throws(() => draftFacts({ case: dir, source: 'a.docx' }), /先用解析工具/)
})

test('事实：从 md 抽候选，默认不写入', () => {
  const dir = tmpCase()
  fs.writeFileSync(
    path.join(dir, 'note.md'),
    '# 标题\n\n被告乙公司于二〇二五年三月三十一日应付货款一百二十万元，至今未付。\n\n原告多次催讨，被告以资金紧张为由拖延。\n',
  )
  const r = draftFacts({ case: dir, source: 'note.md' })
  assert.equal(r.dryRun, true)
  assert.ok(r.candidates.length >= 2)
  assert.ok(r.candidates[0].locator.startsWith('L'))
  assert.equal(listFacts({ case: dir }).total, 0, 'dryRun 不应写入')
})

test('新案件 facts.jsonl 为空时 listFacts 给明确提示', () => {
  const dir = tmpCase()
  const r = listFacts({ case: dir })
  assert.equal(r.total, 0)
  assert.match(r.summary, /事实台账为空/)
})
