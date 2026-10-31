import fs from 'node:fs'
import path from 'node:path'
import { qccProbe, qccQuery, listQccTools, SERVERS } from '../core/enterprise.js'
import { casePaths, loadCase, log } from '../core/store.js'

const SERVER_LIST = Object.entries(SERVERS).map(([k, v]) => `${k}(${v})`).join('、')

/** 企业信息查询工具组 */
export const enterpriseTools = [
  {
    name: 'lc_enterprise_probe',
    description:
      '探测企查查 CLI（qcc-agent-cli）是否可用：已安装？已绑定 API Key？返回可执行的下一步。只读。',
    parameters: {
      bin: { type: 'string', description: 'qcc 可执行文件路径，留空自动查找' },
    },
    execute: async ({ bin }) => {
      const p = await qccProbe({ bin })
      const lines = [
        p.ok ? '企查查 CLI 可用' : '企查查 CLI 不可用',
        `- 已安装：${p.installed ? '是' : '否'}`,
        `- 路径：${p.bin || '（未找到）'}`,
        p.ok ? '' : `- 原因：${p.reason}`,
        p.hint ? `- 下一步：${p.hint}` : '',
        '',
      ].filter(Boolean)
      return { text: lines.join('\n') }
    },
  },
  {
    name: 'lc_enterprise_query',
    description:
      '按企查查 CLI 查询企业数据（调用即消耗积分，一个被查询主体每月有封顶）。' +
      'server 取 company/risk/ipr/operation/history/executive/regulation/case/tender/document；' +
      'tool 先用 lc_enterprise_tools 列出。传 case 时结果会落盘到案件的 .lawcase/enterprise/，可作事实出处。' +
      `可选 server：${SERVER_LIST}`,
    parameters: {
      server: { type: 'string', required: true, description: '如 company / risk / case / regulation' },
      tool: { type: 'string', required: true, description: '工具名，如 get_company_registration_info' },
      query: { type: 'string', required: true, description: '查询词，如「企查查科技股份有限公司」' },
      case: { type: 'string', description: '案件目录（可选）：结果落盘到该案件，便于引用出处' },
      maxChars: { type: 'number', description: '返回给模型的最大字符数，默认 6000' },
    },
    execute: async ({ server, tool, query, case: caseDir, maxChars }) => {
      const r = await qccQuery({ server, tool, query })
      const json = JSON.stringify(r.data, null, 2)
      let saved = ''
      if (caseDir) {
        const cp = casePaths(caseDir)
        const c = loadCase(caseDir)
        const dir = path.join(cp.state, 'enterprise')
        fs.mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = path.join(dir, `${stamp}-${server}-${String(tool).replace(/\W+/g, '_')}.json`)
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), server, tool, query, data: r.data }, null, 2))
        log(cp, { op: 'enterprise-query', caseId: c.caseId, server, tool, query, file })
        saved = `\n\n已落盘：${path.relative(caseDir, file)}`
      }
      const limit = Number(maxChars) > 0 ? Number(maxChars) : 6000
      const body = json.length > limit
        ? `${json.slice(0, limit)}\n…（共 ${json.length} 字，已截断；完整内容见落盘文件）`
        : json
      return { text: `${server}.${tool}「${query}」\n\n${body}${saved}` }
    },
  },
  {
    name: 'lc_enterprise_tools',
    description: '列出企查查某个 server 下有哪些查询工具（不消耗积分）。',
    parameters: {
      server: { type: 'string', description: `留空列全部；可选：${SERVER_LIST}` },
    },
    execute: async ({ server }) => {
      const out = await listQccTools(server)
      return { text: out.slice(0, 8000) }
    },
  },
]
