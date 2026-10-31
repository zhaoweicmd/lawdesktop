// 同一个数字不能在界面上出现三种答案。
// 现场：左栏「事实 190」、右侧「事实 81 条：已核 0」、顶部「核对 81/153」同时为真——
// 三个口径各算各的，用户没法判断该信哪个。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase, openCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact, amendFact, listFacts } from '../lib/core/fact.js'
import { checkItem } from '../lib/core/checkoff.js'
import { nextStep } from '../lib/core/next.js'

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-cnt-'))
  const dir = path.join(root, '案')
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  newCase({ dir, title: '口径一致性', materialsDirs: [src] })
  scanMaterials({ case: dir, source: src })
  addFact({ case: dir, text: '被告收取货款五十万元后未交付货物', source: path.join(src, 'a.pdf'), locator: 'P1' })
  addFact({ case: dir, text: '被告逾期九十日未履行交付义务', source: path.join(src, 'a.pdf'), locator: 'P2' })
  return { root, dir }
}

test('事实数：openCase / listFacts / 核对台账三处一致', () => {
  const { root, dir } = mk()
  const oc = openCase({ case: dir })
  const lf = listFacts({ case: dir })
  const st = nextStep({ case: dir })
  assert.equal(oc.facts.total, 2)
  assert.equal(lf.total, 2)
  assert.equal(st.state.facts, 2)
  assert.equal(st.state.factCheckTotal, 2)
  fs.rmSync(root, { recursive: true, force: true })
})

test('修正记录不重复计数（amend 是覆盖，不是新增）', () => {
  const { root, dir } = mk()
  amendFact({ case: dir, id: 'F1', locator: 'P9', reason: '页码写错' })
  assert.equal(openCase({ case: dir }).facts.total, 2, 'openCase 不能把修正算成新事实')
  assert.equal(listFacts({ case: dir }).total, 2)
  assert.equal(nextStep({ case: dir }).state.facts, 2)
  fs.rmSync(root, { recursive: true, force: true })
})

test('已核数：openCase / listFacts / nextStep 都用 checkoff', () => {
  const { root, dir } = mk()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '测试' })
  assert.equal(openCase({ case: dir }).facts.ok, 1)
  assert.equal(listFacts({ case: dir }).verified, 1)
  assert.equal(nextStep({ case: dir }).state.factChecked, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('全核完后 listFacts 不再说「待核」', () => {
  const { root, dir } = mk()
  checkItem({ case: dir, kind: 'fact', id: 'F1', result: 'ok', by: '测试' })
  checkItem({ case: dir, kind: 'fact', id: 'F2', result: 'ok', by: '测试' })
  const lf = listFacts({ case: dir })
  assert.equal(lf.pending, 0)
  assert.match(lf.summary, /已核 2，待核 0/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('有结论且有材料时，nextStep 不会说「走到头了」', () => {
  const { root, dir } = mk()
  // 有材料 1 份未核对 → 必须给出待办
  const st = nextStep({ case: dir })
  assert.ok(st.next, '有事实但没结论/没核对，不该返回空待办：' + st.summary)
  fs.rmSync(root, { recursive: true, force: true })
})
