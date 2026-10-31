// LawCase 律案编排与验收助手 · DSH 宿主侧插件
//
// 设计原则：**确定性台账 + 可选宿主模型审核**。
//   - 插件负责：编号、校验、追溯、状态机、报告骨架、AI 输出闸门（确定性、可复现）
//   - 宿主模型负责：条款含义、风险分级、替换措辞（语言判断）
//   - 人负责：采纳/丢弃、最终判断
//
// 为什么改成"可以调模型"：模型能力由宿主以服务形式注入（ctx.llm），
// 不需要插件自带 API Key。插件仍然自己决定"哪些模型输出算数"——
// 所有模型输出都必须过 lib/core/aivalidate.js 的确定性校验才能进草稿。
//
// 代码分层：
//   core/    纯函数与文件读写，不依赖宿主，可直接 node 跑（宿主 API 变了也能退成 CLI）
//   tools/   工具定义（薄壳）
//   index.js 只做装配与注册、宿主服务注入

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEXT_OUTPUT, wrap } from './tools/_shared.js'
import { defineRawTool, assertRawSchema } from './schema.js'
import { createApi } from './server/api.js'
import { resolveRoot, stateDir, appendLog } from './core/paths.js'
import { setAuditSink } from './core/store.js'
import { writeAudit, pruneAudit } from './core/audit.js'
import { pingTool } from './tools/ping.js'
import { caseTools } from './tools/case.js'
import { verifyTools } from './tools/verify.js'
import { procTools } from './tools/proc.js'
import { pipelineTools } from './tools/pipeline.js'
import { nextTools } from './tools/next.js'
import { deliverTools } from './tools/deliver.js'
import { skillTools } from './tools/skill.js'
import { ledgerTools } from './tools/ledger.js'
import { enterpriseTools } from './tools/enterprise.js'
import { lawTools } from './tools/law.js'
import { reviewTools } from './tools/review.js'
import { clauseTools } from './tools/clause.js'
import { precheckTools } from './tools/precheck.js'
import { checkoffTools } from './tools/checkoff.js'
import { sessionTools } from './tools/session.js'
import { findingTools } from './tools/finding.js'
import { materialTools } from './tools/material.js'
import { factTools } from './tools/fact.js'

const VERSION = '2.58.0'
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 模块加载即留痕（写到 /tmp，不依赖任何路径解析）：
// 用于区分「bundle 没被加载」和「加载了但注册失败」——这两种故障的修法完全不同。
try {
  const fs0 = await import('node:fs')
  const b = path.join(process.env.TMPDIR || '/tmp', 'lawcase-boot.log')
  fs0.appendFileSync(
    b,
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      argv1: process.argv[1] || null,
      pkgRoot: PKG_ROOT,
      cwd: process.cwd(),
    }) + '\n',
    'utf8'
  )
} catch (e) {
  // 留痕失败不影响插件
}

export const name = 'lawcase'

// 工作台/面板规范要求 Config 是 Schemastery schema（不能直接导普通对象）。
// 宿主里一定装了这个包；CLI 与单测环境可能没有，所以动态取，取不到就不导 Config
// （退回「无 schema」，老用法不受影响）。
const Schema = await import('@deepseek-ai/schemastery')
  .then((m) => (m && m.default) || m)
  .catch(() => null)

export const Config =
  Schema && typeof Schema.object === 'function'
    ? Schema.object({
        root: Schema.string()
          .default('auto')
          .description('案件总目录；auto = 不固定，依赖每次调用传的 case 参数'),
        readonlyRoots: Schema.array(Schema.string())
          .default([])
          .description('只读案卷白名单：写在这里的目录只读不写'),
        scanLimit: Schema.natural()
          .default(2000)
          .description('单次扫描的最大文件数，防止误扫巨型目录'),
        parseMaxMB: Schema.natural()
          .default(200)
          .description('单个文件超过此体积(MB)只登记不解析'),
      })
    : undefined

// 不走宿主 defineTool：它依赖 @deepseek-ai/dsh-tools，加载不到时会静默退化成
// 恒等函数，把作者 DSL 原样塞进 register()，被宿主验成
// `schema.properties.text.required is not supported on type "string"`。
// 改为 lib/schema.js 本地编译成 raw JSON Schema，注册路径完全自持。

export function apply(ctx, config = {}) {
  const root = resolveRoot(config, PKG_ROOT)
  const logFile = path.join(stateDir(root, PKG_ROOT), 'plugin.log.jsonl')
  const note = (rec) => appendLog(logFile, rec)

  // ---- 写入审计（机制 M1）---------------------------------------------------
  // 所有业务写入最终都走 core/store 的 log()；这里把审计落点接上，
  // 于是「谁、什么时候、对哪个案、干了什么」在插件侧也查得到。
  // 案件侧 log.jsonl 仍然是对外证据，两边不是重复，是一份记录两个读者。
  // 顺手每天清一次 30 天前的分片：审计不能长成第二座山。
  try {
    setAuditSink(({ caseDir, record, previous }) =>
      writeAudit({ pkgRoot: PKG_ROOT, record, caseDir, previous })
    )
    pruneAudit(PKG_ROOT, { keepDays: 30 })
  } catch (e) {
    note({ op: 'audit-sink-fail', error: String((e && e.message) || e) })
  }

  // ---- 宿主模型服务（可缺省）-------------------------------------------------
  // llm / agentDefaultModel 是**可选**依赖：宿主没装（或换了版本）时，
  // 插件必须照常工作，只是「AI 审核」按钮报错、退回「生成提示词」。
  // 关键：cordis 4 里未 inject 的服务连读都抛，所以只用 ctx.get() 探测，绝不 ctx.llm。
  const hostLlm = () => {
    try {
      return (typeof ctx.get === 'function' && ctx.get('llm')) || null
    } catch (e) {
      return null
    }
  }
  const hostDefaultModel = () => {
    try {
      return (typeof ctx.get === 'function' && ctx.get('agentDefaultModel')) || null
    } catch (e) {
      return null
    }
  }

  const pendingTools = []
  const pluginCtx = {
    version: VERSION,
    pkgRoot: PKG_ROOT,
    root,
    config,
    // 每次调用现取，不缓存：HMR/设置变更后服务可能是新的
    llm: hostLlm,
    defaultModel: hostDefaultModel,
    toolsRef: () => pendingTools.map((t) => t.name),
  }

  const T = (def) => {
    if (pendingTools.some((t) => t.name === def.name)) {
      note({ op: 'tool-dup', name: def.name })
      throw new Error('工具名重复：' + def.name)
    }
    pendingTools.push({
      ...def,
      output: def.output || TEXT_OUTPUT,
      // 把工具名和插件上下文一起交进去：wrap 要用它们做「会话↔案件」绑定校验
      execute: wrap(def.execute, { name: def.name, ctx: pluginCtx }),
    })
  }

  // ---- 工具清单 ----------------------------------------------------------
  T(pingTool(pluginCtx))
  for (const def of caseTools) T(def)
  for (const def of verifyTools) T(def)
  for (const def of procTools) T(def)
  for (const def of pipelineTools) T(def)
  for (const def of nextTools) T(def)
  for (const def of deliverTools) T(def)
  for (const def of skillTools) T(def)
  for (const def of ledgerTools) T(def)
  for (const def of enterpriseTools) T(def)
  for (const def of lawTools) T(def)
  for (const def of reviewTools) T(def)
  for (const def of precheckTools) T(def)
  for (const def of checkoffTools) T(def)
  for (const def of sessionTools) T(def)
  for (const def of clauseTools) T(def)
  for (const def of findingTools) T(def)
  for (const def of materialTools) T(def)
  for (const def of factTools) T(def)

  // ---- 注册 --------------------------------------------------------------
  // tools 是 inject 服务，直接读 ctx.tools 会抛
  // `cannot get property "tools" without inject`。
  const registerTools = (tctx) => {
    let ok = 0
    const failed = []
    for (const def of pendingTools) {
      try {
        tctx.tools.register(defineRawTool(def))
        ok++
      } catch (e) {
        failed.push({ name: def.name, error: String((e && e.message) || e) })
      }
    }
    if (!failed.length) {
      const bad = []
      for (const def of pendingTools) {
        const compiled = defineRawTool(def)
        for (const msg of assertRawSchema(compiled.parameters, def.name + '.parameters')) bad.push({ name: def.name, where: 'parameters', msg })
        for (const msg of assertRawSchema(compiled.output.schema, def.name + '.output')) bad.push({ name: def.name, where: 'output', msg })
      }
      note({ op: 'schema-selfcheck', ok: bad.length === 0, bad })
    }
    note({ op: 'tool-register', ok, total: pendingTools.length, failed })

    // 注册后自检：register() 不抛错 ≠ 工具真的进了 tools 服务。
    // 记下服务可用的读取接口，以及能否读回 lc_ping —— 下次重启看日志就能定性。
    try {
      const svc = tctx.tools
      const shape = {}
      for (const k of ['get', 'has', 'list', 'all', 'entries', 'registry']) {
        try { shape[k] = typeof svc[k] } catch (e) { shape[k] = 'ERR' }
      }
      let readable = null
      try {
        if (typeof svc.has === 'function') readable = { via: 'has', hit: svc.has('lc_ping') }
        else if (typeof svc.get === 'function') readable = { via: 'get', hit: !!svc.get('lc_ping') }
        else if (typeof svc.list === 'function') {
          const l = svc.list()
          readable = { via: 'list', count: Array.isArray(l) ? l.length : null, sample: Array.isArray(l) ? l.slice(0, 6) : null }
        }
      } catch (e) { readable = { error: String((e && e.message) || e) } }
      note({ op: 'tools-service-probe', shape, readable })
    } catch (e) {}
    if (failed.length) {
      // 注册失败必须留痕，否则表现为「工具莫名其妙不见了」
      for (const f of failed) note({ op: 'tool-register-fail', ...f })
    }
  }

  try {
    ctx.inject(['tools'], registerTools)
  } catch (e) {
    note({ op: 'tool-register-fail', name: '(inject)', error: String((e && e.message) || e) })
  }

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => note({ op: 'dispose', version: VERSION }))
    }
  } catch (e) {}

  // ---- 本机接口（工作台 / 插件面板用）--------------------------------------
  // agent 走 tools，界面走 /api/lawcase，两者共用 lib/core，互不依赖。
  // 挂载要经得起两件事：
  //   1) connection 可能比本插件晚出现 —— 所以 inject 等它；
  //   2) 已经就绪时不要傻等 —— 先试一次即时挂载；
  //   3) 挂载失败必须有日志（之前异常被吞，界面上就成了"案件根目录掉了"）。
  let apiRef = null
  let mounted = false
  const registerRoute = (scope) => {
    if (mounted) return
    const conn = scope && scope.connection
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') return
    mounted = true
    scope.effect(
      () =>
        conn.fetch.register({
          path: apiRef.apiPath,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {}
            try {
              body = await request.json()
            } catch (e) {
              body = {}
            }
            const result = await apiRef.handle(body && body.op, body && body.payload)
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            })
          },
        }),
      'lawcase: api route'
    )
    note({ op: 'api-route', path: apiRef.apiPath, via: scope === ctx ? 'immediate' : 'inject', ops: apiRef.ops })
  }

  try {
    apiRef = createApi({
      version: VERSION,
      root,
      config,
      pkgRoot: PKG_ROOT,
      note,
      // 模型能力以函数形式交给接口层：每次请求现取，
      // 这样 llm 服务晚于插件就绪、或被 HMR 换掉，都不需要重启插件。
      llm: hostLlm,
      defaultModel: hostDefaultModel,
    })

    // 1) 即时尝试：connection 已就绪时不必等 inject
    try {
      const ready = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (ready) registerRoute(ctx)
      else note({ op: 'api-mount', result: 'connection not ready, waiting' })
    } catch (e) {
      note({ op: 'api-mount-fail', phase: 'immediate', error: String((e && e.message) || e) })
    }

    // 2) 等待服务出现（或补挂）
    ctx.inject(['connection'], (cctx) => {
      try {
        registerRoute(cctx)
      } catch (e) {
        note({ op: 'api-route-fail', phase: 'inject', error: String((e && e.message) || e) })
      }
    })
  } catch (e) {
    note({ op: 'api-route-fail', phase: 'setup', error: String((e && e.message) || e) })
  }

  note({ op: 'plugin-ready', version: VERSION, root, tools: pendingTools.map((t) => t.name) })
}

export const _internals = { VERSION, PKG_ROOT }
