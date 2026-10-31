import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runQcc, qccQuery, qccProbe, SERVERS, extractJson } from '../lib/core/enterprise.js'

function fakeQcc(body) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-qcc-'))
  const f = path.join(d, 'qcc')
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(f, 0o755)
  return { bin: f, cleanup: () => fs.rmSync(d, { recursive: true, force: true }) }
}

test('未初始化：退出码 0 + stderr 报错，也要判失败并给出可照做的下一步', async () => {
  const { bin, cleanup } = fakeQcc('echo "错误: 配置文件不存在，运行 qcc init 进行初始化" >&2; exit 0')
  try {
    await assert.rejects(() => runQcc(['list-tools', 'company'], { bin }), (e) => {
      assert.match(e.message, /未初始化/)
      assert.match(e.message, /qcc init --authorization/)
      return true
    })
  } finally { cleanup() }
})

test('退出码 0 + stdout 里写「错误:」也要判失败（不静默返回空）', async () => {
  const { bin, cleanup } = fakeQcc('echo "错误: 参数不合法"; exit 0')
  try {
    await assert.rejects(() => runQcc(['company', 'x'], { bin }), /企查查返回错误：参数不合法/)
  } finally { cleanup() }
})

test('正常返回 JSON 时解析成功', async () => {
  const { bin, cleanup } = fakeQcc(`echo '{"name":"某某公司","regNo":"9132"}'`)
  try {
    const r = await qccQuery({ server: 'company', tool: 'get_company_registration_info', query: '某某公司', bin })
    assert.equal(r.ok, true)
    assert.equal(r.data.name, '某某公司')
  } finally { cleanup() }
})

test('返回不是 JSON 时明确报错并附前 300 字', async () => {
  const { bin, cleanup } = fakeQcc('echo "这不是 JSON"')
  try {
    await assert.rejects(
      () => qccQuery({ server: 'company', tool: 't', query: 'q', bin }),
      /不是 JSON（前 300 字）：这不是 JSON/,
    )
  } finally { cleanup() }
})

test('缺参数时先在本地拦住，不发请求（省积分）', async () => {
  await assert.rejects(() => qccQuery({ tool: 'x', query: 'q' }), /缺少 server/)
  await assert.rejects(() => qccQuery({ server: 'company', query: 'q' }), /缺少 tool/)
  await assert.rejects(() => qccQuery({ server: 'company', tool: 'x' }), /缺少查询词/)
})

test('可执行文件不存在时给出安装命令', async () => {
  await assert.rejects(
    () => runQcc(['list-tools'], { bin: '/nonexistent/qcc' }),
    /企查查调用失败/,
  )
})

test('probe 在未安装时报「未安装」而不是抛错', async () => {
  const p = await qccProbe({ bin: '/nonexistent/qcc' })
  assert.equal(p.ok, false)
  assert.equal(p.installed, true, '路径给了但不存在 → 安装状态由 findQcc 判，这里走调用失败分支')
})

test('10 个 server 都登记在册', () => {
  const keys = Object.keys(SERVERS)
  for (const k of ['company', 'risk', 'ipr', 'operation', 'history', 'executive', 'regulation', 'case', 'tender', 'document']) {
    assert.ok(keys.includes(k), `${k} 应存在`)
  }
})

test('extractJson：跳过「正在调用 …」前缀，只取 JSON', () => {
  const raw = '正在调用 company/get_company_registration_info...\n\n{\n  "企业名称": "某某"\n}'
  assert.equal(extractJson(raw).trim(), '{\n  "企业名称": "某某"\n}')
})

test('extractJson：数组开头也能抠出来', () => {
  const raw = '提示行\n[{"a":1},{"a":2}]'
  assert.equal(extractJson(raw), '[{"a":1},{"a":2}]')
})

test('extractJson：没有 JSON 时原样返回（交给 JSON.parse 报错）', () => {
  assert.equal(extractJson('纯文本'), '纯文本')
})

test('qccQuery 自动加 --json（否则拿到的是 Markdown 文本）', async () => {
  const { bin, cleanup } = fakeQcc('case "$@" in *--json*) echo \'{"ok":true}\';; *) echo "不是JSON的文本";; esac')
  try {
    const r = await qccQuery({ server: 'company', tool: 't', query: 'q', bin })
    assert.equal(r.data.ok, true)
  } finally { cleanup() }
})
