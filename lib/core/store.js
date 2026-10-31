// 账本存储层：原子写 + 文件锁 + JSONL 追加
//
// 同步盘（Synology Drive / iCloud / OneDrive）的现实：文件会被后台同步进程同时读写，
// 直接覆盖半截文件会产生「冲突副本」。所以这里所有写都走 临时文件 → rename，
// 关键结构修改（case.json）再套一层目录锁。

import fs from 'node:fs'
import path from 'node:path'

export const STATE = '.lawcase'

/** 案件内各文件位置 */
export function casePaths(caseDir) {
  const s = path.join(caseDir, STATE)
  return {
    state: s,
    caseJson: path.join(s, 'case.json'),
    facts: path.join(s, 'facts.jsonl'),
    findings: path.join(s, 'findings.jsonl'),
    laws: path.join(s, 'laws.jsonl'),
    review: path.join(s, 'review.jsonl'),
    clauses: path.join(s, 'clauses.json'),
    notes: path.join(s, 'notes.jsonl'),
    materials: path.join(s, 'materials.json'),
    materialsMd: path.join(s, '材料登记.md'),
    progress: path.join(s, 'progress.md'),
    conclusion: path.join(s, 'conclusion.md'),
    log: path.join(s, 'log.jsonl'),
    cache: path.join(s, 'cache'),
    lock: path.join(s, '.lock'),
  }
}

export const nowIso = () => new Date().toISOString()

const sleepSync = (ms) => {
  // Atomics.wait 是唯一不阻塞事件循环之外线程的同步 sleep
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback
    throw new Error(`读取 ${path.basename(file)} 失败：${(e && e.message) || e}`)
  }
}

/** 原子写：同步盘上避免半截文件的标准做法 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return file
}

export function writeTextAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

export function writeJsonl(file, records) {
  const body = records.map((r) => JSON.stringify(r)).join('\n')
  writeTextAtomic(file, body ? body + '\n' : '')
}

export function readJsonl(file) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch (e) {
      // 坏行不吞掉整份台账：保留标记，让体检环节能报出来
      out.push({ __broken: true, raw: t.slice(0, 200) })
    }
  }
  return out
}

/**
 * 目录锁：mkdir 的原子性做互斥。
 * 拿不到锁时给可执行的提示，而不是让调用方对着 EEXIST 发呆。
 */
export function withLock(lockPath, fn, { timeoutMs = 6000, staleMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let acquired = false
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath)
      acquired = true
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // 陈旧锁（进程崩溃留下的）：按 mtime 判定后清理
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.rmdirSync(lockPath) } catch (_) {}
          continue
        }
      } catch (_) {}
      sleepSync(60)
    }
  }
  if (!acquired) {
    throw new Error(
      `无法获取案件锁（${lockPath}）。可能有另一个会话/窗口正在写同一案件；` +
      `若确认没有并发，删除该目录后重试。`
    )
  }
  try {
    return fn()
  } finally {
    try { fs.rmdirSync(lockPath) } catch (_) {}
  }
}

/** 读-改-写 case.json 的标准姿势：加锁 + 原子写 */
export function mutateCase(caseDir, mutator) {
  const p = casePaths(caseDir)
  return withLock(p.lock, () => {
    const cur = readJson(p.caseJson, null)
    if (!cur) throw new Error(`该目录不是 LawCase 案件（缺少 ${path.join(STATE, 'case.json')}）：${caseDir}`)
    const next = mutator(cur)
    next.updatedAt = nowIso()
    writeJsonAtomic(p.caseJson, next)
    return next
  })
}

/** 只读打开：确认是案件目录并返回内容 */
export function loadCase(caseDir) {
  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件（缺少 ${path.join(STATE, 'case.json')}）：${caseDir}`)
  return c
}

/**
 * 追加一条案件日志。
 *
 * 签名兼容两种写法：
 *   log(dir, { op: 'x', ...payload })      ← 推荐
 *   log(dir, 'x', { ...payload })          ← 历史写法（19 处调用在用）
 *
 * 为什么必须兼容：老写法把字符串当 record 展开，`{ ts, ...'note-add' }`
 * 会得到 {"0":"n","1":"o",...}，整条日志变成按字符索引的垃圾——
 * 2026-10-26 排查「AI 审核完却提示没有草稿」时才发现日志全不可读。
 * 与其改 19 个调用点（容易漏、且老代码不该被无谓改动），不如在这里收口。
 */
export function log(caseDir, record, extra) {
  let rec = record
  if (typeof record === 'string') {
    rec = Object.assign({ op: record }, extra && typeof extra === 'object' ? extra : {})
  } else if (!rec || typeof rec !== 'object') {
    rec = {}
  }
  const row = Object.assign({ ts: nowIso() }, rec)

  // ① 案件侧：对外证据（交付包里要能看见「这个案子的台账是怎么长出来的」）
  let wroteCase = false
  try {
    appendJsonl(casePaths(caseDir).log, row)
    wroteCase = true
  } catch (e) {
    // 日志失败不得拖垮主流程
  }

  // ② 插件侧：跨案件可查的操作流水（谁、什么时候、对哪个案、干了什么）
  // 2026-10-31 实测：插件日志 1464 行全是挂载记录，零业务操作 ⇒ 改错案卷查不到。
  try {
    const sink = auditSink()
    if (sink) sink({ caseDir, record: row, previous: rec.previous || null })
  } catch (e) {
    // 审计失败同样不得拖垮主流程
  }
  return wroteCase
}

/**
 * 审计落点由宿主装配时注入（index.js / cli.js），store 本身不认识 pkgRoot。
 *
 * 为什么不在这里 import audit.js：core/store 被 CLI、单测、子进程共用，
 * 一旦它反过来依赖「插件装在哪儿」，纯函数层就破了。
 * 用一个可注入的 sink，既保住分层，又保住「所有 log() 都进审计」这个不变量。
 */
let _auditSink = null
export function setAuditSink(fn) {
  _auditSink = typeof fn === 'function' ? fn : null
}
export function auditSink() {
  return _auditSink
}
