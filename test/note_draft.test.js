// AI 预生成：worksheet 给可逐字引用的原句，validateDrafts 只判不写。
// 钉住的坑：引文必须逐字命中条款原文，凭记忆抄必被拒收；这里让「候选句子」来自原文本身。

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/core/zipwrite.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { indexClauses, addNote, reviewWorksheet, validateDrafts, listNotes } from '../lib/core/clause.js'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lawcase-${tag}-`))
}

function makeDocx(file, paras) {
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  return file
}

function setup() {
  const base = tmpDir('draft')
  const src = path.join(base, '材料')
  makeDocx(path.join(src, '合同.docx'), [
    '第一条  甲方应在验收合格后 10 个工作日内支付合同价款。',
    '第二条  乙方应在收到材料后 7 日内完成设计并交付。',
    '第三条  任何一方违约的，应赔偿对方全部损失。',
  ])
  const caseDir = path.join(base, 'case')
  newCase({ dir: caseDir, title: '草稿测试', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: caseDir })
  indexClauses({ case: caseDir, file: 'M1' })
  return caseDir
}

test('worksheet 列出全部条款，并给出可直接逐字引用的原句', () => {
  const caseDir = setup()
  const ws = reviewWorksheet({ case: caseDir })
  assert.equal(ws.total, 3)
  assert.equal(ws.pending, 3)
  const c1 = ws.items.find((x) => x.clause === '第一条')
  assert.ok(c1.sentences.length >= 1, '应给出候选引文')
  // 候选句子必须真的出现在条款原文里（否则选它也会被拒收）
  for (const s of c1.sentences) assert.ok(c1.text.includes(s), '候选引文必须来自原文：' + s)
})

test('worksheet 标出已有意见的条款，避免重复登记', () => {
  const caseDir = setup()
  addNote({
    case: caseDir,
    file: '合同.docx',
    clause: '第二条',
    level: '建议修改',
    issue: '交付期限只约定 7 日却未约定逾期后果，乙方迟延交付时甲方无救济依据。',
    fix: '乙方逾期交付的，每逾期一日按合同总价的 0.05% 支付违约金，逾期超过 15 日甲方有权解除合同。',
  })
  const ws = reviewWorksheet({ case: caseDir })
  assert.equal(ws.items.find((x) => x.clause === '第二条').noteCount, 1)
  assert.equal(ws.pending, 2)
})

test('validateDrafts 只判不写：合格/不合格分别标出，台账不变', () => {
  const caseDir = setup()
  const before = listNotes({ case: caseDir }).count
  const v = validateDrafts({
    case: caseDir,
    drafts: [
      { clause: '第一条', level: '重大风险', quote: '甲方应在验收合格后 10 个工作日内支付合同价款。',
        issue: '付款以验收合格为条件，但全文未约定验收标准与期限，卖方可无限拖延验收而甲方无救济。',
        fix: '甲方应在收货后 7 个工作日内按附件技术规格验收；逾期未提书面异议视为验收合格，付款期限自验收合格之日起算。' },
      { clause: '第二条', level: '建议修改', quote: '这句话原文里根本没有',
        issue: '引文是编的，这里写够十五个字让长度检查通过。',
        fix: '这是一段足够长的替换条文，用来验证长度检查能通过。' },
      { clause: '第三条', level: '提示', quote: '任何一方违约的',
        issue: '建议完善相关条款，予以明确。',
        fix: '乙方应加强管理，优化流程，注意风险。' },
    ],
  })
  assert.equal(v.count, 3)
  assert.equal(v.ready, 1, '只有第 1 条应通过: ' + JSON.stringify(v.drafts.map((d) => [d.clause, d.problems])))
  const bad = v.drafts.find((d) => d.clause === '第二条')
  assert.ok(bad.problems.some((p) => p.includes('引文')), '应指出引文没命中')
  const vague = v.drafts.find((d) => d.clause === '第三条')
  assert.ok(vague.problems.some((p) => p.includes('空泛')), '应指出空泛话术')
  assert.equal(listNotes({ case: caseDir }).count, before, '校验不能写台账')
})

test('validateDrafts 指出不存在的条款号', () => {
  const caseDir = setup()
  const v = validateDrafts({
    case: caseDir,
    drafts: [{ clause: '第九十九条', level: '提示', issue: '这一条的问题描述需要足够长才能通过长度检查。', fix: '对应的替换条文也需要足够长才能通过检查。' }],
  })
  assert.equal(v.drafts[0].ok, false)
  assert.ok(v.drafts[0].problems.some((p) => p.includes('没有')), JSON.stringify(v.drafts[0].problems))
})

test('编号两种写法都能认：条款是「第一条」时，草稿写 "1" 也能找到', () => {
  const caseDir = setup()
  // 合同用字面「第一条…」，草稿用阿拉伯数字 1 —— AI 和人都会混用
  const v = validateDrafts({
    case: caseDir,
    drafts: [{ clause: '1', level: '重大风险', quote: '甲方应在验收合格后 10 个工作日内支付合同价款。',
      issue: '付款以验收合格为条件，但全文未约定验收标准与期限，卖方可无限拖延验收而买方无救济。',
      fix: '买方应在收货后 7 个工作日内按附件技术规格验收；逾期未提书面异议视为验收合格。' }],
  })
  assert.equal(v.count, 1)
  assert.equal(v.drafts[0].ok, true, JSON.stringify(v.drafts[0].problems))
  assert.equal(v.drafts[0].clause, '第一条', '应回填真实条款号，避免落库时对不上')
})

test('草稿暂存：save=true 才落盘，list 读得回，逐条移除不误伤别人', async () => {
  const caseDir = setup()
  const { loadDrafts, clearDrafts } = await import('../lib/core/clause.js')
  const drafts = [
    { clause: '第一条', level: '重大风险', quote: '甲方应在验收合格后 10 个工作日内支付合同价款。',
      issue: '付款以验收合格为条件，但全文未约定验收标准与期限，卖方可无限拖延验收而买方无救济。',
      fix: '买方应在收货后 7 个工作日内按附件技术规格验收；逾期未提书面异议视为验收合格。' },
    { clause: '第二条', level: '建议修改', quote: '乙方应在收到材料后 7 日内完成设计并交付。',
      issue: '交付期限只约定 7 日却未约定逾期后果，乙方迟延时甲方没有任何救济依据。',
      fix: '乙方逾期交付的，每逾期一日按合同总价的 0.05% 支付违约金，逾期超过 15 日甲方有权解除。' },
  ]
  // 不 save 就不该落盘
  validateDrafts({ case: caseDir, drafts })
  assert.equal(loadDrafts({ case: caseDir }).count, 0, 'save=false 不能留痕')

  validateDrafts({ case: caseDir, drafts, save: true })
  const got = loadDrafts({ case: caseDir })
  assert.equal(got.count, 2)
  assert.equal(got.drafts[0].ok, true)

  // 采纳第一条后只移除它
  clearDrafts({ case: caseDir, clause: '第一条' })
  const after = loadDrafts({ case: caseDir })
  assert.equal(after.count, 1)
  assert.equal(after.drafts[0].clause, '第二条')

  clearDrafts({ case: caseDir })
  assert.equal(loadDrafts({ case: caseDir }).count, 0)
})

test('暂存草稿不能污染台账：采纳前 notes.jsonl 一条不能多', async () => {
  const caseDir = setup()
  const before = listNotes({ case: caseDir }).count
  validateDrafts({
    case: caseDir,
    save: true,
    drafts: [{ clause: '第一条', level: '重大风险', quote: '甲方应在验收合格后 10 个工作日内支付合同价款。',
      issue: '付款以验收合格为条件，但全文未约定验收标准与期限，卖方可无限拖延验收而买方无救济。',
      fix: '买方应在收货后 7 个工作日内按附件技术规格验收；逾期未提书面异议视为验收合格。' }],
  })
  assert.equal(listNotes({ case: caseDir }).count, before, '草稿只是暂存，不能自动变成意见')
})

// ---------- 条款审核判定：丢弃＝已审·无需修改，必须留痕 ----------
test('丢弃草稿要留判定：理由选填，但理由若在描述风险必须拒收', async () => {
  const caseDir = setup()
  const { ruleClause, loadRulings, rulingStatus } = await import('../lib/core/clause.js')
  // 理由留空是允许的（用户要求不用填理由）
  const empty = ruleClause({ case: caseDir, clause: '第一条', kind: 'norevision', reason: '' })
  assert.equal(empty.ok, true)
  assert.equal(loadRulings({ case: caseDir }).length, 1)

  // 但"理由"若在描述风险，就是自相矛盾的判定，必须拒收
  assert.throws(
    () => ruleClause({ case: caseDir, clause: '第二条', kind: 'norevision', reason: '未约定违约金且联系方式空白，缺乏救济' }),
    /描述风险/
  )
  assert.equal(loadRulings({ case: caseDir }).length, 1, '被拒的不能新增判定')

  ruleClause({ case: caseDir, clause: '第一条', kind: 'norevision', reason: '付款与验收顺序清楚，无修改必要' })
  const got = loadRulings({ case: caseDir })
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'norevision')

  // 进度里这条要算「已处理」而不是「漏审」
  const st = rulingStatus({ case: caseDir })
  const c1 = st.items.find((x) => x.clause === '第一条')
  assert.ok(c1.ruling, '应挂上判定')
  assert.equal(st.ruled, 1)
  assert.equal(st.pending, 2)
})

test('判定后写覆盖先写：同一条改判只保留最后一次', async () => {
  const caseDir = setup()
  const { ruleClause, loadRulings } = await import('../lib/core/clause.js')
  ruleClause({ case: caseDir, clause: '第二条', kind: 'norevision', reason: '先判为无需修改' })
  ruleClause({ case: caseDir, clause: '第二条', kind: 'revision', reason: '后来发现交付期限有问题' })
  const got = loadRulings({ case: caseDir })
  assert.equal(got.length, 1, '同一条只留一条判定')
  assert.equal(got[0].kind, 'revision')
})

test('已登记意见的条款也算已处理，不会重复要求审', async () => {
  const caseDir = setup()
  const { rulingStatus } = await import('../lib/core/clause.js')
  addNote({
    case: caseDir,
    file: '合同.docx',
    clause: '第一条',
    level: '重大风险',
    issue: '付款以验收合格为条件，但未约定验收标准与期限，卖方可无限拖延验收。',
    fix: '买方应在收货后 7 个工作日内按附件技术规格验收，逾期未提异议视为合格。',
  })
  const st = rulingStatus({ case: caseDir })
  const c1 = st.items.find((x) => x.clause === '第一条')
  assert.equal(c1.noteCount, 1)
  assert.equal(st.ruled, 1)
})
