# PicoShelf

**Every public-domain book, read aloud. Right in your browser.**

PicoShelf is an audiobook player for public-domain books (Project Gutenberg and Standard Ebooks) and Wikipedia's
articles. Each book is fetched
from its source and read aloud by [PicoVox](https://github.com/craigahobbs/picovox)
([npm](https://www.npmjs.com/package/picovox)) - realistic speech synthesis in pure JavaScript, under 1 MB - synthesized
on your device, in a Web Worker. No server, no recorded speech, no runtime dependencies beyond PicoVox.

It is a static site, published with GitHub Pages: `make app` builds it into `build/app/` (`index.html`, the app, the
catalog, and PicoVox), and `make gh-pages` publishes it.

## Links

A book's address is its link, and it follows the listener's section - share it from the player's share button, or
copy it from the address bar. The link's hash parameters (key=value pairs joined by "&", URL-encoded, as
[MarkdownUp](https://github.com/craigahobbs/markdown-up)'s) name the book and, optionally, the section and the place:

- `book` - the book's id, stable across catalog builds: `pg` and its Project Gutenberg ebook number (`pg1342`),
  `se.` and its Standard Ebooks path with dots for slashes (`se.jane-austen.pride-and-prejudice`), or `wp.` and a
  Wikipedia article's title as Wikipedia's links write it (`wp.Moby-Dick`, `wp.Herman_Melville`)
- `section` - the section's number in the book's contents (its sections and subsections in order, from 1)
- `char` - a place in the book - its character offset in the book's text (the share sheet's "This place" - the
  listener's sentence); the link opens there, not at the listener's place

For example, `#book=se.miguel-de-cervantes-saavedra.don-quixote.john-ormsby&section=12` opens Don Quixote at its fifth
chapter - or at the listener's place, if that is in the section.

## Layout

PicoShelf is a [javascript-build](https://github.com/craigahobbs/javascript-build#readme) package.

- `static/index.html` - the page
- `lib/` - the app: `app.js` (the library and the player), `engine.js` (playback), `worker.js` and `renderworker.js`
  (the synthesis worker runs the voice network and its render worker the synthesizer, at once on two cores),
  `store.js` and `bookcache.js` (the listener's places and the downloaded books, in browser storage), the catalog and
  book-format code (`catalog.js` - catalog search; `gutenberg.js` - Gutenberg text cleanup; `epub.js`, `zip.js` - EPUB
  and ZIP reading), and the book sources (`lib/sources/` - Project Gutenberg, Standard Ebooks, and the Wikipedia shelf,
  `wikipedia.js` - live, from Wikipedia's CORS-enabled APIs: today's featured and most-read articles, search, and an
  article's plain text, its sections the chapters, read by default by Michael - of the best-measured voices on
  encyclopedia prose; CC BY-SA, credited on each article)
- `test/` - the unit tests (`node --test`, with jsdom for the browser; 100% coverage)
- `data/catalog.json` - the book catalog, each book with its narrator's voice and its genres (`make catalog`)
- `tools/` - the catalog builder (`catalog.js` - every Standard Ebooks book and the most-downloaded Project Gutenberg
  books, its pages cached under `cache/catalog/`), and the decisions a local Ollama decision model makes about each
  book (`decide.js`): its narrator (`voicecast.js`; `voicelabels.json`, 132 hand-cast books, scores the decision models)
  and its genres (`genres.js`)
- `package.json` - the PicoVox dependency (`picovox`) and the development dependencies
- `Makefile` - javascript-build's targets (`make commit` - the tests, lint, documentation, and 100% coverage), and
  `make app`, `make run`, and `make catalog`

## The catalog and its narrators

`make catalog` rebuilds `data/catalog.json` (`node tools/catalog.js`; `--cache-only` builds from the cached pages
alone). Each book's default narrator is cast by a local [Ollama](https://ollama.com) decision model,
`kev:9b-nvfp4` (`ollama pull kev:9b-nvfp4`, with Ollama running): it answers a choice of the ten designed voices, each
with casting notes, about the book's title, author, subjects, and description - Jane Austen gets Helen, a composed,
refined voice, and Moby Dick gets Robert, a deep, weathered one. The casts are cached by model and book, so a rebuild
casts only new or changed books. `node tools/voicecast.js --eval --model <model>` scores a decision model on the
hand-cast books; `--book <title>` shows a book's cast. A listener's voice and speed for a book override its defaults
(the cast voice, at 1×), and the Narrator sheet resets them.

The same decision model chooses each book's genres (`tools/genres.js`): one choice of 23 genres - Adventure, Mystery &
Crime, Poetry, Children's, ... - about the book's catalog entry, the book's genres its choice and up to two others it
finds nearly as likely (Alice's Adventures in Wonderland is Children's and Fantasy). `node tools/genres.js --book
<title>` shows a book's.

## The library

The library is the whole catalog (Library) or the books you've opened (My Library, most recent first), searched by
title, author, and subject, and shown three ways: all its books, by author (by surname - a book with several authors
under each), or by genre; an author or a genre opens to its books. The book playing is in the player bar at the
bottom - close it there (×) to stop, its place kept in My Library.

## PicoVox

The app imports PicoVox by its package name (`import ... from 'picovox/lib/synthesis.js'`), from `node_modules`. A
static site can't resolve bare imports, so `make app` copies the package's `lib/` into the site (`picovox/lib/`) and
rewrites the app's imports to relative ones. To update PicoVox, change its version in `package.json` (`~1.6` takes the
latest 1.6 release) and rebuild (`make clean app`).

## Running locally

```sh
make run
```

then open http://localhost:8000/ (`make run` builds the site and serves `build/app/`).

## Development

```sh
make commit
```

runs the unit tests, eslint, jsdoc, and the coverage check (100%), and builds the site.
