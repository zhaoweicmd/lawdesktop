// 会话 ↔ 案件 绑定：解决「对话里的指令到底对哪个案件生效」。
//
// 问题现场（2026-10-25 踩过）：同一台机器上有两个同名案件目录（例如两份「某某合同纠纷案」），
// 面板在看 A，助手把事实写进了 B。工具只信 `args.case`，谁也没校验这个 case
// 是不是用户此刻正在看的那个案。
//
// 做法：
//   1. 每次工具调用都能拿到 exec.agent.id（宿主实证：exec.agent.id 是会话 id）
//   2. 维护「会话 → 案件目录」绑定，存在 <pkgRoot>/.lawcase-plugin/sessions.json
//   3. 统一在 wrap 里做校验：
//        · 没绑过 + 带了 case  → 首次绑定（自动，留痕）
//        · 已绑 + 带了不同的 case → **拒绝执行**，除非 payload 明确 allowRebind
//        · 已绑 + 没带 case → 自动补上绑定的案子（省得模型猜）
//   4. 面板可以读/改绑定，让人看得见「这个对话绑的是哪个案」
//
// 这一层的价值只有一个：**改错案卷是灾难性的**，宁可多一次报错。

import fs from 'node:fs'
import path from 'node:path'

const FILE = 'sessions.json'

function sessionsPath(pkgRoot) {
  return path.join(pkgRoot || '.', '.lawcase-plugin', FILE)
}

function readAll(pkgRoot) {
  const p = sessionsPath(pkgRoot)
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch (e) {
    return {}
  }
}

function writeAll(pkgRoot, data) {
  const p = sessionsPath(pkgRoot)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (e) {}
  return data
}

/** 会话 id：宿主把 Agent 放在 exec.agent 上，id 即会话标识 */
export function sessionIdOf(exec) {
  const a = exec && exec.agent
  if (!a) return null
  return a.id ? String(a.id) : null
}

export function getBinding(sessionId, { pkgRoot } = {}) {
  if (!sessionId) return null
  const all = readAll(pkgRoot)
  const hit = all[sessionId]
  return hit && hit.case ? hit : null
}

export function setBinding(sessionId, caseDir, { pkgRoot, title } = {}) {
  if (!sessionId) return null
  const all = readAll(pkgRoot)
  all[sessionId] = { case: caseDir, title: title || (all[sessionId] && all[sessionId].title) || '', at: new Date().toISOString() }
  writeAll(pkgRoot, all)
  return all[sessionId]
}

export function clearBinding(sessionId, { pkgRoot } = {}) {
  if (!sessionId) return null
  const all = readAll(pkgRoot)
  delete all[sessionId]
  writeAll(pkgRoot, all)
  return true
}

export function listBindings({ pkgRoot } = {}) {
  const all = readAll(pkgRoot)
  return Object.entries(all).map(([sessionId, v]) => ({ sessionId, case: v.case, title: v.title || '', at: v.at || null }))
}

/**
 * 在工具执行前统一裁决「这次调用作用于哪个案件」。
 *
 * @returns {{ caseDir: string|null, action: 'bound'|'rebound'|'same'|'none', error?: string }}
 */
export function resolveCaseForTool({ sessionId, argsCase, caseType = 'any', pkgRoot = '' } = {}) {
  const wanted = argsCase ? path.resolve(String(argsCase)) : null
  const bound = getBinding(sessionId, { pkgRoot })

  // 没有会话信息（CLI、单测、非会话调用）：不参与绑定，原样放行
  if (!sessionId) return { caseDir: wanted, action: 'none' }

  if (!bound) {
    if (!wanted) return { caseDir: null, action: 'none' }
    setBinding(sessionId, wanted, { pkgRoot })
    return { caseDir: wanted, action: 'bound' }
  }

  const boundDir = path.resolve(String(bound.case))
  if (!wanted) {
    // 没带 case：用绑定，省得模型自己猜
    return { caseDir: boundDir, action: 'same' }
  }
  if (wanted === boundDir) return { caseDir: wanted, action: 'same' }

  // 带了不同的案：这是最危险的情形，直接拒
  return {
    caseDir: null,
    action: 'conflict',
    error:
      `这个对话绑定的是「${bound.title || boundDir}」（${boundDir}），` +
      `而这次调用要动的是 ${wanted}。\n` +
      `为防止改错案卷，本次调用已拒绝。如果确实要切到另一个案子，` +
      `先在工作台面板里选中那个案件（或显式传 rebind=true 并在理由里说明）。`,
  }
}
