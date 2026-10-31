// 宿主模型调用的薄封装：超时、取消、失败分类。
//
// 这一层只回答一个问题：**这次调用到底成功了没有**。
// 文档第七章「失败冒充成功」是这里唯一的设计目标：
//   超时 / 模型报错 / token 上限 / 模型去调工具 / 非正常结束 / 空返回 / 非 JSON
//   全部是**失败**，一条都不能变成「没有发现问题」。
//
// 不 import 宿主包：llm 由 index.js 注入后传进来，单测可注入假服务。

import { REVIEW_PURPOSE, REVIEW_TIMEOUT_MS } from './models.js'

/**
 * 从宿主流式分片里收集文本。
 *
 * 分片形状由 host 的 llm 服务定义：block-start / text-delta / usage / finish。
 * 这里只认 text-delta 的文本，其余一律忽略；**finish 是唯一可靠的终止信号**，
 * 没拿到 finish 就等于没结束（半截响应比没响应更危险）。
 */
export function collectStream(chunks) {
  const parts = []
  let finish = null
  let toolCalls = 0
  let deltas = 0
  for (const c of chunks || []) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text-delta' && typeof c.text === 'string') {
      parts.push(c.text)
      deltas += 1
    } else if (c.type === 'finish') {
      finish = c.reason || null
    } else if (c.type === 'tool-call' || c.type === 'tool-call-delta') {
      toolCalls += 1
    }
  }
  return { text: parts.join(''), finish, toolCalls, deltas }
}

/** 把宿主 finish.reason 翻译成可行动的失败（成功返回 null） */
export function classifyFinish(reason, { toolCalls = 0 } = {}) {
  if (!reason) {
    return fail('model/no-finish', '模型流没有正常结束（没有收到 finish）：本次审核结果不可用，请重试。')
  }
  const kind = String(reason.kind || '')
  if (kind === 'stop') {
    // 正常结束，但模型中途去调工具 → 它没按约定只回 JSON，不能当结果用
    if (toolCalls > 0) {
      return fail('model/tool-call', '模型返回了工具调用而不是审核结果 JSON（模型在试图操作工具）。请重试，或换一个模型。')
    }
    return null
  }
  if (kind === 'max-tokens') {
    return fail(
      'model/max-tokens',
      '模型输出达到 token 上限，审核结果被截断。合同太长时可分批审核，或改用输出上限更大的模型。'
    )
  }
  if (kind === 'aborted') {
    return fail('model/aborted', '模型调用已取消，本次没有产生任何审核结论。')
  }
  if (kind === 'tool-calls') {
    return fail('model/tool-call', '模型以工具调用结束，没有给出审核结果 JSON。请重试，或换一个模型。')
  }
  const f = reason.failure || {}
  const code = String(f.code || kind || 'MODEL_ERROR')
  const msg = String(f.message || '')
  // 这几类是常见且可自愈的，给出针对性说法，不要让人对着英文 code 猜
  if (code === 'NO_ADAPTER') {
    return fail('model/no-adapter', `找不到可用的模型适配器：${msg || '请检查 DSH 的模型配置'}`)
  }
  if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL' || code === 'AUTH') {
    return fail('model/auth', `模型凭据无效或缺失：${msg || '请在 DSH 里重新登录或配置密钥'}`)
  }
  if (code === 'RATE_LIMIT') return fail('model/rate-limit', `模型限流：${msg || '稍后重试'}`)
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return fail('model/quota', `模型额度不足：${msg || '请充值后再试'}`)
  if (code === 'CONTEXT_WINDOW_EXCEEDED') {
    return fail('model/context', `合同超出模型上下文窗口：${msg || '请改用上下文更大的模型，或分批审核'}`)
  }
  return fail('model/error', `模型调用失败（${code}）：${msg || '未提供详情'}`)
}

/**
 * 从模型文本里取出 JSON 对象。
 *
 * 只做 JSON.parse，**绝不 eval / 绝不执行**返回文本。
 * 允许的兜底仅一种：整段被 ```json 围栏包住，或前后有解释性废话时，
 * 取第一个 '{' 到最后一个 '}' 的切片再试一次——这是格式问题，不是执行问题。
 */
export function parseJsonObject(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return { ok: false, code: 'model/empty', message: '模型返回了空内容：本次没有产生审核结果，不能当作「没有风险」。' }

  const attempts = [raw]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced && fenced[1]) attempts.push(fenced[1].trim())
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1))

  let lastErr = null
  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v }
      lastErr = '返回的不是 JSON 对象'
    } catch (e) {
      lastErr = (e && e.message) || String(e)
    }
  }
  return {
    ok: false,
    code: 'model/not-json',
    message: `模型没有返回合法 JSON（${lastErr}）。原文开头：${raw.slice(0, 160)}`,
  }
}

/**
 * 调一次模型，拿回完整文本。
 *
 * @param {object} p
 * @param {object} p.llm            宿主 llm 服务（必须有 stream）
 * @param {{provider:string,model:string}} p.selection
 * @param {string} p.system
 * @param {string} p.user
 * @param {string} [p.sessionId]
 * @param {AbortSignal} [p.signal]  外部取消（界面「取消」按钮）
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ok:true,text:string}|{ok:false,code:string,message:string}>}
 */
export async function callModel({ llm, selection, system, user, sessionId, signal, timeoutMs = REVIEW_TIMEOUT_MS }) {
  if (!llm || typeof llm.stream !== 'function') {
    return fail('model/no-service', '宿主没有提供 llm 服务：当前环境不能执行 AI 审核，请改用「生成提示词」在对话里完成。')
  }
  if (!selection || !selection.provider || !selection.model) {
    return fail('model/empty', '没有指定审核模型。')
  }

  const ctrl = new AbortController()
  // 超时是可选的（0 / 未设 = 不设上限）。
  // 2026-11-01 用户明确：大合同 120 秒不够，不要做这个时间限制。
  // 该限制的是成本与可取消性，不是墙钟时间——真卡死有「取消」按钮（signal）。
  let timedOut = false
  const ms = Number(timeoutMs) || 0
  const timer = ms > 0
    ? setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, ms)
    : null
  if (timer && typeof timer.unref === 'function') timer.unref()

  // 外部取消要能传到流里；两个信号合成一个
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const options = {
      provider: selection.provider,
      model: selection.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      purpose: REVIEW_PURPOSE,
      signal: ctrl.signal,
    }
    if (sessionId) options.sessionId = sessionId

    // 超时/取消不能只靠 signal 生效：适配器不保证及时响应 abort
    // （真机上就见过 chunk 还在慢慢吐）。所以起一个"闸门" Promise，
    // 谁先结束就以谁为准——这样超时一定能打断等待，而不是等模型吐完再判超时。
    const gate = new Promise((_, reject) => {
      const onKill = () => reject(Object.assign(new Error('interrupted'), { code: 'INTERRUPTED' }))
      if (ctrl.signal.aborted) onKill()
      else ctrl.signal.addEventListener('abort', onKill, { once: true })
    })

    const pump = (async () => {
      const chunks = []
      for await (const ch of llm.stream(options)) chunks.push(ch)
      return chunks
    })()

    const chunks = await Promise.race([pump, gate])
    // 后台 pump 失败不要变成未处理的 rejection
    pump.catch(() => {})

    if (timedOut) {
      return fail('model/timeout', `模型调用超过 ${Math.round((timeoutMs || 0) / 1000)} 秒仍未完成，已中止。本次没有审核结论。`)
    }
    if (signal && signal.aborted) {
      return fail('model/aborted', '审核已取消，未产生任何结论。')
    }

    const got = collectStream(chunks)
    const bad = classifyFinish(got.finish, { toolCalls: got.toolCalls })
    if (bad) return bad
    if (!got.text.trim()) {
      return fail('model/empty', '模型正常结束但没有输出任何文本：本次没有产生审核结果，不能当作「没有风险」。')
    }
    return { ok: true, text: got.text }
  } catch (e) {
    if (timedOut) {
      return fail('model/timeout', `模型调用超过 ${Math.round((timeoutMs || 0) / 1000)} 秒仍未完成，已中止。本次没有审核结论。`)
    }
    if (signal && signal.aborted) return fail('model/aborted', '审核已取消，未产生任何结论。')
    if (e && (e.code === 'ABORTED' || e.code === 'INTERRUPTED')) return fail('model/aborted', '模型调用被中止，未产生任何结论。')
    return fail('model/error', `模型调用异常：${(e && e.message) || e}`)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function fail(code, message) {
  return { ok: false, code, message }
}

export const _internals = { fail }
