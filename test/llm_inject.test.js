// 「宿主配了模型，AI 审核却说没有 llm 服务」——2026-11-01 用户本地实测。
//
// 根因：插件对 llm / agentDefaultModel 只用一次性的 ctx.get() 探测。
// 服务若比插件晚就绪，那一刻拿到 null；之后再没人重试，于是
//   · models.list 永远空 → 界面选不到模型
//   · note.aiReview 永远报「宿主没有提供 llm 服务」
// 而宿主里明明配了 deepseek / openai-gateway。
//
// tool 与 connection 一直用 ctx.inject 等（见 index.js 里那两处），llm 漏了。
// 官方 practices.md 第 20 条也写明：可选服务要放进 inject 或 ctx.inject([...], fn)，
// 这样缺它的 profile 里插件保持 inactive 而不是抛错。
//
// 这组测试锁住：服务晚到必须能被补上，且缺失时插件不能崩。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')

/**
 * 假 ctx：能控制某个服务"此刻是否就绪"，并能手动触发 inject 回调。
 * 关键点——get() 对未 inject 的服务会抛（cordis 4 的真实行为），这里如实模拟。
 */
function fakeCtx() {
  const services = {} // name -> 值；undefined = 尚未就绪
  const injectCbs = [] // { names, fn }
  const logs = []
  let disposed = false

  const ctx = {
    get(name) {
      if (!(name in services) || services[name] == null) {
        const err = new Error(`cannot get property "${name}" without inject`)
        throw err
      }
      return services[name]
    },
    inject(names, fn) {
      if (typeof names === 'function') {
        // 数组省略写法：inject(fn)
        injectCbs.push({ names: null, fn: names })
        return
      }
      injectCbs.push({ names, fn })
    },
    on: () => () => {},
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get disposed() {
      return disposed
    },
  }
  return {
    ctx,
    logs,
    /** 让某个服务就绪，并触发等待它的 inject 回调 */
    makeReady(name, value) {
      services[name] = value
      for (const c of injectCbs) {
        if (c.names && c.names.includes(name)) {
          try {
            c.fn(ctx)
          } catch (e) {
            /* 插件自己的 try/catch 之外不再抛 */
          }
        }
      }
    },
    injectCbs,
  }
}

async function loadApply() {
  const m = await import(`${INDEX}?t=${Date.now()}`)
  assert.equal(typeof m.apply, 'function', 'index.js 必须导出 apply')
  return m.apply
}

test('llm 服务晚于插件就绪时，必须被补上（不能永远取不到）', async () => {
  const apply = await loadApply()
  const f = fakeCtx()
  // 初始化阶段：llm 还没就绪。插件不能让 apply 抛出去（否则整个前端起不来）。
  assert.doesNotThrow(() => apply(f.ctx, {}))

  const waited = f.injectCbs.map((c) => c.names).filter(Boolean).flat()
  assert.ok(waited.includes('llm'), '必须对 llm 用 ctx.inject 等它出现，而不是只 get 一次')

  // 服务出现
  const fakeLlm = { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [] }
  f.makeReady('llm', fakeLlm)

  // 现在必须能取到——原来这里恒为 null
  const got = f.ctx.get('llm')
  assert.equal(got, fakeLlm, '服务就绪后 ctx.get 应能取到')
})

test('llm 一直不存在时，插件照常加载、get 抛错但不外泄', async () => {
  const apply = await loadApply()
  const f = fakeCtx()
  assert.doesNotThrow(() => apply(f.ctx, {}), '没有 llm 的宿主里插件也必须能加载')
  assert.throws(() => f.ctx.get('llm'), /without inject/, '未就绪时 get 抛错是 cordis 的既定行为')
})

test('agentDefaultModel 同样要等，不能只在初始化时抓一次', async () => {
  const apply = await loadApply()
  const f = fakeCtx()
  assert.doesNotThrow(() => apply(f.ctx, {}))
  const waited = f.injectCbs.map((c) => c.names).filter(Boolean).flat()
  assert.ok(waited.includes('agentDefaultModel'), '默认模型也要 inject 等待')
})

test('inject 回调内部的异常不能冒出来（otherwise 插件 fiber 变 failed）', async () => {
  const apply = await loadApply()
  const f = fakeCtx()
  assert.doesNotThrow(() => apply(f.ctx, {}))
  // 造一个"读 cctx.llm 就抛"的怪 ctx，验证插件自己兜住
  assert.doesNotThrow(() => {
    for (const c of f.injectCbs) {
      if (c.names && c.names.includes('llm')) {
        try {
          c.fn({ get() { throw new Error('boom') } })
        } catch (e) {
          throw e
        }
      }
    }
  }, '回调里读服务失败必须被插件 try/catch 住')
})
