// 合同审核输出链路的测试：条款意见计数、意见表生成、修订版前置校验。
// 为了不依赖 docx 解析，这里直接种 .lawcase/clauses.json 与 notes.jsonl（模拟"已经索引过、已登记意见"）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { createApi } from '../lib/server/api.js'

function seedContractCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-contract-'))
  const dir = path.join(root, '合同审核')
  newCase({ dir, title: '合同审核', cause: '合同审核', caseType: 'contract' })

  const state = path.join(dir, '.lawcase')
  const docx = path.join(dir, '采购合同.docx')
  fs.writeFileSync(docx, 'PK-fake', 'utf8')

  const clauses = {
    files: [
      {
        name: '采购合同.docx',
        file: docx,
        clauses: [
          { no: '第一条', title: '标的', heading: '第一条 标的', text: '标的为设备一批。' },
          { no: '第二条', title: '付款', heading: '第二条 付款', text: '签订后一次性付清。' },
        ],
      },
      {
        name: '服务合同.docx',
        file: path.join(dir, '服务合同.docx'),
        clauses: [{ no: '第一条', title: '服务', heading: '第一条 服务', text: '提供运维服务。' }],
      },
    ],
  }
  fs.writeFileSync(path.join(state, 'clauses.json'), JSON.stringify(clauses), 'utf8')

  const notes = [
    {
      id: 'N1',
      file: '采购合同.docx',
      clause: '第二条',
      clauseHeading: '第二条 付款',
      level: '重大风险',
      issue: '一次性付清导致预付款风险过高，缺乏验收与付款前置条件',
      fix: '合同签订后支付合同总价的百分之三十作为预付款，剩余款项在验收合格后十个工作日内支付。',
      at: new Date().toISOString(),
    },
  ]
  fs.writeFileSync(path.join(state, 'notes.jsonl'), notes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8')

  return { root, dir }
}

test('clauses.list 标出每条已有几条意见，并按合同汇总', async () => {
  const { root, dir } = seedContractCase()
  const api = createApi({ version: 't', root })
  const out = await api.handle('clauses.list', { case: dir })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.data.count, 2, '两份合同')
  assert.equal(out.data.noteTotal, 1)

  const buy = out.data.files.find((f) => f.name === '采购合同.docx')
  assert.equal(buy.total, 2)
  assert.equal(buy.noteCount, 1)
  const second = buy.clauses.find((c) => c.no === '第二条')
  assert.equal(second.noteCount, 1, '第二条有一条意见')
  const first = buy.clauses.find((c) => c.no === '第一条')
  assert.equal(first.noteCount, 0, '第一条没有意见')

  const svc = out.data.files.find((f) => f.name === '服务合同.docx')
  assert.equal(svc.noteCount, 0)
})

test('contract.report 生成意见表 md，写到案件 out/ 下', async () => {
  const { root, dir } = seedContractCase()
  const api = createApi({ version: 't', root })
  const out = await api.handle('contract.report', { case: dir })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.ok(fs.existsSync(out.data.file), '文件应落盘')
  assert.equal(out.data.count, 1)
  assert.match(out.data.summary, /重大风险 1/)
  const md = fs.readFileSync(out.data.file, 'utf8')
  assert.match(md, /合同审核意见/)
  assert.match(md, /N1/)
})

test('没有意见时不出空表', async () => {
  const { root, dir } = seedContractCase()
  fs.writeFileSync(path.join(dir, '.lawcase', 'notes.jsonl'), '', 'utf8')
  const api = createApi({ version: 't', root })
  const out = await api.handle('contract.report', { case: dir })
  assert.equal(out.ok, false)
  assert.match(String(out.error.message), /还没有审核意见/)
})

test('没有条款索引时 report / revise 都给出可执行的报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-contract-empty-'))
  const dir = path.join(root, '空合同案')
  newCase({ dir, title: '空合同案', caseType: 'contract' })
  const api = createApi({ version: 't', root })

  const rep = await api.handle('contract.report', { case: dir })
  assert.equal(rep.ok, false)
  assert.match(String(rep.error.message), /还没有索引合同/)

  const rev = await api.handle('contract.revise', { case: dir })
  assert.equal(rev.ok, false)
  assert.match(String(rev.error.message), /还没有条款索引/)
})

test('契约 op 仍需案件目录校验', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-contract-plain-'))
  const plain = path.join(root, '普通目录')
  fs.mkdirSync(plain, { recursive: true })
  const api = createApi({ version: 't', root })
  const out = await api.handle('contract.report', { case: plain })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'case/not-a-case')
})
