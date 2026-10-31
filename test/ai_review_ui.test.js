// 「AI 审核全部条款」前端接线测试。
//
// 钉住的都是"界面看起来正常、其实没接线"的坑：
//   · 模型下拉必须来自 models.list，且分组标题不可选
//   · 点审核必须先确认（合同正文会发给模型），不会一点就发
//   · 失败必须显示原因，**不能**显示成「没有风险」
//   · 调用期间禁止重复点击（防重复计费）
//   · 「生成提示词 / 载入 AI 草稿」必须保留（人工路径不能被 AI 路径挤掉）

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
      return [stores.get(key), (v) => stores.set(key, typeof v === 'function' ? v(stores.get(key)) : v)]
    },
    useEffect(fn, deps) {
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
  react.Component.prototype.isReactComponent = {}
  function runComp(type, props, nodePath) {
    const sp = hookPath
    const si = hookIdx
    hookPath = nodePath
    hookIdx = 0
    try {
      return type(props)
    } finally {
      hookPath = sp
      hookIdx = si
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
  return {
    react,
    async render(Comp, props) {
      const first = walk(runComp(Comp, props, 'root'), 'root', [])
      for (const fn of effects.splice(0)) {
        try {
          await fn()
        } catch (e) {}
      }
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0))
      return walk(runComp(Comp, props, 'root'), 'root', [])
    },
  }
}

// 收集节点里所有可见文案
function texts(nodes) {
  const out = []
  const push = (t) => {
    if (t == null || t === false || t === true) return
    if (Array.isArray(t)) return t.forEach(push)
    if (typeof t === 'string' || typeof t === 'number') out.push(String(t))
    else if (typeof t === 'object') push(t.props && t.props.children)
  }
  for (const n of nodes) push(n.props ? n.props.children : null)
  return out.join(' ')
}

function findByText(nodes, needle) {
  return nodes.filter((n) => {
    const t = texts([n])
    return t.includes(needle)
  })
}

let seq = 0
async function load({ apiResult } = {}) {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  const calls = []
  globalThis.fetch = async (url, opts) => {
    let body = {}
    try {
      body = JSON.parse((opts && opts.body) || '{}')
    } catch (e) {}
    calls.push(body)
    const op = body.op
    if (op === 'models.list') {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            default: { provider: 'apigoto', model: 'deepseek-flash' },
            groups: [
              { id: 'apigoto', name: 'apigoto', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
              { id: 'conatus', name: 'conatus', models: [{ id: 'conatus-free', name: 'conatus-free' }] },
            ],
            warnings: [],
          },
        }),
      }
    }
    const data = apiResult ? apiResult(op, body) : {}
    return { status: 200, json: async () => data }
  }
  seq += 1
  await import(`${CLIENT}?aiui=${seq}`)
  const harness = createHarness()
  const mod = globalThis.__spec.factory((name) => (name === 'react' ? harness.react : {}))
  return { mod, harness, calls }
}


// 切到「登记表单」视图：确认横幅、草稿卡片、生成提示词都在那个视图里。
// 默认视图已改为「全文四段式」（通读优先），所以这些断言必须显式切换。
async function switchToForm(mod, harness, props) {
  const nodes = await harness.render(mod.__views.NotesView, props)
  const btn = findByText(nodes, '登记表单').find((n) => n.props && n.props.onClick)
  assert.ok(btn, '必须有「登记表单」切换按钮')
  btn.props.onClick()
  return harness.render(mod.__views.NotesView, props)
}

const FILES = [
  {
    name: '合同.docx',
    total: 2,
    clauses: [
      { no: '第一条', title: '第一条 付款', text: '甲方应付款。', noteCount: 0 },
      { no: '第二条', title: '第二条 交付', text: '乙方应交付。', noteCount: 0 },
    ],
  },
]

const baseProps = (extra) =>
  Object.assign(
    {
      data: { count: 0, notes: [] },
      actions: {},
      caseDir: '/tmp/some-case',
      files: FILES,
      review: { stance: 'neutral', templateId: 'general', instructions: '', brief: '', updatedAt: null },
      preview: null,
    },
    extra || {}
  )

test('AI 审核：模型下拉来自 models.list，默认项 + 分组标题（分组不可选）', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.NotesView, baseProps())
  const selects = nodes.filter((n) => n.type === 'select' && n.props['data-lawcase-testid'] === 'model-select')
  assert.equal(selects.length, 1, '必须渲染出审核模型下拉')

  const opts = []
  const collect = (c) => {
    if (Array.isArray(c)) return c.forEach(collect)
    if (c && typeof c === 'object') {
      if (c.type === 'option') opts.push(c)
      collect(c.props && c.props.children)
    }
  }
  collect(selects[0].props.children)
  const vals = opts.map((o) => o.props.value)
  assert.ok(vals.includes(''), '必须有「跟随默认」的空值项')
  assert.ok(
    opts.some((o) => (texts([o]) || '').includes('deepseek-flash')),
    '必须列出默认 provider 的模型'
  )
  // 分组标题是不可选的分隔项
  const groupHeads = opts.filter((o) => o.props.disabled && /conatus/.test(texts([o])))
  assert.ok(groupHeads.length >= 1, '分组标题要存在且禁用')
})

test('AI 审核：第一次点击只弹「确认发送」，不会立刻调模型', async () => {
  const { mod, harness, calls } = await load()
  let props = baseProps({
    actions: { onAiReview: async () => ({ ok: true, drafts: [], message: 'ok' }) },
  })
  let nodes = await switchToForm(mod, harness, props)
  let btn = findByText(nodes, 'AI 审核全部条款').find((n) => n.type !== 'div' && n.props && n.props.onClick)
  assert.ok(btn, '必须渲染出「AI 审核全部条款」按钮')
  btn.props.onClick()
  nodes = await switchToForm(mod, harness, props)
  const t = texts(nodes)
  assert.match(t, /确认发送/)
  assert.match(t, /发送给所选模型服务/, '必须明说合同正文会发给模型')
  // 还没真正发审核请求
  assert.equal(calls.filter((c) => c.op === 'note.aiReview').length, 0)
})

test('AI 审核：失败时显示失败原因，绝不显示成「没有风险」', async () => {
  const { mod, harness } = await load()
  let release
  const gate = new Promise((r) => (release = r))
  const props = baseProps({
    actions: {
      onAiReview: async () => {
        await gate
        return { ok: false, code: 'model/max-tokens', message: '模型输出达到 token 上限，审核结果被截断。' }
      },
    },
  })
  let nodes = await switchToForm(mod, harness, props)
  // 点两次：第一次确认，第二次真正发起
  findByText(nodes, 'AI 审核全部条款').find((n) => n.props && n.props.onClick).props.onClick()
  nodes = await harness.render(mod.__views.NotesView, props)
  findByText(nodes, '确认并审核').find((n) => n.props && n.props.onClick).props.onClick()
  release()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
  nodes = await harness.render(mod.__views.NotesView, props)
  const t = texts(nodes)
  assert.match(t, /AI 审核失败/)
  assert.match(t, /max-tokens/)
  assert.match(t, /不能当作「合同没有风险」/)
  assert.doesNotMatch(t, /没有发现问题/)
  assert.match(t, /重试/)
})

test('AI 审核：成功时把草稿摆出来，并显示实际模型与口径', async () => {
  const { mod, harness } = await load()
  let release
  const gate = new Promise((r) => (release = r))
  const props = baseProps({
    actions: {
      onAiReview: async () => {
        await gate
        return {
          ok: true,
          message: '模型给出 1 条问题：可采纳 1 条',
          drafts: [
            {
              clause: '第一条',
              level: '重大风险',
              severity: 'high',
              title: '预付风险',
              issue: '签约即全额付款且无验收条款，甲方付款后失去救济手段。',
              fix: '甲方应支付合同总价的【30%】作为预付款。',
              quote: '甲方应付款',
              quoteOk: true,
              status: 'ok',
              ok: true,
              problems: [],
              warnings: [],
            },
          ],
          model: { provider: 'apigoto', model: 'deepseek-flash', label: 'apigoto / deepseek-flash' },
          config: { brief: '立场：站在乙方立场｜类型：服务合同' },
          counts: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
          reviewId: 'R1',
          truncated: false,
          warnings: [],
        }
      },
    },
  })
  let nodes = await switchToForm(mod, harness, props)
  findByText(nodes, 'AI 审核全部条款').find((n) => n.props && n.props.onClick).props.onClick()
  nodes = await harness.render(mod.__views.NotesView, props)
  findByText(nodes, '确认并审核').find((n) => n.props && n.props.onClick).props.onClick()
  release()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
  nodes = await harness.render(mod.__views.NotesView, props)
  const t = texts(nodes)
  assert.match(t, /本次模型：apigoto \/ deepseek-flash/, '必须显示实际用了哪个模型')
  assert.match(t, /本次口径：立场：站在乙方立场/, '必须显示本次口径')
  assert.match(t, /AI 草稿 1 条/, '草稿列表要摆出来')
  assert.match(t, /采纳（要修改）/, '草稿要能采纳')
  assert.match(t, /丢弃（无需修改）/, '草稿要能丢弃')
})

test('AI 审核：保留「生成提示词」与「载入 AI 草稿」两条人工路径', async () => {
  const { mod, harness } = await load()
  // 「生成提示词」在登记表单视图里；「载入 AI 草稿」两种视图都有
  const full = await harness.render(mod.__views.NotesView, baseProps())
  assert.match(texts(full), /载入 AI 草稿/, '全文视图也要能载入 AI 草稿')

  const nodes = await switchToForm(mod, harness, baseProps())
  const t = texts(nodes)
  assert.match(t, /生成提示词/)
  assert.match(t, /载入 AI 草稿/)
})

test('AI 审核：没有模型时不报错崩掉，而是禁用并说明', async () => {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  globalThis.fetch = async (url, opts) => {
    let body = {}
    try {
      body = JSON.parse((opts && opts.body) || '{}')
    } catch (e) {}
    if (body.op === 'models.list') {
      return {
        status: 200,
        json: async () => ({ ok: true, data: { default: null, groups: [], warnings: ['宿主没有提供 llm 服务'] } }),
      }
    }
    return { status: 200, json: async () => ({ ok: true, data: {} }) }
  }
  seq += 1
  await import(`${CLIENT}?aiui=${seq}`)
  const harness = createHarness()
  const mod = globalThis.__spec.factory((name) => (name === 'react' ? harness.react : {}))
  const nodes = await harness.render(mod.__views.NotesView, baseProps())
  const sel = nodes.filter((n) => n.type === 'select' && n.props['data-lawcase-testid'] === 'model-select')
  assert.equal(sel.length, 1)
  assert.equal(sel[0].props.disabled, true, '没有模型时下拉要禁用')
  assert.match(texts(nodes), /跟随 DSH 默认模型/)
})

test('丢弃理由：输入框必须在每张草稿卡片里，且是选填', async () => {
  const { mod, harness } = await load()
  let release
  const gate = new Promise((r) => (release = r))
  const props = baseProps({
    actions: {
      onAiReview: async () => {
        await gate
        return {
          ok: true,
          message: 'ok',
          drafts: [
            {
              clause: '第一条', level: '重大风险', severity: 'high', title: 't',
              issue: '这是一个足够长的问题描述，说明该条款存在风险。',
              fix: '这是一个足够长的替换条文，可以直接粘回合同使用。',
              quote: '', quoteOk: null, status: 'ok', ok: true, problems: [], warnings: [],
            },
          ],
          model: { label: 'm' }, config: { brief: 'b' }, counts: { total: 1, ok: 1, warn: 0, fail: 0, skipped: 0 },
          reviewId: 'R', truncated: false, warnings: [],
        }
      },
    },
  })
  let nodes = await switchToForm(mod, harness, props)
  findByText(nodes, 'AI 审核全部条款').find((n) => n.props && n.props.onClick).props.onClick()
  nodes = await harness.render(mod.__views.NotesView, props)
  findByText(nodes, '确认并审核').find((n) => n.props && n.props.onClick).props.onClick()
  release()
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
  nodes = await harness.render(mod.__views.NotesView, props)

  const inputs = nodes.filter((n) => n.type === 'input' && /丢弃理由/.test(String(n.props.placeholder || '')))
  assert.equal(inputs.length, 1, '每张草稿卡片里都要有「丢弃理由」输入框（用户反馈找不到地方填）')
  assert.match(String(inputs[0].props.placeholder), /选填/)
  // 不当必填项：不能因为空就禁用丢弃按钮
  const discardBtn = findByText(nodes, '丢弃（无需修改）').find((n) => n.props && n.props.onClick)
  assert.ok(discardBtn, '丢弃按钮必须存在')
  assert.ok(!discardBtn.props.disabled, '理由留空时丢弃按钮不能禁用')
})

// ============================================================================
// 全文四段式视图（本次需求）
// ============================================================================

const FULL_FILES = [
  {
    name: '合同.docx',
    total: 2,
    clauses: [
      { no: '第一条', title: '付款', text: '甲方应于验收合格后十日内付款。', noteCount: 1 },
      { no: '第二条', title: '交付', text: '交付标准由双方另行确定。', noteCount: 0 },
    ],
  },
]

test('全文视图：整份合同一次列全，每条四段都在（原文/审核意见/建议修改/实际修改意见）', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: FULL_FILES,
    notes: [
      {
        id: 'N1',
        file: '合同.docx',
        clause: '第一条',
        level: '重大风险',
        issue: '付款与验收挂钩但未约定逾期违约金，甲方拖延验收时无从主张。',
        fix: '甲方应在验收合格后十日内支付；逾期付款按日万分之五计违约金。',
        quote: '甲方应于验收合格后十日内付款',
      },
    ],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
  })
  const t = texts(nodes)
  // 四段标题
  assert.match(t, /原文/)
  assert.match(t, /审核意见/)
  assert.match(t, /建议修改/)
  assert.match(t, /实际修改意见/)
  // 整份合同都列出来（不是只列一条）
  assert.match(t, /第一条/)
  assert.match(t, /第二条/)
  assert.match(t, /甲方应于验收合格后十日内付款/)
  assert.match(t, /交付标准由双方另行确定/)
  // 已登记意见进「审核意见」段
  assert.match(t, /付款与验收挂钩但未约定逾期违约金/)
  // 「实际修改意见」现在是**可编辑输入框**，已登记的定稿在 textarea 的 value 里
  const finalBox = nodes.find(
    (n) => n.type === 'textarea' && typeof n.props.placeholder === 'string' && /最终条文/.test(n.props.placeholder)
  )
  assert.ok(finalBox, '「实际修改意见」必须是可编辑的输入框（用户要求能自己填）')
  assert.match(String(finalBox.props.value), /逾期付款按日万分之五计违约金/, '要把已定稿的条文带进输入框')
})

test('全文视图：建议修改「有内容」时可复制，且复制的是建议文本身', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: FULL_FILES,
    notes: [],
    drafts: [
      {
        clause: '第一条',
        level: '重大风险',
        issue: '未约定逾期付款违约金，甲方延迟付款时乙方缺乏救济。',
        fix: '甲方逾期付款的，每日按未付金额万分之五支付违约金。',
        quoteOk: true,
        ok: true,
      },
    ],
    keyword: '',
    onKeyword: () => {},
  })

  // 数"复制按钮"有两个坑：
  //   ① 渲染工具会把组件走两遍（渲染→跑 effect→再渲染），同一按钮在 nodes 里出现两次；
  //   ② Select 等组件内部也有带 title 的按钮，只按 title 匹配会误算进来。
  // 所以：title + 文案双条件，再按 props 序列化去重。
  // 只认 FullTextReview 里**自己写的**那个按钮：它带 small:true。
  // 通用 Button 组件展开后会产生第二个同文案的节点（多出 type/disabled/aria-*），
  // 那是同一个按钮的另一种形态，不该算作第二个按钮。
  const copyBtns = nodes.filter(
    (n) => n.props && n.props.title === '复制这一段到剪贴板' && n.props.small === true && n.props.children === '复制'
  )
  // 第一条：建议修改有 AI fix（=1 个复制按钮）；实际修改意见无正式意见（空，不给按钮）
  // 第二条：两段都空（0 个）
  console.log('DEBUG copyBtns:', copyBtns.length, copyBtns.map((b) => Object.keys(b.props)))
  assert.equal(copyBtns.length, 1, '只有"有建议"的那一段才有复制按钮，且不能重复渲染')

  const t = texts(nodes)
  assert.match(t, /AI 草稿/, '未登记的草稿要标成 AI 草稿')
  assert.match(t, /未约定逾期付款违约金/)
})

test('全文视图：没有意见也没有草稿时，四段给出明确的空状态提示', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: [FULL_FILES[0]],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
  })
  const t = texts(nodes)
  assert.match(t, /暂无建议/)
  // 「审核意见」现在是可编辑输入框（律师能补写模型没提到的风险），
  // 没有内容时靠 placeholder 提示怎么写，而不是一句只读的"还没有审核意见"。
  const issueBoxes = nodes.filter(
    (n) => n.type === 'textarea' && typeof n.props.placeholder === 'string' && /审核意见/.test(n.props.placeholder)
  )
  assert.ok(issueBoxes.length >= 1, '没有意见时也要能直接写审核意见')
  // 「实际修改意见」同样永远可编辑
  const boxes = nodes.filter(
    (n) => n.type === 'textarea' && typeof n.props.placeholder === 'string' && /最终条文/.test(n.props.placeholder)
  )
  assert.ok(boxes.length >= 1, '没有意见时也要能直接填实际修改意见')
})

test('全文视图：关键词过滤只留命中的条款', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: FULL_FILES,
    notes: [],
    drafts: [],
    keyword: '验收',
    onKeyword: () => {},
  })
  const t = texts(nodes)
  assert.match(t, /甲方应于验收合格后十日内付款/, '命中的条款要在')
  assert.doesNotMatch(t, /交付标准由双方另行确定/, '未命中的条款要滤掉')
})

test('全文视图：空合同给可行动提示，而不是一片空白', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: [],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
  })
  assert.match(texts(nodes), /还没有索引合同/)
})

test('意见页默认就是全文四段式，且带「登记表单」切换入口', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.NotesView, baseProps())
  const t = texts(nodes)
  assert.match(t, /全文四段式/)
  assert.match(t, /登记表单/)
  // 默认必须能看到原文（=全文视图），而不是空的表单
  assert.match(t, /甲方应付款/)
})

// ============================================================================
// 审核意见合并成一条 + 实际修改意见可编辑并保存
// ============================================================================

const MULTI_DRAFTS = [
  { clause: '第十条', level: '建议修改', issue: '第一个风险点：逾期付款没有违约金上限。', fix: '建议文A', quoteOk: true, ok: true },
  { clause: '第十条', level: '重大风险', issue: '第二个风险点：解雇实习生仍要付全额服务费。', fix: '建议文B', quoteOk: true, ok: true },
  { clause: '第十条', level: '提示', issue: '第三个风险点：用餐补助金额空白。', fix: '建议文C', quoteOk: false, ok: true },
]

test('审核意见：同一条款的 N 个风险合并成一条，级别取最高', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第十条', text: '第十条 违约责任……', noteCount: 0 }] }],
    notes: [],
    drafts: MULTI_DRAFTS,
    keyword: '',
    onKeyword: () => {},
  })
  const t = texts(nodes)

  // 三个风险点都保留（合并≠丢弃）
  assert.match(t, /第一个风险点/)
  assert.match(t, /第二个风险点/)
  assert.match(t, /第三个风险点/)

  // 只出现**一个**「审核意见」段（合并成一条）
  const opHeads = nodes.filter((n) => n.props && n.props.children === '审核意见')
  const uniqHead = new Set(opHeads.map((n) => JSON.stringify(n.props)))
  assert.equal(uniqHead.size, 1, '「审核意见」只应有一段，不能一条风险一个段')

  // 级别取最高：重大风险（虽然还有建议修改/提示）
  assert.match(t, /重大风险/)
  // 草稿数量标注在合并后的标签上
  assert.match(t, /AI 草稿 3 条/)
  // 多条时正文带序号
  assert.match(t, /1\. 第一个风险点/)
})

test('实际修改意见：可编辑，默认带出建议文，保存时把编辑后的条文交给台账', async () => {
  const { mod, harness } = await load()
  const saved = []
  const props = {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第十条', text: '第十条 违约责任……', noteCount: 0 }] }],
    notes: [],
    drafts: MULTI_DRAFTS,
    keyword: '',
    onKeyword: () => {},
    actions: {
      onSaveFinal: async (p) => {
        saved.push(p)
        return { ok: true, summary: '已保存' }
      },
    },
  }
  let nodes = await harness.render(mod.__views.FullTextReview, props)

  const box = nodes.find(
    (n) => n.type === 'textarea' && typeof n.props.placeholder === 'string' && /最终条文/.test(n.props.placeholder)
  )
  assert.ok(box, '必须有可编辑的实际修改意见输入框')
  assert.match(String(box.props.value), /建议文A/, '默认要带出建议文，省去重打')

  // 人工改写成定稿
  box.props.onChange({ target: { value: '这是律师最终定稿的条文，已改成分期付款。' } })
  nodes = await harness.render(mod.__views.FullTextReview, props)

  const saveBtn = nodes.find((n) => n.props && n.props.children === '保存' && n.props.onClick && n.props.small)
  assert.ok(saveBtn, '要有「保存」按钮')
  await saveBtn.props.onClick()

  assert.equal(saved.length, 1, '点保存要调用 onSaveFinal')
  assert.equal(saved[0].fix, '这是律师最终定稿的条文，已改成分期付款。', '保存的是人改过的条文')
  assert.equal(saved[0].clause, '第十条')
  assert.equal(saved[0].level, '重大风险', '级别取合并后的最高级')
  assert.match(saved[0].issue, /第一个风险点/, '问题描述用合并后的审核意见')
})

test('实际修改意见：没有建议文时也可以直接手写（不从空白开始拦人）', async () => {
  const { mod, harness } = await load()
  const saved = []
  const props = {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第二条', text: '第二条 交付。', noteCount: 0 }] }],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
    actions: { onSaveFinal: async (p) => { saved.push(p); return { ok: true } } },
  }
  let nodes = await harness.render(mod.__views.FullTextReview, props)
  const box = nodes.find((n) => n.type === 'textarea' && /最终条文/.test(String(n.props.placeholder || '')))
  assert.equal(String(box.props.value), '', '没有建议时输入框是空的')

  box.props.onChange({ target: { value: '第二条 乙方应于收到付款后十个工作日内交付。' } })
  nodes = await harness.render(mod.__views.FullTextReview, props)
  const saveBtn = nodes.find((n) => n.props && n.props.children === '保存' && n.props.onClick && n.props.small)
  await saveBtn.props.onClick()

  assert.equal(saved.length, 1)
  assert.equal(saved[0].fix, '第二条 乙方应于收到付款后十个工作日内交付。')
})

test('实际修改意见：内容为空时保存按钮禁用（不允许空条文入库）', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.FullTextReview, {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第二条', text: '第二条 交付。', noteCount: 0 }] }],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
    actions: { onSaveFinal: async () => ({ ok: true }) },
  })
  const saveBtn = nodes.find((n) => n.props && n.props.children === '保存' && n.props.onClick && n.props.small)
  assert.equal(saveBtn.props.disabled, true, '空内容不能保存')
})

test('审核意见：可以手写（模型没提到的风险也要能写），保存时进台账', async () => {
  const { mod, harness } = await load()
  const saved = []
  const props = {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第十二条', text: '第十二条 争议解决……', noteCount: 0 }] }],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
    actions: { onSaveFinal: async (p) => { saved.push(p); return { ok: true } } },
  }
  let nodes = await harness.render(mod.__views.FullTextReview, props)

  // 审核意见输入框必须存在（这就是"我怎么加审核意见"的入口）
  const issueBox = nodes.find(
    (n) => n.type === 'textarea' && /审核意见/.test(String(n.props.placeholder || ''))
  )
  assert.ok(issueBox, '「审核意见」必须可编辑')

  // 律师手写一条模型没说过的风险
  issueBox.props.onChange({
    target: { value: '管辖条款约定「合同签订地法院」，但全文签订地点为空白，管辖法院无法确定。' },
  })
  nodes = await harness.render(mod.__views.FullTextReview, props)

  // 再写实际修改条文
  const fixBox = nodes.find((n) => n.type === 'textarea' && /最终条文/.test(String(n.props.placeholder || '')))
  fixBox.props.onChange({ target: { value: '因本合同引起的争议，双方应协商解决；协商不成的，向甲方住所地人民法院起诉。' } })
  nodes = await harness.render(mod.__views.FullTextReview, props)

  const saveBtn = nodes.find((n) => n.props && n.props.children === '保存' && n.props.onClick && n.props.small)
  await saveBtn.props.onClick()

  assert.equal(saved.length, 1, '手写的审核意见也要能保存')
  assert.match(saved[0].issue, /管辖条款约定/, '保存的必须是人写的那条意见')
  assert.match(saved[0].fix, /甲方住所地人民法院/, '保存的必须是人写的那条条文')
})

test('审核意见：只写条文、不写问题，也可以保存（字数与必填都放开了）', async () => {
  // 用户 2026-11-01：「这里不要给字数限制」，也不再强求问题与条文都填。
  // 仍然拦的只有一种：两边都空（登记一条空意见没有意义）。
  const { mod, harness } = await load()
  const props = {
    files: [{ name: '合同.docx', total: 1, clauses: [{ no: '第十二条', text: '第十二条 争议解决……', noteCount: 0 }] }],
    notes: [],
    drafts: [],
    keyword: '',
    onKeyword: () => {},
    actions: { onSaveFinal: async () => ({ ok: true }) },
  }
  let nodes = await harness.render(mod.__views.FullTextReview, props)
  const fixBox = nodes.find((n) => n.type === 'textarea' && /最终条文/.test(String(n.props.placeholder || '')))
  fixBox.props.onChange({ target: { value: '向甲方住所地起诉。' } })
  nodes = await harness.render(mod.__views.FullTextReview, props)

  const saveBtn = nodes.find((n) => n.props && n.props.children === '保存' && n.props.onClick && n.props.small)
  assert.equal(saveBtn.props.disabled, false, '只写条文也该能保存')
})
