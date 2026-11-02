import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nextStep } from '../lib/core/next.js'
import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { planProcesses, updateProcess } from '../lib/core/proc.js'
import { addFact } from '../lib/core/fact.js'
import { addFinding } from '../lib/core/finding.js'
import { casePaths, writeJsonAtomic } from '../lib/core/store.js'

function freshCase(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-'))
  const caseDir = path.join(root, 'case')
  newCase({ dir: caseDir, title: '下一步测试案', parties: '甲；乙', ...extra })
  return caseDir
}

test('下一步：空案件首先要求给材料源', () => {
  const c = freshCase()
  const r = nextStep({ case: c })
  assert.strictEqual(r.next.tool, 'lc_material_scan')
  assert.match(r.next.stuck, /没有材料源/)
})

test('下一步：有材料但没解析时，要求先解析', () => {
  const c = freshCase()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-src-'))
  fs.writeFileSync(path.join(src, 'a.txt'), '一')
  scanMaterials({ case: c, source: src })
  const r = nextStep({ case: c })
  assert.strictEqual(r.next.tool, 'lc_material_parse_all')
})

test('下一步：材料解析完、没工序时要求拆工序', () => {
  const c = freshCase()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-src2-'))
  fs.writeFileSync(path.join(src, 'a.txt'), '正文')
  scanMaterials({ case: c, source: src })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-r2-'))
  assert.ok(root)
  // 手工放一份解析缓存，模拟已解析
  const cp = casePaths(c)
  fs.mkdirSync(path.join(cp.cache, 'parse'), { recursive: true })
  writeJsonAtomic(path.join(cp.cache, 'parse', 'M1.json'), { mid: 'M1', units: [{ n: 1, text: '正文' }] })
  const r = nextStep({ case: c })
  assert.strictEqual(r.next.tool, 'lc_proc_plan')
  assert.match(r.next.stuck, /还没有工序表/)
})

test('下一步：工序进行中时，提示推进而不是重排', () => {
  const c = freshCase()
  planProcesses({ case: c, processes: [
    { name: '读材料', acceptance: '能说出材料讲了什么' },
    { name: '写结论', acceptance: '结论有事实支撑', dependsOn: ['读材料'] },
  ] })
  updateProcess({ case: c, id: 'P1', status: 'doing' })
  const r = nextStep({ case: c })
  const hit = [r.next, ...r.alsoTodo].find((x) => x && x.tool === 'lc_proc_update')
  assert.ok(hit, '应提示推进工序')
})

test('下一步：有事实但没结论时，要求出结论并带上事实编号', () => {
  const c = freshCase()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-src3-'))
  fs.writeFileSync(path.join(src, '材料.txt'), '原告与被告于2020年签订协议。')
  scanMaterials({ case: c, source: src })
  const cp = casePaths(c)
  fs.mkdirSync(path.join(cp.cache, 'parse'), { recursive: true })
  writeJsonAtomic(path.join(cp.cache, 'parse', 'M1.json'), { mid: 'M1', units: [{ n: 1, text: '原告与被告于2020年签订协议。' }] })
  planProcesses({ case: c, processes: [{ name: '读材料', acceptance: '读完' }] })
  updateProcess({ case: c, id: 'P1', status: 'done', acceptResult: true })
  addFact({ case: c, text: '原告与被告于2020年签订协议', source: 'M1', locator: '第1段', confirmed: true })
  addFact({ case: c, text: '约定服务费按退出收入20%计', source: 'M1', locator: '第1段', confirmed: true })
  const r = nextStep({ case: c })
  const hit = [r.next, ...r.alsoTodo].find((x) => x && x.tool === 'lc_finding_add')
  assert.ok(hit, '应提示出结论')
  assert.ok(Array.isArray(hit.args.factRefs) && hit.args.factRefs.length === 2, '参数里要带事实编号')
})

test('下一步：合同案按条款线走，不按事实线', () => {
  const c = freshCase({ caseType: 'contract' })
  const r = nextStep({ case: c })
  assert.strictEqual(r.caseType, 'contract')
  assert.strictEqual(r.next.tool, 'lc_clause_index')
})

test('下一步：结论引用已作废事实时，这是最优先的卡点', () => {
  const c = freshCase()
  const cp = casePaths(c)
  // 直接铺台账：一条结论引用不存在的事实
  fs.writeFileSync(cp.facts, '')
  fs.writeFileSync(cp.findings, JSON.stringify({ id: 'K1', text: '付款条件成就', factRefs: ['F99'], lawRef: '', lawSource: null }) + '\n')
  const r = nextStep({ case: c })
  assert.ok(r.next.priority <= 1, '悬空引用必须是最高优先级（0 或 1）')
  assert.match(r.next.stuck, /引用了已作废或不存在的事实/)
})

test('下一步：没有可开工的事时说清楚，不硬凑', () => {
  const c = freshCase()
  const cp = casePaths(c)
  fs.writeFileSync(cp.facts, '')
  fs.writeFileSync(cp.findings, '')
  const r = nextStep({ case: c })
  assert.ok(r.next, '空案件也应该给出下一步')
  assert.strictEqual(typeof r.summary, 'string')
})

test('合同审核案不推送工序类下一步（否则会指向已移除的页面）', () => {
  // 用户 2026-10-27 要求合同审核去掉工序页。服务端若还推 lc_proc_plan，
  // 界面上的「下一步」按钮就无处可去——两边必须一致。
  const c = freshCase({ caseType: 'contract' })
  const r = nextStep({ case: c })
  const all = [r.next, ...(r.hints || [])].filter(Boolean)
  const tools = all.map((x) => x && x.tool).filter(Boolean)
  assert.equal(tools.filter((t) => /^lc_proc_/.test(t)).length, 0, '合同案不该出现工序工具：' + JSON.stringify(tools))
  assert.doesNotMatch(JSON.stringify(all), /拆成工序/, '不该提示拆工序')
})

test('诉讼案仍然保留工序层（不会被上一条修成全局关闭）', () => {
  const c = freshCase()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-next-src-proc-'))
  fs.writeFileSync(path.join(src, '证据.txt'), '正文内容')
  scanMaterials({ case: c, source: src })
  const cp = casePaths(c)
  fs.mkdirSync(path.join(cp.cache, 'parse'), { recursive: true })
  writeJsonAtomic(path.join(cp.cache, 'parse', 'M1.json'), { mid: 'M1', units: [{ n: 1, text: '正文' }] })

  // 关键断言：诉讼案在"材料已就绪、还没有工序表"时必须提示拆工序。
  // 这一条足以证明工序层没有被全局关掉（对比上一条：合同案不出现）。
  // 至于"有工序表后提示推进"，它会被更高优先级的 lc_fact_add 等盖住，
  // 由 next 的单条返回机制决定，不在这里硬凑。
  const r1 = nextStep({ case: c })
  assert.strictEqual(r1.next.tool, 'lc_proc_plan', '诉讼案空工序表时应提示拆工序')
  assert.match(r1.next.stuck, /工序表/)

  // 有工序表后，工序不再要求"拆"，界面也不会再提示拆工序
  planProcesses({ case: c, processes: [{ name: '整理证据', acceptance: '证据清单齐全' }] })
  const r2 = nextStep({ case: c })
  assert.doesNotMatch(JSON.stringify([r2.next, ...(r2.hints || [])]), /还没有工序表/)
})
