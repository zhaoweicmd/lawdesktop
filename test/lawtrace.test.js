// 法条溯源：结论引用的条号是否真的在台账里、有没有原文、来源够不够权威。
// 这是「结论 → 验收」之间必须过的一关，机器能判的部分必须判准。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { casePaths } from '../lib/core/store.js'
import { addFact } from '../lib/core/fact.js'
import { addFinding } from '../lib/core/finding.js'
import { addLaw } from '../lib/core/law.js'
import { lawTrace } from '../lib/core/lawtrace.js'
import { nextStep } from '../lib/core/next.js'

function mkCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-lt-'))
  const dir = path.join(root, '案')
  const src = path.join(root, '卷宗')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  newCase({ dir, title: '法条溯源测试案', materialsDirs: [src] })
  addFact({ case: dir, text: '被告收取货款五十万元后未交付货物', source: path.join(src, 'a.pdf'), locator: 'P1' })
  return dir
}

function mkLaw(dir, over = {}) {
  const r = addLaw({
    case: dir,
    title: '中华人民共和国刑法',
    article: '第二百二十四条',
    quote: '有下列情形之一，以非法占有为目的，在签订、履行合同过程中，骗取对方当事人财物，数额较大的……',
    source: 'pkulaw',
    url: 'https://example.test/law/224',
    ...over,
  })
  // addLaw 返回 { ok, law, summary }
  return r.law
}

test('结论引的法条在台账里、有原文、来源权威 → 通过', () => {
  const dir = mkCase()
  const l = mkLaw(dir)
  addFinding({ case: dir, text: '被告以非法占有为目的骗取货款五十万元，构成合同诈骗', factRefs: ['F1'], law: l.id, lawSource: { locator: '北大法宝｜刑法｜第224条' } })
  const r = lawTrace({ case: dir })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].level, 'pass')
  assert.match(r.summary, /全部可核/)
})

test('引用了台账里不存在的条号 → 重大风险（凭空/笔误）', () => {
  const dir = mkCase()
  addFinding({ case: dir, text: '被告行为构成合同诈骗，依据相关法条应当追究刑事责任', factRefs: ['F1'], law: 'L99', lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, '重大风险')
  assert.equal(r.items[0].status, 'missing-law')
  assert.match(r.items[0].problems[0], /台账里没有这一条/)
  assert.equal(r.stats.missing, 1)
})

test('结论没标法条 → 建议修改（交付时核不到条文）', () => {
  const dir = mkCase()
  addFinding({ case: dir, text: '被告行为构成合同诈骗应当追究刑事责任', factRefs: ['F1'] })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, '建议修改')
  assert.equal(r.items[0].status, 'no-law')
})

test('法条只有条号、没有条文原文 → 报「无法核对」', () => {
  const dir = mkCase()
  const l = mkLaw(dir, { quote: '' })
  addFinding({ case: dir, text: '被告构成合同诈骗应追究刑事责任', factRefs: ['F1'], law: l.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.ok(r.items[0].problems.some((p) => /没有条文原文/.test(p)))
  assert.equal(r.stats.noQuote, 1)
})

test('手工录入（source=manual）→ 提示来源不够权威', () => {
  const dir = mkCase()
  const l = mkLaw(dir, { source: 'manual', url: 'https://example.test/x' })
  addFinding({ case: dir, text: '被告构成合同诈骗应追究刑事责任', factRefs: ['F1'], law: l.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.ok(r.items[0].problems.some((p) => /未经权威库核对/.test(p)))
  assert.equal(r.stats.weakSource, 1)
})

test('已废止的法条 → 重大风险', () => {
  const dir = mkCase()
  const l = mkLaw(dir, { repealedAt: '2020-01-01' })
  addFinding({ case: dir, text: '被告构成合同诈骗应追究刑事责任', factRefs: ['F1'], law: l.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, '重大风险')
  assert.ok(r.items[0].problems.some((p) => /废止/.test(p)))
})

test('条号格式不同不算引错：正文「第二百二十四条」vs 台账「第2项（刑法第二百二十四条…）」', () => {
  const dir = mkCase()
  const l = mkLaw(dir, { article: '第2项（刑法第二百二十四条合同诈骗罪）' })
  addFinding({ case: dir, text: '依刑法第二百二十四条，被告构成合同诈骗罪，应追究刑事责任', factRefs: ['F1'], law: l.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, 'pass', JSON.stringify(r.items[0].problems))
})

test('一条结论引用多个条号：只要命中其中一条就不算引错', () => {
  const dir = mkCase()
  const l = mkLaw(dir)
  addFinding({
    case: dir,
    text: '依刑法第二百三十一条、第三十一条，对单位判处罚金；对直接责任人按第二百二十四条处罚',
    factRefs: ['F1'],
    law: l.id,
    lawSource: { locator: 'x' },
  })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, 'pass', JSON.stringify(r.items[0].problems))
})

test('正文条号与所引法条完全对不上 → 报出来', () => {
  const dir = mkCase()
  const l = mkLaw(dir)
  addFinding({ case: dir, text: '依刑法第二百六十六条，被告构成诈骗罪，应当追究刑事责任', factRefs: ['F1'], law: l.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.equal(r.items[0].level, '重大风险')
  assert.ok(r.items[0].problems.some((p) => /都不一致/.test(p)))
})

test('台账里有但没被引用的法条单独列出（不是错，只是提示）', () => {
  const dir = mkCase()
  const a = mkLaw(dir)
  const b = mkLaw(dir, { article: '第二百三十一条' })
  addFinding({ case: dir, text: '依刑法第二百二十四条被告构成合同诈骗', factRefs: ['F1'], law: a.id, lawSource: { locator: 'x' } })
  const r = lawTrace({ case: dir })
  assert.deepEqual(r.unused.map((x) => x.id), [b.id])
})

test('法条引证有问题时，「下一步」会把它列进待办', () => {
  const dir = mkCase()
  addFinding({ case: dir, text: '被告行为构成合同诈骗应当追究刑事责任', factRefs: ['F1'], law: 'L77', lawSource: { locator: 'x' } })
  const st = nextStep({ case: dir })
  const all = [st.next, ...(st.alsoTodo || [])].filter(Boolean)
  const hit = all.find((x) => x.tool === 'lc_law_trace')
  assert.ok(hit, '法条有问题时必须出现在待办里：' + JSON.stringify(all.map((x) => x.tool)))
})

test('没有结论时给「无法溯源」而不是空表', () => {
  const dir = mkCase()
  const r = lawTrace({ case: dir })
  assert.equal(r.items.length, 0)
  assert.match(r.summary, /还没有结论/)
})
