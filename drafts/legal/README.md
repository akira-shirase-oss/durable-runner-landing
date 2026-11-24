# Legal drafts (unpublished)

`terms.astro` and `privacy.astro` are page drafts for the hosted Durable Runner beta. They live
outside `src/pages/` so nothing builds or serves them: the operator's contact address is not decided
yet, and every contact point in them reads `CONTACT_ADDRESS_TBD`. `scripts/check-dist.mjs` fails if a
draft carrying that token is built at its address, or if the token appears anywhere in `dist/`.

The drafts keep their publish-time relative imports (`../layouts/…`); they are not compiled where
they sit.

## To publish a page

1. Move it back, e.g. `git mv drafts/legal/terms.astro src/pages/terms.astro`.
2. Replace every `CONTACT_ADDRESS_TBD` with the real contact address.
3. Drop `noindex` from the `<Base>` props (and the `Draft` badge from the body) once the text is final.
4. Link it from the footer (`src/components/SiteFooter.astro`).
5. Add it to `src/pages/sitemap.xml.ts`.
6. Update the `legal` check in `scripts/check-dist.mjs` if the draft file itself is removed from this
   directory.
7. `npm run build && node scripts/check-dist.mjs` must be green.
