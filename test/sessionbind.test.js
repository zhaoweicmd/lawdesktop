// 会话 ↔ 案件 绑定：防「对话指令改错案卷」。
// 实证背景：2026-10-25 用户机器上有两个「某某合同诈骗案」目录，
// 面板在看 A，助手把事实写进了 B。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { newCase } from '../lib/core/case.js'
import { addFact } from '../lib/core/fact.js'
import {
  sessionIdOf, getBinding, setBinding, clearBinding, listBindings, resolveCaseForTool,
} from '../lib/core/sessionbind.js'
import { wrap } from '../lib/tools/_shared.js'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-sb-'))
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'a.pdf'), 'x')
  const A = path.join(root, 'A案')
  const B = path.join(root, 'B案')
  newCase({ dir: A, title: 'A案', materialsDirs: [src] })
  newCase({ dir: B, title: 'B案', materialsDirs: [src] })
  return { root, src, A, B }
}

const factCount = (dir) =>
  fs.readFileSync(path.join(dir, '.lawcase', 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).length

test('sessionIdOf：从 exec.agent.id 取会话标识（宿主实证路径）', () => {
  assert.equal(sessionIdOf({ agent: { id: 's1' } }), 's1')
  assert.equal(sessionIdOf({ agent: {} }), null)
  assert.equal(sessionIdOf({}), null)
  assert.equal(sessionIdOf(null), null)
})

test('没有会话信息（CLI/单测）时不参与绑定，原样放行', () => {
  const { root, A } = setup()
  const r = resolveCaseForTool({ sessionId: null, argsCase: A, pkgRoot: root })
  assert.equal(r.action, 'none')
  assert.equal(r.caseDir, A)
})

test('首次带 case 自动绑定；随后改调另一个案会被拒', () => {
  const { root, A, B } = setup()
  const r1 = resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  assert.equal(r1.action, 'bound')
  assert.equal(getBinding('s1', { pkgRoot: root }).case, A)

  const r2 = resolveCaseForTool({ sessionId: 's1', argsCase: B, pkgRoot: root })
  assert.equal(r2.action, 'conflict')
  assert.equal(r2.caseDir, null)
  assert.match(r2.error, /为防止改错案卷，本次调用已拒绝/)
  assert.match(r2.error, /A案/)
})

test('同一个案再调：不算冲突', () => {
  const { root, A } = setup()
  resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  const r = resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  assert.equal(r.action, 'same')
})

test('不带 case 时用绑定值补上（不穿透到 core 报 case 不能为空）', () => {
  const { root, A } = setup()
  resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  const r = resolveCaseForTool({ sessionId: 's1', argsCase: null, pkgRoot: root })
  assert.equal(r.action, 'same')
  assert.equal(r.caseDir, A)
})

test('解绑后可以绑到别的案', () => {
  const { root, A, B } = setup()
  resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  clearBinding('s1', { pkgRoot: root })
  assert.equal(getBinding('s1', { pkgRoot: root }), null)
  const r = resolveCaseForTool({ sessionId: 's1', argsCase: B, pkgRoot: root })
  assert.equal(r.action, 'bound')
  assert.equal(r.caseDir, B)
})

test('绑定按会话隔离：两个会话互不干扰', () => {
  const { root, A, B } = setup()
  resolveCaseForTool({ sessionId: 's1', argsCase: A, pkgRoot: root })
  resolveCaseForTool({ sessionId: 's2', argsCase: B, pkgRoot: root })
  assert.equal(getBinding('s1', { pkgRoot: root }).case, A)
  assert.equal(getBinding('s2', { pkgRoot: root }).case, B)
  assert.equal(listBindings({ pkgRoot: root }).length, 2)
})

test('端到端：wrap 真的拦住了写进另一个案', async () => {
  const { root, src, A, B } = setup()
  const ctx = { pkgRoot: root }
  const exec = { agent: { id: 'sess-e2e' } }
  const tool = wrap(async (a) => addFact({ case: a.case, text: '被告收款五十万元未交付货物', source: path.join(src, 'a.pdf'), locator: 'P1' }), { name: 'lc_fact_add', ctx })

  await tool({ case: A }, exec)
  assert.equal(factCount(A), 1)

  const blocked = await tool({ case: B }, exec)
  assert.match(blocked.text, /本次调用已拒绝/)
  assert.equal(factCount(B), 0, '被拦下的调用绝不能写进 B 案')

  // 不带 case：落到绑定案
  await tool({}, exec)
  assert.equal(factCount(A), 2)
  assert.equal(factCount(B), 0)
})

test('BYPASS 的工具不受绑定限制（ping 之类）', async () => {
  const { root, A, B } = setup()
  const ctx = { pkgRoot: root }
  const exec = { agent: { id: 'sess-by' } }
  const tool = wrap(async (a) => ({ ok: true, got: a.case }), { name: 'lc_ping', ctx })
  resolveCaseForTool({ sessionId: 'sess-by', argsCase: A, pkgRoot: root })
  const r = await tool({ case: B }, exec)
  assert.match(r.text, /B案/, 'ping 不做绑定校验，原样子执行')
})
