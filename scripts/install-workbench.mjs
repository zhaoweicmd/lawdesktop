#!/usr/bin/env node
// 把当前源码打包并装进 **DSH Desktop (Workbench).app** 的 profile。
//
// 为什么需要这个脚本（2026-11-01 踩了三次）：
//   本机有两个 DSH Desktop：
//     · DeepSeek Harness.app            → ~/.dsh/profiles/desktop，lawcase 是 link: 源码，改完重启即生效
//     · DSH Desktop (Workbench).app     → ~/Library/Application Support/dsh-desktop/harness/profiles/web，
//                                         lawcase 是 **file: 装进去的 tgz 快照**，改源码它根本看不到
//   用户实际用的是 Workbench 版，于是"改了十几个版本，界面一直是旧的"。
//   从那以后：改完必须打包 + 装进 Workbench profile，否则等于没做。
//
// 用法：
//   node scripts/install-workbench.mjs              # 打包 + 安装
//   node scripts/install-workbench.mjs --dry        # 只打包校验，不改 profile
//   node scripts/install-workbench.mjs --profile <路径>   # 指定其它 profile

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const profileArg = (() => {
  const i = argv.indexOf('--profile')
  return i >= 0 ? argv[i + 1] : ''
})()

const DEFAULT_PROFILE = path.join(
  os.homedir(),
  'Library/Application Support/dsh-desktop/harness/profiles/web'
)
const PROFILE = profileArg ? path.resolve(profileArg) : DEFAULT_PROFILE

const SHIP = ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']
const FORBIDDEN = [/(^|\/)\.lawcase-plugin(\/|$)/, /(^|\/)test(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.tgz$/, /(^|\/)\.env/, /(^|\/)\.pack(\/|$)/]

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const stage = path.join(ROOT, '.pack', `${version}-local`)

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}
function copyTree(src, dest) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dest, e))
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

console.log(`打包 lawcase ${version} → 装到 Workbench profile`)

// ---- 1. 暂存 ---------------------------------------------------------------
rmrf(stage)
const out = path.join(stage, 'package')
fs.mkdirSync(out, { recursive: true })
for (const rel of SHIP) {
  const src = path.join(ROOT, rel)
  if (!fs.existsSync(src)) {
    console.error(`缺少要打包的文件：${rel}`)
    process.exit(1)
  }
  copyTree(src, path.join(out, rel))
}
// 本地安装版：保持 dsh.client.inject 为空（Workbench 宿主已由 profile 提供）
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

// ---- 2. 体检 ---------------------------------------------------------------
// 不许把本机绝对路径、私有状态、测试打进产物；一旦带出去，别人装了就指向我本机。
const problems = []
function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (FORBIDDEN.some((re) => re.test(relPath))) {
      problems.push(`不该打包的路径：${relPath}`)
      continue
    }
    if (entry.isDirectory()) walk(dir, relPath)
    else if (/\.(js|json|yml|md)$/.test(entry.name)) {
      const text = fs.readFileSync(path.join(dir, relPath), 'utf8')
      for (const m of text.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g)) {
        // 文档里的示例路径允许；代码里的绝对路径不允许
        if (!/\.md$/.test(relPath)) problems.push(`本机绝对路径 ${relPath}: ${m[0]}`)
      }
    }
  }
}
walk(out)
if (problems.length) {
  console.error('打包体检未通过：\n' + problems.slice(0, 10).join('\n'))
  process.exit(1)
}
console.log('  ✅ 体检通过（无本机路径 / 无私有状态 / 无测试）')

// ---- 3. 打 tgz -------------------------------------------------------------
const distDir = path.join(ROOT, 'dist')
fs.mkdirSync(distDir, { recursive: true })
const tgz = path.join(distDir, `lawcase-${version}.tgz`)
execFileSync('tar', ['czf', tgz, 'package'], { cwd: stage })
const list = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).trim().split('\n')
console.log(`  ✅ 已打包 ${path.relative(ROOT, tgz)}（${list.length} 项）`)

if (dry) {
  console.log('\n--dry：到此为止，没有改任何 profile')
  process.exit(0)
}

// ---- 4. 装进 profile -------------------------------------------------------
if (!fs.existsSync(path.join(PROFILE, 'package.json'))) {
  console.error(`⛔ 找不到 profile：${PROFILE}`)
  console.error('   用 --profile <路径> 指定，或确认 DSH Desktop (Workbench) 已启动过一次')
  process.exit(1)
}
const profPkgPath = path.join(PROFILE, 'package.json')
const profPkg = JSON.parse(fs.readFileSync(profPkgPath, 'utf8'))
const prev = profPkg.dependencies && profPkg.dependencies.lawcase
console.log(`  当前 profile 装的：${prev || '(无)'}`)

// 备份 package.json：改坏了要能退回
const backup = path.join(PROFILE, `package.json.bak-lawcase-${Date.now()}`)
fs.copyFileSync(profPkgPath, backup)

// 直接把 node_modules/lawcase 换成本次产物（不依赖 pnpm/npm，离线可用）。
// 为什么不用 npm install：这台机器上 profile 是 Electron 独占的，装包容易和宿主抢锁。
const target = path.join(PROFILE, 'node_modules', 'lawcase')
rmrf(target)
fs.mkdirSync(target, { recursive: true })
for (const rel of SHIP) copyTree(path.join(out, rel), path.join(target, rel))
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

// profile 依赖必须和磁盘一致，否则下次 pnpm 一跑就又被退回旧版
profPkg.dependencies = Object.assign({}, profPkg.dependencies, { lawcase: `file:${tgz}` })
fs.writeFileSync(profPkgPath, JSON.stringify(profPkg, null, 2) + '\n')

// ---- 5. 校验 ---------------------------------------------------------------
const installedPkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
const okVer = installedPkg.version === version
// 新功能必须在装进去的那份里，不能只在我本机
const clientSrc = fs.readFileSync(path.join(target, 'lib', 'client.js'), 'utf8')
const hasButtons = clientSrc.includes("'改正文'")
const coreSrc = fs.readFileSync(path.join(target, 'lib', 'core', 'store.js'), 'utf8')
const hasAudit = coreSrc.includes('setAuditSink')

console.log('')
console.log(`  ${okVer ? '✅' : '⛔'} 版本 ${installedPkg.version}（期望 ${version}）`)
console.log(`  ${hasButtons ? '✅' : '⛔'} 客户端含「批注 / 改正文」按钮`)
console.log(`  ${hasAudit ? '✅' : '⛔'} 宿主侧含审计双写`)
console.log(`  ✅ profile 依赖已指向 file:${path.basename(tgz)}`)
console.log(`  ✅ package.json 备份：${path.basename(backup)}`)

if (!okVer || !hasButtons || !hasAudit) {
  console.error('\n⛔ 装进去的内容不对，请检查上面的 ⛔ 项')
  process.exit(1)
}
console.log('\n装好了。**必须完全退出 DSH Desktop (Workbench) 再打开**，宿主侧改动才会加载。')
