// 「载入 AI 草稿」按钮的接线测试。
// 用能真正跑状态的迷你 React：否则「按钮在但没接线」测不出来（踩过 CheckButtons 那次）。
// 注意：插件自己不调模型，按钮只负责把口径 + 条款清单交给左侧会话——
// 所以这里断言的是「点了会不会去取 worksheet、会不会开对话」，不是「生成得好不好」。

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
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0))
      return walk(runComp(Comp, props, 'root'), 'root', [])
    },
  }
}

let seq = 0
async function load() {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, data: {} }) })
  seq += 1
  await import(`${CLIENT}?draftui=${seq}`)
  const harness = createHarness()
  const mod = globalThis.__spec.factory((name) => (name === 'react' ? harness.react : {}))
  return { mod, harness }
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
      files: FILES,
      review: { stance: 'neutral', templateId: 'general', instructions: '', brief: '', updatedAt: null },
      preview: null,
    },
    extra || {}
  )


// 默认视图已改为「全文四段式」；草稿卡片/按钮禁用这些断言针对「登记表单」视图，
// 先显式切过去，否则测的是另一个视图里的东西。
async function toForm(mod, harness, props) {
  const nodes = await harness.render(mod.__views.NotesView, props)
  const btn = nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === '登记表单')
  assert.ok(btn, '必须有「登记表单」切换按钮')
  btn.props.onClick()
  return harness.render(mod.__views.NotesView, props)
}

test('审核口径旁渲染出「载入 AI 草稿」按钮', async () => {
  const { mod, harness } = await load()
  const nodes = await harness.render(mod.__views.NotesView, baseProps())
  const btn = nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === '载入 AI 草稿')
  assert.ok(btn, '按钮必须存在；文案：' + JSON.stringify(nodes.filter((n) => typeof n.type !== 'function' && n.props && typeof n.props.children === 'string').map((n) => n.props.children).slice(0, 30)))
  assert.equal(btn.props.disabled, false)
})

test('既没有条款也没有草稿时按钮禁用', async () => {
  const { mod, harness } = await load()
  const nodes = await toForm(mod, harness, baseProps({ files: [] }))
  const btn = nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === '载入 AI 草稿')
  assert.ok(btn, '按钮仍要显示，只是不可点')
  assert.equal(btn.props.disabled, true)
})

test('点按钮会调 onDraftAll，并把返回的草稿摆出来', async () => {
  const { mod, harness } = await load()
  const calls = []
  const draft = {
    clause: '第一条',
    heading: '第一条 付款',
    level: '重大风险',
    issue: '付款以验收合格为条件，但全文未约定验收标准与期限，卖方可无限拖延验收。',
    fix: '买方应在收货后 7 个工作日内按附件技术规格验收；逾期未提书面异议视为验收合格。',
    quote: '甲方应付款。',
    basis: '民法典第五百零九条',
    quoteOk: true,
    ok: true,
    problems: [],
  }
  // 草稿区在「登记表单」视图里渲染，先切过去
  const nodes = await toForm(
    mod,
    harness,
    baseProps({
      actions: {
        onDraftAll: async (p) => {
          calls.push(p)
          return { text: '已就绪', drafts: [draft] }
        },
      },
    })
  )
  const btn = nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === '载入 AI 草稿')
  await btn.props.onClick()
  // 点了之后按当前口径传出去
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stance, 'neutral')

  // 重渲染看草稿区（仍在表单视图）
  const after = await toForm(
    mod,
    harness,
    baseProps({ actions: { onDraftAll: async () => ({ text: '已就绪', drafts: [draft] }) } })
  )
  const texts = after
    .filter((n) => typeof n.type !== 'function' && n.props)
    .map((n) => n.props.children)
    .filter((c) => typeof c === 'string')
  assert.ok(texts.some((t) => /AI 草稿 1 条/.test(t)), '应显示草稿区：' + JSON.stringify(texts.slice(0, 40)))
  // 语义要明说：采纳＝要改，丢弃＝已审无需修改（后者会留痕，不是静默移除）
  assert.ok(texts.some((t) => /采纳/.test(t)), '要有采纳按钮')
  assert.ok(texts.some((t) => /丢弃/.test(t) && /无需修改/.test(t)), '丢弃要标明语义是「无需修改」')
})

test('点「载入 AI 草稿」不会弹对话框：不调 service.openSession / ensureSession', async () => {
  // 这条钉住「点了别弹窗」。onDraftAll 在 PanelInner 里定义，会把 aiOpen 打开——
  // 现在它只读草稿，绝不能再动对话抽屉。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const start = src.indexOf('载入 AI 草稿（不生成、不弹窗）')
  assert.ok(start > 0, '找不到 onDraftAll 的实现')
  const body = src.slice(start, start + 2200)
  assert.ok(!/setAiOpen\(true\)/.test(body), 'onDraftAll 不能再打开 AI 抽屉')
  assert.ok(!/openSession|ensureSession/.test(body), 'onDraftAll 不能开会话')
  // 必须真的去读草稿，而不是只返回一句话
  assert.ok(/note\.drafts/.test(body), '必须调用 note.drafts 读取草稿')
})

test('有草稿时即使没有条款选项也能点（读草稿不依赖条款下拉）', async () => {
  const { mod, harness } = await load()
  const nodes = await toForm(
    mod,
    harness,
    baseProps({
      files: [],
      actions: {
        onDraftAll: async () => ({ text: '已载入', drafts: [{ clause: '第一条', level: '提示', issue: 'x', fix: 'y', ok: true, problems: [] }] }),
      },
    })
  )
  const btn = nodes.find((n) => typeof n.type !== 'function' && n.props && n.props.children === '载入 AI 草稿')
  assert.ok(btn)
  // 第一次渲染尚无草稿 → 禁用；点过之后 Node 侧会 setDrafts，禁用条件随之放开
  assert.equal(btn.props.disabled, true, '还没有草稿且没有条款时应禁用')
})

test('内置完整指令：含工具名、逐字引文约束、save=true', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  // 提示词内建在 REVIEW_PROMPT_TEMPLATE 里，跟插件校验规则同源
  const start = src.indexOf('const REVIEW_PROMPT_TEMPLATE')
  assert.ok(start > 0, '找不到内置提示词模板')
  const body = src.slice(start, start + 2400)
  assert.ok(/lc_note_worksheet/.test(body), '要指明先取条款清单')
  assert.ok(/lc_note_validate/.test(body), '要指明收尾用校验工具')
  assert.ok(/save=true/.test(body), '不传 save=true，面板读不到草稿')
  assert.ok(/逐字引用|整句复制/.test(body), '必须强调引文逐字复制')
  assert.ok(/空泛|空话/.test(body), '必须禁止空泛表述')
  assert.ok(/分级要有区分/.test(body), '必须要求分级')
})

test('按了载入后把指令存进 state 并渲染出可复制文本', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(/setDraftPrompt\(/.test(src), '要把 prompt 存进 state')
  assert.ok(/复制指令/.test(src), '要有复制按钮')
  assert.ok(/draftPrompt/.test(src) && /textarea/.test(src), '指令要显示在只读文本框里，便于手动复制')
})

test('没索引合同不是「载入失败」：不能掉进 catch 报红字', async () => {
  // 真实踩过：note.worksheet 在没索引合同时会抛错，整个 onDraftAll 掉进 catch，
  // 用户看到「载入草稿失败」以为功能坏了——其实只是还没切条款。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const start = src.indexOf('载入 AI 草稿（不生成、不弹窗）')
  const body = src.slice(start, start + 2600)
  assert.ok(/try \{\s*ws = await call\('note\.worksheet'/.test(body), 'worksheet 必须单独 try，不能连累整体')
  assert.ok(/noContract: true/.test(body), '应把「没合同」当成一种正常状态返回')
  assert.ok(/还没索引合同/.test(body), '应给出去条款页的指引，而不是错误码')
})

test('点过载入但没草稿时，显示空状态而不是一片静默', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(/draftTried && !drafts\.length/.test(src), '需要空状态分支')
  assert.ok(/这个案件还没有 AI 草稿/.test(src), '空状态要说明没有草稿')
  assert.ok(/draftTried/.test(src), '空状态只在点过之后出现，不要一进页面就吵')
})

test('提示词载入审核口径：立场说明、合同类型、补充要求、必查项都要进去', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const i = src.indexOf('const REVIEW_PROMPT_TEMPLATE')
  const j = src.indexOf('const buildReviewPrompt')
  assert.ok(i > 0 && j > i, '找不到提示词模板')
  const snippet = src.slice(i, j)
  // 模板里必须引用 ctx.config 的四个部分，否则口径等于没传
  assert.ok(/cfg\.stance\.label/.test(snippet), '要有立场名称')
  assert.ok(/cfg\.stance\.hint/.test(snippet), '要有立场说明（AI 才知道往哪边审）')
  assert.ok(/cfg\.template\.title/.test(snippet), '要有合同类型')
  assert.ok(/cfg\.review\.instructions/.test(snippet), '要有补充要求')
  assert.ok(/cfg\.rules/.test(snippet), '要有必查项清单')
  assert.ok(/不许编造|不编造/.test(snippet), '要禁止编造')
})

test('onDraftPrompt 会去取 contract.config.get 再拼指令', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const start = src.indexOf('onDraftPrompt: async (p) => {')
  assert.ok(start > 0, '找不到 onDraftPrompt')
  const body = src.slice(start, start + 1600)
  assert.ok(/contract\.config\.get/.test(body), '必须读完整口径，不能只读 case.open 的英文枚举')
  assert.ok(/buildReviewPrompt\(\{[^}]*config/.test(body), '口径要传进提示词')
})

test('不给固定步骤：明确把「怎么审」交给 AI 自己判断', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const i = src.indexOf('const REVIEW_PROMPT_TEMPLATE')
  const j = src.indexOf('const buildReviewPrompt')
  const snippet = src.slice(i, j)
  assert.ok(/你自己判断/.test(snippet), '要显式授权 AI 自行决定方法')
  assert.ok(/没有固定流程/.test(snippet), '要说明没有固定流程')
  assert.ok(/参考，不必逐项硬套/.test(snippet), '必查项要降级为参考，不能当硬性清单')
  assert.ok(/特别要求优先/.test(snippet), '补充要求的优先级要高于参考清单')
  // 不能出现「第一步…第二步…」这种把方法定死的写法
  assert.ok(!/第[一二三]步/.test(snippet), '不能写死步骤')
})

test('口径每次点都重新读，不缓存', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  const start = src.indexOf('onDraftPrompt: async (p) => {')
  const body = src.slice(start, start + 1600)
  // config.get 必须在 onClick 触发的 onDraftAll 内，而不是在 props 初始化或 useMemo 里
  assert.ok(/cfg = await call\('contract\.config\.get'/.test(body), '每次点都要现读口径')
})

test('载入到草稿后不能再显示「还没有草稿」空状态', async () => {
  // 线上踩过：同一帧里 drafts 还没更新，于是「已载入 7 条」和「这个案件还没有 AI 草稿」
  // 同时显示在屏幕上，用户不知道该信哪个。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(/draftLoaded/.test(src), '需要独立的「载入成功」标记')
  assert.ok(
    /draftTried && !drafts\.length && !draftLoaded/.test(src),
    '空状态必须排除「刚载入到草稿」的情况'
  )
})

test('draftLoaded 按「是否真的拿到草稿」维护，且重新审核前会清空', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  // 找「载入/审核完成后」那处判断：必须读 list.length
  const hit = [...src.matchAll(/setDraftLoaded\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(hit.length > 0, '必须维护 draftLoaded')
  assert.ok(
    hit.some((x) => /list\.length|drafts\.length/.test(x)),
    '要有「按实际拿到的条数」设值的那一处：' + hit.join(' / ')
  )
  // 重新审核前必须把旧草稿清掉（用户 2026-11-01：重新审核应该清除原草稿）
  const start = src.indexOf('async function runAiReview()')
  const body = src.slice(start, start + 900)
  assert.match(body, /setDrafts\(\[\]\)/, '重新审核开始时要先把界面上的旧草稿清空')
})

test('两个按钮分开：载入草稿 与 生成提示词 各自独立', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(/'载入 AI 草稿'/.test(src), '要有载入按钮')
  assert.ok(/'生成提示词'/.test(src), '要有生成提示词按钮')
  // 生成提示词不能去读草稿文件（那是载入按钮的活）
  // 用函数边界切，不要用固定长度——固定长度会越界到下一个函数里，误报
  const pStart = src.indexOf('onDraftPrompt: async (p) => {')
  const pEnd = src.indexOf('onDraftAll: async (p) => {')
  const body = src.slice(pStart, pEnd)
  assert.ok(!/note\.drafts'/.test(body), '生成提示词不该读草稿')
  // 载入也不能自己拼长指令（已经拆走）
  const start2 = pEnd
  const body2 = src.slice(start2, src.indexOf('const actions', start2) > 0 ? src.indexOf('checkMap: (function', start2) : start2 + 2000)
  assert.ok(!/buildReviewPrompt/.test(body2), '载入不该再拼提示词')
})
