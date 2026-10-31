import fs from 'node:fs'
import path from 'node:path'
import { newCase, openCase } from './case.js'
import { scanMaterials, listMaterials } from './material.js'
import { parseAll } from './parse.js'
import { readJson, casePaths, log } from './store.js'

/**
 * 一键把「机械活」跑完：建案 → 扫材料 → 批量解析 → 报出还剩什么要人决定。
 *
 * 它不抽事实、不出结论、不定版本——那三件事要么需要读懂内容，要么需要判断，
 * 都不是流水线能代替的。流水线只负责把「不用动脑子但不能不做」的部分做完。
 */
export async function runPipeline({
  case: caseDirRaw,
  source,
  title,
  parties,
  cause,
  caseType = 'litigation',
  kind,
  limit = 200,
  hashMaxMB = 0,
  recursive = true,
}) {
  const dir = path.resolve(String(caseDirRaw))
  const steps = []
  const started = Date.now()

  // 1. 案件
  let created = false
  const cp = casePaths(dir)
  if (!fs.existsSync(cp.caseJson)) {
    if (!title) throw new Error('案件目录不存在。要新建请传 title（案件名称）')
    newCase({ dir, title, parties, cause, caseType, materialsDirs: source ? [path.resolve(source)] : [] })
    created = true
    steps.push({ step: '建案', ok: true, detail: `已建 ${path.basename(dir)}` })
  } else {
    steps.push({ step: '建案', ok: true, detail: '案件已存在，跳过' })
  }

  const c = readJson(cp.caseJson, null)
  if (!c) throw new Error(`${dir} 不是 LawCase 案件`)

  // 2. 扫材料
  let scan = null
  const src = source ? path.resolve(source) : (c.materialsDirs || [])[0]
  if (src) {
    scan = scanMaterials({ case: dir, source: src, recursive, hashMaxMB })
    steps.push({
      step: '扫材料',
      ok: true,
      detail: scan.summary || `扫到 ${(scan.files || []).length} 个文件`,
    })
  } else {
    steps.push({ step: '扫材料', ok: false, detail: '没有材料源目录（传 source 或在案件里记 materialsDirs）' })
  }

  // 3. 批量解析
  let parse = null
  if (scan && (scan.files || []).length) {
    try {
      parse = await parseAll({ case: dir, kind, limit })
      steps.push({ step: '解析材料', ok: parse.failed.length === 0, detail: parse.summary })
    } catch (e) {
      steps.push({ step: '解析材料', ok: false, detail: String(e.message || e) })
    }
  } else {
    steps.push({ step: '解析材料', ok: false, detail: '没扫到材料，跳过解析' })
  }

  // 4. 还剩什么要人决定
  const mats = readJson(cp.materials, null)
  const groups = (mats && mats.groups) || []
  const undecided = groups.filter((g) => !g.decision)
  const stale = (mats && mats.files ? mats.files : []).filter((f) => f.stale && !f.acceptedRel)

  const todo = []
  if (undecided.length) {
    todo.push(`版本待定 ${undecided.length} 组：${undecided.slice(0, 3).map((g) => g.members.map((m) => m.mid).join('/')).join('、')}${undecided.length > 3 ? ' 等' : ''}（用 lc_material_decide 定版）`)
  }
  if (!(c.proc || []).length) {
    todo.push('还没有工序表：先用 lc_proc_plan 把要做的工序拆出来（每道要有验收标准）')
  }
  const factsPath = cp.facts
  const factCount = fs.existsSync(factsPath)
    ? fs.readFileSync(factsPath, 'utf8').split('\n').filter((l) => l.trim()).length
    : 0
  if (!factCount) {
    todo.push('事实台账是空的：材料已解析，可以让 agent 逐条抽事实（每条带材料+位置+原文引用）')
  }
  const findingsPath = cp.findings
  const findCount = fs.existsSync(findingsPath)
    ? fs.readFileSync(findingsPath, 'utf8').split('\n').filter((l) => l.trim()).length
    : 0
  if (!findCount) {
    todo.push('结论台账是空的：事实齐了再用 lc_finding_add 出结论（必须引用事实编号）')
  }

  const elapsedMs = Date.now() - started
  log(dir, { op: 'pipeline', created, materials: scan ? (scan.files || []).length : 0, parsed: parse ? parse.parsed : 0, elapsedMs })

  return {
    ok: steps.every((s) => s.ok),
    case: dir,
    caseId: c.caseId,
    created,
    steps,
    materials: scan ? (scan.files || []).length : 0,
    versionGroups: groups.length,
    undecidedGroups: undecided.length,
    parsed: parse ? parse.parsed : 0,
    cached: parse ? parse.cached : 0,
    parseFailed: parse ? parse.failed : [],
    cells: parse && parse.byEngine ? parse.byEngine : {},
    todo,
    elapsedMs,
    summary:
      `${created ? '新建案件' : '案件已存在'}｜材料 ${scan ? (scan.files || []).length : 0} 个` +
      (parse ? `｜解析 ${parse.parsed} 新 + ${parse.cached} 缓存${parse.failed.length ? ` + ${parse.failed.length} 失败` : ''}｜${(parse.elapsedMs / 1000).toFixed(1)}s` : '') +
      `｜待决定 ${todo.length} 项`,
  }
}
