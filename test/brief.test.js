// 开场简报：一句话回答「到哪了 / 卡在哪 / 谁刚动过」。
//
// 这组测试盯的是三件容易退化的东西：
//   1. 顶栏那行不能变长（它要被一眼扫完，不能长成第二份 JSON）
//   2. 「上次动作」要跳过硬性噪音（挂载/重载不算人的动作）
//   3. 卡点判定要按风险排序：核后又被改 > 未核 > 没解析

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { scanMaterials } from '../lib/core/material.js'
import { addFact, amendFact } from '../lib/core/fact.js'
import { checkItem } from '../lib/core/checkoff.js'
import { caseBrief, lastAction, relDay, shortTime } from '../lib/core/brief.js'
import { listParsed } from '../lib/core/parse.js'

/**
 * 让「没解析」这个更上游的卡点先消失。
 * 不真跑解析（假 PDF 会让 pdftotext 直接抛错并留下未处理的异步拒绝），
 * 而是照缓存文件的形状写占位：简报只数 cache/parse 里的 json 个数。
 */
function parseAllForTest(dir) {
  const cache = path.join(dir, '.lawcase', 'cache', 'parse')
  fs.mkdirSync(cache, { recursive: true })
  const mats = JSON.parse(fs.readFileSync(path.join(dir, '.lawcase', 'materials.json'), 'utf8'))
  for (const f of mats.files || []) {
    fs.writeFileSync(path.join(cache, `${f.mid}.json`), JSON.stringify({ mid: f.mid, units: [] }))
  }
  assert.ok(listParsed(dir).length > 0)
}
import { writeAudit } from '../lib/core/audit.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-brief-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  fs.writeFileSync(path.join(src, 'b.pdf'), 'y')
  const A = path.join(root, '甲案')
  newCase({ dir: A, title: '甲案', materialsDirs: [src] })
  scanMaterials({ case: A, source: src })
  return { root, src, A }
}

test('简短的对象简报：四行，且每行都以【】开头（能直接贴进对话）', () => {
  const { A } = setup()
  const r = caseBrief({ case: A })
  const lines = r.block.split('\n')
  assert.equal(lines.length, 4)
  for (const l of lines) assert.match(l, /^【.+】/, `简报行格式跑偏：${l}`)
})

test('顶栏那行不超过 60 字（超过就不是「一眼扫完」了）', () => {
  const { A } = setup()
  addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' })
  const r = caseBrief({ case: A })
  assert.ok(r.line.length <= 60, `顶栏一行已经 ${r.line.length} 字：${r.line}`)
})

test('没有业务动作时给「暂无」，不是空白（空行会被当成渲染失败）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-brief-quiet-'))
  const A = path.join(root, '静默案')
  // 不扫材料：这份案子除了 case.json 之外没有任何动作，才能验证「暂无」分支
  newCase({ dir: A, title: '静默案' })
  const r = caseBrief({ case: A })
  assert.match(r.block, /【上次动作】暂无业务操作记录/)
  assert.equal(r.last, null)
})

test('上次动作跳过硬性噪音：挂载/重载不算人干的活', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-brief-noise-'))
  const A = path.join(root, '静默案')
  newCase({ dir: A, title: '静默案' })
  writeAudit({ pkgRoot: root, record: { op: 'client-mount', phase: 'mount' }, caseDir: null })
  writeAudit({ pkgRoot: root, record: { op: 'plugin-ready' }, caseDir: null })
  const last = lastAction(A, { pkgRoot: root })
  assert.equal(last, null, '把挂载日志当「上次动作」⇒ 顶栏永远显示「今天 前端加载」')
})

test('上次动作认得出是哪个案：别的案的动作不能算到这个案头上', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-brief-swap-'))
  const A = path.join(root, '甲案')
  const B = path.join(root, '乙案')
  newCase({ dir: A, title: '甲案' })
  newCase({ dir: B, title: '乙案' })
  writeAudit({ pkgRoot: root, record: { op: 'fact-add', id: 'F9' }, caseDir: B })
  const last = lastAction(A, { pkgRoot: root })
  assert.equal(last, null, '串案 ⇒ 顶栏会把别的案子的动作显示成本案的上次动作')
})

test('审计缺失时回退到案件自己的 log.jsonl（老案件也能显示）', () => {
  const { A } = setup()
  // 没有 pkgRoot：强制走案件日志
  const last = lastAction(A, {})
  assert.ok(last)
  assert.equal(last.source, 'case-log')
  assert.equal(last.op, 'material-scan')
})

test('卡点排序：核后又被改 > 未核（材料都解析完的前提下）', () => {
  const { A } = setup()
  parseAllForTest(A)
  const f = addFact({ case: A, text: '合同签订于 2023 年 5 月', source: 'M1', locator: 'P1' }).fact
  checkItem({ case: A, kind: 'fact', id: f.id, result: 'ok', by: '赵律师' })
  // 此时：大量未核 + 0 条核对后被改
  let r = caseBrief({ case: A })
  assert.match(r.blocker.text, /未核对/)

  amendFact({ case: A, id: f.id, locator: 'P2', reason: '定位写错' })

  r = caseBrief({ case: A })
  assert.match(r.blocker.text, /核对后又被改过/, '有「核对后被改」却先报「未核对」⇒ 把最危险的那类排在了后面')
})

test('传了 next 就以 next 的卡点为准（唯一权威，不各算一遍）', () => {
  const { A } = setup()
  parseAllForTest(A)
  const next = { next: { stuck: '还有 3 道工序待做', tool: 'lc_proc_update', priority: 2 } }
  const r = caseBrief({ case: A, next })
  assert.equal(r.blocker.text, '还有 3 道工序待做')
  assert.equal(r.blocker.tool, 'lc_proc_update')
})

test('材料没解析完会报出来，且给出对应工具', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-brief-parse-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  fs.writeFileSync(path.join(src, 'b.pdf'), 'y')
  const B = path.join(root, '丙案')
  newCase({ dir: B, title: '丙案', materialsDirs: [src] })
  scanMaterials({ case: B, source: src })
  const r = caseBrief({ case: B })
  assert.match(r.blocker.text, /没解析/)
  assert.equal(r.blocker.tool, 'lc_material_parse_all')
})

test('三段色出现在简报里，且绿+黄+灰 = 总数', () => {
  const { A } = setup()
  const r = caseBrief({ case: A })
  assert.match(r.block, /【核对】绿 \d+｜黄 \d+｜灰 \d+（共 \d+）/)
  assert.equal(r.tri.verified + r.tri.stale + r.tri.unverified, r.tri.total)
})

test('不是案件目录要明确报错，不能让简报静默变成空', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-empty-'))
  assert.throws(() => caseBrief({ case: empty }), /不是 LawCase 案件/)
})

test('时间格式：今天/昨天/相对天数，跨月不能变成「0 天前」', () => {
  const now = new Date('2026-11-01T10:00:00')
  assert.equal(relDay('2026-11-01T09:00:00', now), '今天')
  assert.equal(relDay('2026-10-31T23:00:00', now), '昨天')
  assert.equal(relDay('2026-10-28T09:00:00', now), '4 天前')
  assert.equal(shortTime('2026-10-31T09:05:00'), '10-31 09:05')
  assert.equal(shortTime('不是时间'), '')
})
