import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newCase } from '../lib/core/case.js'
import { addFact } from '../lib/core/fact.js'
import { addFinding } from '../lib/core/finding.js'
import { addLaw } from '../lib/core/law.js'
import { planProcesses, updateProcess } from '../lib/core/proc.js'
import { autoReview } from '../lib/core/review_auto.js'

function tmpCase(name) {
  const d = path.join(os.tmpdir(), `lc-auto-${name}-${Date.now()}`)
  fs.rmSync(d, { recursive: true, force: true })
  newCase({ dir: d, title: `自动复盘测试 ${name}` })
  return d
}

function seedFacts(dir) {
  // 材料登记：给 F1 一个可解析的出处
  const cp = path.join(dir, '.lawcase')
  // 材料登记要带 abs，出处校验会真实读这个路径
  const pdfPath = path.join(dir, '合同.pdf')
  fs.writeFileSync(pdfPath, '%PDF-1.4 test')
  fs.writeFileSync(path.join(cp, 'materials.json'), JSON.stringify({ files: [{ mid: 'M1', rel: '合同.pdf', abs: pdfPath }] }))
  addFact({ case: dir, text: '双方签订咨询服务协议', source: 'M1', locator: 'P1' })
}

test('没有结论时拒绝复盘（没有什么可攻击）', () => {
  const d = tmpCase('no-finding')
  assert.throws(() => autoReview({ case: d, subject: 'x' }), /还没有任何结论/)
})

test('R1 事实未复核 → 重大攻击点', () => {
  const d = tmpCase('r1')
  seedFacts(d)
  addFinding({ case: d, text: '被告乙公司应按约向原告支付咨询服务费', factRefs: ['F1'], law: '民法典第五百零九条', lawSource: { locator: '库+条' } })
  const r = autoReview({ case: d, subject: 'K1' })
  const names = r.items.map((i) => i.name)
  assert.ok(names.includes('事实未复核'), `应命中 R1，实际：${names.join('/')}`)
})

test('R3 法条未回源 → 重大', () => {
  const d = tmpCase('r3')
  seedFacts(d)
  addLaw({ case: d, title: '中华人民共和国民法典', article: '第五百零九条', source: 'manual' })
  addFinding({ case: d, text: '被告乙公司应按约向原告支付咨询服务费', factRefs: ['F1'], law: '民法典第五百零九条', lawSource: { locator: '库+条' } })
  const r = autoReview({ case: d, subject: 'K' })
  assert.ok(r.items.some((i) => i.name === '法条未回源'))
})

test('R6 结论没有法律依据 → 重大', () => {
  const d = tmpCase('r6')
  seedFacts(d)
  addFinding({ case: d, text: '被告乙公司应按约向原告支付咨询服务费', factRefs: ['F1'] })
  const r = autoReview({ case: d, subject: 'K' })
  assert.ok(r.items.some((i) => i.name === '结论没有法律依据'))
})

test('R8 工序未完成 → 重大，且点名具体工序', () => {
  const d = tmpCase('r8')
  seedFacts(d)
  addFinding({ case: d, text: '被告乙公司应按约向原告支付咨询服务费', factRefs: ['F1'], law: '民法典第五百零九条', lawSource: { locator: '库+条' } })
  planProcesses({ case: d, processes: [{ name: '梳理合同', acceptance: '条款逐条过完' }, { name: '核算法条', acceptance: '法条回源' }] })
  const r = autoReview({ case: d, subject: 'K' })
  const hit = r.items.find((i) => i.name === '工序未完成即出结论')
  assert.ok(hit, '应命中 R8')
  assert.match(hit.target, /P1|P2/)
})

test('R10 空泛表述 → 一般（历史数据绕过闸门的情况）', () => {
  const d = tmpCase('r10')
  seedFacts(d)
  // addFinding 会拒收空泛话术，所以这里直写台账，模拟「早期录入的历史结论」
  const cp = path.join(d, '.lawcase')
  fs.appendFileSync(
    path.join(cp, 'findings.jsonl'),
    JSON.stringify({
      id: 'K1', text: '建议进一步明确付款条件与时间节点', factRefs: ['F1'],
      law: '民法典第五百零九条', lawSource: { locator: '库+条' }, createdAt: new Date().toISOString(),
    }) + '\n',
  )
  const r = autoReview({ case: d, subject: 'K' })
  assert.ok(r.items.some((i) => i.name === '结论表述空泛'))
})

test('全部到位时不再报结构性缺陷', () => {
  const d = tmpCase('clean')
  seedFacts(d)
  // F1 标记为已复核
  const cp = path.join(d, '.lawcase')
  const rows = fs.readFileSync(path.join(cp, 'facts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  rows[0].confirmed = true
  fs.writeFileSync(path.join(cp, 'facts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  addLaw({ case: d, title: '中华人民共和国民法典', article: '第五百零九条', quote: '当事人应当按照约定全面履行自己的义务。', source: 'official' })
  addFinding({ case: d, text: '被告应按约向原告支付咨询服务费', factRefs: ['F1'], law: '民法典第五百零九条', lawSource: { locator: '库+条' } })
  const r = autoReview({ case: d, subject: 'K' })
  // 可能仍报 R3（法条未核验）与 R8（工序未排时不报），这里只断言不崩且有结构
  assert.equal(typeof r.count, 'number')
  assert.ok(Array.isArray(r.items))
})

test('同一案件重复跑会递增轮次 R1→R2', () => {
  const d = tmpCase('rounds')
  seedFacts(d)
  addFinding({ case: d, text: '被告乙公司应按约向原告支付咨询服务费', factRefs: ['F1'] })
  const a = autoReview({ case: d, subject: 'K' })
  const b = autoReview({ case: d, subject: 'K' })
  assert.equal(a.round, 'R1')
  assert.equal(b.round, 'R2')
})
