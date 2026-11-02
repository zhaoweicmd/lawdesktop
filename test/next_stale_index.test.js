// 三条真机教训（2026-11-01 用户实测）：
//   1. AI 审出 21 条草稿，界面却告诉他"还没有意见"
//   2. 只登记了 1 条意见，下一步就卡在「意见只有 1 条 → 继续逐条审」
//   3. 索引是旧逻辑生成的（1,2,3 混在第一条…第十五条里），草稿挂不上
//
// 这三条互相掩盖：看起来是"AI 没审出东西"，实际是索引脏了 + 判据把"意见少"当成缺陷。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { nextStep } from '../lib/core/next.js'
import { casePaths, writeJsonAtomic } from '../lib/core/store.js'
import { execFileSync } from 'node:child_process'

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

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-'))
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
  return { root, A, cp }
}

/** 直接写一份 clauses.json（模拟不同形态的索引） */
function putClauses(cp, nos) {
  writeJsonAtomic(cp.clauses, {
    files: [{ file: '/tmp/合同.docx', name: '合同.docx', paragraphs: 10, clauses: nos.map((no) => ({ no, heading: no, text: no, chars: 4, lines: 1 })) }],
  })
}

test('★ 旧索引（数字与「第X条」混在一起）必须被识别出来，并推「重新索引」', () => {
  const { A, cp } = setup()
  putClauses(cp, ['1', '2', '3', '第一条', '第二条'])
  const r = nextStep({ case: A })
  assert.equal(r.next.tool, 'lc_clause_index', `应推重新索引，实际推了 ${r.next.tool}`)
  assert.match(r.next.stuck, /旧版本|前言/)
})

test('反例：干净的索引不该被判成过期（否则每次打开都催你重建）', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  const r = nextStep({ case: A })
  assert.doesNotMatch(String(r.next.stuck), /旧版本|前言/)
})

test('纯数字编号的合同（自动编号）不算过期', () => {
  const { A, cp } = setup()
  putClauses(cp, ['1', '2', '3'])
  const r = nextStep({ case: A })
  assert.doesNotMatch(String(r.next.stuck), /旧版本|前言/)
})

test('★ 意见条数少不是缺陷：1 条也不该被要求"继续逐条审"', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  writeJsonAtomic(path.join(cp.state, 'notes.jsonl'), [])
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({ id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险', issue: '付款没有期限', fix: '甲方应于 15 日内付款。', at: new Date().toISOString() }) + '\n'
  )
  const r = nextStep({ case: A })
  assert.doesNotMatch(String(r.next.stuck), /意见只有/, '合同本来就只有一处问题，不能要求凑数')
})

test('★ 有 AI 草稿但没采纳时，推「去采纳」而不是「去登记」', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  writeJsonAtomic(path.join(cp.state, 'note-drafts.json'), {
    file: '合同.docx',
    at: new Date().toISOString(),
    drafts: [
      { clause: '第一条', level: '重大风险', issue: '付款没有期限', fix: '甲方应于 15 日内付款。', ok: true },
      { clause: '第二条', level: '建议修改', issue: '交付标准不明', fix: '交付标准以附件一为准。', ok: true },
    ],
  })
  const r = nextStep({ case: A })
  assert.match(r.next.stuck, /AI 已审出 \d+ 条|没采纳/, `应提示去采纳草稿，实际：${r.next.stuck}`)
})

// ===== 重复登记自动变成更新 =====
test('★ 同一条款同一问题再保存 = 更新那一条，不是报错', async () => {
  // 用户 2026-11-01 实测：保存时弹「已登记过相同问题 N6，请用『更新』」——
  // 而界面**根本没有那个按钮**。等于让用户去点一个不存在的东西。
  const { addNote, loadNotes } = await import('../lib/core/clause.js')
  const { indexClauses } = await import('../lib/core/clause.js')
  const { root, A, cp } = setup()
  indexClauses({ case: A, file: 'M1' })

  const args = {
    case: A,
    clause: '第一条',
    level: '重大风险',
    issue: '付款没有约定具体期限，甲方可以无限期拖延而不构成违约',
    fix: '甲方应于收到发票后 15 个工作日内支付全部价款。',
  }
  const a = addNote(args)
  assert.equal(a.ok, true)
  assert.equal(a.updated, undefined, '第一次应是新建')

  const b = addNote(args) // 完全同样的内容再存一次
  assert.equal(b.ok, true, '重复保存不该报错')
  assert.equal(b.updated, true, '应当走更新')
  assert.equal(b.note.id, a.note.id, '更新的是同一条，不是新开一条')
  assert.equal(loadNotes(cp).length, 1, '台账里应该只有一条')
})

test('反例：不同问题仍然允许各记一条（不能把不同风险合并掉）', async () => {
  const { addNote, loadNotes } = await import('../lib/core/clause.js')
  const { indexClauses } = await import('../lib/core/clause.js')
  const { A, cp } = setup()
  indexClauses({ case: A, file: 'M1' })
  addNote({ case: A, clause: '第一条', level: '重大风险', issue: '付款没有约定具体期限，甲方可以无限期拖延而不构成违约', fix: '甲方应于 15 日内付款。' })
  addNote({ case: A, clause: '第一条', level: '建议修改', issue: '没有约定逾期付款的违约金计算方式，违约成本为零', fix: '逾期按日万分之五计付违约金。' })
  assert.equal(loadNotes(cp).length, 2, '一条条款常同时有两处问题，不能合并')
})

// ===== 已交付/已验收的案件，不许再催「跑验收」「打交付包」 =====
// 用户 2026-11-01 实测：交付包显示「验收 pass」，底部还在写「下一步：跑验收」。
// 原因是这两条提示无条件推，从不看验收跑没跑过。

function putVerify(cp, verdict) {
  writeJsonAtomic(path.join(cp.state, 'last-verify.json'), {
    at: new Date().toISOString(),
    verdict,
    summary: verdict === 'pass' ? '五道全过' : '1 道未通过',
    ok: verdict === 'pass',
    checks: [],
  })
}
function putDelivery(A, verdict) {
  const d = path.join(A, '交付包_20260101-0000')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'delivery.json'), JSON.stringify({ verdict, checks: [] }))
}
function seedNotes(cp) {
  fs.writeFileSync(
    cp.notes,
    JSON.stringify({ id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险', issue: '付款没有期限', fix: '甲方应于 15 日内付款。', at: new Date().toISOString() }) + '\n'
  )
}

test('★ 验收已 pass 时，不再提示「跑五道验收」', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  seedNotes(cp)
  putVerify(cp, 'pass')
  const r = nextStep({ case: A })
  const all = [r.next, ...(r.alsoTodo || [])].filter(Boolean).map((t) => t.tool)
  assert.ok(!all.includes('lc_case_verify'), `验收已过还在催：${all.join(',')}`)
})

test('★ 已有交付包（旧案件没有 last-verify.json）也不许再催验收', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  seedNotes(cp)
  putDelivery(A, 'pass') // 只有交付包，没有 last-verify.json
  const r = nextStep({ case: A })
  // r.next 可能是 null：那表示"这条线走到头了"，正是期望结果
  const all = [r.next, ...(r.alsoTodo || [])].filter(Boolean).map((t) => t.tool)
  assert.ok(!all.includes('lc_case_verify'), `交付包里已 pass，却还在催验收：${all.join(',')}`)
  assert.ok(!all.includes('lc_deliver'), `已经打过交付包了，不该再催：${all.join(',')}`)
})

test('反例：验收没过时仍然要催（不能因为"跑过一次"就当过了）', () => {
  const { A, cp } = setup()
  putClauses(cp, ['第一条', '第二条'])
  seedNotes(cp)
  putVerify(cp, 'needs_fix')
  const r = nextStep({ case: A })
  const all = [r.next, ...(r.alsoTodo || [])].filter(Boolean).map((t) => t.tool)
  assert.ok(all.includes('lc_case_verify'), '验收没过当然要催修，不能因为跑过就放过')
  // 但"打交付包"可以先不催（还没过）
  assert.match(String(r.next.stuck) + (r.alsoTodo || []).map((t) => t.stuck).join(''), /验收/, '要说明上次验收没过')
})
