// Erzeugt die Tray-Icons als PNG, damit kein Binaerasset im Repo noetig ist.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const size = 32

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(pixel) {
  const raw = []
  const r = size / 2 - 1
  for (let y = 0; y < size; y++) {
    raw.push(0) // Filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5
      const dy = y - size / 2 + 0.5
      const inside = dx * dx + dy * dy <= r * r
      raw.push(...(inside ? pixel : [0, 0, 0, 0]))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const out = resolve(here, '../resources')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'tray-idle.png'), png([120, 124, 132, 255]))
writeFileSync(resolve(out, 'tray-alarm.png'), png([220, 38, 38, 255]))
writeFileSync(resolve(out, 'tray-offline.png'), png([180, 120, 20, 255]))
console.log('Tray-Icons geschrieben nach', out)
