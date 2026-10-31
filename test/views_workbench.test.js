// 工作台交互的冒烟测试：AI 抽屉与宿主 props 契约。
// 契约来自宿主实现（packages/dsh-desktop-workbenches/client.js）：
//   h(item.Component, { service, entry, active, conversation })
//   service.ensureSession({ folder }) / service.currentSession() / service.openSession(id)

import test from 'node:test'
import assert from 'node:assert/strict'
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
    __ModuleLoader__: { load: (spec) => { globalThis.__spec = spec } },
  }
  seq += 1
  await import(`${CLIENT}?wb=${seq}`)
  const react = fakeReact()
  return globalThis.__spec.factory((name) => (name === 'react' ? react : {}))
}

// 收集树里所有元素的 props（不展开子组件），用于找按钮
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return out
  }
  out.push(node)
  collect(node.children || [], out)
  return out
}

function findButton(tree, label) {
  const els = collect(tree)
  return els.find((el) => el && el.props && el.props.children === label && typeof el.props.onClick === 'function')
}

test('抽屉关闭时不渲染', async () => {
  const mod = await load()
  const out = mod.__views.AiDrawer({ open: false })
  assert.equal(out, null)
})

test('无会话时给出「用当前案件目录开会话」，点它调用 ensureSession(folder)', async () => {
  const mod = await load()
  const calls = []
  const service = {
    ensureSession: async (arg) => {
      calls.push(arg)
      return 'session-1'
    },
    currentSession: () => null,
    openSession: () => {},
  }
  const tree = mod.__views.AiDrawer({
    open: true,
    conversation: null,
    service,
    folder: '/Users/x/cases/某某案件',
    onClose: () => {},
    onStart: async () => {
      await service.ensureSession({ folder: '/Users/x/cases/某某案件' })
    },
    busy: false,
  })
  const btn = findButton(tree, '用当前案件目录开会话')
  assert.ok(btn, '应出现开会话按钮')
  await btn.props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].folder, '/Users/x/cases/某某案件')
})

test('有会话时把宿主给的 conversation 节点放进去，且不复制聊天界面', async () => {
  const mod = await load()
  const node = { type: 'div', props: { id: 'host-conversation' }, children: [] }
  const service = { currentSession: () => 'session-1', ensureSession: async () => 'session-1' }
  const tree = mod.__views.AiDrawer({
    open: true,
    conversation: node,
    service,
    folder: '/x',
    onClose: () => {},
    onStart: () => {},
    busy: false,
  })
  const found = collect(tree).some((el) => el && el.props && el.props.id === 'host-conversation')
  assert.ok(found, '宿主会话节点必须被挂进抽屉')
})

test('Panel 收到宿主 props 不抛错（forward 到 PanelInner）', async () => {
  const mod = await load()
  const service = { currentSession: () => null, ensureSession: async () => 's1' }
  assert.doesNotThrow(() => mod.__views.Panel({ service, entry: { id: 'lawdsh/lawcase' }, active: true, conversation: null }))
})
