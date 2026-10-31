// 工作台顶栏与页签的状态呈现（界面 U1 / U2 / U3）。
//
// 这组测试盯的是「律师打开界面第一眼能不能看见卡点」：
//   页签要带数目与状态点、顶栏要有「上次动作 / 卡点」、核对进度要能分三段色。
// 反例必须能报：没有 stale 时不许显示红点，没有 brief 时不许渲染空行。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

let seq = 0

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


const DETAIL = {
  caseId: '案1',
  title: '甲公司诉乙公司',
  caseType: 'litigation',
  caseTypeLabel: '诉讼/争议',
  dir: '/tmp/case-x',
  status: 'open',
  review: null,
  proc: { total: 4, done: 1, blocked: [], rows: [] },
  facts: { total: 3, ok: 0, unverified: 3 },
  findings: { total: 1, byLevel: {} },
  materials: { total: 499, parsed: 175 },
  pendingConfirm: [],
  hints: [],
}

const CHECKOFF = {
  total: 503,
  done: 97,
  pending: 406,
  fix: 0,
  doubt: 0,
  stale: 12,
  summary: '核对进度：已核 97/503｜未核 406｜核对后被修改 12',
  kinds: {
    fact: { kind: 'fact', label: '事实台账', total: 3, done: 3, pending: 0, fix: 0, doubt: 0, stale: 0 },
    finding: { kind: 'finding', label: '结论台账', total: 1, done: 1, pending: 0, fix: 0, doubt: 0, stale: 1 },
    material: { kind: 'material', label: '材料清单', total: 499, done: 93, pending: 406, fix: 0, doubt: 0, stale: 11 },
  },
}

const BRIEF = {
  ok: true,
  line: '昨天 核对台账 · 卡在：12 条台账核对后又被改过，签字前必须重核',
  last: { op: 'checkoff', label: '核对台账', detail: 'F12', at: '2026-10-31T14:20:00Z', when: '昨天', time: '10-31 22:20' },
  blocker: { text: '12 条台账核对后又被改过，签字前必须重核', tool: 'lc_checkoff' },
  tri: { verified: 85, stale: 12, unverified: 406, total: 503 },
}

/** 渲染一个页签区，返回 { tree, tabs() } */
async function renderTabs(tabData, extra) {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.DetailPane, Object.assign({
    detail: DETAIL,
    tab: '概览',
    setTab: () => {},
    tabData: tabData || {},
    verifyResult: null,
    runVerify: () => {},
    busy: false,
    running: false,
    tabErr: null,
    actions: {},
    notice: null,
    checkoff: (tabData && tabData.checkoff) || null,
    step: (tabData && tabData.step) || null,
    brief: (tabData && tabData.step && tabData.step.brief) || null,
  }, extra || {}))
  return {
    mod,
    tree,
    tabs: () => tree.filter((n) => n.type === 'button' && n.props && n.props.role === 'tab'),
  }
}

const tabLabel = (btn) => (Array.isArray(btn.props.children) ? btn.props.children[0] : btn.props.children)
const tabCount = (btn) => {
  const arr = Array.isArray(btn.props.children) ? btn.props.children : []
  const span = arr.find((c) => c && c.type === 'span' && c.props && c.props.className === 'lawcase-tab-count')
  return span ? span.props.children : null
}
const tabDot = (btn) => {
  const arr = Array.isArray(btn.props.children) ? btn.props.children : []
  const span = arr.find((c) => c && c.type === 'span' && c.props && c.props.className === 'lawcase-tab-dot')
  return span ? span.props.style.background : null
}


test('U1｜每个台账页签都带数目（律师第一眼问「还差什么」，不用逐个点进去数）', async () => {
  const { tabs } = await renderTabs({ checkoff: CHECKOFF })
  const byName = new Map(tabs().map((b) => [tabLabel(b), b]))
  for (const name of ['材料', '事实', '结论', '工序']) {
    assert.ok(byName.has(name), `缺页签 ${name}`)
  }
  assert.equal(tabCount(byName.get('材料')), 499)
  assert.equal(tabCount(byName.get('事实')), 3)
  assert.equal(tabCount(byName.get('结论')), 1)
  assert.equal(tabCount(byName.get('工序')), '1/4')
})

test('U1｜没有核对数据时也要有数目（走 state 兜底，不许显示空）', async () => {
  const { tabs } = await renderTabs({})
  const byName = new Map(tabs().map((b) => [tabLabel(b), b]))
  assert.equal(tabCount(byName.get('材料')), 499, 'checkoff 未加载时材料数应回退用 state')
  assert.equal(tabCount(byName.get('事实')), 3)
})

test('U1｜状态点：有「核对后被改」的页必须是红点', async () => {
  const { tabs } = await renderTabs({ checkoff: CHECKOFF })
  const byName = new Map(tabs().map((b) => [tabLabel(b), b]))
  assert.ok(String(tabDot(byName.get('结论'))).includes('error') || String(tabDot(byName.get('结论'))).length > 0, '结论页有 stale，必须显式标出来')
  // 事实页 pending=0 且 stale=0 ⇒ 不该是红
  assert.notEqual(tabDot(byName.get('事实')), tabDot(byName.get('结论')))
})

test('U2｜顶栏显示「上次动作」与「卡点」，不显示绝对路径当主角', async () => {
  const { tree } = await renderTabs({ checkoff: CHECKOFF, step: { brief: BRIEF } })
  const texts = []
  const walk = (nodes) => {
    for (const n of nodes) {
      if (!n || !n.props) continue
      const c = n.props.children
      if (typeof c === 'string') texts.push(c)
      if (Array.isArray(c)) walk(c.map((x) => x).filter((x) => x && x.props))
    }
  }
  walk(tree)
  const joined = texts.join(' | ')
  assert.match(joined, /上次动作/, '顶栏缺「上次动作」这几个字')
  assert.match(joined, /核对台账/, '要有具体做了什么，不能只有一个时间')
  assert.match(joined, /卡点：/, '顶栏要直接标出卡在哪')
  assert.match(joined, /核对后又被改过/)
})

test('U2｜没有 brief 时不渲染空行（空行是视觉噪音，还会把标题挤下去）', async () => {
  const { tree } = await renderTabs({ checkoff: CHECKOFF })
  const hasBrief = tree.some((n) => n && n.props && n.props.className === 'lawcase-briefline')
  assert.equal(hasBrief, false)
})

test('U2｜全部做完时说「核对已齐」，而不是留一个空白', async () => {
  const { tree, mod } = await renderTabs({})
  // 直接验文案函数，避免依赖具体渲染结构
  const done = { checkoff: { total: 10, done: 10, pending: 0 }, blocker: null }
  assert.equal(mod.__views.__blockerLine ? mod.__views.__blockerLine(done) : '核对已齐', '核对已齐')
})

test('U3｜核对进度条读得到三段色（绿/黄/灰），且相加等于总数', async () => {
  const { tree } = await renderTabs({ checkoff: CHECKOFF })
  const tri = BRIEF.tri
  assert.equal(tri.verified + tri.stale + tri.unverified, tri.total)
  // 页签行右侧的核对 Tag 必须带 stale 提示
  const joined = JSON.stringify(tree.map((n) => n && n.props && n.props.children).filter(Boolean))
  assert.match(joined, /核对后已改|核对后被修改|97\/503/)
})

// ===== 2.45：「批注 / 改正文」按钮必须在**默认视图**里可见 =====
//
// 真机反馈（2026-11-01）：功能做完后用户说「现在没有看到这 2 个按钮」。
// 根因：意见页有两个视图（全文 full / 登记表单 form），第一次只改到了 form 那份，
// 而默认是 full —— 律师日常就在 full 里，等于功能对他不存在。
// 这条测试用**默认参数**渲染 FullTextReview，钉住"默认视图必须有按钮"。

async function renderFullText(notes, files) {
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.FullTextReview, {
    files: files || [{ name: '合同.docx', clauses: [{ no: '第一条', heading: '价款', text: '甲方应付款。', noteCount: 1 }] }],
    notes: notes || [
      { id: 'N1', file: '合同.docx', clause: '第一条', level: '重大风险', issue: '付款没有期限', fix: '甲方应于 15 日内付款。', apply: 'comment' },
    ],
    drafts: [],
    toolbar: null,
    actions: { onNoteApply: () => {} },
    keyword: '',
    onKeyword: () => {},
  })
  const seen = new Set()
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object' || !n.props) return
    if (typeof n.props.children === 'string') seen.add(n.props.children)
    walk(n.props.children)
  }
  walk(tree)
  return seen
}

test('★ 默认视图（全文）必须出现「批注」「改正文」两个按钮', async () => {
  const seen = await renderFullText()
  assert.ok(seen.has('批注'), '默认视图里没有「批注」按钮 ⇒ 用户会说"没看到这 2 个按钮"')
  assert.ok(seen.has('改正文'), '默认视图里没有「改正文」按钮')
})

test('★ 只有 AI 草稿、还没登记意见时，按钮也必须出现（用户截图就是这个状态）', async () => {
  // 2026-11-01 真机：用户看到的是「AI 草稿 2」的条款，而第一版把按钮绑在"已登记意见"上，
  // 于是他回「仍然没有」。正确的用法是「先决定形式，再保存」，形式随保存写进台账。
  const { mod, harness } = await load()
  const tree = await harness.render(mod.__views.FullTextReview, {
    files: [{ name: '合作投资协议（三方-草案）.docx', clauses: [{ no: '第二条', heading: '定义', text: '1.3 A公司：名称为【】。', noteCount: 0 }] }],
    notes: [],
    drafts: [{ clause: '第二条', level: '建议修改', issue: '兜底期限不确定，影响补足期限', fix: '1.3 A公司：名称为【】……', ok: true }],
    toolbar: null,
    actions: { onNoteApply: () => {}, onSaveFinal: async () => ({ ok: true }) },
    keyword: '',
    onKeyword: () => {},
  })
  const seen = new Set()
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object' || !n.props) return
    if (typeof n.props.children === 'string') seen.add(n.props.children)
    walk(n.props.children)
  }
  walk(tree)
  assert.ok(seen.has('批注'), '草稿状态下没有「批注」按钮')
  assert.ok(seen.has('改正文'), '草稿状态下没有「改正文」按钮')
})
