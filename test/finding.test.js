// 结论台账的回归测试：重点验证四类拒收 + 追溯状态

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { addFact } from '../lib/core/fact.js'
import { addFinding, listFindings } from '../lib/core/finding.js'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-finding-'))
  newCase({ dir, title: '结论测试案件' })
  // addFact 要求出处文件真实存在，测试里造占位文件
  fs.writeFileSync(path.join(dir, '服务合同.pdf'), 'dummy')
  fs.writeFileSync(path.join(dir, '对账单.xlsx'), 'dummy')
  const f1 = addFact({ case: dir, text: '双方于2024年3月签订《服务合同》，约定服务费100万元', source: '服务合同.pdf', locator: 'P1 第2条' })
  const f2 = addFact({ case: dir, text: '被告自2024年6月起未再支付服务费，累计欠付40万元', source: '对账单.xlsx', locator: '应付账款行' })
  return { dir, f1: f1.fact, f2: f2.fact }
}

const GOOD = '被告未按《服务合同》第2条支付服务费，已构成违约，应支付欠付服务费40万元'
const SRC = { locator: '国家法律法规数据库｜民法典｜第577条' }

test('正常登记：编号 K1、写入台账、conclusion.md 出现该行', () => {
  const { dir, f1, f2 } = fixture()
  const r = addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id], law: '民法典第五百七十七条', lawSource: SRC })
  assert.equal(r.id, 'K1')
  assert.match(r.summary, /引用 2 条事实/)
  const md = fs.readFileSync(casePaths(dir).conclusion, 'utf8')
  assert.match(md, /K1/)
  assert.match(md, /40万元/)
  const list = listFindings({ case: dir })
  assert.equal(list.count, 1)
  assert.equal(list.broken, 0)
  assert.equal(list.items[0].trace, 'ok')
})

test('拒收：不引用任何事实', () => {
  const { dir } = fixture()
  assert.throws(() => addFinding({ case: dir, text: GOOD, factRefs: [] }), /未引用任何事实编号/)
})

test('拒收：引用不存在的事实编号', () => {
  const { dir, f1 } = fixture()
  assert.throws(
    () => addFinding({ case: dir, text: GOOD, factRefs: [f1.id, 'F99'] }),
    /引用了不存在的事实 F99/,
  )
})

test('拒收：空泛话术', () => {
  const { dir, f1 } = fixture()
  assert.throws(
    () => addFinding({ case: dir, text: '建议进一步明确双方的权利义务关系并完善相关条款', factRefs: [f1.id] }),
    /空泛话术/,
  )
  assert.throws(
    () => addFinding({ case: dir, text: '该条款尚需明确具体的履行期限和违约责任承担方式', factRefs: [f1.id] }),
    /空泛话术/,
  )
})

test('拒收：引用法条但无回源定位', () => {
  const { dir, f1, f2 } = fixture()
  assert.throws(
    () => addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id], law: '民法典第五百七十七条' }),
    /没有回源定位/,
  )
  assert.throws(
    () => addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id], law: '民法典第五百七十七条', lawSource: {} }),
    /没有回源定位/,
  )
})

test('拒收：结论过短', () => {
  const { dir, f1 } = fixture()
  assert.throws(() => addFinding({ case: dir, text: '被告违约', factRefs: [f1.id] }), /结论过短/)
})

test('允许无法条的结论（law 留空）', () => {
  const { dir, f1, f2 } = fixture()
  const r = addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id] })
  assert.equal(r.law, undefined)
  const list = listFindings({ case: dir })
  assert.equal(list.items[0].trace, 'ok')
})

test('追溯：事实台账被删后，结论标记 broken', () => {
  const { dir, f1, f2 } = fixture()
  addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id] })
  const cp = casePaths(dir)
  const kept = fs.readFileSync(cp.facts, 'utf8').split('\n').filter((l) => l && !l.includes(f2.id))
  fs.writeFileSync(cp.facts, kept.join('\n') + '\n')
  const list = listFindings({ case: dir })
  assert.equal(list.broken, 1)
  assert.equal(list.items[0].trace, 'broken')
  assert.deepEqual(list.items[0].brokenRefs, [f2.id])
})

test('多条结论按序编号 K1、K2', () => {
  const { dir, f1, f2 } = fixture()
  addFinding({ case: dir, text: GOOD, factRefs: [f1.id, f2.id] })
  const r2 = addFinding({ case: dir, text: '原告已履行全部服务义务，有权请求被告支付上述欠付款项', factRefs: [f1.id, f2.id] })
  assert.equal(r2.id, 'K2')
  assert.equal(listFindings({ case: dir }).count, 2)
})

test('非案件目录报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-empty-'))
  assert.throws(() => addFinding({ case: empty, text: GOOD, factRefs: ['F1'] }), /不是 LawCase 案件/)
})
