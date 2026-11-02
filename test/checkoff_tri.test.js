// 核对三段色（界面 U3）：绿=核过没变 / 黄=核后又被改 / 灰=从没核过。
//
// 为什么要这组测试：stale（核对后被修改）是交付时最大的雷，但在旧进度条上
// 它和「已核」是同一个颜色 —— 等于把风险画成了正常。
// 反例必须能证明：核过一次之后再改内容，颜色必须变黄，而不是继续显示绿。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact, amendFact } from '../lib/core/fact.js'
import { checkItem, checkStatus, triState } from '../lib/core/checkoff.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-tri-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  fs.writeFileSync(path.join(src, 'b.pdf'), 'y')
  const A = path.join(root, 'A案')
  newCase({ dir: A, title: 'A案', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  return { root, src, A }
}

const tri = (dir) => checkStatus({ case: dir }).tri

test('三段色相加恒等于 total（任何情况下都不漏数）', () => {
  const { A } = setup()
  const t = tri(A)
  assert.equal(t.verified + t.stale + t.unverified, t.total)
})

test('从没核过 ⇒ 全部落灰，绿与黄都是 0', () => {
  const { A } = setup()
  addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' })
  const t = tri(A)
  assert.equal(t.verified, 0)
  assert.equal(t.stale, 0)
  assert.ok(t.unverified > 0)
})

test('核过且内容没动 ⇒ 变绿', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  const before = tri(A)
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  const after = tri(A)
  assert.equal(after.verified, before.verified + 1)
  assert.equal(after.stale, 0)
  assert.equal(after.unverified, before.unverified - 1)
})

test('反例（最关键）：核过之后再改内容 ⇒ 必须变黄，不许继续显示绿', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  assert.equal(tri(A).stale, 0)

  // 核对之后有人改了这条事实的定位
  amendFact({ case: A, id: f.id, locator: 'P2', reason: '定位标错了页' })

  const t = tri(A)
  assert.equal(t.stale, 1, '内容和核对时不一样了，却还显示绿色 ⇒ 等于把风险画成正常')
  assert.equal(t.verified, 0, '这条已经不可信，不应再计入「已核」')
})

test('结论为「需修改」也算人核过：计入绿，不计入灰', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '被告于 2024 年 1 月收货', source: 'M1', locator: 'P3' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'fix', by: '赵律师', note: '时间需核对' })
  const t = tri(A)
  assert.equal(t.stale, 0)
  assert.equal(t.verified, 1)
})

test('triState 对空值稳健（面板初次加载时拿到 null 不能崩）', () => {
  assert.deepEqual(triState(null), { verified: 0, stale: 0, unverified: 0, total: 0 })
  assert.deepEqual(triState({ total: 3, done: 1, stale: 1 }), { verified: 0, stale: 1, unverified: 2, total: 3 })
})

test('stale 不会把 verified 算成负数（重复核对同一条的病态输入）', () => {
  const t = triState({ total: 2, done: 1, stale: 5 })
  assert.equal(t.verified, 0)
  assert.equal(t.stale, 5)
})
