// LawCase 本机接口层（只读第一版）
//
// 定位：把 lib/core 里那些纯函数包成一组可被界面调用的 op，
// 供「工作台 / 插件面板」这类客户端使用。agent 的工具（lib/tools）与
// 这里并列，互不依赖：同一个 core，两种外壳。
//
// 约定：
//   - 不在这里调用任何 LLM（继续做账不做脑）
//   - 所有 op 输入输出都是普通 JSON，能直接被 fetch 序列化
//   - 只有含 .lawcase/case.json 的目录才算案件目录，不做「猜路径」
//   - 本文件不 import 任何宿主包，可脱离宿主用 node 直接测
//
// 由 index.js 挂到 `<API_PATH>`，请求体形如：
//   { "op": "cases.list", "payload": { ... } }

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { casePaths, readJson, readJsonl, writeJsonAtomic } from '../core/store.js'
import { openCase } from '../core/case.js'
import { listMaterials, scanMaterials, decideMaterial } from '../core/material.js'
import { parseAll, listParsed } from '../core/parse.js'
import { listFacts, addFact, amendFact, revokeFact } from '../core/fact.js'
import { listFindings, addFinding } from '../core/finding.js'
import { listProcesses, planProcesses, updateProcess } from '../core/proc.js'
import { verifyCase, waiveCheck } from '../core/verify.js'
import { loadLaws } from '../core/law.js'
import { loadClauses, loadNotes, listNotes, indexClauses, skipContract, unindexClauses, addNote, deleteNote, buildReport, contractCandidates, reviewWorksheet, validateDrafts, loadDrafts, clearDrafts, ruleClause, revokeRuling, loadRulings, rulingStatus } from '../core/clause.js'
import { precheckCase } from '../core/precheck.js'
import { readReviewConfig, setReviewConfig, reviewRules, reviewBrief, templateOf, STANCES } from '../core/contractcfg.js'
import { previewRevision } from '../core/preview.js'
import { checkStatus, checkItem, checkMany, buildSignoff } from '../core/checkoff.js'
import { nextStep } from '../core/next.js'
import { caseBrief } from '../core/brief.js'
import { lawTrace } from '../core/lawtrace.js'
import { machinePrecheck } from '../core/machinecheck.js'
import { getBinding, setBinding, clearBinding, listBindings } from '../core/sessionbind.js'
// AI 审核：编排 / 审计 / 草稿详情，以及模型目录
import { runAiReview, loadAiAudit, loadDraftsDetail } from '../core/aireview.js'
import { readDocx } from '../core/docx.js'
import { listModelCatalog } from '../core/models.js'
// 条款审核状态机：把草稿/意见/判定/修订合成一条可追溯的状态
import { clauseStateMachine } from '../core/clausestate.js'
// 片段级修订：唯一性/重叠检查 + 只写新文件的 docx 生成
import { previewPatches, applyPatches, loadPatchRecord } from '../core/patchrevise.js'
import { reviseContract } from '../core/redline.js'
import { buildDelivery } from '../core/deliver.js'
import { runPipeline } from '../core/pipeline.js'

/** 客户端与宿主共用的接口路径 */
export const API_PATH = '/api/lawcase'

const DEFAULT_LIMIT = 500

/** 带 code 的错误：界面按 code 分支，不靠解析文案 */
function httpError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 只有含 .lawcase/case.json 的目录才算案件目录 */
export function assertCaseDir(raw) {
  const raw2 = String(raw || '').trim()
  if (!raw2) throw httpError('case/empty', 'case 不能为空：请给出案件工作目录绝对路径')
  const dir = path.resolve(raw2)
  const p = casePaths(dir)
  if (!fs.existsSync(p.caseJson)) {
    throw httpError('case/not-a-case', `不是 LawCase 案件（缺少 .lawcase/case.json）：${dir}`)
  }
  return dir
}

function countJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    let n = 0
    for (const line of text.split('\n')) if (line.trim()) n += 1
    return n
  } catch (e) {
    return 0
  }
}

/** 列表页用的单案摘要：只读 case.json + 数行数，不解析任何材料 */
export function summarizeCase(dir) {
  const cp = casePaths(dir)
  const c = readJson(cp.caseJson, null)
  if (!c) return null
  const proc = Array.isArray(c.proc) ? c.proc : []
  const mats = readJson(cp.materials, null) || { files: [] }
  const files = Array.isArray(mats.files) ? mats.files : []
  const type = c.caseType || 'litigation'
  return {
    dir,
    caseId: c.caseId,
    title: c.title,
    cause: c.cause || '',
    parties: c.parties || '',
    caseType: type,
    caseTypeLabel: type === 'contract' ? '合同审核' : '诉讼/争议',
    status: c.status || '',
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
    counts: {
      materials: files.length,
      materialsParsed: files.filter((f) => f && f.parsed).length,
      facts: countJsonl(cp.facts),
      findings: countJsonl(cp.findings),
      procTotal: proc.length,
      procDone: proc.filter((x) => x && x.status === 'done').length,
      procBlocked: proc.filter((x) => x && x.status === 'blocked').length,
    },
  }
}

/** 扫案件根目录下的所有案件，按更新时间倒序。
 *
 *  两条必须同时成立，否则用户会看到「明明有好几个案子，列表里只剩一个」：
 *  ① 根目录本身是案件（含 .lawcase/case.json）时，把它当作其中一件，而不是
 *     直接返回它、把里面的其它案件全屏蔽掉——「案件根目录」被误设成某个案子
 *     的那一次（cases/ 自己带上了 .lawcase）就是这么把 5 个案子吃成 1 个的。
 *  ② 确实只有这一件（里面再没有别的案件）时，仍然照旧返回它并标 single，
 *     界面据此提示「这个目录本身就是案件目录」，用户才知道该怎么改根目录。
 */
export function listCases({ root, limit = DEFAULT_LIMIT } = {}) {
  if (!root) {
    throw httpError(
      'root/unset',
      '未配置案件根目录：请在插件 Config 里写 root（案件总目录），调用时也可临时传 payload.root'
    )
  }
  const self = summarizeCase(root)

  let names = []
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch (e) {
    // 根目录本身不可读时，只要它自己是个案件就还能用
    if (self) return { root, count: 1, single: true, cases: [self] }
    throw httpError('root/unreadable', `案件根目录不可读：${root}（${e.message}）`)
  }
  const rows = []
  for (const name of names.slice(0, limit)) {
    const s = summarizeCase(path.join(root, name))
    if (s) rows.push(s)
  }
  if (self) rows.push(self)
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return {
    root,
    count: rows.length,
    // 只有「根目录是案件」且「它下面没有别的案件」才算单案根目录
    single: Boolean(self) && rows.length === 1,
    selfIsCase: Boolean(self),
    cases: rows,
  }
}

/** 目录浏览单页上限：只为「点选」用，不需要一次列完几千个子目录 */
const BROWSE_LIMIT = 500

/**
 * 目录浏览（只读）：给界面「点选目录」用。
 *
 * 只列子目录名，**不读任何文件内容**，不递归；隐藏目录（.lawcase/.trash 之类）不列。
 * 传进来的是文件（用户常把文件路径粘进来）就退到它所在目录，而不是报错。
 */
/** 手输 ~ 是常态（律师不会背绝对路径），展开成主目录 */
export function expandHome(p) {
  const s = String(p || '').trim()
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  return s
}

export function browseDir({ dir, limit = BROWSE_LIMIT } = {}) {
  const startRaw = expandHome(dir)
  if (!startRaw) throw httpError('fs/empty', '请给出要浏览的目录（或先设置案件根目录）')

  let target = path.resolve(startRaw)
  let st = null
  try {
    st = fs.statSync(target)
  } catch (e) {
    throw httpError('fs/not-found', `目录不存在或不可访问：${target}`)
  }
  // 传进来的是文件：退到它所在目录，别逼用户重来一遍
  if (!st.isDirectory()) target = path.dirname(target)

  const caseMark = path.join('.lawcase', 'case.json')
  let names = []
  let truncated = false
  try {
    const all = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    truncated = all.length > limit
    names = all.slice(0, limit)
  } catch (e) {
    throw httpError('fs/denied', `目录不可读：${target}（${e.message}）`)
  }

  const parent = path.dirname(target)
  return {
    dir: target,
    // 到了磁盘根就封顶，别让界面给出一个点不动的「上一级」
    parent: parent === target ? null : parent,
    home: os.homedir(),
    isCase: fs.existsSync(path.join(target, caseMark)),
    truncated,
    entries: names.map((name) => {
      const full = path.join(target, name)
      return { name, path: full, hasCase: fs.existsSync(path.join(full, caseMark)) }
    }),
  }
}

/**
 * 建接口实例。
 * @param {{ version: string, root: string|null, config: object, pkgRoot: string }} deps
 */
const UI_STATE_FILE = 'ui-state.json'

export function createApi({ version = '', root = null, config = {}, pkgRoot = '', note = null, llm = null, defaultModel = null } = {}) {
  /**
   * 正在跑的那次审核（按案件登记）。
   *
   * 为什么必须有：2026-11-01 取消了 120 秒墙钟上限，审核可能跑很久。
   * 界面的「取消」以前只改界面状态，请求照样在后端跑 —— 去掉时间上限后
   * 那就等于「点了取消还在烧模型钱」。这里登记 AbortController，
   * 让取消真的传到 `llm.stream` 的 signal 上。
   */
  const runningReviews = new Map() // caseDir → { ctrl, at, reviewId }
  // llm / defaultModel 传的是**函数**：每次调用现取宿主服务。
  // 直接传对象会踩「服务晚于插件就绪」——宿主启动顺序不保证，那样会永远拿到 null。
  const getLlm = () => (typeof llm === 'function' ? llm() : llm)
  const getDefaultModel = () => (typeof defaultModel === 'function' ? defaultModel() : defaultModel)
  const uiStatePath = pkgRoot ? path.join(pkgRoot, '.lawcase-plugin', UI_STATE_FILE) : null
  const readUiState = () => {
    if (!uiStatePath) return {}
    try {
      return JSON.parse(fs.readFileSync(uiStatePath, 'utf8')) || {}
    } catch (e) {
      return {}
    }
  }
  const writeUiState = (patch) => {
    if (!uiStatePath) return {}
    // 只合并「确实给了值」的键：patch 里值为 undefined 不能覆盖旧值。
    // 踩过——只传 lastCase 时 root 被写成 undefined，序列化后整个键消失，
    // 表现为「案件根目录莫名其妙掉了」。
    const clean = {}
    for (const [k, v] of Object.entries(patch || {})) {
      if (v !== undefined) clean[k] = v
    }
    const next = Object.assign({}, readUiState(), clean, { updatedAt: new Date().toISOString() })
    try {
      fs.mkdirSync(path.dirname(uiStatePath), { recursive: true })
      fs.writeFileSync(uiStatePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch (e) {}
    return next
  }

  const configuredRoot = () => root || null
  const limitOf = () => {
    const n = Number(config && config.scanLimit)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT
  }

  const ops = {
    // 客户端半区自报：界面是否真的挂上了、走的是哪条路。写日志，不改案件。
    async 'client.mount'(payload) {
      const rec = (payload && payload) || {}
      if (typeof note === 'function') note({ op: 'client-mount', ...rec })
      return { ok: true, recorded: true, version }
    },

    // 界面状态：记住用户填的案件根目录等，跨重启、跨端口都不丢
    async 'ui.state'() {
      const st = readUiState()
      return {
        root: st.root || configuredRoot(),
        lastCase: st.lastCase || null,
        storedRoot: st.root || null,
        // 核对人/签字人：问过一次就记住，否则每点一条都要重新填
        checker: st.checker || '',
      }
    },

    async 'ui.state.set'(payload) {
      const st = writeUiState({
        root: payload && payload.root ? String(payload.root) : undefined,
        lastCase: payload && payload.lastCase ? String(payload.lastCase) : undefined,
        checker: payload && payload.checker !== undefined ? String(payload.checker) : undefined,
      })
      return { ok: true, state: st }
    },

    // 连通性与身份：界面首屏先调它，确认插件在这台机器上真的加载了
    async ping() {
      return { version, pkgRoot, root: configuredRoot(), api: API_PATH }
    },

    async 'cases.list'(payload) {
      const want = payload && typeof payload.root === 'string' && payload.root.trim() ? payload.root.trim() : configuredRoot()
      return listCases({ root: want, limit: limitOf() })
    },

    // 目录点选：界面的「选择位置」按钮用它。只读，不建目录、不写任何东西。
    // 起点优先级：payload.dir > payload.root > 案件根目录 > 主目录。
    async 'fs.browse'(payload) {
      const p = payload || {}
      const start = String(p.dir || p.root || '').trim() || configuredRoot() || os.homedir()
      const out = browseDir({ dir: start, limit: limitOf() })
      const sections = [{ label: '主目录', path: os.homedir() }]
      if (configuredRoot()) sections.push({ label: '案件根目录', path: configuredRoot() })
      const st = readUiState()
      if (st.lastCase && String(st.lastCase).trim()) sections.push({ label: '上次打开的案件', path: String(st.lastCase) })
      return { ...out, sections }
    },

    // 开工复述：core 的 openCase 已经把工序/事实/结论/材料/待确认/下一步都摊开了
    async 'case.open'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return openCase({ case: dir })
    },

    async 'materials.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return listMaterials({ case: dir, staleOnly: Boolean(payload && payload.staleOnly) })
    },

    async 'facts.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return listFacts({ case: dir, pendingOnly: Boolean(payload && payload.pendingOnly) })
    },

    async 'findings.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return listFindings({ case: dir })
    },

    async 'processes.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return listProcesses({ case: dir })
    },

    async 'laws.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const laws = loadLaws(dir)
      return { ok: true, count: laws.length, laws }
    },

    // 合同预检：只做机器能判的硬伤，不调 LLM，不写任何文件
    async 'precheck.run'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return precheckCase({ case: dir, file: payload && payload.file })
    },

    // 核对台账：读进度 / 打核对结论 / 出签字单
    async 'checkoff.status'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return checkStatus({ case: dir })
    },

    async 'checkoff.set'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return checkItem({
        case: dir,
        kind: payload && payload.kind,
        id: payload && payload.id,
        result: payload && payload.result,
        by: payload && payload.by,
        note: payload && payload.note,
      })
    },

    // 批量核对：必须显式给 ids（不提供「全部通过」）
    async 'checkoff.batch'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return checkMany({
        case: dir,
        kind: payload && payload.kind,
        ids: payload && payload.ids,
        result: payload && payload.result,
        by: payload && payload.by,
        note: payload && payload.note,
      })
    },

    async 'checkoff.sign'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return buildSignoff({ case: dir, signer: payload && payload.signer })
    },

    // 会话绑定：面板要知道「这个对话绑的是哪个案」，也要能改
    async 'session.bind.list'(payload) {
      const sessionId = payload && payload.sessionId ? String(payload.sessionId) : null
      return {
        sessionId,
        binding: getBinding(sessionId, { pkgRoot }),
        bindings: listBindings({ pkgRoot }),
      }
    },

    async 'session.bind.set'(payload) {
      const sessionId = payload && payload.sessionId ? String(payload.sessionId) : ''
      if (!sessionId) throw httpError('session/empty', '缺少 sessionId：面板要传当前会话 id，否则不知道该绑哪个对话')
      if (payload && payload.unbind) {
        clearBinding(sessionId, { pkgRoot })
        return { ok: true, binding: null, summary: '已解除本对话的案件绑定' }
      }
      const dir = assertCaseDir(payload && payload.case)
      const b = setBinding(sessionId, dir, { pkgRoot, title: payload && payload.title })
      return { ok: true, binding: b, summary: `本对话已绑定到 ${dir}` }
    },

    // 机器预核：能由机器判的先判掉，判不了的明确交人工
    async 'check.machine'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return machinePrecheck({ case: dir })
    },

    // 法条溯源：结论 → 法条 → 条文原文 → 权威来源，逐条核对
    async 'law.trace'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return lawTrace({ case: dir })
    },

    // 状态栏用：现在卡在哪一步、下一步做什么（与 lc_case_next 同一套 skill）
    async 'next.step'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const step = nextStep({ case: dir })
      // 顶栏「上次动作 / 卡点」与三轮色：同一份数据，界面别自己再算一遍
      let brief = null
      try {
        brief = caseBrief({ case: dir, pkgRoot, next: step })
      } catch (e) {
        brief = null
      }
      let check = null
      try {
        check = checkStatus({ case: dir })
      } catch (e) {}
      // 法条溯源的结论也带上：状态栏要显示「法条」这一步做完没有
      let trace = null
      try {
        trace = lawTrace({ case: dir })
      } catch (e) {}
      return { ...step, checkoff: check, lawtrace: trace, brief }
    },

    // 审核口径（立场/类型/补充要求）：不带写字段时是只读
    async 'contract.config'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const review = readReviewConfig(dir)
      return {
        review,
        brief: reviewBrief(review),
        rules: reviewRules({ templateId: review.templateId }),
      }
    },

    // 读审核口径的**完整内容**：立场说明 + 类型必查项 + 补充要求。
    // 面板要把这些写进给 AI 的指令里，只给英文枚举值（partyB）AI 看不懂该往哪边审。
    async 'contract.config.get'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const cfg = readReviewConfig(dir)
      const tpl = templateOf(cfg.templateId)
      const st = STANCES.find((x) => x.value === cfg.stance) || STANCES[0]
      return {
        ok: true,
        review: cfg,
        brief: reviewBrief(cfg),
        stance: { value: cfg.stance, label: st.label, hint: st.hint },
        template: { id: tpl.id, title: tpl.title, description: tpl.description },
        rules: reviewRules({ templateId: cfg.templateId }),
        summary: reviewBrief(cfg),
      }
    },

    async 'contract.config.set'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return setReviewConfig({
        case: dir,
        stance: payload && payload.stance,
        templateId: payload && payload.templateId,
        instructions: payload && payload.instructions,
      })
    },

    // 修订对照预览：只读计算，不落盘（最终以 contract.revise 的 docx 为准）
    async 'contract.preview'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return previewRevision({ case: dir, file: payload && payload.file, noteIds: payload && payload.noteIds })
    },

    // 合同审核类案型的条款索引（没索引过就是空数组，不是错误）
    async 'clauses.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const files = loadClauses(dir)
      // 条款审核判定（丢弃草稿＝无需修改）：跟「有意见」分开记，但都要显示
      const rulingMap = new Map()
      for (const r of loadRulings({ case: dir })) rulingMap.set(String(r.clause || '').replace(/\s+/g, ''), r)

      // 每条条款已有几条意见：界面要标出来，避免重复登记或漏审
      const counts = new Map()
      let noteTotal = 0
      try {
        for (const n of readJsonl(casePaths(dir).notes)) {
          if (!n || n.__broken || n.__deleted) continue
          const key = (n.file || '') + '#' + String(n.clause || '').replace(/\s+/g, '')
          counts.set(key, (counts.get(key) || 0) + 1)
          noteTotal += 1
        }
      } catch (e) {}
      return {
        ok: true,
        count: files.length,
        noteTotal,
        files: files.map((f) => ({
          name: f.name || f.file,
          total: Array.isArray(f.clauses) ? f.clauses.length : 0,
          noteCount: Array.isArray(f.clauses)
            ? f.clauses.reduce((acc, c) => acc + (counts.get((f.name || f.file) + '#' + String(c.no || '').replace(/\s+/g, '')) || 0), 0)
            : 0,
          clauses: Array.isArray(f.clauses)
            ? f.clauses.map((c) => {
                const key = String(c.no || '').replace(/\s+/g, '')
                const ruling = rulingMap.get(key) || null
                return {
                  no: c.no,
                  title: c.title,
                  text: c.text,
                  noteCount: counts.get((f.name || f.file) + '#' + key) || 0,
                  // 「无需修改」也是审核结论，界面要跟「有意见」区分开显示
                  ruling: ruling ? { kind: ruling.kind, reason: ruling.reason, by: ruling.by, at: ruling.at } : null,
                }
              })
            : [],
        })),
      }
    },

    async 'notes.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return listNotes({ case: dir })
    },

    // ---- 写操作：都要显式给出 case；由界面二次确认后调用 ----

    // 一键机械活：建案 → 扫材料 → 批量解析（不抽事实、不出结论）
    async 'pipeline.run'(payload) {
      const raw = String((payload && payload.case) || '').trim()
      if (!raw) throw httpError('case/empty', '案件目录不能为空')
      // 相对路径按"案件根目录"解析，不要按宿主进程 cwd 解析：
      // 工作台宿主的 cwd 是应用安装目录，会把案子建到那里去（踩过）。
      let target = raw
      if (!path.isAbsolute(target)) {
        const baseRoot = configuredRoot()
        if (!baseRoot) {
          throw httpError('case/relative', '案件目录要给绝对路径（或在插件配置里设置 root）')
        }
        target = path.join(baseRoot, target)
      }
      return runPipeline({
        case: path.resolve(target),
        // 空白字符串当"没填"处理：界面里的可选输入框清空后会送 '' 过来，
        // 原样传下去会被 path.resolve 解析成宿主 cwd（应用安装目录），
        // 报出一句"材料源目录不存在或不可读：/…/lawcase-plugin/  "，谁都看不懂。
        source: (payload.source && String(payload.source).trim()) || undefined,
        title: payload.title,
        parties: payload.parties,
        cause: payload.cause,
        caseType: payload.caseType,
        kind: payload.kind,
        limit: payload.limit,
        hashMaxMB: payload.hashMaxMB,
        recursive: payload.recursive !== false,
      })
    },

    async 'material.scan'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return scanMaterials({
        case: dir,
        source: payload.source,
        recursive: payload.recursive !== false,
        hashMaxMB: payload.hashMaxMB || 0,
        maxDepth: payload.maxDepth || 8,
      })
    },

    // 定版：一组版本里指定哪份为准（写进台账，不是口头结论）
    async 'material.decide'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return decideMaterial({ case: dir, group: payload.group, accept: payload.accept, note: payload.note || '' })
    },

    /**
     * 批量解析材料。
     *
     * 为什么现在才补（2026-11-01）：界面的「批量解析」按钮一直在调
     * `material.parse_all`，而这个 op **从来没实现过** —— core 里 parseAll 早就写好了，
     * 只是没暴露成接口。用户点下去只会看到「未知 op」，然后卡在"11 份但一份没解析"。
     * 这是典型的"两边各写一半"：按钮做了，接口忘了。
     */
    async 'material.parse_all'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return parseAll({
        case: dir,
        kind: payload.kind || undefined,
        limit: payload.limit || 200,
        force: Boolean(payload.force),
        ocrDpi: payload.ocrDpi || 200,
        pdfEngine: payload.pdfEngine || 'auto',
        tier: payload.tier || undefined,
      })
    },

    async 'material.parsed'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const items = listParsed(dir)
      return { ok: true, count: items.length, items, summary: `已解析 ${items.length} 份` }
    },

    async 'fact.add'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return addFact({
        case: dir,
        text: payload.text,
        source: payload.source,
        locator: payload.locator,
        quote: payload.quote,
        confirmed: Boolean(payload.confirmed),
        note: payload.note || '',
      })
    },

    async 'fact.amend'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return amendFact({
        case: dir,
        id: payload.id,
        locator: payload.locator,
        quote: payload.quote,
        text: payload.text,
        reason: payload.reason,
      })
    },

    async 'fact.revoke'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return revokeFact({ case: dir, id: payload.id, reason: payload.reason })
    },

    async 'finding.add'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return addFinding({
        case: dir,
        text: payload.text,
        factRefs: payload.factRefs,
        law: payload.law,
        lawSource: payload.lawSource,
        confidence: payload.confidence,
      })
    },

    async 'proc.plan'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return planProcesses({
        case: dir,
        processes: payload.processes,
        replace: Boolean(payload.replace),
        force: Boolean(payload.force),
      })
    },

    async 'proc.update'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return updateProcess({
        case: dir,
        id: payload.id,
        status: payload.status,
        note: payload.note || '',
        acceptResult: payload.acceptResult,
      })
    },

    async 'clause.candidates'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const items = contractCandidates({ case: dir })
      const pending = items.filter((x) => !x.indexed && !x.skipped).length
      const skipped = items.filter((x) => x.skipped).length
      return {
        ok: true,
        total: items.length,
        pending,
        skipped,
        items,
        summary: items.length
          ? `材料里有 ${items.length} 份 docx：已索引 ${items.filter((x) => x.indexed).length}，待决定 ${pending}，明确不索引 ${skipped}`
          : '材料台账里没有 .docx（先扫材料，或在下方的「索引其他文件」里指定路径）',
      }
    },

    async 'clause.index'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return indexClauses({ case: dir, file: payload.file })
    },

    // 明确「这份不索引」：收口那些永远切不出条款的附件，让索引这一步能走完
    async 'clause.skip'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return skipContract({
        case: dir,
        file: payload.file,
        reason: payload.reason,
        unskip: Boolean(payload.unskip),
      })
    },

    async 'clause.unindex'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return unindexClauses({ case: dir, file: payload.file })
    },

    // AI 预生成用的条款清单：只读，不写台账（意见必须由人勾选采纳后才落盘）
    async 'note.worksheet'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return reviewWorksheet({ case: dir, file: payload.file })
    },

    // 校验一批 AI 草稿：只判能不能落地，**不写台账**。
    // save=true 时记进 .lawcase/note-drafts.json，界面据此摆出草稿区（采纳才写 notes.jsonl）
    async 'note.validateDrafts'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return validateDrafts({ case: dir, file: payload.file, drafts: payload.drafts, save: Boolean(payload.save) })
    },

    // 读回/清空 AI 草稿暂存
    async 'note.drafts'(payload) {
      return loadDrafts({ case: assertCaseDir(payload && payload.case) })
    },

    // 草稿详情：连同模型、口径、合同指纹一起给，界面要说清"这份草稿是谁审的"
    async 'note.draftsDetail'(payload) {
      return loadDraftsDetail({ case: assertCaseDir(payload && payload.case) })
    },

    // ---- 审核模型目录 ----------------------------------------------------
    // 宿主没配模型时**不抛错**：界面要靠这份数据画下拉框并给出可读提示。
    async 'models.list'() {
      return listModelCatalog({ llm: getLlm(), defaultModel: getDefaultModel() })
    },

    // ---- AI 审核（核心新增）----------------------------------------------
    // 服务端自己读案件与条款，绝不拿前端提交的合同全文当唯一来源。
    // 失败一律 ok:false，message 说清"这次没有结论"——不许冒充零风险。
    async 'note.aiReview'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      // 同一个案件同时只允许一次审核：并发跑两轮会互相覆盖草稿
      const running = runningReviews.get(dir)
      if (running) {
        return {
          ok: false,
          code: 'review/running',
          message: '这个案件已经有一次 AI 审核在进行中。等它结束，或先点「取消」。',
        }
      }
      const ctrl = new AbortController()
      runningReviews.set(dir, { ctrl, at: new Date().toISOString() })
      try {
      const r = await runAiReview({
        signal: ctrl.signal,
        case: dir,
        file: payload.file,
        sessionId: payload.sessionId,
        modelSelection: payload.modelSelection,
        stance: payload.stance,
        templateId: payload.templateId,
        instructions: payload.instructions,
        llm: getLlm(),
        defaultModel: getDefaultModel(),
        timeoutMs: payload.timeoutMs,
        pkgRoot,
      })
      return r
      } finally {
        runningReviews.delete(dir)
      }
    },

    /** 取消正在进行的 AI 审核（真的中止后端请求，不只是改界面） */
    async 'note.aiCancel'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const running = runningReviews.get(dir)
      if (!running) return { ok: true, cancelled: false, summary: '这个案件没有正在进行的审核' }
      running.ctrl.abort()
      runningReviews.delete(dir)
      return { ok: true, cancelled: true, summary: '已取消：本次不会产生任何审核结论' }
    },

    // 审核审计：每次审核的实际模型、口径、合同指纹、时间、草稿采纳情况
    async 'ai.audit'(payload) {
      return loadAiAudit({ case: assertCaseDir(payload && payload.case), limit: payload && payload.limit })
    },

    // 条款审核状态机：每条条款现在是「待审/有草稿/无需修改/需修改/已登记/已修订」，
    // 并标出互相打架的组合（比如同一句既判无需修改又登记了意见）
    async 'clause.states'(payload) {
      return clauseStateMachine({ case: assertCaseDir(payload && payload.case), file: payload && payload.file })
    },

    // 丢弃草稿 = 「已审·无需修改」：判定与清草稿**一次完成**，
    // 分开做会出现「判定写了、草稿还在」的中间态，下次审核又会捡回来。
    async 'note.discard'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const clause = String((payload && payload.clause) || '').trim()
      if (!clause) throw httpError('clause/empty', '缺条款号：不知道丢弃哪一条草稿')
      // 理由选填（用户要求「不用填理由」）；但若理由在描述风险，ruleClause 会拒收
      const reason = String((payload && payload.reason) || '').trim()
      // 先写判定（留痕），成功后才清草稿：反过来的话判定失败就丢了草稿
      const ruled = ruleClause({ case: dir, file: payload.file, clause, kind: 'norevision', reason, by: payload.by })
      const cleared = clearDrafts({ case: dir, clause })
      return {
        ok: true,
        ruling: ruled.ruling,
        remaining: cleared.remaining == null ? null : cleared.remaining,
        summary: `已记录「${clause} → 已审·无需修改」，并从草稿里移除`,
      }
    },

    // 采纳草稿 = 「已审·需修改」：写正式意见（notes.jsonl）→ 记 revision 判定 → 清草稿。
    // 三步合成一个 op，避免「意见登记了但判定没写」导致状态机看不出这条审过。
    async 'note.adopt'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const clause = String((payload && payload.clause) || '').trim()
      if (!clause) throw httpError('clause/empty', '缺条款号：不知道采纳哪一条草稿')
      const added = addNote({
        case: dir,
        file: payload.file,
        clause,
        level: payload.level,
        issue: payload.issue,
        fix: payload.fix,
        basis: payload.basis,
        quote: payload.quote,
        // 已有同一条意见时原地更新（界面「实际修改意见」保存走这条）
        updateId: payload && payload.updateId ? String(payload.updateId) : undefined,
        // 落地形式：comment（正文不动只批注，默认）/ redline（改正文）
        apply: payload && payload.apply,
      })
      let ruling = null
      try {
        ruling = ruleClause({
          case: dir,
          file: payload.file,
          clause,
          kind: 'revision',
          reason: String((payload && payload.reason) || '按 AI 草稿采纳并登记意见').slice(0, 200),
          by: payload && payload.by,
        })
      } catch (e) {
        // 判定写失败不该回滚意见（意见本身已合法），但要如实告知
        return { ok: true, note: added, ruling: null, warning: '意见已登记，但「已审·需修改」判定没记上：' + ((e && e.message) || e), summary: (added && added.summary) || '已登记意见' }
      }
      const cleared = clearDrafts({ case: dir, clause })
      return {
        ok: true,
        note: added,
        ruling: ruling.ruling,
        remaining: cleared.remaining == null ? null : cleared.remaining,
        summary: `${(added && added.summary) || '已登记意见'}；并记为「已审·需修改」`,
      }
    },

    async 'note.draftsClear'(payload) {
      return clearDrafts({ case: assertCaseDir(payload && payload.case), clause: payload && payload.clause })
    },

    // 条款审核判定：丢弃草稿＝「已审·无需修改」，采纳并登记意见＝「已审·需修改」
    async 'clause.rule'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return ruleClause({ case: dir, file: payload.file, clause: payload.clause, kind: payload.kind, reason: payload.reason, by: payload.by })
    },

    // 作废一条判定（判定写错时用：例如把风险条款记成「无需修改」）。
    // 追加 __deleted 行、不删原始记录，复核的人能看出"这条曾被判过又被推翻"。
    async 'clause.revoke'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return revokeRuling({
        case: dir,
        file: payload && payload.file,
        clause: payload && payload.clause,
        reason: payload && payload.reason,
        by: payload && payload.by,
      })
    },

    async 'clause.rulings'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return {
        ok: true,
        items: loadRulings({ case: dir }),
        status: rulingStatus({ case: dir, file: payload.file }),
      }
    },

    async 'note.add'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return addNote({
        case: dir,
        file: payload.file,
        clause: payload.clause,
        level: payload.level,
        issue: payload.issue,
        fix: payload.fix,
        basis: payload.basis,
        quote: payload.quote,
        apply: payload.apply,
      })
    },

    // 一键切换某条意见的落地形式（批注 / 改正文）：界面上就是两个按钮
    async 'note.setApply'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const rows = loadNotes(casePaths(dir))
      const hit = rows.find((r) => String(r.id || '').toUpperCase() === String(payload.id || '').toUpperCase())
      if (!hit) throw new Error(`没有 ${payload.id} 这条审核意见`)
      return addNote({
        case: dir,
        file: hit.file,
        clause: hit.clause,
        level: hit.level,
        issue: hit.issue,
        fix: hit.fix,
        basis: hit.basis,
        quote: hit.quote,
        updateId: hit.id,
        apply: payload.apply,
      })
    },

    async 'note.delete'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return deleteNote({ case: dir, id: payload.id })
    },

    // ---- 片段级修订 ------------------------------------------------------
    // 只校验 + 对照预览，**不写文件**：界面上先看"改了什么"再决定要不要落盘。
    async 'patch.preview'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return previewPatches({ case: dir, file: payload.file, patches: payload.patches })
    },

    // 应用片段级修订：唯一性/重叠检查不过就整批拒绝，原合同只读
    async 'patch.apply'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return applyPatches({
        case: dir,
        file: payload.file,
        patches: payload.patches,
        acceptAll: payload.acceptAll === undefined ? true : Boolean(payload.acceptAll),
      })
    },

    // 上次接受了哪几处（交付包要写清逐条接受/拒绝）
    async 'patch.record'(payload) {
      return loadPatchRecord({ case: assertCaseDir(payload && payload.case) })
    },

    // 打交付包：五道验收有 fail 时会拒绝（force 才生成，包名带「未通过验收」）
    async 'deliver'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return buildDelivery({
        case: dir,
        label: payload.label || '',
        force: Boolean(payload.force),
        outDir: payload.outDir || '',
      })
    },

    // 生成审核意见表（Markdown，写到案件 out/ 下）
    async 'contract.report'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return buildReport({ case: dir })
    },

    // 生成带修订痕迹的合同 docx。
    // source='drafts' → 用未采纳的 AI 草稿出（审核完就能看整份改动）；
    // 不传 → 用已登记的正式意见出。
    async 'contract.revise'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return reviseContract({
        case: dir,
        file: payload.file,
        noteIds: Array.isArray(payload.noteIds) && payload.noteIds.length ? payload.noteIds : undefined,
        source: payload && payload.source === 'drafts' ? 'drafts' : undefined,
        outName: payload && payload.outName ? String(payload.outName) : undefined,
        // 批注默认开；显式 false 才出"只有红线、没有批注"的干净稿
        comments: payload && payload.comments === false ? false : true,
      })
    },

    // 列出案件产出（out/ 目录）：界面要有「预览区」，不能生成完只剩一句提示
    async 'outputs.list'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const outDir = path.join(dir, 'out')
      let names = []
      try {
        names = fs.readdirSync(outDir).filter((f) => !f.startsWith('.') && !f.startsWith('~$'))
      } catch (e) {
        names = []
      }
      const items = names
        .map((name) => {
          const abs = path.join(outDir, name)
          let st = null
          try {
            st = fs.statSync(abs)
          } catch (e) {
            return null
          }
          if (!st || !st.isFile()) return null
          const ext = path.extname(name).toLowerCase()
          return {
            name,
            abs,
            ext,
            bytes: st.size,
            at: st.mtime.toISOString(),
            // 分类：界面据此选图标/说明
            kind: ext === '.docx' ? 'word' : ext === '.md' ? 'markdown' : ext === '.pdf' ? 'pdf' : 'other',
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      // 读 Markdown 类的正文（供预览区直接显示内容）
      // 每类文件都给可预览的文本，界面才能"点开就能看"，而不是只能去文件夹里找。
      //   markdown → 原文
      //   docx     → 抽段落文字（修订痕迹显示为纯文本，够看清改了哪句）
      //   其他     → 无预览，界面提供复制路径
      for (const it of items) {
        try {
          if (it.kind === 'markdown') {
            const text = fs.readFileSync(it.abs, 'utf8')
            it.preview = text.slice(0, 40000)
            it.truncated = text.length > 40000
          } else if (it.kind === 'word') {
            const paras = readDocx(fs.readFileSync(it.abs))
            const text = paras.join('\n')
            it.preview = text.slice(0, 40000)
            it.truncated = text.length > 40000
            it.previewKind = 'docx-text'
          }
        } catch (e) {
          it.previewError = String((e && e.message) || e)
        }
      }
      const latest = items.find((x) => x.kind === 'word') || null
      return {
        ok: true,
        dir: outDir,
        count: items.length,
        items,
        latestWord: latest,
        summary: items.length ? `产出 ${items.length} 个文件（最新：${items[0].name}）` : '还没有产出文件',
      }
    },

    /**
     * 用系统默认应用打开一个产出文件（或它所在的目录）。
     *
     * 为什么自己做而不是用宿主的 /open-in-app/open：那套接口要求
     * 「已登记在会话 deliverables 里的文件坐标」，插件自己写出的 out/ 文件不在其中，
     * 调不通。这里直接让宿主进程执行平台打开命令，效果与双击一致。
     *
     * 安全边界：只允许打开**本案件 out/ 目录内**的文件，路径必须落在 out 下，
     * 防止把任意路径（如 /etc/passwd）传给系统打开器。
     */
    /**
     * 在 Finder / 资源管理器里显示交付包。
     *
     * 为什么单独一个 op：交付包在**案件根目录**下（`交付包_YYYYMMDD-HHMM/`），
     * 不在 `out/` 里；`outputs.open` 有越界检查（只许开 out/ 内的），
     * 拿它开交付包会被拒。用户 2026-11-01 要求「在 Finder 中显示」。
     *
     * name 可选：不传就打开**最新的**那个交付包。
     */
    async 'deliver.open'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const want = String((payload && payload.name) || '').replace(/^.*[\\/]/, '')
      let target = null
      if (want) {
        target = path.join(dir, want)
        // 只允许打开案件根下、以「交付包_」开头的目录
        if (!/^交付包_/.test(want)) throw httpError('path/outside', `只能打开交付包目录：${want}`)
      } else {
        let names = []
        try {
          names = fs.readdirSync(dir).filter((n) => /^交付包_/.test(n)).sort()
        } catch (e) {
          names = []
        }
        if (!names.length) throw httpError('deliver/none', '还没有交付包：先在验收页点「打交付包」')
        target = path.join(dir, names[names.length - 1])
      }
      if (!fs.existsSync(target)) throw httpError('file/missing', `交付包不存在：${target}`)

      const { spawn } = await import('node:child_process')
      const platform = process.platform
      // -R = 在 Finder 里「显示」并把该文件夹选中（不是直接打开内容）
      const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = platform === 'darwin'
        ? ['-R', target]
        : platform === 'win32'
          ? ['/c', 'start', '', target]
          : [target]
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
        child.on('error', (e) => reject(new Error(`调用系统打开命令失败：${(e && e.message) || e}`)))
        child.unref()
        setTimeout(resolve, 80)
      })
      const rel = path.relative(dir, target)
      return { ok: true, dir: target, summary: `已在 Finder 中显示：${rel}` }
    },

    async 'outputs.open'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const outDir = path.resolve(path.join(dir, 'out'))
      const mode = String((payload && payload.mode) || 'file') // file | folder
      let target
      if (mode === 'folder') {
        target = outDir
      } else {
        const name = String((payload && payload.name) || '').replace(/^.*[\\/]/, '') // 只取文件名，丢掉任何目录部分
        if (!name) throw httpError('file/empty', '没有指定要打开的文件')
        target = path.resolve(path.join(outDir, name))
      }
      // 越界检查：解析后必须仍在 out/ 内
      if (target !== outDir && !target.startsWith(outDir + path.sep)) {
        throw httpError('path/outside', `只允许打开本案件 out/ 目录内的文件：${target}`)
      }
      if (!fs.existsSync(target)) throw httpError('file/missing', `文件不存在：${target}`)

      const { spawn } = await import('node:child_process')
      const platform = process.platform
      const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = platform === 'win32' ? ['/c', 'start', '', target] : [target]
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
        child.on('error', (e) => reject(new Error(`调用系统打开命令失败：${(e && e.message) || e}`)))
        // detached + unref：不要等应用退出，否则请求会挂住
        child.unref()
        setTimeout(resolve, 150)
      })
      return { ok: true, target, mode, summary: `已用系统默认应用打开：${path.basename(target)}` }
    },

    // 忽略某一道验收检查（留理由与判定人，可撤销；硬失败不允许忽略）
    async 'verify.waive'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      return waiveCheck({
        case: dir,
        name: payload && payload.name,
        reason: payload && payload.reason,
        by: payload && payload.by,
        revoke: Boolean(payload && payload.revoke),
      })
    },

    // 五道验收：纯读，不改任何状态（core 里已声明 stateUnchanged）
    async verify(payload) {
      const dir = assertCaseDir(payload && payload.case)
      const r = verifyCase({ case: dir, checks: payload && payload.checks })
      // 把**最近一次验收结果**落盘，界面才不至于刷新一次就忘。
      // 用户 2026-11-01 实测：交付包已经「验收 pass」，验收页却还写「还没跑过验收」，
      // 底部还在催「下一步：跑验收」——因为结果只活在页面内存里。
      // 注意：core 的 verifyCase 刻意不写案件状态（stateUnchanged）；
      // 这里写的是插件侧缓存（.lawcase/last-verify.json），不改变"验收不改案件"的约定。
      try {
        const cacheFile = path.join(casePaths(dir).state, 'last-verify.json')
        writeJsonAtomic(cacheFile, {
          at: r.checkedAt,
          verdict: r.verdict,
          summary: r.summary,
          ok: r.ok,
          checks: (r.checks || []).map((c) => ({ name: c.name, title: c.title, status: c.status, fails: (c.items || []).filter((i) => i.level === 'fail').length })),
        })
      } catch (e) {}
      return r
    },

    /** 读最近一次验收结果（没跑过返回 null） */
    async 'verify.last'(payload) {
      const dir = assertCaseDir(payload && payload.case)
      try {
        const f = path.join(casePaths(dir).state, 'last-verify.json')
        const j = readJson(f, null)
        return j || null
      } catch (e) {
        return null
      }
    },
  }

  /** 统一入口：永远返回 { ok, data } 或 { ok:false, error:{code,message} } */
  async function handle(op, payload) {
    const name = String(op || '').trim()
    if (!name) return { ok: false, error: { code: 'op/empty', message: '缺少 op' } }
    const fn = ops[name]
    if (!fn) {
      return {
        ok: false,
        error: { code: 'op/unknown', message: `未知 op：${name}（可用：${Object.keys(ops).join('、')}）` },
      }
    }
    try {
      const data = await fn(payload || {})
      return { ok: true, data }
    } catch (e) {
      return {
        ok: false,
        error: {
          code: (e && e.code) || 'op/failed',
          message: String((e && e.message) || e),
        },
      }
    }
  }

  return { ops: Object.keys(ops), handle, apiPath: API_PATH }
}
