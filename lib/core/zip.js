import zlib from 'node:zlib'

/** 最小 ZIP 读取器（只支持 stored / deflate），零依赖。
 *  docx / xlsx / pptx 都是 zip，够用。 */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

export function readZip(buf) {
  const eocd = findEOCD(buf)
  if (eocd < 0) throw new Error('不是有效的 zip/docx/xlsx：找不到中央目录')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    read(name) {
      const e = entries.get(name)
      if (!e) return null
      if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`)
      const nameLen = buf.readUInt16LE(e.localOff + 26)
      const extraLen = buf.readUInt16LE(e.localOff + 28)
      const start = e.localOff + 30 + nameLen + extraLen
      const data = buf.subarray(start, start + e.compSize)
      if (e.method === 0) return data
      if (e.method === 8) return zlib.inflateRawSync(data)
      throw new Error(`不支持的压缩方式 ${e.method}：${name}`)
    },
    readText(name) {
      const b = this.read(name)
      return b ? b.toString('utf8') : null
    },
  }
}
