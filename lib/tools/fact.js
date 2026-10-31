import { addFact, listFacts, draftFacts, revokeFact, amendFact } from '../core/fact.js'

export const factTools = [
  {
    name: 'lc_fact_add',
    description:
      '登记一条事实到台账（facts.jsonl），自动编号 F1、F2…。**出处文件名与定位都必填**，' +
      '出处文件不存在直接拒收。这就是「事实必有出处」的落地。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      text: { type: 'string', required: true, description: '事实内容（4~1000 字，一条只写一件事）' },
      source: { type: 'string', required: true, description: '出处：材料编号（如 M3）或文件路径' },
      locator: { type: 'string', required: true, description: '定位：页码 P12 / 第3段 / 表格「应付账款」行 / 录音 05:12' },
      confirmed: { type: 'boolean', description: '是否已人工复核（默认 false=待核）' },
      note: { type: 'string', description: '备注' },
    },
    execute: async (args) => addFact(args),
  },
  {
    name: 'lc_fact_list',
    description: '读事实台账：总数、已复核/待复核/来源失效各多少，以及每条事实的出处。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      pendingOnly: { type: 'boolean', description: '只看未复核的' },
    },
    execute: async (args) => listFacts(args),
  },
  {
    name: 'lc_fact_draft',
    description:
      '从 .md/.txt/.csv 抽候选事实（返回候选，默认**不写入**）。docx/pdf 会明确拒绝——' +
      '请先用解析工具转 md。用于「机器先出候选、人逐条确认」的流程。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      source: { type: 'string', required: true, description: '材料编号（如 M3）或 .md/.txt/.csv 路径' },
      max: { type: 'number', description: '最多抽多少条，默认 40' },
      dryRun: { type: 'boolean', description: '默认 true 只返回候选；false 则批量登记（待核状态）' },
      confirmed: { type: 'boolean', description: '批量登记时是否直接标为已复核，默认 false' },
    },
    execute: async (args) => draftFacts(args),
  },
  {
    name: 'lc_fact_revoke',
    description:
      '作废一条事实（必须写理由）。追加作废记录、不删原始行，可审计；作废后不再计入验收。' +
      '用于来源被推翻、误录、或测试残留的数据。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', required: true, description: '事实编号，如 F1' },
      reason: { type: 'string', required: true, description: '作废理由（必填，写清为什么不能再用）' },
    },
    execute: async (args) => revokeFact(args),
  },
  {
    name: 'lc_fact_amend',
    description:
      '修正一条事实的出处/原文引用/表述（必须写理由）。追加修正记录、保留原始行；改出处会重置复核状态。' +
      '用于定位标错（如把非空段数成绝对段号）、补齐原文引用。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', required: true, description: '事实编号，如 F2' },
      locator: { type: 'string', description: '新的定位，如 P3 / N2；不改则不传' },
      quote: { type: 'string', description: '该位置上的原文片段（逐字），供机器核对' },
      text: { type: 'string', description: '新的表述；不改则不传' },
      reason: { type: 'string', required: true, description: '修正理由（必填）' },
    },
    execute: async (args) => amendFact(args),
  },
]
