// 新建案件交互测试：目录自动生成 + 目录点选 + 案型中文化。
//
// 现有 views_smoke 用 noop setState，只能证明「渲染不崩」。
// 这里补一个能真正跑状态的迷你 React（setState 会改值，再渲染就能看到结果），
// 否则「名称改了目录不跟着变」这类 bug 一条都测不出来。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function createHarness() {
  // hook 值按「组件在树里的位置 + hook 序号」存：位置固定则顺序稳定，
  // 条件分支（三元里的 null）也占位，不会让后面的组件错位。
  const stores = new Map()
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
    useEffect(fn) {
      effects.push(fn)
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
      // 组件节点本身也留着：要按 type.name 找它的 props（比如 DirPicker 的 onPick）
      out.push(node)
      walk(runComp(node.type, node.props, nodePath), nodePath, out)
      return out
    }
    out.push(node)
    const kids = node.children || []
    if (Array.isArray(kids)) kids.forEach((c, i) => walk(c, nodePath + '.' + i, out))
    return out
  }

  async function settle() {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0))
  }

  return {
    react,
    // 渲染一次：先跑组件，再把 effect 跑掉（fetch 用 mock），最后再渲染一次，
    // 让 effect 里 setState 的结果体现出来。
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
  await import(`${CLIENT}?newcase=${seq}`)
  const harness = createHarness()
  const mod = globalThis.__spec.factory((name) => (name === 'react' ? harness.react : {}))
  return { mod, harness }
}

function textOf(nodes) {
  return nodes
    .map((n) => (typeof n.props.children === 'string' || typeof n.props.children === 'number' ? String(n.props.children) : ''))
    .join(' ')
}

function findByText(nodes, text) {
  return nodes.find((n) => n.props && n.props.children === text)
}

function byPlaceholder(nodes, sub) {
  return nodes.find((n) => n.props && typeof n.props.placeholder === 'string' && n.props.placeholder.includes(sub))
}

function byCompName(nodes, name) {
  return nodes.find((n) => typeof n.type === 'function' && n.type.name === name)
}

const BASE = { activeDir: null, running: false, notice: null, root: '/Users/x/cases' }

async function openNewForm(harness, mod, props) {
  const tree = await harness.render(mod.__views.ActionBar, props)
  findByText(tree, '新建案件').props.onClick()
  return harness.render(mod.__views.ActionBar, props)
}

test('只填案件名称：目录名自动生成在案件根目录下，不用手打路径', async () => {
  const { mod, harness } = await load()
  let tree = await openNewForm(harness, mod, BASE)

  const titleInput = byPlaceholder(tree, '案件名称')
  assert.ok(titleInput, '应有「案件名称」输入框')
  titleInput.props.onChange({ target: { value: '甲公司诉乙公司' } })
  tree = await harness.render(mod.__views.ActionBar, BASE)

  const dirInput = byPlaceholder(tree, '案件目录')
  assert.ok(dirInput, '应有案件目录框')
  assert.equal(dirInput.props.value, '/Users/x/cases/甲公司诉乙公司', '目录应由名称自动生成')
  assert.match(textOf(tree), /将建在：\/Users\/x\/cases\/甲公司诉乙公司/)
})

test('名称里的非法字符被换掉，不会建出打不开的目录', async () => {
  const { mod } = await load()
  assert.equal(mod.__views.dirNameOf('甲/乙:丙*丁?戊"己<庚>辛|壬'), '甲-乙-丙-丁-戊-己-庚-辛-壬')
  assert.equal(mod.__views.dirNameOf('  多   空格  '), '多 空格')
  assert.equal(mod.__views.dirNameOf(''), '')
  assert.equal(mod.__views.joinDir('/a/b/', 'c'), '/a/b/c')
  assert.equal(mod.__views.joinDir('', 'c'), 'c')
})

test('案型下拉显示中文，落盘值仍是英文（core 只认 litigation/contract）', async () => {
  const { mod, harness } = await load()
  const tree = await openNewForm(harness, mod, BASE)
  const options = tree.filter((n) => n.type === 'option')
  assert.deepEqual(options.map((o) => o.props.children), ['诉讼/争议', '合同审核'])
  assert.deepEqual(options.map((o) => o.props.value), ['litigation', 'contract'])
})

test('点「选择位置」选父目录后，目录跟着名称走（不把案子建在父目录自己身上）', async () => {
  const { mod, harness } = await load()
  let tree = await openNewForm(harness, mod, BASE)
  byPlaceholder(tree, '案件名称').props.onChange({ target: { value: '甲公司诉乙公司' } })
  tree = await harness.render(mod.__views.ActionBar, BASE)

  findByText(tree, '选择位置').props.onClick()
  tree = await harness.render(mod.__views.ActionBar, BASE)
  assert.ok(findByText(tree, '选定此目录'), '点开选择位置后应出现目录选择器')

  const picker = byCompName(tree, 'DirPicker')
  assert.ok(picker, '应能拿到目录选择器的 props')
  assert.equal(picker.props.open, true)
  picker.props.onPick('/Users/x/court')
  tree = await harness.render(mod.__views.ActionBar, BASE)

  assert.equal(byPlaceholder(tree, '案件目录').props.value, '/Users/x/court/甲公司诉乙公司')
})

test('手动改过目录就按手动来；点「自动」回到按名称生成', async () => {
  const { mod, harness } = await load()
  let tree = await openNewForm(harness, mod, BASE)
  byPlaceholder(tree, '案件名称').props.onChange({ target: { value: '案子一' } })
  tree = await harness.render(mod.__views.ActionBar, BASE)

  byPlaceholder(tree, '案件目录').props.onChange({ target: { value: '/elsewhere/自定目录' } })
  tree = await harness.render(mod.__views.ActionBar, BASE)
  assert.equal(byPlaceholder(tree, '案件目录').props.value, '/elsewhere/自定目录')
  assert.match(textOf(tree), /已手动指定/)

  findByText(tree, '自动').props.onClick()
  tree = await harness.render(mod.__views.ActionBar, BASE)
  assert.equal(byPlaceholder(tree, '案件目录').props.value, '/Users/x/cases/案子一')
})

test('名称或目录为空时「建案并扫描」不可点；都有值时把自动目录原样交给宿主', async () => {
  const { mod, harness } = await load()
  const calls = []
  const props = Object.assign({}, BASE, {
    onNewCase: (f) => calls.push(f),
    onScan: () => {},
    onDeliver: () => {},
    onReloadCase: () => {},
  })
  let tree = await openNewForm(harness, mod, props)
  assert.equal(findByText(tree, '建案并扫描').props.disabled, true, '名称为空时不能建')

  byPlaceholder(tree, '案件名称').props.onChange({ target: { value: '无材料也能建' } })
  tree = await harness.render(mod.__views.ActionBar, props)
  assert.equal(findByText(tree, '建案并扫描').props.disabled, false)

  findByText(tree, '建案并扫描').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].dir, '/Users/x/cases/无材料也能建')
  assert.equal(calls[0].title, '无材料也能建')
  assert.equal(calls[0].caseType, 'litigation', '默认案型是诉讼/争议')
})

test('没设案件根目录时，目录就只有名称（交给宿主按 root 解析，不乱拼）', async () => {
  const { mod, harness } = await load()
  const props = Object.assign({}, BASE, { root: '' })
  let tree = await openNewForm(harness, mod, props)
  byPlaceholder(tree, '案件名称').props.onChange({ target: { value: '仅名称' } })
  tree = await harness.render(mod.__views.ActionBar, props)
  assert.equal(byPlaceholder(tree, '案件目录').props.value, '仅名称')
})

test('目录选择器：关闭不渲染；打开有上一级/选定此目录；取消回调 onClose', async () => {
  const { mod, harness } = await load()
  const closed1 = await harness.render(mod.__views.DirPicker, { open: false, onPick: () => {}, onClose: () => {} })
  assert.equal(closed1.length, 0)

  let closed = 0
  const tree = await harness.render(mod.__views.DirPicker, {
    open: true,
    title: '选择案件位置',
    startDir: '/tmp',
    onPick: () => {},
    onClose: () => {
      closed += 1
    },
  })
  assert.ok(findByText(tree, '上一级'))
  assert.ok(findByText(tree, '选定此目录'))
  assert.ok(findByText(tree, '选择案件位置'))
  findByText(tree, '取消').props.onClick()
  assert.equal(closed, 1)
})

test('目录选择器：把服务端列出的子目录显示出来，案件目录带「案件」标记', async () => {
  const browseData = {
    dir: '/Users/x/cases',
    parent: '/Users/x',
    home: '/Users/x',
    isCase: false,
    truncated: false,
    sections: [
      { label: '主目录', path: '/Users/x' },
      { label: '案件根目录', path: '/Users/x/cases' },
    ],
    entries: [
      { name: '甲案', path: '/Users/x/cases/甲案', hasCase: true },
      { name: '乙案', path: '/Users/x/cases/乙案', hasCase: false },
    ],
  }
  const { mod, harness } = await load(async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.op === 'fs.browse') return { status: 200, json: async () => ({ ok: true, data: browseData }) }
    return { status: 200, json: async () => ({ ok: true, data: {} }) }
  })

  const picked = []
  const tree = await harness.render(mod.__views.DirPicker, {
    open: true,
    startDir: '/Users/x/cases',
    onPick: (p) => picked.push(p),
    onClose: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /甲案/)
  assert.match(text, /乙案/)
  assert.match(text, /主目录/, '常用位置要有')

  findByText(tree, '选定此目录').props.onClick()
  assert.deepEqual(picked, ['/Users/x/cases'], '默认选定当前目录')
})

test('目录选择器里点「选它」直接选定该子目录', async () => {
  const browseData = {
    dir: '/Users/x/cases',
    parent: '/Users/x',
    home: '/Users/x',
    isCase: false,
    truncated: false,
    sections: [],
    entries: [{ name: '甲案', path: '/Users/x/cases/甲案', hasCase: true }],
  }
  const { mod, harness } = await load(async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.op === 'fs.browse') return { status: 200, json: async () => ({ ok: true, data: browseData }) }
    return { status: 200, json: async () => ({ ok: true, data: {} }) }
  })
  const picked = []
  const tree = await harness.render(mod.__views.DirPicker, {
    open: true,
    startDir: '/Users/x/cases',
    onPick: (p) => picked.push(p),
    onClose: () => {},
  })
  const rows = tree.filter((n) => n.props && n.props.title === '/Users/x/cases/甲案')
  assert.equal(rows.length, 1, '应有子目录行')
  findByText(tree, '选它').props.onClick()
  assert.deepEqual(picked, ['/Users/x/cases/甲案'])
})
