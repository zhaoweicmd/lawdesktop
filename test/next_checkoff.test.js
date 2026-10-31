// 「下一步」的复核口径必须只看 checkoff。
// 历史坑：next.js 读 f.confirmed，而 addFact 写的是 verified —— 字段名对不上，
// 导致永远报「N 条事实待人工复核」，用户被一个假警报牵着走。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { addFact } from '../lib/core/fact.js'
import { scanMaterials } from '../lib/core/material.js'
import { planProcesses } from '../lib/core/proc.js'
import { checkItem } from '../lib/core/checkoff.js'
import { nextStep } from '../lib/core/next.js'
import { autoReview } from '../lib/core/review_auto.js'

function mkCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-nextck-'))
  const dir = path.join(root, '案')
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, '合同.pdf'), 'x')
  fs.writeFileSync(path.join(src, '函件.docx'), 'y')
  newCase({ dir, title: '下一步口径测试案', materialsDirs: [src] })
  scanMaterials({ case: dir, source: src })
  planProcesses({ case: dir, processes: [{ name: '梳理', acceptance: '清单出具' }] })
  addFact({ case: dir, text: '被告于2025年3月1日收取货款人民币50万元', source: path.join(src, '合同.pdf'), locator: 'P12' })
  addFact({ case: dir, text: '被告逾期九十日未交付货物', source: path.join(src, '函件.docx'), locator: '第2页' })
  return { dir, src }
}

test('没核对过：待核数 = 事实条数，核对项出现在待办里', () => {
  const { dir } = mkCase()
  const st = nextStep({ case: dir })
  assert.equal(st.state.factsPending, 2)
  assert.equal(st.state.factChecked, 0)
  // 材料没解析时优先级更高（这没问题），所以这里查待办列表而不是只查 top
  const all = [st.next, ...(st.alsoTodo || [])].filter(Boolean)
  const ck = all.find((x) => x.tool === 'lc_checkoff')
  assert.ok(ck, '核对项应出现在待办里：' + JSON.stringify(all.map((x) => x.tool)))
  assert.match(ck.stuck, /2 条事实还没人工核对/)
})

test('核过一条：待核数减一（不再永远全红）', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  const st = nextStep({ case: dir })
  assert.equal(st.state.factsPending, 1)
  assert.equal(st.state.factChecked, 1)
})

test('全部核完：核对这项不再是卡点', () => {
  const { dir } = mkCase()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  checkItem({ case: dir, kind: 'fact', id: 'F2', result: 'ok', by: '张律师' })
  const st = nextStep({ case: dir })
  assert.equal(st.state.factsPending, 0)
  assert.ok(!/还没人工核对/.test(st.summary), '不该再报待核对：' + st.summary)
})

test('事实按 id 合并：修正记录不重复计数', () => {
  const { dir } = mkCase()
  fs.appendFileSync(
    casePaths(dir).facts,
    JSON.stringify({ id: 'F1', text: '修正后：被告收取货款55万元', source: { file: '合同.pdf', locator: 'P13' }, __amended: true, amendedAt: new Date().toISOString(), amendReason: '金额修正' }) + '\n'
  )
  const st = nextStep({ case: dir })
  assert.equal(st.state.facts, 2, '修正是覆盖，不是新事实')
})

test('state 里的两种计数一致：facts 与核对总数同源', () => {
  const { dir } = mkCase()
  const st = nextStep({ case: dir })
  assert.equal(st.state.facts, st.state.factCheckTotal)
})

test('机器攻击 R1 也只看 checkoff：核过的不再被攻击', () => {
  const { dir } = mkCase()
  // 先出一条结论（引用两条事实）
  fs.appendFileSync(
    casePaths(dir).findings,
    JSON.stringify({ id: 'K1', text: '被告收款后逾期九十日未交货，构成根本违约，原告有权解除合同并要求返还货款', factRefs: ['F1', 'F2'], at: new Date().toISOString() }) + '\n'
  )
  const before = autoReview({ case: dir })
  const r1before = before.items.filter((x) => x.name === '事实未复核')
  assert.equal(r1before.length, 1, '没核对时应被攻击')
  assert.match(r1before[0].text, /尚未在核对台账里标为已核对/)

  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '张律师' })
  checkItem({ case: dir, kind: 'fact', id: 'F2', result: 'ok', by: '张律师' })
  const after = autoReview({ case: dir })
  assert.equal(after.items.filter((x) => x.name === '事实未复核').length, 0, '核过就不该再被攻击')
})
