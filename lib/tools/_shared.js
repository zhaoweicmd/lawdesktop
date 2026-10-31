// 工具共用壳：所有工具返回结构化对象，由宿主渲染成文本
//
// defineTool 必须声明 output（宿主硬性要求，缺失即注册失败）。
// 这里统一走 { schema: {text}, render }，工具本身只管返回数据。
//
// 这里还统一做一件要命的事：**会话 ↔ 案件 的绑定校验**（见 core/sessionbind.js）。
// 放在这一层是因为所有工具都从这里过，漏一个就等于没做。

import { sessionIdOf, resolveCaseForTool } from '../core/sessionbind.js'


// 哪些工具的参数表里声明了 case：这些工具即使调用时没传，也要按绑定补上
const CASE_TOOLS = new Set([
  'lc_case_open','lc_case_status','lc_case_verify','lc_case_pipeline','lc_case_next','lc_deliver',
  'lc_proc_plan','lc_proc_update','lc_proc_list','lc_material_scan','lc_material_list','lc_material_decide',
  'lc_material_parse','lc_material_parse_all','lc_material_parsed','lc_fact_add','lc_fact_list','lc_fact_draft',
  'lc_fact_revoke','lc_fact_amend','lc_finding_add','lc_finding_list','lc_law_add','lc_law_list','lc_law_verify',
  'lc_law_probe','lc_law_trace','lc_review_open','lc_review_attack','lc_review_reply','lc_review_verdict',
  'lc_review_list','lc_review_auto','lc_clause_index','lc_clause_unindex','lc_clause_skip','lc_clause_candidates','lc_note_worksheet','lc_note_validate','lc_note_add','lc_note_list','lc_note_delete',
  'lc_contract_report','lc_contract_revise','lc_precheck','lc_contract_config','lc_contract_preview',
  'lc_checkoff','lc_check_machine','lc_skill_draft','lc_enterprise_probe','lc_enterprise_query','lc_enterprise_tools',
  'lc_ledger_scan','lc_ledger_fix',
])
function hasCaseParam(name) {
  return CASE_TOOLS.has(name)
}

export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [
    { type: 'text', text: value && value.text != null ? String(value.text) : '' },
  ],
}

/** 不做绑定校验的工具（这几个本来就不针对某个案件，或者本身就是在管理绑定） */
const BYPASS = new Set(['lc_ping', 'lc_skill_list', 'lc_skill_publish', 'lc_session_bind'])

/**
 * 把返回对象的 execute 包成宿主可渲染的 { text }。
 * @param {Function} fn 原始 execute
 * @param {{ name?: string, ctx?: object }} meta 工具名与插件上下文（要 pkgRoot 存绑定）
 */
export const wrap = (fn, meta = {}) => async (args, exec) => {
  const a = args || {}
  const name = meta.name || ''
  try {
    // 注意：不能要求「参数里有 case」才校验——没带 case 时也要能用绑定值补上，
    // 否则模型不带 case 就会直接穿透到 core 然后报「case 不能为空」。
    if (!BYPASS.has(name) && (('case' in a) || hasCaseParam(name))) {
      const sessionId = sessionIdOf(exec)
      const r = resolveCaseForTool({
        sessionId,
        argsCase: a.case,
        pkgRoot: (meta.ctx && meta.ctx.pkgRoot) || '',
      })
      if (r.action === 'conflict') {
        return { text: r.error }
      }
      // 已经绑定但没带 case（极少数工具允许）：自动补上，避免模型猜
      if (r.action === 'same' && !a.case && r.caseDir) a.case = r.caseDir
    }
    // 把 pkgRoot 挂到 exec 上：工具内部（如 lc_session_bind）也要读写绑定表
    if (exec && meta.ctx && meta.ctx.pkgRoot && !exec.__lawcasePkgRoot) {
      try {
        exec.__lawcasePkgRoot = meta.ctx.pkgRoot
      } catch (e) {}
    }
  } catch (e) {
    // 绑定校验本身出错不能把工具打死；但要留下痕迹
    try {
      console.error('lawcase: sessionbind failed', e)
    } catch (x) {}
  }
  const out = await fn(a, exec)
  return { text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }
}
