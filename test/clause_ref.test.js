// 「用户/AI 只说合同是哪一份」时的解析：材料编号、文件名、相对路径。
// 这一组钉住的坑：indexClauses 曾经只有 path.resolve(ref)，相对路径按**进程 cwd** 解析，
// 而 DSH Desktop 宿主的 cwd 是 launch-root —— 用户在条款页敲个文件名必然报
// 「合同文件不存在：/…/launch-root/xxx.docx」。看着像能用，实际是陷阱。

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/core/zipwrite.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { resolveContractRef, contractCandidates, indexClauses } from '../lib/core/clause.js'

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
  const base = tmpDir('ref')
  const src = path.join(base, '材料')
  makeDocx(path.join(src, '居间协议.docx'), ['第一条  甲方支付服务费。', '第二条  乙方提供居间服务。'])
  const caseDir = path.join(base, 'case')
  newCase({ dir: caseDir, title: '解析测试', caseType: 'contract', materialsDirs: [src] })
  scanMaterials({ case: caseDir })
  return { base, src, caseDir }
}

test('按材料编号索引：传 M1 就能找到台账里的真实路径', () => {
  const { caseDir } = setup()
  const abs = resolveContractRef(caseDir, 'M1')
  assert.ok(abs.endsWith('居间协议.docx'), abs)
  assert.ok(path.isAbsolute(abs))
  const r = indexClauses({ case: caseDir, file: 'M1' })
  assert.equal(r.count, 2)
})

test('按文件名索引：唯一匹配时不必给路径', () => {
  const { caseDir } = setup()
  assert.ok(resolveContractRef(caseDir, '居间协议.docx').endsWith('居间协议.docx'))
  assert.equal(indexClauses({ case: caseDir, file: '居间协议.docx' }).count, 2)
})

test('相对路径按案件目录解析，不按进程 cwd', () => {
  const { caseDir } = setup()
  // 复制一份到案件目录下的相对位置，验证解析顺序
  const rel = path.join(caseDir, '合同副本.docx')
  makeDocx(rel, ['第一条  测试。'])
  assert.equal(resolveContractRef(caseDir, '合同副本.docx'), rel)
})

test('候选列表：列出材料里的 docx，并标出是否已索引', () => {
  const { caseDir } = setup()
  const before = contractCandidates({ case: caseDir })
  assert.equal(before.length, 1)
  assert.equal(before[0].mid, 'M1')
  assert.equal(before[0].indexed, false)
  indexClauses({ case: caseDir, file: 'M1' })
  const after = contractCandidates({ case: caseDir })
  assert.equal(after[0].indexed, true)
  assert.equal(after[0].clauseCount, 2)
})

test('找不到时把试过的地方和台账内容说清楚，而不是只报一个路径', () => {
  const { caseDir } = setup()
  let msg = ''
  try {
    resolveContractRef(caseDir, '不存在的合同.docx')
  } catch (e) {
    msg = e.message
  }
  assert.match(msg, /找不到/)
  assert.match(msg, /M\d+=/, '应列出台账里的文件，方便直接改用 M 编号')
})

test('意见编号不复用：作废/折叠后新增意见不能撞号', async () => {
  const os = await import('node:os')
  const { newCase } = await import('../lib/core/case.js')
  const { writeZip } = await import('../lib/core/zipwrite.js')
  const { scanMaterials } = await import('../lib/core/material.js')
  const { indexClauses, addNote, deleteNote, loadNotes } = await import('../lib/core/clause.js')
  const { casePaths } = await import('../lib/core/store.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-id-'))
  const mat = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-id-mat-'))
  newCase({ dir, title: '编号测试', caseType: 'contract' })
  const doc =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>第一条 甲方应在验收合格后十日内支付服务费人民币十万元。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二条 乙方应于收到付款后交付成果，交付标准以附件为准。</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  fs.writeFileSync(path.join(mat, '合同.docx'), writeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: doc },
  ]))
  scanMaterials({ case: dir, source: mat })
  indexClauses({ case: dir, file: '合同.docx' })

  const mk = (clause, issue) =>
    addNote({
      case: dir,
      file: '合同.docx',
      clause,
      level: '建议修改',
      issue,
      fix: '甲方应在验收合格后十日内支付；逾期付款的，每逾期一日按未付金额万分之五支付违约金。',
    })

  const a = mk('第一条', '付款未设逾期违约金，甲方拖延验收时价款无从主张，救济不足。')
  const b = mk('第二条', '交付标准以附件为准但未约定附件一，标准可能缺失导致无法验收。')
  assert.equal(a.note.id, 'N1')
  assert.equal(b.note.id, 'N2')

  // 作废一条，再登记新的：编号必须继续往后，不能复用 N2
  deleteNote({ case: dir, id: 'N2' })
  const c = mk('第二条', '乙方交付期限未约定，甲方无法主张迟延交付责任，履约进度不可控。')
  const all = loadNotes(casePaths(dir))
  const idSet = new Set(all.map((x) => x.id))
  assert.equal(idSet.size, all.length, '编号必须唯一：' + JSON.stringify(all.map((x) => x.id)))
  assert.notEqual(c.note.id, 'N2', '作废的编号不能复用')
  assert.ok(idSet.has('N3'), '新意见应该拿到 N3，实际：' + [...idSet].join(','))
})
