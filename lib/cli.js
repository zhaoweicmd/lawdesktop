// LawCase CLI 兜底入口
//
// 为什么要有它：插件的 core 层是纯函数，不依赖宿主。宿主侧工具（lc_*）要重启才刷新，
// 开发期在本会话里根本调不到 —— CLI 让我能用 node 直接跑同一条代码路径做端到端验证，
// 也保证宿主 API 变了插件还能退成命令行工具（设计文档里的「可退」不是口号）。
//
// 用法：
//   node lib/cli.js ping
//   node lib/cli.js case-new --dir <案件目录> --title <标题> [--cause <案由>] [--parties <当事人>] [--client <委托人>]
//   node lib/cli.js case-open --case <案件目录>
//   node lib/cli.js case-status --case <案件目录>
//   node lib/cli.js case-verify --case <案件目录>
//   node lib/cli.js proc-plan --case <案件目录> --spec @procs.json [--replace] [--force]
//   node lib/cli.js proc-update --case <案件目录> --id P1 --status doing [--note ...] [--accept]
//   node lib/cli.js proc-list --case <案件目录>

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRoot, stateDir, probeWritable } from './core/paths.js'
import { setAuditSink } from './core/store.js'
import { writeAudit } from './core/audit.js'
import { newCase, openCase } from './core/case.js'
import { verifyCase } from './core/verify.js'
import { planProcesses, updateProcess, listProcesses } from './core/proc.js'
import { scanMaterials, listMaterials, decideMaterial } from './core/material.js'
import { parseMaterial, listParsed } from './core/parse.js'
import { addLaw, loadLaws, localVerdict, verifyLawWithMcp, probePkulaw, listPkulawTools } from './core/law.js'
import { openReview, addAttack, addReply, addVerdict, listReview, detectAdvice } from './core/review.js'
import { indexClauses, addNote, listNotes, deleteNote, buildReport } from './core/clause.js'
import { draftSkill } from './tools/skill.js'
import { publishSkill, listSkills, testSkill } from './core/skill.js'
import { reviseContract } from './core/redline.js'
import { addFact, listFacts, draftFacts, revokeFact, amendFact } from './core/fact.js'
import { addFinding, listFindings } from './core/finding.js'

// 版本单一真相源：package.json（index.js 的常量由测试保证一致）
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import fs from 'node:fs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'

// CLI 跑同一条代码路径，审计也必须跟着走：否则「用 CLI 改的案件查不到记录」。
// LAWCASE_AUDIT_ROOT 允许测试把审计指到临时目录；默认落在插件包内（和宿主一致）。
setAuditSink(({ caseDir, record, previous }) =>
  writeAudit({
    pkgRoot: process.env.LAWCASE_AUDIT_ROOT || PKG_ROOT,
    record,
    caseDir,
    previous,
  })
)

function optOr(name) {
  const v = opt(name, undefined)
  return v === true || v === '' ? undefined : v
}

function opt(name, def = '') {
  const i = argv.indexOf('--' + name)
  if (i === -1) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

try {
  if (cmd === 'ping') {
    const root = resolveRoot({ root: 'auto' }, PKG_ROOT)
    const sd = stateDir(root, PKG_ROOT)
    out({
      ok: true,
      plugin: 'lawcase',
      version: VERSION,
      entry: 'cli',
      node: process.version,
      platform: process.platform + '-' + process.arch,
      pkgRoot: PKG_ROOT,
      root,
      rootSource: root ? 'auto(pkgSibling)' : 'none',
      stateDir: sd,
      stateWritable: probeWritable(sd),
      caseCommands: [
        'case-new', 'case-open', 'case-status', 'case-next', 'brief',
        'proc-plan', 'proc-update', 'proc-list',
        'material-scan', 'material-list', 'material-parse', 'material-parse-all', 'material-parsed', 'material-decide',
        'fact-add', 'fact-add-many', 'fact-list', 'fact-draft', 'fact-confirm', 'fact-revoke', 'fact-amend',
        'finding-add', 'finding-list',
        'verify', 'deliver', 'pipeline',
        'skill-draft', 'skill-list', 'skill-publish', 'skill-test',
        'review-auto', 'review-open', 'review-attack', 'review-reply', 'review-verdict', 'review-list',
        'contract-index', 'note-add', 'note-list', 'note-delete', 'contract-revise', 'contract-report',
        'ledger-scan', 'ledger-fix',
        'law-add', 'law-list', 'law-probe', 'law-verify', 'law-tools',
        'enterprise-probe', 'enterprise-tools', 'enterprise-query',
      ],
    })
  } else if (cmd === 'case-new') {
    const dir = opt('dir')
    if (!dir || dir === true) throw new Error('缺少 --dir <案件目录绝对路径>')
    const r = newCase({
      dir,
      title: opt('title', '') === true ? '' : opt('title', ''),
      cause: opt('cause', '') === true ? '' : opt('cause', ''),
      parties: opt('parties', '') === true ? '' : opt('parties', ''),
      client: opt('client', '') === true ? '' : opt('client', ''),
    })
    out({ ok: true, entry: 'cli', ...r })
  } else if (cmd === 'case-open') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const r = openCase({ case: c, client: opt('client', '') })
    out({ ok: true, entry: 'cli', ...r })
  } else if (cmd === 'case-status') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const o = openCase({ case: c })
    const proc = o.proc || {}
    out({
      ok: true, entry: 'cli',
      caseId: o.caseId, title: o.title, cause: o.cause, status: o.status,
      proc, facts: o.facts, materials: o.materials, pendingConfirm: o.pendingConfirm || [],
      summary: `${o.caseId}｜${o.status}｜工序 ${proc.done || 0}/${proc.total || 0}｜事实 ${(o.facts && o.facts.total) || 0} 条（未核 ${(o.facts && o.facts.unverified) || 0}）`,
    })
  } else if (cmd === 'skill-publish') {
    const caseDir = opt('case')
    const name = opt('name')
    if (!caseDir || !name) throw new Error('用法：skill-publish --case <案件目录> --name <Skill 名>')
    const r = publishSkill({ root: resolveRoot({ root: 'auto' }, PKG_ROOT), case: caseDir, name })
    out(r.summary)
  } else if (cmd === 'skill-list') {
    const r = listSkills({ root: resolveRoot({ root: 'auto' }, PKG_ROOT) })
    out(r.summary)
    for (const sk of r.skills) out(`- ${sk.name}｜${sk.scene || '—'}｜${sk.items} 项｜来自 ${sk.from?.title || '—'}`)
  } else if (cmd === 'skill-test') {
    const caseDir = opt('case')
    const name = opt('name')
    if (!name) throw new Error('用法：skill-test --name <Skill 名> [--case <案件目录>]')
    const r = testSkill({ root: resolveRoot({ root: 'auto' }, PKG_ROOT), name, case: caseDir })
    out(r.summary)
    for (const t of r.tests) {
      out(`${t.pass ? '✓' : '✗'} ${t.name}`)
      for (const pb of t.problems) out(`    - ${pb}`)
    }
    if (!r.pass) process.exitCode = 1
  } else if (cmd === 'deliver') {
    const { buildDelivery } = await import('./core/deliver.js')
    const caseDir = opt('case')
    if (!caseDir) throw new Error('用法：deliver --case <案件目录> [--label 致合伙人] [--force]')
    out(
      buildDelivery({
        case: caseDir,
        label: opt('label'),
        force: opt('force') === true,
        outDir: opt('out'),
      }),
    )
  } else if (cmd === 'case-verify') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(verifyCase({ case: c }))
  } else if (cmd === 'proc-plan') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const spec = opt('spec')
    if (!spec || spec === true) throw new Error('缺少 --spec <JSON数组，或以 @ 开头指向 json 文件>')
    const raw = spec.startsWith('@') ? fs.readFileSync(spec.slice(1), 'utf8') : spec
    let processes
    try { processes = JSON.parse(raw) } catch (e) { throw new Error('--spec 不是合法 JSON：' + e.message) }
    out({ ok: true, entry: 'cli', ...planProcesses({ case: c, processes, replace: !!opt('replace'), force: !!opt('force') }) })
  } else if (cmd === 'proc-update') {
    const c = opt('case'), id = opt('id'), st = opt('status')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!id || id === true) throw new Error('缺少 --id <工序id>')
    if (!st || st === true) throw new Error('缺少 --status <todo|doing|done|blocked>')
    out({ ok: true, entry: 'cli', ...updateProcess({ case: c, id, status: st, note: opt('note', ''), acceptResult: !!opt('accept') }) })
  } else if (cmd === 'proc-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const r = listProcesses({ case: c })
    out({
      ...r,
      summary: `${r.caseId}｜工序 ${r.done}/${r.total} 完成｜可开工 ${r.ready.map((p) => p.id).join('/') || '无'}${r.blocked.length ? '｜阻塞 ' + r.blocked.map((p) => p.id).join('/') : ''}`,
    })
  } else if (cmd === 'material-scan') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const r = scanMaterials({
      case: c,
      source: opt('source', '') || '',
      recursive: opt('no-recursive') ? false : true,
      hashMaxMB: (() => {
        const v = opt('hash-max', '')
        return v === '' || v === true ? 0 : Math.max(0, Number(v) || 0)
      })(),
    })
    out({ ...r, files: r.files.map((f) => ({ mid: f.mid, rel: f.rel, kind: f.kind, size: f.size, isLatest: f.isLatest, latestOf: f.latestOf, versionKind: f.versionKind, formatsOf: f.formatsOf, dupOf: f.dupOf })) })
  } else if (cmd === 'material-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(listMaterials({ case: c, staleOnly: !!opt('stale') }))
  } else if (cmd === 'material-decide') {
    const c = opt('case'), g = opt('group'), a = opt('accept')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!g || g === true) throw new Error('缺少 --group <组内任一材料编号>')
    if (!a || a === true) throw new Error('缺少 --accept <定为准确版本的材料编号>')
    out({ ok: true, entry: 'cli', ...decideMaterial({ case: c, group: g, accept: a, note: opt('note', '') }) })
  } else if (cmd === 'fact-add') {
    const c = opt('case'), t = opt('text'), src = opt('source'), loc = opt('locator')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!t || t === true) throw new Error('缺少 --text <事实内容>')
    if (!src || src === true) throw new Error('缺少 --source <材料编号或文件>')
    if (!loc || loc === true) throw new Error('缺少 --locator <定位>')
    out({ ok: true, entry: 'cli', ...addFact({ case: c, text: t, source: src, locator: loc, quote: opt('quote') === true ? undefined : opt('quote'), confirmed: !!opt('confirm'), note: opt('note', '') }) })
  } else if (cmd === 'fact-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(listFacts({ case: c, pendingOnly: !!opt('pending') }))
  } else if (cmd === 'fact-draft') {
    const c = opt('case'), src = opt('source')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!src || src === true) throw new Error('缺少 --source <材料编号或 .md/.txt/.csv>')
    out({ ...draftFacts({ case: c, source: src, max: Number(opt('max', '40')) || 40, dryRun: !opt('write') }) })
  } else if (cmd === 'material-parse') {
    const c = opt('case'), id = opt('id'), src = opt('source')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out({ ok: true, entry: 'cli', ...(await parseMaterial({ case: c, id: id === true ? undefined : id, source: optOr('source'), force: !!opt('force'), pdfEngine: optOr('pdf-engine') || 'auto', ...(optOr('tier') ? { tier: optOr('tier') } : {}) })) })
  } else if (cmd === 'material-parsed') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const items = listParsed(c)
    out({ ok: true, count: items.length, items, summary: `已解析 ${items.length} 份材料` })
  } else if (cmd === 'next') {
    const { nextStep } = await import('./core/next.js')
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(nextStep({ case: c }))
  } else if (cmd === 'brief') {
    const { caseBrief } = await import('./core/brief.js')
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const r = caseBrief({ case: c, pkgRoot: process.env.LAWCASE_AUDIT_ROOT || PKG_ROOT })
    // --text：只要那段能贴进对话/注入的简报，不要 JSON
    if (opt('text') === true) process.stdout.write(r.block + '\n')
    else out(r)
  } else if (cmd === 'pipeline') {
    const { runPipeline } = await import('./core/pipeline.js')
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(runPipeline({
      case: c,
      source: opt('source'),
      title: opt('title'),
      parties: opt('parties'),
      cause: opt('cause'),
      kind: opt('kind'),
      limit: Number(opt('limit') || 200) || 200,
      hashMaxMB: Number(opt('hash-max') || 0) || 0,
    }))
  } else if (cmd === 'material-parse-all') {
    const { parseAll } = await import('./core/parse.js')
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(await parseAll({ case: c, kind: opt('kind'), limit: Number(opt('limit') || 50) || 50, force: !!opt('force'), pdfEngine: optOr('pdf-engine') || 'auto' }))
  } else if (cmd === 'clause-index') {
    const c = opt('case'), f = opt('file')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!f || f === true) throw new Error('缺少 --file <合同 docx>')
    out(indexClauses({ case: c, file: f }))
  } else if (cmd === 'note-add') {
    const c = opt('case'), cl = opt('clause'), is = opt('issue'), fx = opt('fix')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!cl || cl === true) throw new Error('缺少 --clause <第X条>')
    if (!is || is === true) throw new Error('缺少 --issue <问题>')
    if (!fx || fx === true) throw new Error('缺少 --fix <修改方案>')
    out(addNote({ case: c, clause: cl, level: optOr('level') || '重大风险', issue: is, fix: fx, basis: optOr('basis'), file: optOr('file') }))
  } else if (cmd === 'note-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(listNotes({ case: c }))
  } else if (cmd === 'note-delete') {
    const c = opt('case'), id = opt('id')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!id || id === true) throw new Error('缺少 --id <N1>')
    out(deleteNote({ case: c, id }))
  } else if (cmd === 'skill-draft') {
    const c = opt('case'), f = opt('from')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!f || f === true) throw new Error('缺少 --from <skill 规格 json>')
    const spec = JSON.parse(fs.readFileSync(f, 'utf8'))
    out(draftSkill({ case: c, ...spec }))
  } else if (cmd === 'contract-revise') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(reviseContract({ case: c, file: optOr('file'), noteIds: optOr('notes') ? String(opt('notes')).split(',') : undefined }))
  } else if (cmd === 'contract-report') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(buildReport({ case: c }))
  } else if (cmd === 'review-auto') {
    const { autoReview } = await import('./core/review_auto.js')
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const sub = optOr('subject') || '自动复盘'
    out(autoReview({ case: c, subject: sub }))
  } else if (cmd === 'review-open') {
    const c = opt('case'), s2 = opt('subject')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!s2 || s2 === true) throw new Error('缺少 --subject <复盘对象>')
    out(openReview({ case: c, subject: s2 }))
  } else if (cmd === 'review-attack') {
    const c = opt('case'), r = opt('round'), t = opt('text'), g = optOr('target')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!r || r === true) throw new Error('缺少 --round <R1>')
    if (!t || t === true) throw new Error('缺少 --text <攻击理由>')
    out(addAttack({ case: c, round: r, target: g, text: t }))
  } else if (cmd === 'review-reply') {
    const c = opt('case'), r = opt('round'), a = opt('aid'), t = opt('text')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!r || r === true) throw new Error('缺少 --round <R1>')
    if (!a || a === true) throw new Error('缺少 --aid <A1>')
    if (!t || t === true) throw new Error('缺少 --text <回应>')
    out(addReply({ case: c, round: r, aid: a, text: t }))
  } else if (cmd === 'review-verdict') {
    const c = opt('case'), r = opt('round'), a = opt('aid'), sv = opt('severity'), n = optOr('note')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!r || r === true) throw new Error('缺少 --round <R1>')
    if (!a || a === true) throw new Error('缺少 --aid <A1>')
    if (!sv || sv === true) throw new Error('缺少 --severity <致命|重大|一般>')
    out(addVerdict({ case: c, round: r, aid: a, severity: sv, note: n }))
  } else if (cmd === 'review-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(listReview({ case: c, round: optOr('round') }))
  } else if (cmd === 'law-add') {
    const c = opt('case'), t = opt('title'), a = opt('article')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!t || t === true) throw new Error('缺少 --title <法规名>')
    if (!a || a === true) throw new Error('缺少 --article <条号>')
    const g = (k) => (opt(k) === true ? undefined : opt(k))
    out({ ok: true, entry: 'cli', ...addLaw({ case: c, title: t, article: a, quote: g('quote'), source: g('source') || 'manual', url: g('url'), effectiveFrom: g('effectiveFrom'), repealedAt: g('repealedAt'), note: g('note') }) })
  } else if (cmd === 'law-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    const items = loadLaws(c).map((l) => ({ ...l, verdict: localVerdict(l) }))
    out({ ok: true, count: items.length, items, summary: `法条 ${items.length} 条` })
  } else if (cmd === 'law-verify') {
    const c = opt('case'), id = opt('id'), mode = (opt('mode') === true ? 'auto' : opt('mode')) || 'auto'
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!id || id === true) throw new Error('缺少 --id <法条编号>')
    const law = loadLaws(c).find((l) => l.id === String(id).toUpperCase())
    if (!law) throw new Error('没有 ' + id + ' 这条法条记录')
    if (mode === 'local') out({ ok: true, mode: 'local', local: localVerdict(law), summary: law.id + ' 本地核验：' + localVerdict(law).level })
    else await verifyLawWithMcp({ case: c, id, command: optOr('command'), tool: optOr('tool') }).then((r) => out({ ok: true, entry: 'cli', ...r })).catch((e) => out({ ok: false, error: e.message }))
  } else if (cmd === 'law-tools') {
    const server = optOr('server') || 'fatiao'
    try {
      const names = await listPkulawTools({ server, command: optOr('command') })
      out({ ok: true, server, count: names.length, tools: names })
    } catch (e) {
      out({ ok: false, server, error: e.message })
    }
  } else if (cmd === 'law-probe') {
    const r = await probePkulaw({ command: optOr('command') })
    out(r)
  } else if (cmd === 'fact-amend') {
    const c = opt('case'), id = opt('id'), why = opt('reason')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!id || id === true) throw new Error('缺少 --id <事实编号>')
    if (!why || why === true) throw new Error('缺少 --reason <修正理由>')
    const g = (k) => (opt(k) === true ? undefined : opt(k))
    out({ ok: true, entry: 'cli', ...amendFact({ case: c, id, locator: g('locator'), quote: g('quote'), text: g('text'), reason: why }) })
  } else if (cmd === 'fact-revoke') {
    const c = opt('case'), id = opt('id'), why = opt('reason')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!id || id === true) throw new Error('缺少 --id <事实编号>')
    if (!why || why === true) throw new Error('缺少 --reason <作废理由>')
    out({ ok: true, entry: 'cli', ...revokeFact({ case: c, id, reason: why }) })
  } else if (cmd === 'finding-add') {
    const c = opt('case'), t = opt('text'), refs = opt('facts'), law = opt('law'), loc = opt('law-locator'), url = opt('law-url')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    if (!t || t === true) throw new Error('缺少 --text <结论正文>')
    if (!refs || refs === true) throw new Error('缺少 --facts F1,F2 <支撑事实编号>')
    out({
      ok: true, entry: 'cli',
      ...addFinding({
        case: c, text: t,
        factRefs: String(refs).split(',').map((x) => x.trim()).filter(Boolean),
        law: law && law !== true ? law : undefined,
        lawSource: (loc && loc !== true) || (url && url !== true) ? { locator: loc && loc !== true ? loc : undefined, url: url && url !== true ? url : undefined } : undefined,
      }),
    })
  } else if (cmd === 'finding-list') {
    const c = opt('case')
    if (!c || c === true) throw new Error('缺少 --case <案件目录>')
    out(listFindings({ case: c }))
  } else {
    out({ ok: false, error: 'unknown command: ' + cmd, commands: ['ping', 'case-new', 'case-open', 'case-status', 'case-verify', 'proc-plan', 'proc-update', 'proc-list', 'material-scan', 'material-list', 'material-decide', 'fact-add', 'fact-list', 'fact-draft', 'material-parse', 'material-parsed', 'contract-revise', 'skill-draft', 'clause-index', 'note-add', 'note-list', 'note-delete', 'contract-report', 'review-open', 'review-attack', 'review-reply', 'review-verdict', 'review-list', 'law-add', 'law-list', 'law-verify', 'law-tools', 'law-probe', 'fact-amend', 'fact-revoke', 'finding-add', 'finding-list'] })
    process.exitCode = 2
  }
} catch (e) {
  out({ ok: false, error: String((e && e.message) || e) })
  process.exitCode = 1
}
