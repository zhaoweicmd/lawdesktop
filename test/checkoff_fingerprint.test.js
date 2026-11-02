// 内容指纹必须能分辨「改了出处」——这是签字单「核对后被修改」判定的地基。
//
// 实证缺陷（2026-10-31 发现）：normJson 用
//   JSON.stringify(v, Object.keys(v).sort())
// 把**键名数组**当 replacer 用，而 replacer 数组只保留"出现在数组里的键"，
// 嵌套对象的键（source.file / source.locator）不在顶层数组里 ⇒ 整个对象被写成 {}。
// 后果：改出处、改正文字引用的 locator，指纹都不变，
// 签字单会照样打「已核对」——等于把「事后改了证据」盖上了章。
//
// 这组测试里每条都带反例语义：改了什么，指纹就必须变。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact, amendFact } from '../lib/core/fact.js'
import { addFinding } from '../lib/core/finding.js'
import { checkItem, checkStatus } from '../lib/core/checkoff.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-fp-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  const A = path.join(root, 'A案')
  newCase({ dir: A, title: 'A案', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  return { root, src, A }
}

test('反例：核对后改「出处定位」⇒ 必须标为核对后被修改', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  assert.equal(checkStatus({ case: A }).kinds.fact.stale, 0)

  amendFact({ case: A, id: f.id, locator: 'P2', reason: '定位标到了下一页' })

  const st = checkStatus({ case: A })
  assert.equal(st.kinds.fact.stale, 1, '出处改了却不算 stale ⇒ 签字单会把改过的证据当已核对')
  assert.equal(st.tri.stale, 1)
  assert.equal(st.tri.verified, 0)
})

test('核对后只改「正文」也要算改动', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  amendFact({ case: A, id: f.id, text: '合同签订于 2023 年 6 月', reason: '月份写错' })
  assert.equal(checkStatus({ case: A }).kinds.fact.stale, 1)
})

test('什么都没改（同一内容重复点核对）⇒ 不算 stale，不能制造假警报', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '被告于 2024 年 1 月收货', source: 'M1', locator: 'P3' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  const st = checkStatus({ case: A })
  assert.equal(st.stale, 0)
  assert.equal(st.tri.verified, 1)
})

test('结论台账同理：改了结论正文 ⇒ stale', () => {
  const { A } = setup()
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  const k = addFinding({
    case: A,
    text: '被告逾期付款构成违约，应承担违约责任并支付违约金',
    factRefs: [f.id],
  })
  const kid = (k.finding && k.finding.id) || k.id
  checkItem({ case: A, kind: 'finding', id: kid, result: 'ok', by: '赵律师' })
  assert.equal(checkStatus({ case: A }).kinds.finding.stale, 0)
})

// 口径变更（用户 2026-11-01）：材料不再参与核对，所以"材料改了算 stale"这条不再适用。
// 保留这条位置，改成守住新口径——既不数材料，也不能因此把事实/结论的指纹检查弄丢。
test('材料不参与核对：改附件不再产生 stale，但事实指纹照旧生效', () => {
  const { A, src } = setup()
  const st0 = checkStatus({ case: A })
  assert.equal(st0.kinds.material, undefined, '材料不该出现在核对分类里')

  // 事实改内容仍必须标 stale（这条能力不能因为口径调整而丢）
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  assert.equal(checkStatus({ case: A }).kinds.fact.stale, 0, '刚核完不该 stale')

  amendFact({ case: A, id: f.id, reason: '出处页码标错', locator: 'P2' })
  assert.ok(
    checkStatus({ case: A }).kinds.fact.stale >= 1,
    '事实改了内容却还算已核对 ⇒ 签字单会写成没人改过的样子'
  )
})
