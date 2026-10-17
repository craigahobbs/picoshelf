# PicoShelf

**Every public-domain book, read aloud. Right in your browser.**

PicoShelf is an audiobook player for public-domain books (Project Gutenberg and Standard Ebooks). Each book is fetched
from its source and read aloud by [PicoVox](https://github.com/craigahobbs/picovox)
([npm](https://www.npmjs.com/package/picovox)) - realistic speech synthesis in pure JavaScript, under 1 MB - synthesized
on your device, in a Web Worker. No server, no recorded speech, no runtime dependencies beyond PicoVox.

It is a static site, published with GitHub Pages: `index.html` is the app, and `.nojekyll` keeps GitHub Pages from
processing the files.

## Layout

- `index.html`, `app.js`, `engine.js`, `worker.js`, `store.js`, `bookcache.js` - the app (copied from voice-synth's
  `static/audiobook/`)
- `sources/` - the book sources (Project Gutenberg, Standard Ebooks)
- `lib/` - the catalog and book-format code (catalog search, Gutenberg text cleanup, EPUB and ZIP reading)
- `data/catalog.json` - the book catalog (built by voice-synth's `tools/catalog.js`)
- `picovox/` - the PicoVox voice - a copy of the npm package `picovox`'s `lib/` (the text front end and G2P, the neural
  model and synthesizer runtime, the synthesis pipeline and sentence splitting the app uses, and the generated model
  modules, `lib/models/`), with its `package.json` (the version) and `LICENSE`
- `package.json`, `package-lock.json` - the PicoVox dependency, pinned by the lock file
- `Makefile` - `make picovox` copies the installed package into `picovox/`

## Updating PicoVox

A static site can't resolve bare imports (`import ... from 'picovox'`), so the app imports a committed copy of the
package, `picovox/`, which GitHub Pages serves. To update it, install the new version, copy it, and commit:

```sh
npm install picovox@latest
make picovox
git add package.json package-lock.json picovox
```

`make picovox` runs `npm ci` (the version in `package-lock.json`) and replaces `picovox/` with
`node_modules/picovox/lib/`, `package.json`, and `LICENSE`.

## Running locally

Serve the directory with any static file server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000/.
