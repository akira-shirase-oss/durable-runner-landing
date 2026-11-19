import type { APIRoute } from 'astro'

// One public page: the home page (the 404 is noindex, everything else lives on the docs domain).
export const GET: APIRoute = ({ site }) => {
  const base = site!.href
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${new URL('/', base).href}</loc></url>
</urlset>
`
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
