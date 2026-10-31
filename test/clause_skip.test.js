// 「只索引其中一份，其余明确不索引」——让合同审核的索引这一步能真正走完。
//
// 用户实测反馈（2026-11-01）：
//   「合同卷宗有多个文件时我只能索引一个或几个，其它没有不索引的选项，
//     按现在的规则始终走不完这一步。」
//
// 根因：next/候选列表只区分「已索引 / 未索引」两种状态。
// 卷宗里只要混进一份没有「第X条」的附件（劳动合同、居间协议、保密承诺），
// 它永远是「未索引」，这一步就永远完不成。
//
// 这组测试的反例是最后一条：不跳过时，那份附件必须仍然挡路——
// 证明这是个真检查，而不是把问题藏起来。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { indexClauses, contractCandidates, skipContract, unindexClauses } from '../lib/core/clause.js'
import { nextStep } from '../lib/core/next.js'
import { casePaths } from '../lib/core/store.js'

/** 造一份真 docx（zip 结构最小可用），paras 里有没有「第X条」决定能不能切出条款 */
function makeDocx(file, paras) {
  const body = paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'))
  fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  fs.mkdirSync(path.join(tmp, '_rels'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '_rels', '.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  fs.mkdirSync(path.join(tmp, 'word'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'word', 'document.xml'), doc)
  execFileSync('zip', ['-qr', path.resolve(file), '.'.toString()], { cwd: tmp })
}


/** 按文件名取材料编号：扫描结果按文件名排序，写死 M1/M2 会指错文件 */
function midOf(caseDir, name) {
  const c = contractCandidates({ case: caseDir }).find((x) => x.name === name)
  if (!c) throw new Error(`候选里没有 ${name}`)
  return c.mid
}

function setup({ skipParse = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-skip-'))
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  makeDocx(path.join(src, '劳动合同.docx'), ['劳动合同', '第一条 岗位', '甲方安排乙方从事财务工作。', '第二条 工资', '每月支付 8000 元。'])
  makeDocx(path.join(src, '保密协议.docx'), ['保密协议', '第一条 保密范围', '第二条 保密期限'])
  // 没有条款编号的附件：这就是现实中卡住那一步的东西
  makeDocx(path.join(src, '居间协议.docx'), ['居间服务协议', '本协议主要约定双方居间报酬事项，没有条款编号。'])
  const A = path.join(root, '甲案')
  newCase({ dir: A, title: '多文件合同案', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  if (skipParse) {
    // 只造解析缓存，不真跑 pdftotext（假文件会抛错并留下未处理拒绝）
    const cp = casePaths(A)
    const cache = path.join(cp.state, 'cache', 'parse')
    fs.mkdirSync(cache, { recursive: true })
    for (const f of JSON.parse(fs.readFileSync(cp.materials, 'utf8')).files) {
      fs.writeFileSync(path.join(cache, `${f.mid}.json`), JSON.stringify({ mid: f.mid, units: [] }))
    }
  }
  return { root, src, A }
}

const byName = (caseDir) => {
  const m = new Map()
  for (const c of contractCandidates({ case: caseDir })) m.set(c.name, c)
  return m
}

test('候选列表区分「未索引」和「明确不索引」两回事', () => {
  const { A } = setup()
  indexClauses({ case: A, file: midOf(A, '劳动合同.docx') })
  skipContract({ case: A, file: midOf(A, '居间协议.docx'), reason: '居间协议无条款编号，本次不审' })
  const m = byName(A)
  assert.equal(m.get('劳动合同.docx').indexed, true)
  assert.equal(m.get('居间协议.docx').skipped, true)
  assert.equal(m.get('居间协议.docx').skipReason, '居间协议无条款编号，本次不审')
  assert.equal(m.get('保密协议.docx').skipped, false, '既没索引也没跳过 ⇒ 仍然是待决定')
})

test('★ 核心：只要索引过一份，「索引条款」这一步就算完成（未索引默认不审）', () => {
  // 用户口径（2026-11-01）：「我只索引了一个或多个文件，未点索引的默认就是不审核的，无需再确认」。
  const { A } = setup()
  indexClauses({ case: A, file: midOf(A, '劳动合同.docx') })
  indexClauses({ case: A, file: midOf(A, '保密协议.docx') })

  // 还剩一份没索引的居间协议——但它不该挡路
  const r = nextStep({ case: A })
  assert.equal(r.next.tool, 'lc_note_add', `未索引的合同挡路了（推了 ${r.next.tool}）：用户明确说不用再确认`)
  assert.doesNotMatch(r.next.stuck, /没决定|还没切条款/)
  // 也不该在待办里反复提示「去标记不索引」
  const pushSkip = (r.alsoTodo || []).find((t) => t.tool === 'lc_clause_skip')
  assert.equal(pushSkip, undefined, '不该再催用户去点「不索引」')
})

test('反例：一份都没索引时必须仍然挡路（不能让人一字未审就往下走）', () => {
  const { A } = setup()
  const r = nextStep({ case: A })
  assert.notEqual(r.next.tool, 'lc_note_add', '一份都没索引也能走到登意见 ⇒ 等于允许"没审就交付"')
  assert.match(r.next.stuck + r.next.action, /切条款|索引/)
})

test('「不索引」的理由是选填（未索引本来就默认不审，不必再确认）', () => {
  const { A } = setup()
  const m3 = midOf(A, '居间协议.docx')
  assert.doesNotThrow(() => skipContract({ case: A, file: m3, reason: '' }))
  const m = byName(A)
  assert.equal(m.get('居间协议.docx').skipped, true, '不写理由也应该能标记')
  assert.equal(m.get('居间协议.docx').skipReason, '')
})

test('已索引的不能直接标不索引（否则已登记的意见指向不存在的条款）', () => {
  const { A } = setup()
  const mid = midOf(A, '劳动合同.docx')
  indexClauses({ case: A, file: mid })
  assert.throws(() => skipContract({ case: A, file: mid, reason: '不审了' }), /不能直接跳过/)
})

test('取消跳过 ⇒ 恢复成「未索引」，且不会因此重新挡路（已索引过别的）', () => {
  const { A } = setup()
  indexClauses({ case: A, file: midOf(A, '劳动合同.docx') })
  const m3 = midOf(A, '居间协议.docx')
  skipContract({ case: A, file: m3, reason: '无条款编号' })
  skipContract({ case: A, file: m3, reason: '', unskip: true })
  const m = byName(A)
  assert.equal(m.get('居间协议.docx').skipped, false)
  // 已经索引过一份 ⇒ 未索引的那份依然不挡路
  assert.equal(nextStep({ case: A }).next.tool, 'lc_note_add')
})

test('取消索引：条款从台账里移除，且不留下"已索引"的假状态', () => {
  const { A } = setup()
  indexClauses({ case: A, file: midOf(A, '劳动合同.docx') })
  const before = contractCandidates({ case: A }).find((x) => x.name === '劳动合同.docx')
  assert.equal(before.indexed, true)
  unindexClauses({ case: A, file: midOf(A, '劳动合同.docx') })
  const after = contractCandidates({ case: A }).find((x) => x.name === '劳动合同.docx')
  assert.equal(after.indexed, false)
  assert.equal(after.clauseCount, 0)
})

test('跳过状态落盘可追溯（理由与时间都记下来）', () => {
  const { A } = setup()
  skipContract({ case: A, file: midOf(A, '居间协议.docx'), reason: '本次不审' })
  const cp = casePaths(A)
  const store = JSON.parse(fs.readFileSync(cp.clauses, 'utf8'))
  assert.equal(store.skipped.length, 1)
  assert.equal(store.skipped[0].reason, '本次不审')
  assert.ok(store.skipped[0].at)
  const logRaw = fs.readFileSync(cp.log, 'utf8')
  assert.match(logRaw, /clause-skip/)
})

test('一份都不索引、全部跳过 ⇒ 仍然提示「合同还没切条款」，不能假装完成', () => {
  const { A } = setup()
  for (const n of ['劳动合同.docx', '保密协议.docx', '居间协议.docx']) {
    skipContract({ case: A, file: midOf(A, n), reason: '无条款' })
  }
  const r = nextStep({ case: A })
  assert.match(r.next.stuck, /没有切出条款|还没切条款/, `全跳过却走到 ${r.next.tool}：等于允许"一字未审就交付"`)
})

// ===== 2.45：意见的落地形式（批注 / 改正文）=====

test('note.apply 默认是 comment（正文不动），显式才改', async () => {
  const { addNote, loadNotes } = await import('../lib/core/clause.js')
  const { newCase } = await import('../lib/core/case.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses } = await import('../lib/core/clause.js')
  const { casePaths } = await import('../lib/core/store.js')
  const fs2 = await import('node:fs')
  const os2 = await import('node:os')
  const path2 = await import('node:path')
  const { execFileSync } = await import('node:child_process')

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lawcase-apply-'))
  const src = path2.join(root, 'in')
  fs2.mkdirSync(src)
  // 最小 docx
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:t>第一条 价款约定如下。</w:t></w:r></w:p></w:body></w:document>`
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'dx-'))
  fs2.writeFileSync(path2.join(tmp, 'word'), '')
  fs2.rmSync(path2.join(tmp, 'word'))
  fs2.mkdirSync(path2.join(tmp, 'word'))
  fs2.mkdirSync(path2.join(tmp, '_rels'))
  fs2.writeFileSync(path2.join(tmp, '[Content_Types].xml'), '<Types/>')
  fs2.writeFileSync(path2.join(tmp, '_rels', '.rels'), '<Relationships/>')
  fs2.writeFileSync(path2.join(tmp, 'word', 'document.xml'), doc)
  execFileSync('zip', ['-qr', path2.join(src, '合同.docx'), '.'.toString()], { cwd: tmp })

  const A = path2.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  indexClauses({ case: A, file: 'M1' })

  addNote({ case: A, clause: '第一条', issue: '付款没有约定期限，甲方可以无限期拖延支付而不构成违约', fix: '甲方应于收到发票之日起 15 个工作日内支付全部价款。' })
  let rows = loadNotes(casePaths(A))
  assert.equal(rows[0].apply, 'comment', '默认必须是批注：替客户改正文属于越界')

  addNote({ case: A, clause: '第一条', issue: '没有约定逾期付款违约金，甲方拖欠没有任何成本', fix: '逾期付款的，每逾期一日按未付金额的万分之五计付违约金。', apply: 'redline' })
  rows = loadNotes(casePaths(A))
  const rl = rows.find((r) => r.apply === 'redline')
  assert.ok(rl, '显式声明要改正文时必须生效')
})

test('normalizeApply：认中英文多种写法，未知值回退到上一个或默认', async () => {
  const { normalizeApply } = await import('../lib/core/clause.js')
  assert.equal(normalizeApply('comment'), 'comment')
  assert.equal(normalizeApply('redline'), 'redline')
  assert.equal(normalizeApply('annotation'), 'comment')
  assert.equal(normalizeApply('track'), 'redline')
  assert.equal(normalizeApply(undefined), 'comment', '未传时默认批注')
  assert.equal(normalizeApply(undefined, { prev: 'redline' }), 'redline', '更新时应保留原值')
})
