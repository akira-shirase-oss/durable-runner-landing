// Reads Geist Pixel's own glyph cells out of the shipped woff2: the font draws every glyph as separate
// square cells on a 38-unit grid, so a word is a set of cells on that grid. Shared by
// wordmark-from-geist-pixel.mjs (the footer wordmark) and make-og.mjs (the share image), which then
// can't drift from the font the site ships.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Font, woff2 } from 'fonteditor-core'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const CELL = 38 // font units per pixel cell

let font
async function load() {
  if (font) return font
  await woff2.init()
  font = Font.create(readFileSync(join(ROOT, 'public/fonts/geist-pixel-latin.woff2')), { type: 'woff2' }).get()
  return font
}

/** The cells of `word`: { cells: [{col,row}], cols, rows, capRows } with row 0 the cap top. */
export async function cellsFor(word) {
  const data = await load()
  const { cmap, glyf } = data
  const capTop = Math.round(data['OS/2'].sCapHeight / CELL)

  // A compound glyph (the dot on an 'i' is one) points at other glyphs with an offset each:
  // flatten to plain contours so cells resolve the same way.
  const contoursOf = (g, ox = 0, oy = 0, depth = 0) => {
    if (depth > 8) throw new Error('compound glyph nested too deep')
    if (g.compound) {
      return g.glyfs.flatMap((ref) =>
        contoursOf(glyf[ref.glyphIndex], ox + (ref.transform?.e ?? 0), oy + (ref.transform?.f ?? 0), depth + 1),
      )
    }
    return (g.contours ?? []).map((contour) =>
      contour.map((p) => ({ x: p.x + ox, y: p.y + oy })),
    )
  }

  const cells = []
  let penX = 0
  for (const ch of word) {
    const glyph = glyf[cmap[ch.codePointAt(0)]]
    if (!glyph) throw new Error(`no glyph for ${JSON.stringify(ch)}`)
    for (const contour of contoursOf(glyph)) {
      const xs = contour.map((p) => p.x)
      const ys = contour.map((p) => p.y)
      const col = Math.round(Math.min(...xs) / CELL) + penX
      const row = capTop - Math.round(Math.max(...ys) / CELL)
      if (Math.round((Math.max(...xs) - Math.min(...xs)) / CELL) !== 1 || Math.round((Math.max(...ys) - Math.min(...ys)) / CELL) !== 1) {
        throw new Error(`${ch}: a contour is not one cell; the font is not the pixel instance this expects`)
      }
      cells.push({ col, row })
    }
    penX += Math.round(glyph.advanceWidth / CELL)
  }

  const minRow = Math.min(...cells.map((c) => c.row))
  const minCol = Math.min(...cells.map((c) => c.col))
  const cols = Math.max(...cells.map((c) => c.col)) - minCol + 1
  const rows = Math.max(...cells.map((c) => c.row)) - minRow + 1
  return { cells: cells.map((c) => ({ col: c.col - minCol, row: c.row - minRow })), cols, rows, capRows: capTop - minRow + 1 }
}
