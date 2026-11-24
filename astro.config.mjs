// @ts-check
import { defineConfig } from 'astro/config'
import svelte from '@astrojs/svelte'
import tailwindcss from '@tailwindcss/vite'
import { aaOnSurface } from './scripts/lib/shiki-transformer.mjs'

// The one place the public address lives: canonical URLs, the sitemap and share images all derive from it.
const site = 'https://durable-runner.404human.dev'

// Static output: every page is plain HTML at build time, so search engines read it without running JavaScript.
// The components are shadcn-svelte, rendered to HTML at build time; no Svelte runtime ships to the browser.
// The one interactive piece (the hero's story card) is a small vanilla script.
export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  integrations: [svelte()],
  vite: {
    plugins: [tailwindcss()],
  },
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
