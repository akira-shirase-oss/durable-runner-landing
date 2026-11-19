// Renders the share image (public/og.png, 1200 × 630) in the page's own language: the hero's white →
// #0061ff gradient, and the product's name in Geist Pixel's own cells — the same cells the footer
// wordmark uses, read from the shipped font by lib/geist-cells.mjs. No browser needed:
//
//   node scripts/make-og.mjs
//
// Commit the result.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { cellsFor } from './lib/geist-cells.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const W = 1200
const H = 630

// The brand block's colours (tokens.css --c-brand-top / --c-brand-bottom / --c-on-brand).
const TOP = [0xff, 0xff, 0xff]
const BOTTOM = [0x00, 0x61, 0xff]
const INK = [0x08, 0x14, 0x2b]

// The title, stacked so the cells stay chunky on a 1200-wide card, and the one-line promise below it.
const LINES = [
  { word: 'Durable', pitch: 9 },
  { word: 'Runner', pitch: 9 },
  { word: 'acknowledged work survives', pitch: 3 },
]
const rendered = []
for (const { word, pitch } of LINES) rendered.push({ ...(await cellsFor(word)), pitch })

// Vertical layout: lines centred as a block, 4 cell-rows of pitch between them.
const heights = rendered.map((r) => r.rows * r.pitch)
const gap = Math.round((H - heights.reduce((a, b) => a + b, 0)) / (rendered.length + 1))

const px = new Uint8Array(W * H * 4)
const put = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = 0xff
}
for (let y = 0; y < H; y++) {
  const t = y / (H - 1)
  const row = TOP.map((v, i) => Math.round(v + (BOTTOM[i] - v) * t))
  for (let x = 0; x < W; x++) put(x, y, row)
}
// One font cell = a square of 0.9 pitch, the hairline left as gradient.
let y = gap
for (const { cells, cols, rows, pitch } of rendered) {
  const size = Math.max(1, Math.round(pitch * 0.9))
  const x0 = Math.round((W - cols * pitch) / 2)
  for (const { col, row } of cells)
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) put(x0 + col * pitch + dx, y + row * pitch + dy, INK)
  y += rows * pitch + gap
}

// PNG: signature + IHDR + IDAT (each scanline filter-byte 0, deflated) + IEND.
const table = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const scan = Buffer.alloc(H * (1 + W * 4))
for (let r = 0; r < H; r++) {
  scan[r * (1 + W * 4)] = 0
  Buffer.from(px.buffer, r * W * 4, W * 4).copy(scan, r * (1 + W * 4) + 1)
}
const tag = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, check])
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  tag('IHDR', ihdr),
  tag('IDAT', deflateSync(scan, { level: 9 })),
  tag('IEND', Buffer.alloc(0)),
])

const out = join(ROOT, 'public', 'og.png')
writeFileSync(out, png)
console.log(`make-og: public/og.png, ${W} × ${H}, ${(png.length / 1024).toFixed(1)} KB`)
