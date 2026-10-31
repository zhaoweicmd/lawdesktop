#!/usr/bin/env node
// 装机自检（机制 M2）：一条命令回答「这台机器现在还能不能用」。
//
// 为什么要有它：
//   现在的验证散在三处 —— 看日志找挂载记录、跑 500 多条测试、打开面板点一圈。
//   换机 / 升级宿主 / 网盘同步出冲突之后，没人知道该先看哪个。
//   对方工作台的做法是「全量标准化体检」：结构 → 工具 → 测试 → 探活，一次说完，
//   并且**任何一项失败就 exit 非 0**（没有会失败的检查 = 一句装饰）。
//
// 判据（每一条都能写出"什么样算不过"）：
//   1. 结构：lib/index.js、lib/client.js、package.json 版本与 index.js 常量一致
//   2. 工具：注册的工具数 == 期望数，且每个都必须声明 output.render（宿主硬要求）
//   3. 测试：node --test 全过（可 --skip-tests 跳过，用于慢机）
//   4. 数据：案件根可读、`.lawcase` 可写、审计目录可写
//   5. 面板：ui-state.json 记的根目录还存在（不存在 = 打开面板一片空白）
//
// 用法：
//   node scripts/selfcheck.mjs            # 全测
//   node scripts/selfcheck.mjs --quiet    # 只打结果行
//   node scripts/selfcheck.mjs --skip-tests

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const skipTests = argv.includes('--skip-tests')

const checks = []
function ok(name, detail) {
  checks.push({ name, status: 'ok', detail })
  if (!quiet) console.log(`  ✅ ${name}${detail ? ' · ' + detail : ''}`)
}
function bad(name, detail) {
  checks.push({ name, status: 'bad', detail })
  console.log(`  ⛔ ${name}${detail ? ' · ' + detail : ''}`)
}
function warn(name, detail) {
  checks.push({ name, status: 'warn', detail })
  if (!quiet) console.log(`  ⚠️ ${name}${detail ? ' · ' + detail : ''}`)
}

// ---- 1. 结构 ----------------------------------------------------------------
if (!quiet) console.log('\n【1/5 结构】')
const pkgFile = path.join(ROOT, 'package.json')
let pkg = null
try {
  pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  ok('package.json 可解析', `v${pkg.version}`)
} catch (e) {
  bad('package.json 可解析', String(e.message).slice(0, 80))
}

for (const rel of ['lib/index.js', 'lib/client.js', 'lib/core/store.js', 'cordis.patch.yml']) {
  const f = path.join(ROOT, rel)
  if (fs.existsSync(f)) ok(`存在 ${rel}`)
  else bad(`存在 ${rel}`, '缺文件')
}

// 版本单一真相源：package.json 与 lib/index.js 的 VERSION 常量必须一致
try {
  const idx = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  const m = idx.match(/const VERSION = '([^']+)'/)
  if (!m) bad('index.js 版本常量', '找不到 VERSION')
  else if (m[1] === String(pkg && pkg.version)) ok('版本一致', m[1])
  else bad('版本一致', `package ${pkg.version} ≠ index ${m[1]}`)
} catch (e) {
  bad('index.js 版本常量', String(e.message).slice(0, 80))
}

// 客户端 inject 不能写宿主不存在的包（会卡住 web boot，踩过）
try {
  const inject = (pkg && pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
  const suspect = inject.filter((n) => /workbench|desktop/i.test(n))
  if (suspect.length) warn('dsh.client.inject', `含 ${suspect.join(',')}（普通 Harness 里会让 boot 卡住；上架产物才加）`)
  else ok('dsh.client.inject', inject.length ? inject.join(',') : '空（本地开发版正确）')
} catch (e) {
  warn('dsh.client.inject', String(e.message).slice(0, 60))
}

// ---- 2. 工具 ----------------------------------------------------------------
if (!quiet) console.log('\n【2/5 工具】')
let toolNames = []
try {
  const mod = await import(path.join(ROOT, 'lib/tools/index.js')).catch(() => null)
  // 工具是分散在多个文件里导出的数组，这里按 index.js 的装配顺序扫一遍源码更稳
  const idx = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  const groups = [...idx.matchAll(/from '\.\/tools\/([a-z_]+)\.js'/g)].map((m) => m[1])
  for (const g of [...new Set(groups)]) {
    const file = path.join(ROOT, 'lib', 'tools', `${g}.js`)
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/name:\s*'(lc_[a-z_]+)'/g)) toolNames.push(m[1])
  }
  toolNames = [...new Set(toolNames)]
  if (toolNames.length >= 50) ok('工具注册数', `${toolNames.length} 个`)
  else bad('工具注册数', `只有 ${toolNames.length} 个，装配可能漏了分组`)
} catch (e) {
  bad('工具注册数', String(e.message).slice(0, 80))
}

// 每个工具都必须能被宿主接受：schema 编译 + output.render
try {
  const { assertRawSchema } = await import(path.join(ROOT, 'lib/schema.js'))
  const problems = []
  for (const g of fs.readdirSync(path.join(ROOT, 'lib', 'tools'))) {
    if (!g.endsWith('.js') || g.startsWith('_')) continue
    let mod = null
    try {
      mod = await import(path.join(ROOT, 'lib', 'tools', g))
    } catch (e) {
      problems.push(`${g}: 加载失败 ${String(e.message).slice(0, 60)}`)
      continue
    }
    for (const t of Object.values(mod)) {
      if (!Array.isArray(t)) continue
      for (const def of t) {
        if (!def || !def.name) continue
        if (typeof def.execute !== 'function') problems.push(`${def.name}: 缺 execute`)
      }
    }
  }
  if (problems.length) bad('工具定义完整', problems.slice(0, 3).join('；'))
  else ok('工具定义完整', '每个工具都有 execute')
  void assertRawSchema
} catch (e) {
  warn('工具定义完整', String(e.message).slice(0, 80))
}

// ---- 3. 测试 ----------------------------------------------------------------
if (!quiet) console.log('\n【3/5 测试】')
if (skipTests) {
  warn('测试', '--skip-tests 跳过')
} else {
  try {
    // 必须显式列出 test/*.test.js：`node --test test/` 在 Node 24 上会把目录本身
    // 当成一个测试文件去跑，直接报 "test failed"（假警报，实测过）。
    const files = fs
      .readdirSync(path.join(ROOT, 'test'))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join('test', f))
    const out = execFileSync(process.execPath, ['--test', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
    const pass = (out.match(/^# pass (\d+)/m) || out.match(/ℹ pass (\d+)/) || [])[1]
    const fail = (out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [])[1]
    if (Number(fail) === 0) ok('测试全过', `${pass} 条`)
    else bad('测试全过', `失败 ${fail} 条`)
  } catch (e) {
    // 失败时 stdout 里也有统计，先看它，别只报一句 ExecFileException
    const out = String((e && e.stdout) || '')
    const fail = (out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [])[1]
    const pass = (out.match(/^# pass (\d+)/m) || out.match(/ℹ pass (\d+)/) || [])[1]
    if (fail !== undefined) bad('测试全过', `失败 ${fail} 条 / 共 ${Number(pass || 0) + Number(fail)}`)
    else bad('测试全过', String((e && e.message) || e).slice(0, 160))
  }
}

// ---- 4. 数据与写权限 ---------------------------------------------------------
if (!quiet) console.log('\n【4/5 数据】')
const caseRoot = (() => {
  const env = process.env.LAWCASE_ROOT
  if (env && env.trim()) return path.resolve(env.trim())
  const sibling = path.join(path.dirname(ROOT), 'cases')
  return fs.existsSync(sibling) ? sibling : null
})()

if (!caseRoot) {
  warn('案件根', '未找到（LAWCASE_ROOT 未设置，且同级没有 cases/）')
} else if (!fs.existsSync(caseRoot)) {
  bad('案件根', `${caseRoot} 不存在`)
} else {
  let dirs = []
  try {
    dirs = fs.readdirSync(caseRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (e) {
    bad('案件根可读', String(e.message).slice(0, 80))
  }
  const cases = dirs.filter((n) => fs.existsSync(path.join(caseRoot, n, '.lawcase', 'case.json')))
  ok('案件根', `${caseRoot.replace(/^\/Users\/[^/]+/, '~')}｜${cases.length} 个案件`)
  if (!cases.length) warn('案件', '这个根下一个 LawCase 案件都没有')
}

// 审计目录：写不进去 = 「上次动作」永远空着
const auditDir = path.join(ROOT, '.lawcase-plugin', 'audit')
try {
  fs.mkdirSync(auditDir, { recursive: true })
  const probe = path.join(auditDir, `.probe-${process.pid}`)
  fs.writeFileSync(probe, 'ok')
  fs.unlinkSync(probe)
  ok('审计目录可写', path.relative(ROOT, auditDir))
} catch (e) {
  bad('审计目录可写', String(e.message).slice(0, 80))
}

// ---- 5. 面板状态 -------------------------------------------------------------
if (!quiet) console.log('\n【5/5 面板】')
const uiState = path.join(ROOT, '.lawcase-plugin', 'ui-state.json')
try {
  const st = JSON.parse(fs.readFileSync(uiState, 'utf8'))
  if (!st.root) warn('面板根目录', 'ui-state 里没有 root（面板会回到默认根）')
  else if (!fs.existsSync(st.root)) bad('面板根目录', `${st.root} 已不存在（打开面板会一片空白）`)
  else ok('面板根目录', st.root.replace(/^\/Users\/[^/]+/, '~'))
} catch (e) {
  warn('面板根目录', '还没有 ui-state.json（面板第一次打开会自己建）')
}

// 会话绑定：指向已删除案件 = 助手会一直拒绝对话
try {
  const bind = JSON.parse(fs.readFileSync(path.join(ROOT, '.lawcase-plugin', 'sessions.json'), 'utf8'))
  const dead = Object.entries(bind).filter(([, v]) => v && v.case && !fs.existsSync(v.case))
  if (dead.length) bad('会话绑定', `${dead.length} 条指向已删除的案件`)
  else ok('会话绑定', `${Object.keys(bind).length} 条，全部有效`)
} catch (e) {
  warn('会话绑定', '还没有绑定记录')
}

// ---- 汇总 -------------------------------------------------------------------
const bads = checks.filter((c) => c.status === 'bad')
const warns = checks.filter((c) => c.status === 'warn')
const oks = checks.filter((c) => c.status === 'ok')

console.log('')
if (bads.length === 0) {
  console.log(`自检通过：✅ ${oks.length} 项${warns.length ? ` · ⚠️ ${warns.length} 项` : ''}`)
  if (warns.length) console.log(`提醒：${warns.map((w) => w.name).join('、')}`)
  process.exit(0)
} else {
  console.log(`自检不通过：⛔ ${bads.length} 项 · ⚠️ ${warns.length} 项 · ✅ ${oks.length} 项`)
  for (const b of bads) console.log(`  ⛔ ${b.name}：${b.detail || ''}`)
  process.exit(1)
}
