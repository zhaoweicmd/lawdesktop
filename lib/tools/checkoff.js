// 核对签字工具：agent 侧入口，与面板按钮共用同一套 core。
//
// 一个工具三件事（按参数分派），避免工具表里堆三个名字：
//   不带 result/signer → 读进度
//   带 result          → 给某条台账打核对结论
//   带 signer          → 生成签字单

import { checkStatus, checkItem, buildSignoff, CHECK_KINDS, RESULTS } from '../core/checkoff.js'
import { machinePrecheck } from '../core/machinecheck.js'

const KIND_IDS = Object.keys(CHECK_KINDS)
const RESULT_IDS = Object.keys(RESULTS)

export const checkoffTools = [
  {
    name: 'lc_check_machine',
    description:
      '机器预核（只读，不调 LLM）：把能由机器判定的部分判掉——引文是否逐字出现在材料的解析文本里、' +
      '出处材料是否存在、定位页码是否越界、结论引用的 F/法条编号是否存在。' +
      '三色分流：green=可直接确认（引文与出处都对得上）、yellow=机器判不了（缺引文/缺材料编号，必须人工看）、' +
      'red=查出矛盾（引文找不到、编号不存在，必须处理）。注意 green 只证明「这句话写在材料里」，' +
      '不证明内容成立或结论站得住。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
    },
    execute: async (args) => machinePrecheck({ case: args.case }),
  },
  {
    name: 'lc_checkoff',
    description:
      '核对签字：把「人工逐条校对」记进台账。不带参数=读核对进度；带 kind+id+result=给某条台账打结论' +
      `（result 只能是 ${RESULT_IDS.map((k) => `${k}=${RESULTS[k].label}`).join(' / ')}，非 ok 必须写 note）；` +
      '带 signer=生成签字单（Markdown，写明签字人、时间、逐条结论、文件 SHA256，以及仍未核对/需修改/有疑问的条数）。' +
      `可核对的台账：${KIND_IDS.map((k) => `${k}=${CHECK_KINDS[k].label}`).join(' / ')}。` +
      '核对时会记下内容指纹，之后内容被改，签字单上会标「核对后已改」。',
    parameters: {
      case: { type: 'string', required: true, description: '案件工作目录绝对路径' },
      kind: { type: 'string', description: `哪本台账：${KIND_IDS.join(' / ')}` },
      id: { type: 'string', description: '条目编号，如 F1 / K2 / M13' },
      result: { type: 'string', description: `核对结论：${RESULT_IDS.join(' / ')}` },
      by: { type: 'string', description: '核对人姓名（不给则用案件 owner）' },
      note: { type: 'string', description: '备注；结论不是 ok 时必填（签字页上要写清问题在哪）' },
      signer: { type: 'string', description: '签字人姓名（给了就生成签字单）' },
    },
    execute: async (args) => {
      const signer = String(args.signer || '').trim()
      const result = String(args.result || '').trim()
      if (signer) return buildSignoff({ case: args.case, signer })
      if (result) {
        return checkItem({
          case: args.case,
          kind: args.kind,
          id: args.id,
          result,
          by: args.by,
          note: args.note,
        })
      }
      return checkStatus({ case: args.case })
    },
  },
]
