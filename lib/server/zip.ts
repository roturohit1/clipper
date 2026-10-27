import fs from 'node:fs'
import zlib from 'node:zlib'

/** Minimal streaming ZIP writer using STORE (no compression), which is right for already-compressed mp4 files. No dependencies. */
export type ZipEntry = { name: string; file: string; size: number; mtime?: Date }

const MAX_32 = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const nativeCrc = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32

function crc32(chunk: Uint8Array, previous: number) {
  if (nativeCrc) return nativeCrc(chunk, previous)
  let c = ~previous >>> 0
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

const FLAGS = 0x0808 // bit 3: sizes/CRC follow the data; bit 11: UTF-8 names

/** Exact byte length of the archive for these entries, so the download can show real progress. */
export function zipSize(entries: ZipEntry[]) {
  let total = 22
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.name)
    total += 30 + name + entry.size + 16 + 46 + name
  }
  return total
}

export async function* zipStore(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  let offset = 0
  const central: Buffer[] = []
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const { time, date } = dosDateTime(entry.mtime ?? new Date())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAGS, 6)
    local.writeUInt16LE(0, 8) // STORE
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt16LE(name.length, 26)
    const localOffset = offset
    yield Buffer.concat([local, name])
    offset += 30 + name.length

    let crc = 0
    let size = 0
    for await (const chunk of fs.createReadStream(entry.file) as AsyncIterable<Buffer>) {
      crc = crc32(chunk, crc)
      size += chunk.length
      offset += chunk.length
      yield chunk
    }
    if (size > MAX_32 || offset > MAX_32) throw new Error('The archive is too large for a standard zip (4 GB limit). Download clips individually.')

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc >>> 0, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    yield descriptor
    offset += 16

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(FLAGS, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc >>> 0, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(localOffset, 42)
    central.push(Buffer.concat([header, name]))
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  yield directory
  yield end
}
