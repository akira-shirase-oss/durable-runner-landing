// Draws the hero's sky-and-hills landscape: procedural noise (sky, warped-fBm clouds, three hill
// ridges, grass texture), a tilt-shift blur and film grain, rendered in headless Chromium. The output is
// original art, so the page carries no stock photo. Re-run it to change the picture:
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/make-landscape.mjs            # day
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright TIME=night node scripts/make-landscape.mjs # night
//   cwebp -q 80 -m 6 -sharp_yuv .cache/landscape.png -o public/hero/landscape.webp
//   cwebp -q 80 -m 6 -sharp_yuv .cache/landscape-night.png -o public/hero/landscape-night.webp
//
// Day is the light theme's picture; night is the same hills, clouds and seed under a moonlit blue-hour sky, for
// the dark theme. Same seed, same shapes. Output: .cache/landscape[-night].png (git-ignored) at 2 × the desktop
// panel (2336 × 886).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.cache')
const seed = Number(process.env.SEED ?? 7)
const night = process.env.TIME === 'night'

// Every colour the picture uses, per time of day.
const PALETTES = {
  day: {
    sky: [[0, '#3b7fd6'], [0.22, '#5795df'], [0.45, '#86b4ea'], [0.62, '#c3dcf3'], [0.72, '#dbe9f5']],
    glow: '#e8f1fa', glowAt: [1, 0.2], glowAmount: 0.1,
    cloudShade: '#a9bcd6', cloudLit: '#ffffff', cloudAlpha: 1,
    farNear: '#a9c7b4', farDeep: '#93b886', farHaze: '#cfe1ea',
    mid: [[0, '#d3e283'], [0.12, '#a9cd5c'], [0.45, '#7fb043'], [1, '#5a8c2e']],
    front: [[0, '#93c052'], [0.4, '#679c36'], [1, '#456f24']],
    flower: [250, 252, 244], flowerAlpha: 0.75, stars: 0,
  },
  night: {
    sky: [[0, '#0a1430'], [0.22, '#12224a'], [0.45, '#1d3463'], [0.62, '#2f4c80'], [0.72, '#43629a']],
    glow: '#8fa8dc', glowAt: [0.68, 0.15], glowAmount: 0.3, moon: '#eef2fc', moonR: 21,
    cloudShade: '#121c36', cloudLit: '#7186b2', cloudAlpha: 0.74,
    farNear: '#273a52', farDeep: '#22383a', farHaze: '#36507a',
    mid: [[0, '#56785f'], [0.12, '#3c5d47'], [0.45, '#284434'], [1, '#182e22']],
    front: [[0, '#2d4c38'], [0.4, '#1e3829'], [1, '#11211a']],
    flower: [196, 212, 240], flowerAlpha: 0.32, stars: 520,
  },
}
const palette = PALETTES[night ? 'night' : 'day']

const playwright = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
)
const browser = await playwright.chromium.launch()
const page = await browser.newPage()

const dataUrl = await page.evaluate(
  ({ W, H, seed, P }) => {
    // ---- noise -------------------------------------------------------------------------------
    let s = seed >>> 0
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
    const perm = [...Array(256).keys()]
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[perm[i], perm[j]] = [perm[j], perm[i]]
    }
    const p = new Uint8Array(512)
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255]
    const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
    const noise = (x, y) => {
      const xf = Math.floor(x), yf = Math.floor(y)
      const X = xf & 255, Y = yf & 255
      x -= xf; y -= yf
      const g = (h, dx, dy) => { const v = G[h & 7]; return v[0] * dx + v[1] * dy }
      const u = fade(x), v = fade(y)
      const aa = g(p[p[X] + Y], x, y), ba = g(p[p[X + 1] + Y], x - 1, y)
      const ab = g(p[p[X] + Y + 1], x, y - 1), bb = g(p[p[X + 1] + Y + 1], x - 1, y - 1)
      const l1 = aa + u * (ba - aa), l2 = ab + u * (bb - ab)
      return l1 + v * (l2 - l1)
    }
    const fbm = (x, y, oct = 6, gain = 0.5) => {
      let sum = 0, amp = 1, f = 1, norm = 0
      for (let i = 0; i < oct; i++) { sum += amp * noise(x * f, y * f); norm += amp; amp *= gain; f *= 2.03 }
      return sum / norm // ~[-0.7, 0.7]
    }
    const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
    const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t) }
    const mix = (a, b, t) => a + (b - a) * t
    const mix3 = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)]
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
    const ramp = (stops, t) => {
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
          const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]
          return mix3(hex(c0), hex(c1), smooth(0, 1, (t - t0) / (t1 - t0)))
        }
      }
      return hex(stops[stops.length - 1][1])
    }
    // A ridge line through control points (x/W, y/H), Catmull-Rom between them, with a small wiggle.
    const ridge = (pts, wiggle, freq, off) => (x) => {
      const u = x / W
      let i = 0
      while (i < pts.length - 2 && u > pts[i + 1][0]) i++
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
      const t = clamp((u - p1[0]) / (p2[0] - p1[0]))
      const t2 = t * t, t3 = t2 * t
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      return (y + wiggle * fbm(x / freq + off, off, 4)) * H
    }

    const far = ridge([[0, 0.6], [0.2, 0.62], [0.45, 0.6], [0.65, 0.57], [0.8, 0.58], [1, 0.55]], 0.03, 260, 11.3)
    const mid = ridge([[0, 0.5], [0.12, 0.555], [0.26, 0.655], [0.42, 0.7], [0.56, 0.69], [0.7, 0.63], [0.82, 0.52], [0.92, 0.37], [1, 0.3]], 0.025, 300, 3.7)
    const front = ridge([[0, 0.8], [0.14, 0.83], [0.34, 0.9], [0.6, 0.92], [0.8, 0.83], [1, 0.74]], 0.02, 220, 7.1)

    // Where the clouds gather: soft blobs (cx, cy, rx, ry, weight) in panel fractions.
    const blobs = [
      [0.06, 0.06, 0.2, 0.2, 0.95], [0.22, 0.0, 0.18, 0.14, 0.7], [0.36, 0.22, 0.14, 0.12, 0.45],
      [0.68, 0.36, 0.1, 0.2, 0.95], [0.6, 0.16, 0.12, 0.12, 0.55], [0.86, 0.12, 0.1, 0.1, 0.35],
      [0.5, 0.06, 0.12, 0.1, 0.4], [0.1, 0.42, 0.12, 0.1, 0.55],
    ]
    const cover = (u, v) => {
      let m = 0
      for (const [cx, cy, rx, ry, w] of blobs) {
        const dx = (u - cx) / rx, dy = (v - cy) / ry
        m += w * Math.exp(-(dx * dx + dy * dy))
      }
      return m
    }

    const sky = P.sky
    const buf = new Float32Array(W * H * 3)
    const cloudDensity = (x, y, oct = 5) => {
      const sx = x / 420, sy = y / 250
      const wx = fbm(sx + 5.2, sy + 1.3, 3), wy = fbm(sx + 1.7, sy + 9.2, 3)
      return fbm(sx + 0.35 * wx, sy + 0.35 * wy, oct, 0.47)
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H
        const i = (y * W + x) * 3
        // sky, a touch brighter toward the right-hand sun
        let c = ramp(sky, v + 0.04 * (u - 0.5))
        if (P.glowAt[0] === 1) c = mix3(c, hex(P.glow), P.glowAmount * smooth(0.4, 1, u) * smooth(0.6, 0.2, v))
        else {
          // the moon's halo: a soft disc of light high on the right
          const dx = (u - P.glowAt[0]) * (W / H), dy = v - P.glowAt[1]
          c = mix3(c, hex(P.glow), P.glowAmount * Math.exp(-(dx * dx + dy * dy) / 0.02))
          // the moon itself, behind the clouds drawn next
          const md = Math.hypot(x - P.glowAt[0] * W, y - P.glowAt[1] * H)
          if (md < P.moonR + 1.5) c = mix3(c, hex(P.moon), smooth(P.moonR + 1.5, P.moonR - 1.5, md))
        }

        // clouds
        if (v < 0.78) {
          const d = cloudDensity(x, y)
          const m = cover(u, v)
          const a = Math.pow(smooth(0.38, 0.72, d * 0.9 + m * 0.6 + 0.12), 0.8) * smooth(0.74, 0.5, v)
          if (a > 0.001) {
            // cumulus: bright where density grows downward (the tops), grey-blue at the bases
            const up = cloudDensity(x - 10, y - 34, 3), down = cloudDensity(x + 10, y + 34, 3)
            const lit = clamp(0.78 + (down - up) * 3.2 + 0.12 * smooth(0.5, 0, v))
            const base = mix3(hex(P.cloudShade), hex(P.cloudLit), lit)
            c = mix3(c, base, clamp(a * P.cloudAlpha))
          }
        }

        // far hills: hazy blue-green that melts into the sky
        const yf = far(x)
        if (y >= yf) {
          const t = clamp((y - yf) / (0.12 * H))
          let hc = mix3(hex(P.farNear), hex(P.farDeep), t)
          hc = mix3(hc, hex(P.farHaze), 0.35 * (1 - t))
          c = mix3(c, hc, smooth(0, 3, y - yf))
        }
        // mid hill: sunlit crest, deepening green, patchy light
        const ym = mid(x)
        if (y >= ym) {
          const t = clamp((y - ym) / (0.3 * H))
          let hc = ramp(P.mid, t)
          const sun = fbm(x / 420 + 20, y / 140, 3)
          const patch = fbm(x / 120 + 30, y / 60, 4)
          const grass = fbm(x / 5 + 40, y / 22, 3)
          hc = hc.map((ch) => ch * (1 + 0.3 * sun + 0.14 * patch + 0.06 * grass))
          c = mix3(c, hc, smooth(0, 2.5, y - ym))
        }
        // foreground: darker, richer grass with streaks
        const yr = front(x)
        if (y >= yr) {
          const t = clamp((y - yr) / (0.2 * H))
          let hc = ramp(P.front, t)
          const streak = fbm(x / 4 + 60, y / 36, 3)
          const patch = fbm(x / 160 + 80, y / 70, 3)
          hc = hc.map((ch) => ch * (1 + 0.1 * streak + 0.26 * patch))
          c = mix3(c, hc, smooth(0, 2, y - yr))
        }
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]
      }
    }

    // white flower specks in the grass
    for (let k = 0; k < 900; k++) {
      const x = Math.floor(rnd() * W)
      const yTop = Math.min(mid(x), front(x)) + 30
      const y = Math.floor(yTop + rnd() * (H - yTop))
      if (y >= H) continue
      const r = 1 + rnd() * 2.2
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const dd = Math.hypot(dx, dy)
        if (dd > r) continue
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = (yy * W + xx) * 3
        const a = P.flowerAlpha * (1 - dd / (r + 0.01))
        buf[j] = mix(buf[j], P.flower[0], a); buf[j + 1] = mix(buf[j + 1], P.flower[1], a); buf[j + 2] = mix(buf[j + 2], P.flower[2], a)
      }
    }

    // night only: faint stars, drawn on clear sky (never over a cloud or a hill)
    for (let k = 0; k < P.stars; k++) {
      const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H * 0.55)
      const j = (y * W + x) * 3
      if (y > mid(x) - 20 || buf[j] + buf[j + 1] + buf[j + 2] > 3 * 95) continue
      const big = rnd() < 0.12, a = 0.35 + rnd() * 0.5
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const w = dx === 0 && dy === 0 ? a : big ? a * 0.35 : 0
        if (!w) continue
        const q = ((y + dy) * W + x + dx) * 3
        if (q < 0 || q >= buf.length) continue
        buf[q] = mix(buf[q], 235, w); buf[q + 1] = mix(buf[q + 1], 240, w); buf[q + 2] = mix(buf[q + 2], 255, w)
      }
    }

    // to a canvas
    const toCanvas = (data) => {
      const cv = document.createElement('canvas')
      cv.width = W; cv.height = H
      const ctx = cv.getContext('2d')
      const img = ctx.createImageData(W, H)
      for (let k = 0, j = 0; k < W * H; k++, j += 3) {
        img.data[k * 4] = data[j]; img.data[k * 4 + 1] = data[j + 1]; img.data[k * 4 + 2] = data[j + 2]; img.data[k * 4 + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      return cv
    }
    const sharp = toCanvas(buf)
    const blurred = (px) => {
      const cv = document.createElement('canvas')
      cv.width = W; cv.height = H
      const ctx = cv.getContext('2d')
      ctx.filter = `blur(${px}px)`
      ctx.drawImage(sharp, 0, 0)
      return ctx.getImageData(0, 0, W, H).data
    }
    const soft = blurred(1.6)
    const deep = blurred(22)

    // tilt-shift: the foreground and the top-left corner go soft, the middle band stays crisp
    const final = document.createElement('canvas')
    final.width = W; final.height = H
    const fctx = final.getContext('2d')
    const out = fctx.createImageData(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H
        const w = clamp(smooth(0.7, 0.98, v) + 0.55 * smooth(0.3, 0.0, v) * smooth(0.45, 0.0, u) + 0.35 * smooth(0.82, 1, u) * smooth(0.6, 1, v))
        const k = (y * W + x) * 4
        const grain = (rnd() - 0.5) * 9
        for (let ch = 0; ch < 3; ch++) out.data[k + ch] = clamp(mix(soft[k + ch], deep[k + ch], w) + grain, 0, 255)
        out.data[k + 3] = 255
      }
    }
    fctx.putImageData(out, 0, 0)
    return final.toDataURL('image/png')
  },
  { W: 2336, H: 886, seed, P: palette },
)

await browser.close()
mkdirSync(out, { recursive: true })
const name = night ? 'landscape-night.png' : 'landscape.png'
writeFileSync(join(out, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
console.log(`wrote ${join('.cache', name)} (seed ${seed})`)
