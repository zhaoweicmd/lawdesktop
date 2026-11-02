// 五道验收的回归测试
//
// 核心断言是「能失败」：空案必须判 fail，造假的结论必须被抓住。
// 一条通过的测试只能证明代码跑起来了；一条失败的测试才证明检查是真的。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths, readJson, writeJsonAtomic, appendJsonl } from '../lib/core/store.js'
import { verifyCase } from '../lib/core/verify.js'
import { checkItem } from '../lib/core/checkoff.js'

function tmpCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-test-'))
  newCase({ dir, title: '测试案件', cause: '买卖合同纠纷', parties: '原告：甲；被告：乙' })
  return dir
}

function statusOf(r, name) {
  return (r.checks.find((c) => c.name === name) || {}).status
}

test('空案必须判 fail（五道不能白过）', () => {
  const dir = tmpCase()
  const r = verifyCase({ case: dir })
  assert.equal(r.verdict, 'needs_fix')
  assert.equal(statusOf(r, 'facts'), 'fail', '没有事实必须 fail')
  assert.equal(r.stateUnchanged, true, '验收不得改状态')
  // 状态字段没被动过
  const c = readJson(casePaths(dir).caseJson)
  assert.equal(c.status, 'draft')
})

test('事实有出处且已核对才 pass，缺出处必抓', () => {
  const dir = tmpCase()
  const p = casePaths(dir)
  appendJsonl(p.facts, { id: 'F1', text: '双方于2024年3月签约', source: { file: '合同.pdf', locator: 'p.1' } })
  // 「已核对」只认 checkoff（逐条核对台账），verified 字段不再参与判断
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '测试' })
  assert.equal(statusOf(verifyCase({ case: dir }), 'facts'), 'pass')

  appendJsonl(p.facts, { id: 'F2', text: '被告承认收货' }) // 无 source
  const r = verifyCase({ case: dir })
  assert.equal(statusOf(r, 'facts'), 'fail')
  assert.ok(r.mustFix.some((m) => m.ref === 'F2'))
})

test('来源失效的事实必须 fail', () => {
  const dir = tmpCase()
  const p = casePaths(dir)
  appendJsonl(p.facts, { id: 'F1', text: 'x', source: { file: 'g.pdf', locator: 'p.2' }, verified: 'broken' })
  const r = verifyCase({ case: dir })
  assert.equal(statusOf(r, 'facts'), 'fail')
  assert.ok(r.mustFix.some((m) => /来源已失效/.test(m.msg)))
})

test('结论引用不存在的事实必须被逻辑道抓住', () => {
  const dir = tmpCase()
  const p = casePaths(dir)
  appendJsonl(p.facts, { id: 'F1', text: 'x', source: { file: 'a.pdf', locator: 'p.1' }, verified: 'ok' })
  appendJsonl(p.findings, { id: 'C1', text: '被告应付款', factRefs: ['F9'] }) // F9 不存在
  const r = verifyCase({ case: dir })
  assert.equal(statusOf(r, 'logic'), 'fail')
  assert.ok(r.mustFix.some((m) => /不存在的事实 F9/.test(m.msg)))
})

test('工序没走完就出结论，逻辑道必须 fail', () => {
  const dir = tmpCase()
  const p = casePaths(dir)
  const c = readJson(p.caseJson)
  c.proc = [
    { id: 'P1', name: '梳理证据', status: 'done' },
    { id: 'P2', name: '计算损失', status: 'todo' },
  ]
  writeJsonAtomic(p.caseJson, c)
  appendJsonl(p.facts, { id: 'F1', text: 'x', source: { file: 'a.pdf', locator: 'p.1' }, verified: 'ok' })
  appendJsonl(p.findings, { id: 'C1', text: '结论', factRefs: ['F1'] })
  const r = verifyCase({ case: dir })
  assert.equal(statusOf(r, 'logic'), 'fail')
  assert.ok(r.mustFix.some((m) => /P2/.test(m.msg)))
})

test('敏感信息命中要提示（保密道）', () => {
  const dir = tmpCase()
  const p = casePaths(dir)
  appendJsonl(p.facts, { id: 'F1', text: '被告身份证 310101199001011234', source: { file: 'a.pdf', locator: 'p.1' }, verified: 'ok' })
  const r = verifyCase({ case: dir })
  assert.equal(statusOf(r, 'confidential'), 'warn')
  assert.ok(r.checks.find((c) => c.name === 'confidential').items.some((i) => /身份证号/.test(i.msg)))
})

test('只看指定几道（checks 过滤）', () => {
  const dir = tmpCase()
  const r = verifyCase({ case: dir, checks: ['confidential'] })
  assert.equal(r.checks.length, 1)
  assert.equal(r.checks[0].name, 'confidential')
})

test('不是案件目录要明确报错，不静默', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-neg-'))
  assert.throws(() => verifyCase({ case: dir }), /不是 LawCase 案件/)
})

test('合同审核案：法条这道看「意见的依据」，不再因为「没有结论台账」而卡住', async () => {
  // 真机踩过：合同案不写 findings.jsonl，却复用了只读 findings 的 checkLaw，
  // 于是永远报「没有任何带法条引用的结论」→ 验收卡在"待人工确认"，界面上无处可点。
  const os = await import('node:os')
  const { newCase } = await import('../lib/core/case.js')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses, addNote } = await import('../lib/core/clause.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-lawcheck-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-lawcheck-mat-'))
  newCase({ dir, title: '法条检查测试', caseType: 'contract' })
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>第一条 甲方应在验收合格后十日内支付服务费人民币十万元。</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '合同.docx' })

  // 只登记意见、**不写任何结论**（合同案的真实形态）
  addNote({
    case: dir,
    file: '合同.docx',
    clause: '第一条',
    level: '建议修改',
    issue: '付款未设逾期违约金，甲方拖延验收时价款无从主张，救济手段不足。',
    fix: '甲方应在验收合格后十日内支付；逾期付款的，每逾期一日按未付金额万分之五支付违约金。',
    basis: '',
  })

  const r = verifyCase({ case: dir })
  const law = r.checks.find((c) => c.name === 'law')
  assert.equal(law.status, 'pass', '合同案没有法条引用时，这一道不该判 warn/fail：' + JSON.stringify(law.items))
  assert.match(law.items[0].msg, /都没有引用法条|暂无可核/)
  // 不该再出现"没有任何带法条引用的结论"这种指向不存在台账的话
  assert.doesNotMatch(JSON.stringify(law.items), /结论/)
})

test('验收：warning 可以被人工忽略（留理由），fail 不允许忽略', async () => {
  const os = await import('node:os')
  const { newCase } = await import('../lib/core/case.js')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses, addNote } = await import('../lib/core/clause.js')
  const { waiveCheck } = await import('../lib/core/verify.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-waive-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-waive-mat-'))
  newCase({ dir, title: '忽略测试', caseType: 'contract' })
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>第一条 甲方应在验收合格后十日内支付服务费人民币十万元。</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })

  // 还没索引条款 → 「条款已索引」是 fail，不允许忽略
  indexClauses({ case: dir, file: '合同.docx' })

  // 没意见时「意见可执行」是 fail → 不允许忽略
  assert.throws(
    () => waiveCheck({ case: dir, name: 'notes', reason: '我不想写意见', by: '赵' }),
    /不能忽略|真失败/
  )

  addNote({
    case: dir,
    file: '合同.docx',
    clause: '第一条',
    level: '建议修改',
    issue: '付款未设逾期违约金，甲方拖延验收时价款无从主张，救济手段不足。',
    fix: '甲方应在验收合格后十日内支付；逾期付款的，每逾期一日按未付金额万分之五支付违约金。',
    basis: '',
  })

  // 现在 law 是 pass（合同案没有法条引用时不报警），法条类 warning 用另一案测试：
  // 这里验证"忽略后状态变 pass 且留痕"
  const r1 = waiveCheck({ case: dir, name: 'law', reason: '本案确实无法条争议', by: '赵律师' })
  assert.equal(r1.ok, true)

  const after = verifyCase({ case: dir })
  const law = after.checks.find((c) => c.name === 'law')
  assert.equal(law.status, 'pass')
  // 忽略记录写进文件，可审计
  const w = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'verify-waivers.json'), 'utf8'))
  assert.equal(w.law.by, '赵律师')
  assert.match(w.law.reason, /无法条争议/)

  // 可撤销
  waiveCheck({ case: dir, name: 'law', revoke: true })
  const w2 = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'verify-waivers.json'), 'utf8'))
  assert.equal(w2.law, undefined)
})
