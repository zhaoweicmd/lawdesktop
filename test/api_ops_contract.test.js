// 界面 → 后端 的 op 契约：界面调用的每个 op，后端必须真的存在。
//
// 真机事故（2026-11-01）：界面的「批量解析」按钮调 `material.parse_all`，
// 而这个 op **从来没实现过**。用户点下去只看到：
//   「未知 op: material.parse_all（可用：…）」
// 然后卡在「材料 11 份但一份没解析」，整条流程走不动。
//
// 根因是"两边各写一半"：core 里 parseAll 早写好了，只是没暴露成接口；
// 界面那边先按名字写上了调用。这类错**不会让任何测试变红**——
// 因为测工具测的是 core，测界面测的是渲染，没人测"这两边名字对不对得上"。
// 这条测试就是补这个缺口。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const API = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'api.js'), 'utf8')

/**
 * 从 api.js 里抓出所有 op 名。
 * ⚠ 两种写法都要认：`async 'approve.step'(payload)` 与 `async verify(payload)`。
 *   只认带引号的那种会漏掉 `verify`，然后测试报一个**假 missing**
 *   （我第一版就写漏了，差点去补一个本来存在的接口）。
 */
function apiOps() {
  const out = new Set()
  for (const m of API.matchAll(/async\s+'([a-zA-Z][\w.]*)'\s*\(/g)) out.add(m[1])
  for (const m of API.matchAll(/async\s+([a-zA-Z_][\w]*)\s*\(\s*(?:payload)?\s*\)\s*\{/g)) out.add(m[1])
  return out
}

/**
 * 从 client.js 里抓出所有 call('xxx.yyy', …) / runAction(…, 'xxx.yyy', …)。
 * 只认带点的 op 名（服务名.方法），避免把 DOM 事件名之类算进来。
 */
function clientOps() {
  const out = new Set()
  for (const m of CLIENT.matchAll(/\bcall\(\s*'([a-zA-Z][\w.]+)'/g)) out.add(m[1])
  for (const m of CLIENT.matchAll(/runAction\([^,]*,\s*'([a-zA-Z][\w.]+)'/g)) out.add(m[1])
  return out
}

test('★ 界面调用的每个 API op，后端都必须存在（否则用户只会看到「未知 op」）', () => {
  const have = apiOps()
  const want = [...clientOps()]
  assert.ok(want.length > 10, `没抓到界面调用（${want.length} 个），正则可能失效了`)
  const missing = want.filter((op) => !have.has(op)).sort()
  assert.deepEqual(
    missing,
    [],
    `界面在调、后端没有这些 op：\n  ${missing.join('\n  ')}\n` +
      '这类缺口不会让别的测试变红，只会在用户点下去的时候报「未知 op」。'
  )
})

test('反例：material.parse_all 与 material.parsed 必须真实注册（这次事故的两个）', () => {
  const have = apiOps()
  assert.ok(have.has('material.parse_all'), '批量解析接口缺失：界面按钮点了必然失败')
  assert.ok(have.has('material.parsed'))
})

test('反例：批注相关 op 必须存在（2.45 加的）', () => {
  const have = apiOps()
  assert.ok(have.has('note.setApply'), '「批注 / 改正文」按钮依赖它')
  assert.ok(have.has('clause.skip'), '「不索引」按钮依赖它')
  assert.ok(have.has('clause.unindex'))
})

// ===== 审核指令必须真的进到发给模型的提示词里 =====
import { buildReviewMessage } from '../lib/core/aiprompt.js'

test('★ 用户在「审核指令」里写的话，必须逐字出现在发给模型的提示词里', () => {
  // 用户 2026-11-01：「AI 审核时我要能给出提示词；要 AI 怎么审」
  // 这条盯的是「界面让填了，但没传下去」这类静默失效。
  const cfg = { stance: 'partyA', templateId: 'purchase', instructions: '重点看付款与验收；每条都要给可直接粘回合同的替代表述' }
  const r = buildReviewMessage({
    file: 'x.docx',
    worksheet: { items: [{ clause: '第一条', text: '甲方应付款。', sentences: ['甲方应付款。'] }] },
    config: cfg,
  })
  assert.match(r.text, /重点看付款与验收/, '自定义审核指令没进提示词 ⇒ 用户白填了')
  assert.match(r.text, /每条都要给可直接粘回合同的替代表述/)
  assert.match(r.text, /站在甲方/, '立场也要进提示词')
  assert.match(r.text, /采购合同/, '类型决定必查方向，也要进')
})

test('反例：口径区块不许出现重复拼接的「立场：立场：」', () => {
  const r = buildReviewMessage({
    file: 'x.docx',
    worksheet: { items: [{ clause: '第一条', text: '甲。', sentences: [] }] },
    config: { stance: 'partyB', templateId: 'service', instructions: '只看对我方不利的' },
  })
  assert.doesNotMatch(r.text, /立场：立场：/, 'reviewBrief 是给人看的摘要，不能整个塞进提示词')
})

test('没写审核指令时给出明确缺省，而不是留空让人猜', () => {
  const r = buildReviewMessage({
    file: 'x.docx',
    worksheet: { items: [{ clause: '第一条', text: '甲。', sentences: [] }] },
    config: { stance: 'neutral', templateId: 'general', instructions: '' },
  })
  assert.match(r.text, /本人本次审核指令：/)
})

// ===== 「在 Finder 中显示交付包」 =====
test('★ deliver.open 必须存在（用户 2026-11-01 要求）', () => {
  const have = apiOps()
  assert.ok(have.has('deliver.open'), '交付包在案件根下、不在 out/ 里，outputs.open 的越界检查会拒它')
})

test('deliver.open 的边界：没有交付包要说清楚，不能静默失败', async () => {
  const { createApi } = await import('../lib/server/api.js')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { newCase } = await import('../lib/core/case.js')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-reveal-'))
  const A = path.join(root, '空案')
  newCase({ dir: A, title: '空案', caseType: 'contract' })
  const api = createApi({ version: 'x', root, config: {}, pkgRoot: root })
  const r = await api.handle('deliver.open', { case: A })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'deliver/none')
  assert.match(r.error.message, /打交付包/)
})

test('deliver.open 不许越界去开别的目录', async () => {
  const { createApi } = await import('../lib/server/api.js')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { newCase } = await import('../lib/core/case.js')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-reveal2-'))
  const A = path.join(root, '案')
  newCase({ dir: A, title: '案', caseType: 'contract' })
  const api = createApi({ version: 'x', root, config: {}, pkgRoot: root })
  const r = await api.handle('deliver.open', { case: A, name: '../../etc' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'path/outside')
})
