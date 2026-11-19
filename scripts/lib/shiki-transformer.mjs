// @ts-check

// github-light-default draws comments in #6E7781, 4.06:1 on the code surface: one step darker
// (#57606A, the theme's own secondary text) clears AA. Every other token already does.
// Astro caches rendered Markdown in node_modules/.astro: after changing this, delete it before building.
// Shared by astro.config.mjs (Markdown fences) and the <Code> blocks in components.
const LIGHT_SWAPS = { '#6e7781': '#57606A' }

export const aaOnSurface = {
  name: 'aa-on-surface',
  span(node) {
    const style = node.properties.style
    if (typeof style !== 'string') return
    node.properties.style = style.replace(/--shiki-light:(#[0-9a-f]{6})/i, (all, hex) => {
      const swap = LIGHT_SWAPS[hex.toLowerCase()]
      return swap ? `--shiki-light:${swap}` : all
    })
  },
}
