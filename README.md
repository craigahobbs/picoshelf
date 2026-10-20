# PicoShelf

**Every public-domain book, read aloud. Right in your browser.**

PicoShelf is an audiobook player for public-domain books (Project Gutenberg and Standard Ebooks). Each book is fetched
from its source and read aloud by [PicoVox](https://github.com/craigahobbs/picovox)
([npm](https://www.npmjs.com/package/picovox)) - realistic speech synthesis in pure JavaScript, under 1 MB - synthesized
on your device, in a Web Worker. No server, no recorded speech, no runtime dependencies beyond PicoVox.

It is a static site, published with GitHub Pages: `index.html` is the app, and `.nojekyll` keeps GitHub Pages from
processing the files.

## Layout

- `index.html`, `app.js`, `engine.js`, `worker.js`, `renderworker.js`, `store.js`, `bookcache.js` - the app (copied
  from voice-synth's `static/audiobook/`); the synthesis worker runs the voice network and its render worker the
  synthesizer, at once on two cores
- `sources/` - the book sources (Project Gutenberg, Standard Ebooks)
- `lib/` - the catalog and book-format code (catalog search, Gutenberg text cleanup, EPUB and ZIP reading)
- `data/catalog.json` - the book catalog, each book with its narrator's voice (`make catalog`)
- `tools/` - the catalog builder (`catalog.js` - every Standard Ebooks book and the most-downloaded Project Gutenberg
  books, its pages cached under `build/catalog/`) and the narrator casting (`voicecast.js` - a local Ollama decision
  model chooses each book's voice; `voicelabels.json`, 132 hand-cast books, scores the decision models)
- `picovox/` - the PicoVox voice - a copy of the npm package `picovox`'s `lib/` (the text front end and G2P, the neural
  model and synthesizer runtime, the synthesis pipeline and sentence splitting the app uses, and the generated model
  modules, `lib/models/`), with its `package.json` (the version) and `LICENSE`
- `package.json`, `package-lock.json` - the PicoVox dependency, pinned by the lock file
- `Makefile` - `make picovox` copies the installed package into `picovox/`; `make catalog` builds the catalog

## The catalog and its narrators

`make catalog` rebuilds `data/catalog.json` (`node tools/catalog.js`; `--cache-only` builds from the cached pages
alone). Each book's default narrator is cast by a local [Ollama](https://ollama.com) decision model,
`kev:9b-nvfp4` (`ollama pull kev:9b-nvfp4`, with Ollama running): it answers a choice of the ten designed voices, each
with casting notes, about the book's title, author, subjects, and description - Jane Austen gets Helen, a composed,
refined voice, and Moby Dick gets Robert, a deep, weathered one. The casts are cached by model and book, so a rebuild
casts only new or changed books. `node tools/voicecast.js --eval --model <model>` scores a decision model on the
hand-cast books; `--book <title>` shows a book's cast. A listener's voice and speed for a book override its defaults
(the cast voice, at 1×), and the Narrator sheet resets them.

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
