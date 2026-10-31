// 真实 React 点击测试（可选跑）：用真 React 18 + jsdom 渲染，然后**真的点按钮**。
//
// 为什么必须有这一层：用假 React 的测试只验证"节点存在"，验证不了
// 「点下去会发生什么」——之前按钮渲染出来了但 onClick 没接线，
// 假 React 测试全绿、用户点下去毫无反应。
//
// 依赖 react/react-dom/jsdom 是开发期可选的：没装就 skip，不阻塞零依赖安装。
import test from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

async function loadDeps() {
  try {
    const React = (await import('react')).default
    const { createRoot } = await import('react-dom/client')
    const { JSDOM } = await import('jsdom')
    return { React, createRoot, JSDOM }
  } catch (e) {
    return null
  }
}

const deps = await loadDeps()

test('真实 React：点「生成修订版 Word」必须真的发出 contract.revise 请求', { skip: deps ? false : '未安装 react/react-dom/jsdom' }, async () => {
  const { React, createRoot, JSDOM } = deps
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  global.window = dom.window
  global.document = dom.window.document
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
  global.HTMLElement = dom.window.HTMLElement
  global.Node = dom.window.Node
  global.Event = dom.window.Event
  global.MouseEvent = dom.window.MouseEvent
  global.IS_REACT_ACT_ENVIRONMENT = true

  const calls = []
  const REPLIES = {
    'case.open': { ok: true, data: { caseId: 'A', title: '测试', caseType: 'contract', caseTypeLabel: '合同审核', dir: '/tmp/lc-case', status: 'open', review: { stance: 'partyA', templateId: 'general', instructions: '', brief: '立场：甲方' }, proc: { total: 0, done: 0, blocked: [], rows: [] }, facts: { total: 0, ok: 0, unverified: 0 }, findings: { total: 0, byLevel: {} }, materials: { total: 1, parsed: 1 }, pendingConfirm: [], hints: [] } },
    'cases.list': { ok: true, data: { root: '/tmp', count: 1, cases: [{ dir: '/tmp/lc-case', title: '测试', caseType: 'contract', caseTypeLabel: '合同审核', counts: { materials: 1, facts: 0, findings: 0, procTotal: 0, procDone: 0 } }] } },
    'outputs.list': { ok: true, data: { count: 1, summary: '产出 1 个', items: [{ name: '测试.docx', abs: '/tmp/测试.docx', kind: 'word', bytes: 34000, at: '2026-10-28T01:00:00Z' }] } },
    verify: { ok: true, data: { verdict: 'pass', summary: '五道全过', checks: [] } },
    'contract.revise': { ok: true, data: { ok: true, summary: '已生成修订版《测试.docx》', outFile: '/tmp/测试.docx' } },
    'next.step': { ok: true, data: { next: null, state: {} } },
    'ui.state': { ok: true, data: {} },
  }
  global.fetch = async (url, opts) => {
    let b = {}
    try { b = JSON.parse((opts && opts.body) || '{}') } catch (e) {}
    calls.push(b.op)
    return { status: 200, json: async () => REPLIES[b.op] || { ok: true, data: {} } }
  }
  dom.window.fetch = global.fetch

  let spec
  dom.window.__ModuleLoader__ = { load: (s) => { spec = s } }
  await import(CLIENT + '?realclick=' + Date.now())
  const mod = spec.factory((n) => (n === 'react' ? React : {}))

  const root = createRoot(document.getElementById('root'))
  const { act } = React
  await act(async () => {
    root.render(React.createElement(mod.__views.Panel, { service: { currentSession: () => null }, entry: {}, active: true, conversation: null }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 300)) })

  // 选案件
  const row = [...document.querySelectorAll('button,div')].find((e) => e.textContent === '测试')
  assert.ok(row, '案件列表里应有「测试」')
  await act(async () => { row.click() })
  await act(async () => { await new Promise((r) => setTimeout(r, 400)) })

  // 切到验收页
  const vtab = [...document.querySelectorAll('button')].find((b) => b.textContent === '验收')
  assert.ok(vtab, '应有「验收」页签')
  await act(async () => { vtab.click() })
  await act(async () => { await new Promise((r) => setTimeout(r, 300)) })

  // 真的点生成按钮
  const gen = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('生成修订版'))
  assert.ok(gen, '验收页必须渲染出「生成修订版 Word」按钮')
  await act(async () => { gen.click() })
  await act(async () => { await new Promise((r) => setTimeout(r, 300)) })

  assert.ok(calls.includes('contract.revise'), '点击必须真的调用 contract.revise，实际调用：' + calls.join(','))
  // 生成后预览区要出现结果
  assert.match(document.body.textContent, /已生成修订版|测试\.docx/, '生成后要在页面上看到结果')
})
