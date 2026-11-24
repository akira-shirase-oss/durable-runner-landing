// Renders the share image (public/og.png, 1200 × 630) from the built home page itself: the badge, the
// headline with its app icon and the top of the phone over the landscape, cropped at 1200 px wide, so the
// card people see when the link is shared is the page they land on.
//
//   npm run build && PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/make-og.mjs
//
// Commit the result. Playwright is not a dependency of this repo (see scripts/capture.mjs).
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, 'dist')
if (!existsSync(join(dist, 'index.html'))) {
  console.error('make-og: no build at dist/. Run npm run build first.')
  process.exit(1)
}

const playwright = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
)

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer((req, res) => {
  let file = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
  if (file !== dist && !file.startsWith(dist + sep)) return void res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))

const browser = await playwright.chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' })
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
const top = await page.evaluate(() => Math.round(document.querySelector('[data-slot=badge]').getBoundingClientRect().top) - 34)
const png = await page.screenshot({ clip: { x: 0, y: top, width: 1200, height: 630 } })
await browser.close()
server.close()

writeFileSync(join(root, 'public', 'og.png'), png)
console.log(`wrote public/og.png (1200 × 630, ${Math.round(png.length / 1024)} kB)`)
