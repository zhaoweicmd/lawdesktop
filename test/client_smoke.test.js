// 客户端半区的冒烟测试：不渲染，只验证「模块能加载 + 两条挂载路径调对 API」。
// 渲染正确性只能在真实宿主里看（工作台/插件面板），这里挡的是低级错误：
// ModuleLoader id 写错、apply 里读不到服务、注册参数缺字段。

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
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    Component,
  }
}

let importSeq = 0

function fakeSlots() {
  return {
    inject: (_slot, fn) => {
      fn()
      return () => {}
    },
    register: () => () => {},
  }
}

async function loadModule() {
  let captured = null
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    __ModuleLoader__: {
      load: (spec) => {
        captured = spec
      },
    },
  }
  importSeq += 1
  await import(`${CLIENT}?v=${importSeq}`)
  assert.ok(captured, '客户端模块必须调用 window.__ModuleLoader__.load')
  return captured
}

test('ModuleLoader id 等于包名 lawcase，工厂返回 apply/inject', async () => {
  const spec = await loadModule()
  assert.equal(spec.id, 'lawcase')
  assert.equal(typeof spec.factory, 'function')
  const mod = spec.factory(fakeReact)
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})

test('有 desktopWorkbenches 时注册工作台：title/repository/业务整页 + dispose 归 effect', async () => {
  const spec = await loadModule()
  const mod = spec.factory(fakeReact)
  const calls = []
  const wb = {
    register: (meta, Component) => {
      calls.push({ meta, Component })
      return () => {}
    },
  }
  const ctx = {
    // 真实 cordis ctx 的规矩：未 inject 的服务只能走 ctx.get()，
    // 裸读 ctx.desktopWorkbenches 会抛 "cannot get property ... without inject"。
    get: (name) => (name === 'desktopWorkbenches' ? wb : undefined),
    slots: fakeSlots(),
    effect: (fn, label) => {
      calls.push({ effectLabel: label })
      fn()
    },
  }
  mod.apply(ctx)
  const reg = calls.find((c) => c.meta)
  assert.ok(reg, '必须调用 desktopWorkbenches.register')
  assert.equal(reg.meta.title, '律案工作台')
  assert.match(reg.meta.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, '工作台身份要求规范的 GitHub 仓库 URL')
  // 整页模式（customFrame）：宿主不再常驻左侧会话，对话入口与空状态由工作台自己给，
  // 「打开 AI 对话」才能打开真实抽屉（标准分栏下 conversation 节点不传给业务面板）。
  assert.equal(reg.meta.customFrame, true)
  assert.equal(reg.meta.headerLayout, 'compact')
  assert.equal(reg.meta.layout, undefined, '整页模式不再声明分栏布局')
  assert.equal(typeof reg.Component, 'function')
  assert.ok(calls.find((c) => c.effectLabel), '注册必须挂在 ctx.effect 下，卸载才能回收')
})

test('apply 内部抛异常也必须被吞掉（否则整个 web boot 失败）', async () => {
  const spec = await loadModule()
  const mod = spec.factory(fakeReact)
  const ctx = {
    get: () => {
      throw new ReferenceError('boom')
    },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
})

test('没有工作台服务时退回插件面板：sidebar.panellist + main 两个槽位', async () => {
  const spec = await loadModule()
  const mod = spec.factory(fakeReact)
  const registered = []
  const ctx = {
    slots: {
      inject: (slot, fn) => {
        fn()
        return () => {}
      },
      register: (opts, Component) => {
        registered.push({ opts, Component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  const panel = registered.find((r) => r.opts.name === 'sidebar.panellist')
  const main = registered.find((r) => r.opts.name === 'main')
  assert.ok(panel, '需要侧栏图标')
  assert.ok(main, '需要主面板')
  assert.equal(panel.opts.id, main.opts.key, '侧栏 id 必须与 main 的 key 同名才能联动')
  assert.equal(panel.opts.id, 'lawcase')
})

test('两种宿主都没有时不抛错（安静退场）', async () => {
  const spec = await loadModule()
  const mod = spec.factory(fakeReact)
  assert.doesNotThrow(() => mod.apply({}))
})
