// 会话绑定管理：让人能看见、能改「这个对话绑的是哪个案件」。
//
// 为什么需要人手动改：绑定是自动建的（第一次调用带 case 就绑上），
// 但用户可能一个会话里要处理两个案子，或者绑定建错了。这时要能明确切换，
// 而不是靠「改错案卷」来发现。

import { getBinding, setBinding, clearBinding, listBindings, sessionIdOf } from '../core/sessionbind.js'

export const sessionTools = [
  {
    name: 'lc_session_bind',
    description:
      '查看或设置当前对话绑定的案件。不带 case=查看当前绑定与全部绑定；带 case=把当前对话改绑到该案件；' +
      '带 unbind=true=解除绑定。绑定存在后，工具收到的 case 与绑定不一致会被直接拒绝（防改错案卷）。',
    parameters: {
      case: { type: 'string', description: '要绑定到的案件目录绝对路径' },
      unbind: { type: 'boolean', description: '解除当前对话的绑定' },
      title: { type: 'string', description: '案件名（只为显示方便）' },
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const pkgRoot = (exec && exec.__lawcasePkgRoot) || ''
      if (!sessionId) {
        return {
          ok: true,
          sessionId: null,
          bindings: listBindings({ pkgRoot }),
          summary: `没有会话信息（命令行/非会话调用，不参与绑定）｜现有绑定 ${listBindings({ pkgRoot }).length} 条`,
        }
      }
      if (args.unbind) {
        clearBinding(sessionId, { pkgRoot })
        return { ok: true, sessionId, binding: null, summary: '已解除本对话的案件绑定' }
      }
      if (args.case) {
        const b = setBinding(sessionId, String(args.case), { pkgRoot, title: args.title })
        return { ok: true, sessionId, binding: b, summary: `本对话已绑定到 ${b.case}` }
      }
      const b = getBinding(sessionId, { pkgRoot })
      return {
        ok: true,
        sessionId,
        binding: b,
        bindings: listBindings({ pkgRoot }),
        summary: b ? `本对话绑定：${b.title || b.case}（${b.case}）` : '本对话还没绑定案件：下一次带 case 的调用会自动绑定',
      }
    },
  },
]
