import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { casePaths, writeJsonAtomic, writeTextAtomic, mutateCase, loadCase, nowIso, log, readJson } from './store.js'

const SKIP_DIRS = new Set(['.lawcase', 'node_modules', '.git', '.Trash', '$RECYCLE.BIN'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 可以把「时间线更新.xlsx」「庭前准备-更新.docx」归到同一个 base 上 */
const VERSION_TAIL =
  /[\s\-_（(【\[]*(更新版|更新|终稿|终版|最终版|最终|最新版|最新|修订版|修订|修改版|修改稿|定稿|副本|复印件|copy|final|new|v\d+|\(\d+\)|（\d+）|第?[一二三四五六七八九十\d]+版)[\s\-_）)】\]]*$/i

export function normBase(filename) {
  let name = filename.replace(/\.[^.]+$/, '')
  let prev
  do {
    prev = name
    name = name.replace(VERSION_TAIL, '').trim()
  } while (name && name !== prev)
  return name || filename.replace(/\.[^.]+$/, '')
}

function walk(root, maxDepth) {
  const out = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      // `~$xxx.doc` 是 Word 打开文件时生成的**临时锁定文件**（0 字节）：
      // 它不是卷宗材料，进台账只会让人以为漏了文件（用户 2026-11-01 截图反馈）。
      // 同理跳过 Office 的 owner 文件与系统缩略文件。
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue // 不跟随链接，避免环与越界
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: p, depth: depth + 1 })
      } else if (e.isFile()) {
        out.push(p)
      }
    }
  }
  return out
}

function sha256(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 256)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

const EXT_CN = {
  '.docx': 'Word', '.doc': 'Word', '.pdf': 'PDF', '.xlsx': 'Excel', '.xls': 'Excel',
  '.pptx': 'PPT', '.md': 'Markdown', '.txt': '文本', '.csv': 'CSV',
  '.jpg': '图片', '.jpeg': '图片', '.png': '图片', '.tif': '图片', '.tiff': '图片',
  '.eml': '邮件', '.msg': '邮件', '.zip': '压缩包',
}

export function renderMaterialsMd(c, files, stats) {
  const lines = [
    `# 材料登记 · ${c.title}`,
    '',
    '> 由 LawCase 扫描生成。**只登记，不复制、不改动源目录**。',
    '',
    `- 源目录：\`${stats.source}\``,
    `- 扫描时间：${stats.scannedAt}`,
    `- 文件总数：${stats.total}（${Object.entries(stats.byExt).map(([k, v]) => `${k} ${v}`).join('，') || '无'}）`,
    `- 真版本组：${stats.groups} 组（旧版 ${stats.stale} 个）`,
    `- 同文档多格式：${stats.formatPairs} 组（docx 工作稿与 pdf 定稿这类，不算版本冲突）`,
    `- 内容重复：${stats.dup} 个`,
    '',
    '## 文件清单',
    '',
    '| 编号 | 文件 | 类型 | 大小 | 最新版 | 备注 |',
    '|---|---|---|---|---|---|',
  ]
  for (const f of files) {
    const note = f.dupOf
      ? `内容与 ${f.dupOf} 相同`
      : f.versionKind === 'stale'
        ? `旧版（同组最新为 ${f.latestOf}）`
        : f.versionKind === 'format'
          ? `同文档另有 ${f.formatsOf}`
          : ''
    const latestCol = f.versionKind === 'format' ? '同格式' : f.isLatest === false ? '否' : '是'
    lines.push(`| ${f.mid} | ${f.rel} | ${EXT_CN[f.ext] || f.ext} | ${(f.size / 1024).toFixed(0)} KB | ${latestCol} | ${note} |`)
  }
  lines.push('')
  const stale = files.filter((f) => f.versionKind === 'stale')
  if (stale.length) {
    lines.push('## 待确认的版本（同格式、多份，需定哪份为准）', '')
    for (const f of stale) {
      const decided = f.decision && f.decision.acceptedMid
      const latest = files.find((x) => x.mid === f.latestOf)
      const acc = decided || (latest && latest.mid)
      const accName = decided ? files.find((x) => x.mid === decided)?.rel || decided : latest?.rel || f.latestOf
      const mark = decided
        ? `[x] \`${f.rel}\` → 已定以 \`${accName}\` 为准（${String(f.decision.at).slice(0, 10)}）`
        : `[ ] \`${f.rel}\` 与 \`${accName}\` 同组，需定以哪份为准`
      lines.push(`- ${mark}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 扫描材料源目录并登记。只读源目录。
 * @param {{case:string, source?:string, recursive?:boolean, hashMaxMB?:number, maxDepth?:number}} args
 */
export function scanMaterials({ case: caseDirRaw, source, recursive = true, hashMaxMB = 0, maxDepth = 8 }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = loadCase(dir)
  const srcRaw = source || (c.materialsDirs && c.materialsDirs[0]) || ''
  if (!srcRaw) throw new Error('没有材料源目录：请在案件里配置 materialsDirs，或传 source 参数')
  const src = path.resolve(dir, srcRaw)

  let st
  try {
    st = fs.statSync(src)
  } catch {
    throw new Error('材料源目录不存在或不可读：' + src)
  }
  if (!st.isDirectory()) throw new Error('材料源不是目录：' + src)

  const absFiles = walk(src, recursive ? maxDepth : 0)
  const hashLimit = hashMaxMB * 1024 * 1024

  const files = absFiles.map((abs, i) => {
    const s = fs.statSync(abs)
    const ext = path.extname(abs).toLowerCase()
    let hash = null
    if (hashMaxMB > 0 && s.size > 0 && s.size <= hashLimit) {
      try {
        hash = sha256(abs)
      } catch {
        hash = null
      }
    }
    return {
      mid: 'M' + (i + 1),
      name: path.basename(abs),
      rel: path.relative(src, abs),
      abs,
      ext,
      kind: EXT_CN[ext] || ext.replace('.', '').toUpperCase() || '其他',
      size: s.size,
      mtime: s.mtime.toISOString(),
      sha256: hash,
      baseKey: path.join(path.dirname(path.relative(src, abs)), normBase(path.basename(abs))),
      isLatest: true,
      latestOf: null,
      dupOf: null,
    }
  })

  // 重扫保留历史定版决定（按相对路径匹配，文件改名则失效并重新提示）
  const prev = readJson(cp.materials, null)
  const prevDecision = new Map()
  for (const f of (prev && prev.files) || []) {
    if (f.decision) prevDecision.set(f.rel, f.decision)
  }
  for (const f of files) {
    const d = prevDecision.get(f.rel)
    if (d) {
      f.decision = d
      f.accepted = d.acceptedMid === f.mid || String(d.accepted).length > 0 ? d.accepted === f.rel : false
    }
  }

  // 版本组：同目录 + 同 base，按 mtime 降序，最新的一份 isLatest
  const byBase = new Map()
  for (const f of files) {
    if (!byBase.has(f.baseKey)) byBase.set(f.baseKey, [])
    byBase.get(f.baseKey).push(f)
  }
  let groups = 0
  let stale = 0
  let formatPairs = 0
  for (const [, grp] of byBase) {
    if (grp.length < 2) continue
    grp.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    const latest = grp[0]
    const exts = new Set(grp.map((f) => f.ext))
    if (exts.size === 1) {
      // 同扩展名 → 真版本关系（更新/终稿/副本）
      groups++
      latest.versionKind = 'latest'
      for (const f of grp.slice(1)) {
        f.isLatest = false
        f.latestOf = latest.mid
        f.latestName = latest.name
        f.versionKind = 'stale'
        stale++
      }
    } else {
      // 不同扩展名 → 同一份文档的多种格式（docx 工作稿 / pdf 定稿），不是版本冲突
      formatPairs++
      for (const f of grp) {
        f.versionKind = 'format'
        f.formatsOf = grp.filter((g) => g.mid !== f.mid).map((g) => g.ext.replace('.', '')).join('/')
      }
    }
  }

  // 用 history 里的定版结果标记 accepted（组内按 rel 对齐）
  for (const [, grp] of byBase) {
    const dec = grp.find((f) => f.decision)
    if (!dec) continue
    const acceptRel = dec.decision.acceptRel
    for (const f of grp) {
      f.decision = dec.decision
      f.accepted = acceptRel ? f.rel === acceptRel : false
    }
    if (!grp.some((f) => f.accepted) && grp[0]) grp[0].accepted = true
  }

  // 内容重复：同 hash
  const byHash = new Map()
  for (const f of files) {
    if (!f.sha256) continue
    if (!byHash.has(f.sha256)) byHash.set(f.sha256, [])
    byHash.get(f.sha256).push(f)
  }
  let dup = 0
  for (const [, grp] of byHash) {
    if (grp.length < 2) continue
    for (const f of grp.slice(1)) {
      f.dupOf = grp[0].mid
      dup++
    }
  }

  const byExt = {}
  for (const f of files) {
    const k = f.ext ? f.ext.replace('.', '') : '无扩展名'
    byExt[k] = (byExt[k] || 0) + 1
  }

  const scannedAt = nowIso()
  const stats = { source: src, scannedAt, total: files.length, byExt, groups, stale, formatPairs, dup }

  writeJsonAtomic(cp.materials, { schema: 1, source: src, scannedAt, stats, files })
  writeTextAtomic(cp.materialsMd, renderMaterialsMd(c, files, stats))

  mutateCase(dir, (doc) => {
    doc.materialsDirs = [src]
    doc.materials = { ...stats, latest: files.filter((f) => f.isLatest).length }
    // 扫到材料＝「确认材料目录清单」这件事已经做过了，提醒跟着消掉。
    // 一个文件都没扫到时保留提醒：那说明目录选错了，还没真正确认。
    if (files.length > 0 && Array.isArray(doc.pendingConfirm)) {
      doc.pendingConfirm = doc.pendingConfirm.filter((q) => !/材料(目录)?清单|卷宗目录/.test(String(q)))
    }
    return doc
  })
  log(dir, { op: 'material-scan', source: src, total: files.length, groups, stale, formatPairs, dup })

  return {
    ok: true,
    source: src,
    total: files.length,
    byExt,
    groups,
    stale,
    formatPairs,
    dup,
    latest: files.filter((f) => f.isLatest).length,
    files,
    written: { materials: cp.materials, view: cp.materialsMd },
    summary:
      `扫描 ${files.length} 个文件（${Object.entries(byExt).map(([k, v]) => `${k}${v}`).join(' ')}）｜` +
      `真版本组 ${groups}（旧版 ${stale}）｜同文档多格式 ${formatPairs} 组｜内容重复 ${dup}`,
  }
}

/** 读已登记的材料（不重新扫描） */
export function listMaterials({ case: caseDirRaw, staleOnly = false }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = loadCase(dir)
  const doc = readJson(cp.materials, null)
  const all = (doc && doc.files) || []
  const files = staleOnly ? all.filter((f) => f.isLatest === false) : all
  return {
    ok: true,
    caseId: c.caseId,
    source: (c.materials && c.materials.source) || null,
    total: all.length,
    shown: files.length,
    files: files.map((f) => ({ mid: f.mid, rel: f.rel, kind: f.kind, size: f.size, isLatest: f.isLatest, latestOf: f.latestOf, dupOf: f.dupOf })),
    summary: all.length ? `已登记 ${all.length} 个文件${staleOnly ? `，其中非最新 ${files.length} 个` : ''}` : '尚未扫描材料（用 lc_material_scan）',
  }
}

/**
 * 定版：一组版本里指定哪份为准。决定写进台账，不是口头结论。
 * @param {{case:string, group:string, accept:string, note?:string}} args
 */
export function decideMaterial({ case: caseDirRaw, group, accept, note = '' }) {
  const dir = path.resolve(caseDirRaw)
  const cp = casePaths(dir)
  const c = loadCase(dir)
  const doc = readJson(cp.materials, null)
  if (!doc || !doc.files) throw new Error('还没有材料登记，先跑 lc_material_scan')

  const g = String(group || '').trim().toUpperCase()
  const a = String(accept || '').trim().toUpperCase()
  if (!g || !a) throw new Error('group 与 accept 都要给材料编号（如 group=M3, accept=M2）')

  const target = doc.files.find((f) => f.mid === g)
  if (!target) throw new Error(`材料编号 ${g} 不存在`)
  const grp = doc.files.filter((f) => f.baseKey === target.baseKey)
  if (grp.length < 2) throw new Error(`${g} 不在任何版本组里，不需要定版`)
  const acc = doc.files.find((f) => f.mid === a)
  if (!acc) throw new Error(`材料编号 ${a} 不存在`)
  if (acc.baseKey !== target.baseKey) throw new Error(`${a} 与 ${g} 不是同一组，不能互定`)

  const at = nowIso()
  for (const f of grp) {
    f.decision = { at, acceptedMid: acc.mid, acceptRel: acc.rel, note: note || undefined }
    f.accepted = f.mid === acc.mid
  }
  doc.decisions = [...(doc.decisions || []), { at, group: g, accept: a, members: grp.map((f) => f.mid), note }]
  writeJsonAtomic(cp.materials, doc)
  writeTextAtomic(cp.materialsMd, renderMaterialsMd(c, doc.files, doc.stats))

  mutateCase(dir, (d) => {
    d.confirmed = d.confirmed || {}
    d.confirmed['材料定版:' + target.baseKey] = { accept: acc.rel, at, group: grp.map((f) => f.mid) }
    const still = doc.files.filter((f) => f.versionKind === 'stale' && !(f.decision && f.decision.acceptedMid)).length
    d.pendingConfirm = (d.pendingConfirm || []).filter((q) => !String(q).includes(target.baseKey))
    if (still) d.pendingConfirm.push(`材料定版剩余 ${still} 组未定（见 材料登记.md）`)
    return d
  })
  log(dir, { op: 'material-decide', group: g, accept: a })

  const still = doc.files.filter((f) => f.versionKind === 'stale' && !(f.decision && f.decision.acceptedMid)).length
  return {
    ok: true,
    group: grp.map((f) => ({ mid: f.mid, rel: f.rel, accepted: !!f.accepted })),
    accepted: acc.rel,
    remainingUndecided: still,
    summary: `已定以 ${acc.mid}（${acc.rel}）为准｜同组 ${grp.length} 份｜剩余未定 ${still} 组`,
  }
}
