import { scanLedgers, renderLedgerReport } from '../core/ledger.js'
import { fixLedgers } from '../core/ledgerfix.js'

/** 台账体检类工具 */
export const ledgerTools = [
  {
    name: 'lc_ledger_scan',
    description:
      '台账体检（只读）：逐张检查案件里的 xlsx 表格，报出口径问题——日期被存成序列号（46085）、' +
      '文字算式（(189,464,959-174,515,814)×20%）当数值用、浮点尾巴（5.0000000000000001E-4）、整表无表头。' +
      '**不改任何文件**。format=md 返回人看的报告，json 返回结构化结果。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      mid: { type: 'string', description: '只查这一份材料（如 M13），留空查全部 xlsx' },
      format: { type: 'string', description: 'md（默认，人读）/ json（机器读）' },
    },
    execute: async ({ case: caseDir, mid, format }) => {
      const r = scanLedgers({ case: caseDir, mid })
      if (String(format || 'md').toLowerCase() === 'json') {
        return { text: JSON.stringify(r, null, 2) }
      }
      const md = renderLedgerReport(r)
      return { text: `${r.summary}\n\n${md}` }
    },
  },
  {
    name: 'lc_ledger_fix',
    description:
      '台账批改（写）：只改两类「改了不改变含义」的问题——浮点尾巴四舍五入到分、日期序列号加日期格式（值不变）。' +
      '**默认 dryRun=true 只报方案不写盘**；apply=true 才生成修正版。' +
      '输出到 <案件>/out/台账修正_<时间>/，**原文件不动**。' +
      '证据目录下的表格一律跳过（改对方提交的证据性质就变了），要改须用 mid 明确指定。' +
      '文字算式、缺表头、列错位不改——那要判断「本该是什么」，机器猜不出来。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      mid: { type: 'string', description: '只处理这一份（如 M13）；指定时不受证据目录保护限制' },
      apply: { type: 'boolean', description: '默认 false=只报方案；true=写盘生成修正版' },
      decimals: { type: 'number', description: '浮点保留小数位，默认 2（金额到分）' },
    },
    execute: async ({ case: caseDir, mid, apply, decimals }) => {
      const r = fixLedgers({ case: caseDir, mid, apply: !!apply, decimals: Number(decimals) > 0 ? Number(decimals) : 2 })
      const lines = [r.summary, '']
      if (r.skipped?.length) {
        lines.push('## 跳过（证据材料，不改）', '')
        for (const s of r.skipped.slice(0, 12)) lines.push(`- ${s.mid} ${s.file}`)
        if (r.skipped.length > 12) lines.push(`- …共 ${r.skipped.length} 份`)
        lines.push('')
      }
      const withPlan = (r.files || []).filter((f) => f.plan?.length)
      if (withPlan.length && !r.applied) {
        lines.push('## 将改动', '')
        for (const f of withPlan) {
          lines.push(`### ${f.mid} ${f.file}（${f.plan.length} 处）`, '')
          lines.push('| 位置 | 类型 | 改前 | 改后 |', '|---|---|---|---|')
          for (const p of f.plan.slice(0, 20)) lines.push(`| ${p.sheet}!${p.ref} | ${p.kind} | ${p.before} | ${p.after} |`)
          if (f.plan.length > 20) lines.push(`| … | | | 共 ${f.plan.length} 处 |`)
          lines.push('')
        }
        lines.push('> 确认无误后传 apply=true 生成修正版。')
      }
      if (r.applied) {
        lines.push('## 已生成', '')
        for (const w of r.written) lines.push(`- ${w.mid} ${w.file} → \`${w.out}\`（${w.count} 处，自检 ${w.selfCheck}）`)
        lines.push('', `修改清单：\`${r.outDir}/修改清单.md\``)
      }
      return { text: lines.join('\n') }
    },
  },
]
