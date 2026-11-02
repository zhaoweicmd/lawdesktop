#!/usr/bin/env node
// 把本机源码打包并安装到 DSH Desktop 工作台。
//
// 为什么需要它：本体是 `link:` 安装（改源码重启即可），工作台是 tarball 安装
// （必须重新打包再装）。以前每次改完都要手工做四件事，且踩过两个坑：
//   ① 忘了保住 .lawcase-plugin/ui-state.json → 案件根目录被冲掉
//   ② 忘了更新 profile/package.json 的依赖版本 → 重启后装回旧版
//
// 用法：
//   node scripts/sync-workbench.mjs            # 打包 + 安装（默认目标 profile web）
//   node scripts/sync-workbench.mjs --dry      # 只报告，不动手
//   node scripts/sync-workbench.mjs --profile web

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.resolve(ROOT, '..', 'dist')
const WORKBENCH_HOME = path.join(os.homedir(), 'Library/Application Support/dsh-desktop/harness')
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const profileArg = (() => {
  const i = args.indexOf('--profile')
  return i >= 0 && args[i + 1] ? args[i + 1] : 'web'
})()

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const PROFILE = path.join(WORKBENCH_HOME, 'profiles', profileArg)
const TARGET = path.join(PROFILE, 'node_modules', 'lawcase')
const UI_STATE = path.join(TARGET, '.lawcase-plugin', 'ui-state.json')

const say = (s) => console.log(s)

function sha1Tree(dir, filter = (f) => f.endsWith('.js')) {
  const out = execFileSync('bash', ['-c', `cd ${JSON.stringify(dir)} && find . -name '*.js' -exec shasum {} \\; | sort | shasum`], {
    encoding: 'utf8',
  })
  return out.trim().split(/\s+/)[0]
}

if (!fs.existsSync(PROFILE)) {
  console.error(`✗ 找不到工作台 profile：${PROFILE}`)
  process.exit(1)
}

say(`源码版本 ${version}`)
const targetPkgPath = path.join(TARGET, 'package.json')
if (fs.existsSync(targetPkgPath)) {
  const cur = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8')).version
  const same = cur === version && sha1Tree(path.join(ROOT, 'lib')) === sha1Tree(path.join(TARGET, 'lib'))
  say(`工作台已装 ${cur}${same ? '（内容一致，无需同步）' : '（需要同步）'}`)
  if (same && !dry) {
    say('✓ 已经是最新，什么都没做')
    process.exit(0)
  }
} else {
  say('工作台未安装 lawcase（将全新安装）')
}

// 1) 保住界面状态：案件根目录、上次打开的案件、核对人
let uiState = null
try {
  uiState = fs.readFileSync(UI_STATE, 'utf8')
  say('已备份 ui-state（案件根目录不会被冲掉）')
} catch (e) {
  say('目标没有 ui-state，跳过备份')
}

// 2) 打包：顶层必须是 package/，npm 才认
const tgz = path.join(DIST, `lawcase-${version}.tgz`)
say(`打包 → ${tgz}`)
if (!dry) {
  fs.mkdirSync(DIST, { recursive: true })
  const stage = path.join(ROOT, '.sync-stage')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true })
  for (const item of ['lib', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    const src = path.join(ROOT, item)
    if (!fs.existsSync(src)) continue
    fs.cpSync(src, path.join(stage, 'package', item), { recursive: true })
  }
  execFileSync('tar', ['czf', tgz, '-C', stage, 'package'], { stdio: 'inherit' })
  fs.rmSync(stage, { recursive: true, force: true })
}

// 3) 安装：备份旧版 → 解包 → 写回 ui-state → 更新依赖版本
if (!dry) {
  const bak = path.join(PROFILE, 'node_modules', `lawcase.bak-${(() => {
    try {
      return JSON.parse(fs.readFileSync(targetPkgPath, 'utf8')).version
    } catch (e) {
      return 'old'
    }
  })()}`)
  if (fs.existsSync(TARGET)) {
    fs.rmSync(bak, { recursive: true, force: true })
    fs.renameSync(TARGET, bak)
    say(`旧版备份 → ${path.basename(bak)}`)
  }
  fs.mkdirSync(TARGET, { recursive: true })
  execFileSync('tar', ['xzf', tgz, '-C', TARGET, '--strip-components=1'], { stdio: 'inherit' })

  if (uiState) {
    fs.mkdirSync(path.dirname(UI_STATE), { recursive: true })
    fs.writeFileSync(UI_STATE, uiState, 'utf8')
    try {
      const st = JSON.parse(uiState)
      say(`ui-state 已写回｜根目录：${st.root || '(未设置)'}`)
    } catch (e) {}
  }

  const profPkg = path.join(PROFILE, 'package.json')
  const d = JSON.parse(fs.readFileSync(profPkg, 'utf8'))
  d.dependencies = d.dependencies || {}
  const before = d.dependencies.lawcase
  d.dependencies.lawcase = 'file:' + tgz
  fs.writeFileSync(profPkg, JSON.stringify(d, null, 2) + '\n', 'utf8')
  say(`profile 依赖：${before} → ${d.dependencies.lawcase}`)
}

// 4) 校验
say('')
if (dry) {
  say('（--dry 模式，未实际安装）')
  process.exit(0)
}
const now = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version
const sameNow = sha1Tree(path.join(ROOT, 'lib')) === sha1Tree(path.join(TARGET, 'lib'))
say(`版本 ${now}｜lib 内容与源码一致：${sameNow ? '是' : '否'}`)
if (now !== version || !sameNow) {
  console.error('✗ 校验失败')
  process.exit(1)
}
say('')
say('✓ 同步完成。重启 DSH Desktop 后生效（Cmd+Q 完全退出再打开）。')
