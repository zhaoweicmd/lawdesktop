import { addFinding, listFindings } from '../core/finding.js'

/** 结论台账工具（M5） */
export const findingTools = [
  {
    name: 'lc_finding_add',
    description:
      '登记一条结论到结论台账（findings.jsonl）。三重闸门：必须引用已登记的事实编号；引用法条必须给回源定位（url 或「库名+条号」）；' +
      '含「建议进一步明确」这类空泛话术直接拒收——改成能直接落地的话。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      text: { type: 'string', required: true, description: '结论正文（≥15 字，写清「谁对谁、基于什么、得出什么」）' },
      factRefs: {
        type: 'array',
        required: true,
        description: '支撑该结论的事实编号数组，如 ["F1","F3"]；必须是已登记的',
        items: { type: 'string' },
      },
      law: { type: 'string', description: '法律依据，如「民法典第五百七十七条」；留空表示该结论不依赖法条' },
      lawSource: {
        type: 'object',
        description: '法条回源定位（law 非空时必填其一）',
        properties: {
          url: { type: 'string', description: '法规库链接' },
          locator: { type: 'string', description: '库名+条号，如「国家法律法规数据库｜民法典｜第577条」' },
          note: { type: 'string', description: '备注' },
        },
      },
      confidence: { type: 'string', description: '把握程度：高/中/低（可选）' },
    },
    execute: async (args) => addFinding(args),
  },
  {
    name: 'lc_finding_list',
    description: '读结论台账：每条结论的事实引用是否还有效、法条是否回源。纯读。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => listFindings(args),
  },
]
