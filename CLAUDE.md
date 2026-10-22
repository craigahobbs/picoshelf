# CLAUDE.md

Notes for coding agents working in this repository.

## javascript-build

This is a [javascript-build](https://github.com/craigahobbs/javascript-build#readme) package. Read the javascript-build
skill before running tests, lint, coverage, or changing the Makefile:
[`../javascript-build/SKILL.md`](../javascript-build/SKILL.md) if that file exists, otherwise
[https://raw.githubusercontent.com/craigahobbs/javascript-build/main/SKILL.md](https://raw.githubusercontent.com/craigahobbs/javascript-build/main/SKILL.md).

Local Makefile overrides:

- `GHPAGES_SRC` - `build/app/`
- `USE_JSDOM` - jsdom is a development dependency (the app's tests, and `tools/catalog.js`)
- `ESLINT_ARGS` - also `tools/`
- `C8_ARGS` - also `tools/` (100% coverage of the catalog builder too)
- `commit` also depends on `app`
- `superclean` also removes `cache/` (the catalog builder's cached pages and Ollama decisions - hours to rebuild)

Package-specific targets:

- `make app` - the site, `build/app/`: `static/index.html`, `lib/`, `data/catalog.json`, PicoVox
  (`node_modules/picovox/lib/` in `picovox/lib/`), the app's bare `picovox/...` imports rewritten to relative ones, and
  the service worker (`static/sw.js` - a classic script, linted, tested by `test/testServiceWorker.js` - with its
  version and file list written in)
- `make run` - `make app`, then serve `build/app/` at http://localhost:8000/
- `make icons` - render `static/icon.svg` into the PNG icons (`static/*.png`) with headless Chrome - after changing the icon
- `make catalog` - rebuild `data/catalog.json` (`tools/catalog.js`; needs a local Ollama - a first build decides
  every candidate's genre and every book's narrator, hours on the GPU; later builds decide only new books)

## Code

- `lib/` - the app (browser ES modules): `app.js` (the UI - importing it has no side effects; `main(window, overrides)`
  starts it, as `static/index.html` does, and the tests pass fakes for its services in `overrides`), `engine.js` (playback), `worker.js` and `renderworker.js`
  (the synthesis Web Workers), `store.js` and `bookcache.js` (browser storage), the book code (`catalog.js`, `zip.js`,
  `epub.js`, `gutenberg.js`), and the book sources (`lib/sources/`). PicoVox is imported bare (`picovox/lib/...`), so
  the code runs under Node's tests as is and `make app` makes the imports relative for the static site.
- `tools/` - the catalog builder (Node). Its tests (`test/testTools*.js`) never reach the network or Ollama: they set
  `PICOSHELF_CACHE` (the cache directory) and `PICOSHELF_CATALOG` (the catalog `tools/decide.js` reads) to temporary
  files, fake `fetch` in-process, and run the CLIs as child processes against a local fake Ollama (`OLLAMA_HOST`).
- `test/` - `node --test` unit tests; jsdom stands in for the browser.
