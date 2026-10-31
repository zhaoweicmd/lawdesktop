// 核对签字（checkoff）的测试。
// 核心命题：签字页必须如实反映「谁看了哪一条、什么时候、内容有没有被改」，
// 不允许因为「大部分核过了」就写得比实际更干净。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { addFact } from '../lib/core/fact.js'
import { addFinding } from '../lib/core/finding.js'
import { scanMaterials } from '../lib/core/material.js'
import { checkItem, checkStatus, buildSignoff, CHECK_KINDS, RESULTS } from '../lib/core/checkoff.js'

function mkCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-chk-'))
  const dir = path.join(root, '案')
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, '合同.pdf'), 'x')
  fs.writeFileSync(path.join(src, '函件.docx'), 'x')
  newCase({ dir, title: '核对签字测试案', materialsDirs: [src] })
  scanMaterials({ case: dir, source: src })
  addFact({ case: dir, text: '被告于2025年3月1日收取货款人民币50万元', source: path.join(src, '合同.pdf'), locator: 'P12' })
  addFact({ case: dir, text: '被告未在约定期限内交付货物，逾期已达九十日', source: path.join(src, '函件.docx'), locator: '第2页' })
  addFinding({
    case: dir,
    text: '被告收取货款后逾期九十日未交货，构成根本违约，原告有权解除并要求返还货款',
    factRefs: ['F1', 'F2'],
  })
  return { root, dir }
}

test('三本台账都能核：事实 / 结论 / 材料', () => {
  const { dir } = mkCase()
  assert.ok(CHECK_KINDS.fact && CHECK_KINDS.finding && CHECK_KINDS.material)
  assert.equal(checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' }).ok, true)
  assert.equal(checkItem({ case: dir, kind: 'finding', id: 'K1', result: 'ok', by: '张律师' }).ok, true)
  assert.equal(checkItem({ case: dir, kind: 'material', id: 'M1', result: 'ok', by: '张律师' }).ok, true)
  const st = checkStatus({ case: dir })
  assert.equal(st.done, 3)
})

test('没有默认通过：没点过的就是「未核对」', () => {
  const { dir } = mkCase()
  const st = checkStatus({ case: dir })
  assert.equal(st.done, 0)
  assert.equal(st.pending, st.total)
  assert.ok(st.items.every((x) => x.result === null), '一条都不该被自动判为已核')
  assert.match(st.summary, /已核 0\//)
})

test('需修改/有疑问必须写说明，否则拒收', () => {
  const { dir } = mkCase()
  assert.throws(() => checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'fix', by: '张律师' }), /必须写一句说明/)
  assert.throws(() => checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'doubt', by: '张律师' }), /必须写一句说明/)
  assert.equal(checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'fix', by: '张律师', note: '金额需与银行流水核对' }).ok, true)
})

test('核对人必须写：签字页上没有名字等于没人负责', () => {
  const { dir } = mkCase()
  assert.throws(() => checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok' }), /核对人要写/)
})

test('非法的 kind / result / 编号都拒收，并给出可用清单', () => {
  const { dir } = mkCase()
  assert.throws(() => checkItem({ case: dir, kind: 'nope', id: 'F1', result: 'ok', by: 'x' }), /kind 只能是/)
  assert.throws(() => checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'pass', by: 'x' }), /核对结论只能是/)
  assert.throws(() => checkItem({ case: dir, kind: 'fact', id: 'F99', result: 'ok', by: 'x' }), /没有 F99/)
})

test('追加写、可审计：同一条重复核对，以最后一次为准', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'doubt', by: '张律师', note: '出处页码看不清' })
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const st = checkStatus({ case: dir })
  const f1 = st.items.find((x) => x.kind === 'fact' && x.id === 'F1')
  assert.equal(f1.result, 'ok')
  const rows = fs.readFileSync(path.join(casePaths(dir).state, 'checkoff.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(rows.length, 2, '两次核对都留在文件里，不覆盖')
})

test('签字单如实写明未核条数（允许签，但不许看起来比实际干净）', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const r = buildSignoff({ case: dir, signer: '张律师' })
  const md = fs.readFileSync(r.file, 'utf8')
  assert.match(md, /签字人：\*\*张律师\*\*/)
  assert.match(md, /未核对：\*\*\d+\*\*/)
  assert.match(md, /不是.*全部无误.*的证明/, '有未核项时必须加风险声明')
  assert.match(md, /SHA256|〔不存在〕|^[0-9a-f]{64}$/m)
  assert.equal(r.meta.stats.done >= 1, true)
  assert.ok(r.meta.stats.pending > 0)
})

test('全部核完时签字单写「已逐条核对」', () => {
  const { dir } = mkCase()
  const st0 = checkStatus({ case: dir })
  for (const it of st0.items) checkItem({ case: dir, kind: it.kind, id: it.id, result: 'ok', by: '李律师' })
  const r = buildSignoff({ case: dir, signer: '李律师' })
  const md = fs.readFileSync(r.file, 'utf8')
  assert.match(md, /已逐条核对/)
  assert.ok(!/全部无误.*证明/.test(md))
  assert.equal(r.meta.stats.pending, 0)
})

test('核对后又改了内容：签字单标「核对后已改」并计入 stale', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  assert.equal(checkStatus({ case: dir }).stale, 0)
  // 追加一条修正（改内容）
  const cp = casePaths(dir)
  fs.appendFileSync(cp.facts, JSON.stringify({ id: 'F1', text: '改过的内容：被告收取货款人民币60万元', source: { file: '合同.pdf', locator: 'P12' }, at: new Date().toISOString() }) + '\n')
  const st = checkStatus({ case: dir })
  assert.equal(st.stale, 1, '内容变了必须能查出来')
  const r = buildSignoff({ case: dir, signer: '张律师' })
  const md = fs.readFileSync(r.file, 'utf8')
  assert.match(md, /核对后已改/)
})

test('签字人要必填；产物落 out/ 并有 signoff.json 记录指纹', () => {
  const { dir } = mkCase()
  assert.throws(() => buildSignoff({ case: dir }), /签字人要写/)
  const r = buildSignoff({ case: dir, signer: '王律师' })
  assert.ok(r.file.includes('/out/'))
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(r.file), 'signoff.json'), 'utf8'))
  assert.equal(meta.signer, '王律师')
  assert.ok(Array.isArray(meta.digests) && meta.digests.length >= 3)
  assert.ok(meta.digests.every((d) => d.name && d.sha256))
})

test('三本台账互不串味：kind 标错就查不到', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const st = checkStatus({ case: dir })
  const K1 = st.items.find((x) => x.kind === 'finding' && x.id === 'K1')
  assert.equal(K1.result, null, '结论 K1 不该因为 F1 被核就变成已核')
})

test('RESULTS 三档齐全且互斥', () => {
  assert.deepEqual(Object.keys(RESULTS).sort(), ['doubt', 'fix', 'ok'])
  assert.equal(new Set(Object.values(RESULTS).map((r) => r.label)).size, 3)
})

test('事实被修正过也只算一条（amend 是追加覆盖，不是重复条目）', () => {
  const { dir } = mkCase()
  const before = checkStatus({ case: dir }).kinds.fact.total
  assert.equal(before, 2)
  // 修正 F1：追加一条同 id 的覆盖记录
  import('../lib/core/fact.js').then(() => {})
  const fsx = fs
  const cp = casePaths(dir)
  fsx.appendFileSync(
    cp.facts,
    JSON.stringify({
      id: 'F1',
      text: '被告于2025年3月1日收取货款人民币55万元（经银行流水核对）',
      source: { file: '合同.pdf', locator: 'P13' },
      __amended: true,
      amendedAt: new Date().toISOString(),
      amendReason: '金额按流水修正',
    }) + '\n'
  )
  const st = checkStatus({ case: dir })
  assert.equal(st.kinds.fact.total, 2, '修正不该让条数变多')
  const f1 = st.items.find((x) => x.kind === 'fact' && x.id === 'F1')
  assert.match(f1.text, /55万元/, '取的是修正后的最新内容')
  assert.equal(st.items.filter((x) => x.kind === 'fact' && x.id === 'F1').length, 1, '同一编号只出现一次')
})

// ---- 批量核对 ----

import { checkMany } from '../lib/core/checkoff.js'

test('批量核对：逐条留痕，不是一次性写一条', () => {
  const { dir } = mkCase()
  const r = checkMany({ case: dir, kind: 'fact', ids: ['F1', 'F2'], result: 'ok', by: '张律师' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.done, ['F1', 'F2'])
  assert.match(r.summary, /成功 2 条/)
  const st = checkStatus({ case: dir })
  assert.equal(st.kinds.fact.done, 2)
  const rows = fs.readFileSync(path.join(casePaths(dir).state, 'checkoff.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(rows.length, 2, '每条都要有自己的记录')
})

test('批量核对：不存在「全部通过」——不给 ids 直接拒收', () => {
  const { dir } = mkCase()
  assert.throws(() => checkMany({ case: dir, kind: 'fact', ids: [], result: 'ok', by: '张律师' }), /不提供「全部通过」/)
  assert.throws(() => checkMany({ case: dir, kind: 'fact', result: 'ok', by: '张律师' }), /不提供「全部通过」/)
})

test('批量核对：单条失败不静默跳过，如实回报', () => {
  const { dir } = mkCase()
  const r = checkMany({ case: dir, kind: 'fact', ids: ['F1', 'F404'], result: 'ok', by: '张律师' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.done, ['F1'])
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].id, 'F404')
  assert.match(r.summary, /失败 1 条/)
})

test('批量核对：一次最多 200 条（再多就不叫逐条核对了）', () => {
  const { dir } = mkCase()
  const ids = Array.from({ length: 201 }, (_, i) => 'F' + (i + 1))
  assert.throws(() => checkMany({ case: dir, kind: 'fact', ids, result: 'ok', by: 'x' }), /一次最多 200 条/)
})

test('批量核对：仍然要求核对人', () => {
  const { dir } = mkCase()
  const r = checkMany({ case: dir, kind: 'fact', ids: ['F1'], result: 'ok' })
  assert.equal(r.ok, false)
  assert.match(r.failed[0].error, /核对人要写/)
})
