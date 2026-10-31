/**
 * 老格式与纯文本读取（.doc / .txt / .rtf）
 *
 * .doc 走 macOS 自带 textutil（零依赖，系统级转换），.txt 直接解码。
 * 两者都不调 LLM、不联网。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEXTUTIL = '/usr/bin/textutil'
const IS_WIN = process.platform === 'win32'

export function findTextutil() {
  if (IS_WIN) return null // Windows 没有 textutil
  try {
    readFileSync(TEXTUTIL)
    return TEXTUTIL
  } catch {
    return null
  }
}

/**
 * Windows 上把 .doc 转成文本：走 PowerShell + Word COM。
 *
 * 为什么不用 LibreOffice：用户机器上不一定装；Word 是 Windows 办公机的基本盘。
 * 为什么不用纯 Node 解析 .doc：老的二进制 OLE 格式，自己解析成本与风险都太高。
 * 失败时给出可执行的替代路径（另存为 .docx），而不是一句"不支持"。
 */
function readDocTextOnWindows(file, { timeoutMs = 60000 } = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$src = $env:LAWCASE_DOC_SRC',
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false',
    'try {',
    '  $doc = $w.Documents.Open($src, $false, $true)', // ReadOnly
    '  if ($env:LAWCASE_DOC_OUT) {',
    '    $doc.SaveAs([ref]$env:LAWCASE_DOC_OUT, [ref]16)', // 16 = wdFormatText
    '    Write-Output "OK:FILE"',
    '  } else {',
    '    Write-Output $doc.Content.Text',
    '  }',
    '  $doc.Close($false)',
    '} finally { $w.Quit() }',
  ].join('\n')

  return new Promise((resolve, reject) => {
    // 把正文写进临时文件再读，避免 COM 输出与 PowerShell 编码互相污染
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { LAWCASE_DOC_SRC: file, LAWCASE_DOC_OUT: '' }),
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          return reject(
            new Error(
              '.doc 转换失败（Windows 需要已安装 Microsoft Word）。' +
                '请用 Word 打开后「另存为 .docx」再扫描，或在有 Word 的机器上转换。'
            )
          )
        }
        const units = splitText(String(stdout || ''))
        if (!units.length) {
          return reject(new Error('.doc 转换没有产出任何文字：文件可能是空的或被加密'))
        }
        resolve(units)
      }
    )
  })
}

/** .doc/.rtf → 纯文本段落（macOS: textutil；Windows: Word COM） */
export async function readDocText(file, { timeoutMs = 60000 } = {}) {
  // textutil 对不存在的文件**退出码仍是 0**（错误只写 stderr），必须自己先查
  if (!existsSync(file)) throw new Error(`.doc 源文件不存在：${file}`)
  if (IS_WIN) return readDocTextOnWindows(file, { timeoutMs })
  const bin = findTextutil()
  if (!bin) throw new Error('缺少 .doc 转换工具（macOS 自带 textutil）——请先在「文本编辑」打开并另存为 .docx')
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', file],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`.doc 转换失败：${err.message}`))
        const units = splitText(stdout)
        // 退出码 0 但没有内容 + stderr 有 Error reading → 当作失败，不静默返回空
        if (!units.length && /Error reading/i.test(String(stderr || ''))) {
          return reject(new Error(`.doc 读取失败：${String(stderr).trim().slice(0, 200)}`))
        }
        resolve(units)
      },
    )
  })
}

/** 纯文本 → 段落（按空行/换行切，保留页标记） */
export function readTxt(buf) {
  let s
  if (Buffer.isBuffer(buf)) {
    // BOM 识别
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) s = buf.toString('utf8').slice(1)
    else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) s = buf.toString('utf16le').slice(1)
    else {
      s = buf.toString('utf8')
      // 非法替换字符过多 → 按 GBK 再试（Node 无内置 GBK，交给 TextDecoder）
      const bad = (s.match(/\uFFFD/g) || []).length
      if (bad > s.length * 0.01) {
        try { s = new TextDecoder('gbk').decode(buf) } catch { /* 保留 utf8 结果 */ }
      }
    }
  } else s = String(buf ?? '')
  return splitText(s)
}

function splitText(s) {
  const out = []
  let page = 1
  for (const raw of String(s).split(/\r?\n/)) {
    if (/^\f+$/.test(raw.trim())) { page += 1; continue }
    const hadFF = raw.includes('\f')
    const t = raw.replace(/\f/g, '').trimEnd()
    if (!t.trim()) continue
    if (hadFF) page += 1
    out.push({ n: out.length + 1, text: t, page })
  }
  return out
}
