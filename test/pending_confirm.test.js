// 「待你确认」这两条提醒怎么才算确认：做完对应动作就自动消失，不是让用户点同意。
// 之前只有「工序拆解」会被清，材料目录那条永远挂着（用户看到 2 条，做完还是 2 条）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase, openCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { scanMaterials } from '../lib/core/material.js'
import { planProcesses } from '../lib/core/proc.js'

function mkCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-confirm-'))
  const dir = path.join(root, '案')
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  newCase({ dir, title: '待确认测试案', materialsDirs: [src] })
  return { dir, src }
}

const pend = (dir) => JSON.parse(fs.readFileSync(casePaths(dir).caseJson, 'utf8')).pendingConfirm || []

test('建案时两条提醒都在', () => {
  const { dir } = mkCase()
  const list = pend(dir)
  assert.equal(list.length, 2)
  assert.ok(list.some((q) => /工序拆解/.test(q)))
  assert.ok(list.some((q) => /材料目录清单/.test(q)))
})

test('扫到材料后，「确认材料目录清单」这条自动消失', () => {
  const { dir, src } = mkCase()
  fs.writeFileSync(path.join(src, '合同.pdf'), 'x')
  scanMaterials({ case: dir, source: src })
  const list = pend(dir)
  assert.ok(!list.some((q) => /材料目录/.test(q)), JSON.stringify(list))
  assert.ok(list.some((q) => /工序拆解/.test(q)), '另一条不该被连带清掉')
})

test('扫到 0 个文件时保留提醒（说明目录选错了，还没真正确认）', () => {
  const { dir, src } = mkCase()
  scanMaterials({ case: dir, source: src })
  assert.ok(pend(dir).some((q) => /材料目录/.test(q)))
})

test('提交工序表后，「确认工序拆解」这条自动消失', () => {
  const { dir } = mkCase()
  planProcesses({
    case: dir,
    processes: [{ name: '梳理材料', acceptance: '材料清单出具且无遗漏' }, { name: '出具意见', acceptance: '意见表可交付', dependsOn: ['梳理材料'] }],
  })
  const list = pend(dir)
  assert.ok(!list.some((q) => /工序拆解/.test(q)))
  assert.ok(list.some((q) => /材料目录/.test(q)))
})

test('两步都做完：提醒清空，概览不再显示待确认', () => {
  const { dir, src } = mkCase()
  fs.writeFileSync(path.join(src, '材料.txt'), 'x')
  scanMaterials({ case: dir, source: src })
  planProcesses({ case: dir, processes: [{ name: '开工', acceptance: '台账可查' }] })
  assert.deepEqual(pend(dir), [])
  assert.equal(openCase({ case: dir }).pendingConfirm.length, 0)
})
