/**
 * 企业信息查询（企查查 CLI：qcc-agent-cli）
 *
 * 为什么走 CLI 而不是 MCP：插件与 MCP 是两套隔离的工具表，`lc_*` 调不到 MCP 服务里的工具；
 * CLI 是普通可执行文件，插件能直接 execFile，结果是原始 JSON、不经过 LLM。
 *
 * 一个必须防的坑：**qcc 未初始化时退出码是 0**，错误只写在输出里（和 macOS textutil 一样）。
 * 所以判定成败不能看 exit code，必须看输出内容。
 */
import { execFile } from 'node:child_process'
import { extractJson } from './clijson.js'
import { which } from './bins.js'
export { extractJson }
import path from 'node:path'

/** 10 个 server 的说明（顺序与官方一致） */
export const SERVERS = {
  company: '企业信息',
  risk: '风险信息',
  ipr: '知识产权',
  operation: '经营信息',
  history: '历史信息（需企业实名认证）',
  executive: '董监高',
  regulation: '法律法规',
  case: '司法案例',
  tender: '标讯',
  document: '文档解析',
}

/** 找企查查 CLI：环境变量 LAWCASE_QCC_BIN 优先，其次 PATH 与常见目录 */
export function findQcc() {
  return which('qcc', { envName: 'LAWCASE_QCC_BIN' })
}

const ERR_RE = /^\s*(?:错误|Error)[:：]/

/** 跑一条 qcc 命令；不信任退出码，只信任输出内容 */
export function runQcc(args, { bin, timeoutMs = 60000 } = {}) {
  const command = bin || findQcc()
  if (!command) {
    return Promise.reject(new Error(
      '找不到 qcc 命令。安装：npm install -g qcc-agent-cli；然后 qcc init --authorization "Bearer <API Key>"',
    ))
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      // 判定成败只看输出内容：qcc 未初始化时退出码是 0，错误可能落在 stdout 也可能落在 stderr
      const combined = [out, errOut].filter(Boolean).join('\n').trim()
      const bump = (m) => {
        const msg = m.replace(ERR_RE, '').trim()
        if (/配置文件不存在|qcc init|初始化/.test(msg)) {
          return `企查查 CLI 未初始化：${msg}。运行 qcc init --authorization "Bearer <API Key>"（Key 在 agent.qcc.com 个人中心获取）`
        }
        return `企查查返回错误：${msg}`
      }
      if (out && ERR_RE.test(out)) return reject(new Error(bump(out)))
      if (!out && combined && (ERR_RE.test(combined) || /配置文件不存在|qcc init/.test(combined))) {
        return reject(new Error(bump(combined)))
      }
      if (err && !out) return reject(new Error(`企查查调用失败：${(errOut || err.message).slice(0, 300)}`))
      if (!out) return reject(new Error(`企查查无输出${errOut ? '：' + errOut.slice(0, 200) : ''}`))
      resolve(out)
    })
  })
}

/** 是否已配置（能不能真的查） */
export async function qccProbe({ bin } = {}) {
  const command = bin || findQcc()
  if (!command) return { ok: false, installed: false, reason: '未安装 qcc-agent-cli', hint: 'npm install -g qcc-agent-cli' }
  try {
    const out = await runQcc(['list-tools', 'company'], { bin: command, timeoutMs: 30000 })
    return { ok: true, installed: true, bin: command, sample: out.slice(0, 300) }
  } catch (e) {
    return {
      ok: false,
      installed: true,
      bin: command,
      reason: e.message,
      hint: /未初始化/.test(e.message) ? 'qcc init --authorization "Bearer <API Key>"' : undefined,
    }
  }
}

/** 列某个 server 的工具 */
export async function listQccTools(server, { bin } = {}) {
  const out = await runQcc(['list-tools', ...(server ? [server] : [])], { bin })
  return out
}

/** 查一条；返回 { ok, server, tool, query, data, raw } */
export async function qccQuery({ server, tool, query, bin, timeoutMs } = {}) {
  if (!server) throw new Error('缺少 server（如 company / risk / case / regulation）')
  if (!tool) throw new Error('缺少 tool（先用 qcc list-tools <server> 看有哪些）')
  if (!query) throw new Error('缺少查询词')
  const args = [server, tool]
  // 形如 --file_path ./x.pdf 的具名参数
  if (Array.isArray(query)) args.push(...query)
  else args.push(String(query))
  // 不加 --json 时 qcc 返回的是给人看的 Markdown 文本，不是 JSON
  if (!args.includes('--json')) args.push('--json')
  const raw = await runQcc(args, { bin, timeoutMs })
  const jsonText = extractJson(raw)
  let data
  try { data = JSON.parse(jsonText) } catch {
    throw new Error(`企查查返回的不是 JSON（前 300 字）：${raw.slice(0, 300)}`)
  }
  return { ok: true, server, tool, query: Array.isArray(query) ? query.join(' ') : String(query), data, raw }
}

export { path }
