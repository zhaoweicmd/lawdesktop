import { probeWritable, stateDir, resolveRoot } from '../core/paths.js'

/**
 * lc_ping —— M0 冒烟 / 随时自检
 * 只回答一个问题：插件活着吗、能写吗、能调到几个工具。
 */
export function pingTool({ version, pkgRoot, toolsRef }) {
  return {
    name: 'lc_ping',
    description:
      'LawCase 自检：确认插件已加载、工具已注册、状态目录可写。返回版本、Node 版本、根目录解析结果与写权限探测。',
    parameters: {
      echo: { type: 'string', description: '可选回显字符串，用于确认参数透传正常' },
    },
    execute: async ({ echo } = {}, ctx = {}) => {
      const root = ctx.root !== undefined ? ctx.root : resolveRoot(ctx.config || {}, pkgRoot)
      const dir = stateDir(root, pkgRoot)
      const probe = probeWritable(dir)
      return {
        ok: true,
        plugin: 'lawcase',
        version,
        stage: 'M2-verify',
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        pkgRoot,
        root: root || null,
        rootSource: process.env.LAWCASE_ROOT ? 'env' : (root ? 'config' : 'none'),
        stateDir: dir,
        writable: { ok: probe.ok, dir: probe.dir, error: probe.error },
        tools: toolsRef ? toolsRef() : [],
        echo: echo != null ? String(echo) : null,
        hostTime: new Date().toISOString(),
      }
    },
  }
}
