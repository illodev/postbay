# postbay.app

The landing page: plain static files, English at `/` and Spanish at `/es/`.

```sh
node site/build.mjs     # rebuilds index.html and es/index.html from src/content.mjs
```

The built pages are committed, so it deploys as is. On Vercel: import the repository, set **Root Directory** to `site`,
**Framework Preset** to *Other*, and leave the build command empty.
