// 工序表：拆解 / 推进
//
// 三条硬约束（来自需求：工序表拆解是六项技巧里的第一项）：
//   1. 每条工序必须有验收标准。没有验收标准的工序不是工序，是愿望——直接拒收。
//   2. 依赖必须成 DAG，不能成环（成环的工期表永远开不了工）。
//   3. 工序 done 必须其依赖全部 done。跳步就是漏做，漏做会在庭上被问出来。
//
// 工序状态：todo → doing → done；任意状态可 blocked（并记录阻塞原因）。

import fs from 'node:fs'
import path from 'node:path'
import { casePaths, readJson, writeJsonAtomic, appendJsonl, writeTextAtomic, nowIso } from './store.js'
import { renderProgressMd } from './case.js'

const STATUSES = ['todo', 'doing', 'done', 'blocked']

function loadCase(caseDirRaw) {
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const caseDir = path.resolve(String(caseDirRaw))
  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件（缺少 .lawcase/case.json）：${caseDir}`)
  if (!Array.isArray(c.proc)) c.proc = []
  return { caseDir, p, c }
}

/** 把外部的 processes（用 name 表依赖）编译成带 id 的工序数组，并做 DAG 校验 */
function compile(processes) {
  if (!Array.isArray(processes) || !processes.length) throw new Error('processes 不能为空：至少要有一道工序')

  const names = []
  for (let i = 0; i < processes.length; i++) {
    const p = processes[i] || {}
    const name = String(p.name || '').trim()
    if (!name) throw new Error(`第 ${i + 1} 道工序缺 name`)
    if (names.includes(name)) throw new Error(`工序名重复：${name}`)
    const acc = String(p.acceptance || '').trim()
    if (!acc) throw new Error(`工序「${name}」没有验收标准（acceptance）——没有验收标准的工序不算工序`)
    names.push(name)
  }

  const idOf = new Map(names.map((n, i) => [n, 'P' + (i + 1)]))

  const proc = processes.map((p, i) => {
    const depsRaw = Array.isArray(p.dependsOn) ? p.dependsOn : []
    const deps = []
    for (const d of depsRaw) {
      const key = String(d).trim()
      if (!idOf.has(key)) throw new Error(`工序「${p.name}」依赖了不存在的工序「${key}」`)
      deps.push(idOf.get(key))
    }
    return {
      id: idOf.get(String(p.name).trim()),
      name: String(p.name).trim(),
      inputs: p.inputs ? String(p.inputs) : '',
      outputs: p.outputs ? String(p.outputs) : '',
      acceptance: String(p.acceptance).trim(),
      dependsOn: deps,
      status: 'todo',
      acceptResult: false,
      note: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
  })

  // 环检测（DFS 三色）
  const byId = new Map(proc.map((p) => [p.id, p]))
  const color = new Map(proc.map((p) => [p.id, 0]))
  const stack = []
  const visit = (id) => {
    color.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id).dependsOn) {
      if (color.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d)).concat(d)
        throw new Error('工序依赖成环：' + cyc.join(' → '))
      }
      if (color.get(d) === 0) visit(d)
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const p of proc) if (color.get(p.id) === 0) visit(p.id)

  return proc
}

/** 提交工序表。已有 done 工序时默认拒绝覆盖（除非 force），避免把已干的活冲掉 */
export function planProcesses({ case: caseDirRaw, processes, replace = false, force = false } = {}) {
  const { caseDir, p, c } = loadCase(caseDirRaw)
  const proc = compile(processes)

  const oldDone = (c.proc || []).filter((x) => x.status === 'done')
  if (c.proc && c.proc.length && !replace) {
    throw new Error(`案件已有 ${c.proc.length} 道工序。要替换请传 replace=true（会丢弃现有进度）`)
  }
  if (oldDone.length && replace && !force) {
    throw new Error(`已有 ${oldDone.length} 道工序验收完成（${oldDone.map((x) => x.id).join('、')}）。覆盖会丢进度，需 force=true 确认`)
  }

  c.proc = proc
  if (!Array.isArray(c.pendingConfirm)) c.pendingConfirm = []
  c.pendingConfirm = c.pendingConfirm.filter((q) => !/工序拆解/.test(q))
  c.updatedAt = nowIso()
  writeJsonAtomic(p.caseJson, c)
  writeTextAtomic(p.progress, renderProgressMd(c))
  appendJsonl(p.log, { at: nowIso(), op: 'proc-plan', count: proc.length, replaced: !!replace, ids: proc.map((x) => x.id) })

  return {
    ok: true,
    caseId: c.caseId,
    dir: caseDir,
    count: proc.length,
    proc: proc.map((x) => ({ id: x.id, name: x.name, dependsOn: x.dependsOn, acceptance: x.acceptance })),
    progressFile: p.progress,
    next: proc.find((x) => x.dependsOn.length === 0) || proc[0],
  }
}

/** 推进一道工序的状态 */
export function updateProcess({ case: caseDirRaw, id, status, note = '', acceptResult } = {}) {
  const { caseDir, p, c } = loadCase(caseDirRaw)
  if (!id) throw new Error('id 不能为空：要推进哪道工序？')
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join('/')}，收到：${status}`)

  const target = (c.proc || []).find((x) => x.id === String(id))
  if (!target) throw new Error(`没有工序 ${id}（现有：${(c.proc || []).map((x) => x.id).join('、') || '无'}）`)

  if (status === 'done') {
    const blockedBy = (target.dependsOn || []).filter((d) => {
      const dep = c.proc.find((x) => x.id === d)
      return !dep || dep.status !== 'done'
    })
    if (blockedBy.length) {
      throw new Error(`工序 ${id} 依赖未完成（${blockedBy.join('、')}），不能标记 done——跳步会漏做`)
    }
  }
  if (target.status === 'done' && status !== 'done') {
    throw new Error(`工序 ${id} 已验收完成，不能退回 ${status}`)
  }

  const before = target.status
  target.status = status
  target.updatedAt = nowIso()
  if (note) target.note = String(note)
  if (acceptResult !== undefined) target.acceptResult = !!acceptResult

  c.updatedAt = nowIso()
  writeJsonAtomic(p.caseJson, c)
  writeTextAtomic(p.progress, renderProgressMd(c))
  appendJsonl(p.log, { at: nowIso(), op: 'proc-update', id, from: before, to: status, note: note || undefined })

  const done = c.proc.filter((x) => x.status === 'done').length
  return {
    ok: true,
    caseId: c.caseId,
    id,
    from: before,
    to: status,
    progress: { done, total: c.proc.length },
    progressFile: p.progress,
  }
}

/** 读工序表（给 agent 看当前该干什么） */
export function listProcesses({ case: caseDirRaw } = {}) {
  const { caseDir, c } = loadCase(caseDirRaw)
  const proc = c.proc || []
  const ready = proc.filter(
    (x) => x.status === 'todo' && (x.dependsOn || []).every((d) => (proc.find((y) => y.id === d) || {}).status === 'done')
  )
  return {
    ok: true,
    caseId: c.caseId,
    dir: caseDir,
    total: proc.length,
    done: proc.filter((x) => x.status === 'done').length,
    doing: proc.filter((x) => x.status === 'doing').map((x) => x.id),
    blocked: proc.filter((x) => x.status === 'blocked').map((x) => ({ id: x.id, note: x.note })),
    ready: ready.map((x) => ({ id: x.id, name: x.name, acceptance: x.acceptance })),
    proc: proc.map((x) => ({ id: x.id, name: x.name, status: x.status, dependsOn: x.dependsOn, acceptance: x.acceptance })),
  }
}
