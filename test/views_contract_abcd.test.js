// 合同审核界面（A/B/C/D）的交互测试。
// 用能真正跑状态的迷你 React：点按钮、改输入都能看到结果，否则「控件在但没接线」测不出来。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function createHarness() {
  const stores = new Map()
  const effectDeps = new Map()
  let hookPath = 'root'
  let hookIdx = 0
  let effects = []

  const react = {
    createElement: (type, props, ...children) => {
      const p = props || {}
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { type, props: p, children }
    },
    useState(init) {
      const key = hookPath + '#' + hookIdx++
      if (!stores.has(key)) stores.set(key, typeof init === 'function' ? init() : init)
      return [
        stores.get(key),
        (v) => {
          stores.set(key, typeof v === 'function' ? v(stores.get(key)) : v)
        },
      ]
    },
    useEffect(fn, deps) {
      // 真实 React 按依赖数组决定要不要重跑。这里也必须一样：
      // 否则每次渲染都会把用户刚改的 state 覆盖回 props 初值，
      // 测出来的就是「控件不生效」——而线上其实是好的。
      const key = hookPath + '@' + hookIdx++
      const sig = deps === undefined ? '__always__' : JSON.stringify(deps)
      if (deps === undefined || effectDeps.get(key) !== sig) {
        effectDeps.set(key, sig)
        effects.push(fn)
      }
    },
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    Component: class {
      constructor(props) {
        this.props = props
      }
    },
  }
  // 真 React 靠这个标记识别 class 组件；不设的话错误边界会被当函数调用
  react.Component.prototype.isReactComponent = {}

  function runComp(type, props, nodePath) {
    const savedPath = hookPath
    const savedIdx = hookIdx
    hookPath = nodePath
    hookIdx = 0
    try {
      return type(props)
    } finally {
      hookPath = savedPath
      hookIdx = savedIdx
    }
  }

  function walk(node, nodePath, out) {
    if (node == null || node === false || node === true) return out
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, nodePath + '.' + i, out))
      return out
    }
    if (typeof node === 'string' || typeof node === 'number') return out
    if (typeof node.type === 'function') {
      out.push(node)
      // class 组件（本仓库只有错误边界）不能当函数调用：没出错时它原样渲染 children
      if (node.type.prototype && node.type.prototype.isReactComponent) {
        walk(node.props && node.props.children, nodePath, out)
        return out
      }
      walk(runComp(node.type, node.props, nodePath), nodePath, out)
      return out
    }
    out.push(node)
    const kids = node.children || []
    if (Array.isArray(kids)) kids.forEach((c, i) => walk(c, nodePath + '.' + i, out))
    return out
  }

  async function settle() {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0))
  }

  return {
    react,
    async render(Comp, props) {
      const first = walk(runComp(Comp, props, 'root'), 'root', [])
      const pending = effects.splice(0)
      if (!pending.length) return first
      for (const fn of pending) {
        try {
          await fn()
        } catch (e) {}
      }
      await settle()
      effects = []
      return walk(runComp(Comp, props, 'root'), 'root', [])
    },
  }
}

let seq = 0
async function load(fetchImpl) {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  globalThis.fetch = fetchImpl || (async () => ({ status: 200, json: async () => ({ ok: true, data: {} }) }))
  seq += 1
  await import(`${CLIENT}?abcdview=${seq}`)
  const harness = createHarness()
  const mod = globalThis.__spec.factory((name) => (name === 'react' ? harness.react : {}))
  return { mod, harness }
}

const textOf = (nodes) =>
  nodes
    .map((n) => (typeof n.props.children === 'string' || typeof n.props.children === 'number' ? String(n.props.children) : ''))
    .join(' ')

// 只找「真正的 DOM 元素」：组件节点（TextInput/TextArea 等）的 props 里也有
// placeholder 和 onChange，但那里的 onChange 是 setState 本身，不是事件处理器，
// 误把它当 DOM 用会把 state 写成事件对象。
const findByText = (nodes, text) =>
  nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === text)
const byPlaceholder = (nodes, sub) =>
  nodes.find(
    (n) =>
      typeof n.type !== 'function' &&
      n.props &&
      typeof n.props.placeholder === 'string' &&
      n.props.placeholder.includes(sub)
  )

const DETAIL = {
  caseId: '案1',
  title: '采购合同审核',
  caseType: 'contract',
  caseTypeLabel: '合同审核',
  dir: '/tmp/x',
  status: 'open',
  review: { stance: 'partyB', templateId: 'purchase', instructions: '重点看验收', brief: '立场：站在乙方立场｜类型：采购合同' },
  proc: { total: 0, done: 0, blocked: [], rows: [] },
  facts: { total: 0, ok: 0, unverified: 0 },
  findings: { total: 0, byLevel: {} },
  materials: { total: 0, parsed: 0 },
  pendingConfirm: [],
  hints: [],
}

const CLAUSE_FILES = [
  {
    name: '采购合同.docx',
    total: 2,
    noteCount: 0,
    clauses: [
      { no: '第二条', title: '第二条 价款与付款', text: '第二条 价款与付款\n合同总价 100 万元，签订后 3 日内一次性付款。', noteCount: 0 },
    ],
  },
]

test('A｜合同案不再有「预检」页签（已并入验收）', async () => {
  // 用户 2026-11-01：「感觉可以不要预检这步」。
  // 理由：预检的四项核心检查（编号/附件/关键词/签署）AI 审核已全覆盖，
  // 多一个页签只是多一步点击。占位符检查移到了「验收」页顶部的自查块。
  const { mod, harness } = await load()
  const props = {
    detail: DETAIL,
    tab: '概览',
    setTab: () => {},
    tabData: {},
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
  }
  const ctree = await harness.render(mod.__views.DetailPane, props)
  const tabs = ctree
    .filter((n) => n.type === 'button' && n.props && n.props.role === 'tab')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children[0] : n.props.children))
  assert.ok(!tabs.includes('预检'), `页签里不该再有预检：${tabs.join(',')}`)
  assert.ok(tabs.includes('验收'), '验收页签要在')
})

test('A｜验收页顶部有「机器自查（占位符）」，且只报占位符', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '验收',
    setTab: () => {},
    tabData: {
      precheck: {
        ok: true,
        findings: [
          { id: 'PC1', ruleId: 'placeholder', level: '重大风险', title: '第二条 有未填的下划线空位', clause: '第二条' },
          { id: 'PC-AI-2', ruleId: 'ai-untouched', level: '重大风险', title: 'AI 报出的风险未处理', clause: '第二条' },
        ],
      },
    },
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
  })
  const text = textOf(tree)
  assert.match(text, /机器自查/)
  assert.match(text, /占位符/)
  assert.match(text, /未填的下划线空位/, '占位符问题要显示出来')
  // 只是 AI 未处理的提示不该混进"机器自查"——那是意见页的活
  assert.ok(!/AI 报出的风险未处理/.test(text), '自查块只该报占位符，不该把 AI 未处理也塞进来')
})

// 意见页默认是「全文四段式」；口径控件/引文输入/登记意见都在「登记表单」视图里。
// 每轮渲染前先切到表单视图（重新 render 会回到默认视图）。
async function renderForm(mod, harness, props) {
  let tree = await harness.render(mod.__views.NotesView, props)
  // findByText 返回的是**单个元素**（不是数组），别再 .find()
  const btn = findByText(tree, '登记表单')
  assert.ok(btn && btn.props && btn.props.onClick, '切换按钮要可点')
  assert.ok(btn, '必须有「登记表单」切换按钮')
  btn.props.onClick()
  return harness.render(mod.__views.NotesView, props)
}

test('C｜意见页显示当前口径；点「保存口径」把立场/类型/补充要求交上去', async () => {
  const { mod, harness } = await load()
  const calls = []
  const tree = await renderForm(mod, harness, {
    data: { notes: [], summary: '' },
    actions: { onConfigSet: (p) => calls.push(p) },
    files: CLAUSE_FILES,
    review: DETAIL.review,
  })
  assert.match(textOf(tree), /当前：立场：站在乙方立场｜类型：采购合同/)

  findByText(tree, '保存口径').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stance, 'partyB')
  assert.equal(calls[0].templateId, 'purchase')
  assert.equal(calls[0].instructions, '重点看验收')
})

test('C｜口径控件能改选项并跟着保存', async () => {
  const { mod, harness } = await load()
  const calls = []
  const props = {
    data: { notes: [], summary: '' },
    actions: { onConfigSet: (p) => calls.push(p) },
    files: CLAUSE_FILES,
    review: DETAIL.review,
  }
  let tree = await renderForm(mod, harness, props)
  // 第一个 select 是立场（neutral / partyA / partyB），第二个是合同类型
  const selects = tree.filter((n) => n.type === 'select')
  const stanceSelect = selects[0]
  const options = stanceSelect.props.children
  assert.deepEqual(options.map((o) => o.props.value), ['neutral', 'partyA', 'partyB'])
  stanceSelect.props.onChange({ target: { value: 'neutral' } })
  tree = await renderForm(mod, harness, props)
  findByText(tree, '保存口径').props.onClick()
  assert.equal(calls[0].stance, 'neutral')
})

test('B｜意见页有引文输入；提交时把 quote 一起交上去', async () => {
  const { mod, harness } = await load()
  const calls = []
  const props = {
    data: { notes: [], summary: '' },
    actions: { onNoteAdd: (p) => calls.push(p) },
    files: CLAUSE_FILES,
    review: DETAIL.review,
  }
  let tree = await renderForm(mod, harness, props)
  const quoteInput = byPlaceholder(tree, '引文')
  assert.ok(quoteInput, '应有引文输入框')

  byPlaceholder(tree, '问题：哪句话导致什么后果').props.onChange({
    target: { value: '签订即全额付款且未与验收挂钩，买方先付钱后失去救济' },
  })
  tree = await renderForm(mod, harness, props)
  byPlaceholder(tree, '替换条文').props.onChange({
    target: { value: '签订后 7 个工作日内支付 30% 预付款，验收合格后支付剩余 70%。' },
  })
  tree = await renderForm(mod, harness, props)
  byPlaceholder(tree, '引文').props.onChange({ target: { value: '签订后 3 日内一次性付款' } })
  tree = await renderForm(mod, harness, props)

  findByText(tree, '登记意见').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].quote, '签订后 3 日内一次性付款')
  assert.equal(calls[0].clause, '第二条')
})

test('D｜点「修订对照预览」触发 onPreview；有结果时渲染删除线/插入', async () => {
  const { mod, harness } = await load()
  const calls = []
  const base = {
    data: { notes: [], summary: '' },
    actions: { onPreview: (p) => calls.push(p) },
    files: CLAUSE_FILES,
    review: DETAIL.review,
  }
  let tree = await renderForm(mod, harness, base)
  findByText(tree, '修订对照预览').props.onClick()
  assert.equal(calls.length, 1)

  const preview = {
    ok: true,
    summary: '《采购合同.docx》修订预览：1 条意见涉及 1 条条款（删 12 字 / 增 20 字）',
    note: '预览按条款原文与建议条文做字符级对照。',
    items: [
      {
        noteId: 'N1',
        clause: '第二条',
        level: '重大风险',
        removedChars: 12,
        addedChars: 20,
        diff: { prefix: '第二条 价款与付款\n', oldMid: '签订后 3 日内一次性付款', newMid: '签订后 7 日支付 30%', suffix: '。', same: false },
      },
    ],
  }
  tree = await renderForm(mod, harness, Object.assign({}, base, { preview }))
  const text = textOf(tree)
  assert.match(text, /修订对照预览/)
  assert.match(text, /删 12 字 \/ 增 20 字/)
  const dels = tree.filter((n) => n.type === 'del')
  const inss = tree.filter((n) => n.type === 'ins')
  assert.equal(dels.length, 1)
  assert.equal(inss.length, 1)
  assert.match(textOf(dels), /签订后 3 日内一次性付款/)
  assert.match(textOf(inss), /签订后 7 日支付 30%/)
})

test('B｜意见列表里带引文的意见有「有引文」标记并显示原文', async () => {
  const { mod, harness } = await load()
  const tree = await renderForm(mod, harness, {
    data: {
      notes: [
        {
          id: 'N1',
          clause: '第二条',
          clauseHeading: '第二条 价款',
          level: '重大风险',
          issue: '签订即全额付款且未与验收挂钩，买方先付钱后失去救济',
          fix: '签订后 7 个工作日内支付 30% 预付款，验收合格后支付剩余 70%。',
          quote: '签订后 3 日内一次性付款',
          file: '采购合同.docx',
        },
      ],
      summary: '',
    },
    actions: {},
    files: CLAUSE_FILES,
    review: DETAIL.review,
  })
  const text = textOf(tree)
  assert.match(text, /有引文/)
  assert.match(text, /引文：签订后 3 日内一次性付款/)
})

test('待确认：每条都写清「怎么消掉」，而不是让人点同意', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.Overview, {
    detail: Object.assign({}, DETAIL, {
      pendingConfirm: ['确认本案的工序拆解（哪些工序、依赖关系、验收标准）', '确认材料目录清单（只读来源与产出位置）'],
    }),
  })
  const text = textOf(tree)
  assert.match(text, /待你确认（2）/)
  assert.match(text, /lc_proc_plan/, '工序那条要指到具体工具')
  assert.match(text, /扫材料/, '材料那条要指到具体的按钮/动作')
  assert.match(text, /做完就会自动消失/)

  assert.match(mod.__views.confirmHowTo('确认本案的工序拆解（哪些工序）'), /工序/)
  assert.match(mod.__views.confirmHowTo('材料定版剩余 1 组未定'), /定版/)
  assert.match(mod.__views.confirmHowTo('确认材料目录清单'), /扫材料/)
  assert.ok(mod.__views.confirmHowTo('某个没见过的提醒').length > 0, '未知条目也要给兜底指引')
})

test('标准分栏：工作台模式不再渲染自定义会话 UI（会话由宿主常驻左侧）', async () => {
  const { mod, harness } = await load(async () => ({
    status: 200,
    json: async () => ({ ok: true, data: { root: '/tmp/x', cases: [], count: 0 } }),
  }))
  const service = {
    ensureSession: async () => 's1',
    currentSession: () => null,
    openSession: () => {},
  }
  const tree = await harness.render(mod.__views.Panel, { service, entry: { id: 'lawdsh/lawcase' }, active: true, conversation: null })
  const text = textOf(tree)
  // 标准分栏：会话由宿主任左侧常驻，插件不再自己造聊天界面（规范禁止复制）
  assert.ok(!/AI 协助/.test(text), '不再提供自定义 AI 入口')
  assert.ok(!/用当前案件目录开会话/.test(text), '不再提供自定义开会话引导')
  const floating = tree.filter((n) => n.props && n.props.style && n.props.style.position === 'absolute' && n.props.style.borderRadius === 999)
  assert.equal(floating.length, 0, '不再有浮动会话按钮')
})

test('标准分栏：普通面板模式也不渲染任何自定义会话 UI', async () => {
  const { mod, harness } = await load(async () => ({
    status: 200,
    json: async () => ({ ok: true, data: { root: '/tmp/x', cases: [], count: 0 } }),
  }))
  const tree = await harness.render(mod.__views.Panel, { service: {}, entry: {}, active: true, conversation: null })
  const text = textOf(tree)
  assert.ok(!/AI 协助/.test(text))
  assert.ok(!/用当前案件目录开会话/.test(text))
})

test('每个台账页都有「刷新本页」：在对话里登记完东西，一点就同步过来', async () => {
  const { mod, harness } = await load()
  let hits = 0
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '事实',
    setTab: () => {},
    tabData: { facts: { total: 0, facts: [], summary: '事实台账为空（用 lc_fact_add 逐条登记）' } },
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
    onReloadTab: () => {
      hits += 1
    },
  })
  const btn = findByText(tree, '刷新本页')
  assert.ok(btn, '页签行必须有「刷新本页」')
  btn.props.onClick()
  assert.equal(hits, 1, '点了要真的触发重读，而不是只画个按钮')
})

test('逐条核对：每行三档按钮，非 ok 必须先写说明', async () => {
  const { mod, harness } = await load()
  const calls = []
  const props = {
    data: { facts: [{ id: 'F1', text: '被告收款50万元', file: '合同.pdf', locator: 'P12', verified: 'pending' }], summary: '' },
    actions: {
      checkMap: new Map(),
      onCheck: (p) => calls.push(p),
    },
  }
  let tree = await harness.render(mod.__views.FactsView, props)
  assert.ok(findByText(tree, '✓ 已核'), '应有「已核」按钮')
  assert.ok(findByText(tree, '改'))
  assert.ok(findByText(tree, '疑'))
  assert.match(textOf(tree), /未核对/, '没点过就显示未核对')

  // 一键已核：直接提交，不用写说明
  findByText(tree, '✓ 已核').props.onClick()
  assert.deepEqual(calls[0], { kind: 'fact', id: 'F1', result: 'ok', note: '' })

  // 「改」要先展开说明框
  findByText(tree, '改').props.onClick()
  tree = await harness.render(mod.__views.FactsView, props)
  assert.ok(byPlaceholder(tree, '要改成什么'), '点「改」应展开说明输入框')
})

test('核对进度与签字入口显示在页签行', async () => {
  const { mod, harness } = await load()
  const signed = []
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '事实',
    setTab: () => {},
    tabData: { facts: { facts: [], summary: '' } },
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
    checkoff: { done: 3, total: 62, pending: 59, fix: 1, doubt: 0, stale: 0, summary: '核对进度：已核 3/62｜未核 59｜需修改 1', items: [] },
    onSign: (who) => signed.push(who),
  })
  const text = textOf(tree)
  assert.match(text, /核对 3\/62/)
  assert.ok(findByText(tree, '生成签字单'), '应有生成签字单入口')
})

test('核对人框存在且为空时「生成签字单」禁用（不靠 window.prompt）', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '事实',
    setTab: () => {},
    tabData: { facts: { facts: [], summary: '' } },
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
    checkoff: { done: 0, total: 154, pending: 154, fix: 0, doubt: 0, stale: 0, summary: '', items: [] },
    onSign: () => {},
    checker: '',
    onCheckerChange: () => {},
  })
  const input = byPlaceholder(tree, '核对人姓名')
  assert.ok(input, '必须有核对人输入框（Electron 里 window.prompt 返回 null）')
  assert.equal(input.props.value, '')
  assert.equal(findByText(tree, '生成签字单').props.disabled, true, '没填核对人不能出签字单')
})

test('填了核对人后可以出签字单，且把姓名传下去', async () => {
  const { mod, harness } = await load()
  const signed = []
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '事实',
    setTab: () => {},
    tabData: { facts: { facts: [], summary: '' } },
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
    checkoff: { done: 10, total: 154, pending: 144, fix: 0, doubt: 0, stale: 0, summary: '', items: [] },
    onSign: (who) => signed.push(who),
    checker: '张律师',
    onCheckerChange: () => {},
  })
  const btn = findByText(tree, '生成签字单')
  assert.equal(btn.props.disabled, false)
  btn.props.onClick()
  assert.deepEqual(signed, ['张律师'])
})

test('底部状态栏：标出当前阶段、卡点与下一步按钮', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.CaseStatusBar, {
    detail: DETAIL,
    step: {
      state: { materials: 56, parsed: 56, proc: { total: 9, done: 9 }, facts: 82, findings: 16, clauses: 0, notes: 0 },
      checkoff: { done: 16, total: 154, pending: 138, fix: 0, doubt: 0, stale: 0 },
      next: { tool: 'lc_fact_list', stuck: '138 条未核对', action: '逐条核对事实', why: '未核对的台账进不了签字单' },
      summary: '',
    },
    busy: false,
    onGoto: () => {},
    onNext: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /卡在：138 条未核对/)
  assert.ok(findByText(tree, '下一步：核事实'), '按钮文案要短，不能把整句塞进按钮')
  assert.match(text, /✓ 材料|● 核对|○ 验收/, '阶段条要有完成/当前/未做三态')
})

test('阶段条按案件类型分派（合同案没有事实/结论页）', async () => {
  const { mod } = await load()
  const lit = mod.__views.stagePlan({ caseType: 'litigation' }, { state: {} }).map((s) => s.key)
  const con = mod.__views.stagePlan({ caseType: 'contract' }, { state: {} }).map((s) => s.key)
  assert.deepEqual(lit, ['材料', '工序', '事实', '核对', '结论', '法条', '验收'])
  // 预检已并入验收（用户 2026-11-01），合同线只剩四步
  assert.deepEqual(con, ['材料', '条款', '意见', '验收'])
})

test('下一步按钮：可一键做的给直白文案，需要判断的也不含糊', async () => {
  const { mod } = await load()
  assert.equal(mod.__views.shortAction({ tool: 'lc_material_parse_all', action: 'x' }), '批量解析')
  assert.equal(mod.__views.shortAction({ tool: 'lc_case_verify', action: 'x' }), '跑验收')
  assert.equal(mod.__views.shortAction({ tool: 'lc_proc_update', args: { id: 'P3' }, action: 'x' }), 'P3 推进')
  assert.equal(mod.__views.shortAction({ tool: 'lc_unknown_tool', action: '做点别的' }), '做点别的')
})

test('没有下一步时（走完了）状态栏不显示按钮，改成说清走完了', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.CaseStatusBar, {
    detail: DETAIL,
    step: { state: {}, next: null, summary: '这条线已经走到头了' },
    busy: false,
    onGoto: () => {},
    onNext: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /已经走到头/)
  assert.equal(findByText(tree, '下一步：继续'), undefined)
})

test('法条溯源页：逐条列出结论→法条→来源，问题项高亮', async () => {
  const { mod, harness } = await load()
  const data = {
    ok: true,
    note: '本表只做引证可核性判断。',
    summary: '法条溯源 2 条结论：重大风险 1',
    findings: 2,
    laws: 3,
    stats: { checked: 1, missing: 1, noQuote: 0, weakSource: 0, unused: 1 },
    unused: [{ id: 'L9', title: '刑法', article: '第三十一条' }],
    items: [
      {
        findingId: 'K1',
        finding: '被告构成合同诈骗',
        lawId: 'L1',
        lawTitle: '中华人民共和国刑法',
        article: '第二百二十四条',
        level: 'pass',
        problems: [],
        quote: '有下列情形之一，以非法占有为目的……',
        source: 'pkulaw',
        sourceLabel: '北大法宝 MCP',
        status: 'mcp-verified',
        weight: 100,
      },
      {
        findingId: 'K2',
        finding: '被告应承担连带责任',
        lawId: 'L99',
        lawTitle: '',
        article: '',
        level: '重大风险',
        problems: ['引用了 L99，但法律台账里没有这一条：可能是笔误或凭空写的条号'],
        quote: '',
        source: '',
        sourceLabel: '',
        status: 'missing-law',
        weight: 0,
      },
    ],
  }
  const tree = await harness.render(mod.__views.LawTraceView, { data, running: false, onRun: () => {}, onGotoFindings: () => {} })
  const text = textOf(tree)
  assert.match(text, /K1/)
  assert.match(text, /K2/)
  assert.match(text, /重大风险/)
  assert.match(text, /台账里没有这一条/)
  assert.match(text, /北大法宝 MCP/, '来源要显示出来')
  assert.match(text, /没被任何结论引用/, '未被引用的法条要单列')
  assert.ok(findByText(tree, '重新核对'))
})

test('法条溯源页：没跑过时给按钮与说明，不是空表', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.LawTraceView, { data: null, running: false, onRun: () => {}, onGotoFindings: () => {} })
  const text = textOf(tree)
  assert.ok(findByText(tree, '跑法条溯源'))
  assert.match(text, /不调模型、不改文件/)
})

test('法条页出现在「结论」之后、「验收」之前', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.DetailPane, {
    detail: DETAIL,
    tab: '概览',
    setTab: () => {},
    tabData: {},
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
  })
  const litTree = await harness.render(mod.__views.DetailPane, {
    detail: Object.assign({}, DETAIL, { caseType: 'litigation', caseTypeLabel: '诉讼/争议', review: null }),
    tab: '概览',
    setTab: () => {},
    tabData: {},
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
  })
  // 页签 button 现在带数目与状态点（界面 U1），children 变成数组：
  // 第一个子节点才是页签名，其余是数/点/读屏文字。只认「本身就是页签名」的 button，
  // 不要把按钮里的计数 span 也算成页签。
  const TAB_NAMES = ['概览', '材料', '事实', '结论', '法条', '工序', '验收', '条款', '意见', '预检']
  const labels = litTree
    .filter((n) => n.type === 'button')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children[0] : n.props.children))
    .filter((x) => typeof x === 'string' && TAB_NAMES.includes(x))
  const idxLaw = labels.indexOf('法条')
  const idxCon = labels.indexOf('结论')
  const idxVer = labels.indexOf('验收')
  assert.ok(idxLaw > idxCon && idxLaw < idxVer, `页签顺序应为 结论(>)} → 法条 → 验收，实际 ${labels.join(',')}`)
})

test('状态栏含「法条」阶段：溯源通过才打勾', async () => {
  const { mod } = await load()
  const withBad = mod.__views.stagePlan({ caseType: 'litigation' }, {
    state: { facts: 5, findings: 3 },
    checkoff: { total: 5, done: 5 },
    lawtrace: { items: [{ level: 'pass' }, { level: '重大风险' }], summary: 'x' },
  })
  const lawStage = withBad.find((s) => s.key === '法条')
  assert.ok(lawStage, '要法条阶段')
  assert.equal(lawStage.done, false, '有问题时不能打勾')

  const clean = mod.__views.stagePlan({ caseType: 'litigation' }, {
    state: { facts: 5, findings: 3 },
    checkoff: { total: 5, done: 5 },
    lawtrace: { items: [{ level: 'pass' }], summary: 'y' },
  })
  assert.equal(clean.find((s) => s.key === '法条').done, true)
})

test('批量核对确认条：名单可见、核对人必填、能取消', async () => {
  const { mod, harness } = await load()
  const confirmed = []
  const tree = await harness.render(mod.__views.BatchCheckBar, {
    draft: { kind: 'fact', ids: ['F1', 'F2', 'F3'] },
    checker: '',
    running: false,
    onCancel: () => {},
    onConfirm: (d) => confirmed.push(d),
  })
  const text = textOf(tree)
  assert.match(text, /F1、F2、F3/, '名单必须看得见')
  assert.match(text, /先在上面填核对人姓名/)
  const btn = findByText(tree, '确认标这 3 条')
  assert.ok(btn)
  assert.equal(btn.props.disabled, true, '没填核对人不能执行')
})

test('批量核对确认条：填了核对人就能执行', async () => {
  const { mod, harness } = await load()
  const confirmed = []
  const tree = await harness.render(mod.__views.BatchCheckBar, {
    draft: { kind: 'fact', ids: ['F1', 'F2'] },
    checker: '张律师',
    running: false,
    onCancel: () => {},
    onConfirm: (d) => confirmed.push(d),
  })
  assert.match(textOf(tree), /核对人：张律师/)
  const btn = findByText(tree, '确认标这 2 条')
  assert.equal(btn.props.disabled, false)
  btn.props.onClick()
  assert.equal(confirmed.length, 1)
  assert.deepEqual(confirmed[0].ids, ['F1', 'F2'])
})

test('批量核对提示语要说清代价：批量看不出是否逐条读过', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.BatchCheckBar, {
    draft: { kind: 'fact', ids: ['F1'] },
    checker: '张律师',
    running: false,
    onCancel: () => {},
    onConfirm: () => {},
  })
  assert.match(textOf(tree), /看不出你是否逐条读过/)
})

test('suggestBatchIds：从「下一步」文案里抠编号，抠不到就取未核前几条', async () => {
  const { mod } = await load()
  assert.deepEqual(mod.__views.suggestBatchIds({ action: '让我批量标：F1、F2、F3' }).slice(0, 3), ['F1', 'F2', 'F3'])
  const items = [
    { kind: 'fact', id: 'F8', result: null },
    { kind: 'fact', id: 'F9', result: 'ok' },
    { kind: 'fact', id: 'F10', result: null },
  ]
  assert.deepEqual(mod.__views.suggestBatchIds({ action: '没有编号' }, items), ['F8', 'F10'])
})

test('核对进度只显示当前页，不拿全案合计误导人', async () => {
  const { mod, harness } = await load()
  const ck = {
    done: 81, total: 153, pending: 72, fix: 0, doubt: 0, stale: 0,
    summary: '核对进度：已核 81/153｜未核 72',
    kinds: {
      fact: { kind: 'fact', label: '事实台账', total: 81, done: 81, pending: 0, fix: 0, doubt: 0, stale: 0 },
      finding: { kind: 'finding', label: '结论台账', total: 16, done: 0, pending: 16, fix: 0, doubt: 0, stale: 0 },
      material: { kind: 'material', label: '材料清单', total: 56, done: 0, pending: 56, fix: 0, doubt: 0, stale: 0 },
    },
    items: [],
  }
  const base = {
    detail: Object.assign({}, DETAIL, { caseType: 'litigation', caseTypeLabel: '诉讼/争议', review: null }),
    setTab: () => {},
    tabData: { facts: { facts: [], summary: '' } },
    verifyResult: null, runVerify: () => {}, busy: false, running: false, tabErr: null,
    actions: {}, notice: null, checkoff: ck, checker: '张三', onCheckerChange: () => {}, onSign: () => {},
  }
  const factTree = await harness.render(mod.__views.DetailPane, Object.assign({}, base, { tab: '事实' }))
  assert.match(textOf(factTree), /事实台账 81\/81/, '事实页应显示事实自己的进度')
  assert.ok(!/81\/153/.test(textOf(factTree)), '不能把全案合计显示在事实页')

  const findTree = await harness.render(mod.__views.DetailPane, Object.assign({}, base, { tab: '结论', tabData: { findings: { items: [], summary: '' } } }))
  assert.match(textOf(findTree), /结论台账 0\/16/)
})

test('事实页筛选：全部/未核/已核 三档且带条数', async () => {
  const { mod, harness } = await load()
  const actions = { checkMap: new Map([['fact:F1', { kind: 'fact', id: 'F1', result: 'ok', by: '张三' }]]) }
  const tree = await harness.render(mod.__views.FactsView, {
    data: { facts: [{ id: 'F1', text: '已核的事实内容够长', file: 'a.pdf', locator: 'P1' }, { id: 'F2', text: '未核的事实内容够长', file: 'a.pdf', locator: 'P2' }], summary: '' },
    actions,
  })
  const text = textOf(tree)
  assert.match(text, /全部 2/)
  assert.match(text, /未核 1/)
  assert.match(text, /已核 1/)
})

test('验收页每条警告带「去处理 Fn」按钮，点了能跳转', async () => {
  const { mod, harness } = await load()
  const jumped = []
  const tree = await harness.render(mod.__views.VerifyView, {
    result: {
      verdict: 'needs_review',
      summary: '无硬性失败，但有 3 道待人工确认',
      checks: [
        {
          name: 'facts',
          title: '事实可追溯',
          status: 'warn',
          counts: { unchecked: 0, sourceIssues: 2, fails: 0 },
          items: [
            { level: 'warn', msg: '事实 F35 第 27 页的识别质量差（汉字占比过低，像 OCR 乱码）', ref: 'facts.jsonl' },
            { level: 'warn', msg: '事实 F65 引文在第 3 段（第 1 页），不是第 3 页', ref: 'facts.jsonl' },
          ],
        },
      ],
      mustFix: [],
    },
    onRun: () => {},
    busy: false,
    onGotoItem: (ref) => jumped.push(ref),
  })
  const text = textOf(tree)
  assert.match(text, /出处问题 2/, '要显示出处问题数（为 0 的项不显示，避免噪音）')
  // msg 要正常显示，不能是 JSON 串
  assert.ok(!/\\{"level"/.test(text), '不能把 JSON 原串怼到界面')
  const btns = tree.filter((n) => n.type === 'button' && /去处理/.test(String(n.props.children)))
  assert.ok(btns.length >= 2, '每条带编号的警告都要有跳转按钮')
  btns[0].props.onClick()
  assert.deepEqual(jumped, ['F35'])
})

test('事实页收到 focusId 时高亮那一条', async () => {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.FactsView, {
    data: { facts: [{ id: 'F35', text: '被聚焦的事实', file: 'a.pdf', locator: 'P27' }, { id: 'F36', text: '别的事实', file: 'a.pdf', locator: 'P28' }], summary: '' },
    actions: { checkMap: new Map() },
    focusId: 'F35',
  })
  const focused = tree.find((n) => n.props && n.props.key === 'F35')
  assert.ok(focused)
  assert.match(String(focused.props.style.border), /2px solid/, '被聚焦的那条要有加粗边框')
})
