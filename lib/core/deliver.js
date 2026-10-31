import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { casePaths, readJson } from './store.js'
import { loadFacts } from './fact.js'
import { verifyCase } from './verify.js'
// 交付包要能说清「谁审的、按什么口径、哪些判为无需修改、哪些片段被接受」
import { loadAiAudit, loadDraftsDetail } from './aireview.js'
import { loadRulings } from './clause.js'
import { patchRecordPath } from './patchrevise.js'

/** 交付包时间戳：本地时间 YYYYMMDD-HHmm */
function stampFor(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function pluginVersion() {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '?'
  } catch {
    return '?'
  }
}

/**
 * 交付包：把散落的产物打成一个可交给合伙人的目录。
 *
 * 设计取舍：
 * - 五道验收有 fail 时**拒绝生成**（除非 force）。交付等于外发，带 red flag 的包不该流出去。
 * - 缺什么就明写"未包含"，不留空白让人误以为齐了。
 * - 每个文件算 sha256，证明交出去之后没被动过。
 * - 只算 ≤50MB 的文件哈希（云盘上对大 PDF 算 sha256 会挂住）。
 */

const MAX_HASH = 50 * 1024 * 1024

function sha256File(p) {
  const st = fs.statSync(p)
  if (st.size > MAX_HASH) return { sha256: null, bytes: st.size, skipped: true }
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(p))
  return { sha256: h.digest('hex'), bytes: st.size, skipped: false }
}

function human(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 在目录里找最新的匹配文件，跳过 Word 临时锁文件（~$ 开头） */
function newest(dir, test) {
  if (!fs.existsSync(dir)) return null
  const hits = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('~$') && test(d.name))
    .map((d) => {
      const p = path.join(dir, d.name)
      return { p, name: d.name, mtime: fs.statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0] || null
}

function renderFactsMd(caseDir) {
  // 复用 core/fact 的视图：它会按 id 合并原始行与后续的作废/复核记录
  const { active, revoked } = loadFacts(caseDir)
  const lines = [
    '# 事实台账',
    '',
    `> 共 ${active.length} 条有效事实，${revoked.length} 条已作废。每条必须能追到出处。`,
    '',
  ]
  if (!active.length) lines.push('（无有效事实）')
  else {
    lines.push('| 编号 | 事实 | 出处 | 复核 |', '|---|---|---|---|')
    for (const f of active) {
      const file = (f.source && f.source.file) || '（缺出处）'
      const loc = (f.source && f.source.locator) || ''
      const mid = f.source && f.source.materialId ? `${f.source.materialId} ` : ''
      const src = loc ? `${mid}${file} · ${loc}` : `${mid}${file}`
      const esc = (x) => String(x == null ? '' : x).replace(/\|/g, '\\|')
      lines.push(`| ${f.id} | ${esc(f.text)} | ${esc(src)} | ${f.verified ? '已复核' : '待复核'} |`)
    }
  }
  if (revoked.length) {
    lines.push('', '## 已作废', '', '| 编号 | 原文 | 作废理由 |', '|---|---|---|')
    const esc = (x) => String(x == null ? '' : x).replace(/\|/g, '\\|')
    for (const f of revoked) lines.push(`| ${f.id} | ${esc(f.text)} | ${esc(f.reason || '—')} |`)
  }
  return lines.join('\n') + '\n'
}

function renderClausesMd(caseDir) {
  const doc = readJson(casePaths(caseDir).clauses, null)
  const files = (doc && doc.files) || []
  const lines = ['# 条款索引', '', '> 合同按「第X条」切分后的目录。审核意见即挂在这些条款上。', '']
  if (!files.length) lines.push('（尚未索引任何合同）')
  for (const f of files) {
    lines.push(`## ${f.name}`, '', `- 段落数：${f.paragraphs}｜条款数：${(f.clauses || []).length}`, '')
    lines.push('| 条款 | 标题 | 字数 |', '|---|---|---|')
    for (const c of f.clauses || []) {
      lines.push(`| ${c.no} | ${String(c.heading || '').replace(/\|/g, '\\|').slice(0, 60)} | ${c.chars || 0} |`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

function renderVerifyMd(v) {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' }
  const lines = [
    '# 五道验收结果',
    '',
    `- 校验时间：${v.checkedAt}`,
    `- 结论：**${v.verdict}** —— ${v.summary}`,
    `- 未改动案件状态：${v.stateUnchanged ? '是' : '否'}`,
    '',
    '| 校验项 | 结果 | 说明 |',
    '|---|---|---|',
  ]
  for (const c of v.checks) {
    const detail = c.items.length ? c.items.map((i) => i.msg).join('；') : '—'
    lines.push(`| ${c.title} | ${icon[c.status] || c.status} | ${String(detail).replace(/\|/g, '\\|')} |`)
  }
  if (v.mustFix.length) {
    lines.push('', '## 必须修', '')
    for (const m of v.mustFix) lines.push(`- ${m.msg}${m.ref ? `（\`${m.ref}\`）` : ''}`)
  }
  return lines.join('\n') + '\n'
}

export function buildDelivery({ case: caseDirRaw, label = '', force = false, outDir = '' }) {
  if (!caseDirRaw) throw new Error('case 不能为空：请给出案件工作目录绝对路径')
  const caseDir = path.resolve(String(caseDirRaw))
  const p = casePaths(caseDir)
  const c = readJson(p.caseJson, null)
  if (!c) throw new Error(`该目录不是 LawCase 案件（缺少 .lawcase/case.json）：${caseDir}`)

  const v = verifyCase({ case: caseDir })
  const type = v.caseType || 'litigation'
  if (v.verdict === 'needs_fix' && !force) {
    const fix = v.mustFix.map((m) => `  · ${m.msg}`).join('\n')
    throw new Error(
      `验收未通过，不出交付包：${v.summary}\n${fix}\n\n` +
        '这些是硬性失败，带出去的包会被当成"已审核完成"。修完再出；确要留档请传 force=true（包名会带「未通过验收」标记）。',
    )
  }

  // AI 审核与人工判定的留痕：只读，取不到就给空值（不能因为没审过 AI 就出不了包）
  const aiTrace = (() => {
    try {
      const d = readJson(patchRecordPath(caseDir), null)
      return {
        audit: loadAiAudit({ case: caseDir, limit: 20 }),
        drafts: loadDraftsDetail({ case: caseDir }),
        // 判定有两种：norevision（无需修改）与 revision（需修改）。
        // 这里**分开存**，混在一起会把「需修改」错写进「无需修改」表（真机验证时踩到）。
        rulings: loadRulings({ case: caseDir }).filter((r) => r && r.kind === 'norevision'),
        revisions: loadRulings({ case: caseDir }).filter((r) => r && r.kind === 'revision'),
        patch: d
          ? {
              status: d.status,
              count: Array.isArray(d.accepted) ? d.accepted.length : 0,
              accepted: d.accepted || [],
              outFile: d.outFile || '',
              message: d.message || '',
              code: d.code || '',
            }
          : null,
      }
    } catch (e) {
      return { audit: null, drafts: null, rulings: [], patch: null }
    }
  })()

  const stamp = stampFor(new Date())
  // 目录只带时间戳；验收结论写在 04_五道验收.md 与 delivery.json 里。
  // 名字里挂「未通过验收」会让人只看文件名就下结论，也容易和旧包混。
  const base = `交付包_${stamp}`
  const outDir0 = path.join(caseDir, 'out') // 产物在案件根的 out/，不在 .lawcase/ 下
  const dir = path.join(outDir ? path.resolve(outDir) : caseDir, base)
  if (fs.existsSync(dir)) throw new Error(`交付目录已存在：${dir}`)
  fs.mkdirSync(dir, { recursive: true })

  const files = []
  const missing = []
  const notes = [] // 不是缺项，但需要说明"为什么没有"
  const add = (num, srcPath, name, desc) => {
    const info = sha256File(srcPath)
    const target = path.join(dir, name)
    fs.copyFileSync(srcPath, target)
    files.push({ num, name, desc, bytes: info.bytes, sha256: info.sha256 })
  }

  // 01 审核意见报告
  const rep =
    newest(outDir0, (n) => /^合同审核意见_.*\.md$/.test(n)) ||
    newest(outDir0, (n) => n.endsWith('.md') && !n.startsWith('修订版'))
  if (rep) add('01', rep.p, '01_合同审核意见.md', '条款级意见（含级别、定位、建议替换文字）')
  else missing.push(type === 'contract' ? '合同审核意见报告：本类型必含，需先跑 lc_report' : '合同审核意见报告：本案件 out/ 下没有报告，需先跑 lc_report')

  // 02 修订版
  const red = newest(outDir0, (n) => n.startsWith('修订版_') && n.endsWith('.docx'))
  if (red) add('02', red.p, '02_修订版合同.docx', '带修订痕迹的合同（Word 里可逐条接受/拒绝）')
  else missing.push('修订版合同：未生成修订版 docx，需先跑 lc_contract_revise')

  // 03 事实台账（合同审核案不需要：它的产出是意见清单，不是事实清单）
  const factsDir = path.join(dir, '_tmp')
  fs.mkdirSync(factsDir, { recursive: true })
  const factsPath = path.join(factsDir, 'facts.md')
  if (type === 'contract') {
    // 合同审核案的核心结构是条款，不是事实：换成条款索引比放一份空台账有用
    fs.writeFileSync(factsPath, renderClausesMd(caseDir), 'utf8')
    add('03', factsPath, '03_条款索引.md', '合同切条目录，意见即挂在这些条款上')
  } else {
    fs.writeFileSync(factsPath, renderFactsMd(caseDir), 'utf8')
    add('03', factsPath, '03_事实台账.md', '每条事实带出处与复核状态')
  }
  fs.rmSync(factsDir, { recursive: true, force: true })

  // 04 五道验收
  const vpath = path.join(dir, '_v.md')
  fs.writeFileSync(vpath, renderVerifyMd(v), 'utf8')
  add(
    '04',
    vpath,
    '04_五道验收.md',
    type === 'contract' ? '条款/法条/意见/格式/保密五道结果' : '事实/法条/逻辑/格式/保密五道结果',
  )
  fs.rmSync(vpath, { force: true })

  // 05 进度台账
  if (fs.existsSync(p.progress)) add('05', p.progress, '05_进度台账.md', '工序完成情况与待确认项')
  else missing.push('进度台账：缺少 progress.md')

  // 06 结论台账
  if (fs.existsSync(p.conclusion)) add('06', p.conclusion, '06_结论台账.md', '已登记结论及其事实/法条引用')
  else missing.push('结论台账：缺少 conclusion.md')

  // 07 材料登记
  const matMd = [p.materialsMd, path.join(caseDir, '材料登记.md')].find((x) => x && fs.existsSync(x))
  if (matMd) add('07', matMd, '07_材料登记.md', '材料编号、版本组与定版结果')
  else if (type === 'contract') {
    // 合同审核案的必要材料就是那几份合同，已通过条款索引登记，不另做目录扫描
    notes.push('材料登记：本案为单文件合同审核，必要材料已通过条款索引登记，未另做目录扫描')
  } else missing.push('材料登记：尚未扫描材料（lc_material_scan）')

  // 清单
  const icon = { pass: '✅ 通过', warn: '⚠️ 待人工确认', fail: '❌ 未通过' }
  const lines = [
    `# 交付清单 · ${c.title}`,
    '',
    '> 本包由 LawCase 生成。**所有内容均为初稿**，须经承办律师复核后方可对外使用。',
    '',
    `- 案件编号：\`${c.caseId}\``,
    `- 案型：${type === 'contract' ? '合同审核' : '诉讼/争议'}（验收判据按案型分派）`,
    `- 当事人：${c.parties || '（未填）'}`,
    `- 案由：${c.cause || '（未填）'}`,
    label ? `- 交付对象：${label}` : '- 交付对象：（未指定）',
    `- 生成时间：${stamp}`,
    `- 验收结论：**${v.verdict}** —— ${v.summary}`,
    '',
    '## 一、交付文件',
    '',
    '| 编号 | 文件 | 说明 | 大小 | SHA256（前 16 位） |',
    '|---|---|---|---|---|',
  ]
  for (const f of files) {
    const shown = f.name.replace(/^\d+_/, '')
    lines.push(`| ${f.num} | ${shown} | ${f.desc} | ${human(f.bytes)} | ${f.sha256 ? f.sha256.slice(0, 16) : '未计算'} |`)
  }
  lines.push('', '## 二、五道验收', '', '| 校验项 | 结果 |', '|---|---|')
  for (const ck of v.checks) lines.push(`| ${ck.title} | ${icon[ck.status] || ck.status} |`)
  // ---- AI 审核与人工判定（文档 4.7 要求交付包能说清这四件事）----
  lines.push('', '## 三、AI 审核与人工处理留痕', '')
  const ai = aiTrace || {}
  const rulings = Array.isArray(ai.rulings) ? ai.rulings : []
  // 注意：loadAiAudit/loadDraftsDetail 在「没有记录」时也返回 {count:0} 对象，
  // 所以这里必须按**条数**判断是不是空的，不能按对象是否为空。
  const hasAny =
    (ai.audit && ai.audit.count > 0) ||
    (ai.drafts && ai.drafts.count > 0) ||
    rulings.length > 0 ||
    (ai.patch && ai.patch.status)
  if (!hasAny) {
    lines.push('（本案没有使用 AI 审核，也没有「无需修改」判定记录）')
  } else {
    if (ai.audit && ai.audit.items && ai.audit.items.length) {
      const last = ai.audit.items[0]
      lines.push(
        `- 实际模型：${(last.model && last.model.label) || (last.model && last.model.model) || '（未记录）'}`,
        `- 审核口径：立场 ${last.stance || '—'}｜类型 ${last.templateId || '—'}` +
          (last.instructions ? `｜补充要求：${last.instructions}` : ''),
        `- 审核时间：${last.at || '—'}（共 ${ai.audit.count} 次，最近一次 ${last.status === 'ok' ? '成功' : '失败：' + (last.code || '')}）`,
        last.contract && last.contract.sha256 ? `- 合同指纹：\`${String(last.contract.sha256).slice(0, 16)}\`` : '',
        last.promptVersion ? `- 提示词版本：${last.promptVersion}` : ''
      )
      const failed = ai.audit.items.filter((x) => x.status !== 'ok')
      if (failed.length) {
        lines.push('', `> 注意：有 ${failed.length} 次 AI 审核失败（${failed.map((x) => x.code || '未知').join('、')}）。失败不等于没有风险。`, '')
      }
    } else {
      lines.push('- 本案未留下 AI 审核记录')
    }
    if (ai.drafts && ai.drafts.count) {
      lines.push('', `- 仍有 ${ai.drafts.count} 条 AI 草稿未处理（未采纳也未丢弃）：这些条款尚未形成审核结论`)
    }
    if (rulings.length) {
      lines.push('', `### 人工判定「已审·无需修改」${rulings.length} 条`, '', '| 条款 | 理由 | 判定人 | 时间 |', '|---|---|---|---|')
      for (const r of rulings) {
        lines.push(`| ${r.clause || ''} | ${String(r.reason || '').replace(/\|/g, '｜')} | ${r.by || '—'} | ${r.at || ''} |`)
      }
    }
    // 「需修改」的条款已经体现为正式意见（notes.jsonl），这里只报个数，避免和上方意见表重复
    const revisions = Array.isArray(ai.revisions) ? ai.revisions : []
    if (revisions.length) {
      lines.push('', `- 人工判定「已审·需修改」${revisions.length} 条（条款：${revisions.map((r) => r.clause).join('、')}），具体意见见意见表`)
    }
    if (ai.patch && ai.patch.status === 'applied') {
      lines.push('', `- 片段级修订：接受 ${ai.patch.count} 处` + (ai.patch.outFile ? `（${path.basename(ai.patch.outFile)}）` : ''))
      for (const a of ai.patch.accepted || []) {
        lines.push(`  - ${a.clause}：「${String(a.original || '').slice(0, 40)}」→「${String(a.replacement || '').slice(0, 40)}」`)
      }
    } else if (ai.patch && ai.patch.status === 'rejected') {
      lines.push('', `- 片段级修订：上次未应用（${ai.patch.message || ai.patch.code || ''}）`)
    }
  }

  lines.push('', '## 四、未包含的内容', '')
  if (!missing.length && !notes.length) lines.push('（无，材料齐全）')
  for (const m of missing) lines.push(`- ${m}`)
  for (const n of notes) lines.push(`- ${n}`)
  lines.push(
    '',
    '## 五、复核提示',
    '',
    '1. 先看 `04_五道验收.md`：里面凡标 ⚠️ 的，都需要人工确认后才能定稿。',
    '2. 修订版合同在 Word 中打开，逐条「接受/拒绝」；未接受的修订不生效。',
    '3. 事实台账里标「待复核」的条目，请核对出处后再确认。',
    '4. 本包不含对外脱敏版本；如需外发，另跑脱敏导出。',
    '',
    `> 生成器：lawcase v${pluginVersion()} ｜ 清单里的 SHA256 可核对文件未被篡改。`,
    '',
  )
  const listPath = path.join(dir, '交付清单.md')
  fs.writeFileSync(listPath, lines.join('\n'), 'utf8')

  const manifest = {
    caseId: c.caseId,
    title: c.title,
    label: label || null,
    builtAt: stamp,
    verdict: v.verdict,
    checks: v.checks.map((x) => ({ name: x.name, title: x.title, status: x.status })),
    files: files.map((f) => ({ num: f.num, name: f.name, desc: f.desc, bytes: f.bytes, sha256: f.sha256 })),
    missing,
    notes,
    // 谁审的、按什么口径审的、哪些条款判为无需修改、哪些片段被接受
    aiReview: aiTrace && aiTrace.audit ? { count: aiTrace.audit.count, latest: (aiTrace.audit.items || [])[0] || null } : null,
    rulings: (aiTrace && aiTrace.rulings) || [],
    revisions: (aiTrace && aiTrace.revisions) || [],
    pendingDrafts: aiTrace && aiTrace.drafts ? aiTrace.drafts.count : 0,
    fragmentRevision: aiTrace && aiTrace.patch ? { status: aiTrace.patch.status, count: aiTrace.patch.count, accepted: aiTrace.patch.accepted || [] } : null,
    notice: '本包内容为初稿，须经承办律师复核后方可对外使用。',
  }
  fs.writeFileSync(path.join(dir, 'delivery.json'), JSON.stringify(manifest, null, 2), 'utf8')

  return {
    ok: true,
    dir,
    base,
    verdict: v.verdict,
    files: files.map((f) => ({ num: f.num, name: f.name, bytes: f.bytes })),
    missing,
    notes,
    summary: `交付包已生成：${base}｜${files.length} 个文件｜验收 ${v.verdict}${missing.length ? `｜${missing.length} 项未包含` : ''}`,
  }
}
