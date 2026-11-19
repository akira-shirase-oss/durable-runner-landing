// Screenshots of the built site, for review: desktop 1440 and phone 390, in light and dark.
// Serves dist/ with dist/_headers applied (the real CSP), scrolls the page so every asset
// loads, then takes a full-page PNG into shots/.
//
//   npm run build && npm run capture                  # all four: 1440/390 x light/dark
//   node scripts/capture.mjs --only 1440-light        # one shot
//   node scripts/capture.mjs --only 1440-light,390-dark
//
// Playwright is not a dependency of this repo. Install it (npm i -D playwright && npx playwright
// install chromium), or point PLAYWRIGHT_MODULE at an existing node_modules/playwright directory.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, 'dist')
const outDir = resolve(root, 'shots')
const only = process.argv.indexOf('--only') > 0 ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null

if (!existsSync(join(dist, 'index.html'))) {
  console.error('capture: no build at dist/. Run npm run build first.')
  process.exit(1)
}

let playwright
try {
  playwright = await import(
    process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
  )
} catch {
  console.error('capture: Playwright not found. Install it (npm i -D playwright && npx playwright install chromium),')
  console.error('  or set PLAYWRIGHT_MODULE to an existing node_modules/playwright directory.')
  process.exit(2)
}

// The same static server check-csp-browser.mjs uses: dist/ plus the rules in dist/_headers.
const rules = []
for (const line of readFileSync(join(dist, '_headers'), 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (t === '' || t.startsWith('#')) continue
  if (!/^\s/.test(line)) rules.push({ match: new RegExp(`^${t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), headers: [] })
  else rules.at(-1).headers.push([t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1).trim()])
}
const headersFor = (path) => {
  const out = {}
  for (const rule of rules) if (rule.match.test(path)) for (const [name, value] of rule.headers) out[name] = value
  return out
}
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = normalize(join(dist, path))
  if (file !== dist && !file.startsWith(dist + sep)) return void res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) return void res.writeHead(404, headersFor(path)).end('not found')
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...headersFor(path) })
  res.end(readFileSync(file))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}`

const shots = [
  { name: '1440-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: '1440-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: '390-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: '390-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
].filter((s) => !only || only.includes(s.name))

if (shots.length === 0) {
  console.error(`capture: --only wants one of 1440-light, 1440-dark, 390-light, 390-dark (got ${only})`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const browser = await playwright.chromium.launch()
for (const shot of shots) {
  const context = await browser.newContext({ viewport: shot.viewport, colorScheme: shot.colorScheme, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`capture ${shot.name}: page error ${e.message}`))
  page.on('requestfailed', (r) => console.error(`capture ${shot.name}: request failed ${r.url()}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  // Scroll through once so every below-fold asset is fetched and the fonts are settled, then back to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 40))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  // Let the hero's print animation finish so the title is fully drawn in the shot.
  await page.waitForTimeout(1600)
  const file = join(outDir, `${shot.name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`capture: ${file}`)
  await context.close()
}
await browser.close()
server.close()
