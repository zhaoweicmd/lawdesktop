#!/usr/bin/env node
// 打包「上架用」的工作台产物。
//
// 为什么需要这个脚本：
//   市场验收要求 package.json 的 dsh.client.inject **必须包含** dsh-desktop-workbenches；
//   但这一条写在普通 DeepSeek Harness（本体）里会让 web boot 卡死（宿主等不到那个客户端包）。
//   所以本地开发版保持 inject: []，上架产物在打包时**注入**该字段，其余内容完全一致。
//
// 用法：
//   node scripts/pack-market.mjs
// 产出：
//   dist/lawcase-<version>-workbench.tgz（上传到 GitHub Release，YAML 里 tarball 指它）

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY = 'https://github.com/zhaoweicmd/lawdesktop'
const WORKBENCH_HOST_PKG = 'dsh-desktop-workbenches'
const MAX_BYTES = 8 * 1024 * 1024
const SHIP = ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']
const FORBIDDEN = [/(^|\/)\.lawcase-plugin(\/|$)/, /(^|\/)test(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.tgz$/, /(^|\/)\.env/]

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const stage = path.join(ROOT, '.pack', version)

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function copyTree(src, dest) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyTree(path.join(src, entry), path.join(dest, entry))
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

for (const rel of SHIP) {
  const src = path.join(ROOT, rel)
  if (!fs.existsSync(src)) {
    console.error(`缺少要打包的文件：${rel}`)
    process.exit(1)
  }
}

rmrf(stage)
fs.mkdirSync(path.join(stage, 'package'), { recursive: true })
const out = path.join(stage, 'package')
for (const rel of SHIP) copyTree(path.join(ROOT, rel), path.join(out, rel))

// 上架用清单：注入 dsh-desktop-workbenches，补 repository / files / license
const market = {
  ...pkg,
  repository: { type: 'git', url: `${REPOSITORY}.git` },
  homepage: REPOSITORY,
  files: SHIP,
  license: 'MIT',
  dsh: {
    ...pkg.dsh,
    client: {
      ...(pkg.dsh && pkg.dsh.client ? pkg.dsh.client : { platform: 'web' }),
      inject: [WORKBENCH_HOST_PKG],
    },
  },
}
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(market, null, 2) + '\n')

// 打包前体检：不许带本机绝对路径 / 私有状态
const problems = []
function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (FORBIDDEN.some((re) => re.test(relPath))) {
      problems.push(`不该打包的路径：${relPath}`)
      continue
    }
    if (entry.isDirectory()) walk(dir, relPath)
    else {
      const text = fs.readFileSync(path.join(dir, relPath), 'utf8')
      for (const m of text.matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g)) {
        if (!m[0].endsWith('/你')) problems.push(`本机绝对路径 ${relPath}: ${m[0]}`)
      }
    }
  }
}
walk(out)
if (problems.length) {
  console.error('打包体检未通过：\n' + problems.join('\n'))
  process.exit(1)
}

const outDir = process.env.OUT_DIR || path.join(ROOT, 'dist')
const tgz = path.join(outDir, `lawcase-${version}-workbench.tgz`)
fs.mkdirSync(path.dirname(tgz), { recursive: true })
execFileSync('tar', ['czf', tgz, 'package'], { cwd: stage, stdio: 'inherit' })

const bytes = fs.statSync(tgz).size
const list = execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).trim().split('\n')
const manifest = JSON.parse(execFileSync('tar', ['xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }))

console.log(`\n产物：${path.relative(ROOT, tgz)}`)
console.log(`大小：${(bytes / 1024).toFixed(0)} KB / 上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MiB → ${bytes <= MAX_BYTES ? '通过' : '超限'}`)
console.log(`文件：${list.length} 项`)
console.log(`manifest：name=${manifest.name} version=${manifest.version} inject=${JSON.stringify(manifest.dsh.client.inject)} repository=${manifest.repository.url}`)
if (bytes > MAX_BYTES) process.exit(1)
