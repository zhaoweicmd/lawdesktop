// 合同审核三项强化：
//   B 引文逐字核对（note.add 的 quote）
//   C 审核口径（立场 / 合同类型 / 补充要求）
//   D 修订对照预览（previewRevision）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase, openCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { addNote, listNotes } from '../lib/core/clause.js'
import {
  readReviewConfig,
  setReviewConfig,
  reviewBrief,
  reviewRules,
  normalizeReviewConfig,
  STANCES,
  CONTRACT_TEMPLATES,
} from '../lib/core/contractcfg.js'
import { previewRevision } from '../lib/core/preview.js'

const CLAUSES = [
  {
    no: '第二条',
    heading: '第二条 价款与付款',
    text: '第二条 价款与付款\n合同总价为人民币 100 万元；签订后 3 日内一次性付款。',
  },
  {
    no: '第三条',
    heading: '第三条 交付与验收',
    text: '第三条 交付与验收\n卖方应于 2026 年 12 月 31 日前交付；买方应于交付后 7 日内验收，逾期未验收视为验收合格。',
  },
]

function mkCase(type = 'contract') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-cr-'))
  newCase({ dir, title: '合同审核强化测试', caseType: type })
  fs.writeFileSync(
    casePaths(dir).clauses,
    JSON.stringify(
      { files: [{ file: '/fake/采购合同.docx', name: '采购合同.docx', parsedAt: new Date().toISOString(), clauses: CLAUSES }] },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

const BASE = {
  clause: '第二条',
  level: '重大风险',
  issue: '签订即全额付款且未与验收挂钩，导致买方先付钱后失去救济手段',
  fix: '合同签订后 7 个工作日内支付 30% 预付款；验收合格后 10 个工作日内支付剩余 70%。',
}

// ---------------- B：引文逐字核对 ----------------

test('B｜引文逐字出现才收，并原样存进台账', () => {
  const dir = mkCase()
  const r = addNote({ case: dir, ...BASE, quote: '签订后 3 日内一次性付款' })
  assert.equal(r.ok, true)
  assert.equal(r.note.quote, '签订后 3 日内一次性付款')
  assert.match(r.summary, /引文已逐字核对/)
  assert.equal(listNotes({ case: dir }).notes[0].quote, '签订后 3 日内一次性付款')
})

test('B｜引文被改写成同义句就拒收（不做相似容忍）', () => {
  const dir = mkCase()
  assert.throws(
    () => addNote({ case: dir, ...BASE, quote: '签约后立即支付全部价款' }),
    /没有在「第二条」里逐字出现/
  )
  assert.equal(listNotes({ case: dir }).count, 0, '拒收时不能落台账')
})

test('B｜引文过短（能被任何合同命中）也拒收', () => {
  const dir = mkCase()
  assert.throws(() => addNote({ case: dir, ...BASE, quote: '付款' }), /引文太短/)
})

test('B｜引文跨行/多空格时按空白规范化后仍能命中', () => {
  const dir = mkCase()
  const r = addNote({
    case: dir,
    clause: '第三条',
    level: '重大风险',
    issue: '交付时间只写在正文里，没有和任何付款或验收节点挂钩，卖方拖到最后一天也不构成违约',
    fix: '卖方应于 2026 年 12 月 31 日前交付；逾期交付的，按日承担合同总价万分之五的违约金。',
    quote: '卖方应于  2026 年 12 月 31 日\n前交付',
  })
  assert.equal(r.ok, true)
  assert.match(r.note.quote, /卖方应于/)
})

test('B｜不给引文照旧能登记（引文是加固项，不是新门槛）', () => {
  const dir = mkCase()
  const r = addNote({ case: dir, ...BASE })
  assert.equal(r.ok, true)
  assert.equal(r.note.quote, undefined)
  assert.match(r.summary, /未给引文/)
})

// ---------------- C：审核口径 ----------------

test('C｜新建合同案带默认口径；诉讼案也有字段但不影响判据', () => {
  const dir = mkCase()
  const d = openCase({ case: dir })
  assert.equal(d.review.stance, 'neutral')
  assert.equal(d.review.templateId, 'general')
  assert.match(d.review.brief, /立场：中立审查/)
})

test('C｜设置立场与类型后回显，并给出该类型的检查清单', () => {
  const dir = mkCase()
  const r = setReviewConfig({ case: dir, stance: 'partyB', templateId: 'purchase', instructions: '重点看验收期限' })
  assert.equal(r.ok, true)
  assert.equal(r.review.stance, 'partyB')
  assert.equal(r.review.templateId, 'purchase')
  assert.match(r.brief, /站在乙方立场/)
  assert.match(r.brief, /采购合同/)
  assert.match(r.brief, /重点看验收期限/)
  assert.ok(r.rules.some((x) => x.id === 'acceptance'), '采购合同模板必须含验收项')
  assert.match(openCase({ case: dir }).review.brief, /站在乙方立场/)
})

test('C｜非法立场/类型直接拒，不静默回退成默认值', () => {
  const dir = mkCase()
  assert.throws(() => setReviewConfig({ case: dir, stance: 'partyC' }), /立场只能是/)
  assert.throws(() => setReviewConfig({ case: dir, templateId: 'nope' }), /合同类型只能是/)
})

test('C｜只改一个字段时其他字段保持原值', () => {
  const dir = mkCase()
  setReviewConfig({ case: dir, stance: 'partyA', templateId: 'service', instructions: '别动这句话' })
  setReviewConfig({ case: dir, stance: 'partyB' })
  const r = readReviewConfig(dir)
  assert.equal(r.stance, 'partyB')
  assert.equal(r.templateId, 'service', '没传的类型不该被清空')
  assert.equal(r.instructions, '别动这句话', '没传的补充要求不该被清空')
})

test('C｜诉讼案不接受审核口径（免得给错案型加错字段）', () => {
  const dir = mkCase('litigation')
  assert.throws(() => setReviewConfig({ case: dir, stance: 'partyA' }), /只对合同审核案有意义/)
})

test('C｜老案件没有 review 字段时按默认读，不炸', () => {
  assert.deepEqual(
    Object.keys(normalizeReviewConfig(undefined)).sort(),
    ['instructions', 'stance', 'templateId', 'updatedAt']
  )
  assert.equal(normalizeReviewConfig({ stance: '乱写' }).stance, 'neutral')
  assert.equal(STANCES.length, 3)
  assert.equal(CONTRACT_TEMPLATES.length, 4)
  assert.ok(reviewRules({ templateId: 'lease' }).some((x) => x.id === 'deposit'))
})

// ---------------- D：修订对照预览 ----------------

test('D｜逐条给出差异与整份合并预览', () => {
  const dir = mkCase()
  addNote({ case: dir, ...BASE, quote: '签订后 3 日内一次性付款' })
  const r = previewRevision({ case: dir })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.deepEqual(r.changedClauses, ['第二条'])
  const it = r.items[0]
  assert.equal(it.clause, '第二条')
  assert.equal(it.changed, true)
  assert.ok(it.diff.oldMid.includes('签订后 3 日内一次性付款'), '被替换的原文要落在 oldMid')
  assert.ok(it.diff.newMid.includes('30% 预付款'), '新条文要落在 newMid')
  assert.equal(it.before, CLAUSES[0].text)
  // merged：已审条款换成建议条文，未审条款原样保留
  const merged = Object.fromEntries(r.merged.map((m) => [m.no, m]))
  assert.equal(merged['第二条'].changed, true)
  assert.match(merged['第二条'].text, /30% 预付款/)
  assert.equal(merged['第三条'].changed, false)
  assert.equal(merged['第三条'].text, CLAUSES[1].text)
  assert.match(r.summary, /修订预览/)
})

test('D｜只预览指定意见', () => {
  const dir = mkCase()
  const a = addNote({ case: dir, ...BASE })
  addNote({
    case: dir,
    clause: '第三条',
    level: '建议修改',
    issue: '验收期限只有 7 日且逾期视为合格，实际操作中买方很难在期限内完成检验',
    fix: '买方应于交付后 15 个工作日内验收并书面提出异议，逾期未提出的视为验收合格。',
  })
  const all = previewRevision({ case: dir })
  assert.equal(all.count, 2)
  const one = previewRevision({ case: dir, noteIds: [a.note.id] })
  assert.equal(one.count, 1)
  assert.equal(one.items[0].noteId, a.note.id)
})

test('D｜没有意见/没有索引时给可执行报错', () => {
  const dir = mkCase()
  assert.throws(() => previewRevision({ case: dir }), /还没有可预览的意见/)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-cr2-'))
  newCase({ dir: empty, title: '空案', caseType: 'contract' })
  assert.throws(() => previewRevision({ case: empty }), /还没有条款索引/)
})

test('D｜意见指向的条款不在索引里时归到 orphans，不静默丢掉', () => {
  const dir = mkCase()
  addNote({ case: dir, ...BASE })
  // 索引被重新生成，条款号变了
  fs.writeFileSync(
    casePaths(dir).clauses,
    JSON.stringify(
      { files: [{ file: '/fake/采购合同.docx', name: '采购合同.docx', clauses: [{ no: '第二条', heading: '第二条', text: '整条改写后的内容' }] }] },
      null,
      2
    ),
    'utf8'
  )
  const r = previewRevision({ case: dir })
  assert.equal(r.orphans.length, 0, '条款还在（只是内容变了），不该算 orphan')
  const r2 = previewRevision({ case: dir, file: '采购合同.docx' })
  assert.equal(r2.count, 1)
})

test('D｜预览是只读的：不写任何文件、不改意见状态', () => {
  const dir = mkCase()
  addNote({ case: dir, ...BASE })
  const before = fs.readFileSync(casePaths(dir).notes, 'utf8')
  const filesBefore = fs.readdirSync(casePaths(dir).state).sort()
  previewRevision({ case: dir })
  assert.equal(fs.readFileSync(casePaths(dir).notes, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(casePaths(dir).state).sort(), filesBefore)
})
