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

/**
 * Schreibt ein RGBA-PNG. shade(x, y) liefert den Pixel oder null fuer transparent,
 * wobei x/y Gleitkommazahlen sind. Mit ss > 1 wird pro Pixel ein Raster von
 * ss x ss Punkten abgetastet - das glaettet die Kanten von Kreisen und Radien.
 */
function png(dim, shade, ss = 1) {
  const raw = []
  for (let y = 0; y < dim; y++) {
    raw.push(0) // Filter: none
    for (let x = 0; x < dim; x++) {
      if (ss === 1) {
        raw.push(...(shade(x + 0.5, y + 0.5) ?? [0, 0, 0, 0]))
        continue
      }
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const pixel = shade(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)
          if (pixel) {
            r += pixel[0]
            g += pixel[1]
            b += pixel[2]
            hits++
          }
        }
      }
      const total = ss * ss
      if (hits === 0) raw.push(0, 0, 0, 0)
      else raw.push(Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((255 * hits) / total))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Tray: schlichter gefuellter Kreis in der jeweiligen Statusfarbe. */
function trayIcon(pixel) {
  const r = size / 2 - 1
  return png(
    size,
    (x, y) => {
      const dx = x - size / 2
      const dy = y - size / 2
      return dx * dx + dy * dy <= r * r ? pixel : null
    },
    4
  )
}

/** App-Icon: rotes abgerundetes Quadrat mit Signal-Ringen. */
function appIcon(dim) {
  const pad = dim * 0.09
  const radius = dim * 0.22
  const red = [220, 38, 38, 255]
  const white = [255, 255, 255, 255]
  const cx = dim / 2
  const cy = dim / 2

  const inRounded = (x, y) => {
    const lo = pad
    const hi = dim - pad
    if (x < lo || x > hi || y < lo || y > hi) return false
    const qx = Math.max(lo + radius - x, x - (hi - radius), 0)
    const qy = Math.max(lo + radius - y, y - (hi - radius), 0)
    return qx * qx + qy * qy <= radius * radius
  }

  const ring = (d, from, to) => d >= from && d <= to

  return png(
    dim,
    (x, y) => {
      if (!inRounded(x, y)) return null
      const d = Math.hypot(x - cx, y - cy)
      if (d <= dim * 0.085) return white
      if (ring(d, dim * 0.16, dim * 0.205)) return white
      if (ring(d, dim * 0.275, dim * 0.32)) return white
      return red
    },
    4
  )
}

const out = resolve(here, '../resources')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'tray-idle.png'), trayIcon([120, 124, 132, 255]))
writeFileSync(resolve(out, 'tray-alarm.png'), trayIcon([220, 38, 38, 255]))
writeFileSync(resolve(out, 'tray-offline.png'), trayIcon([180, 120, 20, 255]))

// Quelle fuer icon.icns (macOS) und icon.ico/PNG (Windows) - siehe scripts/make-appicon.sh
writeFileSync(resolve(out, 'icon.png'), appIcon(1024))
console.log('Icons geschrieben nach', out)
