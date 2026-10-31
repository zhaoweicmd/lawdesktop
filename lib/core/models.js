// 审核模型的目录与选择（宿主 llm 服务的适配层）
//
// 为什么要有它：以前「AI 审核」只是拼一段提示词让人自己去对话里跑——
// 插件根本没碰过模型。宿主其实把模型能力以服务形式注入了（ctx.llm），
// 所以按钮可以直接审核，不必绕一圈对话框。
//
// 两条硬边界：
//   1) **不新增任何 API Key**。凭据由宿主适配器持有，这里只列 provider/model 名单。
//   2) **模型不可用时必须报错，不能悄悄降级**。降级会把「没审」说成「没问题」。
//
// 本文件不 import 任何宿主包：llm 服务由调用方（index.js 注入后）传进来，
// 所以能脱离宿主用假服务直接测。

/**
 * 一次审核调用的墙钟上限。
 *
 * 2026-11-01 改为**不设上限**（0 = 不设）：
 *   原来固定 120 秒，小合同够用，但大合同（几十条、每批还要模型逐条分析）
 *   会被中途掐断，然后靠"切批重跑"补救——批次越多越慢，反而更容易超时。
 *   用户的判断是对的：**该限制的是成本与可取消性，不是墙钟时间**。
 *
 * 现在的做法：
 *   - 不设上限：让模型自己跑完（宿主/provider 各有自己的上限，真卡死有「取消」按钮）；
 *   - 仍然可取消：界面「取消」按钮走 AbortSignal，立刻中止；
 *   - 仍然分批：分批是为了**提示词预算**（单次塞不下整份合同），不是为了赶时间。
 *
 * 显式传 timeoutMs > 0 时仍然生效（测试、或用户想强制上限时用）。
 */
export const REVIEW_TIMEOUT_MS = 0

/** 可作为 purpose 的值：审计记录里用，便于区分「审核」与「对话」 */
export const REVIEW_PURPOSE = 'contract-review'

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/**
 * 读宿主默认模型（agentDefaultModel.currentSelection()）。
 * 宿主没装这个服务时返回 null —— 调用方据此提示「请指定模型」。
 */
export function defaultSelection(defaultModel) {
  if (!defaultModel || typeof defaultModel.currentSelection !== 'function') return null
  try {
    const s = defaultModel.currentSelection()
    if (!s || !s.provider || !s.model) return null
    const out = { provider: String(s.provider), model: String(s.model) }
    if (s.reasoningEffort !== undefined) out.reasoningEffort = String(s.reasoningEffort)
    return out
  } catch (e) {
    return null
  }
}

/**
 * 列模型目录：{ default, groups: [{id, name, models:[{id, name}]}], warnings[] }
 *
 * 刻意**不抛错**：界面要靠这份目录画下拉框，某个 provider 的发现失败
 * （密钥过期、端点不通）不该让整个下拉框空掉——失败原因进 warnings。
 */
export async function listModelCatalog({ llm, defaultModel, timeoutMs = 8000 } = {}) {
  const def = defaultSelection(defaultModel)
  const out = { default: def, groups: [], warnings: [] }
  if (!llm || typeof llm.listProviders !== 'function') {
    out.warnings.push('宿主没有提供 llm 服务：无法列出模型，也无法执行 AI 审核。')
    return out
  }

  let providers = []
  try {
    providers = llm.listProviders() || []
  } catch (e) {
    out.warnings.push(`读取 provider 列表失败：${(e && e.message) || e}`)
    return out
  }

  for (const p of providers) {
    const id = String((p && p.id) || '')
    if (!id) continue
    const group = { id, name: String((p && p.name) || id), models: [] }
    if (typeof llm.listModels !== 'function') {
      out.warnings.push(`${group.name}：该适配器不支持列出模型（listModels），只能手动指定 model。`)
      out.groups.push(group)
      continue
    }
    try {
      // 发现模型要走网络，必须设上限：界面不能因为一个端点挂住而白屏
      const models = await withTimeout(Promise.resolve(llm.listModels(id)), timeoutMs, `列 ${group.name} 模型超时`)
      for (const m of Array.isArray(models) ? models : []) {
        const mid = String((m && (m.id || m.model)) || '')
        if (!mid) continue
        group.models.push({ id: mid, name: String((m && m.name) || mid) })
      }
    } catch (e) {
      out.warnings.push(`${group.name}：${(e && e.message) || e}`)
    }
    out.groups.push(group)
  }

  if (!out.groups.length) out.warnings.push('没有任何已注册的模型 provider：请先在 DSH 里配置模型。')
  return out
}

/**
 * 把界面/参数交来的 modelSelection 解析成一次调用的 {provider, model}。
 *
 * 规则（严格，不猜）：
 *   · 空 = 跟随宿主默认模型；宿主默认也没有 → 报 model/empty
 *   · 指定了 provider/model → 必须在目录里仍可用，否则报 model/unavailable
 *     （模型下架后界面还留着旧值，必须让重选，不能拿旧值硬调）
 */
export async function resolveSelection({ modelSelection, llm, defaultModel } = {}) {
  const raw = modelSelection && typeof modelSelection === 'object' ? modelSelection : {}
  const provider = String(raw.provider || '').trim()
  const model = String(raw.model || '').trim()

  if (!provider && !model) {
    const def = defaultSelection(defaultModel)
    if (!def) {
      throw err('model/empty', '没有可用的审核模型：DSH 没有设置默认模型，本次也没有指定。请在「审核模型」里选一个。')
    }
    return { ...def, source: 'default' }
  }
  if (!provider || !model) {
    throw err('model/incomplete', `模型选择不完整：provider 与 model 必须同时给出（收到 provider="${provider}" model="${model}"）`)
  }

  const cat = await listModelCatalog({ llm, defaultModel })
  const group = cat.groups.find((g) => g.id === provider)
  if (!group) {
    throw err('model/unavailable', `所选模型已不可用：找不到 provider「${provider}」。请重新选择。`)
  }
  if (group.models.length && !group.models.some((m) => m.id === model)) {
    throw err('model/unavailable', `所选模型已不可用：${provider} 下没有「${model}」。请重新选择。`)
  }
  return { provider, model, source: 'explicit', providerName: group.name }
}

/** 把选择变成一句人话（界面与审计都用同一个写法） */
export function selectionLabel(sel, { providerName } = {}) {
  if (!sel || !sel.provider) return '跟随默认模型'
  return `${providerName || sel.providerName || sel.provider} / ${sel.model}`
}

function withTimeout(promise, ms, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(err('model/timeout', message)), Math.max(1, Number(ms) || 1))
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export const _internals = { withTimeout }
