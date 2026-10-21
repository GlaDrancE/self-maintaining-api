# site/

One static file: `index.html`. No build step, no dependencies. Deploy the `site/`
directory as-is.

## GitHub Pages

`.github/workflows/pages.yml` already does this on every push to `main`.
Enable it once: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Vercel

```bash
npx vercel deploy --prod ./site
```
Dashboard: Framework Preset `Other`, Root Directory `site`, Build Command empty,
Output Directory `.`.

## Netlify

```bash
npx netlify deploy --prod --dir=site
```
Dashboard: Build command empty, Publish directory `site`.

## Cloudflare Pages

```bash
npx wrangler pages deploy site --project-name=sma
```
Dashboard: Framework preset `None`, Build command empty, Build output directory `site`.

## Local preview

```bash
npx serve site        # or: python -m http.server -d site
```
