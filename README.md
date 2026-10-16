# PicoShelf

**Every public-domain book, read aloud. Right in your browser.**

PicoShelf is an audiobook player for public-domain books (Project Gutenberg and Standard Ebooks). Each book is fetched
from its source and read aloud by [PicoVox](https://github.com/craigahobbs/voice-synth) - realistic speech synthesis in
pure JavaScript, under 1 MB - synthesized on your device, in a Web Worker. No server, no recorded speech, no runtime
dependencies.

It is a static site, published with GitHub Pages: `index.html` is the app, and `.nojekyll` keeps GitHub Pages from
processing the files.

## Layout

- `index.html`, `app.js`, `engine.js`, `worker.js`, `store.js`, `bookcache.js` - the app (copied from voice-synth's
  `static/audiobook/`)
- `sources/` - the book sources (Project Gutenberg, Standard Ebooks)
- `lib/` - the catalog and book-format code (catalog search, Gutenberg text cleanup, EPUB and ZIP reading)
- `data/catalog.json` - the book catalog (built by voice-synth's `tools/catalog.js`)
- `picovox/` - the PicoVox voice: the text front end and G2P (`lib/`), the generated model modules (`lib/models/`), and
  the neural model and synthesizer runtime (`nn/js/`) - copied from voice-synth for now

## Running locally

Serve the directory with any static file server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000/.
