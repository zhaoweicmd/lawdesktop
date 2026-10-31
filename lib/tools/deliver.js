import { buildDelivery } from '../core/deliver.js'

/** 交付包（M11） */
export const deliverTools = [
  {
    name: 'lc_deliver',
    description:
      '打交付包：把意见报告、修订版合同、事实台账、五道验收结果等产物复制进一个带时间戳的目录，' +
      '附「交付清单.md」（文件说明 + SHA256 + 验收结论 + 未包含项）和机器可读的 delivery.json。' +
      '五道验收有 fail 时**拒绝生成**（交付即外发），确需留档传 force=true（包名带「未通过验收」）。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      label: { type: 'string', description: '交付对象，如「致合伙人」「致客户」；会写进清单' },
      force: { type: 'boolean', description: '验收未通过时仍生成（包名带「未通过验收」标记）' },
      outDir: { type: 'string', description: '输出到哪个目录，默认案件目录下' },
    },
    execute: async (args) => buildDelivery(args),
  },
]
