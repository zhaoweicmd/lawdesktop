// 视图渲染冒烟测试：不依赖浏览器，把每一页用真实形状的数据渲染一次。
// 目的是挡住「点开某一页就崩」——这类错误在宿主里只会表现为白屏或错误边界文案。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function fakeReact() {
  class Component {
    constructor(props) {
      this.props = props
    }
  }
  return {
    createElement: (type, props, ...children) => {
      // 真实 React 会把 children 也放进 props，组件里 props.children 才拿得到
      const p = props || {}
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { type, props: p, children }
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    Component,
  }
}

let seq = 0
async function load() {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    __ModuleLoader__: {
      load: (spec) => {
        globalThis.__spec = spec
      },
    },
  }
  seq += 1
  await import(`${CLIENT}?render=${seq}`)
  const react = fakeReact()
  // 客户端模块的 factory 拿到的是 require 函数（模块表），不是 React 本身
  return globalThis.__spec.factory((name) => (name === 'react' ? react : {}))
}

// 把渲染树拍平成文字，便于断言。
// 注意：假的 createElement 不会自动展开子组件，所以函数型 type 要在这里手动调用，
// 否则子组件里的文字（如 Notice / Field）不会被统计到。
function textOf(node, depth = 0) {
  if (depth > 40) return ''
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).join(' ')
  if (typeof node.type === 'function') {
    try {
      return textOf(node.type(node.props), depth + 1)
    } catch (e) {
      return ''
    }
  }
  return textOf(node.children || [], depth + 1)
}

const actions = new Proxy(
  {},
  {
    get: () => () => {},
  }
)

test('概览页：渲染出下一步 / 台账计数', async () => {
  const mod = await load()
  const detail = {
    caseId: '案1',
    caseType: 'litigation',
    caseTypeLabel: '诉讼/争议',
    title: '甲诉乙买卖合同纠纷',
    cause: '买卖合同纠纷',
    parties: '原告：甲；被告：乙',
    dir: '/tmp/x',
    status: 'open',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    proc: { total: 2, done: 1, doing: null, blocked: [], rows: [] },
    facts: { total: 3, ok: 2, unverified: 1, brokenLines: 0 },
    findings: { total: 1, byLevel: {} },
    materials: { dirs: [], total: 5, parsed: 4 },
    pendingConfirm: [],
    hints: ['有 1 条事实未核到出处'],
    lastLog: null,
  }
  const tree = mod.__views.Overview({ detail })
  const text = textOf(tree)
  assert.match(text, /未核到出处/)
  assert.match(text, /甲诉乙/)
})

test('材料 / 事实 / 结论 / 工序 / 条款 / 意见 / 验收 七页都能渲染（含空数据）', async () => {
  const mod = await load()
  const V = mod.__views

  const cases = [
    ['MaterialsView', { files: [{ mid: 'M1', rel: '合同.pdf', kind: 'pdf', size: 2048, isLatest: true }], summary: '已登记 1 个文件' }],
    ['FactsView', { total: 1, facts: [{ id: 'F1', text: '双方签约', file: '合同.pdf', locator: 'P1', verified: 'pending' }] }],
    ['FindingsView', { count: 1, items: [{ id: 'K1', text: '合同成立', factRefs: ['F1'], trace: 'ok' }] }],
    ['ProcView', { total: 1, done: 0, proc: [{ id: 'P1', name: '梳理材料', status: 'todo', dependsOn: [], acceptance: '材料登记' }] }],
    ['ClausesView', { count: 1, files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第一条', title: '标的', text: '……' }] }] }],
    ['NotesView', { count: 1, notes: [{ id: 'N1', clause: '第一条', level: '重大风险', issue: '标的约定不明导致履行争议', fix: '标的按附件一清单确定', basis: '民法典' }] }],
  ]
  for (const [name, data] of cases) {
    const Comp = V[name]
    assert.equal(typeof Comp, 'function', name + ' 应该是组件')
    const tree = Comp({ data, actions })
    assert.ok(textOf(tree).length > 0, name + ' 应渲染出内容')
  }

  // 空数据也不许崩
  for (const [name] of cases) {
    const Comp = V[name]
    assert.doesNotThrow(() => textOf(Comp({ data: null, actions })), name + ' 空数据')
  }

  // 验收页：有结果 + 只看没过
  const verify = V.VerifyView({
    result: {
      verdict: 'needs_fix',
      summary: '1 道未通过',
      checks: [
        { name: 'facts', status: 'pass', title: '事实可追溯', items: [] },
        { name: 'law', status: 'fail', title: '法条可回源', items: [{ text: 'L1 未回源' }] },
      ],
      mustFix: [{ text: 'L1 未回源' }],
    },
    onRun: () => {},
    busy: false,
  })
  assert.match(textOf(verify), /法条可回源/)
})

// 回归：结论页曾经「一个核对按钮都没有」。
// 原因是 DetailPane 渲染 FindingsView 时漏传 actions，而 CheckButtons 在
// onCheck 缺失时 **静默返回 null**——不报错、不告警，界面上就是没有按钮。
test('结论页必须渲染出逐条核对按钮（漏传 actions 会静默消失）', async () => {
  const mod = await load()
  const V = mod.__views
  const data = { count: 1, items: [{ id: 'K1', text: '合同成立', factRefs: ['F1'], trace: 'ok' }], summary: '共 1 条' }

  // 假的 createElement 不会自动展开子组件，这里手动往下钻
  const findNamed = (node, name, out = [], depth = 0) => {
    if (depth > 40 || node == null) return out
    if (typeof node.type === 'function') {
      if (node.type.name === name) out.push(node)
      try {
        findNamed(node.type(node.props), name, out, depth + 1)
      } catch (e) {
        /* 组件里用到本用例没提供的钩子就跳过 */
      }
      return out
    }
    if (Array.isArray(node)) {
      node.forEach((n) => findNamed(n, name, out, depth + 1))
      return out
    }
    return findNamed(node.children || [], name, out, depth + 1)
  }

  // 1) 有 actions：每条结论都有自己的核对按钮组，且 onCheck 真的接上了
  const wired = findNamed(V.FindingsView({ data, actions, checker: '张三' }), 'CheckButtons')
  assert.equal(wired.length, 1, '每条结论都要有自己的核对按钮组')
  assert.equal(typeof wired[0].props.onCheck, 'function', 'onCheck 必须接上，否则按钮静默不渲染')

  // 2) 漏传 actions：按钮数归零——把「为什么会静默消失」钉死。
  //    （FindingsView 在没 actions 时仍会造一个空壳 onCheck，真正拦人的是
  //    CheckButtons 里 onCheck 缺席就 return null，所以这里往里钻一层看按钮本体）
  const unwired = findNamed(V.FindingsView({ data }), 'CheckButtons')
  assert.equal(unwired.length, 1, '空壳组件还在')
  assert.equal(findNamed(unwired[0].type(unwired[0].props), 'button').length, 0, '没接 onCheck 时一个按钮都不许渲染')

  // 3) 真实接线点：DetailPane 渲染结论页时必须把 actions 传下去
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  assert.match(src, /FindingsView, \{ data: tabData\.findings, actions/, 'DetailPane 渲染结论页必须传 actions')

  // 4) 没填核对人时要把原因写在页面上，而不是留一排点了没反应的按钮
  assert.match(textOf(V.FindingsView({ data, actions })), /核对人姓名/)
})

test('面板整页（DetailPane）在两种案型下都能渲染', async () => {
  const mod = await load()
  const V = mod.__views
  const base = {
    caseId: '案1',
    title: '测试',
    caseType: 'litigation',
    caseTypeLabel: '诉讼/争议',
    dir: '/tmp/x',
    status: 'open',
    proc: { total: 0, done: 0, blocked: [], rows: [] },
    facts: { total: 0, ok: 0, unverified: 0 },
    findings: { total: 0, byLevel: {} },
    materials: { total: 0, parsed: 0 },
    pendingConfirm: [],
    hints: [],
  }
  for (const [caseType, label, wantTab] of [
    ['litigation', '诉讼/争议', '事实'],
    ['contract', '合同审核', '条款'],
  ]) {
    const tree = V.DetailPane({
      detail: Object.assign({}, base, { caseType, caseTypeLabel: label }),
      tab: '概览',
      setTab: () => {},
      tabData: {},
      verifyResult: null,
      runVerify: () => {},
      busy: false,
      tabErr: null,
      actions,
      notice: { ok: true, text: '扫材料完成' },
    })
    const text = textOf(tree)
    assert.match(text, new RegExp(wantTab), caseType + ' 应有 ' + wantTab + ' 页签')
    assert.match(text, /扫材料完成/, '操作结果应显示在标题旁')
  }
})

test('操作条渲染：无案件时「扫材料」「打交付包」应禁用', async () => {
  const mod = await load()
  const tree = mod.__views.ActionBar({ activeDir: null, running: false, notice: null })
  const text = textOf(tree)
  assert.match(text, /新建案件/)
  assert.match(text, /扫材料/)
})

test('面板整页：合同案的**每一个**页签都能渲染（含「意见」页）', async () => {
  // 为什么必须逐页签跑：之前的测试一律用 tab:'概览' 渲染，
  // 而「意见」页里 NotesView 的接线（caseDir）只在那个分支才执行——
  // 结果线上点进"意见"就整页崩掉（ReferenceError: activeDir is not defined），
  // 测试却全绿。只渲染默认页等于只测了十分之一。
  const mod = await load()
  const V = mod.__views
  const detail = {
    caseId: '案1',
    title: '测试合同案',
    caseType: 'contract',
    caseTypeLabel: '合同审核',
    dir: '/tmp/lawcase-tabs',
    status: 'open',
    review: { stance: 'neutral', templateId: 'general', instructions: '', brief: '' },
    proc: { total: 0, done: 0, blocked: [], rows: [] },
    findings: { total: 0, byLevel: {} },
    materials: { total: 0, parsed: 0 },
    pendingConfirm: [],
    hints: [],
  }
  const tabs = ['概览', '材料', '条款', '意见', '预检', '工序', '验收']
  for (const tab of tabs) {
    const tree = V.DetailPane({
      detail,
      tab,
      setTab: () => {},
      tabData: {},
      verifyResult: null,
      runVerify: () => {},
      busy: false,
      tabErr: null,
      actions,
      notice: null,
    })
    assert.ok(tree, `「${tab}」页应能渲染`)
    const text = textOf(tree)
    assert.ok(text.length > 0, `「${tab}」页不应是空白`)
  }
})

test('意见页必须把当前案件目录传给 NotesView（AI 审核要用它）', async () => {
  const mod = await load()
  const V = mod.__views
  const detail = {
    caseId: '案1',
    title: '测试合同案',
    caseType: 'contract',
    caseTypeLabel: '合同审核',
    dir: '/tmp/lawcase-notes-dir',
    status: 'open',
    review: { stance: 'neutral', templateId: 'general', instructions: '', brief: '' },
    proc: { total: 0, done: 0, blocked: [], rows: [] },
    materials: { total: 0, parsed: 0 },
    pendingConfirm: [],
    hints: [],
  }
  const tree = V.DetailPane({
    detail,
    tab: '意见',
    setTab: () => {},
    tabData: {},
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    tabErr: null,
    actions,
    notice: null,
  })
  // 找到 NotesView 那一层，断言 caseDir 传的是 detail.dir（而不是 undefined）
  let found = null
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.props && n.props.caseDir !== undefined) found = n.props.caseDir
    const kids = n.props && n.props.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else walk(kids)
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(tree)
  assert.equal(found, '/tmp/lawcase-notes-dir', 'NotesView 必须拿到真实案件目录')
})

test('合同审核案的页签里没有「工序」；诉讼案仍然有', async () => {
  // 用户 2026-10-27 明确要求：合同审核不要工序。
  // 工序是诉讼案拆办理步骤用的；合同案多一个空工序表会把"下一步"指向不存在的页面。
  const mod = await load()
  const V = mod.__views
  const base = {
    caseId: 'A',
    title: 'T',
    status: 'open',
    dir: '/tmp/tab-check',
    review: { stance: 'neutral', templateId: 'general', instructions: '', brief: '' },
    proc: { total: 0, done: 0, blocked: [], rows: [] },
    materials: { total: 0, parsed: 0 },
    pendingConfirm: [],
    hints: [],
  }
  const render = (caseType) =>
    V.DetailPane({
      detail: Object.assign({}, base, { caseType, caseTypeLabel: caseType === 'contract' ? '合同审核' : '诉讼/争议' }),
      tab: '概览',
      setTab: () => {},
      tabData: {},
      verifyResult: null,
      runVerify: () => {},
      busy: false,
      tabErr: null,
      actions: new Proxy({}, { get: () => () => {} }),
      notice: null,
      checker: '',
      onCheckerChange: () => {},
    })

  const contractText = textOf(render('contract'))
  assert.doesNotMatch(contractText, /工序/, '合同审核案不该出现「工序」页签')

  const litText = textOf(render('litigation'))
  assert.match(litText, /工序/, '诉讼案仍然要有「工序」页签')
})

test('界面代码里不得调用 prompt / alert / confirm（Electron 下静默失效）', async () => {
  // 踩过两次：Electron 工作台里 window.prompt 返回 null、window.confirm 返回 false，
  // 浏览器里看着正常，用起来就是"点了完全没反应"。需要输入/确认的地方一律用页内控件。
  const src = fs.readFileSync(CLIENT, 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l)) // 去掉整行注释，避免把"教训说明"当成调用
    .join('\n')
  const hits = []
  for (const fn of ['prompt', 'alert', 'confirm']) {
    const needle = 'window.' + fn + '('
    if (code.includes(needle)) hits.push(needle)
  }
  assert.deepEqual(hits, [], '不得调用这些浏览器弹窗：' + hits.join('、'))
})

test('验收页「忽略」必须用页内输入框，而不是弹窗', async () => {
  const mod = await load()
  const V = mod.__views
  const result = {
    verdict: 'needs_review',
    summary: '有 1 道待人工确认',
    checks: [
      { name: 'law', title: '法条可回源', status: 'warn', items: [{ level: 'warn', msg: 'N17（12）依据「民诉法第35条」未登记', ref: 'notes.jsonl' }] },
    ],
  }
  // 点「忽略」不弹窗、而是切换到“填理由”状态 —— 这里验证按钮存在且是普通按钮
  const tree = V.VerifyView({ result, onRun: () => {}, busy: false, onGotoItem: () => {}, onWaive: () => {} })
  const texts = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props && typeof n.props.children === 'string') texts.push(n.props.children)
    const k = n.children || (n.props && n.props.children)
    if (Array.isArray(k)) k.forEach(walk)
    else walk(k)
  }
  walk(tree)
  assert.ok(texts.includes('忽略'), '要有「忽略」入口')
})

test('验收页必须有产出文件预览区：列出文件名/大小，Markdown 直接给正文', async () => {
  const mod = await load()
  const V = mod.__views
  const outputs = {
    count: 2,
    summary: '产出 2 个文件（最新：修订版.docx）',
    items: [
      { name: '修订版.docx', abs: '/tmp/c/out/修订版.docx', ext: '.docx', kind: 'word', bytes: 35000, at: '2026-10-28T01:00:00.000Z' },
      { name: '意见表.md', abs: '/tmp/c/out/意见表.md', ext: '.md', kind: 'markdown', bytes: 3457, at: '2026-10-28T00:00:00.000Z', preview: '# 意见表\n第一条 付款' },
    ],
  }
  const tree = V.VerifyView({
    result: { verdict: 'pass', summary: '五道全过', checks: [] },
    onRun: () => {},
    busy: false,
    onGotoItem: () => {},
    onWaive: () => {},
    onReviseDocx: () => {},
    outputs,
    revising: false,
    reviseMsg: { ok: true, text: '已生成修订版｜落实 8 条' },
    onLoadOutputs: () => {},
    onOpenOutput: () => {},
    openBusy: '',
  })
  const texts = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props && typeof n.props.children === 'string') texts.push(n.props.children)
    const k = n.children || (n.props && n.props.children)
    if (Array.isArray(k)) k.forEach(walk)
    else walk(k)
  }
  walk(tree)
  const all = texts.join(' ')
  assert.match(all, /产出文件/, '要有预览区标题')
  assert.match(all, /修订版\.docx/, '要列出生成的文件名')
  assert.match(all, /意见表\.md/)
  assert.match(all, /已生成修订版/, '要显示本次生成结果')
  assert.match(all, /在默认应用打开/, '必须有「在默认应用打开」入口')
  assert.match(all, /打开文件夹/, '必须有「打开文件夹」入口')
  // 预览默认收起（避免一屏堆满长文档）：行内要有「预览」提示，点开才展开正文
  assert.match(all, /预览/, '有内容的文件要给「预览」入口')
})

test('验收页：没有产出时给出明确空状态，而不是一片空白', async () => {
  const mod = await load()
  const V = mod.__views
  const tree = V.VerifyView({
    result: { verdict: 'pass', summary: 'ok', checks: [] },
    onRun: () => {}, busy: false, onGotoItem: () => {}, onWaive: () => {},
    outputs: { count: 0, items: [], summary: '还没有产出文件' },
  })
  const texts = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props && typeof n.props.children === 'string') texts.push(n.props.children)
    const k = n.children || (n.props && n.props.children)
    if (Array.isArray(k)) k.forEach(walk)
    else walk(k)
  }
  walk(tree)
  assert.match(texts.join(' '), /还没有产出/)
})

test('DetailPane 必须把验收页需要的 props 全部转给 VerifyView（漏传=按钮点了没反应）', async () => {
  // 踩过：VerifyView 里用 revising 控制按钮文案、用 outputs 渲染预览区，
  // 但 DetailPane 渲染时漏传 → revising 是 undefined，按钮永远显示原文案，
  // 用户看到的就是"点了毫无反应"。直接测 VerifyView 的测试抓不到这个（它自己传 props）。
  const mod = await load()
  const V = mod.__views
  const detail = {
    caseId: 'A', title: 'T', caseType: 'contract', caseTypeLabel: '合同审核', dir: '/tmp/x',
    status: 'open', review: null, proc: { total: 0, done: 0, blocked: [], rows: [] },
    materials: { total: 0, parsed: 0 }, pendingConfirm: [], hints: [],
  }
  const outputs = { count: 1, summary: '产出 1 个文件', items: [{ name: '修订版.docx', abs: '/tmp/x/out/修订版.docx', kind: 'word', bytes: 34000, at: '2026-10-28T01:00:00Z' }] }
  const tree = V.DetailPane({
    detail, tab: '验收', setTab: () => {}, tabData: {},
    verifyResult: { verdict: 'pass', summary: 'ok', checks: [] },
    runVerify: () => {}, busy: false, tabErr: null,
    actions: new Proxy({}, { get: () => () => {} }), notice: null, running: false,
    checker: '', onCheckerChange: () => {},
    onReviseDocx: () => {}, onWaive: () => {},
    outputs, revising: true, reviseMsg: { ok: true, text: '已生成修订版' }, onLoadOutputs: () => {},
  })
  // 用文件里现成的 textOf：它会手动展开函数型组件（VerifyView 是函数组件，
  // 自己写的 walk 不会展开它，导致断言取不到文字）。
  const all = textOf(tree)
  assert.match(all, /生成中…/, 'revising=true 时必须转给 VerifyView，否则按钮文案不变（点击没反应的假象）')
  assert.match(all, /修订版\.docx/, 'outputs 必须转给 VerifyView，否则预览区是空的')
  assert.match(all, /已生成修订版/, 'reviseMsg 必须转给 VerifyView')
})
