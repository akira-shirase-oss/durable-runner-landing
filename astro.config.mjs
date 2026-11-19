// @ts-check
import { defineConfig } from 'astro/config'
import { aaOnSurface } from './src/lib/shiki.ts'

// The one place the public address lives: canonical URLs, the sitemap and share images all derive from it.
const site = 'https://durable-runner.404human.dev'

// Static output: every page is plain HTML at build time, so search engines read it without running JavaScript.
// The few interactive pieces are small vanilla scripts.
export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'ignore',
  // Code is coloured through CSS variables (--shiki-light, --shiki-dark) instead of fixed colours, so its
  // tokens are drawn for the background they sit on. `npm run check` measures every token against the code
  // surface and fails below AA (4.5:1).
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
      defaultColor: false,
      transformers: [aaOnSurface],
    },
  },
})
