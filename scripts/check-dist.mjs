// Checks the built site before it ships. Run after `npm run build`:
//
//   node scripts/check-dist.mjs [dir]     (dir defaults to dist/)
//
// headers  dist/_headers sends the security headers, and its Content-Security-Policy allows exactly
//          what the built pages use: a hash for every inline script and no stale ones, same-origin
//          images, fonts and stylesheets, no inline event handlers.
// leaks    nothing private ships: no source maps, env or git files, dev-server paths, local paths,
//          the build user's name or home directory, names listed in LEAK_SCAN_NAMES (comma-separated,
//          kept out of the repo), or credential-shaped strings.
// drafts   no `draft: true` post is built, linked, or named in the feed or sitemap.
// links    every target="_blank" link carries rel="noopener" or rel="noreferrer", and every link,
//          image, script and stylesheet on the site's own origin resolves to a built file (and its
//          #fragment to an id on that page).
// seo      each page has one non-empty, unique <title> and meta description, one <h1>, a canonical
//          URL that is its own address (or robots noindex instead), Open Graph and Twitter card tags
//          with an image and its alt text, and alt on every <img>; each post has BlogPosting data with
//          its dates and author; the sitemap lists exactly the indexable pages and the feed every post.
// jsonld   every JSON-LD block is valid JSON with no "<" in it, so its data can't end the script
//          (`</script>`) or swallow the rest of the page (`<!--`).
// code     every highlighted code block is coloured through the theme variables (--shiki-light and
//          --shiki-dark), never a fixed colour; every token reaches WCAG AA (4.5:1) on the light code
//          surface (--c-surface) and 4.8:1 on the dark one.
// light    the page stays still unless someone acts: no backdrop-filter (a blurred sticky layer re-blurs on
//          every frame), no animation that repeats forever, and no script listening to pointer or mouse moves,
//          scroll, wheel or touch moves. One-time effects (the title and wordmark print, the theme toggle's view
//          transition on click) are fine.
// app      Durable Runner is self-hosted — there is no hosted app or account area, so no page links to one
// fonts    the site uses exactly one webfont: every @font-face is Google Sans Flex, every font file built is
//          its one woff2 file, and nothing links to or preloads any other font.
// redirects dist/_redirects matches public/_redirects; every rule is a permanent redirect from a plain
//          path that is no longer built to a built page, never to another rule's source; a retired post
//          address has a rule for both spellings (with and without the trailing slash); and no page, the
//          sitemap or the feed still links to a retired address.
//
// Exits 1 and lists every failure, or prints one line per check that passed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(process.argv[2] ?? join(root, 'dist'))
const site = 'https://durable-runner.404human.dev'

const failures = []
const fail = (check, message) => failures.push(`[${check}] ${message}`)

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No build at ${dist}. Run npm run build first.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// The built files

const files = (function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
})(dist)
const rel = (file) => relative(dist, file)
const html = files.filter((f) => extname(f) === '.html').map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }))
const css = files.filter((f) => extname(f) === '.css').map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }))

// ---------------------------------------------------------------------------------------------
// A small HTML reader: enough for Astro's output, not a general parser.

/**
 * Every element in document order as { name, attrs, body? }. A start tag is matched whole, quoted
 * attribute values included, so markup inside an attribute (`content="</script>"`) is never mistaken
 * for a tag. <script> and <style> carry their raw text in `body`, exactly what a browser hashes.
 * Comments are skipped: nothing in them runs or loads.
 */
function elementsOf(text) {
  const out = []
  const tag = /<!--[\s\S]*?(?:-->|$)|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g
  for (let m; (m = tag.exec(text)); ) {
    if (!m[1]) continue
    const name = m[1].toLowerCase()
    const element = { name, attrs: attributes(m[2]) }
    if (name === 'script' || name === 'style') {
      const close = new RegExp(`</${name}[\\s/>]`, 'ig')
      close.lastIndex = tag.lastIndex
      const end = close.exec(text)
      element.body = text.slice(tag.lastIndex, end ? end.index : text.length)
      tag.lastIndex = end ? text.indexOf('>', end.index) + 1 || text.length : text.length
    }
    out.push(element)
  }
  return out
}
const scriptsOf = (text) => elementsOf(text).filter((e) => e.name === 'script')
const stylesOf = (text) => elementsOf(text).filter((e) => e.name === 'style').map((e) => e.body)
const tagsOf = elementsOf

function attributes(source) {
  const attrs = new Map()
  for (const m of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase()
    if (!attrs.has(name)) attrs.set(name, decode(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return attrs
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

/** Script types a browser runs, and so the CSP governs. Anything else (JSON-LD) is a data block. */
const JS_TYPES = new Set(['', 'module', 'importmap', 'speculationrules', 'text/javascript', 'application/javascript'])
const runs = (script) => JS_TYPES.has((script.attrs.get('type') ?? '').trim().toLowerCase())

/** Relative URLs and the site's own origin are same-origin; everything else is not. */
const sameOrigin = (url) => {
  const u = url.trim()
  if (u === '' || u.startsWith('#')) return true
  if (u.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u === site || u.startsWith(`${site}/`)
  return true
}

// ---------------------------------------------------------------------------------------------
// headers: dist/_headers

function checkHeaders() {
  const path = join(dist, '_headers')
  if (!existsSync(path)) {
    fail('headers', 'dist/_headers is missing: put the security headers in public/_headers')
    return
  }
  const text = readFileSync(path, 'utf8')
  const source = join(root, 'public', '_headers')
  if (existsSync(source) && readFileSync(source, 'utf8') !== text) {
    fail('headers', 'dist/_headers differs from public/_headers: rebuild')
  }

  // Cloudflare Pages syntax: an unindented path line, then indented `Name: value` lines.
  // Limits: 100 rules, 2,000 characters a line (https://developers.cloudflare.com/pages/configuration/headers/).
  const rules = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > 2000) fail('headers', `_headers line ${i + 1} is ${line.length} characters; Cloudflare's limit is 2,000`)
    const t = line.trim()
    if (t === '' || t.startsWith('#')) return
    if (!/^\s/.test(line)) return void rules.push({ path: t, headers: [] })
    const m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(t)
    if (!rules.length || !m) return void fail('headers', `_headers line ${i + 1} is not a header line: ${t}`)
    rules.at(-1).headers.push([m[1].toLowerCase(), m[2].trim()])
  })
  if (rules.length > 100) fail('headers', `_headers has ${rules.length} rules; Cloudflare's limit is 100`)

  // Pages joins a header set by two matching rules with a comma, which for a CSP means two policies.
  const cspRules = rules.filter((r) => r.headers.some(([n]) => n === 'content-security-policy'))
  if (cspRules.length > 1) fail('headers', 'Content-Security-Policy is set by more than one rule')

  const all = rules.find((r) => r.path === '/*')
  if (!all) return void fail('headers', 'no `/*` rule, so some responses would go out without the headers')
  const get = (name) => {
    const values = all.headers.filter(([n]) => n === name).map(([, v]) => v)
    if (values.length > 1) fail('headers', `${name} is set twice in the /* rule`)
    return values[0]
  }

  const expect = (name, ok, want) => {
    const value = get(name)
    if (value === undefined) fail('headers', `missing ${name} (want ${want})`)
    else if (!ok(value)) fail('headers', `${name}: ${value} (want ${want})`)
  }
  expect('x-content-type-options', (v) => v === 'nosniff', 'nosniff')
  expect('x-frame-options', (v) => v === 'DENY', 'DENY')
  expect(
    'strict-transport-security',
    (v) => Number(/max-age=(\d+)/.exec(v)?.[1] ?? 0) >= 31536000,
    'max-age of at least a year',
  )
  expect(
    'referrer-policy',
    (v) => ['strict-origin-when-cross-origin', 'strict-origin', 'same-origin', 'no-referrer'].includes(v),
    'strict-origin-when-cross-origin or stricter',
  )
  expect('permissions-policy', (v) => /camera=\(\)/.test(v) && /microphone=\(\)/.test(v), 'camera=(), microphone=() at least')
  expect('cross-origin-opener-policy', (v) => v === 'same-origin', 'same-origin')

  const csp = get('content-security-policy')
  if (csp === undefined) return void fail('headers', 'missing Content-Security-Policy')
  checkPolicy(csp)
}

function checkPolicy(csp) {
  const policy = new Map()
  for (const part of csp.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/)
    if (policy.has(name.toLowerCase())) fail('csp', `${name} appears twice; browsers ignore the second`)
    else policy.set(name.toLowerCase(), sources)
  }
  const is = (name, want) => {
    const got = policy.get(name)?.join(' ')
    if (got !== want) fail('csp', `${name} is ${got === undefined ? 'missing' : `"${got}"`} (want "${want}")`)
  }
  is('default-src', "'none'")
  is('base-uri', "'none'")
  is('form-action', "'none'")
  is('frame-ancestors', "'none'")
  if (policy.has('object-src')) is('object-src', "'none'")

  // script-src: same-origin files and hashed inline scripts, nothing else.
  const scriptSrc = policy.get('script-src')
  if (!scriptSrc) return void fail('csp', "missing script-src (want 'self' plus hashes)")
  for (const s of scriptSrc) {
    if (s !== "'self'" && !/^'sha(256|384|512)-[A-Za-z0-9+/]+={0,2}'$/.test(s)) {
      fail('csp', `script-src allows ${s}; only 'self' and hashes are allowed`)
    }
  }
  const allowed = new Set(scriptSrc.filter((s) => s.startsWith("'sha")))
  const needed = new Map()
  for (const page of html) {
    for (const script of scriptsOf(page.text)) {
      if (script.attrs.has('src')) {
        if (!sameOrigin(script.attrs.get('src'))) fail('csp', `${page.file} loads a script from ${script.attrs.get('src')}`)
      } else if (runs(script)) {
        const hash = sha256(script.body)
        if (!needed.has(hash)) needed.set(hash, { page: page.file, excerpt: script.body.trim().slice(0, 70) })
      }
    }
  }
  for (const [hash, { page, excerpt }] of needed) {
    if (!allowed.has(hash)) fail('csp', `inline script in ${page} is not allowed; review it, then add ${hash} to script-src: ${excerpt}…`)
  }
  for (const hash of allowed) {
    if (!needed.has(hash)) fail('csp', `script-src allows ${hash}, which no page uses: remove it`)
  }

  // style-src: Shiki's code colours are style attributes and Astro inlines small stylesheets, so
  // inline styles need 'unsafe-inline'. A hash or nonce next to it would make browsers ignore it.
  const styleSrc = policy.get('style-src') ?? []
  const inlineStyles = html.some((p) => stylesOf(p.text).length > 0 || tagsOf(p.text).some((t) => t.attrs.has('style')))
  if (!styleSrc.includes("'self'")) fail('csp', "style-src lacks 'self', so /_astro/*.css would be blocked")
  if (inlineStyles && !styleSrc.includes("'unsafe-inline'")) fail('csp', "the pages use inline styles, but style-src lacks 'unsafe-inline'")
  if (styleSrc.some((s) => /^'(sha\d+|nonce)-/.test(s))) fail('csp', "style-src has a hash or nonce, which disables its 'unsafe-inline'")
  for (const name of ['img-src', 'font-src']) {
    const sources = policy.get(name) ?? []
    if (!sources.includes("'self'")) fail('csp', `${name} lacks 'self', so the self-hosted files would be blocked`)
    for (const s of sources) if (s !== "'self'") fail('csp', `${name} allows ${s}; the site only loads its own files`)
  }

  // What the policy would block or can't express, page by page.
  for (const page of html) {
    for (const tag of tagsOf(page.text)) {
      for (const [name, value] of tag.attrs) {
        if (/^on[a-z]+$/.test(name)) fail('csp', `${page.file}: <${tag.name} ${name}> is an inline handler, which script-src blocks`)
        if (/^\s*javascript:/i.test(value)) fail('csp', `${page.file}: <${tag.name} ${name}="javascript:…">, which script-src blocks`)
      }
      if (['iframe', 'frame', 'object', 'embed'].includes(tag.name)) fail('csp', `${page.file}: <${tag.name}>, which default-src 'none' blocks`)
      if (tag.name === 'form') fail('csp', `${page.file}: a <form>, which form-action 'none' blocks`)
      const urls = []
      if (['img', 'source', 'video', 'audio', 'track'].includes(tag.name)) {
        if (tag.attrs.has('src')) urls.push(tag.attrs.get('src'))
        if (tag.attrs.has('srcset')) urls.push(...tag.attrs.get('srcset').split(',').map((c) => c.trim().split(/\s+/)[0]))
      }
      const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/)
      if (tag.name === 'link' && rel.some((r) => ['stylesheet', 'preload', 'modulepreload', 'icon'].includes(r))) {
        urls.push(tag.attrs.get('href') ?? '')
      }
      for (const url of urls) {
        if (!sameOrigin(url)) fail('csp', `${page.file}: <${tag.name}> loads ${url} from another origin`)
      }
    }
  }
  for (const sheet of [...css, ...html.flatMap((p) => stylesOf(p.text).map((text) => ({ file: p.file, text })))]) {
    for (const m of sheet.text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)) {
      if (!sameOrigin(m[2])) fail('csp', `${sheet.file}: url(${m[2]}) is not a same-origin file`)
    }
    for (const m of sheet.text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'");\s]+)/g)) {
      if (!sameOrigin(m[1])) fail('csp', `${sheet.file}: @import ${m[1]} is not a same-origin file`)
    }
  }
  return needed.size
}

// ---------------------------------------------------------------------------------------------
// leaks: nothing private in the build

const TEXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.svg', '.webmanifest', '.map', '.md', ''])

function checkLeaks() {
  const forbiddenFiles = [
    [/\.map$/, 'a source map'],
    [/(^|\/)\.env($|\.)/, 'an env file'],
    [/(^|\/)\.git($|\/)/, 'git metadata'],
    [/(^|\/)(\.DS_Store|\.npmrc|Thumbs\.db)$/, 'a local or credentials file'],
    [/\.(log|pem|key|p12|pfx|sqlite3?|db|bak|swp)$/, 'a log, key, database or backup file'],
    [/(^|\/)node_modules\//, 'node_modules'],
    [/(^|\/)(package(-lock)?\.json|tsconfig\.json|astro\.config\.mjs)$/, 'project config'],
    [/(^|\/)src\//, 'source files'],
  ]
  for (const file of files.map(rel)) {
    for (const [pattern, what] of forbiddenFiles) if (pattern.test(file)) fail('leaks', `${file} is ${what}`)
  }

  // The build user's own name and home directory (a generic CI account name is skipped: "runner"
  // is also an English word), plus private names from the environment, never from this repo.
  const generic = new Set(['runner', 'root', 'ubuntu', 'node', 'user', 'admin', 'build', 'ci', 'vscode', 'codespace'])
  const user = userInfo().username
  const names = [
    homedir(),
    ...(user.length >= 3 && !generic.has(user.toLowerCase()) ? [user] : []),
    ...(process.env.LEAK_SCAN_NAMES ?? '').split(',').map((n) => n.trim()).filter((n) => n.length >= 3),
  ]
  const nameHits = (text) => names.filter((n) => text.toLowerCase().includes(n.toLowerCase()))

  // Checked in every file, images and fonts included: metadata can carry paths and names.
  const everywhere = [
    [/\/Users\/[^/\s"'<>]+\//, 'a macOS home path'],
    [/\/home\/[^/\s"'<>]+\//, 'a Linux home path'],
    [/[A-Za-z]:\\\\?Users\\\\?/, 'a Windows home path'],
    [/file:\/\/\//, 'a file:// URL'],
  ]
  // Checked in text files.
  const inText = [
    [/sourceMappingURL=/, 'a source map reference'],
    [/\/@fs\/|\/@vite\/|\/@id\//, 'a Vite dev-server path'],
    [/data-astro-source-(file|loc)/, 'an Astro dev annotation (it holds absolute paths)'],
    [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
    [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, 'a private key'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'a GitHub token'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/\b[rs]k_live_[A-Za-z0-9]{16,}/, 'a Stripe live key'],
    [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/, 'an OpenAI or Anthropic key'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
    [/\bnpm_[A-Za-z0-9]{36}\b/, 'an npm token'],
    [/\bdurable_api_[A-Za-z0-9_-]{16,}/, 'a Durable Runner API token'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  ]

  for (const path of files) {
    const file = rel(path)
    const bytes = readFileSync(path).toString('latin1')
    for (const [pattern, what] of everywhere) if (pattern.test(bytes)) fail('leaks', `${file} contains ${what}`)
    for (const hit of nameHits(bytes)) fail('leaks', `${file} contains a private name (${hit.length} characters, not printed)`)
    if (!TEXT.has(extname(file)) && !file.endsWith('_headers')) continue
    const text = readFileSync(path, 'utf8')
    for (const [pattern, what] of inText) if (pattern.test(text)) fail('leaks', `${file} contains ${what}`)
  }
  return names.length
}

// ---------------------------------------------------------------------------------------------
// drafts: posts marked `draft: true` never reach the build

function checkDrafts() {
  const dir = join(root, 'src', 'content', 'blog')
  if (!existsSync(dir)) return 0
  const drafts = []
  for (const name of readdirSync(dir, { recursive: true })) {
    if (!/\.mdx?$/.test(name)) continue
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, name), 'utf8'))?.[1] ?? ''
    if (!/^draft:\s*true\s*$/m.test(front)) continue
    const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2')
    drafts.push({ id: field('slug') ?? name.replace(/\.mdx?$/, '').split(sep).join('/'), title: field('title') })
  }
  const texts = files.filter((f) => TEXT.has(extname(f))).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }))
  for (const { id, title } of drafts) {
    if (existsSync(join(dist, 'blog', id))) fail('drafts', `the draft "${id}" was built at blog/${id}/`)
    for (const { file, text } of texts) {
      if (text.includes(`/blog/${id}`)) fail('drafts', `${file} links to the draft "${id}"`)
      const escaped = title?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      if (title && (text.includes(title) || text.includes(escaped))) fail('drafts', `${file} names the draft "${title}"`)
    }
  }
  return drafts.length
}

// ---------------------------------------------------------------------------------------------
// links: new tabs never get a handle on this page

function checkLinks() {
  for (const page of html) {
    for (const tag of tagsOf(page.text)) {
      if (tag.name !== 'a' || (tag.attrs.get('target') ?? '').toLowerCase() !== '_blank') continue
      const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/)
      if (!rel.includes('noopener') && !rel.includes('noreferrer')) {
        fail('links', `${page.file}: <a target="_blank" href="${tag.attrs.get('href')}"> needs rel="noopener" or rel="noreferrer"`)
      }
    }
  }
}

/** The address a built page is served at: index.html → /, blog/x/index.html → /blog/x/. */
const urlOf = (file) => `/${file.split(sep).join('/')}`.replace(/index\.html$/, '').replace(/\.html$/, '')

/** The built file a same-origin path serves, or undefined. Cloudflare Pages serves /x/ from x/index.html. */
function fileFor(path) {
  const clean = decodeURIComponent(path).replace(/^\/+/, '')
  const candidates = clean === '' || clean.endsWith('/') ? [`${clean}index.html`] : [clean, `${clean}/index.html`, `${clean}.html`]
  return candidates.map((c) => join(dist, c)).find((c) => existsSync(c) && !c.endsWith(sep))
}

function checkInternalLinks() {
  const ids = new Map(html.map((p) => [urlOf(p.file), new Set([...p.text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]))
  let checked = 0
  for (const page of html) {
    for (const tag of tagsOf(page.text)) {
      const attr = { a: 'href', link: 'href', img: 'src', script: 'src', source: 'src' }[tag.name]
      const raw = attr && tag.attrs.get(attr)
      if (!raw || !sameOrigin(raw) || /^(mailto|tel|data):/i.test(raw)) continue
      const url = new URL(raw, `${site}${urlOf(page.file)}`)
      checked++
      const target = url.pathname === urlOf(page.file) || raw.startsWith('#') ? join(dist, page.file) : fileFor(url.pathname)
      if (!target) {
        fail('links', `${page.file}: <${tag.name} ${attr}="${raw}"> points at nothing in the build`)
        continue
      }
      const fragment = decodeURIComponent(url.hash.slice(1))
      const targetIds = ids.get(urlOf(relative(dist, target)))
      if (fragment && targetIds && !targetIds.has(fragment)) {
        fail('links', `${page.file}: <${tag.name} ${attr}="${raw}"> names #${fragment}, which that page has no id for`)
      }
    }
  }
  return checked
}

// ---------------------------------------------------------------------------------------------
// seo: every page can be found, titled, shared and described

function checkSeo() {
  const meta = (text, key, value) =>
    tagsOf(text)
      .filter((t) => t.name === 'meta' && t.attrs.get(key) === value)
      .map((t) => t.attrs.get('content') ?? '')
  const seen = { title: new Map(), description: new Map() }
  const indexable = []
  for (const page of html) {
    const tags = tagsOf(page.text)
    const titles = [...page.text.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1]).trim())
    const descriptions = meta(page.text, 'name', 'description')
    if (titles.length !== 1 || !titles[0]) fail('seo', `${page.file}: wants one non-empty <title>, has ${titles.length}`)
    if (descriptions.length !== 1 || !descriptions[0].trim()) fail('seo', `${page.file}: wants one non-empty meta description`)
    for (const [kind, value] of [['title', titles[0]], ['description', descriptions[0]]]) {
      if (!value) continue
      // Search results cut titles past about 60 characters and descriptions past about 155.
      const max = kind === 'title' ? 60 : 155
      if (value.length > max) fail('seo', `${page.file}: the ${kind} is ${value.length} characters (at most ${max})`)
      if (seen[kind].has(value)) fail('seo', `${page.file} and ${seen[kind].get(value)} share the ${kind} "${value}"`)
      else seen[kind].set(value, page.file)
    }
    const h1s = tags.filter((t) => t.name === 'h1').length
    if (h1s !== 1) fail('seo', `${page.file}: wants one <h1>, has ${h1s}`)

    const noindex = meta(page.text, 'name', 'robots').some((c) => /noindex/i.test(c))
    const canonicals = tags.filter((t) => t.name === 'link' && t.attrs.get('rel') === 'canonical').map((t) => t.attrs.get('href'))
    if (noindex) {
      if (canonicals.length) fail('seo', `${page.file}: is noindex but names a canonical URL`)
    } else {
      indexable.push(`${site}${urlOf(page.file)}`)
      if (canonicals.length !== 1 || canonicals[0] !== `${site}${urlOf(page.file)}`) {
        fail('seo', `${page.file}: canonical is ${canonicals.join(', ') || 'missing'} (want ${site}${urlOf(page.file)})`)
      }
    }
    for (const [key, name] of [
      ['property', 'og:title'],
      ['property', 'og:description'],
      ['property', 'og:image'],
      ['property', 'og:image:alt'],
      ['name', 'twitter:card'],
      ['name', 'twitter:image'],
      ['name', 'twitter:image:alt'],
    ]) {
      const values = meta(page.text, key, name)
      if (values.length !== 1 || !values[0].trim()) fail('seo', `${page.file}: wants one ${name}`)
    }
    for (const image of [...meta(page.text, 'property', 'og:image'), ...meta(page.text, 'name', 'twitter:image')]) {
      if (!image.startsWith(`${site}/`) || !fileFor(new URL(image).pathname)) fail('seo', `${page.file}: share image ${image} isn't a built file on ${site}`)
    }
    for (const img of tags.filter((t) => t.name === 'img')) {
      if (!img.attrs.has('alt')) fail('seo', `${page.file}: <img src="${img.attrs.get('src')}"> has no alt (use alt="" for decoration)`)
    }
    if (/^blog\/[^/]+\/index\.html$/.test(page.file.split(sep).join('/'))) {
      const posting = scriptsOf(page.text)
        .filter((sc) => sc.attrs.get('type') === 'application/ld+json')
        .map((sc) => { try { return JSON.parse(sc.body) } catch { return {} } })
        .find((d) => d['@type'] === 'BlogPosting')
      if (!posting) fail('seo', `${page.file}: no BlogPosting JSON-LD`)
      else for (const key of ['headline', 'datePublished', 'dateModified', 'author']) {
        if (!posting[key]) fail('seo', `${page.file}: BlogPosting has no ${key}`)
      }
    }
  }

  const xml = (name) => (existsSync(join(dist, name)) ? readFileSync(join(dist, name), 'utf8') : '')
  const locs = [...xml('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]))
  if (!locs.length) fail('seo', 'sitemap.xml is missing or lists nothing')
  for (const url of indexable) if (!locs.includes(url)) fail('seo', `sitemap.xml leaves out ${url}`)
  for (const loc of locs) if (!indexable.includes(loc)) fail('seo', `sitemap.xml lists ${loc}, which isn't an indexable page`)
  if (new Set(locs).size !== locs.length) fail('seo', 'sitemap.xml lists a page twice')

  const posts = indexable.filter((u) => /\/blog\/[^/]+\/$/.test(u))
  const items = [...xml('rss.xml').matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => decode(m[1]))
  for (const url of posts) if (!items.includes(url)) fail('seo', `rss.xml leaves out ${url}`)
  for (const url of items) if (!posts.includes(url)) fail('seo', `rss.xml has an item for ${url}, which isn't a built post`)
  return { indexable: indexable.length, posts: posts.length }
}

// ---------------------------------------------------------------------------------------------
// jsonld: structured data stays data

function checkJsonLd() {
  let blocks = 0
  for (const page of html) {
    for (const script of scriptsOf(page.text)) {
      if ((script.attrs.get('type') ?? '').trim().toLowerCase() !== 'application/ld+json') continue
      blocks++
      if (script.body.includes('<')) {
        fail('jsonld', `${page.file}: a JSON-LD block contains "<", which can end the script or swallow the page; serialise it with jsonLd()`)
      }
      try {
        JSON.parse(script.body)
      } catch {
        fail('jsonld', `${page.file}: a JSON-LD block is not valid JSON (cut short by "</script>" in its data?): ${script.body.slice(0, 70)}…`)
      }
    }
  }
  return blocks
}

// ---------------------------------------------------------------------------------------------
// redirects: renamed pages keep their old addresses working, and nothing links to the old ones

function checkRedirects() {
  const source = join(root, 'public', '_redirects')
  const path = join(dist, '_redirects')
  if (!existsSync(source)) return 0
  if (!existsSync(path)) {
    fail('redirects', 'dist/_redirects is missing: rebuild')
    return 0
  }
  const text = readFileSync(path, 'utf8')
  if (readFileSync(source, 'utf8') !== text) fail('redirects', 'dist/_redirects differs from public/_redirects: rebuild')

  // Cloudflare Pages syntax: `source destination status`, one rule a line; 2,000 static rules at most
  // (https://developers.cloudflare.com/pages/configuration/redirects/).
  const rules = []
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) return
    const parts = t.split(/\s+/)
    if (parts.length !== 3) return void fail('redirects', `_redirects line ${i + 1} wants "source destination status": ${t}`)
    const [from, to, code] = parts
    if (code !== '301' && code !== '308') fail('redirects', `_redirects line ${i + 1}: ${from} is a ${code}; a renamed page wants a permanent 301`)
    if (!/^\/[^\s*:?#]*$/.test(from)) fail('redirects', `_redirects line ${i + 1}: the source ${from} must be a plain path (no splats, placeholders or queries)`)
    if (!to.startsWith('/') || to.startsWith('//')) fail('redirects', `_redirects line ${i + 1}: the destination ${to} must be a path on this site`)
    rules.push({ from, to, line: i + 1 })
  })
  if (rules.length > 2000) fail('redirects', `_redirects has ${rules.length} rules; Cloudflare's limit is 2,000 static rules`)

  const sources = new Map()
  for (const rule of rules) {
    if (sources.has(rule.from)) fail('redirects', `${rule.from} has two rules (lines ${sources.get(rule.from).line} and ${rule.line})`)
    sources.set(rule.from, rule)
  }
  const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  const retired = new Map([...sources.values()].map((r) => [trim(r.from), r.to]))
  for (const rule of rules) {
    if (fileFor(rule.from)) fail('redirects', `${rule.from} is still a built page, so its redirect hides it or never runs`)
    const target = new URL(rule.to, site).pathname
    if (!fileFor(target)) fail('redirects', `${rule.from} → ${rule.to}, which isn't a built page`)
    if (retired.has(trim(target))) fail('redirects', `${rule.from} → ${rule.to}, which is itself redirected: point it at the final page`)
    if (/^\/blog\/[^/]+\/?$/.test(rule.from)) {
      const other = rule.from.endsWith('/') ? rule.from.slice(0, -1) : `${rule.from}/`
      if (!sources.has(other)) fail('redirects', `${rule.from} has a rule but ${other} doesn't; add both spellings`)
      else if (sources.get(other).to !== rule.to) fail('redirects', `${rule.from} and ${other} go to different pages`)
    }
  }

  // Nothing of ours points at a retired address: links resolve through a redirect, which costs a hop.
  for (const page of html) {
    for (const tag of tagsOf(page.text)) {
      if (tag.name !== 'a' && tag.name !== 'link') continue
      const raw = tag.attrs.get('href')
      if (!raw || !sameOrigin(raw) || raw.startsWith('#')) continue
      const to = retired.get(trim(new URL(raw, `${site}${urlOf(page.file)}`).pathname))
      if (to) fail('redirects', `${page.file} links to the retired ${raw}; link to ${to} instead`)
    }
  }
  for (const name of ['sitemap.xml', 'rss.xml']) {
    const file = join(dist, name)
    if (!existsSync(file)) continue
    const body = readFileSync(file, 'utf8')
    for (const [from, to] of retired) {
      if (body.includes(`${site}${from}<`) || body.includes(`${site}${from}/<`)) fail('redirects', `${name} lists the retired ${from}; it should list ${to}`)
    }
  }
  return rules.length
}

// ---------------------------------------------------------------------------------------------
// code: highlighted code stays readable on the surface it is drawn on

const luminance = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function checkCode() {
  // The light surface is the first --c-surface; the dark one is the one set for :root[data-theme=dark].
  const surface = css.map((sheet) => sheet.text.match(/--c-surface:\s*(#[0-9a-f]{3,6})\b/i)?.[1]).find(Boolean)
  if (!surface) return void fail('code', 'no --c-surface colour in the built CSS, so the code surface is unknown')
  const darkSurface = css
    .map((sheet) => sheet.text.match(/:root\[data-theme=["']?dark["']?\]\s*{[^}]*--c-surface:\s*(#[0-9a-f]{3,6})\b/i)?.[1])
    .find(Boolean)
  if (!darkSurface) return void fail('code', 'no dark --c-surface in the built CSS, so the dark code surface is unknown')
  let tokens = 0
  for (const page of html) {
    const blocks = page.text.match(/<pre class="astro-code[\s\S]*?<\/pre>/g) ?? []
    for (const block of blocks) {
      for (const m of block.matchAll(/style="([^"]*)"/g)) {
        const style = m[1]
        if (/(^|;)\s*color\s*:/i.test(style)) {
          fail('code', `${page.file}: a code token has a fixed colour (${style.slice(0, 60)}); use the theme variables`)
          continue
        }
        const light = style.match(/--shiki-light:\s*(#[0-9a-f]{3,6})\b/i)?.[1]
        const dark = style.match(/--shiki-dark:\s*(#[0-9a-f]{3,6})\b/i)?.[1]
        if (!light) continue
        tokens++
        if (!dark) fail('code', `${page.file}: code token ${light} has no dark colour (--shiki-dark)`)
        // AA is 4.5:1; small monospace loses some to anti-aliasing, so the dark theme keeps a margin.
        for (const [colour, ground, floor, name] of [[light, surface, 4.5, 'light'], [dark, darkSurface, 4.8, 'dark']]) {
          if (!colour) continue
          const ratio = contrast(colour, ground)
          if (ratio < floor) fail('code', `${page.file}: ${name} code token ${colour} is ${ratio.toFixed(2)}:1 on the ${name} code surface ${ground} (want ${floor})`)
        }
      }
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------------------------
// fonts: one family, nothing else downloaded

const FONT_FAMILIES = new Set(['Google Sans Flex'])
const FONT_FILES = new Set(['fonts/google-sans-flex-latin.woff2'])

function checkFonts() {
  let faces = 0
  for (const sheet of css) {
    for (const face of sheet.text.match(/@font-face\s*{[^}]*}/g) ?? []) {
      faces++
      const family = face.match(/font-family:\s*["']?([^;"'}]+)["']?/)?.[1]?.trim()
      if (!FONT_FAMILIES.has(family)) fail('fonts', `${sheet.file}: @font-face for "${family}"; the site uses Google Sans Flex only`)
      for (const m of face.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const file = m[1].replace(/^\//, '')
        if (!FONT_FILES.has(file)) fail('fonts', `${sheet.file}: @font-face loads ${m[1]}, which is not the site's font file`)
      }
    }
  }
  for (const file of files.map(rel)) {
    if (/\.(woff2?|ttf|otf|eot)$/i.test(file) && !FONT_FILES.has(file.split(sep).join('/'))) fail('fonts', `${file} is a font file the site should not ship`)
  }
  for (const page of html) {
    for (const m of page.text.matchAll(/<link[^>]+href="([^"]+\.(?:woff2?|ttf|otf))"/g)) {
      if (!FONT_FILES.has(m[1].replace(/^\//, ''))) fail('fonts', `${page.file} preloads ${m[1]}`)
    }
  }
  return faces
}

// ---------------------------------------------------------------------------------------------
// app: Durable Runner is self-hosted — there is no hosted app or account, so no page may link to one

function checkApp() {
  let pages = 0
  for (const page of html) {
    if (!/<header/.test(page.text)) continue
    pages++
    if (/href="[^"]*(app\.|\/studio\/|\/signin|\/signup|\/dashboard)/.test(page.text)) {
      fail('app', `${page.file} links to a hosted app or account page; the product is self-hosted, there is none`)
    }
  }
  return { pages, appUrl: null }
}

// ---------------------------------------------------------------------------------------------
// light: nothing that keeps painting while the visitor does nothing, or runs on every pointer or scroll move

function checkLight() {
  const sources = [
    ...css.map((sheet) => ({ file: sheet.file, text: sheet.text, kind: 'css' })),
    ...html.flatMap((page) => [
      ...[...page.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({ file: page.file, text: m[1], kind: 'css' })),
      ...[...page.text.matchAll(/\sstyle="([^"]*)"/g)].map((m) => ({ file: page.file, text: m[1], kind: 'css' })),
      ...[...page.text.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => ({ file: page.file, text: m[1], kind: 'js' })),
    ]),
    ...files.filter((f) => extname(f) === '.js').map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8'), kind: 'js' })),
  ]
  let checked = 0
  for (const { file, text, kind } of sources) {
    checked++
    if (kind === 'css') {
      if (/backdrop-filter\s*:/i.test(text)) fail('light', `${file}: backdrop-filter, which repaints the page under it on every frame`)
      for (const m of text.matchAll(/animation(?:-iteration-count)?\s*:[^;}]*\binfinite\b/gi)) fail('light', `${file}: an animation that never stops (${m[0].slice(0, 80)})`)
    } else {
      for (const m of text.matchAll(/(?:addEventListener\(\s*["'`](pointermove|mousemove|scroll|wheel|touchmove)["'`]|\bon(pointermove|mousemove|scroll|wheel|touchmove)\s*=)/g))
        fail('light', `${file}: a script listens to ${m[1] ?? m[2]}, which runs on every move`)
    }
  }
  return checked
}

// ---------------------------------------------------------------------------------------------

checkHeaders()
const namesScanned = checkLeaks()
const draftCount = checkDrafts()
checkLinks()
const linksChecked = checkInternalLinks()
const seo = checkSeo()
const jsonLdBlocks = checkJsonLd()
const redirectRules = checkRedirects()
const codeTokens = checkCode()
const fontFaces = checkFonts()
const appCheck = checkApp()
const lightChecked = checkLight()

if (failures.length) {
  console.error(`check-dist: ${failures.length} failure(s) in ${dist}\n`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`check-dist: ${html.length} pages, ${files.length} files in ${relative(root, dist) || dist}`)
console.log('  headers  ok: _headers present, CSP covers every inline script and asset')
console.log(`  leaks    ok: no private files, paths, ${namesScanned} private names or credential shapes`)
console.log(`  drafts   ok: ${draftCount} draft post(s), none built, linked or named`)
console.log(`  links    ok: every target="_blank" link has noopener or noreferrer; ${linksChecked} same-origin links resolve`)
console.log(`  seo      ok: titles, descriptions, one h1, canonicals, share cards, alt; ${seo.indexable} pages in the sitemap, ${seo.posts} posts in the feed`)
console.log(`  jsonld   ok: ${jsonLdBlocks} JSON-LD blocks, all valid JSON with no "<"`)
console.log(`  code     ok: ${codeTokens} code tokens coloured by the theme, all at AA on the light and dark code surfaces`)
console.log(`  light    ok: ${lightChecked} stylesheets and scripts: no backdrop-filter, no endless animation, no move or scroll listeners`)
console.log(`  app      ok: ${appCheck.pages} pages checked; no hosted app or account links (the product is self-hosted)`)
console.log(`  fonts    ok: ${fontFaces} @font-face rules, all Google Sans Flex; no other font file or preload`)
console.log(`  redirects ok: ${redirectRules} permanent redirects to built pages; nothing links to a retired address`)
