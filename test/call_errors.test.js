// 接口失败时，界面要说出「为什么」和「怎么办」。
//
// 真实背景：宿主自己的 /api 回包永远是 JSON（200 + {ok}）。所以只要拿到
// 502/503/504、或者根本不是 JSON，就说明请求在到达插件之前被中间层拦掉了
// ——最常见是本机代理把 127.0.0.1 也接管了，或一次请求太久被判超时。
// 以前这里只印「接口返回的不是 JSON（HTTP 502）」，用户完全不知道下一步干什么，
// 于是只能报「新建案件返回 502」这种查不下去的现象。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    Component: class {},
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
  await import(`${CLIENT}?callerr=${seq}`)
  return globalThis.__spec.factory((name) => (name === 'react' ? fakeReact() : {}))
}

/** 造一个只有 fetch 的响应；body 不是 JSON 时让它抛（模拟 502 的网关页） */
function stubFetch(impl) {
  globalThis.fetch = impl
}

test('call()：502 网关页 → 说清是中间层拦的，并给出「让 127.0.0.1 直连」的动作', async () => {
  const mod = await load()
  stubFetch(async () => ({
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token <') },
  }))
  await assert.rejects(
    () => mod.__views.call('pipeline.run', {}),
    (e) => {
      assert.match(e.message, /502/)
      assert.match(e.message, /中间层/)
      assert.match(e.message, /127\.0\.0\.1/)
      assert.equal(e.code, 'api/gateway')
      return true
    }
  )
})

test('call()：504 也要按超时/网关解释，而不是只说「不是 JSON」', async () => {
  const mod = await load()
  stubFetch(async () => ({
    status: 504,
    json: async () => { throw new SyntaxError('nope') },
  }))
  await assert.rejects(() => mod.__views.call('pipeline.run', {}), /中间层/)
})

test('call()：401 指向「别用外部浏览器开随机端口」', async () => {
  const mod = await load()
  stubFetch(async () => ({ status: 401, json: async () => ({ ok: false, error: { message: 'unauthorized' } }) }))
  await assert.rejects(
    () => mod.__views.call('cases.list', {}),
    (e) => {
      assert.match(e.message, /401/)
      assert.match(e.message, /桌面应用/)
      return true
    }
  )
})

test('call()：fetch 自己抛（连接被切）也要给人话，而不是 Failed to fetch', async () => {
  const mod = await load()
  stubFetch(async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(
    () => mod.__views.call('cases.list', {}),
    (e) => {
      assert.match(e.message, /连不上/)
      assert.equal(e.code, 'api/offline')
      return true
    }
  )
})

test('call()：正常的 {ok:true} 照常返回 data（别把错误处理写出新问题）', async () => {
  const mod = await load()
  stubFetch(async () => ({ status: 200, json: async () => ({ ok: true, data: { count: 5 } }) }))
  const data = await mod.__views.call('cases.list', {})
  assert.equal(data.count, 5)
})

test('call()：插件自己的业务错误要原样透出 code 与 message', async () => {
  const mod = await load()
  stubFetch(async () => ({
    status: 200,
    json: async () => ({ ok: false, error: { code: 'case/relative', message: '案件目录要给绝对路径' } }),
  }))
  await assert.rejects(
    () => mod.__views.call('pipeline.run', {}),
    (e) => {
      assert.equal(e.code, 'case/relative')
      assert.match(e.message, /绝对路径/)
      return true
    }
  )
})
