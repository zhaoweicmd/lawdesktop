// 工序表的回归测试：重点验证「拒收」而非「接收」

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths, readJson } from '../lib/core/store.js'
import { planProcesses, updateProcess, listProcesses } from '../lib/core/proc.js'
import { verifyCase } from '../lib/core/verify.js'

function tmpCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-proc-'))
  newCase({ dir, title: '工序测试案件' })
  return dir
}

const demo = [
  { name: '梳理合同', acceptance: '列出全部条款并标注争议条款', outputs: '条款清单.md' },
  { name: '计算损失', acceptance: '金额可复算，公式留痕', dependsOn: ['梳理合同'], outputs: '计算表.xlsx' },
  { name: '出代理意见', acceptance: '五道验收全过', dependsOn: ['计算损失'] },
]

test('正常拆解：编号 P1..Pn 且写入进度台账', () => {
  const dir = tmpCase()
  const r = planProcesses({ case: dir, processes: demo })
  assert.equal(r.count, 3)
  assert.deepEqual(r.proc.map((p) => p.id), ['P1', 'P2', 'P3'])
  assert.deepEqual(r.proc[1].dependsOn, ['P1'])
  const md = fs.readFileSync(casePaths(dir).progress, 'utf8')
  assert.ok(md.includes('| ☐ P1 | 梳理合同 |'), '进度台账要有工序行')
  assert.ok(md.includes('0/3') || md.includes('工序进度：0/3'))
})

test('缺验收标准必须拒收', () => {
  const dir = tmpCase()
  assert.throws(
    () => planProcesses({ case: dir, processes: [{ name: '随便看看' }] }),
    /没有验收标准/
  )
})

test('工序名重复要拒收', () => {
  const dir = tmpCase()
  assert.throws(
    () => planProcesses({ case: dir, processes: [{ name: 'A', acceptance: 'x' }, { name: 'A', acceptance: 'y' }] }),
    /工序名重复/
  )
})

test('依赖不存在的工序要拒收', () => {
  const dir = tmpCase()
  assert.throws(
    () => planProcesses({ case: dir, processes: [{ name: 'A', acceptance: 'x', dependsOn: ['不存在'] }] }),
    /依赖了不存在的工序/
  )
})

test('依赖成环要拒收', () => {
  const dir = tmpCase()
  assert.throws(
    () =>
      planProcesses({
        case: dir,
        processes: [
          { name: 'A', acceptance: 'x', dependsOn: ['C'] },
          { name: 'B', acceptance: 'y', dependsOn: ['A'] },
          { name: 'C', acceptance: 'z', dependsOn: ['B'] },
        ],
      }),
    /依赖成环/
  )
})

test('依赖未完成时不能标 done（跳步会漏做）', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  assert.throws(() => updateProcess({ case: dir, id: 'P2', status: 'done' }), /依赖未完成/)
})

test('按依赖顺序推进可以，且进度台账同步', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  updateProcess({ case: dir, id: 'P1', status: 'doing' })
  updateProcess({ case: dir, id: 'P1', status: 'done' })
  const r = updateProcess({ case: dir, id: 'P2', status: 'done' })
  assert.equal(r.progress.done, 2)
  const md = fs.readFileSync(casePaths(dir).progress, 'utf8')
  assert.ok(md.includes('| ☑ P2 |'), '已完成工序要打勾')
})

test('已验收的工序不能退回', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  updateProcess({ case: dir, id: 'P1', status: 'done' })
  assert.throws(() => updateProcess({ case: dir, id: 'P1', status: 'todo' }), /不能退回/)
})

test('有工序时默认拒绝覆盖，replace=true 才行', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  assert.throws(() => planProcesses({ case: dir, processes: demo }), /replace=true/)
  const r = planProcesses({ case: dir, processes: demo, replace: true })
  assert.equal(r.count, 3)
})

test('已有 done 工序时覆盖需 force', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  updateProcess({ case: dir, id: 'P1', status: 'done' })
  assert.throws(() => planProcesses({ case: dir, processes: demo, replace: true }), /force=true/)
})

test('lc_proc_list 给出「可开工」工序', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  const l1 = listProcesses({ case: dir })
  assert.deepEqual(l1.ready.map((x) => x.id), ['P1'], '只有 P1 可开工')
  updateProcess({ case: dir, id: 'P1', status: 'done' })
  const l2 = listProcesses({ case: dir })
  assert.deepEqual(l2.ready.map((x) => x.id), ['P2'])
})

test('工序没走完时，逻辑道会拦住结论', () => {
  const dir = tmpCase()
  planProcesses({ case: dir, processes: demo })
  const p = casePaths(dir)
  fs.appendFileSync(
    p.facts,
    JSON.stringify({ id: 'F1', text: '合同于2024年3月签订', source: { file: 'a.pdf', locator: 'p.1' }, verified: 'ok' }) + '\n'
  )
  fs.appendFileSync(p.findings, JSON.stringify({ id: 'C1', text: '被告应付款', factRefs: ['F1'] }) + '\n')
  const r = verifyCase({ case: dir })
  const logic = r.checks.find((c) => c.name === 'logic')
  assert.equal(logic.status, 'fail')
  assert.ok(r.mustFix.some((m) => /P1/.test(m.msg)), '要点名具体哪几道工序没完成')
})

test('坏 case 目录要明确报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-proc-neg-'))
  assert.throws(() => planProcesses({ case: dir, processes: demo }), /不是 LawCase 案件/)
})
