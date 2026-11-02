// 报告发布闸门：坏意见不能印给客户。
//
// 真机发现（2026-11-01）：某案件 3 条意见的「修改方案」与「问题描述」完全相同，
// 其中一条甚至把**审核指令**（"你是甲方的律师，审核此合同…"）当成了修改条文。
// 报告是对外交付物——这种东西印出去，客户看到的是一份没有替代方案的清单。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { casePaths } from '../lib/core/store.js'

function makeDocx(file, paras) {
  const body = paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'))
  fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), '<Types/>')
  fs.mkdirSync(path.join(tmp, '_rels'))
  fs.writeFileSync(path.join(tmp, '_rels', '.rels'), '<Relationships/>')
  fs.mkdirSync(path.join(tmp, 'word'))
  fs.writeFileSync(path.join(tmp, 'word', 'document.xml'), doc)
  execFileSync('zip', ['-qr', path.resolve(file), '.'.toString()], { cwd: tmp })
}

async function setup() {
  const { indexClauses, addNote, buildReport } = await import('../lib/core/clause.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-report-'))
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  makeDocx(path.join(src, '合同.docx'), ['第一条 价款', '甲方付款。', '第二条 交付', '乙方交付。'])
  const A = path.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  const cp = casePaths(A)
  const cache = path.join(cp.state, 'cache', 'parse')
  fs.mkdirSync(cache, { recursive: true })
  for (const f of JSON.parse(fs.readFileSync(cp.materials, 'utf8')).files) {
    fs.writeFileSync(path.join(cache, `${f.mid}.json`), '{}')
  }
  indexClauses({ case: A, file: 'M1' })
  return { A, cp, addNote, buildReport }
}

test('★ 修改方案 = 问题描述时，拒绝出报告并点名', async () => {
  const { A, cp, buildReport } = await setup()
  const same = '付款没有约定期限，甲方可以无限期拖延而不构成违约'
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({ id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险', issue: same, fix: same, at: new Date().toISOString() }) + '\n'
  )
  assert.throws(
    () => buildReport({ case: A }),
    (e) => {
      assert.equal(e.code, 'report/bad-notes')
      assert.match(e.message, /N1/)
      assert.match(e.message, /完全相同/)
      return true
    }
  )
})

test('★ 修改方案里混进审核指令原话时，也拦住', async () => {
  const { A, cp, buildReport } = await setup()
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({
      id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险',
      issue: '付款没有约定期限，甲方可以无限期拖延而不构成违约',
      fix: '你是甲方的律师，审核此合同，主要审核对甲方不利的法律条款',
      at: new Date().toISOString(),
    }) + '\n'
  )
  assert.throws(() => buildReport({ case: A }), /审核指令|提示词/)
})

test('反例：正常的意见建议照常出表（闸门不能误杀）', async () => {
  const { A, cp, buildReport } = await setup()
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({
      id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险',
      issue: '付款没有约定具体期限，甲方可以无限期拖延而不构成违约',
      fix: '甲方应于收到发票后 15 个工作日内支付全部价款，逾期按日万分之五计付违约金。',
      at: new Date().toISOString(),
    }) + '\n'
  )
  const r = buildReport({ case: A })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(r.file))
  const md = fs.readFileSync(r.file, 'utf8')
  assert.match(md, /甲方应于收到发票后 15 个工作日内支付全部价款/)
})

test('空修改方案也要拦住（没有替代条文的意见不是意见）', async () => {
  const { A, cp, buildReport } = await setup()
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({
      id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险',
      issue: '付款没有约定具体期限，甲方可以无限期拖延而不构成违约',
      fix: '',
      at: new Date().toISOString(),
    }) + '\n'
  )
  assert.throws(() => buildReport({ case: A }), /没有修改方案/)
})
