import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 扫描件兜底：pdftotext 抽不出字时，把每页渲染成图片再走系统 OCR。
 * 本机现成的 OCR 是 macOS Vision 编译的二进制（~/.dsh/bot/workspace/lzy_ocr/ocr）。
 * 注意：首次调用要加载 Vision 模型，约 14 秒；之后每页 ~0.4 秒。
 */

const OCR_CANDIDATES = [
  process.env.LAWCASE_OCR,
  path.join(os.homedir(), '.dsh/bot/workspace/lzy_ocr/ocr'),
  '/usr/local/bin/ocr',
]

const PY_CANDIDATES = [process.env.LAWCASE_PYTHON, '/usr/bin/python3']

export function findOcr() {
  for (const c of OCR_CANDIDATES) {
    if (!c) continue
    try {
      if (fs.existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return null
}

function findPython() {
  for (const c of PY_CANDIDATES) {
    if (!c) continue
    try {
      if (fs.existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return null
}

/** 用 PyMuPDF 把 PDF 的若干页渲染成 PNG，返回文件路径数组（给 from 就从该页起） */
export function renderPdfPages(absPath, outDir, { dpi = 200, maxPages = 300, from = 1 } = {}) {
  const py = findPython()
  if (!py) throw new Error('找不到 python3，无法把 PDF 渲染成图片做 OCR')
  fs.mkdirSync(outDir, { recursive: true })
  const startIdx = Math.max(0, Number(from || 1) - 1)
  const script = `
import sys, fitz, os
src, out, dpi, cap, start = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
d = fitz.open(src)
end = min(len(d), start + cap)
paths = []
for i in range(start, end):
    p = os.path.join(out, f"p{i+1:04d}.png")
    d[i].get_pixmap(dpi=dpi).save(p)
    paths.append(p)
print("\\n".join(paths))
`
  let out
  try {
    out = execFileSync(py, ['-c', script, absPath, outDir, String(dpi), String(maxPages), String(startIdx)], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    })
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    if (/No module named 'fitz'/i.test(msg) || /ModuleNotFoundError/i.test(msg)) {
      throw new Error('缺 PyMuPDF（fitz），无法把 PDF 渲染成图片。装一下：python3 -m pip install pymupdf')
    }
    throw new Error(`PDF 渲染失败：${msg}`)
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

export function ocrImage(imgPath) {
  const bin = findOcr()
  if (!bin) throw new Error('找不到 OCR 程序。用 LAWCASE_OCR 指到可执行文件（如 lzy_ocr/ocr）')
  try {
    return execFileSync(bin, [imgPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 })
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    throw new Error(`OCR 失败（${path.basename(imgPath)}）：${msg}`)
  }
}

/**
 * 扫描件 PDF → 文本单元。行级切分，页码保留——事实出处要能指回「第几页第几行」。
 */
export function ocrPdf(absPath, { dpi = 200, maxPages = 100, from = 1 } = {}) {
  const startPage = Math.max(1, Number(from) || 1)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lawcase-ocr-'))
  try {
    const pages = renderPdfPages(absPath, tmp, { dpi, maxPages, from: startPage })
    const units = []
    let n = 0
    for (let i = 0; i < pages.length; i++) {
      const text = ocrImage(pages[i])
      for (const line of text.split(/\r?\n/)) {
        const t = line.replace(/\s+$/, '').trim()
        if (!t) continue
        n += 1
        units.push({ n, page: startPage + i, text: t })
      }
    }
    return {
      units,
      pages: pages.length,
      engine: 'ocr',
      nonEmpty: units.length,
      rendered: pages.length,
      from: startPage,
      to: startPage + pages.length - 1,
      truncated: pages.length >= maxPages,
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
