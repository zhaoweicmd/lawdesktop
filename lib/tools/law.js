import { lawTrace } from '../core/lawtrace.js'
import { addLaw, loadLaws, localVerdict, verifyLawWithMcp, probePkulaw, articleNumber, SOURCE_LABEL } from '../core/law.js'

/** 法条台账 + 回源核验（M6/P4） */
export const lawTools = [
  {
    name: 'lc_law_add',
    description:
      '登记一条法条引用（法规名 + 条号 + 条文原文 + 来源）。只写条号不写原文会被标为未回源。' +
      '来源分级：pkulaw(北大法宝) > official(官网原文) > gazette(公报) > manual(手工)。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      title: { type: 'string', required: true, description: '法规名称，如「中华人民共和国民法典」' },
      article: { type: 'string', required: true, description: '条号，如「第五百零九条」' },
      quote: { type: 'string', description: '条文原文（贴完整条文，不能只写条号）' },
      source: { type: 'string', description: 'pkulaw / official / gazette / manual，默认 manual' },
      url: { type: 'string', description: '来源链接（法规库/官网）' },
      effectiveFrom: { type: 'string', description: '施行日期，如 2021-01-01' },
      repealedAt: { type: 'string', description: '废止日期（若已废止）' },
      note: { type: 'string', description: '备注' },
    },
    execute: async (args) => addLaw(args),
  },
  {
    name: 'lc_law_list',
    description: '读法条台账：每条的状态（unverified/local-ok/mcp-verified/mcp-mismatch）与来源。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => {
      const laws = loadLaws(args.case)
      const items = laws.map((l) => ({
        id: l.id, title: l.title, article: l.article, status: l.status,
        source: l.sourceLabel || l.source, hasQuote: !!l.quote,
        checkedAt: l.checkedAt, verdict: localVerdict(l),
      }))
      const bad = items.filter((i) => i.status === 'mcp-mismatch').length
      const un = items.filter((i) => i.status === 'unverified' || !i.hasQuote).length
      return {
        ok: true, count: items.length, items,
        summary: `法条 ${items.length} 条：已验证 ${items.filter((i) => i.status === 'mcp-verified').length}，未回源 ${un}，与权威库不一致 ${bad}`,
      }
    },
  },
  {
    name: 'lc_law_trace',
    description:
      '法条溯源核对（只读，不调 LLM）：把每条结论 → 它引用的法条 → 条文原文 → 权威来源摊开，' +
      '判四件事：条号在法律台账里到底存不存在、有没有条文原文、来源级别（法宝/官方/公报/手工）、' +
      '是否已废止或超期未复核；并检查结论正文点名的条号与所引法条是否对得上。' +
      '同时列出「台账里有但没被任何结论引用」的法条。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => lawTrace({ case: args.case }),
  },
  {
    name: 'lc_law_verify',
    description:
      '核验一条法条。mode=local 只跑本地规则（不联网）；mode=mcp 调北大法宝取权威原文并比对；mode=auto 先探 MCP，不可用则退回本地。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      id: { type: 'string', required: true, description: '法条编号，如 L1' },
      mode: { type: 'string', description: 'local / mcp / auto（默认 auto）' },
      command: { type: 'string', description: 'pkulaw-mcp 命令或绝对路径，默认 pkulaw-mcp' },
    },
    execute: async (args) => {
      const mode = args.mode || 'auto'
      const laws = loadLaws(args.case)
      const law = laws.find((l) => l.id === String(args.id || '').toUpperCase())
      if (!law) throw new Error(`没有 ${args.id} 这条法条记录`)
      const local = localVerdict(law)
      if (mode === 'local') {
        return { ok: local.level !== 'fail', mode: 'local', law, local, summary: `${law.id} 本地核验：${local.level}` }
      }
      try {
        const r = await verifyLawWithMcp({ case: args.case, id: law.id, command: args.command || 'pkulaw-mcp' })
        return { ...r, mode: 'mcp', local }
      } catch (e) {
        if (mode === 'mcp') throw e
        return {
          ok: local.level !== 'fail', mode: 'local-fallback', law, local,
          warning: `北大法宝不可用，已退回本地核验：${e.message}`,
          summary: `${law.id} 本地核验：${local.level}（北大法宝未启用：${String(e.message).slice(0, 60)}）`,
        }
      }
    },
  },
  {
    name: 'lc_law_probe',
    description: '探测北大法宝 MCP 是否可用（是否安装、token 是否配置）。只读，不写案件。',
    parameters: {
      command: { type: 'string', description: 'pkulaw-mcp 命令或绝对路径' },
    },
    execute: async (args) => {
      const r = await probePkulaw({ command: args.command || 'pkulaw-mcp' })
      return { ...r, summary: r.ok ? '北大法宝 MCP 可用' : `北大法宝 MCP 不可用：${r.reason}` }
    },
  },
]
