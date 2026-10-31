import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** 最小 ZIP 写入器：deflate（压缩不可再小时退化为 store）。
 *  docx 本质是 zip，改完 document.xml 必须原样重新打包，Word 才认。 */
export function writeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const crc = crc32(raw)
    const comp = zlib.deflateRawSync(raw, { level: 9 })
    const useDeflate = comp.length < raw.length
    const data = useDeflate ? comp : raw
    const method = useDeflate ? 8 : 0

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    chunks.push(lh, nameBuf, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)

    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, eocd])
}
