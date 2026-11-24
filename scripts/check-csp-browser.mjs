// Loads every built page in headless Chromium with the headers from dist/_headers and fails on any
// Content-Security-Policy violation, page error, failed request or broken image. It also steps the hero's
// story card and applies a stored theme, which proves the hashed inline scripts actually ran.
//
//   npm run build && npm run check:browser
//   node scripts/check-csp-browser.mjs --mutate   # serves a CSP with the script hashes removed; must fail
//
// Playwright is not a dependency of this repo. Install it (npm i -D playwright && npx playwright
// install chromium), or point PLAYWRIGHT_MODULE at an existing node_modules/playwright directory.
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distArg = process.argv.indexOf('--dist')
const dist = resolve(root, distArg > 0 ? process.argv[distArg + 1] : 'dist')
const mutate = process.argv.includes('--mutate')

let playwright
try {
  playwright = await import(
    process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
  )
} catch {
  console.error('check-csp-browser: Playwright not found. Install it, or set PLAYWRIGHT_MODULE (see the top of this file).')
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// A static server for dist/ that applies _headers the way Cloudflare Pages does for these rules.

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
  if (mutate && out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(/ 'sha256-[^']+'/g, '')
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
// The port band the rules hand this repo (58680-58689): try each in turn, then let the kernel pick
// if the band is full — a transient server should never fail on a taken port.
const listen = (server) =>
  new Promise((ok, err) => {
    const band = Array.from({ length: 10 }, (_, i) => 58680 + i).concat(0)
    const tryNext = () => {
      const port = band.shift()
      if (port === undefined) return err(new Error('no free port'))
      server.once('error', tryNext)
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', tryNext); ok() })
    }
    tryNext()
  })
await listen(server)
const origin = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------------------------------

// Every page: / …
const pages = (function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name === 'index.html' ? ['/' + relative(dist, join(dir, '/')).split(sep).join('/')] : [],
  )
})(dist)
  .map((p) => (p === '/' ? p : p.replace(/\/?$/, '/')))
  .sort()

const browser = await playwright.chromium.launch()
const version = browser.version()
const problems = []
let interactions = 0

async function visit(path, viewport, act, colorScheme = 'light') {
  const context = await browser.newContext({ viewport, colorScheme })
  await context.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} (${e.sourceFile || 'page'}:${e.lineNumber})`),
    )
  })
  const page = await context.newPage()
  const report = (what) => problems.push(`${path} [${viewport.width}px ${colorScheme}]: ${what}`)
  page.on('pageerror', (e) => report(`page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && report(`console error: ${m.text()}`))
  page.on('requestfailed', (r) => report(`request failed: ${r.url()} (${r.failure()?.errorText})`))
  page.on('response', (r) => r.status() >= 400 && report(`HTTP ${r.status()} for ${r.url()}`))

  const response = await page.goto(origin + path, { waitUntil: 'load' })
  if (!response.headers()['content-security-policy']) report('served without a Content-Security-Policy header')
  // Scroll through the page so lazy images and late CSS backgrounds load too.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 40))
    }
  })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  if (act) await act(page, report)

  const result = await page.evaluate(() => ({
    csp: window.__csp,
    broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
    fonts: [...document.fonts].filter((f) => f.status === 'loaded').length,
    fontErrors: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family),
    // A code token must be drawn in its theme colour, the one `npm run check` measured against the surface.
    codeOff: [...document.querySelectorAll('pre.astro-code span[style*="--shiki-light"]')]
      .filter((span) => {
        const dark = getComputedStyle(document.documentElement).colorScheme === 'dark'
        const want = getComputedStyle(span).getPropertyValue(dark ? '--shiki-dark' : '--shiki-light').trim()
        const probe = document.createElement('i')
        probe.style.color = want
        document.body.append(probe)
        const wanted = getComputedStyle(probe).color
        probe.remove()
        return getComputedStyle(span).color !== wanted
      })
      .slice(0, 3)
      .map((span) => `${span.textContent.slice(0, 20)} is ${getComputedStyle(span).color}`),
  }))
  for (const off of result.codeOff) report(`code token not in its theme colour: ${off}`)
  for (const v of result.csp) report(`CSP violation: ${v}`)
  for (const src of result.broken) report(`broken image: ${src}`)
  for (const family of result.fontErrors) report(`font failed: ${family}`)
  if (result.fonts === 0) report('no web font loaded')
  await context.close()
}

const desktop = { width: 1440, height: 900 }
const phone = { width: 390, height: 844 }

for (const path of pages) {
  await visit(path, desktop)
}
// Every page again with the system in dark mode: the same CSP, no errors, and the dark tokens in force.
for (const path of pages) {
  await visit(path, desktop, async (page, report) => {
    interactions++
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    if (bg === 'rgb(255, 255, 255)') report(`the system asks for dark, but the page background is ${bg}`)
  }, 'dark')
}

// A stored Dark choice is applied by the hashed inline head script before first paint, on a light system.
{
  const context = await browser.newContext({ viewport: desktop })
  await context.addInitScript(() => { try { localStorage.setItem('theme', 'dark') } catch {} })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
  interactions++
  const early = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, page: getComputedStyle(document.documentElement).getPropertyValue('--c-page').trim() }))
  if (early.theme !== 'dark' || early.page !== '#0d0e10') problems.push(`/ [stored theme]: a stored Dark is not applied before first paint: ${JSON.stringify(early)}`)
  await context.close()
}

// The theme toggle (the family's): one button, aria-pressed when dark. On a light system, pressing stores
// Dark, which a reload applies before first paint (the inline head script); pressing again lands on the
// system's own scheme and clears the choice. On a dark system the same goes the other way. With motion
// allowed the switch runs as a view transition, and with reduced motion it doesn't. Blocked storage still
// switches the page.
const countTransitions = () => {
  window.__vt = 0
  const start = document.startViewTransition?.bind(document)
  if (start) document.startViewTransition = (cb) => { window.__vt++; return start(cb) }
}
const state = (page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    stored: localStorage.getItem('theme'),
    pressed: document.querySelector('[data-theme-toggle]').getAttribute('aria-pressed'),
    vt: window.__vt,
  }))
await visit('/', desktop, async (page, report) => {
  interactions++
  await page.addInitScript(countTransitions)
  await page.reload({ waitUntil: 'networkidle' })
  const toggle = page.locator('[data-theme-toggle]')
  if ((await toggle.getAttribute('aria-pressed')) !== 'false') report('on a light system the toggle starts pressed')
  await toggle.click()
  await page.waitForTimeout(600)
  let s = await state(page)
  if (s.theme !== 'dark' || s.stored !== 'dark' || s.pressed !== 'true') report(`pressing on a light system did not store Dark: ${JSON.stringify(s)}`)
  if (!(s.vt >= 1)) report('with motion allowed, the switch did not run as a view transition')
  await page.reload({ waitUntil: 'domcontentloaded' })
  const early = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, page: getComputedStyle(document.documentElement).getPropertyValue('--c-page').trim() }))
  if (early.theme !== 'dark' || early.page !== '#0d0e10') report(`a stored Dark is not applied before first paint: ${JSON.stringify(early)}`)
  await page.waitForLoadState('networkidle')
  await page.locator('[data-theme-toggle]').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  s = await state(page)
  if (s.theme !== null || s.stored !== null || s.pressed !== 'false') report(`pressing back onto the light system did not clear the choice: ${JSON.stringify(s)}`)
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
  if ((await state(page)).pressed !== 'true') report('Space did not press the toggle')
})
await visit('/', desktop, async (page, report) => {
  interactions++
  const toggle = page.locator('[data-theme-toggle]')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') report('on a dark system the toggle does not start pressed')
  await toggle.click()
  await page.waitForTimeout(600)
  let s = await state(page)
  if (s.theme !== 'light' || s.stored !== 'light') report(`pressing on a dark system did not store Light: ${JSON.stringify(s)}`)
  await toggle.click()
  await page.waitForTimeout(600)
  s = await state(page)
  if (s.theme !== null || s.stored !== null) report(`pressing back onto the dark system did not clear the choice: ${JSON.stringify(s)}`)
}, 'dark')
{
  // reduced motion: no view transition
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  await context.addInitScript(countTransitions)
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.locator('[data-theme-toggle]').click()
  interactions++
  const s = await state(page)
  if (s.vt !== 0 || s.theme !== 'dark') problems.push(`/ [reduced motion]: the switch ran a view transition (${s.vt}) or did not switch (${s.theme})`)
  await context.close()
}
await visit('/', desktop, async (page, report) => {
  interactions++
  // storage blocked: the toggle still changes the page for this visit
  await page.evaluate(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } }) })
  await page.locator('[data-theme-toggle]').click()
  await page.waitForTimeout(600)
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'light') report('with storage blocked, the toggle did not switch to Light')
}, 'dark')

// Each theme has its own landscape and downloads only that one: the day picture in light, the moonlit one in
// dark; the phone's inspector screen follows the theme too.
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: desktop, colorScheme: scheme })
  const page = await context.newPage()
  const pictures = []
  page.on('request', (r) => { if (/\/hero\/landscape/.test(r.url())) pictures.push(new URL(r.url()).pathname) })
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const want = scheme === 'dark' ? '/hero/landscape-night.webp' : '/hero/landscape.webp'
  const got = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector('.panel')).backgroundImage,
    screen: getComputedStyle(document.querySelector('.phone .screen')).color,
  }))
  if (!got.panel.includes(want)) problems.push(`/ [${scheme}]: the panel shows ${got.panel}, not ${want}`)
  if ([...new Set(pictures)].join() !== want) problems.push(`/ [${scheme}]: downloaded ${[...new Set(pictures)].join(', ') || 'no landscape'}, want only ${want}`)
  const light = got.screen === 'rgb(17, 24, 39)'
  if (light !== (scheme === 'light')) problems.push(`/ [${scheme}]: the phone screen's ink is ${got.screen}; it does not follow the theme`)
  await context.close()
}

// The hero's story card: the arrows step through three stories (wrapping both ways), only the shown one is
// reachable (the others are inert and hidden from assistive tech), and the live region names it. The
// script is a hashed inline module, so this also proves the hash in _headers is the one that runs.
for (const viewport of [desktop, phone]) {
  await visit('/', viewport, async (page, report) => {
    interactions++
    const story = () =>
      page.evaluate(() => {
        const card = document.querySelector('[data-story]')
        const slides = [...card.querySelectorAll('[data-slide]')]
        return {
          on: slides.findIndex((s) => s.classList.contains('on')),
          inert: slides.map((s) => s.inert),
          hidden: slides.map((s) => s.getAttribute('aria-hidden')),
          live: card.querySelector('[data-live]').textContent,
        }
      })
    const start = await story()
    if (start.on !== 0 || start.inert.join() !== 'false,true,true') report(`the story card does not start on story 1: ${JSON.stringify(start)}`)
    await page.locator('[data-story] [data-step="1"]').click()
    await page.waitForTimeout(200)
    let s = await story()
    if (s.on !== 1 || s.inert.join() !== 'true,false,true' || s.hidden.join() !== 'true,,true' || !/Story 2 of 3/.test(s.live))
      report(`Next did not show story 2: ${JSON.stringify(s)}`)
    await page.locator('[data-story] [data-step="-1"]').click()
    await page.locator('[data-story] [data-step="-1"]').click()
    await page.waitForTimeout(200)
    s = await story()
    if (s.on !== 2 || !/Story 3 of 3/.test(s.live)) report(`Previous from story 1 did not wrap to story 3: ${JSON.stringify(s)}`)
    await page.locator('[data-story] [data-step="1"]').focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    s = await story()
    if (s.on !== 0) report(`Enter on Next did not wrap to story 1: ${JSON.stringify(s)}`)
  })
}

// The capabilities statement lights up word by word, once: dimmed ("armed") while below the fold, lit when it
// scrolls into view, and never dimmed at all under reduced motion. It is real text the whole time.
{
  const context = await browser.newContext({ viewport: desktop })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const before = await page.evaluate(() => document.querySelector('[data-reveal]').dataset.reveal)
  await page.locator('[data-reveal]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(1200)
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-reveal]')
    const words = [...el.querySelectorAll('.w')]
    return { state: el.dataset.reveal, first: getComputedStyle(words[0]).color, last: getComputedStyle(words.at(-1)).color, text: el.textContent.trim().slice(0, 30) }
  })
  if (before !== 'armed') problems.push(`/ [statement]: not armed below the fold (data-reveal=${before})`)
  if (after.state !== 'lit' || after.first !== after.last) problems.push(`/ [statement]: did not light up fully once on screen: ${JSON.stringify(after)}`)
  if (!/^Your background jobs/.test(after.text)) problems.push(`/ [statement]: the text is not there as text: ${after.text}`)
  await context.close()
  const still = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  await quiet.goto(origin + '/', { waitUntil: 'networkidle' })
  const s = await quiet.evaluate(() => document.querySelector('[data-reveal]').dataset.reveal)
  if (s !== '') problems.push(`/ [statement, reduced motion]: it was dimmed for a reveal (data-reveal=${s})`)
  await still.close()
}

// The capabilities section's entrance plays once and finishes: armed below the fold, 'done' soon after it is
// on screen with every piece visible and nothing left running; hovering a card replays its beat and ends. Under
// reduced motion nothing is armed.
{
  const context = await browser.newContext({ viewport: desktop })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const play = () => page.evaluate(() => document.querySelector('[data-caps]').dataset.play ?? null)
  const armed = await play()
  await page.locator('[data-caps]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500)
  const done = await play()
  const shown = await page.evaluate(() => ['.caps .ui', '.caps .row', '.caps .pill', '.caps .figure', '.caps .what'].every((q) => [...document.querySelectorAll(q)].every((e) => getComputedStyle(e).opacity === '1')))
  await page.locator('.caps .stat').hover()
  await page.waitForTimeout(100)
  const replaying = await page.evaluate(() => document.querySelector('.caps .stat').dataset.replay ?? null)
  await page.waitForTimeout(1000)
  const after = await page.evaluate(() => ({ replay: document.querySelector('.caps .stat').dataset.replay ?? null, running: document.getAnimations().filter((a) => a.playState === 'running' && a.animationName !== 'proof-marquee').length }))
  if (armed !== 'armed' || done !== 'done' || !shown) problems.push(`/ [capabilities]: entrance did not play through: ${JSON.stringify({ armed, done, shown })}`)
  if (replaying !== 'on' || after.replay !== null || after.running) problems.push(`/ [capabilities]: hover replay did not play and end: ${JSON.stringify({ replaying, ...after })}`)
  await context.close()
  const still = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  await quiet.goto(origin + '/', { waitUntil: 'networkidle' })
  const q = await quiet.evaluate(() => document.querySelector('[data-caps]').dataset.play ?? null)
  if (q !== null) problems.push(`/ [capabilities, reduced motion]: the entrance was armed (${q})`)
  await still.close()
}

// The use cases: four cards whose diagrams play an entrance once (nodes in, lines drawn, packets travelling,
// steps ticked), then loop: every 3.2 s each card replays its packet beat, but only while the section is on
// screen (the timer stops off screen) and never the card under the pointer. Every beat is a finite animation:
// nothing runs forever. Under reduced motion nothing is armed, hidden or looping.
{
  const context = await browser.newContext({ viewport: desktop })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const play = () => page.evaluate(() => document.querySelector('.uses').dataset.play ?? null)
  const replays = () => page.evaluate(() => [...document.querySelectorAll('.uses .case')].map((c) => (c.dataset.replay ? 1 : 0)).join(''))
  const armed = await play()
  await page.locator('.uses .grid').scrollIntoViewIfNeeded()
  await page.mouse.move(2, 2)
  await page.waitForTimeout(2900)
  const end = await page.evaluate(() => ({
    play: document.querySelector('.uses').dataset.play,
    cards: document.querySelectorAll('.uses .case').length,
    hidden: [...document.querySelectorAll('.uses .node, .uses .edge .line, .uses .spec, .uses .list, .uses .journal')].filter((e) => getComputedStyle(e).opacity !== '1').length,
  }))
  if (armed !== 'armed' || end.play !== 'done' || end.cards !== 4 || end.hidden) problems.push(`/ [use cases]: entrance did not finish cleanly: ${JSON.stringify({ armed, ...end })}`)
  // the first loop beat comes 1.2 s after the entrance, then every 3.2 s, on every card
  let looped = ''
  for (let i = 0; i < 30 && looped !== '1111'; i++) { await page.waitForTimeout(100); looped = await replays() }
  if (looped !== '1111') problems.push(`/ [use cases]: the loop did not replay every card (${looped})`)
  const forever = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.animationName !== 'proof-marquee').length)
  if (forever) problems.push(`/ [use cases]: ${forever} animation(s) run forever`)
  // the hovered card holds still through the next beat while the others replay
  await page.waitForTimeout(2000)
  await page.locator('.uses .case').nth(1).hover()
  let seen = ''
  for (let i = 0; i < 40 && !/^1.11$/.test(seen); i++) { await page.waitForTimeout(100); seen = await replays() }
  if (!/^1.11$/.test(seen) || seen[1] !== '0') {
    // the hover itself may replay the card once; what matters is that the loop's beat leaves it alone
    const later = await (async () => { let s = ''; for (let i = 0; i < 40 && s !== '1011'; i++) { await page.waitForTimeout(100); s = await replays() } return s })()
    if (later !== '1011') problems.push(`/ [use cases]: the loop did not leave the hovered card still (${seen}, then ${later})`)
  }
  // off screen, the loop stops: no beat while the section is out of view
  await page.mouse.move(2, 2)
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(2200)
  let offBeat = false
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(100); if ((await replays()) !== '0000') offBeat = true }
  if (offBeat) problems.push('/ [use cases]: the loop kept beating while the section was off screen')
  await context.close()
  const still = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  await quiet.goto(origin + '/', { waitUntil: 'networkidle' })
  await quiet.locator('.uses .grid').scrollIntoViewIfNeeded()
  await quiet.waitForTimeout(4600)
  const q = await quiet.evaluate(() => ({ play: document.querySelector('.uses').dataset.play ?? null, hidden: [...document.querySelectorAll('.uses .node, .uses .spec')].filter((e) => getComputedStyle(e).opacity !== '1').length, replay: document.querySelectorAll('.uses [data-replay]').length }))
  if (q.play !== null || q.hidden || q.replay) problems.push(`/ [use cases, reduced motion]: ${JSON.stringify(q)}`)
  await still.close()
}

// The inspector section: an exclusive accordion (one feature open at a time, no script needed for that) whose
// open feature picks the phone's screen; the keyboard opens features too. The footer's links are all there.
{
  const context = await browser.newContext({ viewport: desktop })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const state = () => page.evaluate(() => ({
    open: [...document.querySelectorAll('.insp details')].map((d) => d.open).join(),
    pane: [...document.querySelectorAll('.insp [data-pane]')].findIndex((e) => e.classList.contains('on')),
  }))
  const first = await state()
  await page.locator('.insp summary').nth(2).click()
  await page.waitForTimeout(250)
  const clicked = await state()
  await page.locator('.insp summary').nth(3).focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)
  const keyed = await state()
  if (first.open !== 'true,false,false,false' || first.pane !== 0) problems.push(`/ [inspector]: does not start on the first feature: ${JSON.stringify(first)}`)
  if (clicked.open !== 'false,false,true,false' || clicked.pane !== 2) problems.push(`/ [inspector]: a click did not switch feature and screen: ${JSON.stringify(clicked)}`)
  if (keyed.open !== 'false,false,false,true' || keyed.pane !== 3) problems.push(`/ [inspector]: Enter did not switch feature and screen: ${JSON.stringify(keyed)}`)
  const foot = await page.evaluate(() => ({ links: document.querySelectorAll('footer a').length, social: [...document.querySelectorAll('footer .social a')].map((a) => a.getAttribute('aria-label')) }))
  if (foot.links < 10 || foot.social.length !== 3 || foot.social.some((l) => !l)) problems.push(`/ [footer]: links or labels missing: ${JSON.stringify(foot)}`)
  await context.close()
}

// The pricing section: the nav anchor exists, the entrance plays once and finishes (armed → done, both
// plans visible), and each plan's claim resolves — self-hosted to the docs quick start, the cloud plan to
// the repository; nothing links to a sign-up (there is no app). Checked in light and dark, and the card
// colour follows the theme.
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: desktop, colorScheme: scheme })
  await context.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} (${e.sourceFile || 'page'}:${e.lineNumber})`),
    )
  })
  const page = await context.newPage()
  const report = (what) => problems.push(`/ [pricing ${scheme}]: ${what}`)
  page.on('pageerror', (e) => report(`page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && report(`console error: ${m.text()}`))
  page.on('requestfailed', (r) => report(`request failed: ${r.url()} (${r.failure()?.errorText})`))
  page.on('response', (r) => r.status() >= 400 && report(`HTTP ${r.status()} for ${r.url()}`))
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const armed = await page.evaluate(() => document.querySelector('#pricing').dataset.play ?? null)
  await page.locator('#pricing').scrollIntoViewIfNeeded()
  await page.waitForTimeout(1700)
  const s = await page.evaluate(() => {
    const section = document.querySelector('#pricing')
    return {
      csp: window.__csp,
      play: section.dataset.play ?? null,
      plans: section.querySelectorAll('.plan').length,
      shown: [...section.querySelectorAll('.plan, .soon')].every((e) => getComputedStyle(e).opacity === '1'),
      links: [...section.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      card: getComputedStyle(section.querySelector('.plan')).backgroundColor,
      running: section.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    }
  })
  for (const v of s.csp) report(`CSP violation: ${v}`)
  if (armed !== 'armed' || s.play !== 'done' || s.plans !== 2 || !s.shown) {
    report(`the entrance did not play through: ${JSON.stringify({ armed, play: s.play, plans: s.plans, shown: s.shown })}`)
  }
  if (!s.links.some((h) => /\/quick-start\/?$/.test(h ?? ''))) report('no plan links to the docs quick start')
  if (!s.links.includes('https://github.com/akira-shirase-oss/durable-runner')) report('the cloud plan does not link to the repository')
  const app = s.links.find((h) => /sign-?up|register|log-?in|sign-?in|checkout|billing|subscribe|app\./i.test(h ?? ''))
  if (app) report(`a plan links to a sign-up or app address: ${app}`)
  const want = scheme === 'dark' ? 'rgb(22, 24, 27)' : 'rgb(255, 255, 255)'
  if (s.card !== want) report(`the plan card is ${s.card}, not the ${scheme} card ${want}`)
  if (s.running) report(`${s.running} animation(s) still running after the entrance`)
  // the nav anchor lands on the section
  await page.goto(origin + '/#pricing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(200)
  const near = await page.evaluate(() => {
    const r = document.querySelector('#pricing').getBoundingClientRect()
    return r.top < innerHeight && r.bottom > 0
  })
  if (!near) report('/#pricing did not bring the section into view')
  await context.close()
}
// At phone width the plans stack and nothing scrolls sideways.
await visit('/', phone, async (page, report) => {
  interactions++
  await page.locator('#pricing').scrollIntoViewIfNeeded()
  const m = await page.evaluate(() => {
    const tops = [...document.querySelectorAll('#pricing .plan')].map((e) => Math.round(e.getBoundingClientRect().top))
    return { scroll: document.scrollingElement.scrollWidth, width: innerWidth, tops }
  })
  if (m.scroll > m.width) report(`the page scrolls sideways at 390px (${m.scroll}px of content)`)
  if (!(m.tops.length === 2 && m.tops[1] > m.tops[0])) report(`the two plans do not stack at 390px (tops ${m.tops})`)
})

// The legal drafts live outside src/pages (drafts/legal/), so nothing serves them — check-dist proves
// the token never ships; there is no draft page to visit here.

// Crash-case micro-interactions: hovering a case plays its act-out exactly once (a finite animation) and
// shows the survived check; reduced motion keeps the check but plays nothing.
for (const reducedMotion of ['no-preference', 'reduce']) {
  const context = await browser.newContext({ viewport: desktop, reducedMotion })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  // the strip moves; resting the pointer on it pauses it, then the visible "Lost replies" can be hovered
  await page.locator('.proof .marquee').scrollIntoViewIfNeeded()
  const strip = await page.locator('.proof .marquee').boundingBox()
  await page.mouse.move(strip.x + 10, strip.y + strip.height / 2)
  await page.waitForTimeout(150)
  const target = await page.evaluate((s) => {
    const r = [...document.querySelectorAll('.mark.unplug')].map((e) => e.getBoundingClientRect()).find((r) => r.left > s.x + 150 && r.right < s.x + s.width - 150)
    return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, strip)
  await page.mouse.move(target.x, target.y, { steps: 4 })
  await page.waitForTimeout(60)
  const played = await page.evaluate(() => document.getAnimations().filter((a) => a.animationName === 'act-unplug').map((a) => a.effect.getComputedTiming().iterations))
  await page.waitForTimeout(500)
  const ok = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.mark.unplug .ok')].map((e) => Number(getComputedStyle(e).opacity))).toString())
  const label = reducedMotion === 'reduce' ? 'reduced motion' : 'motion'
  if (reducedMotion === 'reduce' ? played.length !== 0 : played.join() !== '1') problems.push(`/ [crash cases, ${label}]: hover played ${JSON.stringify(played)}`)
  if (ok !== '1') problems.push(`/ [crash cases, ${label}]: the survived check did not show on hover (opacity ${ok})`)
  await context.close()
}

// The phone menu is a native <details>: it opens without any script and lists every header link.
await visit('/', phone, async (page, report) => {
  interactions++
  await page.locator('header details summary').click()
  const menu = await page.evaluate(() => {
    const d = document.querySelector('header details')
    return { open: d.open, links: [...d.querySelectorAll('a')].map((a) => a.textContent.trim()) }
  })
  if (!menu.open || menu.links.length < 6 || !menu.links.includes('Get started')) report(`the phone menu did not open with every link: ${JSON.stringify(menu)}`)
})

// Masks are cheap on an icon and expensive over a large area: no element bigger than 48px may be masked or
// clipped by an SVG mask.
for (const viewport of [desktop, phone]) {
  await visit('/', viewport, async (page, report) => {
    interactions++
    const masked = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((e) => {
          const s = getComputedStyle(e)
          const css = (s.maskImage && s.maskImage !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none')
          const svg = e.getAttribute('mask') || (s.mask && s.mask !== 'none' && /url\(/.test(s.mask))
          if (!css && !svg) return false
          const r = e.getBoundingClientRect()
          return r.width > 48 || r.height > 48
        })
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className).split(' ')[0]} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
    )
    for (const m of masked) report(`a mask over a large element (${m})`)
  })
}

// The header's one action goes to the docs' quick start (the product is self-hosted: no account buttons),
// and nothing shifts after the first paint (CLS 0).
{
  const context = await browser.newContext({ viewport: desktop })
  await context.addInitScript(() => {
    window.__csp = []
    window.__cls = 0
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective))
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value }).observe({ type: 'layout-shift', buffered: true })
  })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  interactions++
  const header = await page.evaluate(() => ({
    auth: document.querySelectorAll('[data-auth]').length,
    start: [...document.querySelectorAll('header a')].find((a) => /Get started/.test(a.textContent))?.getAttribute('href') ?? null,
  }))
  if (header.auth || !/\/quick-start\/$/.test(header.start ?? '')) problems.push(`/ [header]: expected Get started → the quick start and no account buttons: ${JSON.stringify(header)}`)
  const { csp, cls } = await page.evaluate(() => ({ csp: window.__csp.length, cls: window.__cls }))
  if (cls > 0) problems.push(`/ [header]: the page shifted (CLS ${cls.toFixed(4)})`)
  if (csp) problems.push(`/ [header]: ${csp} CSP violation(s)`)
  await context.close()
}

// Nothing moves on its own: the hero stays where it is when the pointer moves, and no animation runs forever.
await visit('/', desktop, async (page, report) => {
  interactions++
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('.phone, [data-story], h1')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}` }).join(' '))
  const at = await boxes()
  await page.mouse.move(40, 200)
  await page.mouse.move(1300, 700, { steps: 10 })
  await page.waitForTimeout(300)
  if ((await boxes()) !== at) report('the hero moved with the pointer')
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.animationName !== 'proof-marquee').length)
  if (running) report(`${running} animation(s) run forever`)
})

// The crash-case marquee, the page's one endless animation, and its guards: paused until on screen, moving
// while on screen, paused under the pointer and by its button (which says so), paused again off screen, and
// absent under reduced motion. The list is in the page as text.
{
  const context = await browser.newContext({ viewport: desktop })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const play = () => page.evaluate(() => document.getAnimations().filter((a) => a.animationName === 'proof-marquee').map((a) => a.playState).join())
  const x = () => page.evaluate(() => Math.round(document.querySelector('.proof .track').getBoundingClientRect().left))
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(300)
  const offscreen = await play()
  await page.locator('.proof').scrollIntoViewIfNeeded()
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
  const x0 = await x()
  await page.waitForTimeout(1200)
  const moved = x0 - (await x())
  const strip = await page.locator('.proof .marquee').boundingBox()
  await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2)
  await page.waitForTimeout(200)
  const hovered = await play()
  await page.mouse.move(2, 2)
  await page.locator('[data-marquee-toggle]').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const button = await page.evaluate(() => document.querySelector('[data-marquee-toggle]').getAttribute('aria-pressed'))
  const pausedByButton = await play()
  const text = await page.evaluate(() => document.querySelector('.proof .sr-only')?.textContent ?? '')
  if (offscreen !== 'paused' || !(moved > 10) || hovered !== 'paused' || button !== 'true' || pausedByButton !== 'paused' || !/kill -9/.test(text))
    problems.push(`/ [marquee]: guards failed: ${JSON.stringify({ offscreen, moved, hovered, button, pausedByButton, text: text.slice(0, 40) })}`)
  await context.close()
  const still = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  await quiet.goto(origin + '/', { waitUntil: 'networkidle' })
  await quiet.locator('.proof').scrollIntoViewIfNeeded()
  await quiet.waitForTimeout(300)
  const q = await quiet.evaluate(() => document.getAnimations().filter((a) => a.animationName === 'proof-marquee').length)
  if (q) problems.push('/ [marquee, reduced motion]: the strip still has its animation')
  await still.close()
}

// The font actually drawn (Chromium's own record of the platform font per node): everything in the
// Google Sans Flex web font, never a local fallback.
for (const path of ['/']) {
  await visit(path, desktop, async (page, report) => {
    interactions++
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const want = [
      ['main h1 .line', 'Google Sans Flex'],
      ['main p', 'Google Sans Flex'],
      ['nav a', 'Google Sans Flex'],
      ['main h2', 'Google Sans Flex'],
    ]
    for (const [selector, family] of want) {
      // the first match that holds text of its own (Chromium reports only a node's direct text)
      const found = await page.evaluate((selector) => {
        const el = [...document.querySelectorAll(selector)].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        if (el) el.setAttribute('data-font-probe', '')
        return !!el
      }, selector)
      if (!found) { report(`${selector}: nothing to measure`); continue }
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${selector}[data-font-probe]` })
      if (!nodeId) continue
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      const main = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0]
      await page.evaluate(() => document.querySelectorAll('[data-font-probe]').forEach((e) => e.removeAttribute('data-font-probe')))
      if (!main || !main.familyName.startsWith('Google Sans Flex') || !main.isCustomFont) report(`${selector} is drawn in ${main ? `${main.familyName}${main.isCustomFont ? '' : ' (local)'}` : 'nothing'}, not the ${family} web font`)
    }
  })
}

// No page scrolls sideways at any width, and the header and the hero share one content column.
for (const viewport of [desktop, { width: 1024, height: 768 }, { width: 820, height: 1180 }, phone, { width: 360, height: 780 }]) {
  await visit('/', viewport, async (page, report) => {
    interactions++
    const m = await page.evaluate(() => ({
      scroll: document.scrollingElement.scrollWidth,
      width: innerWidth,
      lefts: [document.querySelector('header > div'), document.querySelector('.hero > div')].map((e) => Math.round(e.getBoundingClientRect().left)),
    }))
    if (m.scroll > m.width) report(`the page scrolls sideways (${m.scroll}px of content in ${m.width}px)`)
    if (m.lefts[0] !== m.lefts[1]) report(`the header and the hero start at different x: ${m.lefts.join(', ')}`)
  })
}

await browser.close()
server.close()

const label = mutate ? ' (mutated: script hashes removed)' : ''
if (problems.length) {
  console.error(`check-csp-browser${label}: ${problems.length} problem(s) on ${pages.length} pages\n`)
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`)
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`)
  process.exit(1)
}
console.log(`check-csp-browser${label}: ${pages.length} pages in light and dark + 1 phone view in Chromium ${version}, ` +
  `no CSP violations, errors or broken assets; ${interactions} scripted interactions worked`)
