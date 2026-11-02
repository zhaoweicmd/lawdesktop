import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newCase } from '../lib/core/case.js'
import { verifyCase } from '../lib/core/verify.js'
import { casePaths, writeJsonAtomic, appendJsonl } from '../lib/core/store.js'

function mkCase(type = 'contract') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-type-'))
  newCase({ dir, title: '案型测试案', cause: '测试', parties: '甲；乙', caseType: type })
  return dir
}

function seedClauses(dir) {
  writeJsonAtomic(casePaths(dir).clauses, {
    files: [
      {
        file: '/fake/合同.docx',
        name: '合同.docx',
        parsedAt: new Date().toISOString(),
        paragraphs: 10,
        clauses: [
          { no: '第一条', heading: '第一条 服务内容', text: '……' },
          { no: '第二条', heading: '第二条 付款', text: '……' },
          { no: '第三条', heading: '第三条 违约', text: '……' },
        ],
      },
    ],
  })
}

const GOOD = {
  file: '合同.docx',
  clause: '第二条',
  clauseHeading: '第二条 付款',
  level: '重大风险',
  issue: '付款条件写「验收合格后付款」，但未定义验收标准与期限，甲方可无限期拖延',
  fix: '改为：甲方应于收到乙方交付成果后 10 个工作日内书面确认验收；逾期未确认视为验收合格，付款期限自验收合格之日起 30 日。',
  at: new Date().toISOString(),
}

test('建案可按案型，非法案型直接拒', () => {
  const d = mkCase('contract')
  assert.equal(JSON.parse(fs.readFileSync(casePaths(d).caseJson, 'utf8')).caseType, 'contract')
  assert.throws(() => mkCase('随便什么'), /案型只能是/)
})

test('合同审核案的第一道看「条款是否已索引」，不是「事实台账」', () => {
  const d = mkCase('contract')
  const r = verifyCase({ case: d })
  assert.equal(r.caseType, 'contract')
  const clauses = r.checks.find((c) => c.name === 'clauses')
  assert.ok(clauses, '应有 clauses 道')
  assert.equal(clauses.status, 'fail')
  assert.ok(!r.checks.some((c) => c.name === 'facts'), '合同案不该有事实道')
  // 事实台账为空也不该成为拦路条件
  assert.ok(!r.mustFix.some((m) => /事实台账/.test(m.msg)))
})

test('合同审核案的第三道看「意见能否直接改」：缺修改方案要 fail', () => {
  const d = mkCase('contract')
  seedClauses(d)
  appendJsonl(casePaths(d).notes, { ...GOOD, id: 'N1', fix: '' })
  const r = verifyCase({ case: d })
  const notes = r.checks.find((c) => c.name === 'notes')
  assert.equal(notes.status, 'fail')
  assert.ok(notes.items.some((i) => /没有修改方案/.test(i.msg)))
})

test('四要素齐全的意见能过，且不因「意见少」而失败', () => {
  const d = mkCase('contract')
  seedClauses(d)
  appendJsonl(casePaths(d).notes, { ...GOOD, id: 'N1' })
  const r = verifyCase({ case: d })
  const notes = r.checks.find((c) => c.name === 'notes')
  assert.equal(notes.status, 'pass', JSON.stringify(notes.items))
})

test('意见指向索引里不存在的条款要提示（可能编号变了）', () => {
  const d = mkCase('contract')
  seedClauses(d)
  appendJsonl(casePaths(d).notes, { ...GOOD, id: 'N1', clause: '第九条' })
  const r = verifyCase({ case: d })
  const notes = r.checks.find((c) => c.name === 'notes')
  assert.ok(notes.items.some((i) => i.level === 'warn' && /不在索引里/.test(i.msg)))
})

test('意见含空泛表述要 fail', () => {
  const d = mkCase('contract')
  seedClauses(d)
  appendJsonl(casePaths(d).notes, { ...GOOD, id: 'N1', fix: '建议进一步完善相关条款，进一步明确各方责任与义务边界' })
  const r = verifyCase({ case: d })
  const notes = r.checks.find((c) => c.name === 'notes')
  assert.equal(notes.status, 'fail')
  assert.ok(notes.items.some((i) => /空泛表述/.test(i.msg)))
})

test('诉讼案仍走原来的五道（事实道必须在）', () => {
  const d = mkCase('litigation')
  const r = verifyCase({ case: d })
  assert.equal(r.caseType, 'litigation')
  assert.ok(r.checks.some((c) => c.name === 'facts'))
  assert.ok(r.checks.some((c) => c.name === 'logic'))
})

test('合同审核案的交付包放条款索引，不放空的事实台账', async () => {
  const { buildDelivery } = await import('../lib/core/deliver.js')
  const d = mkCase('contract')
  seedClauses(d)
  appendJsonl(casePaths(d).notes, { ...GOOD, id: 'N1' })
  const out = path.join(d, 'out')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, '合同审核意见_20260101-0000.md'), '# 意见\n', 'utf8')
  const r = buildDelivery({ case: d })
  assert.ok(r.files.some((f) => f.name === '03_条款索引.md'), '合同案应有条款索引')
  assert.ok(!r.files.some((f) => f.name.includes('事实台账')), '合同案不该放事实台账')
  const idx = fs.readFileSync(path.join(r.dir, '03_条款索引.md'), 'utf8')
  assert.match(idx, /第三條|第三条/) // 索引里要真有条款
})
